"""Replay one recorded chat through the real agent harness.

The replay creates a throwaway chat in the eval database exactly as the API
does, runs `app.agent.runner` synchronously, and plays the user's side from
the sample:
- a question card (`ask_user`) gets the next recorded `ask_user` answer, in
  order; when they run out the answer is FALLBACK ("Use your judgement.");
- a web approval card gets the next recorded web answer (the same button,
  so the same consent the user gave); when they run out it repeats the
  user's last web answer, or "No" if the user never approved the web;
- when the agent ends its turn, the next recorded message is sent, with the
  chat header's web switch set as it was when the user sent it.
Every card answer is recorded with where it came from (original, repeat,
fallback), so a run that went off script is visible.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

from sqlalchemy import select

FALLBACK = "Use your judgement."
EVAL_OWNER = "eval@helios.local"
# Card answers plus follow-up messages one replay may give before it stops.
MAX_INTERACTIONS = 20


@dataclass
class Replay:
    chat_id: str
    list_ids: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    answers: list[dict[str, Any]] = field(default_factory=list)
    messages_sent: int = 0
    stop_reason: str | None = None
    error: str | None = None
    wall_s: float = 0.0
    lists: list[dict[str, Any]] = field(default_factory=list)
    # Scenarios: the list the chat started on (seeded from the sample).
    setup_list_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _set_web(s, chat, enabled: bool) -> None:
    """The header's globe, as the API's /web_access does (no run starts)."""
    from app.agent import events as ev

    if bool(chat.web_research_enabled) == enabled:
        return
    chat.web_research_enabled = enabled
    if not enabled:
        chat.web_research_once = False
        chat.web_research_allowed_query = None
    ev.append(s, chat.id, ev.USER_WEB_ACCESS, {"enabled": enabled})


def _pending_card(s, chat) -> dict[str, Any] | None:
    from app.agent import events as ev
    from app.models import SessionEvent

    if chat.stop_reason != "requires_action" or not chat.pending_tool_call_id:
        return None
    idle = s.scalars(select(SessionEvent).where(
        SessionEvent.session_id == chat.id, SessionEvent.type == ev.STATUS_IDLE)
        .order_by(SessionEvent.seq.desc()).limit(1)).first()
    if idle is None or idle.payload.get("tool_call_id") != chat.pending_tool_call_id:
        return None
    return dict(idle.payload)


def choose_answer(card: dict[str, Any], queues: dict[str, list[dict]],
                  recorded: dict[str, list[dict]]) -> dict[str, Any]:
    """The answer to a card and where it came from."""
    from app.agent.tools import OPT_DENY

    kind = "web_research" if card.get("kind") == "web_research" else "ask_user"
    queue = queues[kind]
    if queue:
        original = queue.pop(0)
        return {"kind": kind, "question": card.get("question") or "",
                "answer": original["answer"], "source": "original",
                "original_question": original.get("question") or ""}
    if kind == "web_research":
        past = recorded["web_research"]
        answer, source = (past[-1]["answer"], "repeat") if past else (OPT_DENY, "fallback")
    else:
        answer, source = FALLBACK, "fallback"
    return {"kind": kind, "question": card.get("question") or "", "answer": answer,
            "source": source, "original_question": None}


def run(sample: dict[str, Any], owner: str = EVAL_OWNER) -> Replay:
    from app import longlists as ll
    from app.agent import config as agent_config
    from app.agent import events as ev
    from app.agent import runner
    from app.db import session_scope
    from app.models import ChatSession, Longlist

    started = time.monotonic()
    messages = list(sample.get("messages") or [{"text": sample["input"],
                                                "web_enabled": False}])
    recorded = sample.get("answers") or {}
    recorded = {"ask_user": list(recorded.get("ask_user") or []),
                "web_research": list(recorded.get("web_research") or [])}
    queues = {k: list(v) for k, v in recorded.items()}
    chat_id = uuid.uuid4()
    replay = Replay(chat_id=str(chat_id))

    def send(s, chat, i: int) -> None:
        _set_web(s, chat, bool(messages[i].get("web_enabled")))
        runner.enqueue_message(s, chat, messages[i]["text"].strip())
        if i == len(messages) - 1:
            # Header switches after the last message (often mid-run, before
            # an approval card) apply from its start.
            _set_web(s, chat, bool(sample.get("web_enabled_final")))
        replay.messages_sent = i + 1

    with session_scope() as s:
        if spec := (sample.get("setup") or {}).get("list"):
            replay.setup_list_id = seed_list(s, spec, owner)
        chat = ChatSession(id=chat_id, owner=owner, title="",
                           list_ids=[replay.setup_list_id] if replay.setup_list_id else [],
                           agent_config_version=agent_config.current_version(s))
        s.add(chat)
        s.flush()
        send(s, chat, 0)
        ev.begin_run(s, chat)

    for _ in range(MAX_INTERACTIONS + 1):
        runner.run_sync(chat_id)
        with session_scope() as s:
            chat = s.get(ChatSession, chat_id)
            replay.stop_reason = chat.stop_reason
            card = _pending_card(s, chat)
            if card is not None:
                if len(replay.answers) >= MAX_INTERACTIONS:
                    break
                answer = choose_answer(card, queues, recorded)
                replay.answers.append(answer)
                runner.enqueue_tool_result(s, chat, card["tool_call_id"],
                                           answer["answer"], card)
                continue
            if chat.stop_reason == "end_turn" and replay.messages_sent < len(messages):
                send(s, chat, replay.messages_sent)
                continue
        break

    with session_scope() as s:
        chat = s.get(ChatSession, chat_id)
        replay.list_ids = list(chat.list_ids or [])
        replay.events = [ev.public_event(e) for e in ev.events_after(s, chat_id, 0, 10_000)]
        errors = [e["payload"].get("detail") or e["payload"].get("message")
                  for e in replay.events if e["type"] == ev.SESSION_ERROR]
        replay.error = errors[-1] if errors else None
        for list_id in replay.list_ids:
            lst = s.get(Longlist, uuid.UUID(list_id))
            if lst is not None:
                replay.lists.append(list_snapshot(s, lst, ll.table(s, lst)))
    replay.wall_s = round(time.monotonic() - started, 2)
    return replay


def seed_list(s, spec: dict[str, Any], owner: str) -> str:
    """A scenario's starting list: rows outside the corpus with their own
    values (fictional companies), so it needs nothing from the snapshot. A
    missing value is simply not set, so it reads as unknown."""
    from app import longlists as ll

    # Row keys are catalogue data points (or relevance); each gets a column.
    columns = list(dict.fromkeys([*ll.DEFAULT_COLUMNS[spec.get("kind")],
                                  *(k for row in spec["rows"] for k in row)]))
    ops = [ll.AddEntry(op="add_entry", values={k: v for k, v in row.items() if v is not None})
           for row in spec["rows"]]
    lst, _ = ll.create_list(s, name=spec["name"], owner=owner, target=spec.get("target"),
                            kind=spec.get("kind"), columns=columns, ops=ops, author=owner,
                            message="Eval scenario setup")
    return str(lst.id)


def list_snapshot(s, lst, table: dict[str, Any]) -> dict[str, Any]:
    """A built list for scoring: rows with rationale and score, plus the
    corpus facts behind each company row (what the judge checks claims
    against)."""
    from app.agent.tools import _company_snapshot

    rows = []
    for r in table["rows"]:
        cells = {k: c.get("value") for k, c in r["cells"].items()}
        row = {"name": cells.get("name"), "company_id": r["company_id"],
               "relevance_score": cells.get("relevance_score"),
               "relevance_explanation": cells.get("relevance_explanation"),
               "values": {k: v for k, v in cells.items() if k not in (
                   "name", "relevance_score", "relevance_explanation")}}
        if r["company_id"]:
            row["corpus"] = _company_snapshot(s, uuid.UUID(r["company_id"]))
        if urls := sorted({c["url"] for c in r["cells"].values() if c.get("url")}):
            row["source_urls"] = urls
        rows.append(row)
    return {"list_id": str(lst.id), "name": lst.name, "kind": lst.kind,
            "size": len(rows), "rows": rows}
