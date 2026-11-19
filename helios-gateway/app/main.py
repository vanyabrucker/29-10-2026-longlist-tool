"""Helios gateway API: import endpoints (corpus imports for devs, list
imports for everyone signed in); the corpus read API and pins live in
app/corpus.py, lists in app/longlist_api.py."""

import hashlib
import logging
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from pathlib import PurePath
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import auth, catalogue, config, corpus, health, longlist_api, storage
from app.agent import api as agent_api
from app.agent import runner as agent_runner
from app.auth import Dev, SignedIn
from app.db import Db
from app.ingest import detect, listdiff, parse, runner
from app.ingest.commit import revert
from app.models import (
    ChatSession,
    Document,
    Entity,
    Import,
    Longlist,
    Observation,
    RawRow,
    SourceType,
    User,
    Version,
)

# Fail fast, before the server starts, with the message alone (a failure in
# the lifespan would bury it under a traceback).
try:
    config.check()
except config.ConfigError as e:
    sys.exit(str(e))

log = logging.getLogger("uvicorn.error")
PREVIEW_ROWS = 12
EDITABLE = ("mapping_review", "report_review", "failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # A database outage mustn't stop the process (only bad config does):
    # /health stays up and /health/ready reports the database as down.
    try:
        runner.fail_interrupted()
        agent_runner.fail_interrupted()
    except SQLAlchemyError as e:
        log.warning(
            "Database not usable at startup, so imports or chats interrupted by "
            "the last restart still show as running: %s", str(e).splitlines()[0],
        )
    yield


app = FastAPI(title="Helios gateway", lifespan=lifespan)
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(corpus.router)
app.include_router(longlist_api.router)
app.include_router(agent_api.router)




def _import(session: Session, import_id: uuid.UUID, user: User) -> Import:
    """An import the user may see: devs see every one; everyone else only
    their own list imports."""
    imp = session.get(Import, import_id)
    if imp is None or not (user.is_dev or (imp.target == "list"
                                           and imp.created_by == user.email)):
        raise HTTPException(404, "Import not found.")
    return imp


def _iso(d: date | datetime | None) -> str | None:
    return d.isoformat() if d else None


# ── Reference data ─────────────────────────────────────────────────────────


@app.get("/catalogue")
def get_catalogue(_: SignedIn) -> dict:
    return catalogue.to_json()


# Sources an uploader may name for a file (not a person's edit or the agent).
# "other" needs a name, given in the mapping step (PATCH), so not at upload.
IMPORT_SOURCES = ("capiq", "orbis", "internal", "crm", "web", "news", "file", "other")


@app.get("/source-types")
def source_types(_: SignedIn, session: Db) -> list[dict]:
    rows = session.scalars(select(SourceType).order_by(SourceType.sort)).all()
    return [{"key": r.key, "label": r.label, "confidence": r.confidence,
             "importable": r.key in IMPORT_SOURCES} for r in rows]


# ── Imports ────────────────────────────────────────────────────────────────


def _summary(session: Session, imp: Import) -> dict:
    doc = session.get(Document, imp.document_id)
    return {
        "id": str(imp.id),
        "filename": doc.filename,
        "document_id": str(doc.id),
        "size": doc.size,
        "status": imp.status,
        "target": imp.target,
        "step": imp.step,
        "progress": imp.progress,
        "eta_seconds": imp.eta_seconds,
        "error": imp.error,
        "source_type": imp.source_type,
        "source_note": imp.source_note,
        "source_by": imp.source_by,
        "as_of": _iso(imp.as_of),
        "version_id": imp.version_id,
        "created_by": imp.created_by,
        "created_at": _iso(imp.created_at),
        "rows": (imp.report or {}).get("summary", {}).get("rows"),
    }


@app.get("/imports")
def list_imports(_: Dev, session: Db) -> list[dict]:
    rows = session.scalars(select(Import).order_by(Import.created_at.desc()).limit(200))
    return [_summary(session, i) for i in rows]


@app.post("/imports", status_code=201)
async def upload(
    user: SignedIn,
    session: Db,
    file: Annotated[UploadFile, File()],
    source_type: Annotated[str, Form()] = "internal",
    last_modified: Annotated[int | None, Form()] = None,
    allow_duplicate: Annotated[bool, Form()] = False,
    target: Annotated[str, Form()] = "corpus",
    list_id: Annotated[uuid.UUID | None, Form()] = None,
    new_list_name: Annotated[str | None, Form()] = None,
    session_id: Annotated[uuid.UUID | None, Form()] = None,
) -> dict:
    """Upload a file to import. `target=corpus` (devs only) imports into the
    corpus; `target=list` (anyone) into a list (`list_id`) or a new one
    (`new_list_name`, default the file's name), optionally from a chat."""
    author = user.email
    if target not in ("corpus", "list"):
        raise HTTPException(400, "Import into the corpus or a list.")
    if target == "corpus" and not user.is_dev:
        raise HTTPException(403, "Only devs can import into the corpus.")
    if target == "list":
        source_type = "file"
        allow_duplicate = True  # bringing a list's file back is the point
        if list_id and session.get(Longlist, list_id) is None:
            raise HTTPException(400, "Unknown longlist.")
        if session_id:
            chat = session.get(ChatSession, session_id)
            if chat is None or chat.owner != user.email:
                raise HTTPException(404, "Chat not found.")
    else:
        list_id = new_list_name = session_id = None
    data = await file.read()
    filename = PurePath(file.filename or "upload").name
    if not data:
        raise HTTPException(400, "The file is empty.")
    if PurePath(filename).suffix.lower() not in parse.SUPPORTED:
        raise HTTPException(
            400, "Unsupported file type. Upload .xlsx, .xlsm, .xls, .xlsb, .ods or .csv."
        )
    if (source_type not in IMPORT_SOURCES or source_type == "other"
            or session.get(SourceType, source_type) is None):
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
    if target == "list" and not list_id:
        new_list_name = (new_list_name or "").strip()[:255] or PurePath(filename).stem[:255]
    imp = Import(document_id=doc_id, source_type=source_type, source_by=author, as_of=as_of,
                 created_by=author, catalogue_version=catalogue.CATALOGUE_VERSION,
                 target=target, list_id=list_id, new_list_name=new_list_name,
                 session_id=session_id)
    session.add(imp)
    session.commit()
    runner.start_analysis(imp.id)
    return {"id": str(imp.id)}


@app.get("/imports/{import_id}")
def get_import(import_id: uuid.UUID, user: SignedIn, session: Db) -> dict:
    imp = _import(session, import_id, user)
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
        "list_name": (session.get(Longlist, imp.list_id).name if imp.list_id else None),
        "export_id": str(imp.export_id) if imp.export_id else None,
        "session_id": str(imp.session_id) if imp.session_id else None,
        "list_version": imp.list_version,
        # A list import maps onto these columns (plus data points and new ones).
        "list_columns": (listdiff.current_columns(session, session.get(Longlist, imp.list_id))
                         if imp.target == "list" and imp.list_id else []),
        "catalogue_version": imp.catalogue_version,
        "tables": [{**t, "preview": previews.get(i, [])} for i, t in enumerate(imp.tables)],
        "feedback": imp.feedback,
        "report": imp.report,
        "decisions": imp.decisions,
    }


