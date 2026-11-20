"""Writes contacts (people, their roles at companies, and who at Helbling knows
them) as corpus records in one revertable version.

    uv run python -m app.seed_contacts     # fictional contacts, dev databases only

`write_contacts` is also the helper tests use to create contacts.
"""

import random
import re
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.config import settings
from app.db import session_scope
from app.models import CurrentValue, Entity, Observation, User, Version
from app.values import recompute

SEED_AUTHOR = "contacts-seed@helbling.ch"
NOT_A_USER = "Thomas Keller"


@dataclass(frozen=True)
class ContactSpec:
    company_id: uuid.UUID
    first_name: str
    last_name: str
    email: str | None = None
    phone: str | None = None
    linkedin: str | None = None
    title: str | None = None
    function: str | None = None  # one of the catalogue's function options
    primary: bool = False
    known_by: tuple[str, ...] = ()  # names or emails
    end_date: date | None = None


def write_contacts(session: Session, specs: list[ContactSpec], author: str,
                   source_type: str = "internal", as_of: date | None = None) -> Version:
    """One version holding a person, a role and a relationship per spec entry."""
    as_of = as_of or date.today()
    version = Version(kind="import", author=author, message=f"Added {len(specs)} contacts")
    session.add(version)
    session.flush()
    touched: set[uuid.UUID] = set()

    def entity(kind: str, **parents) -> Entity:
        e = Entity(kind=kind, created_version_id=version.id, **parents)
        session.add(e)
        session.flush()
        touched.add(e.id)
        return e

    def observe(e: Entity, field: str, value) -> None:
        session.add(Observation(
            entity_id=e.id, field=field, value={"v": value}, source_type=source_type,
            source_by=author, as_of=as_of, version_id=version.id))

    for s in specs:
        person = entity("person")
        observe(person, "first_name", s.first_name)
        observe(person, "last_name", s.last_name)
        observe(person, "full_name", f"{s.first_name} {s.last_name}")
        for field, value in (("email", s.email), ("phone", s.phone),
                             ("person_linkedin_url", s.linkedin)):
            if value:
                observe(person, field, value)
        role = entity("role", person_id=person.id, company_id=s.company_id)
        for field, value in (("title", s.title), ("function", s.function)):
            if value:
                observe(role, field, value)
        if s.end_date:
            observe(role, "end_date", {"date": s.end_date.isoformat(), "precision": "day"})
        observe(role, "is_primary_contact", s.primary)
        for who in s.known_by:
            rel = entity("relationship", person_id=person.id)
            observe(rel, "helbling_person", who)
    session.flush()
    version.counts = {"people_new": len(specs), "values": len(touched)}
    recompute(session, touched)
    return version


FIRST = ["Anna", "Lukas", "Sophie", "Marc", "Julia", "Stefan", "Laura", "Daniel", "Katrin",
         "Felix", "Nora", "Jonas", "Eva", "Tobias", "Mara", "Philipp", "Lena", "Reto"]
LAST = ["Muster", "Keller", "Weber", "Brunner", "Schmid", "Fischer", "Meier", "Huber",
        "Baumann", "Frei", "Gerber", "Roth", "Vogel", "Lehmann", "Steiner", "Berger"]
TITLES = [("Chief Executive Officer", "CEO"), ("Chief Financial Officer", "CFO"),
          ("Head of Strategy", "Head of Strategy"), ("Head of M&A", "M&A"),
          ("Director Corporate Development", "M&A"), ("Managing Director", "Other"),
          ("Head of Business Development", "Other")]


def _ascii(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower())


def _domain_for(session: Session, company_id: uuid.UUID) -> str | None:
    return session.scalar(
        select(Observation.value["v"].astext)
        .join(CurrentValue, CurrentValue.observation_id == Observation.id)
        .where(CurrentValue.entity_id == company_id, CurrentValue.field == "website"))


def seed_specs(session: Session) -> list[ContactSpec]:
    rng = random.Random(7)
    users = [n for n in session.scalars(select(User.name).order_by(User.name)) if n]
    knowers = [*users, NOT_A_USER]
    names = (select(Observation.entity_id, Observation.value["v"].astext.label("name"))
             .join(CurrentValue, CurrentValue.observation_id == Observation.id)
             .where(CurrentValue.field == "name").subquery())
    companies = session.execute(
        select(names.c.entity_id).join(Entity, Entity.id == names.c.entity_id)
        .where(Entity.kind == "company").order_by(names.c.name).limit(40)).scalars().all()
    specs = []
    for cid in companies:
        domain = _domain_for(session, cid)
        roll = rng.random()
        count = 0 if roll < 0.2 else rng.choice([1, 2, 2, 3, 3]) if roll < 0.9 \
            else rng.choice([4, 5])
        for i in range(count):
            first, last = rng.choice(FIRST), rng.choice(LAST)
            title, function = rng.choice(TITLES)
            specs.append(ContactSpec(
                company_id=cid, first_name=first, last_name=last,
                email=f"{_ascii(first)}.{_ascii(last)}@{domain}"
                if domain and rng.random() < 0.8 else None,
                phone=f"+41 44 {rng.randint(100, 999)} {rng.randint(10, 99)} "
                      f"{rng.randint(10, 99)}" if rng.random() < 0.5 else None,
                linkedin=f"https://www.linkedin.com/in/{_ascii(first)}-{_ascii(last)}"
                if rng.random() < 0.4 else None,
                title=title if rng.random() < 0.85 else None,
                function=function if rng.random() < 0.7 else None,
                primary=i == 0,
                known_by=tuple(rng.sample(knowers, rng.choice([0, 1, 1, 2]))),
            ))
    return specs


def main() -> None:
    name = make_url(settings().database_url).database or ""
    if not name.startswith("helios"):
        raise SystemExit(f"Refusing to seed contacts into database {name!r}: "
                         "dev databases only (name must start with 'helios').")
    with session_scope() as session:
        specs = seed_specs(session)
        if not specs:
            raise SystemExit("No companies in the corpus; import some first.")
        version = write_contacts(session, specs, SEED_AUTHOR)
        print(f"Version {version.id}: {version.message}")


if __name__ == "__main__":
    main()
