"""Longlists: versioned buyer lists on top of the corpus.

Every change goes through `apply_changes` and becomes one numbered list
version. Columns and entry data are temporal rows ([valid_from, valid_to) in
list versions): a change closes the current row and inserts a full new
snapshot, unchanged rows aren't copied. Reading version N takes the rows with
valid_from <= N < valid_to (or valid_to null); the diff of N pairs the rows
that end at N with the rows that start at N. Restoring an older version
writes its rows back as a new version; nothing is deleted.

Corpus columns aren't copied into the list: they show the corpus's shown
value, live on the latest version and as of the version's `corpus_version`
on older ones. Editing a corpus fact from a list writes a `manual`
observation and prioritizes it (a value pin), so it shows everywhere.
"""

import re
import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.catalogue import CATALOGUE
from app.ingest.normalize import Invalid, normalize, parse_number
from app.models import (
    CurrentValue,
    Entity,
    ListColumn,
    ListEntry,
    ListEntryState,
    ListVersion,
    Longlist,
    Observation,
    SourceType,
    User,
    ValuePin,
    Version,
)
from app.quality import freshness, level, score
from app.values import live_at, recompute, winner

# Same lock as import commits and pins: corpus writes run one at a time.
CORPUS_LOCK = 7_331_001

# Kept per list, not in the corpus (the catalogue's list_entry data points).
LIST_FIELDS = ("relevance_score", "relevance_explanation")

DEFAULT_COLUMNS: dict[str | None, tuple[str, ...]] = {
    None: ("name", "relevance_score", "relevance_explanation", "website", "hq"),
    # The list's main fact, then rationale and score, so both are on screen.
    "financial": ("name", "investor_type", "relevance_explanation", "relevance_score",
                  "aum", "hq", "founded", "employee_count", "website"),
    "strategic": ("name", "sector", "relevance_explanation", "relevance_score",
                  "sub_sector", "revenue", "ebitda", "owner_type", "acquisition_interest",
                  "hq", "founded", "employee_count", "website"),
}


class ListError(Exception):
    """A change that can't be applied; `status` is the HTTP status to answer."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def column_spec(key: str) -> dict:
    """A catalogue data point as a list column."""
    point = CATALOGUE.get(key)
    if point is None or point.entity not in ("company", "list_entry"):
        raise ListError(f"'{key}' isn't a company data point.")
    source = "list" if key in LIST_FIELDS else f"corpus:{key}"
    return {"key": key, "label": point.label, "type": point.type, "source": source}


def custom_column_key(label: str, taken: set[str]) -> str:
    """The key a list-only column gets: custom_<slug>, numbered if a column
    of the list ever used it (old versions keep their keys)."""
    slug = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")[:40] or "column"
    key, i = f"custom_{slug}", 2
    while key in taken:
        key, i = f"custom_{slug}_{i}", i + 1
    return key


def used_column_keys(session: Session, list_id: uuid.UUID) -> set[str]:
    """Every column key the list has had, in any version."""
    return set(session.scalars(
        select(ListColumn.key).where(ListColumn.list_id == list_id).distinct()))


def _corpus_field(column: dict | ListColumn) -> str | None:
    source = column["source"] if isinstance(column, dict) else column.source
    return source.removeprefix("corpus:") if source.startswith("corpus:") else None


# ── Operations ─────────────────────────────────────────────────────────────


class Source(BaseModel):
    """Where a value comes from: a web page (`url`), the agent without a
    source, a person typing it in, or an uploaded file (`file`, new data
    from outside Helios). Kept per cell for list-only values and scored like
    corpus values (source confidence × freshness). For corpus facts, `file`
    and `manual` decide the observation's source type; `as_of` dates it
    (default today) and `document_id` points at the uploaded original."""

    type: Literal["web", "agent", "manual", "file"]
    url: str | None = Field(default=None, max_length=2000)
    title: str | None = Field(default=None, max_length=300)
    as_of: date | None = None
    file: str | None = Field(default=None, max_length=255)
    document_id: uuid.UUID | None = None
    # For `file`: the source the uploader picked (a source_types key, e.g.
    # capiq, scored at its confidence; "other" with a `note` naming it,
    # kept but never shown as the source), and who claimed it (`by`).
    source_type: str | None = Field(default=None, max_length=40)
    note: str | None = Field(default=None, max_length=120)
    by: str | None = Field(default=None, max_length=255)


class AddEntry(BaseModel):
    """Add a row (a corpus company, or a row with its own values). A company
    already on the list is updated (and brought back if it was removed)."""

    op: Literal["add_entry"]
    company_id: uuid.UUID | None = None
    values: dict[str, Any] = {}
    source: Source | None = None
    # Corpus facts among `values` that differ from the shown value become
    # corpus observations (list imports); otherwise they are ignored (the
    # corpus import writes them itself).
    corpus: bool = False


class SetCell(BaseModel):
    op: Literal["set"]
    entry_id: uuid.UUID
    key: str
    value: Any = None
    source: Source | None = None


class RemoveEntry(BaseModel):
    op: Literal["remove_entry"]
    entry_id: uuid.UUID


class AddColumn(BaseModel):
    """A catalogue data point (`key`), or a list-only column (`label`)."""

    op: Literal["add_column"]
    key: str | None = None
    label: str | None = Field(default=None, max_length=120)
    after: str | None = None


class RemoveColumn(BaseModel):
    op: Literal["remove_column"]
    key: str


class OrderColumns(BaseModel):
    op: Literal["order_columns"]
    keys: list[str]


class Restore(BaseModel):
    """Bring back version N's columns and rows, as a new version."""

    op: Literal["restore"]
    version: int