class ImportSettings(BaseModel):
    """Optionally also put the imported companies on a longlist: an existing
    one (`list_id`) or a new one (`new_list_name`)."""

    source_type: str | None = None
    # With "other": what the source is called (required; kept as a note).
    source_note: str | None = Field(default=None, max_length=120)
    as_of: date | None = None
    list_id: uuid.UUID | None = None
    new_list_name: str | None = Field(default=None, max_length=255)


@app.patch("/imports/{import_id}")
def update_settings(import_id: uuid.UUID, body: ImportSettings, user: SignedIn,
                    session: Db) -> dict:
    imp = _import(session, import_id, user)
    if imp.status not in EDITABLE:
        raise HTTPException(409, f"Can't change settings while the import is {imp.status}.")
    changes = body.model_dump(exclude_unset=True)
    if imp.target == "list":
        if imp.export_id and {"source_type", "source_note"} & changes.keys():
            # A verified export: its cells are Helios's own or the uploader's
            # edits, never another source's data.
            raise HTTPException(409, "A Helios export doesn't take a source.")
        if {"list_id", "new_list_name"} & changes.keys():
            raise HTTPException(409, "Upload the file again to import into another list.")
    if "source_type" in changes and (changes["source_type"] not in IMPORT_SOURCES
                                     or session.get(SourceType, changes["source_type"]) is None):
        raise HTTPException(400, "Unknown source type.")
    if "source_note" in changes:
        changes["source_note"] = (changes["source_note"] or "").strip() or None
    source = changes.get("source_type", imp.source_type)
    if source == "other" and not changes.get("source_note", imp.source_note):
        raise HTTPException(400, "Say what the other source is.")
    if source != "other":
        if changes.get("source_note"):
            raise HTTPException(400, "Only an Other source takes a name.")
        changes["source_note"] = None
    if {"source_type", "source_note"} & changes.keys():
        changes["source_by"] = user.email  # who claimed where the data is from
    if changes.get("list_id") and session.get(Longlist, changes["list_id"]) is None:
        raise HTTPException(400, "Unknown longlist.")
    if changes.get("new_list_name") is not None:
        changes["new_list_name"] = changes["new_list_name"].strip() or None
    for k, v in changes.items():
        setattr(imp, k, v)
    if {"source_type", "source_note", "as_of"} & changes.keys():
        imp.report = None  # scores depend on both
        if imp.status == "report_review":
            imp.status = "mapping_review"
    return {"ok": True}


class ColumnEdit(BaseModel):
    letter: str
    field: str | None
    period: int | None = None
    # A list import's new list-only column (field "new_column").
    new_label: str | None = Field(default=None, max_length=120)


