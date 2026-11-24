"""Feedback on chats: the owner rates a chat Bad / Fine / Good (asked once a
list exists), optionally with a comment; devs triage it (Todo, In progress,
Done) in the eval dashboard and can turn a chat into an eval sample.

- `POST /sessions/{id}/feedback` (the chat's owner): `{rating, comment}`.
  A rating of null dismisses the ask, so the chat doesn't ask again. A
  later call fills in what it gives (the comment after the rating).
- `GET /feedback?status=&rating=` (dev): rated feedback, newest first.
- `PATCH /feedback/{id}` (dev): `status`, `note`, `dataset_sample`.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Dev, SignedIn
from app.db import Db
from app.models import ChatSession, SessionFeedback, User

router = APIRouter()

Rating = Literal["bad", "fine", "good"]
Status = Literal["todo", "in_progress", "done"]


def state(session: Session, chat_id: uuid.UUID) -> str | None:
    """What a chat's owner said: None (not asked yet), "dismissed", or the rating."""
    row = session.scalars(select(SessionFeedback)
                          .where(SessionFeedback.session_id == chat_id)).first()
    if row is None:
        return None
    return row.rating or "dismissed"


def _out(row: SessionFeedback, names: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "session_id": str(row.session_id) if row.session_id else None,
        "owner": row.owner, "owner_name": (names or {}).get(row.owner, row.owner),
        "session_title": row.session_title,
        "agent_config_version": row.agent_config_version,
        "rating": row.rating, "comment": row.comment, "status": row.status,
        "note": row.note, "analyzed_by": row.analyzed_by,
        "dataset_sample": row.dataset_sample,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


class FeedbackIn(BaseModel):
    rating: Rating | None = None
    comment: str | None = Field(default=None, max_length=4000)


@router.post("/sessions/{chat_id}/feedback")
def give_feedback(chat_id: uuid.UUID, body: FeedbackIn, user: SignedIn,
                  session: Db) -> dict:
    chat = session.get(ChatSession, chat_id)
    if chat is None or chat.owner != user.email:
        raise HTTPException(404, "Chat not found.")
    row = session.scalars(select(SessionFeedback)
                          .where(SessionFeedback.session_id == chat.id)).first()
    comment = (body.comment or "").strip() or None
    if row is None:
        row = SessionFeedback(session_id=chat.id, owner=user.email,
                              session_title=chat.title or "",
                              agent_config_version=chat.agent_config_version)
        session.add(row)
    elif comment is None and body.rating is None:
        raise HTTPException(409, "This chat already has feedback.")
    if body.rating is not None:
        row.rating = body.rating
    if comment is not None:
        if row.rating is None:
            raise HTTPException(400, "Pick Bad, Fine or Good before adding a comment.")
        row.comment = comment
    row.updated_at = datetime.now(UTC)
    session.flush()
    return _out(row)


@router.get("/feedback")
def list_feedback(_: Dev, session: Db, status: Status | None = None,
                  rating: Rating | None = None) -> dict:
    q = select(SessionFeedback).where(SessionFeedback.rating.is_not(None))
    if status:
        q = q.where(SessionFeedback.status == status)
    if rating:
        q = q.where(SessionFeedback.rating == rating)
    rows = session.scalars(q.order_by(SessionFeedback.created_at.desc())).all()
    names = dict(session.execute(select(User.email, User.name)
                                 .where(User.email.in_({r.owner for r in rows}))).all())
    return {"items": [_out(r, names) for r in rows]}


class FeedbackPatch(BaseModel):
    status: Status | None = None
    note: str | None = Field(default=None, max_length=8000)
    dataset_sample: str | None = Field(default=None, max_length=80)


@router.patch("/feedback/{feedback_id}")
def patch_feedback(feedback_id: uuid.UUID, body: FeedbackPatch, dev: Dev,
                   session: Db) -> dict:
    row = session.get(SessionFeedback, feedback_id)
    if row is None or row.rating is None:
        raise HTTPException(404, "Feedback not found.")
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "Nothing to change.")
    for key, value in fields.items():
        if key == "status" and value is None:
            raise HTTPException(400, "status can't be empty.")
        setattr(row, key, (value.strip() or None) if isinstance(value, str) else value)
    row.analyzed_by = dev
    row.updated_at = datetime.now(UTC)
    session.flush()
    return _out(row)
