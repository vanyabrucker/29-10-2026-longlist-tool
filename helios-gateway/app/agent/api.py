"""HTTP API for private agent chats (sessions = Recents)."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from queue import Empty
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.agent import config as agent_config
from app.agent import events as ev
from app.agent import runner
from app.agent.bus import bus
from app.auth import SignedIn
from app.db import Db
from app.models import ChatSession, SessionEvent, User

router = APIRouter()


def _chat(session: Session, chat_id: uuid.UUID, user: User) -> ChatSession:
    chat = session.get(ChatSession, chat_id)
    if chat is None or chat.owner != user.email:
        raise HTTPException(404, "Chat not found.")
    return chat


def _summary(chat: ChatSession) -> dict[str, Any]:
    return {
        "id": str(chat.id),
        "title": chat.title,
        "pinned": chat.pinned,
        "status": chat.status,
        "stop_reason": chat.stop_reason,
        "list_ids": list(chat.list_ids or []),
        "web_research_enabled": chat.web_research_enabled,
        "pending_tool_call_id": chat.pending_tool_call_id,
        "agent_config_version": chat.agent_config_version,
        "created_at": chat.created_at.isoformat() if chat.created_at else None,
        "updated_at": chat.updated_at.isoformat() if chat.updated_at else None,
        "busy": chat.status == "running",
        "has_list": bool(chat.list_ids),
    }


def _ask_from_payload(chat: ChatSession, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "tool_call_id": chat.pending_tool_call_id,
        "question": payload.get("question") or "",
        "options": payload.get("options") or [],
        "grant": payload.get("grant"),
        "kind": payload.get("kind"),
        "scope": payload.get("scope"),
        "query": payload.get("query"),
    }


def _pending_ask(session: Session, chat: ChatSession) -> dict[str, Any] | None:
    if chat.stop_reason != "requires_action" or not chat.pending_tool_call_id:
        return None
    idle = session.scalars(
        select(SessionEvent)
        .where(SessionEvent.session_id == chat.id, SessionEvent.type == ev.STATUS_IDLE)
        .order_by(SessionEvent.seq.desc())
        .limit(1)
    ).first()
    if idle and idle.payload.get("tool_call_id") == chat.pending_tool_call_id:
        return _ask_from_payload(chat, idle.payload)
    use = session.scalars(
        select(SessionEvent)
        .where(
            SessionEvent.session_id == chat.id,
            SessionEvent.type == ev.AGENT_TOOL_USE,
        )
        .order_by(SessionEvent.seq.desc())
    ).first()
    if use and use.payload.get("tool_call_id") == chat.pending_tool_call_id:
        args = use.payload.get("arguments") or {}
        # request_web_research stores reason as the card title.
        question = args.get("question") or args.get("reason") or ""
        return _ask_from_payload(chat, {
            **args,
            "question": question,
            "grant": (
                {"query": "web_research_query", "turn": "web_research_once",
                 "session": "web_research"}.get(str(args.get("scope")), None)
            ),
        })
    return {
        "tool_call_id": chat.pending_tool_call_id,
        "question": "",
        "options": [],
    }


@router.get("/sessions")
def list_sessions(user: SignedIn, session: Db) -> list[dict]:
    rows = session.scalars(
        select(ChatSession)
        .where(ChatSession.owner == user.email)
        .order_by(ChatSession.pinned.desc(), ChatSession.updated_at.desc())
    ).all()
    return [_summary(c) for c in rows]


class NewSession(BaseModel):
    message: str = Field(min_length=1, max_length=20000)
    list_ids: list[uuid.UUID] = []


@router.post("/sessions", status_code=201)
def create_session(body: NewSession, user: SignedIn, session: Db) -> dict:
    chat = ChatSession(
        id=uuid.uuid4(),
        owner=user.email,
        title="",
        agent_config_version=agent_config.current_version(session),
        list_ids=[str(i) for i in body.list_ids],
    )
    session.add(chat)
    session.flush()
    event = runner.enqueue_message(session, chat, body.message.strip())
    # Running in this transaction, so the answer already shows it busy.
    run = ev.begin_run(session, chat)
    session.commit()
    runner.wake(chat.id)
    return {
        **_summary(chat),
        "events": [ev.public_event(e) for e in (event, run) if e is not None],
        "pending_ask": None,
    }


@router.get("/sessions/{chat_id}")
def get_session(chat_id: uuid.UUID, user: SignedIn, session: Db) -> dict:
    chat = _chat(session, chat_id, user)
    events = ev.events_after(session, chat.id, after_seq=0, limit=2000)
    return {
        **_summary(chat),
        "events": [ev.public_event(e) for e in events],
        "pending_ask": _pending_ask(session, chat),
    }


class SessionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    pinned: bool | None = None


@router.patch("/sessions/{chat_id}")
def patch_session(chat_id: uuid.UUID, body: SessionPatch, user: SignedIn,
                  session: Db) -> dict:
    chat = _chat(session, chat_id, user)
    if body.title is not None:
        chat.title = body.title.strip()
    if body.pinned is not None:
        chat.pinned = body.pinned
    ev.touch(chat)
    return _summary(chat)


@router.delete("/sessions/{chat_id}", status_code=204)
def delete_session(chat_id: uuid.UUID, user: SignedIn, session: Db) -> None:
    chat = _chat(session, chat_id, user)
    runner.request_interrupt(chat.id)  # a running loop stops at its next write
    session.execute(delete(SessionEvent).where(SessionEvent.session_id == chat.id))
    session.delete(chat)


@router.get("/sessions/{chat_id}/events")
def get_events(chat_id: uuid.UUID, user: SignedIn, session: Db,
               after: int = 0) -> dict:
    chat = _chat(session, chat_id, user)
    rows = ev.events_after(session, chat.id, after_seq=after)
    return {
        "events": [ev.public_event(e) for e in rows],
        "status": chat.status,
        "stop_reason": chat.stop_reason,
        "pending_ask": _pending_ask(session, chat),
        "list_ids": list(chat.list_ids or []),
    }


class MessageBody(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


@router.post("/sessions/{chat_id}/messages", status_code=201)
def post_message(chat_id: uuid.UUID, body: MessageBody, user: SignedIn,
                 session: Db) -> dict:
    chat = _chat(session, chat_id, user)
    # While a question card is open, text from the composer answers it.
    if chat.stop_reason == "requires_action" and chat.pending_tool_call_id:
        event = runner.enqueue_tool_result(
            session, chat, chat.pending_tool_call_id, body.text.strip(),
            _pending_ask(session, chat))
    else:
        event = runner.enqueue_message(session, chat, body.text.strip())
    ev.begin_run(session, chat)
    session.commit()
    runner.wake(chat.id)
    return {"event": ev.public_event(event), "session": _summary(chat)}


class ToolResultBody(BaseModel):
    tool_call_id: str
    answer: str = Field(min_length=1, max_length=20000)


@router.post("/sessions/{chat_id}/tool_results", status_code=201)
def post_tool_result(chat_id: uuid.UUID, body: ToolResultBody, user: SignedIn,
                     session: Db) -> dict:
    chat = _chat(session, chat_id, user)
    if body.tool_call_id != chat.pending_tool_call_id:
        raise HTTPException(409, "That question isn't open any more.")
    event = runner.enqueue_tool_result(
        session, chat, body.tool_call_id, body.answer.strip(),
        _pending_ask(session, chat))
    ev.begin_run(session, chat)
    session.commit()
    runner.wake(chat.id)
    return {"event": ev.public_event(event), "session": _summary(chat)}


class WebAccessBody(BaseModel):
    enabled: bool


@router.post("/sessions/{chat_id}/web_access", status_code=201)
def set_web_access(chat_id: uuid.UUID, body: WebAccessBody, user: SignedIn,
                   session: Db) -> dict:
    """The header's globe: web search on or off for the whole chat. Off also
    drops this run's and one-search allowances, so it takes effect at the
    agent's next search."""
    chat = _chat(session, chat_id, user)
    ev.lock_chat(session, chat.id)
    session.refresh(chat)
    chat.web_research_enabled = body.enabled
    if not body.enabled:
        chat.web_research_once = False
        chat.web_research_allowed_query = None
    event = ev.append(session, chat.id, ev.USER_WEB_ACCESS, {"enabled": body.enabled})
    ev.touch(chat)
    session.commit()
    bus.publish(chat.id, ev.public_event(event))
    return {"event": ev.public_event(event), "session": _summary(chat)}