class TableEdit(BaseModel):
    include: bool = True
    header_row: int | None = None
    first_data_row: int | None = None
    last_row: int | None = None
    columns: list[ColumnEdit] = []


@app.put("/imports/{import_id}/tables")
def edit_tables(import_id: uuid.UUID, body: list[TableEdit], user: SignedIn,
                session: Db) -> dict:
    """The reviewer's direct corrections: include/exclude tables, fix a
    table's header row or data range, change column mappings."""
    imp = _import(session, import_id, user)
    list_cols = (listdiff.current_columns(session, session.get(Longlist, imp.list_id))
                 if imp.target == "list" and imp.list_id else [])
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
                if imp.target == "list":
                    if not listdiff.valid_field(e.field, list_cols):
                        raise HTTPException(400, f"Unknown column '{e.field}'.")
                    c["new_label"] = ((e.new_label or c["header"] or "").strip()[:120]
                                      if e.field == listdiff.NEW_COLUMN else None)
                elif e.field and e.field not in catalogue.CATALOGUE:
                    raise HTTPException(400, f"Unknown data point '{e.field}'.")
                c["field"], c["period"] = e.field, e.period
    imp.tables = tables
    imp.report = None
    imp.status = "mapping_review"
    return {"ok": True}


class Feedback(BaseModel):
    text: str


@app.post("/imports/{import_id}/feedback")
def feedback(import_id: uuid.UUID, body: Feedback, user: SignedIn, session: Db) -> dict:
    imp = _import(session, import_id, user)
    author = user.email
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
def make_report(import_id: uuid.UUID, user: SignedIn, session: Db) -> dict:
    """The reviewer confirmed the mapping: build the review report."""
    imp = _import(session, import_id, user)
    if imp.status not in ("mapping_review", "report_review"):
        raise HTTPException(409, f"Can't build a report while the import is {imp.status}.")
    if not any(t.get("include") for t in imp.tables):
        raise HTTPException(400, "Include at least one table.")
    runner.start_report(imp.id)
    return {"ok": True}


class Decisions(BaseModel):
    decisions: dict[str, str]


@app.put("/imports/{import_id}/decisions")
def set_decisions(import_id: uuid.UUID, body: Decisions, user: SignedIn,
                  session: Db) -> dict:
    """Corpus: per-row match decisions. List: `c:<row>:<column>` → file |
    helios for a conflict, `d:<entry id>` → remove | keep for a row
    missing from the file."""
    imp = _import(session, import_id, user)
    if imp.status != "report_review":
        raise HTTPException(409, "Decisions can only be changed in review.")
    for key, decision in body.decisions.items():
        if imp.target == "list":
            allowed = (("file", "helios") if key.startswith("c:")
                       else ("remove", "keep") if key.startswith("d:") else ())
            if decision not in allowed:
                raise HTTPException(400, f"Invalid decision for {key}.")
            continue
        if decision not in ("new", "skip") and not decision.startswith("dup:"):
            try:
                uuid.UUID(decision)
            except ValueError as e:
                raise HTTPException(400, f"Invalid decision for {key}.") from e
    imp.decisions = {**imp.decisions, **body.decisions}
    return {"ok": True}


@app.post("/imports/{import_id}/commit")
def commit_import(import_id: uuid.UUID, user: SignedIn, session: Db) -> dict:
    imp = _import(session, import_id, user)
    author = user.email
    if imp.status != "report_review" or not imp.report:
        raise HTTPException(409, "Only a reviewed import can be committed.")
    runner.start_commit(imp.id, author)
    return {"ok": True}


@app.post("/imports/{import_id}/cancel")
def cancel(import_id: uuid.UUID, user: SignedIn, session: Db) -> dict:
    imp = _import(session, import_id, user)
    if imp.status in ("committed", "committing"):
        raise HTTPException(409, "A committed import is undone by reverting its version.")
    imp.status = "cancelled"
    return {"ok": True}


@app.get("/documents/{document_id}/file")
def download(document_id: uuid.UUID, _: Dev, session: Db) -> Response:
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
def versions(_: Dev, session: Db) -> list[dict]:
    rows = session.scalars(select(Version).order_by(Version.id.desc()).limit(200))
    return [_version(session, v) for v in rows]


@app.post("/versions/{version_id}/revert")
def revert_version(version_id: int, author: Dev, session: Db) -> dict:
    target = session.get(Version, version_id)
    if target is None:
        raise HTTPException(404, "Version not found.")
    try:
        return _version(session, revert(session, target, author))
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


# ── Stats ──────────────────────────────────────────────────────────────────


@app.get("/stats")
def stats(_: SignedIn, session: Db) -> dict:
    counts = dict(session.execute(
        select(Entity.kind, func.count()).group_by(Entity.kind)).all())
    return {"entities": counts,
            "observations": session.scalar(select(func.count()).select_from(Observation))}