Op = Annotated[AddEntry | SetCell | RemoveEntry | AddColumn | RemoveColumn
               | OrderColumns | Restore, Field(discriminator="op")]


# ── Reading versions ───────────────────────────────────────────────────────


def _valid_at(model, n: int):
    return (model.valid_from <= n) & (model.valid_to.is_(None) | (model.valid_to > n))


def columns_at(session: Session, list_id: uuid.UUID, n: int) -> list[ListColumn]:
    return list(session.scalars(
        select(ListColumn).where(ListColumn.list_id == list_id, _valid_at(ListColumn, n))
        .order_by(ListColumn.position)))


def states_at(session: Session, list_id: uuid.UUID, n: int) -> dict[uuid.UUID, ListEntryState]:
    return {s.entry_id: s for s in session.scalars(
        select(ListEntryState).where(ListEntryState.list_id == list_id,
                                     _valid_at(ListEntryState, n)))}


def _state_values(s: ListEntryState | dict) -> dict:
    """An entry's list data as one flat dict (hot columns and jsonb)."""
    if isinstance(s, dict):
        return {"relevance_score": s["relevance_score"], **s["data"]}
    return {"relevance_score": s.relevance_score, **(s.data or {})}


def diff(session: Session, list_id: uuid.UUID, n: int) -> dict:
    """What version N changed: rows ending at N paired with rows starting at
    N, compared key by key, plus the corpus facts edited from the list."""
    def rows(model, column):
        return session.scalars(select(model).where(model.list_id == list_id,
                                                   column == n)).all()

    ended = {s.entry_id: s for s in rows(ListEntryState, ListEntryState.valid_to)}
    started = {s.entry_id: s for s in rows(ListEntryState, ListEntryState.valid_from)}
    out: dict[str, Any] = {"cells": [], "added_rows": [], "removed_rows": [],
                           "added_columns": [], "removed_columns": [], "moved_columns": []}
    for entry_id, new in started.items():
        old = ended.get(entry_id)
        was_shown = old is not None and not old.removed
        if not was_shown and not new.removed:
            out["added_rows"].append(entry_id)
        elif was_shown and new.removed:
            out["removed_rows"].append(entry_id)
        elif was_shown:
            before, after = _state_values(old), _state_values(new)
            for key in sorted(before.keys() | after.keys()):
                if before.get(key) != after.get(key):
                    out["cells"].append({"entry_id": entry_id, "key": key,
                                         "old": before.get(key), "new": after.get(key)})
    old_cols = {c.key: c for c in rows(ListColumn, ListColumn.valid_to)}
    new_cols = {c.key: c for c in rows(ListColumn, ListColumn.valid_from)}
    out["added_columns"] = [k for k in new_cols if k not in old_cols]
    out["removed_columns"] = [k for k in old_cols if k not in new_cols]
    if any(new_cols[k].position != old_cols[k].position
           for k in new_cols.keys() & old_cols.keys()):
        before = [c.key for c in columns_at(session, list_id, n - 1)]
        after = [c.key for c in columns_at(session, list_id, n)]
        out["moved_columns"] = _moved(before, after)
    version = _version_row(session, list_id, n)
    for edit in version.corpus_edits if version else []:
        out["cells"].append({**edit, "entry_id": uuid.UUID(edit["entry_id"]),
                             "key": edit["field"], "corpus": True})
    return out


