"""Contacts read API: people, their roles at companies and who at Helbling
knows them, all corpus records (see `seed_contacts`). Any signed-in user.

Visibility follows live observations, since entity rows are never retracted:
a person shows while it has a live observation, a role or relationship while
its person shows and it has one itself. A role also shows while the version
that created it still has a live observation on its person: an import that
maps a contact's name or email but no role column makes a role without
facts. "Live" is now, or as of a global version (`corpus_version`, for older
list versions). Whether a role is current (its end date) is judged against
today, also as of an older version."""

import calendar
import re
import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import SignedIn
from app.corpus import entity_cells
from app.db import Db
from app.models import CurrentValue, Entity, Observation, SourceType, User, ValuePin
from app.values import live_at, winner

router = APIRouter()

PERSON_FIELDS = ("full_name", "first_name", "last_name", "email")  # searched
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _shown(session: Session, entity_ids: list[uuid.UUID], corpus_version: int | None,
           fields: tuple[str, ...] | None = None) -> dict[uuid.UUID, dict[str, Any]]:
    """The shown value per entity and data point (latest period). An entity is
    in the result only if it has a live observation (of `fields`, if given):
    live now, or at `corpus_version` with the entity created by then."""
    if not entity_ids:
        return {}
    out: dict[uuid.UUID, dict[str, Any]] = {}
    if corpus_version is None:
        query = (select(CurrentValue.entity_id, CurrentValue.field, Observation.value)
                 .join(Observation, Observation.id == CurrentValue.observation_id)
                 .where(CurrentValue.entity_id.in_(entity_ids))
                 .order_by(CurrentValue.period))  # the latest period wins
        if fields:
            query = query.where(CurrentValue.field.in_(fields))
        for entity_id, field, value in session.execute(query):
            out.setdefault(entity_id, {})[field] = value.get("v")
        return out
    query = (select(Observation).join(Entity, Entity.id == Observation.entity_id)
             .where(Observation.entity_id.in_(entity_ids),
                    Entity.created_version_id <= corpus_version,
                    live_at(Observation, corpus_version)))
    if fields:
        query = query.where(Observation.field.in_(fields))
    groups: dict[tuple, list[Observation]] = {}
    for o in session.scalars(query):
        groups.setdefault((o.entity_id, o.field, o.period or 0), []).append(o)
    events = session.scalars(select(ValuePin).where(
        ValuePin.entity_id.in_(entity_ids), live_at(ValuePin, corpus_version))
        .order_by(ValuePin.id)).all()
    pins = {(p.entity_id, p.field, p.period): p for p in events}
    confidence = dict(session.execute(select(SourceType.key, SourceType.confidence)).all())
    for key in sorted(groups, key=lambda k: k[2]):  # the latest period wins
        pin = pins.get(key)
        best, _ = winner(groups[key], pin if pin and pin.observation_id else None, confidence)
        out.setdefault(key[0], {})[key[1]] = best.value.get("v")
    return out


def _created_live(session: Session, roles: list[Entity],
                  corpus_version: int | None) -> set[tuple[uuid.UUID, int]]:
    """(person, version) pairs of these roles where the version that created
    the role still has a live observation on its person (now, or as of
    `corpus_version`)."""
    if not roles:
        return set()
    live = (Observation.retracted_version_id.is_(None) if corpus_version is None
            else live_at(Observation, corpus_version))
    query = select(Observation.entity_id, Observation.version_id).where(
        Observation.entity_id.in_({r.person_id for r in roles}),
        Observation.version_id.in_({r.created_version_id for r in roles}), live).distinct()
    return {(person_id, version_id) for person_id, version_id in session.execute(query)}


def _current(end_date: dict | None, today: date) -> bool:
    """No end date, or one that hasn't passed (a month or year runs to its end)."""
    if not end_date:
        return True
    d = date.fromisoformat(end_date["date"])
    if end_date.get("precision") == "year":
        d = date(d.year, 12, 31)
    elif end_date.get("precision") == "month":
        d = date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])
    return d >= today


def _name(values: dict[str, Any]) -> str:
    if values.get("full_name"):
        return values["full_name"].strip()
    return " ".join(p for p in (values.get("first_name"), values.get("last_name")) if p).strip()


class _Users:
    """Resolves "Known by" values to team members: email, else exact name."""

    def __init__(self, session: Session):
        users = session.scalars(select(User)).all()
        self.by_email = {u.email.lower(): u for u in users}
        self.by_name = {u.name.strip().lower(): u for u in users if u.name}

    def known(self, values: list[str]) -> list[dict]:
        out: dict[tuple, dict] = {}
        for written in values:
            text = written.strip()
            user = self.by_email.get(text.lower()) or self.by_name.get(text.lower())
            if user:
                out.setdefault(("user", user.id),
                               {"name": user.name, "email": user.email, "user": True})
            else:
                out.setdefault(("text", text.lower()), {
                    "name": text, "email": text if EMAIL.match(text) else None,
                    "user": False})
        return sorted(out.values(), key=lambda k: k["name"].lower())


