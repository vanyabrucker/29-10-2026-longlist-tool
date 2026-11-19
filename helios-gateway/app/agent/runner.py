"""The agent loop for one chat, in a background thread (like imports).

A run starts when a user event arrives and lasts until the chat goes idle:
the model streams, its tool calls run, their results go back to it, until it
ends its turn, asks the user (requires_action), is stopped (interrupted) or
fails (error).

Rules that keep the log consistent:
- Every write is a short transaction that appends events (`_write`); the
  chat row is locked only while events are appended (seq order), never
  during a model call or a web search.
- Events are published to live streams after their transaction commits.
- Queued user messages are marked handled when they enter the model's
  context, so each is answered once, however many arrive mid-run.
- Every tool call in the history gets a result before the model sees it
  (a placeholder if the run stopped first), as the chat APIs require.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent import config as agent_config
from app.agent import events as ev
from app.agent.bus import bus
from app.agent.tools import (
    MAX_TOOL_FAILURES,
    PAUSING,
    ToolOutcome,
    answer_for_model,
    apply_web_grant,
    clear_ephemeral_web_grants,
    parse_tool_arguments,
    run_tool,
    tool_schemas,
)
from app.config import estimate_cost_usd
from app.db import session_scope
from app.llm import ChatProvider, ChatResult, ChatUsage, LLMError, chat_provider
from app.models import AgentConfig, ChatSession, Longlist, SessionEvent

log = logging.getLogger("uvicorn.error")

MAX_STEPS = 24
# Tool results the model sees in full; older ones are compacted (web hits to
# title and link, list reads to a note), which keeps each call well under the
# provider's tokens-per-minute limit. The log itself keeps everything.
FULL_RESULTS = 6
USER_INPUT = (ev.USER_MESSAGE, ev.USER_TOOL_RESULT, ev.USER_IMPORT)

# Injectable in tests.
ChatFactory = Callable[[], ChatProvider]
_chat_factory: ChatFactory | None = None
_exa_search = None


def use_chat_factory(factory: ChatFactory | None) -> None:
    global _chat_factory
    _chat_factory = factory


def use_exa_search(fn) -> None:
    global _exa_search
    _exa_search = fn


def _chat() -> ChatProvider:
    return _chat_factory() if _chat_factory else chat_provider()


class _Gone(Exception):
    """The chat was deleted mid-run."""


# ── Threads: one per running chat ──────────────────────────────────────────

_lock = threading.Lock()
_running: set[uuid.UUID] = set()
# Woken while running: look for new user events once more before exiting.
_dirty: set[uuid.UUID] = set()
_interrupts: set[uuid.UUID] = set()


def wake(chat_id: uuid.UUID) -> None:
    """Call after committing a user event. Starts the chat's thread, or
    tells the running one to look again before it exits, so an event that
    lands while the thread winds down is never left unhandled."""
    with _lock:
        if chat_id in _running:
            _dirty.add(chat_id)
            return
        _running.add(chat_id)
    threading.Thread(target=_drive, args=(chat_id,), daemon=True,
                     name=f"agent-{chat_id}").start()


def run_sync(chat_id: uuid.UUID) -> None:
    """Run the chat in this thread until it goes idle (evals and scripts:
    the same loop as `wake`, without a background thread)."""
    with _lock:
        if chat_id in _running:
            raise RuntimeError(f"Chat {chat_id} is already running.")
        _running.add(chat_id)
    _drive(chat_id)


def request_interrupt(chat_id: uuid.UUID) -> None:
    """Stop the run at the next check: mid-stream or between tool calls."""
    with _lock:
        if chat_id in _running:
            _interrupts.add(chat_id)


def _interrupted(chat_id: uuid.UUID) -> bool:
    with _lock:
        return chat_id in _interrupts


def _drive(chat_id: uuid.UUID) -> None:
    while True:
        with _lock:
            _dirty.discard(chat_id)
        _run(chat_id)
        with _lock:
            if chat_id in _dirty:
                continue
            _running.discard(chat_id)
            _interrupts.discard(chat_id)
            return


# ── Writing ────────────────────────────────────────────────────────────────

Emit = Callable[[SessionEvent], None]


def _write[T](chat_id: uuid.UUID, fn: Callable[[Session, ChatSession, Emit], T]) -> T:
    """Run `fn` in one short transaction, then publish the events it emitted."""
    emitted: list[SessionEvent] = []
    with session_scope() as s:
        chat = s.get(ChatSession, chat_id)
        if chat is None:
            raise _Gone
        result = fn(s, chat, emitted.append)
    for e in emitted:
        bus.publish(chat_id, ev.public_event(e))
    return result


def _go_idle(s: Session, chat: ChatSession, emit: Emit, stop_reason: str,
             extra: dict[str, Any] | None = None) -> None:
    chat.status = "idle"
    chat.stop_reason = stop_reason
    if stop_reason != "requires_action":
        chat.pending_tool_call_id = None
        # Turn and one-search web approvals end with the run.
        clear_ephemeral_web_grants(chat)
    ev.touch(chat)
    emit(ev.append(s, chat.id, ev.STATUS_IDLE, {"stop_reason": stop_reason,
                                                **(extra or {})}))


def _stop_interrupted(s: Session, chat: ChatSession, emit: Emit) -> None:
    # Everything sent before the Stop belongs to the stopped run.
    ev.mark_all_processed(s, chat.id, (*USER_INPUT, ev.USER_INTERRUPT))
    with _lock:
        _interrupts.discard(chat.id)
    _go_idle(s, chat, emit, "interrupted")


def fail_interrupted() -> None:
    """On startup: runs cut off by a restart can't resume mid-loop."""
    with session_scope() as s:
        ids = s.scalars(select(ChatSession.id).where(ChatSession.status == "running")).all()
    for chat_id in ids:
        def fail(s: Session, chat: ChatSession, emit: Emit) -> None:
            emit(ev.append(s, chat.id, ev.SESSION_ERROR,
                           {"message": "Interrupted by a server restart."}))
            _go_idle(s, chat, emit, "error")
        _write(chat_id, fail)


