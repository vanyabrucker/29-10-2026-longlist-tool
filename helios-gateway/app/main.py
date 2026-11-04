"""Helios gateway API: dev-only import endpoints and the master-data read API."""

import hashlib
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from pathlib import PurePath
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import catalogue, storage
from app.config import settings
from app.db import get_session
from app.ingest import detect, parse, runner
from app.ingest.commit import revert
from app.models import (
    CurrentValue,
    Document,
    Entity,
    Import,
    Longlist,
    Observation,
    RawRow,
    SourceType,
    Version,
)
from app.quality import level, score

PREVIEW_ROWS = 12
EDITABLE = ("mapping_review", "report_review", "failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    runner.fail_interrupted()
    yield


app = FastAPI(title="Helios gateway", lifespan=lifespan)


def user(
    x_gateway_secret: Annotated[str | None, Header()] = None,
    x_user_email: Annotated[str | None, Header()] = None,
) -> str:
    """Checks the shared secret (when configured) and returns the acting dev."""
    secret = settings().gateway_secret
    if secret and x_gateway_secret != secret:
        raise HTTPException(401, "Missing or wrong gateway secret.")
    return x_user_email or "dev"


Db = Annotated[Session, Depends(get_session)]
User = Annotated[str, Depends(user)]


def _import(session: Session, import_id: uuid.UUID) -> Import:
    imp = session.get(Import, import_id)
    if imp is None:
        raise HTTPException(404, "Import not found.")
    return imp


def _iso(d: date | datetime | None) -> str | None:
    return d.isoformat() if d else None


# ── Reference data ─────────────────────────────────────────────────────────


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/catalogue")
def get_catalogue(_: User) -> dict:
    return catalogue.to_json()


@app.get("/source-types")
def source_types(_: User, session: Db) -> list[dict]:
    rows = session.scalars(select(SourceType).order_by(SourceType.sort)).all()
    return [{"key": r.key, "label": r.label, "confidence": r.confidence} for r in rows]


@app.get("/longlists")
def longlists(_: User, session: Db) -> list[dict]:
    rows = session.scalars(select(Longlist).order_by(Longlist.created_at.desc())).all()
    return [{"id": str(r.id), "name": r.name} for r in rows]


# ── Imports ────────────────────────────────────────────────────────────────


def _summary(session: Session, imp: Import) -> dict:
    doc = session.get(Document, imp.document_id)
    return {
        "id": str(imp.id),
        "filename": doc.filename,
        "document_id": str(doc.id),
        "size": doc.size,
        "status": imp.status,
        "step": imp.step,
        "progress": imp.progress,
        "eta_seconds": imp.eta_seconds,
        "error": imp.error,
        "source_type": imp.source_type,
        "as_of": _iso(imp.as_of),
        "version_id": imp.version_id,
        "created_by": imp.created_by,
        "created_at": _iso(imp.created_at),
        "rows": (imp.report or {}).get("summary", {}).get("rows"),
    }


@app.get("/imports")
def list_imports(_: User, session: Db) -> list[dict]:
    rows = session.scalars(select(Import).order_by(Import.created_at.desc()).limit(200))
    return [_summary(session, i) for i in rows]


@app.post("/imports", status_code=201)
async def upload(
    author: User,
    session: Db,
    file: UploadFile = File(...),
    source_type: str = Form("internal"),
    last_modified: int | None = Form(None),
    allow_duplicate: bool = Form(False),
) -> dict:
    data = await file.read()
    filename = PurePath(file.filename or "upload").name
    if not data:
        raise HTTPException(400, "The file is empty.")
    if PurePath(filename).suffix.lower() not in parse.SUPPORTED:
        raise HTTPException(
            400, "Unsupported file type. Upload .xlsx, .xlsm, .xls, .xlsb, .ods or .csv."
        )
    if session.get(SourceType, source_type) is None:
        raise HTTPException(400, f"Unknown source type '{source_type}'.")
    sha = hashlib.sha256(data).hexdigest()
    if not allow_duplicate:
        previous = session.execute(
            select(Import, Document).join(Document, Document.id == Import.document_id)
            .where(Document.sha256 == sha).order_by(Import.created_at.desc())
        ).all()
        if previous:
            raise HTTPException(409, {
                "message": "This exact file was uploaded before.",
                "previous": [{"id": str(i.id), "filename": d.filename, "status": i.status,
                              "created_at": _iso(i.created_at)} for i, d in previous],
            })
    doc_id = uuid.uuid4()
    key = f"documents/{doc_id}/{filename}"
    storage.put(key, data, file.content_type)
    session.add(Document(id=doc_id, filename=filename, sha256=sha, size=len(data),
                         content_type=file.content_type, storage_key=key,
                         uploaded_by=author))
    # As-of defaults to the file's last-modified date (the dev confirms it).
    as_of = (datetime.fromtimestamp(last_modified / 1000, UTC).date()
             if last_modified else date.today())
    imp = Import(document_id=doc_id, source_type=source_type, as_of=as_of,
                 created_by=author, catalogue_version=catalogue.CATALOGUE_VERSION)
    session.add(imp)
    session.commit()
    runner.start_analysis(imp.id)
    return {"id": str(imp.id)}


@app.get("/imports/{import_id}")
def get_import(import_id: uuid.UUID, _: User, session: Db) -> dict:
    imp = _import(session, import_id)
    previews: dict[int, list[dict]] = {}
    for ti in range(len(imp.tables)):
        rows = session.scalars(
            select(RawRow).where(RawRow.import_id == imp.id, RawRow.table_index == ti)
            .order_by(RawRow.row_number).limit(PREVIEW_ROWS)
        ).all()
        previews[ti] = [{"row": r.row_number, "cells": r.cells} for r in rows]
    return {
        **_summary(session, imp),
        "warnings": imp.warnings,
        "list_id": str(imp.list_id) if imp.list_id else None,
        "new_list_name": imp.new_list_name,
        "catalogue_version": imp.catalogue_version,
        "tables": [{**t, "preview": previews.get(i, [])} for i, t in enumerate(imp.tables)],
        "feedback": imp.feedback,
        "report": imp.report,
        "decisions": imp.decisions,
    }


class ImportSettings(BaseModel):
    source_type: str | None = None
    as_of: date | None = None
    list_id: uuid.UUID | None = None
    new_list_name: str | None = None


@app.patch("/imports/{import_id}")
def update_settings(import_id: uuid.UUID, body: ImportSettings, _: User, session: Db) -> dict:
    imp = _import(session, import_id)
    if imp.status not in EDITABLE:
        raise HTTPException(409, f"Can't change settings while the import is {imp.status}.")
    changes = body.model_dump(exclude_unset=True)
    if "source_type" in changes and session.get(SourceType, changes["source_type"]) is None:
        raise HTTPException(400, "Unknown source type.")
    for k, v in changes.items():
        setattr(imp, k, v)
    if {"source_type", "as_of"} & changes.keys():
        imp.report = None  # scores depend on both
        if imp.status == "report_review":
            imp.status = "mapping_review"
    return {"ok": True}


class ColumnEdit(BaseModel):
    letter: str
    field: str | None
    period: int | None = None


class TableEdit(BaseModel):
    include: bool = True
    header_row: int | None = None
    first_data_row: int | None = None
    last_row: int | None = None
    columns: list[ColumnEdit] = []


@app.put("/imports/{import_id}/tables")
def edit_tables(import_id: uuid.UUID, body: list[TableEdit], _: User, session: Db) -> dict:
    """The dev's direct corrections: include/exclude tables, fix a table's
    header row or data range, change column mappings."""
    imp = _import(session, import_id)
    if imp.status not in EDITABLE:
        raise HTTPException(409, f"Can't edit while the import is {imp.status}.")
    if len(body) != len(imp.tables):
        raise HTTPException(400, "Send one edit per table.")
    tables = [dict(t) for t in imp.tables]
    sheets = None
    for ti, (t, edit) in enumerate(zip(tables, body, strict=True)):
        t["include"] = edit.include
        geometry = (edit.header_row, edit.first_data_row, edit.last_row)
        if any(geometry) and geometry != (t["header_row"], t["first_data_row"], t["last_row"]):
            if sheets is None:
                doc = session.get(Document, imp.document_id)
                sheets = {s.name: s for s in parse.parse(doc.filename, storage.get(doc.storage_key))[0]}
            sheet = sheets[t["sheet"]]
            h = edit.header_row or t["header_row"]
            f = edit.first_data_row or h + 1
            last = min(edit.last_row or t["last_row"], len(sheet.rows))
            if not 1 <= h < f <= last:
                raise HTTPException(400, f"Invalid rows for table {ti + 1}.")
            fields = {c["letter"]: c for c in t["columns"]}
            fresh = detect._table(sheet, h - 1, f - 1, last - 1, t.get("title", ""))
            for c in fresh["columns"]:
                old = fields.get(c["letter"], {})
                c.update(field=old.get("field"), period=old.get("period"),
                         confidence=old.get("confidence"), reason=old.get("reason", ""),
                         suggested_field=old.get("suggested_field"))
            t.update({k: fresh[k] for k in ("header_row", "first_data_row", "last_row", "columns")})
            session.execute(RawRow.__table__.delete().where(
                RawRow.import_id == imp.id, RawRow.table_index == ti))
            rows = detect.rows_of(sheet, t)
            for row_number, cells in rows:
                session.add(RawRow(import_id=imp.id, table_index=ti, sheet=t["sheet"],
                                   row_number=row_number, cells=cells))
            t["row_count"] = len(rows)
        by_letter = {c.letter: c for c in edit.columns}
        for c in t["columns"]:
            if c["letter"] in by_letter:
                e = by_letter[c["letter"]]
                if e.field and e.field not in catalogue.CATALOGUE:
                    raise HTTPException(400, f"Unknown data point '{e.field}'.")
                c["field"], c["period"] = e.field, e.period
    imp.tables = tables
    imp.report = None
    imp.status = "mapping_review"
    return {"ok": True}


class Feedback(BaseModel):
    text: str


@app.post("/imports/{import_id}/feedback")
def feedback(import_id: uuid.UUID, body: Feedback, author: User, session: Db) -> dict:
    imp = _import(session, import_id)
    if imp.status not in EDITABLE:
        raise HTTPException(409, f"Can't give feedback while the import is {imp.status}.")
    if not body.text.strip():
        raise HTTPException(400, "Feedback is empty.")
    imp.feedback = [*imp.feedback, {"text": body.text.strip(), "by": author,
                                    "at": datetime.now(UTC).isoformat()}]
    session.commit()
    runner.start_remap(imp.id)
    return {"ok": True}


@app.post("/imports/{import_id}/report")
def make_report(import_id: uuid.UUID, _: User, session: Db) -> dict:
    """The dev confirmed the mapping: build the review report."""
    imp = _import(session, import_id)
    if imp.status not in ("mapping_review", "report_review"):
        raise HTTPException(409, f"Can't build a report while the import is {imp.status}.")
    if not any(t.get("include") for t in imp.tables):
        raise HTTPException(400, "Include at least one table.")
    runner.start_report(imp.id)
    return {"ok": True}


class Decisions(BaseModel):
    decisions: dict[str, str]


@app.put("/imports/{import_id}/decisions")
def set_decisions(import_id: uuid.UUID, body: Decisions, _: User, session: Db) -> dict:
    imp = _import(session, import_id)
    if imp.status != "report_review":
        raise HTTPException(409, "Decisions can only be changed in review.")
    for key, decision in body.decisions.items():
        if decision not in ("new", "skip") and not decision.startswith("dup:"):
            try:
                uuid.UUID(decision)
            except ValueError as e:
                raise HTTPException(400, f"Invalid decision for {key}.") from e
    imp.decisions = {**imp.decisions, **body.decisions}
    return {"ok": True}


@app.post("/imports/{import_id}/commit")
def commit_import(import_id: uuid.UUID, author: User, session: Db) -> dict:
    imp = _import(session, import_id)
    if imp.status != "report_review" or not imp.report:
        raise HTTPException(409, "Only a reviewed import can be committed.")
    runner.start_commit(imp.id, author)
    return {"ok": True}


@app.post("/imports/{import_id}/cancel")
def cancel(import_id: uuid.UUID, _: User, session: Db) -> dict:
    imp = _import(session, import_id)
    if imp.status in ("committed", "committing"):
        raise HTTPException(409, "A committed import is undone by reverting its version.")
    imp.status = "cancelled"
    return {"ok": True}


@app.get("/documents/{document_id}/file")
def download(document_id: uuid.UUID, _: User, session: Db) -> Response:
    doc = session.get(Document, document_id)
    if doc is None:
        raise HTTPException(404, "Document not found.")
    return Response(
        storage.get(doc.storage_key),
        media_type=doc.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{doc.filename}"'},
    )


# ── Versions ───────────────────────────────────────────────────────────────


def _version(session: Session, v: Version) -> dict:
    filename = None
    if v.import_id:
        imp = session.get(Import, v.import_id)
        filename = session.get(Document, imp.document_id).filename if imp else None
    return {
        "id": v.id, "kind": v.kind, "author": v.author, "message": v.message,
        "counts": v.counts, "created_at": _iso(v.created_at),
        "import_id": str(v.import_id) if v.import_id else None, "filename": filename,
        "reverts_version_id": v.reverts_version_id,
        "reverted_by_version_id": v.reverted_by_version_id,
    }


@app.get("/versions")
def versions(_: User, session: Db) -> list[dict]:
    rows = session.scalars(select(Version).order_by(Version.id.desc()).limit(200))
    return [_version(session, v) for v in rows]


@app.post("/versions/{version_id}/revert")
def revert_version(version_id: int, author: User, session: Db) -> dict:
    target = session.get(Version, version_id)
    if target is None:
        raise HTTPException(404, "Version not found.")
    try:
        return _version(session, revert(session, target, author))
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


# ── Master data (read) ─────────────────────────────────────────────────────


def _display(value: Any) -> Any:
    return value.get("v") if isinstance(value, dict) else value


@app.get("/companies")
def companies(_: User, session: Db, q: str | None = None, category: str | None = None,
              limit: int = 200) -> list[dict]:
    """Companies with their shown values (live ones only)."""
    rows = session.execute(
        select(CurrentValue.entity_id, CurrentValue.field, CurrentValue.period,
               CurrentValue.score, CurrentValue.sources, Observation.value)
        .join(Observation, Observation.id == CurrentValue.observation_id)
        .join(Entity, Entity.id == CurrentValue.entity_id)
        .where(Entity.kind == "company")
    ).all()
    by_company: dict[str, dict] = {}
    for entity_id, field, period, sc, sources, value in rows:
        company = by_company.setdefault(str(entity_id), {"id": str(entity_id), "values": {}})
        current = company["values"].get(field)
        # Show the latest fiscal year for per-year data points.
        if current is None or (period or 0) > current["period"]:
            company["values"][field] = {"value": _display(value), "period": period or 0,
                                        "score": sc, "level": level(sc), "sources": sources}
    out = list(by_company.values())
    if q:
        out = [c for c in out if q.lower() in str(c["values"].get("name", {}).get("value", "")).lower()]
    if category:
        out = [c for c in out
               if c["values"].get("buyer_category", {}).get("value") == category]
    out.sort(key=lambda c: str(c["values"].get("name", {}).get("value", "")).lower())
    return out[:limit]


@app.get("/companies/{company_id}")
def company(company_id: uuid.UUID, _: User, session: Db) -> dict:
    """Every data point with the shown value and all its sources."""
    entity = session.get(Entity, company_id)
    if entity is None or entity.kind != "company":
        raise HTTPException(404, "Company not found.")
    confidence = dict(session.execute(select(SourceType.key, SourceType.confidence)).all())
    winners = {(f, p): o for f, p, o in session.execute(
        select(CurrentValue.field, CurrentValue.period, CurrentValue.observation_id)
        .where(CurrentValue.entity_id == company_id)).all()}
    observations = session.scalars(
        select(Observation).where(Observation.entity_id == company_id)
        .order_by(Observation.field, Observation.period, Observation.version_id.desc())
    ).all()
    fields: dict[str, list[dict]] = {}
    for o in observations:
        fields.setdefault(o.field, []).append({
            "value": _display(o.value), "raw": o.raw, "period": o.period,
            "source_type": o.source_type, "document_id": str(o.document_id) if o.document_id else None,
            "sheet": o.sheet, "row": o.row, "col": o.col, "as_of": _iso(o.as_of),
            "version_id": o.version_id, "retracted": o.retracted_version_id is not None,
            "score": score(confidence[o.source_type], o.field, o.as_of),
            "shown": winners.get((o.field, o.period or 0)) == o.id,
        })
    people = session.execute(
        select(Entity.person_id).where(Entity.kind == "role", Entity.company_id == company_id)
    ).scalars().all()
    return {"id": str(company_id), "fields": fields,
            "people": [str(p) for p in people if p],
            "versions": sorted({o.version_id for o in observations})}


@app.get("/stats")
def stats(_: User, session: Db) -> dict:
    counts = dict(session.execute(
        select(Entity.kind, func.count()).group_by(Entity.kind)).all())
    return {"entities": counts,
            "observations": session.scalar(select(func.count()).select_from(Observation))}
