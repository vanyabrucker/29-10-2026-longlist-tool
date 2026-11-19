"""Eval samples from real chats, chosen by hand (chats are private per user).

    uv run python -m evals.dataset chats --owner EMAIL     # pick candidates
    uv run python -m evals.dataset export --chat ID [--chat ID ...]
    uv run python -m evals.dataset export --from evals/good_chats.txt

Nothing is exported unless named: by id on the command line or in a "good
chats" file (one id per line, `#` comments). The source database (default:
the gateway's configured one, normally dev) is opened read-only.

A sample is what the user said, so a replay can say the same:
- `messages`: every user message in order, with whether web search was on in
  the chat header when it was sent (the globe); `web_enabled_final` is the
  header state after the last message.
- `answers`: card answers in order, per kind: `ask_user` (question, options,
  answer) and `web_research` (question, scope, answer, granted). A replay
  answers the new model's cards from these, in order.
- `original`: the original run for comparison: model, lists it built (name,
  kind, rows with company ids) and its usage totals.

Chats that started on an existing list are skipped (the replay can't
recreate that list as it was). Spreadsheet imports in a chat are dropped and
counted (`imports_skipped`). The original web searches seed the web cache.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from evals.env import DATA_DIR
from evals.exa_cache import DEFAULT_PATH as EXA_CACHE
from evals.exa_cache import ExaCache

DEFAULT_OUT = DATA_DIR / "dataset.jsonl"


def read_ids(path: Path) -> list[str]:
    ids = []
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            ids.append(line)
    return ids


def _source_session(url: str | None) -> Session:
    from app.config import settings

    engine = create_engine(url or settings().database_url, connect_args={
        "options": "-c default_transaction_read_only=on", "connect_timeout": 5})
    return Session(engine)


def _json(content: Any) -> Any:
    if isinstance(content, str):
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return None
    return content


def export_chat(s: Session, chat_id: uuid.UUID) -> tuple[dict | None, list, str | None]:
    """(sample, web cache entries, reason it was skipped)."""
    from app.agent import events as ev
    from app.models import ChatSession, Longlist, SessionEvent

    chat = s.get(ChatSession, chat_id)
    if chat is None:
        return None, [], "no such chat"
    rows = s.scalars(select(SessionEvent).where(SessionEvent.session_id == chat_id)
                     .order_by(SessionEvent.seq)).all()

    messages: list[dict] = []
    answers: dict[str, list[dict]] = {"ask_user": [], "web_research": []}
    asks: dict[str, dict] = {}  # tool_call_id → the card it showed
    created: list[str] = []
    web_calls: dict[str, str] = {}  # tool_call_id → query
    web_hits: list[tuple[str, list]] = []
    usage = {"model_calls": 0, "prompt_tokens": 0, "completion_tokens": 0,
             "cost_usd": 0.0, "models": set()}
    web = False
    imports = 0
    for e in rows:
        p = e.payload or {}
        if e.type == ev.USER_WEB_ACCESS:
            web = bool(p.get("enabled"))
        elif e.type == ev.USER_MESSAGE:
            messages.append({"text": p.get("text") or "", "web_enabled": web})
        elif e.type == ev.USER_IMPORT:
            imports += 1
        elif e.type == ev.STATUS_IDLE and p.get("stop_reason") == "requires_action":
            asks[p.get("tool_call_id")] = p
        elif e.type == ev.USER_TOOL_RESULT:
            card = asks.get(p.get("tool_call_id")) or {}
            if card.get("kind") == "web_research":
                answers["web_research"].append({
                    "question": card.get("question") or "", "scope": card.get("scope"),
                    "answer": p.get("answer") or "", "granted": p.get("granted")})
            else:
                answers["ask_user"].append({
                    "question": card.get("question") or "",
                    "options": card.get("options") or [], "answer": p.get("answer") or ""})
        elif e.type == ev.AGENT_TOOL_USE and p.get("name") == "web_research":
            web_calls[p.get("tool_call_id")] = (p.get("arguments") or {}).get("query") or ""
        elif e.type == ev.AGENT_TOOL_RESULT and not p.get("is_error"):
            data = _json(p.get("content"))
            if not isinstance(data, dict):
                continue
            if p.get("name") == "create_list" and data.get("list_id"):
                created.append(data["list_id"])
            elif p.get("name") == "web_research" and p.get("tool_call_id") in web_calls:
                web_hits.append((web_calls[p["tool_call_id"]], data.get("results") or []))
        elif e.type == ev.MODEL_USAGE:
            usage["model_calls"] += 1
            usage["prompt_tokens"] += p.get("prompt_tokens") or 0
            usage["completion_tokens"] += p.get("completion_tokens") or 0
            usage["cost_usd"] += p.get("cost_usd") or 0
            usage["models"].add(f"{p.get('provider')}:{p.get('model')}")

    if not messages:
        return None, [], "no user message"
    attached = [i for i in chat.list_ids or [] if i not in created]
    if attached:
        return None, [], "started on an existing list"

    from app import longlists as ll

    lists = []
    for list_id in created:
        lst = s.get(Longlist, uuid.UUID(list_id))
        if lst is None:
            continue
        table = ll.table(s, lst)
        lists.append({
            "name": lst.name, "kind": lst.kind, "size": len(table["rows"]),
            "rows": [{"name": (r["cells"].get("name") or {}).get("value"),
                      "company_id": r["company_id"]} for r in table["rows"]]})

    usage["models"] = sorted(usage["models"])
    usage["cost_usd"] = round(usage["cost_usd"], 6)
    sample = {
        "id": str(chat.id), "title": chat.title,
        "input": messages[0]["text"], "messages": messages, "web_enabled_final": web,
        "answers": answers, "imports_skipped": imports,
        "original": {"agent_config_version": chat.agent_config_version,
                     "lists": lists, "usage": usage},
    }
    return sample, web_hits, None


def export(ids: list[str], out: Path, source_url: str | None = None,
           exa_cache: Path = EXA_CACHE) -> list[dict]:
    if not ids:
        raise SystemExit("Name the chats to export (--chat or --from); "
                         "nothing is exported by default.")
    samples, hits = [], []
    with _source_session(source_url) as s:
        for raw in dict.fromkeys(ids):
            try:
                chat_id = uuid.UUID(raw)
            except ValueError:
                print(f"skip {raw}: not a chat id", file=sys.stderr)
                continue
            sample, web, why = export_chat(s, chat_id)
            if sample is None:
                print(f"skip {raw}: {why}", file=sys.stderr)
                continue
            if sample["imports_skipped"]:
                print(f"note {raw}: {sample['imports_skipped']} spreadsheet import(s) "
                      "can't be replayed and are left out", file=sys.stderr)
            samples.append(sample)
            hits.extend(web)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in samples))
    if hits:
        cache = ExaCache(exa_cache)
        for query, results in hits:
            cache.store(query, results, save=False)
        cache.save()
    print(f"Wrote {len(samples)} sample(s) to {out}"
          + (f"; seeded {len(hits)} web search(es) into {exa_cache}" if hits else ""))
    return samples


def load(path: Path) -> list[dict]:
    if not path.is_file():
        raise FileNotFoundError(
            f"No dataset at {path}. Export chats first: "
            "uv run python -m evals.dataset export --chat ID")
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def list_chats(owner: str, source_url: str | None = None) -> None:
    from app.models import ChatSession, SessionEvent

    with _source_session(source_url) as s:
        rows = s.execute(
            select(ChatSession.id, ChatSession.created_at, ChatSession.title,
                   func.count(SessionEvent.id))
            .join(SessionEvent, SessionEvent.session_id == ChatSession.id, isouter=True)
            .where(ChatSession.owner == owner)
            .group_by(ChatSession.id).order_by(ChatSession.created_at.desc())).all()
    for chat_id, created, title, n in rows:
        print(f"{chat_id}  {created:%Y-%m-%d %H:%M}  {n:4d} events  {title}")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m evals.dataset", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", help="database URL to read chats from (read only)")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("chats", help="list one user's chats to choose from")
    c.add_argument("--owner", required=True, help="the chat owner's email")
    e = sub.add_parser("export", help="write the chosen chats as eval samples")
    e.add_argument("--chat", action="append", default=[], help="chat id (repeatable)")
    e.add_argument("--from", dest="from_file", type=Path,
                   help="file with one chat id per line")
    e.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = p.parse_args(argv)

    if args.cmd == "chats":
        list_chats(args.owner, args.source)
    else:
        ids = [*args.chat, *(read_ids(args.from_file) if args.from_file else [])]
        export(ids, args.out, args.source)


if __name__ == "__main__":
    main()