# ── The loop ───────────────────────────────────────────────────────────────


def _run(chat_id: uuid.UUID) -> None:
    try:
        _loop(chat_id)
    except _Gone:
        return
    except Exception as e:  # persisted for the user
        log.exception("Agent run failed for chat %s", chat_id)
        raw = f"{type(e).__name__}: {e}"
        message = e.user_message if isinstance(e, LLMError) else (
            "Something went wrong on our side. Send a message to try again.")

        def fail(s: Session, chat: ChatSession, emit: Emit) -> None:
            emit(ev.append(s, chat.id, ev.SESSION_ERROR,
                           {"message": message, "detail": raw}))
            _go_idle(s, chat, emit, "error")
        try:
            _write(chat_id, fail)
        except _Gone:
            return


def _loop(chat_id: uuid.UUID) -> None:
    while True:
        def decide(s: Session, chat: ChatSession, emit: Emit) -> bool:
            ev.lock_chat(s, chat.id)
            s.refresh(chat)
            pending = ev.pending_user_events(s, chat.id)
            if _interrupted(chat.id) or any(e.type == ev.USER_INTERRUPT for e in pending):
                if chat.status == "running":
                    _stop_interrupted(s, chat, emit)
                else:
                    ev.mark_all_processed(s, chat.id, (ev.USER_INTERRUPT,))
                return False
            if not pending:
                if chat.status == "running":
                    _go_idle(s, chat, emit, "end_turn")
                return False
            if started := ev.begin_run(s, chat):
                emit(started)
            return True

        if not _write(chat_id, decide):
            return
        if _model_turn(chat_id) != "done":
            return
        # The model ended its turn: go round once more for messages that
        # arrived after it last read the conversation.