@router.post("/sessions/{chat_id}/interrupt", status_code=201)
def interrupt(chat_id: uuid.UUID, user: SignedIn, session: Db) -> dict:
    chat = _chat(session, chat_id, user)
    ev.lock_chat(session, chat.id)
    session.refresh(chat)
    event = runner.enqueue_interrupt(session, chat)
    session.commit()
    if chat.status == "running":
        # Stops mid-stream or before the next tool call; the loop records it.
        runner.request_interrupt(chat.id)
        runner.wake(chat.id)
    return {"event": ev.public_event(event), "session": _summary(chat)}


HEARTBEAT_SECONDS = 15.0
POLL_SECONDS = 0.05


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, default=str)}\n\n"


@router.get("/sessions/{chat_id}/stream")
def stream(chat_id: uuid.UUID, request: Request, user: SignedIn, session: Db,
           after: int = 0):
    """SSE: missed stored events after `after`, then live bus messages."""
    chat = _chat(session, chat_id, user)
    chat_id = chat.id
    # Subscribe before reading the backlog, so an event stored in between
    # arrives live (duplicates are dropped by seq below).
    queue = bus.subscribe(chat_id)
    backlog = [ev.public_event(e) for e in ev.events_after(session, chat_id, after)]

    async def gen():
        # Async and polling the thread-safe queue: an open stream holds no
        # threadpool thread, and it ends as soon as the client goes away.
        last = after
        try:
            for e in backlog:
                last = max(last, e["seq"])
                yield _sse({"type": e["type"], "seq": e["seq"], "payload": e["payload"],
                            "created_at": e["created_at"]})
            quiet_since = time.monotonic()
            while not await request.is_disconnected():
                try:
                    msg = queue.get_nowait()
                except Empty:
                    if time.monotonic() - quiet_since > HEARTBEAT_SECONDS:
                        quiet_since = time.monotonic()
                        yield ": keepalive\n\n"
                    await asyncio.sleep(POLL_SECONDS)
                    continue
                quiet_since = time.monotonic()
                seq = msg.get("seq")
                if seq is not None and seq <= last:
                    continue
                if seq is not None:
                    last = seq
                yield _sse(msg)
        finally:
            bus.unsubscribe(chat_id, queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