def _moved(before: list[str], after: list[str]) -> list[str]:
    """The columns a reorder moved: one drag moves one column."""
    shared = [k for k in before if k in after]
    target = [k for k in after if k in before]
    single = [k for k in shared
              if [x for x in shared if x != k] == [x for x in target if x != k]]
    if shared != target and single:
        return single[:1]
    return [k for i, k in enumerate(target) if shared[i] != k]


def count_changes(d: dict) -> int:
    return (len(d["cells"]) + len(d["added_rows"]) + len(d["removed_rows"])
            + len(d["added_columns"]) + len(d["removed_columns"]) + len(d["moved_columns"]))


def _version_row(session: Session, list_id: uuid.UUID, n: int) -> ListVersion | None:
    return session.scalar(select(ListVersion).where(ListVersion.list_id == list_id,
                                                    ListVersion.number == n))


# ── Corpus values ──────────────────────────────────────────────────────────


def corpus_cells(session: Session, company_ids: list[uuid.UUID], fields: list[str],
                 corpus_version: int | None) -> dict[tuple[uuid.UUID, str], dict]:
    """The shown value per company and data point (latest fiscal year), with
    its quality. None reads the live values; otherwise as they were at that
    global version (a re-applied revert reads as if it never happened)."""
    if not company_ids or not fields:
        return {}
    confidence = dict(session.execute(select(SourceType.key, SourceType.confidence)).all())
    labels = dict(session.execute(select(SourceType.key, SourceType.label)).all())
    shown: dict[tuple, tuple[Observation, ValuePin | None, int]] = {}
    if corpus_version is None:
        rows = session.execute(
            select(CurrentValue, Observation)
            .join(Observation, Observation.id == CurrentValue.observation_id)
            .where(CurrentValue.entity_id.in_(company_ids), CurrentValue.field.in_(fields))
        ).all()
        pin_ids = [cv.pin_id for cv, _ in rows if cv.pin_id]
        pins = {p.id: p for p in session.scalars(
            select(ValuePin).where(ValuePin.id.in_(pin_ids)))} if pin_ids else {}
        for cv, o in rows:
            shown[(cv.entity_id, cv.field, cv.period)] = (o, pins.get(cv.pin_id), cv.sources)
    else:
        observations = session.scalars(select(Observation).where(
            Observation.entity_id.in_(company_ids), Observation.field.in_(fields),
            live_at(Observation, corpus_version))).all()
        events = session.scalars(select(ValuePin).where(
            ValuePin.entity_id.in_(company_ids), live_at(ValuePin, corpus_version))
            .order_by(ValuePin.id)).all()
        latest = {(p.entity_id, p.field, p.period): p for p in events}
        groups: dict[tuple, list[Observation]] = {}
        for o in observations:
            groups.setdefault((o.entity_id, o.field, o.period or 0), []).append(o)
        for key, group in groups.items():
            pin = latest.get(key)
            best, pin = winner(group, pin if pin and pin.observation_id else None, confidence)
            shown[key] = (best, pin, len(group))
    names = user_names(session, {p.pinned_by for _, p, _ in shown.values() if p})
    today = date.today()
    out: dict[tuple[uuid.UUID, str], dict] = {}
    for (entity_id, field, period), (o, pin, sources) in sorted(
            shown.items(), key=lambda kv: kv[0][2]):  # the latest year wins
        sc = score(confidence[o.source_type], field, o.as_of)
        point = CATALOGUE.get(field)
        undated = o.as_of is None and (point is None or point.half_life_days is not None)
        by = ({"by": pin.pinned_by, "name": names.get(pin.pinned_by, pin.pinned_by),
               "at": pin.created_at.isoformat() if pin.created_at else None}
              if pin else None)
        out[(entity_id, field)] = {
            "value": o.value.get("v") if isinstance(o.value, dict) else o.value,
            "period": period or None, "score": sc,
            "level": "unknown" if undated else level(sc),
            "confidence": round(100 * confidence[o.source_type]),
            "freshness": None if undated else round(100 * freshness(field, o.as_of, today)),
            "as_of": o.as_of.isoformat() if o.as_of else None,
            "source": labels[o.source_type], "sources": sources,
            "pinned": by, "manual": by if o.source_type == "manual" else None,
        }
    return out


def user_names(session: Session, emails: set[str]) -> dict[str, str]:
    if not emails:
        return {}
    return dict(session.execute(select(User.email, User.name)
                                .where(User.email.in_(emails))).all())