def _model_turn(chat_id: uuid.UUID) -> str:
    """Model and tools until the model ends its turn ("done"), asks the user
    ("paused") or the run ends ("stopped")."""
    provider = _chat()
    failures: dict[str, int] = {}
    for _ in range(MAX_STEPS):
        if _interrupted(chat_id):
            _write(chat_id, _stop_interrupted)
            return "stopped"

        def context(s: Session, chat: ChatSession, emit: Emit):
            agent = s.get(AgentConfig, chat.agent_config_version)
            # Everything queued so far is in this context: handled now.
            ev.mark_all_processed(s, chat.id, USER_INPUT)
            return build_messages(s, chat, agent), tool_schemas(agent.tools if agent else None)

        messages, tools = _write(chat_id, context)
        result = _stream(chat_id, provider, messages, tools)
        step = uuid.uuid4().hex

        def record(s: Session, chat: ChatSession, emit: Emit,
                   result: ChatResult = result, step: str = step) -> list[dict]:
            u = result.usage
            emit(ev.append(s, chat.id, ev.MODEL_USAGE, {
                "provider": u.provider or provider.provider_name,
                "model": u.model or provider.model,
                "prompt_tokens": u.prompt_tokens, "completion_tokens": u.completion_tokens,
                "total_tokens": u.total_tokens, "latency_ms": u.latency_ms,
                "cost_usd": u.cost_usd, "step": step}))
            if result.text or not result.tool_calls:
                emit(ev.append(s, chat.id, ev.AGENT_MESSAGE, {
                    "text": result.text, "step": step,
                    **({"interrupted": True} if result.interrupted else {})}))
            if result.interrupted:
                return []
            calls = []
            for tc in result.tool_calls:
                fn = tc.get("function") or {}
                call = {"tool_call_id": tc.get("id") or f"call_{uuid.uuid4().hex[:12]}",
                        "name": fn.get("name") or "",
                        "arguments": parse_tool_arguments(fn.get("arguments") or "{}"),
                        "step": step}
                emit(ev.append(s, chat.id, ev.AGENT_TOOL_USE, call))
                calls.append(call)
            return calls

        calls = _write(chat_id, record)
        if result.interrupted:
            _write(chat_id, _stop_interrupted)
            return "stopped"
        if not calls:
            return "done"
        for i, call in enumerate(calls):
            if _interrupted(chat_id):
                _skip(chat_id, calls[i:], "Not run: the user stopped the run.")
                _write(chat_id, _stop_interrupted)
                return "stopped"
            outcome = _run_call(chat_id, call, failures)
            if outcome.pause:
                if rest := calls[i + 1:]:
                    _skip(chat_id, rest, "Not run: the user had to answer a question "
                                         "first. Call it again if it's still needed.")
                _pause(chat_id, call, outcome)
                return "paused"

    def too_long(s: Session, chat: ChatSession, emit: Emit) -> None:
        emit(ev.append(s, chat.id, ev.SESSION_ERROR, {
            "message": f"I stopped after {MAX_STEPS} steps without finishing. "
                       "Send a message to carry on."}))
        _go_idle(s, chat, emit, "error")
    _write(chat_id, too_long)
    return "stopped"


def _run_call(chat_id: uuid.UUID, call: dict, failures: dict[str, int]) -> ToolOutcome:
    """Run one tool call and record its result in the same transaction (a
    failed call's writes are undone by run_tool's savepoint)."""
    name = call["name"]

    def go(s: Session, chat: ChatSession, emit: Emit) -> ToolOutcome:
        if failures.get(name, 0) >= MAX_TOOL_FAILURES:
            outcome = ToolOutcome(is_error=True, content=(
                f'{{"error": "This tool failed {MAX_TOOL_FAILURES} times in a row, so '
                'it is off for the rest of this run. Tell the user what went wrong '
                'or carry on without it."}'))
        else:
            outcome = run_tool(s, chat, name, call["arguments"], exa_search=_exa_search)
        emit(ev.append(s, chat.id, ev.AGENT_TOOL_RESULT, {
            "tool_call_id": call["tool_call_id"], "name": name,
            "content": outcome.content, "is_error": outcome.is_error,
            "step": call["step"]}))
        return outcome

    outcome = _write(chat_id, go)
    failures[name] = failures.get(name, 0) + 1 if outcome.is_error else 0
    return outcome


def _skip(chat_id: uuid.UUID, calls: list[dict], why: str) -> None:
    def go(s: Session, chat: ChatSession, emit: Emit) -> None:
        for call in calls:
            emit(ev.append(s, chat.id, ev.AGENT_TOOL_RESULT, {
                "tool_call_id": call["tool_call_id"], "name": call["name"],
                "content": f'{{"error": "{why}"}}', "is_error": True,
                "skipped": True, "step": call["step"]}))
    _write(chat_id, go)


def _pause(chat_id: uuid.UUID, call: dict, outcome: ToolOutcome) -> None:
    def go(s: Session, chat: ChatSession, emit: Emit) -> None:
        chat.pending_tool_call_id = call["tool_call_id"]
        _go_idle(s, chat, emit, "requires_action", {
            "tool_call_id": call["tool_call_id"], "grant": outcome.grant,
            **(outcome.ask or {})})
    _write(chat_id, go)


