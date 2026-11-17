"""The corpus read API (companies: search, detail with every source) and
prioritizing a value over the quality score. Any signed-in user."""

import uuid
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import search
from app.auth import SignedIn
from app.catalogue import CATALOGUE
from app.db import Db
from app.ingest.commit import LOCK_ID
from app.models import (
    CurrentValue,
    Document,
    Entity,
    Observation,
    SourceType,
    User,
    ValuePin,
    Version,
)
from app.quality import freshness, level, score
from app.values import recompute

router = APIRouter()

# Shown in the search results (the frontend picks its columns from these).
LIST_FIELDS = ("name", "website", "hq", "sector", "sub_sector", "revenue",
               "employee_count", "buyer_category", "investor_type", "aum", "founded")

# Licensed databases, our own records, or the open web (icons in the app).
CATEGORY = {"capiq": "proprietary", "orbis": "proprietary", "manual": "internal",
            "internal": "internal", "crm": "internal", "web": "public", "news": "public"}

ORDER = {key: i for i, key in enumerate(CATALOGUE)}


def _display(value: Any) -> Any:
    return value.get("v") if isinstance(value, dict) else value


def _iso(d) -> str | None:
    return d.isoformat() if d else None


def cell_level(field: str, as_of: date | None, value: float) -> str:
    """Unknown means no as-of date for a value that goes stale; it isn't bad."""
    point = CATALOGUE.get(field)
    if as_of is None and (point is None or point.half_life_days is not None):
        return "unknown"
    return level(value)


def _company(session: Session, company_id: uuid.UUID) -> Entity:
    entity = session.get(Entity, company_id)
    if entity is None or entity.kind != "company":
        raise HTTPException(404, "Company not found.")
    return entity


@router.get("/companies")
def companies(
    _: SignedIn, session: Db,
    q: str | None = None,
    sort: search.Sort = "relevance",
    dir: Literal["asc", "desc"] = "asc",
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 50,
) -> dict:
    """Search companies (name, website, sector, HQ, description; fuzzy on the
    name), sorted and paged in SQL, with their shown values."""
    total, ids = search.search(session, q, sort, dir == "desc", offset, limit)
    confidence = dict(session.execute(select(SourceType.key, SourceType.confidence)).all())
    rows = session.execute(
        select(CurrentValue.entity_id, CurrentValue.field, CurrentValue.period,
               Observation.source_type, CurrentValue.sources, CurrentValue.pin_id,
               Observation.value, Observation.as_of)
        .join(Observation, Observation.id == CurrentValue.observation_id)
        .where(CurrentValue.entity_id.in_(ids), CurrentValue.field.in_(LIST_FIELDS))
    ).all() if ids else []
    values: dict[uuid.UUID, dict] = {i: {} for i in ids}
    for entity_id, field, period, source_type, sources, pin_id, value, as_of in rows:
        # Scored today, not when the value was last recomputed (freshness decays).
        sc = score(confidence[source_type], field, as_of)
        current = values[entity_id].get(field)
        # Show the latest fiscal year for per-year data points.
        if current is None or period > current["period"]:
            values[entity_id][field] = {
                "value": _display(value), "period": period, "score": sc,
                "level": cell_level(field, as_of, sc), "sources": sources,
                "pinned": pin_id is not None}
    return {"total": total, "offset": offset, "limit": limit,
            "items": [{"id": str(i), "values": values[i]} for i in ids]}


@router.get("/companies/{company_id}")
def company(company_id: uuid.UUID, _: SignedIn, session: Db) -> dict:
    """Every data point with its shown value, quality and all its sources."""
    _company(session, company_id)
    return detail(session, company_id)