def _people(session: Session, person_ids: list[uuid.UUID], corpus_version: int | None,
            past_roles: bool = False) -> dict[uuid.UUID, dict]:
    """Contact items for the visible ones of these people. `roles` holds the
    current roles (past ones too with `past_roles`), current first, then by
    company name."""
    persons = _shown(session, person_ids, corpus_version)
    if not persons:
        return {}
    children = session.scalars(select(Entity).where(
        Entity.person_id.in_(list(persons)), Entity.kind.in_(("role", "relationship")),
        *([Entity.created_version_id <= corpus_version] if corpus_version is not None else []))).all()
    shown = _shown(session, [e.id for e in children], corpus_version)
    bare = [e for e in children if e.kind == "role" and e.id not in shown]
    created = _created_live(session, bare, corpus_version)
    roles = [e for e in children if e.kind == "role"
             and (e.id in shown or (e.person_id, e.created_version_id) in created)]
    companies = _shown(session, list({r.company_id for r in roles if r.company_id}),
                       corpus_version, ("name",))
    users = _Users(session)
    today = date.today()
    items: dict[uuid.UUID, dict] = {}
    for pid, values in persons.items():
        items[pid] = {
            "id": str(pid), "name": _name(values),
            "first_name": values.get("first_name"), "last_name": values.get("last_name"),
            "email": values.get("email"), "phone": values.get("phone"),
            "linkedin": values.get("person_linkedin_url"),
            "roles": [], "known_by": users.known([
                shown[e.id]["helbling_person"] for e in children
                if e.kind == "relationship" and e.person_id == pid
                and shown.get(e.id, {}).get("helbling_person")]),
        }
    for r in roles:
        values = shown.get(r.id, {})
        role = {
            "id": str(r.id), "company_id": str(r.company_id) if r.company_id else None,
            "company_name": companies.get(r.company_id, {}).get("name"),
            "title": values.get("title"), "function": values.get("function"),
            "primary": values.get("is_primary_contact") is True,
            "current": _current(values.get("end_date"), today),
        }
        if role["current"] or past_roles:
            items[r.person_id]["roles"].append(role)
    for item in items.values():
        item["roles"].sort(key=lambda r: (not r["current"], (r["company_name"] or "").lower()))
    return items


def company_contacts(session: Session, company_ids: list[uuid.UUID],
                     corpus_version: int | None = None) -> dict[uuid.UUID, list[dict]]:
    """Each company's current contacts (live, or as of `corpus_version`), the
    primary contact first, then by name. Each item has `role`: its role here."""
    out: dict[uuid.UUID, list[dict]] = {c: [] for c in company_ids}
    if not company_ids:
        return out
    people = _people(session, list(session.scalars(select(Entity.person_id).where(
        Entity.kind == "role", Entity.company_id.in_(company_ids)).distinct())),
        corpus_version)
    for item in people.values():
        for company_id in company_ids:
            here = [r for r in item["roles"] if r["company_id"] == str(company_id)]
            if here:  # the primary role, if a person holds several here
                role = max(here, key=lambda r: r["primary"])
                out[company_id].append({**item, "role": role})
    for items in out.values():
        items.sort(key=lambda i: (not i["role"]["primary"], i["name"].lower()))
    return out


def search_contacts(session: Session, q: str | None, offset: int,
                    limit: int) -> tuple[int, list[dict]]:
    """Live contacts by name; `q` matches (case-insensitive substring) the
    name, email, a current role's title or a current company's name."""
    def matching(fields: tuple[str, ...]):
        query = (select(CurrentValue.entity_id)
                 .join(Observation, Observation.id == CurrentValue.observation_id)
                 .where(CurrentValue.field.in_(fields)))
        if q:
            escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            query = query.where(Observation.value["v"].astext.ilike(f"%{escaped}%",
                                                                    escape="\\"))
        return query

    candidates = select(Entity.id).where(Entity.kind == "person")
    if q:
        role_people = select(Entity.person_id).where(Entity.kind == "role", (
            Entity.id.in_(matching(("title",)))
            | Entity.company_id.in_(matching(("name",)))))
        candidates = candidates.where(Entity.id.in_(matching(PERSON_FIELDS))
                                      | Entity.id.in_(role_people))
    items = list(_people(session, list(session.scalars(candidates)), None).values())
    if q:
        # The SQL above also finds past roles; keep current ones only.
        needle = q.lower()
        items = [i for i in items if any(needle in (v or "").lower() for v in (
            i["name"], i["email"], *(r["title"] for r in i["roles"]),
            *(r["company_name"] for r in i["roles"])))]
    items.sort(key=lambda i: (i["name"].lower(), i["id"]))
    return len(items), items[offset:offset + limit]


def contact_detail(session: Session, person_id: uuid.UUID) -> dict:
    """A contact's cells with every source, each role (current first, past
    too) with its own cells, and who at Helbling knows them."""
    entity = session.get(Entity, person_id)
    item = _people(session, [person_id], None, past_roles=True).get(person_id) \
        if entity is not None and entity.kind == "person" else None
    if item is None:
        raise HTTPException(404, "Contact not found.")
    return {
        "id": item["id"], "name": item["name"],
        "cells": entity_cells(session, person_id)["cells"],
        "roles": [{**r, "cells": entity_cells(session, uuid.UUID(r["id"]))["cells"]}
                  for r in item["roles"]],
        "known_by": item["known_by"],
    }


@router.get("/contacts")
def contacts(
    _: SignedIn, session: Db,
    q: str | None = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict:
    """Search contacts by name, email, title or company; sorted by name."""
    total, items = search_contacts(session, q.strip() if q else None, offset, limit)
    return {"total": total, "offset": offset, "limit": limit, "items": items}


@router.get("/contacts/{person_id}")
def contact(person_id: uuid.UUID, _: SignedIn, session: Db) -> dict:
    return contact_detail(session, person_id)