def _stream(chat_id: uuid.UUID, provider: ChatProvider,
            messages: list[dict[str, Any]], tools: list[dict]) -> ChatResult:
    """Stream text deltas to live clients and fold the stream into one
    result. A Stop ends the stream early; the text so far is kept."""
    if not hasattr(provider, "stream"):
        # Scripted test fakes answer in one piece.
        result = provider.complete(messages, tools)
        if _interrupted(chat_id):
            # Nothing of it was shown before the Stop, so none of it is kept.
            return ChatResult(usage=result.usage, interrupted=True)
        return result

    text: list[str] = []
    calls: list[dict[str, Any]] = []
    finish = None
    usage = ChatUsage(provider=provider.provider_name, model=provider.model)
    stream = provider.stream(messages, tools)
    try:
        for event in stream:
            if _interrupted(chat_id):
                return ChatResult(text="".join(text), usage=usage, interrupted=True)
            if event.kind == "text_delta" and event.text:
                text.append(event.text)
                bus.publish(chat_id, {"type": ev.STREAM_DELTA, "payload": {"text": event.text}})
            elif event.kind == "tool_call":
                calls.append({"id": event.tool_call_id, "type": "function",
                              "function": {"name": event.tool_name,
                                           "arguments": event.tool_arguments or "{}"}})
            elif event.kind == "usage":
                usage.prompt_tokens = event.prompt_tokens or 0
                usage.completion_tokens = event.completion_tokens or 0
                usage.total_tokens = event.total_tokens or (
                    usage.prompt_tokens + usage.completion_tokens)
                usage.cost_usd = estimate_cost_usd(
                    provider.model, usage.prompt_tokens, usage.completion_tokens)
            elif event.kind == "done":
                finish = event.finish_reason
                usage.latency_ms = event.latency_ms or 0
    finally:
        close = getattr(stream, "close", None)
        if close:
            close()  # ends the HTTP response when the stream stopped early
    return ChatResult(text="".join(text), tool_calls=calls, finish_reason=finish,
                      usage=usage)


# ── The model's view of the chat ───────────────────────────────────────────


def _state_line(s: Session, chat: ChatSession) -> str:
    if chat.web_research_enabled:
        web = "approved for this chat"
    elif chat.web_research_once:
        web = "approved until this run ends"
    elif chat.web_research_allowed_query:
        web = f"approved for one search only: {chat.web_research_allowed_query!r}"
    else:
        web = "not approved"
    lines = [f"Web research: {web}."]
    if chat.list_ids:
        names = dict(s.execute(select(Longlist.id, Longlist.name).where(
            Longlist.id.in_([uuid.UUID(i) for i in chat.list_ids]))).all())
        lists = "; ".join(f"{names.get(uuid.UUID(i), '(deleted)')} (list_id {i})"
                          for i in chat.list_ids)
        lines.append(f"Longlists in this chat: {lists}.")
    return "\n".join(lines)


def _compact(name: str, content: str) -> str:
    """An older tool result, shortened for the model's context."""
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return content[:600]
    if not isinstance(data, dict) or "error" in data:
        return content[:600]
    if name == "web_research":
        data["results"] = [{"title": r.get("title"), "url": r.get("url")}
                           for r in data.get("results") or []]
    elif name == "corpus_search":
        data["items"] = [{k: i.get(k) for k in ("id", "name", "website", "hq")}
                         for i in data.get("items") or []]
    elif name == "read_list":
        data = {"list_id": data.get("list_id"), "name": data.get("name"),
                "size": data.get("size"),
                "note": "Older read; call read_list again for the current rows."}
    return json.dumps(data, default=str)


def _placeholder(name: str) -> str:
    if name in PAUSING:
        return "The user didn't answer this question."
    return '{"error": "No result: the run stopped before this tool finished."}'


