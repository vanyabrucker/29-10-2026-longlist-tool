"""Agent tools: corpus search, web research (Exa), reading and writing lists,
and the question card.

Tool arguments are untrusted model output. Each tool has one Pydantic model
that is both the JSON schema the model sees and the validator, so the two
can't drift. Invalid arguments come back to the model as a tool error with
path-tagged messages ("entries.2.relevance_score: …") for it to correct.
The only coercions are lossless ones: arguments sent as a JSON string, and a
list entry given as a bare company name.

Every tool call runs in a savepoint: a call that fails leaves no writes
behind (no half-created list) and never poisons the run's transaction.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    create_model,
    field_validator,
    model_validator,
)
from sqlalchemy.orm import Session

from app import citations
from app import longlists as ll
from app import search as company_search
from app.catalogue import CATALOGUE
from app.config import settings
from app.ingest.normalize import Invalid, normalize
from app.models import ChatSession, Longlist

log = logging.getLogger("uvicorn.error")

EXA_CAP = 20
AGENT_AUTHOR = "agent"
# Choice-card titles must stay short; context goes in the chat message.
ASK_QUESTION_MAX = 120
# The same tool failing this many times in a row ends its use for the run.
MAX_TOOL_FAILURES = 3
READ_LIST_MAX_ROWS = 300

OPT_ALLOW_QUERY = "Allow this search"
OPT_ALLOW_TURN = "Allow web for this turn"
OPT_ALLOW_CHAT = "Allow web for this chat"
OPT_DENY = "No"
ALLOW_OPTIONS = (OPT_ALLOW_QUERY, OPT_ALLOW_TURN, OPT_ALLOW_CHAT)

# Pausing tools: the run waits for the user's answer (user.tool_result).
PAUSING = ("ask_user", "request_web_research")


# ── Argument models (schema + validation) ──────────────────────────────────


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


# Company data points the agent may fill for a row that isn't in our data.
VALUE_KEYS = (
    "name", "website", "description", "hq", "founded", "buyer_category",
    "investor_type", "sector", "sub_sector", "revenue", "ebitda", "aum",
    "ticket_size_min", "ticket_size_max", "employee_count", "owner_type",
    "acquisition_interest", "investment_focus", "products", "services",
    "linkedin_url",
)
_TYPE_HINTS = {
    "money": "amount with currency, e.g. 'EUR 120m' or 'CHF 2bn'",
    "location": "'City, Country', e.g. 'Stuttgart, Germany'",
    "year": "four-digit year",
    "int": "whole number",
    "bool": "true or false",
    "domain": "website domain, e.g. 'bwk.de'",
}


def _value_field(key: str) -> tuple[Any, Any]:
    point = CATALOGUE[key]
    kind: Any = {"int": int, "year": int, "bool": bool, "decimal": float,
                 "percent": float}.get(point.type, str)
    if point.options:
        kind = Literal[tuple(point.options)]
    hint = _TYPE_HINTS.get(point.type)
    description = point.description + (f" ({hint})" if hint else "")
    return kind | None, Field(default=None, description=description)


EntryValues = create_model(
    "EntryValues", __config__=ConfigDict(extra="forbid"),
    **{k: _value_field(k) for k in VALUE_KEYS})


class Entry(_Args):
    """One buyer row: a company from our data (company_id from search
    results) or a company found elsewhere (name plus values)."""

    company_id: uuid.UUID | None = Field(
        default=None, description="Only an id returned by corpus_search; never invent one.")
    name: str | None = Field(default=None, max_length=255)
    relevance_score: float | None = Field(default=None, ge=0, le=100)
    relevance_explanation: str | None = Field(default=None, max_length=4000, description=(
        "Why this buyer fits, in plain words. Back each fact with a citation "
        "[[source | url | evidence]] (see the scoring skill)."))
    values: EntryValues = Field(  # type: ignore[valid-type]
        default_factory=EntryValues,
        description="Facts for a company that isn't in our data (ignored for "
                    "companies from our data, whose facts come from there).")
    source_url: str | None = Field(default=None, max_length=2000, description=(
        "The web page these facts come from (a search result's url). Facts "
        "without one count as unsourced and get a low quality score."))
    source_title: str | None = Field(default=None, max_length=300)

    @field_validator("relevance_explanation")
    @classmethod
    def _cited(cls, text: str | None) -> str | None:
        return None if text is None else citations.check(text)

    @model_validator(mode="after")
    def _named(self) -> Entry:
        if self.company_id is None and not (self.name or self.values.name):
            raise ValueError("needs a name, or a company_id from search results")
        return self


def _entry_from_name(raw: Any) -> Any:
    """Lossless shortcut models take: a bare company name is a name-only row."""
    if isinstance(raw, list):
        return [{"name": r} if isinstance(r, str) and r.strip() else r for r in raw]
    return raw


class CorpusSearch(_Args):
    """Search Helios's internal company data by name, website, sector,
    headquarters or description. Use this before the web."""

    query: str = Field(min_length=1, max_length=300)
    limit: int = Field(default=15, ge=1, le=50)


class RequestWebResearch(_Args):
    """Ask the user to approve web research; opens an approval card. scope
    'query': one exact search (give `query`); 'turn': any searches until this
    run ends; 'session': the rest of the chat. Explain why in your chat
    message; `reason` is only the card title. After approval, call
    web_research."""

    scope: Literal["query", "turn", "session"]
    query: str | None = Field(default=None, max_length=300,
                              description="The exact search; required for scope 'query'.")
    reason: str = Field(min_length=1, max_length=300, description=(
        f"Card title, at most {ASK_QUESTION_MAX} characters, e.g. "
        "'Look up Anybotics on the web?'"))

    @model_validator(mode="after")
    def _query_for_query_scope(self) -> RequestWebResearch:
        if self.scope == "query" and not (self.query or "").strip():
            raise ValueError("query is required when scope is 'query'")
        return self


class WebResearch(_Args):
    """Search the public web. Only after the user approved it (for the chat,
    this turn, or this exact query). At most 20 searches per run."""

    query: str = Field(min_length=1, max_length=300)
    num_results: int = Field(default=5, ge=1, le=10)


class CreateList(_Args):
    """Create a buyer longlist (version 1, written by the agent) with its
    first rows."""

    name: str = Field(min_length=1, max_length=255,
                      description="e.g. 'Acme – Financial buyers'")
    target: str | None = Field(default=None, max_length=255,
                               description="The company being sold.")
    kind: Literal["financial", "strategic"] | None = None
    message: str | None = Field(default=None, max_length=500,
                                description="Version note, e.g. 'First pass from our data'.")
    entries: list[Entry] = Field(default_factory=list, max_length=500)

    _names = field_validator("entries", mode="before")(_entry_from_name)


class AddRow(_Args):
    op: Literal["add_row"]
    entry: Entry


class SetCell(_Args):
    op: Literal["set_cell"]
    row_id: uuid.UUID = Field(description="A row_id from read_list.")
    column: str = Field(min_length=1, description="A column key or label.")
    value: str | int | float | bool | None = None
    source_url: str | None = Field(default=None, max_length=2000, description=(
        "The web page this value comes from, if any."))


class RemoveRow(_Args):
    op: Literal["remove_row"]
    row_id: uuid.UUID = Field(description="A row_id from read_list.")


class AddColumn(_Args):
    """A data point (`key`, one of the company data points) or a list-only
    column (`label`, e.g. 'Owner likes Sauvignon')."""

    op: Literal["add_column"]
    key: Literal[VALUE_KEYS] | None = None  # type: ignore[valid-type]
    label: str | None = Field(default=None, max_length=120)
    after: str | None = Field(default=None, description="Column key to place it after.")

    @model_validator(mode="after")
    def _one(self) -> AddColumn:
        if bool(self.key) == bool(self.label):
            raise ValueError("give either key or label")
        return self


class RemoveColumn(_Args):
    op: Literal["remove_column"]
    column: str = Field(min_length=1, description="A column key or label.")


ListOp = Annotated[AddRow | SetCell | RemoveRow | AddColumn | RemoveColumn,
                   Field(discriminator="op")]


class UpdateList(_Args):
    """Change a longlist: add or remove rows, set cells, add or remove
    columns. All operations become one new list version. Call read_list
    first for row ids and column keys."""

    list_id: uuid.UUID
    message: str = Field(min_length=1, max_length=500,
                         description="Version note, e.g. 'Europe only'.")
    ops: list[ListOp] = Field(min_length=1, max_length=500)


class ReadList(_Args):
    """Read a longlist's latest version: columns and rows with their
    row_id, for refining it with update_list."""

    list_id: uuid.UUID


class AskUser(_Args):
    """Pause and ask the user. Put the context in your chat message;
    `question` is only the card title. Options become buttons; the user can
    also type an answer. For web approval use request_web_research."""

    question: str = Field(min_length=1, max_length=300, description=(
        f"Card title, at most {ASK_QUESTION_MAX} characters."))
    options: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=6)


ARGS: dict[str, type[_Args]] = {
    "corpus_search": CorpusSearch,
    "request_web_research": RequestWebResearch,
    "web_research": WebResearch,
    "read_list": ReadList,
    "create_list": CreateList,
    "update_list": UpdateList,
    "ask_user": AskUser,
}


def _schema(name: str, model: type[_Args]) -> dict[str, Any]:
    params = model.model_json_schema()
    description = " ".join((params.pop("description", "") or "").split())
    params.pop("title", None)
    return {"type": "function",
            "function": {"name": name, "description": description, "parameters": params}}


TOOL_SCHEMAS: list[dict[str, Any]] = [_schema(n, m) for n, m in ARGS.items()]


def tool_schemas(names: list[str] | None) -> list[dict[str, Any]]:
    """The schemas of these tools (a config's tool list), in catalogue order."""
    if not names:
        return TOOL_SCHEMAS
    return [t for t in TOOL_SCHEMAS if t["function"]["name"] in names]


# ── Results ────────────────────────────────────────────────────────────────


@dataclass
class ToolOutcome:
    content: str
    is_error: bool = False
    # ask_user / request_web_research pause the loop.
    pause: bool = False
    # web_research | web_research_once | web_research_query | None
    grant: str | None = None
    # Fields merged into the idle / pending_ask payload.
    ask: dict[str, Any] | None = None


def _ok(data: dict[str, Any]) -> ToolOutcome:
    return ToolOutcome(content=json.dumps(data, default=str))


def _error(message: str) -> ToolOutcome:
    return ToolOutcome(content=json.dumps({"error": message}), is_error=True)


def _validation_message(e: ValidationError) -> str:
    lines = []
    for err in e.errors()[:12]:
        where = ".".join(str(p) for p in err["loc"]) or "arguments"
        lines.append(f"{where}: {err['msg']}")
    more = len(e.errors()) - 12
    if more > 0:
        lines.append(f"… and {more} more")
    return "Invalid arguments. " + "; ".join(lines)


def _short_question(text: str) -> str:
    q = " ".join(str(text or "").split())
    if len(q) <= ASK_QUESTION_MAX:
        return q
    return q[: ASK_QUESTION_MAX - 1].rstrip() + "…"


def parse_tool_arguments(raw: Any) -> dict[str, Any]:
    """The model's arguments as an object. Providers send a JSON string,
    sometimes encoded twice; anything that isn't an object stays visible to
    validation (as `_raw`), which rejects it with a clear error."""
    value: Any = raw
    for _ in range(3):
        if isinstance(value, dict):
            return value
        if not isinstance(value, str):
            break
        text = value.strip()
        if not text:
            return {}
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return {"_raw": raw}
    return value if isinstance(value, dict) else {"_raw": raw}


# ── Dispatch ───────────────────────────────────────────────────────────────


ExaSearch = Callable[[str, int], list[dict[str, Any]]]


def run_tool(session: Session, chat: ChatSession, name: str, arguments: Any, *,
             exa_search: ExaSearch | None = None) -> ToolOutcome:
    """Validate, then run one tool inside a savepoint. Errors (invalid
    arguments, list rules, bugs) come back as tool errors and undo the
    call's writes; bugs are logged with their traceback."""
    model = ARGS.get(name)
    if model is None:
        return _error(f"Unknown tool '{name}'. Available: {', '.join(ARGS)}.")
    try:
        args = model.model_validate(parse_tool_arguments(arguments))
    except ValidationError as e:
        return _error(_validation_message(e))
    savepoint = session.begin_nested()
    try:
        outcome = _dispatch(session, chat, args, exa_search or _exa_search)
    except ll.ListError as e:
        outcome = _error(str(e))
    except Exception as e:  # a bug must not end the chat
        log.exception("Agent tool %s failed", name)
        outcome = _error(f"The tool failed unexpectedly ({type(e).__name__}). "
                         "Try a different approach or tell the user.")
    if outcome.is_error:
        savepoint.rollback()
    else:
        savepoint.commit()
    return outcome


def _dispatch(session: Session, chat: ChatSession, args: _Args,
              exa_search: ExaSearch) -> ToolOutcome:
    match args:
        case CorpusSearch():
            return _corpus_search(session, args)
        case RequestWebResearch():
            return _request_web_research(args)
        case WebResearch():
            return _web_research(chat, args, exa_search)
        case ReadList():
            return _read_list(session, args)
        case CreateList():
            return _create_list(session, chat, args)
        case UpdateList():
            return _update_list(session, chat, args)
        case AskUser():
            ask = {"kind": "ask_user", "question": _short_question(args.question),
                   "options": [o.strip() for o in args.options if o.strip()]}
            return ToolOutcome(content=json.dumps({"status": "waiting_for_user", **ask}),
                               pause=True, ask=ask)
    raise AssertionError(f"no handler for {type(args).__name__}")


# ── Corpus and web ─────────────────────────────────────────────────────────


def _company_snapshot(session: Session, company_id: uuid.UUID) -> dict[str, Any]:
    from app.corpus import detail

    d = detail(session, company_id)
    out: dict[str, Any] = {"id": str(company_id), "name": d.get("name")}
    want = {"name", "website", "sector", "sub_sector", "hq", "description",
            "investor_type", "buyer_category", "revenue", "aum", "employee_count"}
    for cell in d.get("cells") or []:  # catalogue order, newest period first
        field = cell.get("field")
        if field in want and field not in out and cell.get("value") is not None:
            out[field] = cell["value"]
    return out


def _corpus_search(session: Session, args: CorpusSearch) -> ToolOutcome:
    total, ids = company_search.search(session, args.query, "relevance", False, 0,
                                       args.limit)
    if total == 0:
        # Explicit, so the model doesn't report an empty result as an outage.
        return _ok({"status": "ok", "total": 0, "items": [],
                    "note": "Our data is available; nothing matched this query."})
    return _ok({"status": "ok", "total": total,
                "items": [_company_snapshot(session, i) for i in ids]})


def _exa_search(query: str, num_results: int) -> list[dict[str, Any]]:
    s = settings()
    if not s.exa_api_key:
        raise RuntimeError("EXA_API_KEY is not configured.")
    response = httpx.post(
        f"{s.exa_base_url.rstrip('/')}/search",
        headers={"x-api-key": s.exa_api_key, "content-type": "application/json"},
        json={"query": query, "type": "auto", "numResults": num_results,
              "contents": {"highlights": {"maxCharacters": 400}}},
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Exa failed ({response.status_code}): {response.text[:300]}")
    return [{"title": r.get("title"), "url": r.get("url"),
             "published_date": r.get("publishedDate"),
             "highlights": (r.get("highlights") or [])[:3]}
            for r in response.json().get("results") or []]


def _web_blocked(chat: ChatSession, query: str) -> str | None:
    """None if this search is approved; otherwise why not, for the model."""
    if chat.web_research_enabled or chat.web_research_once:
        return None
    allowed = (chat.web_research_allowed_query or "").strip()
    if allowed and allowed.casefold() == query.casefold():
        return None
    if allowed:
        return (f"Only the approved search {allowed!r} may run. Call "
                "request_web_research again for a different search.")
    return ("Web research is off. Call request_web_research first and wait for "
            "the user to approve it.")


def _request_web_research(args: RequestWebResearch) -> ToolOutcome:
    options = {
        "query": [OPT_ALLOW_QUERY, OPT_ALLOW_TURN, OPT_ALLOW_CHAT, OPT_DENY],
        "turn": [OPT_ALLOW_TURN, OPT_ALLOW_CHAT, OPT_DENY],
        "session": [OPT_ALLOW_CHAT, OPT_DENY],
    }[args.scope]
    grant = {"query": "web_research_query", "turn": "web_research_once",
             "session": "web_research"}[args.scope]
    ask = {"kind": "web_research", "question": _short_question(args.reason),
           "options": options, "grant": grant, "scope": args.scope,
           "query": (args.query or "").strip() or None}
    return ToolOutcome(content=json.dumps({"status": "waiting_for_user", **ask}),
                       pause=True, grant=grant, ask=ask)


def _web_research(chat: ChatSession, args: WebResearch,
                  exa_search: ExaSearch) -> ToolOutcome:
    query = args.query.strip()
    blocked = _web_blocked(chat, query)
    if blocked:
        return _error(blocked)
    if chat.web_searches_used >= EXA_CAP:
        return _error(f"Web research cap reached ({EXA_CAP} searches this run). "
                      "Continue with what you have.")
    try:
        results = exa_search(query, args.num_results)
    except Exception as e:  # noqa: BLE001 - the provider's failure, for the model
        return _error(f"Web search failed: {e}")
    chat.web_searches_used += 1
    # A one-search approval is used up by that search.
    if not (chat.web_research_enabled or chat.web_research_once):
        chat.web_research_allowed_query = None
    return _ok({"results": results, "searches_used": chat.web_searches_used,
                "searches_remaining": EXA_CAP - chat.web_searches_used})


# ── Lists ──────────────────────────────────────────────────────────────────


def _entry_op(session: Session, entry: Entry, where: str) -> ll.AddEntry:
    """An add_entry op; every value is checked here, so a bad one is
    reported with its path rather than failing the list as a whole."""
    if entry.company_id is not None:
        from app.models import Entity

        company = session.get(Entity, entry.company_id)
        if company is None or company.kind != "company":
            raise ll.ListError(
                f"{where}.company_id: not a company in our data. Use an id from "
                "search results, or leave it out and give the name and values.")
    values: dict[str, Any] = {
        k: v for k, v in entry.values.model_dump(exclude_none=True).items()}
    if entry.name:
        values.setdefault("name", entry.name)
    if entry.company_id is None:
        for key, raw in values.items():
            try:
                normalize(CATALOGUE[key], raw)
            except Invalid as e:
                raise ll.ListError(f"{where}.values.{key}: {e}") from e
    else:
        values = {}  # facts of a corpus company come from the corpus
    if entry.relevance_score is not None:
        values["relevance_score"] = entry.relevance_score
    if entry.relevance_explanation:
        values["relevance_explanation"] = entry.relevance_explanation
    return ll.AddEntry(op="add_entry", company_id=entry.company_id, values=values,
                       source=_source(entry.source_url, entry.source_title))


def _source(url: str | None, title: str | None = None) -> ll.Source:
    """A web page when the model names one; otherwise its own unsourced claim."""
    url = (url or "").strip() or None
    return ll.Source(type="web" if url else "agent", url=url,
                     title=(title or "").strip() or None)


def _link(chat: ChatSession, lst: Longlist) -> None:
    if str(lst.id) not in (chat.list_ids or []):
        chat.list_ids = [*(chat.list_ids or []), str(lst.id)]


def _create_list(session: Session, chat: ChatSession, args: CreateList) -> ToolOutcome:
    ops = [_entry_op(session, e, f"entries.{i}") for i, e in enumerate(args.entries)]
    # Facts the agent filled in get a column, so they show.
    used = [k for op in ops for k in op.values if k in VALUE_KEYS]
    columns = list(dict.fromkeys([*ll.DEFAULT_COLUMNS[args.kind], *used]))
    lst, version = ll.create_list(
        session, name=args.name, owner=chat.owner, target=args.target, kind=args.kind,
        columns=columns, ops=ops, author=AGENT_AUTHOR,
        message=args.message or "Created by the agent")
    _link(chat, lst)
    return _ok({"list_id": str(lst.id), "name": lst.name, "kind": lst.kind,
                "version": version.number,
                "size": ll.sizes(session, [lst.id]).get(lst.id, 0)})


def _resolve_column(column: str, columns: dict[str, str]) -> str:
    """A column key, or the key of the column with that label."""
    if column in columns:
        return column
    by_label = {label.casefold(): key for key, label in columns.items()}
    key = by_label.get(column.strip().casefold())
    if key is None:
        raise ll.ListError(f"No column '{column}' on this list. Columns: "
                           + ", ".join(f"{k} ({lbl})" for k, lbl in columns.items()))
    return key


def _update_list(session: Session, chat: ChatSession, args: UpdateList) -> ToolOutcome:
    lst = session.get(Longlist, args.list_id)
    if lst is None:
        raise ll.ListError("No longlist with that id.")
    columns = {c.key: c.label for c in ll.columns_at(session, lst.id, lst.head_version)}
    taken = set(columns) | ll.used_column_keys(session, lst.id)
    ops: list = []
    for i, op in enumerate(args.ops):
        where = f"ops.{i}"
        match op:
            case AddRow():
                entry = _entry_op(session, op.entry, f"{where}.entry")
                for key in entry.values:
                    if key in VALUE_KEYS and key not in columns:
                        ops.append(ll.AddColumn(op="add_column", key=key))
                        columns[key] = CATALOGUE[key].label
                ops.append(entry)
            case SetCell():
                key = _resolve_column(op.column, columns)
                if key == "relevance_explanation" and isinstance(op.value, str):
                    try:
                        citations.check(op.value)
                    except ValueError as e:
                        raise ll.ListError(f"{where}.value: {e}") from e
                ops.append(ll.SetCell(op="set", entry_id=op.row_id, key=key,
                                      value=op.value, source=_source(op.source_url)))
            case RemoveRow():
                ops.append(ll.RemoveEntry(op="remove_entry", entry_id=op.row_id))
            case AddColumn():
                if op.key:
                    key, label = op.key, CATALOGUE[op.key].label
                else:
                    label = op.label.strip()
                    key = ll.custom_column_key(label, taken)
                taken.add(key)
                columns[key] = label
                ops.append(ll.AddColumn(op="add_column", key=op.key, label=op.label,
                                        after=op.after))
            case RemoveColumn():
                ops.append(ll.RemoveColumn(op="remove_column",
                                           key=_resolve_column(op.column, columns)))
    version = ll.apply_changes(session, lst, ops, AGENT_AUTHOR, args.message)
    _link(chat, lst)
    return _ok({"list_id": str(lst.id), "name": lst.name, "version": version.number,
                "changes": version.changes, "message": version.message})


def _read_list(session: Session, args: ReadList) -> ToolOutcome:
    lst = session.get(Longlist, args.list_id)
    if lst is None:
        raise ll.ListError("No longlist with that id.")
    table = ll.table(session, lst)
    rows = [{"row_id": r["id"], "company_id": r["company_id"],
             "values": {k: c.get("value") for k, c in r["cells"].items()}}
            for r in table["rows"][:READ_LIST_MAX_ROWS]]
    return _ok({"list_id": str(lst.id), "name": lst.name, "kind": lst.kind,
                "version": table["version"], "size": len(table["rows"]),
                "columns": [{"key": c["key"], "label": c["label"], "type": c["type"]}
                            for c in table["columns"]],
                "rows": rows,
                "truncated": len(table["rows"]) > READ_LIST_MAX_ROWS})


# ── Web approval ───────────────────────────────────────────────────────────


def apply_web_grant(chat: ChatSession, answer: str, grant: str | None, *,
                    query: str | None = None) -> str | None:
    """Apply a web-research approval. Only an allow button grants anything:
    typed text on the card (a question, "maybe") is an answer for the model,
    never consent. Returns the scope granted, or None."""
    if grant not in ("web_research", "web_research_once", "web_research_query"):
        return None
    choice = (answer or "").strip()
    if choice == OPT_ALLOW_CHAT:
        chat.web_research_enabled = True
        chat.web_research_once = False
        chat.web_research_allowed_query = None
        return "session"
    if choice == OPT_ALLOW_TURN:
        chat.web_research_once = True
        return "turn"
    if choice == OPT_ALLOW_QUERY and (query or "").strip():
        chat.web_research_allowed_query = query.strip()
        return "query"
    return None


def answer_for_model(answer: str, ask: dict[str, Any] | None,
                     granted: str | None) -> str:
    """What the model reads as the result of a question card."""
    if not ask or ask.get("kind") != "web_research":
        return f"The user answered: {answer}"
    if granted == "session":
        return "The user approved web research for the rest of this chat."
    if granted == "turn":
        return "The user approved web research until this run ends."
    if granted == "query":
        return f"The user approved this one search: {ask.get('query')!r}."
    if answer.strip() == OPT_DENY:
        return "The user declined web research. Continue with our own data."
    return ("The user didn't approve web research and wrote instead: "
            f"{answer}")


def clear_ephemeral_web_grants(chat: ChatSession) -> None:
    """Drop turn/query allowances when a run finishes (not on requires_action)."""
    chat.web_research_once = False
    chat.web_research_allowed_query = None
