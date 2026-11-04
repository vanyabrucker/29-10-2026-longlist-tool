"""The shown (winning) value per entity, data point and period."""

import uuid
from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import CurrentValue, Observation, SourceType
from app.quality import score


def recompute(session: Session, entity_ids: Iterable[uuid.UUID]) -> None:
    """Rebuild current values for these entities from their live observations:
    best quality score wins, ties go to the newer version."""
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
        groups: dict[tuple, list[Observation]] = {}
        for o in observations:
            groups.setdefault((o.entity_id, o.field, o.period or 0), []).append(o)
        for (entity_id, field, period), group in groups.items():
            ranked = sorted(
                group,
                key=lambda o: (score(confidence[o.source_type], o.field, o.as_of),
                               o.version_id),
                reverse=True,
            )
            best = ranked[0]
            session.add(
                CurrentValue(
                    entity_id=entity_id, field=field, period=period,
                    observation_id=best.id,
                    score=score(confidence[best.source_type], field, best.as_of),
                    sources=len(group),
                )
            )
    session.flush()