def build_messages(s: Session, chat: ChatSession,
                   agent: AgentConfig | None) -> list[dict[str, Any]]:
    """The chat as chat-completions messages. A model step (one model call:
    its text and tool calls) starts at its usage event; each tool call is
    followed by its result, or a placeholder when there is none."""
    system = agent.system_prompt if agent else "You are Helios."
    if skills := agent_config.skills_text(agent.skills if agent else []):
        system += f"\n\n# Skills\n\n{skills}"
    system += f"\n\n# Now\n\n{_state_line(s, chat)}"
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]

    rows = s.scalars(select(SessionEvent).where(SessionEvent.session_id == chat.id)
                     .order_by(SessionEvent.seq)).all()
    results: dict[str, str] = {}
    tool_results = [e for e in rows if e.type == ev.AGENT_TOOL_RESULT
                    and e.payload.get("name") not in PAUSING]
    recent = {e.id for e in tool_results[-FULL_RESULTS:]}
    for e in tool_results:
        content = e.payload.get("content") or ""
        results[e.payload.get("tool_call_id")] = (
            content if e.id in recent else _compact(e.payload.get("name"), content))
    for e in rows:
        call_id = e.payload.get("tool_call_id")
        if e.type == ev.USER_TOOL_RESULT:
            results[call_id] = (e.payload.get("for_model")
                                or f"The user answered: {e.payload.get('answer') or ''}")

    step: dict[str, Any] = {"text": [], "calls": []}

    def flush() -> None:
        text = "\n\n".join(t for t in step["text"] if t)
        if step["calls"]:
            messages.append({"role": "assistant", "content": text or None,
                             "tool_calls": [
                                 {"id": c["tool_call_id"], "type": "function",
                                  "function": {"name": c["name"], "arguments":
                                               _json(c.get("arguments") or {})}}
                                 for c in step["calls"]]})
            for c in step["calls"]:
                messages.append({"role": "tool", "tool_call_id": c["tool_call_id"],
                                 "content": results.get(c["tool_call_id"])
                                 or _placeholder(c["name"])})
        elif text:
            messages.append({"role": "assistant", "content": text})
        step["text"], step["calls"] = [], []

    for e in rows:
        if e.type == ev.AGENT_MESSAGE:
            if step["calls"]:  # older logs: a message after tool calls is a new step
                flush()
            step["text"].append(e.payload.get("text") or "")
        elif e.type == ev.AGENT_TOOL_USE:
            step["calls"].append(e.payload)
        elif e.type == ev.AGENT_TOOL_RESULT:
            continue  # placed right after its call
        else:
            flush()
            if e.type == ev.USER_MESSAGE:
                messages.append({"role": "user", "content": e.payload.get("text") or ""})
            elif e.type == ev.USER_WEB_ACCESS:
                messages.append({"role": "user", "content": (
                    "[Note: I turned web search on for the rest of this chat; no need to ask "
                    "before searching.]" if e.payload.get("enabled") else
                    "[Note: I turned web search off for this chat. Don't search the web "
                    "unless I approve it again.]")})
            elif e.type == ev.USER_IMPORT:
                p = e.payload
                messages.append({"role": "user", "content": (
                    f"[Note: I imported the spreadsheet {p.get('filename')!r} into the list "
                    f"{p.get('list_name')!r} (list_id {p.get('list_id')}) as version "
                    f"{p.get('version')}: new rows {p.get('new_rows', 0)}, "
                    f"changed cells {p.get('changed_cells', 0)}, conflicts "
                    f"{p.get('conflicts', 0)}. Follow the after-import skill: read the "
                    "list, tell me in a sentence or two what changed, and offer to fill "
                    "empty relevance rationales and scores.]")})
    flush()
    return messages


def _json(value: Any) -> str:
    return json.dumps(value, default=str)


# ── User events (called by the API, which commits and then wakes) ─────────


def enqueue_message(s: Session, chat: ChatSession, text: str) -> SessionEvent:
    event = ev.append(s, chat.id, ev.USER_MESSAGE, {"text": text}, processed=False)
    ev.touch(chat)
    if not chat.title:
        chat.title = title_from(text)
    return event


def enqueue_interrupt(s: Session, chat: ChatSession) -> SessionEvent:
    """Recorded either way; only a running chat has anything to stop."""
    running = chat.status == "running"
    return ev.append(s, chat.id, ev.USER_INTERRUPT, {}, processed=not running)


def enqueue_tool_result(s: Session, chat: ChatSession, tool_call_id: str, answer: str,
                        ask: dict[str, Any] | None) -> SessionEvent:
    """The answer to a question card. Only an allow button grants web
    research; the model reads what was granted in plain words."""
    granted = apply_web_grant(chat, answer, (ask or {}).get("grant"),
                              query=(ask or {}).get("query"))
    chat.pending_tool_call_id = None
    return ev.append(s, chat.id, ev.USER_TOOL_RESULT, {
        "tool_call_id": tool_call_id, "answer": answer, "granted": granted,
        "for_model": answer_for_model(answer, ask, granted),
    }, processed=False)


def title_from(text: str) -> str:
    """The first words of the first message, until the user renames it."""
    words = text.split()[:7]
    title = " ".join(words)
    if len(text.split()) > 7:
        title += "…"
    return (title[:1].upper() + title[1:])[:255] if title else "New chat"