def detail(session: Session, company_id: uuid.UUID) -> dict:
    sources = {s.key: s for s in session.scalars(select(SourceType))}
    winners = {(cv.field, cv.period): cv for cv in session.scalars(
        select(CurrentValue).where(CurrentValue.entity_id == company_id))}
    pins = {p.id: p for p in session.scalars(select(ValuePin).where(
        ValuePin.id.in_([cv.pin_id for cv in winners.values() if cv.pin_id])))}
    names = dict(session.execute(select(User.email, User.name).where(
        User.email.in_([p.pinned_by for p in pins.values()]))).all()) if pins else {}
    observations = session.execute(
        select(Observation, Document.filename)
        .outerjoin(Document, Document.id == Observation.document_id)
        .where(Observation.entity_id == company_id)
        .order_by(Observation.field, Observation.period, Observation.version_id.desc())
    ).all()

    today = date.today()
    fields: dict[str, list[dict]] = {}  # every observation, for the admin view
    cells: dict[tuple, list[dict]] = {}
    for o, filename in observations:
        key = (o.field, o.period or 0)
        cv = winners.get(key)
        shown = cv is not None and cv.observation_id == o.id
        pinned = shown and cv.pin_id is not None
        source = {
            "observation_id": o.id, "value": _display(o.value), "raw": o.raw,
            "period": o.period, "source_type": o.source_type,
            "label": sources[o.source_type].label,
            "category": CATEGORY.get(o.source_type, "internal"),
            "document": filename,
            "document_id": str(o.document_id) if o.document_id else None,
            "sheet": o.sheet, "row": o.row, "col": o.col, "as_of": _iso(o.as_of),
            "version_id": o.version_id, "retracted": o.retracted_version_id is not None,
            "score": score(sources[o.source_type].confidence, o.field, o.as_of),
            "shown": shown, "pinned": pinned,
        }
        fields.setdefault(o.field, []).append(source)
        if o.retracted_version_id is None:
            cells.setdefault(key, []).append(source)

    out = []
    for (field, period), group in cells.items():
        cv = winners.get((field, period))
        if cv is None:
            continue
        shown = next(s for s in group if s["observation_id"] == cv.observation_id)
        # The shown source first, then by score.
        group.sort(key=lambda s: (not s["shown"], -s["score"]))
        point = CATALOGUE.get(field)
        as_of = date.fromisoformat(shown["as_of"]) if shown["as_of"] else None
        fresh = freshness(field, as_of, today)
        pin = pins.get(cv.pin_id) if cv.pin_id else None
        out.append({
            "field": field, "label": point.label if point else field,
            "type": point.type if point else "text", "entity": point.entity if point else None,
            "period": period or None, "value": shown["value"],
            "score": shown["score"], "level": cell_level(field, as_of, shown["score"]),
            "confidence": round(100 * sources[shown["source_type"]].confidence),
            "freshness": None if as_of is None and point and point.half_life_days
            else round(100 * fresh),
            "as_of": shown["as_of"],
            "pinned": {"by": pin.pinned_by, "name": names.get(pin.pinned_by, pin.pinned_by),
                       "at": _iso(pin.created_at)} if pin else None,
            "sources": group,
        })
    out.sort(key=lambda c: (ORDER.get(c["field"], 999), -(c["period"] or 0)))

    people = session.execute(
        select(Entity.person_id).where(Entity.kind == "role", Entity.company_id == company_id)
    ).scalars().all()
    name = next((c["value"] for c in out if c["field"] == "name"), None)
    return {"id": str(company_id), "name": name, "cells": out, "fields": fields,
            "people": [str(p) for p in people if p],
            "versions": sorted({o.version_id for o, _ in observations})}


# ── Prioritize a value ─────────────────────────────────────────────────────


class Pin(BaseModel):
    field: str
    period: int | None = None
    observation_id: int


def _describe(session: Session, company_id: uuid.UUID, field: str) -> str:
    point = CATALOGUE.get(field)
    name = session.execute(
        select(Observation.value).join(CurrentValue,
                                       CurrentValue.observation_id == Observation.id)
        .where(CurrentValue.entity_id == company_id, CurrentValue.field == "name")
    ).scalar()
    return f"{point.label if point else field} of {_display(name) or 'a company'}"


def _pin_event(session: Session, user: User, company_id: uuid.UUID, field: str,
               period: int, observation_id: int | None, message: str) -> dict:
    version = Version(kind="pin", author=user.email, message=message,
                      counts={"values": 1})
    session.add(version)
    session.flush()
    session.add(ValuePin(entity_id=company_id, field=field, period=period,
                         observation_id=observation_id, pinned_by=user.email,
                         version_id=version.id))
    session.flush()
    recompute(session, [company_id])
    return detail(session, company_id)


@router.put("/companies/{company_id}/pins")
def prioritize(company_id: uuid.UUID, body: Pin, user: SignedIn, session: Db) -> dict:
    """Show this observation for its data point regardless of the score."""
    session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": LOCK_ID})
    _company(session, company_id)
    period = body.period or 0
    o = session.get(Observation, body.observation_id)
    if (o is None or o.entity_id != company_id or o.field != body.field
            or (o.period or 0) != period):
        raise HTTPException(404, "That source isn't one of this value's sources.")
    if o.retracted_version_id is not None:
        raise HTTPException(409, "That source was withdrawn by a revert.")
    cv = session.get(CurrentValue, (company_id, body.field, period))
    if cv and cv.pin_id and cv.observation_id == o.id:
        raise HTTPException(409, "This source is prioritized already.")
    label = session.get(SourceType, o.source_type).label
    return _pin_event(session, user, company_id, body.field, period, o.id,
                      f"Prioritized {label} for {_describe(session, company_id, body.field)}")


@router.delete("/companies/{company_id}/pins")
def remove_priority(company_id: uuid.UUID, field: str, user: SignedIn, session: Db,
                    period: int | None = None) -> dict:
    """Hand the data point back to the quality score."""
    session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": LOCK_ID})
    _company(session, company_id)
    cv = session.get(CurrentValue, (company_id, field, period or 0))
    if cv is None or cv.pin_id is None:
        raise HTTPException(409, "This value isn't prioritized.")
    return _pin_event(session, user, company_id, field, period or 0, None,
                      f"Removed priority for {_describe(session, company_id, field)}")
