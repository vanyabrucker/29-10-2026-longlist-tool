"""Append-only session event log."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models import ChatSession, SessionEvent

# Event types the harness writes. The chat UI renders a subset.
USER_MESSAGE = "user.message"
USER_INTERRUPT = "user.interrupt"
USER_TOOL_RESULT = "user.tool_result"
AGENT_MESSAGE = "agent.message"
AGENT_TOOL_USE = "agent.tool_use"
AGENT_TOOL_RESULT = "agent.tool_result"
STATUS_RUNNING = "session.status_running"
STATUS_IDLE = "session.status_idle"
SESSION_ERROR = "session.error"
MODEL_USAGE = "agent.model_usage"
# A spreadsheet the user imported into a list from this chat (no run starts;
# the agent sees it as a note on its next turn).
USER_IMPORT = "user.import"

# Live SSE-only (not stored): text while an agent.message is still streaming.
STREAM_DELTA = "agent.message_delta"


def append(
    session: Session,
    chat_id: uuid.UUID,
    type_: str,
    payload: dict[str, Any] | None = None,
    *,
    processed: bool = True,
) -> SessionEvent:
    """Append the next seq for this chat. The API and the run thread both
    write to the log, so the chat row is locked first (until this
    transaction commits): two writers can't take the same seq."""
    lock_chat(session, chat_id)
    next_seq = (session.scalar(
        select(func.coalesce(func.max(SessionEvent.seq), 0)).where(
            SessionEvent.session_id == chat_id)) or 0) + 1
    event = SessionEvent(
        session_id=chat_id,
        seq=next_seq,
        type=type_,
        payload=payload or {},
        processed_at=datetime.now(UTC) if processed else None,
    )
    session.add(event)
    session.flush()
    return event


def lock_chat(session: Session, chat_id: uuid.UUID) -> None:
    session.execute(
        select(ChatSession.id).where(ChatSession.id == chat_id).with_for_update())


def begin_run(session: Session, chat: ChatSession) -> SessionEvent | None:
    """Mark the chat running (a run lasts until it goes idle again). None if
    it already was. Resets the per-run web search count."""
    lock_chat(session, chat.id)
    session.refresh(chat)
    if chat.status == "running":
        return None
    chat.status = "running"
    chat.stop_reason = None
    chat.web_searches_used = 0
    touch(chat)
    return append(session, chat.id, STATUS_RUNNING, {})


def mark_processed(session: Session, event_id: int) -> None:
    session.execute(
        update(SessionEvent)
        .where(SessionEvent.id == event_id)
        .values(processed_at=datetime.now(UTC)))


def events_after(
    session: Session, chat_id: uuid.UUID, after_seq: int = 0, limit: int = 500,
) -> list[SessionEvent]:
    return list(session.scalars(
        select(SessionEvent)
        .where(SessionEvent.session_id == chat_id, SessionEvent.seq > after_seq)
        .order_by(SessionEvent.seq)
        .limit(limit)
    ).all())


def pending_user_events(
    session: Session, chat_id: uuid.UUID, types: tuple[str, ...] | None = None,
) -> list[SessionEvent]:
    return list(session.scalars(
        select(SessionEvent)
        .where(
            SessionEvent.session_id == chat_id,
            SessionEvent.processed_at.is_(None),
            SessionEvent.type.in_(
                types or (USER_MESSAGE, USER_INTERRUPT, USER_TOOL_RESULT)),
        )
        .order_by(SessionEvent.seq)
    ).all())


def mark_all_processed(session: Session, chat_id: uuid.UUID,
                       types: tuple[str, ...]) -> int:
    """Mark every pending event of these types handled; returns how many."""
    result = session.execute(
        update(SessionEvent)
        .where(SessionEvent.session_id == chat_id,
               SessionEvent.processed_at.is_(None),
               SessionEvent.type.in_(types))
        .values(processed_at=datetime.now(UTC)))
    return result.rowcount or 0


def public_event(e: SessionEvent) -> dict[str, Any]:
    return {
        "seq": e.seq,
        "type": e.type,
        "payload": e.payload,
        "processed_at": e.processed_at.isoformat() if e.processed_at else None,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


def touch(chat: ChatSession) -> None:
    chat.updated_at = datetime.now(UTC)