def _company_names(session: Session, company_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    cells = corpus_cells(session, company_ids, ["name"], None)
    return {cid: str(c["value"]) for (cid, _), c in cells.items()}


# ── Writing ────────────────────────────────────────────────────────────────


class _Work:
    """The pending changes of one `apply_changes` call."""

    def __init__(self, session: Session, lst: Longlist, n: int, author: str):
        self.session, self.lst, self.n, self.author = session, lst, n, author
        self.current_cols = {c.key: c for c in columns_at(session, lst.id, n - 1)}
        self.cols: dict[str, dict] = {k: _col_dict(c) for k, c in self.current_cols.items()}
        self.current_states = states_at(session, lst.id, n - 1)
        self.entries = {e.id: e for e in session.scalars(
            select(ListEntry).where(ListEntry.list_id == lst.id))}
        self.states: dict[uuid.UUID, dict] = {}
        self.new_entries: set[uuid.UUID] = set()
        self.corpus_edits: list[dict] = []
        self.corpus_version: Version | None = None
        self.touched_companies: set[uuid.UUID] = set()

    # entries

    def state(self, entry_id: uuid.UUID) -> dict:
        if entry_id not in self.states:
            if entry_id not in self.entries:
                raise ListError("That row isn't on this list.", 404)
            cur = self.current_states.get(entry_id)
            self.states[entry_id] = (
                {"relevance_score": cur.relevance_score, "removed": cur.removed,
                 "data": dict(cur.data or {}),
                 "provenance": dict(cur.provenance or {})} if cur
                else _empty_state())
        return self.states[entry_id]

    def add_entry(self, op: AddEntry) -> None:
        existing = None
        if op.company_id is not None:
            company = self.session.get(Entity, op.company_id)
            if company is None or company.kind != "company":
                raise ListError("Company not found.", 404)
            existing = next((e for e in self.entries.values()
                             if e.company_id == op.company_id), None)
        if existing is None:
            entry = ListEntry(id=uuid.uuid4(), list_id=self.lst.id,
                              company_id=op.company_id, created_version=self.n)
            self.session.add(entry)
            self.entries[entry.id] = entry
            self.new_entries.add(entry.id)
            self.states[entry.id] = _empty_state()
        else:
            entry = existing
            self.state(entry.id)["removed"] = False
        for key, value in op.values.items():
            self.set(SetCell(op="set", entry_id=entry.id, key=key, value=value,
                             source=op.source), edit_corpus=op.corpus)

    def set(self, op: SetCell, edit_corpus: bool = True) -> None:
        state = self.state(op.entry_id)
        if state["removed"]:
            raise ListError("That row was removed from the list.", 409)
        entry = self.entries[op.entry_id]
        raw = op.value.strip() if isinstance(op.value, str) else op.value
        empty = raw is None or raw == ""
        key = op.key
        if key == "relevance_score":
            state["relevance_score"] = None if empty else _percent(raw)
            self.note_source(state, key, op.source, empty)
            return
        if key == "relevance_explanation" or (key in self.cols and
                                              self.cols[key]["source"] == "custom"):
            _set_data(state, key, None if empty else str(raw))
            self.note_source(state, key, op.source, empty)
            return
        point = CATALOGUE.get(key)
        if point is None or point.entity != "company":
            raise ListError(f"Unknown column '{key}'.")
        value = None
        if not empty:
            try:
                value = normalize(point, raw)
            except Invalid as e:
                raise ListError(f"{point.label}: {e}") from e
        if entry.company_id is None:
            # Not in the corpus yet: the list keeps the value, and its source.
            _set_data(state, key, value)
            self.note_source(state, key, op.source, value is None)
        elif not edit_corpus:
            pass  # imports write corpus values themselves
        elif value is None:
            raise ListError(f"{point.label} comes from the corpus and can't be emptied "
                            "here. Prioritize another source on the company page.")
        else:
            self.edit_corpus(entry, key, value, str(raw), op.source)

    def note_source(self, state: dict, key: str, source: Source | None,
                    empty: bool) -> None:
        """Remember where a list-only value came from (who, when, which page)."""
        if empty:
            state["provenance"].pop(key, None)
            return
        kind = source.type if source else ("agent" if self.author == "agent" else "manual")
        if source and source.type == "file" and source.source_type:
            kind = source.source_type
        at = source.as_of if source and source.as_of else date.today()
        state["provenance"][key] = {
            "type": kind, "by": self.author, "at": at.isoformat(),
            **({"note": source.note} if source and source.note else {}),
            **({"claimed_by": source.by} if source and source.by else {}),
            **({"url": source.url} if source and source.url else {}),
            **({"title": source.title} if source and source.title else {}),
            **({"file": source.file} if source and source.file else {})}

    def edit_corpus(self, entry: ListEntry, field: str, value: Any, raw: str,
                    source: Source | None = None) -> None:
        """An observation for the company, prioritized over the score: a
        person's edit (manual) or, from an uploaded file, at file confidence."""
        point = CATALOGUE[field]
        before = corpus_cells(self.session, [entry.company_id], [field], None)
        old = before.get((entry.company_id, field))
        if old is not None and old["value"] == value:
            return
        if self.corpus_version is None:
            self.corpus_version = Version(kind="manual", author=self.author, message="",
                                          counts={"values": 0})
            self.session.add(self.corpus_version)
            self.session.flush()
        version = self.corpus_version
        period = (old["period"] if old and old["period"] else date.today().year - 1
                  ) if point.periodic else None
        from_file = source is not None and source.type == "file"
        o = Observation(entity_id=entry.company_id, field=field, period=period,
                        value={"v": value}, raw=raw,
                        source_type=((source.source_type or "file") if from_file
                                     else "manual"),
                        source_note=source.note if from_file else None,
                        source_by=source.by if from_file else None,
                        document_id=source.document_id if source else None,
                        as_of=source.as_of if source and source.as_of else date.today(),
                        version_id=version.id)
        self.session.add(o)
        self.session.flush()
        self.session.add(ValuePin(entity_id=entry.company_id, field=field,
                                  period=period or 0, observation_id=o.id,
                                  pinned_by=self.author, version_id=version.id))
        version.counts = {"values": version.counts.get("values", 0) + 1}
        self.touched_companies.add(entry.company_id)
        self.corpus_edits.append({"entry_id": str(entry.id), "field": field,
                                  "old": old["value"] if old else None, "new": value})

    def remove_entry(self, op: RemoveEntry) -> None:
        self.state(op.entry_id)["removed"] = True

    # columns

    def add_column(self, op: AddColumn) -> None:
        if op.key:
            spec = column_spec(op.key)
        elif op.label and op.label.strip():
            label = op.label.strip()
            key = custom_column_key(
                label, set(self.cols) | used_column_keys(self.session, self.lst.id))
            spec = {"key": key, "label": label, "type": "text", "source": "custom"}
        else:
            raise ListError("A new column needs a data point or a label.")
        if spec["key"] in self.cols:
            raise ListError(f"The list already has the column {spec['label']}.", 409)
        order = self.order()
        at = order.index(op.after) + 1 if op.after in order else len(order)
        order.insert(at, spec["key"])
        self.cols[spec["key"]] = {**spec, "position": 0}
        self.set_order(order)

    def remove_column(self, op: RemoveColumn) -> None:
        if op.key == "name":
            raise ListError("The name column can't be removed.")
        if op.key not in self.cols:
            raise ListError("That column isn't on this list.", 404)
        order = self.order()
        order.remove(op.key)
        del self.cols[op.key]
        self.set_order(order)

    def order_columns(self, op: OrderColumns) -> None:
        if sorted(op.keys) != sorted(self.cols):
            raise ListError("Send every column of the list once.")
        if op.keys[0] != "name":
            raise ListError("The name column stays first.")
        self.set_order(op.keys)

    def order(self) -> list[str]:
        return sorted(self.cols, key=lambda k: self.cols[k]["position"])

    def set_order(self, keys: list[str]) -> None:
        for i, k in enumerate(keys):
            self.cols[k]["position"] = i

    # restore

    def restore(self, op: Restore) -> None:
        if not 1 <= op.version < self.n - 1:
            raise ListError("Pick an older version to restore.")
        self.cols = {c.key: _col_dict(c) for c in columns_at(self.session, self.lst.id,
                                                              op.version)}
        then = states_at(self.session, self.lst.id, op.version)
        for entry_id in self.entries:
            state = self.state(entry_id)
            old = then.get(entry_id)
            if old is None:
                state["removed"] = True  # added after that version
            else:
                state.update(relevance_score=old.relevance_score, removed=old.removed,
                             data=dict(old.data or {}),
                             provenance=dict(old.provenance or {}))

    # write

    def flush(self) -> None:
        n = self.n
        for entry_id, new in self.states.items():
            cur = self.current_states.get(entry_id)
            if cur is not None:
                if (cur.relevance_score == new["relevance_score"]
                        and cur.removed == new["removed"] and (cur.data or {}) == new["data"]):
                    continue
                cur.valid_to = n
            elif new["removed"]:
                continue  # added and removed in the same change
            self.session.add(ListEntryState(entry_id=entry_id, list_id=self.lst.id,
                                            valid_from=n, **new))
        for key in self.current_cols.keys() - self.cols.keys():
            self.current_cols[key].valid_to = n
        for key, spec in self.cols.items():
            cur = self.current_cols.get(key)
            if cur is not None:
                if _col_dict(cur) == spec:
                    continue
                cur.valid_to = n
            self.session.add(ListColumn(list_id=self.lst.id, valid_from=n, **spec))
        self.session.flush()


def _col_dict(c: ListColumn) -> dict:
    return {"key": c.key, "label": c.label, "type": c.type, "position": c.position,
            "source": c.source}


def _empty_state() -> dict:
    return {"relevance_score": None, "removed": False, "data": {}, "provenance": {}}


def _set_data(state: dict, key: str, value: Any) -> None:
    if value is None:
        state["data"].pop(key, None)
    else:
        state["data"][key] = value


def _percent(raw: Any) -> float:
    """A relevance score as typed: 94, "94", "94%" (not a fraction)."""
    try:
        n = float(raw) if isinstance(raw, (int, float)) else parse_number(str(raw).rstrip("% "))
    except (Invalid, ValueError) as e:
        raise ListError(f"Relevance score: {raw!r} isn't a number.") from e
    if not 0 <= n <= 100:
        raise ListError("Relevance score: use a number from 0 to 100.")
    return round(n, 2)


def apply_changes(session: Session, lst: Longlist, ops: list, author: str,
                  message: str | None = None, *, import_id: uuid.UUID | None = None,
                  allow_empty: bool = False) -> ListVersion:
    """Apply these operations as one new version of the list. The single
    write path for lists: edits, removals, columns, restores and imports."""
    ops = [o if isinstance(o, BaseModel) else _parse_op(o) for o in ops]
    if any(isinstance(o, SetCell) or (isinstance(o, AddEntry) and o.corpus) for o in ops):
        # A cell may be a corpus fact: take the corpus lock first (imports
        # take it before the list lock too, so the order is always the same).
        session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": CORPUS_LOCK})
    session.execute(select(Longlist.id).where(Longlist.id == lst.id).with_for_update())
    session.refresh(lst)
    work = _Work(session, lst, lst.head_version + 1, author)
    restored = None
    for op in ops:
        if isinstance(op, Restore):
            restored = op.version
        getattr(work, {"add_entry": "add_entry", "set": "set",
                       "remove_entry": "remove_entry", "add_column": "add_column",
                       "remove_column": "remove_column", "order_columns": "order_columns",
                       "restore": "restore"}[op.op])(op)
    work.flush()
    if work.touched_companies:
        session.flush()
        recompute(session, work.touched_companies)
    version = ListVersion(list_id=lst.id, number=work.n, author=author, message="",
                          corpus_version=session.scalar(select(func.max(Version.id))) or 0,
                          reverts=restored, import_id=import_id,
                          corpus_edits=work.corpus_edits, changes=0)
    session.add(version)
    session.flush()
    d = diff(session, lst.id, work.n)
    version.changes = count_changes(d)
    if version.changes == 0 and not allow_empty:
        raise ListError("Nothing changed.", 409)
    version.message = message or _describe(session, lst, work, ops, d)
    if work.corpus_version is not None:
        work.corpus_version.message = f"{version.message} (in {lst.name})"
    lst.head_version = work.n
    lst.updated_at = datetime.now(UTC)
    session.flush()
    return version


def _parse_op(o: dict) -> BaseModel:
    from pydantic import TypeAdapter

    return TypeAdapter(Op).validate_python(o)


def _describe(session: Session, lst: Longlist, work: _Work, ops: list, d: dict) -> str:
    """A commit message from the operations: "Edited Website of BWK GmbH"."""
    labels = {**{c.key: c.label for c in work.current_cols.values()},
              **{k: c["label"] for k, c in work.cols.items()}}

    def row_name(entry_id) -> str:
        entry = work.entries.get(uuid.UUID(str(entry_id)))
        if entry is None:
            return "a row"
        if entry.company_id:
            return _company_names(session, [entry.company_id]).get(entry.company_id, "a row")
        return str((work.states.get(entry.id) or {}).get("data", {}).get("name") or "a row")

    kinds = {o.op for o in ops}
    if kinds == {"restore"}:
        return f"Restored version {ops[0].version}"
    if kinds == {"set"} and len(ops) == 1:
        label = labels.get(ops[0].key) or column_label(ops[0].key)
        return f"Edited {label} of {row_name(ops[0].entry_id)}"
    if kinds == {"remove_entry"}:
        if len(ops) == 1:
            return f"Removed {row_name(ops[0].entry_id)}"
        return f"Removed {len(ops)} rows"
    if kinds == {"remove_column"} and len(ops) == 1:
        return f"Removed column {labels.get(ops[0].key, ops[0].key)}"
    if kinds == {"add_column"} and len(ops) == 1:
        added = d["added_columns"][0] if d["added_columns"] else ""
        return f"Added column {labels.get(added, added)}"
    if kinds == {"order_columns"}:
        moved = d["moved_columns"]
        if len(moved) == 1:
            return f"Moved column {labels.get(moved[0], moved[0])}"
        return "Reordered columns"
    if kinds == {"add_entry"}:
        return f"Added {len(ops)} row{'s' if len(ops) != 1 else ''}"
    return f"{len(ops)} changes"


def column_label(key: str) -> str:
    point = CATALOGUE.get(key)
    return point.label if point else key


def create_list(session: Session, *, name: str, owner: str, target: str | None = None,
                kind: str | None = None, columns: list[str] | None = None,
                ops: list | None = None, message: str | None = None,
                import_id: uuid.UUID | None = None,
                author: str | None = None) -> tuple[Longlist, ListVersion]:
    """A new list with its columns (and rows) as version 1."""
    lst = Longlist(name=name.strip(), owner=owner, target=target, kind=kind, head_version=0)
    session.add(lst)
    session.flush()
    keys = list(dict.fromkeys(["name", *(columns or DEFAULT_COLUMNS[kind])]))
    add = [AddColumn(op="add_column", key=k) for k in keys]
    version = apply_changes(session, lst, [*add, *(ops or [])], author or owner,
                            message or "Created the list", import_id=import_id,
                            allow_empty=True)
    return lst, version


# ── The table ──────────────────────────────────────────────────────────────


def table(session: Session, lst: Longlist, n: int | None = None,
          with_diff: bool = False) -> dict:
    """The list as of version N (default: the latest), ready for the table:
    columns in order and rows with their cells. With the diff, rows and
    columns removed in N are included (marked) and changed cells carry their
    old value."""
    head = lst.head_version
    n = head if n is None else n
    if not 1 <= n <= head:
        raise ListError("No such version.", 404)
    version = _version_row(session, lst.id, n)
    columns = [_col_dict(c) for c in columns_at(session, lst.id, n)]
    states = states_at(session, lst.id, n)
    d = diff(session, lst.id, n) if with_diff and n > 1 else None
    marks: dict[uuid.UUID, str] = {}
    old: dict[uuid.UUID, dict] = {}
    if d:
        before = states_at(session, lst.id, n - 1)
        for entry_id in d["removed_rows"]:
            states[entry_id] = before[entry_id]
            marks[entry_id] = "removed"
        for entry_id in d["added_rows"]:
            marks[entry_id] = "added"
        for c in d["cells"]:
            old.setdefault(c["entry_id"], {})[c["key"]] = c["old"]
        gone = {c.key: c for c in columns_at(session, lst.id, n - 1)
                if c.key in d["removed_columns"]}
        for key in d["removed_columns"]:
            columns.append({**_col_dict(gone[key]), "diff": "removed"})
        for c in columns:
            if c["key"] in d["added_columns"]:
                c["diff"] = "added"
        columns.sort(key=lambda c: (c["position"], c.get("diff") != "removed"))
    entries = {e.id: e for e in session.scalars(
        select(ListEntry).where(ListEntry.id.in_(list(states))))} if states else {}
    shown_ids = [i for i, s in states.items() if not s.removed or i in marks]
    company_ids = [entries[i].company_id for i in shown_ids if entries[i].company_id]
    fields = list({f for c in columns if (f := _corpus_field(c))})
    corpus = corpus_cells(session, company_ids, fields,
                          None if n == head else version.corpus_version)
    sourcing = _Sourcing(session, [states[i] for i in shown_ids])
    rows = []
    for entry_id in shown_ids:
        entry, state = entries[entry_id], states[entry_id]
        values = _state_values(state)
        cells: dict[str, dict] = {}
        for c in columns:
            field = _corpus_field(c)
            if field and entry.company_id:
                cell = corpus.get((entry.company_id, field))
            else:
                value = values.get(c["key"])
                cell = None if value is None else sourcing.cell(
                    c["key"], value, (state.provenance or {}).get(c["key"]))
            if cell is not None:
                cells[c["key"]] = cell
        changed = old.get(entry_id, {})
        for key, value in changed.items():
            cells.setdefault(key, {"value": None})["old"] = value
            cells[key]["changed"] = True
        rows.append({"id": str(entry_id),
                     "company_id": str(entry.company_id) if entry.company_id else None,
                     "cells": cells, "diff": marks.get(entry_id)})
    rows.sort(key=lambda r: (-(r["cells"].get("relevance_score", {}).get("value") or -1),
                             str(r["cells"].get("name", {}).get("value") or "").lower()))
    return {**summary(session, lst), "version": n, "columns": columns, "rows": rows,
            "corpus_version": version.corpus_version,
            "changes": d and count_changes(d)}


class _Sourcing:
    """Scores list-only values from their provenance, like corpus values:
    source confidence × freshness. A value with no record (written before
    provenance was kept) is Unknown, never assumed good."""

    def __init__(self, session: Session, states: list[ListEntryState]):
        self.confidence = dict(session.execute(
            select(SourceType.key, SourceType.confidence)).all())
        self.labels = dict(session.execute(select(SourceType.key, SourceType.label)).all())
        emails = {p.get("by") for st in states for p in (st.provenance or {}).values()}
        self.names = user_names(session, {e for e in emails if e and e != "agent"})
        self.today = date.today()

    def who(self, prov: dict) -> dict:
        by = prov.get("by") or ""
        name = "Agent" if by == "agent" else self.names.get(by, by)
        return {"by": by, "name": name, "at": prov.get("at")}

    def cell(self, key: str, value: Any, prov: dict | None) -> dict:
        if key in LIST_FIELDS:
            # The agent's or a person's judgement, not a fact: no quality score.
            return {"value": value, **({"added": self.who(prov)} if prov else {})}
        if not prov:
            return {"value": value, "score": None, "level": "unknown", "confidence": None,
                    "freshness": None, "as_of": None, "source": "Unknown source",
                    "sources": 1}
        kind = prov.get("type") if prov.get("type") in self.confidence else "agent"
        as_of = date.fromisoformat(prov["at"]) if prov.get("at") else None
        sc = score(self.confidence[kind], key, as_of)
        who = self.who(prov)
        return {"value": value, "score": sc, "level": level(sc),
                "confidence": round(100 * self.confidence[kind]),
                "freshness": round(100 * freshness(key, as_of, self.today)),
                "as_of": prov.get("at"), "source": self.labels[kind], "sources": 1,
                "url": prov.get("url"), "source_title": prov.get("title"),
                "file": prov.get("file"),
                "added": who, "manual": who if kind == "manual" else None,
                "pinned": None}


def summary(session: Session, lst: Longlist, names: dict[str, str] | None = None,
            size: int | None = None) -> dict:
    if names is None:
        names = user_names(session, {lst.owner})
    if size is None:
        size = sizes(session, [lst.id]).get(lst.id, 0)
    return {"id": str(lst.id), "name": lst.name, "target": lst.target, "kind": lst.kind,
            "owner": {"email": lst.owner, "name": names.get(lst.owner, lst.owner)},
            "size": size, "head_version": lst.head_version,
            "created_at": lst.created_at.isoformat() if lst.created_at else None,
            "edited_at": lst.updated_at.isoformat() if lst.updated_at else None}


def sizes(session: Session, list_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not list_ids:
        return {}
    return dict(session.execute(
        select(ListEntryState.list_id, func.count())
        .where(ListEntryState.list_id.in_(list_ids), ListEntryState.valid_to.is_(None),
               ListEntryState.removed.is_(False))
        .group_by(ListEntryState.list_id)).all())


def versions(session: Session, lst: Longlist) -> list[dict]:
    rows = session.scalars(select(ListVersion).where(ListVersion.list_id == lst.id)
                           .order_by(ListVersion.number.desc())).all()
    names = user_names(session, {v.author for v in rows})
    return [{"number": v.number, "author": v.author,
             "author_name": "Agent" if v.author == "agent" else names.get(v.author, v.author),
             "message": v.message, "created_at": v.created_at.isoformat(),
             "changes": v.changes, "reverts": v.reverts, "corpus_version": v.corpus_version,
             "latest": v.number == lst.head_version} for v in rows]
