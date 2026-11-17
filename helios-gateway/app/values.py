"""The shown (winning) value per entity, data point and period."""

import uuid
from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import search
from app.models import CurrentValue, Observation, SourceType, ValuePin
from app.quality import score


def live_pins(session: Session, entity_ids: list[uuid.UUID]) -> dict[tuple, ValuePin]:
    """The prioritized observation per (entity, field, period): the newest live
    pin event, unless that event removed the priority."""
    events = session.scalars(
        select(ValuePin).where(ValuePin.entity_id.in_(entity_ids),
                               ValuePin.retracted_version_id.is_(None))
        .order_by(ValuePin.id)
    ).all()
    latest = {(p.entity_id, p.field, p.period): p for p in events}
    return {k: p for k, p in latest.items() if p.observation_id is not None}


def winner(group: list[Observation], pin: ValuePin | None,
           confidence: dict[str, float]) -> tuple[Observation, ValuePin | None]:
    """The shown observation of one data point: the pinned one if it is among
    them, otherwise the best quality score (ties to the newer version)."""
    best = next((o for o in group if pin and o.id == pin.observation_id), None)
    if best is not None:
        return best, pin
    return max(group, key=lambda o: (
        score(confidence[o.source_type], o.field, o.as_of), o.version_id)), None


def recompute(session: Session, entity_ids: Iterable[uuid.UUID]) -> None:
    """Rebuild current values for these entities from their live observations:
    a prioritized (pinned) observation wins if it is still live, otherwise the
    best quality score, ties to the newer version. Also refreshes search."""
    ids = list({uuid.UUID(str(e)) for e in entity_ids})
    if not ids:
        return
    confidence = dict(session.execute(select(SourceType.key, SourceType.confidence)).all())
    for chunk in (ids[i : i + 500] for i in range(0, len(ids), 500)):
        session.execute(delete(CurrentValue).where(CurrentValue.entity_id.in_(chunk)))
        observations = session.scalars(
            select(Observation).where(
                Observation.entity_id.in_(chunk),
                Observation.retracted_version_id.is_(None),
            )
        ).all()
        pins = live_pins(session, chunk)
        groups: dict[tuple, list[Observation]] = {}
        for o in observations:
            groups.setdefault((o.entity_id, o.field, o.period or 0), []).append(o)
        for key, group in groups.items():
            entity_id, field, period = key
            best, pin = winner(group, pins.get(key), confidence)
            session.add(
                CurrentValue(
                    entity_id=entity_id, field=field, period=period,
                    observation_id=best.id,
                    score=score(confidence[best.source_type], field, best.as_of),
                    sources=len(group), pin_id=pin.id if pin else None,
                )
            )
        session.flush()
        search.refresh(session, chunk)
