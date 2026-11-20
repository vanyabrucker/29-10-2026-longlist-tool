"""The longlists API: lists, a list's table at any version with its diff,
version history, changes (every one a version), restore and Excel export
(recorded and signed, see app/exports.py).

Any signed-in user may read and edit every list (one team, shared lists).
"""

import re
import uuid
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import exports
from app import longlists as ll
from app.auth import SignedIn
from app.db import Db
from app.models import Longlist

router = APIRouter()


def _list(session: Session, list_id: uuid.UUID) -> Longlist:
    lst = session.get(Longlist, list_id)
    if lst is None:
        raise HTTPException(404, "Longlist not found.")
    return lst


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ll.ListError as e:
        raise HTTPException(e.status, str(e)) from e


@router.get("/longlists")
def longlists(_: SignedIn, session: Db) -> list[dict]:
    """Every list, most recently edited first."""
    rows = session.scalars(select(Longlist).order_by(Longlist.updated_at.desc())).all()
    names = ll.user_names(session, {r.owner for r in rows})
    sizes = ll.sizes(session, [r.id for r in rows])
    return [ll.summary(session, r, names, sizes.get(r.id, 0)) for r in rows]


class NewList(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    target: str | None = Field(default=None, max_length=255)
    kind: Literal["financial", "strategic"] | None = None
    company_ids: list[uuid.UUID] = []


@router.post("/longlists", status_code=201)
def create(body: NewList, user: SignedIn, session: Db) -> dict:
    ops = [ll.AddEntry(op="add_entry", company_id=c) for c in body.company_ids]
    lst, _ = _guard(ll.create_list, session, name=body.name, owner=user.email,
                    target=body.target, kind=body.kind, ops=ops)
    return ll.table(session, lst)


@router.get("/longlists/{list_id}")
def get_list(list_id: uuid.UUID, _: SignedIn, session: Db,
             version: int | None = None, diff: bool = False) -> dict:
    """The table at a version (default: the latest). With `diff`, what that
    version changed: removed rows and columns included, old cell values."""
    return _guard(ll.table, session, _list(session, list_id), version, diff)


@router.get("/longlists/{list_id}/versions")
def list_versions(list_id: uuid.UUID, _: SignedIn, session: Db) -> list[dict]:
    return ll.versions(session, _list(session, list_id))


class Changes(BaseModel):
    ops: list[ll.Op] = Field(min_length=1, max_length=5000)
    message: str | None = Field(default=None, max_length=500)


@router.post("/longlists/{list_id}/changes")
def change(list_id: uuid.UUID, body: Changes, user: SignedIn, session: Db) -> dict:
    """Cell edits, row and column removal, new columns, column order: one
    new version per call. A corpus fact edited here becomes a prioritized
    manual value in the corpus."""
    lst = _list(session, list_id)
    if any(isinstance(o, ll.Restore) for o in body.ops):
        raise HTTPException(400, "Restore with /restore.")
    _guard(ll.apply_changes, session, lst, body.ops, user.email, body.message)
    return ll.table(session, lst)


class RestoreBody(BaseModel):
    version: int


@router.post("/longlists/{list_id}/restore")
def restore(list_id: uuid.UUID, body: RestoreBody, user: SignedIn, session: Db) -> dict:
    """Bring an older version back, as a new version."""
    lst = _list(session, list_id)
    _guard(ll.apply_changes, session, lst,
           [ll.Restore(op="restore", version=body.version)], user.email)
    return ll.table(session, lst)


# ── Export ─────────────────────────────────────────────────────────────────


@router.get("/longlists/{list_id}/export")
def export(list_id: uuid.UUID, user: SignedIn, session: Db,
           version: int | None = None,
           format: Literal["full", "client"] = "full") -> Response:
    """The list at a version as .xlsx: its columns in their order (or, for
    `format=client`, the fixed client columns), rows by relevance, plus the
    signed export mark and hidden row ids (app/exports.py). Every export is
    recorded with the cells it wrote."""
    lst = _list(session, list_id)
    data = _guard(ll.table, session, lst, version)
    corpus = None
    if format == "client":
        company_ids = [uuid.UUID(r["company_id"]) for r in data["rows"] if r["company_id"]]
        corpus = ll.corpus_cells(session, company_ids, exports.CLIENT_FIELDS,
                                 None if data["version"] == lst.head_version
                                 else data["corpus_version"])
    body = exports.export(session, lst, data, user.email, client=format == "client",
                          corpus=corpus)
    kind = " – Client" if format == "client" else ""
    filename = f"{lst.name}{kind} – Version {data['version']}.xlsx"
    ascii_name = re.sub(r"[^A-Za-z0-9 ._-]+", "-", filename)
    return Response(
        body,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=\"{ascii_name}\"; "
                                        f"filename*=UTF-8''{quote(filename)}"},
    )
