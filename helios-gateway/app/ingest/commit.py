"""Commit a reviewed import as one version, and revert versions.

A commit holds a Postgres advisory lock so only one runs at a time. If the
database changed since the report was built (another import committed), the
dev is sent back to review. Everything for one import is one transaction.
"""

import uuid

from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from app.models import Entity, Import, Longlist, Observation, ValuePin, Version
from app.values import recompute

LOCK_ID = 7_331_001


class StaleReport(Exception):
    """The database changed after the report was built."""


def commit(session: Session, imp: Import, author: str, progress=None) -> Version:
    session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": LOCK_ID})
    latest = session.scalar(select(func.max(Version.id))) or 0
    if imp.report is None or imp.report["base_version"] != latest:
        raise StaleReport()

    version = Version(kind="import", import_id=imp.id, author=author,
                      message=f"Imported {_filename(session, imp)}")
    session.add(version)
    session.flush()

    list_id = imp.list_id
    if not list_id and imp.new_list_name:
        longlist = Longlist(name=imp.new_list_name, created_version_id=version.id)
        session.add(longlist)
        session.flush()
        list_id = longlist.id

    rows = imp.report["rows"]
    decisions = {**{r["key"]: r["decision"] for r in rows}, **(imp.decisions or {})}
    created: dict[str, uuid.UUID] = {}  # row key → company entity id
    touched: set[uuid.UUID] = set()
    counts = {"companies_new": 0, "companies_updated": 0, "people_new": 0,
              "people_updated": 0, "values": 0, "rows_skipped": 0}

    def entity(kind: str, **parents) -> Entity:
        e = Entity(kind=kind, created_version_id=version.id, **parents)
        session.add(e)
        session.flush()
        return e

    def observe(e: Entity, r: dict, cell: dict) -> None:
        session.add(Observation(
            entity_id=e.id, field=cell["field"], period=cell.get("period"),
            value={"v": cell["value"]}, raw=cell.get("raw"),
            source_type=imp.source_type, document_id=imp.document_id,
            sheet=r["sheet"], row=r["row"], col=cell["letter"], as_of=imp.as_of,
            version_id=version.id,
        ))
        touched.add(e.id)
        counts["values"] += 1

    # Rows that duplicate an earlier row resolve after it.
    ordered = sorted(rows, key=lambda r: str(decisions.get(r["key"], "")).startswith("dup:"))
    for n, r in enumerate(ordered):
        decision = decisions.get(r["key"], "skip")
        good = [c for c in r["cells"] if not c.get("error") and "value" in c]
        if decision == "skip" or not good:
            counts["rows_skipped"] += 1
            continue
        company = None
        if r["company"]:
            if decision.startswith("dup:"):
                company_id = created.get(decision[4:]) or _target(decisions.get(decision[4:]))
            elif decision == "new":
                company_id = None
            else:
                company_id = uuid.UUID(decision)
            if company_id:
                company = session.get(Entity, company_id)
                counts["companies_updated"] += 1
            else:
                company = entity("company")
                counts["companies_new"] += 1
            created[r["key"]] = company.id
            for c in good:
                if c["entity"] == "company":
                    observe(company, r, c)
            for kind in ("transaction", "project_ref"):
                child_cells = [c for c in good if c["entity"] == kind]
                if child_cells:
                    child = entity(kind, company_id=company.id)
                    for c in child_cells:
                        observe(child, r, c)
            list_cells = [c for c in good if c["entity"] == "list_entry"]
            if list_id:
                entry = session.scalar(select(Entity).where(
                    Entity.kind == "list_entry", Entity.list_id == list_id,
                    Entity.company_id == company.id))
                if entry is None:
                    entry = entity("list_entry", company_id=company.id, list_id=list_id)
                    touched.add(entry.id)
                for c in list_cells:
                    observe(entry, r, c)

        person_cells = [c for c in good if c["entity"] == "person"]
        if r["person"] and person_cells:
            person_decision = decisions.get(f"{r['key']}:person")
            match = r["person"]["match"]
            if person_decision and person_decision not in ("new", "skip"):
                person = session.get(Entity, uuid.UUID(person_decision))
            elif person_decision != "new" and match["level"] in ("certain", "likely"):
                person = session.get(Entity, uuid.UUID(match["entity_id"]))
            else:
                person = None
            if person_decision == "skip":
                person = None
            elif person is None:
                person = entity("person")
                counts["people_new"] += 1
            else:
                counts["people_updated"] += 1
            if person is not None:
                for c in person_cells:
                    observe(person, r, c)
                if company is not None:
                    role = session.scalar(select(Entity).where(
                        Entity.kind == "role", Entity.person_id == person.id,
                        Entity.company_id == company.id))
                    if role is None:
                        role = entity("role", person_id=person.id, company_id=company.id)
                        touched.add(role.id)
                    for c in good:
                        if c["entity"] == "role":
                            observe(role, r, c)
        if progress and n % 200 == 0:
            progress(0.1 + 0.7 * n / max(1, len(ordered)), "Writing values")

    session.flush()
    if progress:
        progress(0.85, "Recomputing shown values")
    recompute(session, touched)
    version.counts = counts
    imp.version_id = version.id
    imp.status = "committed"
    return version


def _target(decision: str | None) -> uuid.UUID | None:
    if decision and decision not in ("new", "skip") and not decision.startswith("dup:"):
        return uuid.UUID(decision)
    return None


def _filename(session: Session, imp: Import) -> str:
    from app.models import Document

    doc = session.get(Document, imp.document_id)
    return doc.filename if doc else "file"


def revert(session: Session, target: Version, author: str) -> Version:
    """Withdraw a version's values (or, for a revert, re-apply what it
    withdrew) as a new version. Nothing is deleted."""
    session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": LOCK_ID})
    if target.reverted_by_version_id:
        raise ValueError("This version has already been reverted.")
    version = Version(kind="revert", reverts_version_id=target.id, author=author,
                      message=f"Reverted version {target.id}")
    session.add(version)
    session.flush()
    if target.kind == "revert":
        # Re-apply: bring back what the revert withdrew.
        affected = [*session.scalars(select(Observation.entity_id).where(
            Observation.retracted_version_id == target.id)),
            *session.scalars(select(ValuePin.entity_id).where(
                ValuePin.retracted_version_id == target.id))]
        for table in (Observation, ValuePin):
            session.execute(update(table)
                            .where(table.retracted_version_id == target.id)
                            .values(retracted_version_id=None))
        original = session.get(Version, target.reverts_version_id)
        if original:
            original.reverted_by_version_id = None
        version.message = f"Re-applied version {target.reverts_version_id}"
    else:
        # An import's values, or a pin / priority removal.
        affected = [*session.scalars(select(Observation.entity_id).where(
            Observation.version_id == target.id,
            Observation.retracted_version_id.is_(None))),
            *session.scalars(select(ValuePin.entity_id).where(
                ValuePin.version_id == target.id,
                ValuePin.retracted_version_id.is_(None)))]
        for table in (Observation, ValuePin):
            session.execute(update(table)
                            .where(table.version_id == target.id,
                                   table.retracted_version_id.is_(None))
                            .values(retracted_version_id=version.id))
    target.reverted_by_version_id = version.id
    version.counts = {"values": len(affected)}
    session.flush()
    recompute(session, set(affected))
    return version

