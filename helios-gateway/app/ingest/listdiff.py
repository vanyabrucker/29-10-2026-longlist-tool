"""List imports: map a file's columns onto a longlist, diff every cell, and
commit the result as one list version (`apply_changes`).

The stages are the corpus import's (parse, detect, map, match, diff, review,
commit); only the target differs. Rows are matched by the hidden Helios ID
column when the file carries a verified export mark (app/exports.py),
otherwise by company with the corpus matcher (and list-only rows by name).

Every mapped cell of a matched row gets a class:
- unchanged: file = list (or, with an export, nothing changed on either side;
  without one, the file holds a value we exported before). No write, so the
  value keeps its provenance: it never gains confidence by round-tripping.
- kept: changed in Helios since the export, not in the file. Helios stays.
- new / changed: only the file has it or changed it. With an export, the
  uploader edited it (manual, as of the file's date); otherwise it's new data
  from the file (`file` source, file confidence). Corpus facts become a
  prioritized observation, exactly like an edit from the list.
- conflict: changed in both since the export. The reviewer picks; Helios
  is the default.
Rows without an id (or matching no row) are new rows; exported rows missing
from the file are offered for removal (default: keep).
"""

import re
import uuid
from datetime import date
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import exports
from app import longlists as ll
from app.agent import events as ev
from app.agent.bus import bus
from app.catalogue import CATALOGUE
from app.ingest.match import build_index, norm_name
from app.ingest.normalize import Invalid, is_empty, normalize
from app.models import (
    ChatSession,
    Document,
    Import,
    ListEntry,
    ListExport,
    Longlist,
    RawRow,
)

HELIOS_ID = "helios_id"
NEW_COLUMN = "new_column"
LIST_ENTITIES = ("company", "list_entry")
MATCH_FIELDS = ("name", "legal_name", "website", "registry_id", "capiq_id", "orbis_id", "hq")
# The Contacts column and an export's contact block: read from the corpus.
CONTACT_HEADER = re.compile(r"^contact person \d+ (name|role|phone|email|relationship)$",
                            re.IGNORECASE)
CONTACTS_NOT_IMPORTED = "Contacts come from the corpus; not imported."


class StaleList(Exception):
    """The list changed after the review was built."""


# ── Mapping ────────────────────────────────────────────────────────────────


def current_columns(session: Session, lst: Longlist | None) -> list[dict]:
    """The list's columns a file can map onto (all but Contacts)."""
    if lst is None or lst.head_version == 0:
        return []
    return [{"key": c.key, "label": c.label, "type": c.type, "source": c.source}
            for c in ll.columns_at(session, lst.id, lst.head_version)
            if c.key != ll.CONTACTS_KEY]


def premap(table: dict, list_cols: list[dict], export_cols: list[dict] | None = None) -> None:
    """Columns we can map without the LLM: the hidden Helios ID, headers of
    the verified export the file came from (`export_cols`, its record's
    columns: a client export's display-only columns are left out on purpose,
    and its money in millions keeps its scale), and headers equal to one of
    the list's column labels. Contacts headers are display-only."""
    exported = {str(c["label"]).strip().lower(): c for c in export_cols or []}
    by_label = {c["label"].strip().lower(): c["key"] for c in list_cols}
    used: set[str] = set()
    for c in table["columns"]:
        header = str(c["header"]).strip().lower()
        c.pop("scale", None)
        c.pop("display_only", None)
        if (header == ll.CONTACTS_COLUMN["label"].lower()
                or CONTACT_HEADER.match(header)):
            c.update(field=None, period=None, confidence=None, suggested_field=None,
                     new_label=None, display_only=True, reason=CONTACTS_NOT_IMPORTED)
            continue
        if header == exports.ID_HEADER.lower():
            key, reason = HELIOS_ID, "The row ids Helios writes into its exports."
        elif header in exported and exported[header]["key"] is None:
            c.update(field=None, period=None, confidence=None, suggested_field=None,
                     new_label=None, display_only=True,
                     reason="Shown in the client export for reading only; not imported.")
            continue
        elif (header in exported and exported[header]["key"] not in used
              # a custom column removed since the export becomes a new column again
              and valid_field(exported[header]["key"], list_cols)):
            key, reason = exported[header]["key"], "A column Helios exported."
            if exported[header].get("scale"):
                c["scale"] = {"key": key, "factor": exported[header]["scale"]}
        elif header in by_label and by_label[header] not in used:
            key, reason = by_label[header], "Same name as a column of the list."
        else:
            continue
        used.add(key)
        c.update(field=key, period=None, confidence=1.0, reason=reason,
                 suggested_field=key, new_label=None)


def finish_mapping(table: dict, llm_columns: list[dict] | None, rows: list[list]) -> None:
    """Merge the LLM's suggestions into columns `premap` left open, keeping
    only data points a list can hold; whatever is still open and has values
    becomes a new list-only column named after its header."""
    taken = {c["field"] for c in table["columns"] if c.get("field")}
    suggested = {c["letter"]: c for c in llm_columns or []}
    for c in table["columns"]:
        if c.get("field") or c.get("display_only"):
            continue
        s = suggested.get(c["letter"], {})
        field = s.get("field")
        point = CATALOGUE.get(field or "")
        if point is not None and point.entity in LIST_ENTITIES and field not in taken:
            taken.add(field)
            c.update(field=field, period=None, confidence=s.get("confidence"),
                     reason=s.get("reason") or "", suggested_field=field, new_label=None)
            continue
        has_values = any(c["index"] < len(r) and not is_empty(r[c["index"]]) for r in rows)
        reason = s.get("reason") or ""
        if point is not None and point.entity not in LIST_ENTITIES:
            reason = f"{point.label} isn't a company fact, so it becomes a list column."
        c.update(field=NEW_COLUMN if has_values else None, period=None,
                 confidence=None, reason=reason, suggested_field=None,
                 new_label=str(c["header"]).strip()[:120] if has_values else None)


def valid_field(field: str | None, list_cols: list[dict]) -> bool:
    if field in (None, HELIOS_ID, NEW_COLUMN):
        return True
    if field == ll.CONTACTS_KEY:
        return False
    if any(c["key"] == field for c in list_cols):
        return True
    point = CATALOGUE.get(field or "")
    return point is not None and point.entity in LIST_ENTITIES


# ── Diff ───────────────────────────────────────────────────────────────────


def _spec(session: Session, field: str, column: dict, cur: dict[str, dict],
          taken: set[str]) -> dict | None:
    if field == HELIOS_ID:
        return {"key": HELIOS_ID, "kind": "id", "type": "text", "label": exports.ID_HEADER}
    if field == NEW_COLUMN:
        label = (column.get("new_label") or column["header"] or "Column").strip()[:120]
        key = ll.custom_column_key(label, taken)
        taken.add(key)
        return {"key": key, "kind": "custom", "type": "text", "label": label, "new": True}
    if field in cur:
        c = cur[field]
        kind = ("corpus" if c["source"].startswith("corpus:")
                else "list" if c["source"] == "list" else "custom")
        return {"key": field, "kind": kind, "type": c["type"], "label": c["label"]}
    point = CATALOGUE.get(field)
    if point is None or point.entity not in LIST_ENTITIES:
        return None
    return {"key": field, "kind": "list" if field in ll.LIST_FIELDS else "corpus",
            "type": point.type, "label": point.label, "new": True}


def _apply_value(spec: dict, raw: Any, current: Any) -> tuple[Any, Any]:
    """(normalised value for display, value to send to apply_changes) of a
    file cell; raises Invalid with a message for the reviewer."""
    if is_empty(raw):
        return None, None
    if spec["key"] == "relevance_score":
        try:
            n = ll._percent(raw)
        except ll.ListError as e:
            raise Invalid(str(e).removeprefix("Relevance score: ")) from e
        return n, n
    if spec["kind"] == "custom" or spec["key"] == "relevance_explanation":
        s = str(raw).strip()
        return s, s
    point = CATALOGUE[spec["key"]]
    value = normalize(point, raw)
    # Excel keeps the currency in the number format, which doesn't come back:
    # the number keeps the currency the value had.
    if (point.type == "money" and isinstance(value, dict) and value.get("currency") is None
            and isinstance(current, dict) and current.get("currency")):
        value = {**value, "currency": current["currency"]}
        return value, f"{value['currency']} {raw}"
    return value, raw


def _company_values(specs: list[dict], cells: list) -> dict:
    out: dict[str, Any] = {}
    for spec, raw in zip(specs, cells, strict=True):
        if spec["key"] in MATCH_FIELDS and spec["kind"] == "corpus" and not is_empty(raw):
            try:
                out[spec["key"]] = normalize(CATALOGUE[spec["key"]], raw)
            except Invalid:
                pass
    return out


def build(session: Session, imp: Import, progress=None) -> dict:
    lst = session.get(Longlist, imp.list_id) if imp.list_id else None
    data = ll.table(session, lst) if lst and lst.head_version else {"columns": [], "rows": []}
    cur = {c["key"]: c for c in data["columns"]}
    rows_now = {uuid.UUID(r["id"]): r for r in data["rows"]}
    entries = (list(session.scalars(select(ListEntry).where(ListEntry.list_id == lst.id)))
               if lst else [])
    entry_company = {e.id: e.company_id for e in entries}
    by_company = {e.company_id: e.id for e in entries if e.company_id}
    by_name = {norm_name(str(r["cells"]["name"]["value"])): i for i, r in rows_now.items()
               if not r["company_id"] and (r["cells"].get("name") or {}).get("value")}

    export = session.get(ListExport, imp.export_id) if imp.export_id else None
    if export is not None and (lst is None or export.list_id != lst.id):
        export = None
    snap = exports.snapshot(session, export.id) if export else {}
    exported_keys = {c["key"] for c in export.columns} if export else set()

    taken = set(cur) | (ll.used_column_keys(session, lst.id) if lst else set())
    included = [(i, t) for i, t in enumerate(imp.tables) if t.get("include")]
    specs_by_table: dict[int, list[tuple[dict, dict]]] = {}
    new_columns: list[dict] = []
    seen_keys: set[str] = set()
    for ti, t in included:
        specs = []
        for c in t["columns"]:
            field = c.get("field")
            if not field:
                continue
            spec = _spec(session, field, c, cur, taken)
            if spec is None or (spec["key"] in seen_keys and spec["kind"] != "id"):
                continue
            if (c.get("scale") or {}).get("key") == spec["key"]:
                spec = {**spec, "scale": c["scale"]["factor"]}  # money in millions
            seen_keys.add(spec["key"])
            specs.append((c, spec))
            if spec.get("new"):
                new_columns.append({k: spec[k] for k in ("key", "label", "kind", "type")})
        specs_by_table[ti] = specs

    index = build_index(session)
    raw_by_table: dict[int, list[RawRow]] = {}
    for rr in session.scalars(select(RawRow).where(RawRow.import_id == imp.id)
                              .order_by(RawRow.id)):
        raw_by_table.setdefault(rr.table_index, []).append(rr)

    # Pass 1: which row of the list each file row is.
    planned: list[dict] = []
    seen_ids: set[uuid.UUID] = set()
    for ti, _t in included:
        specs = specs_by_table[ti]
        only = [s for _, s in specs]
        for rr in raw_by_table.get(ti, []):
            cells = [rr.cells[c["index"]] if c["index"] < len(rr.cells) else None
                     for c, _ in specs]
            row = {"key": f"t{ti}:r{rr.row_number}", "sheet": rr.sheet, "row": rr.row_number,
                   "specs": only, "raw": cells, "entry_id": None, "company_id": None,
                   "by_id": False, "errors": [], "match": None}
            ids = [raw for s, raw in zip(only, cells, strict=True) if s["kind"] == "id"]
            if export and ids and not is_empty(ids[0]):
                try:
                    entry_id = uuid.UUID(str(ids[0]).strip())
                except ValueError:
                    entry_id = None
                if entry_id in seen_ids:
                    row["errors"].append("The same Helios ID appears on an earlier row; "
                                         "this copy is skipped.")
                elif entry_id in snap:
                    seen_ids.add(entry_id)
                    row.update(entry_id=entry_id, by_id=True,
                               company_id=entry_company.get(entry_id))
            if row["entry_id"] is None and not row["errors"]:
                values = _company_values(only, cells)
                match = index.match_company(values)
                if match.level in ("certain", "likely"):
                    company_id = uuid.UUID(match.entity_id)
                    row["company_id"] = company_id
                    row["entry_id"] = by_company.get(company_id)
                    row["match"] = {"level": match.level, "reason": match.reason,
                                    "label": match.label}
                elif values.get("name"):
                    row["entry_id"] = by_name.get(norm_name(str(values["name"])))
                    if match.level == "suggestion":
                        row["match"] = {"level": "suggestion", "reason": match.reason,
                                        "label": match.label}
                if row["entry_id"] in seen_ids:
                    row["errors"].append("Another row of the file is already this row of "
                                         "the list; this one is skipped.")
                elif row["entry_id"]:
                    seen_ids.add(row["entry_id"])
            planned.append(row)
    if progress:
        progress(0.5, "Comparing values")

    # Current corpus values of matched companies that aren't on the list yet,
    # and of every company for data points the list has no column for (a
    # client export's facts).
    corpus_keys = [s["key"] for s in {s["key"]: s for r in planned for s in r["specs"]}.values()
                   if s["kind"] == "corpus"]
    outside_cells = ll.corpus_cells(
        session, list({r["company_id"] for r in planned if r["company_id"]}), corpus_keys, None)
    before = exports.exported_before(
        session, {r["company_id"] for r in planned if r["company_id"]},
        {r["entry_id"] for r in planned if r["entry_id"]})

    totals = {"rows": len(planned), "new_rows": 0, "changed_cells": 0, "new_cells": 0,
              "conflicts": 0, "errors": 0, "unchanged": 0, "kept": 0, "deleted_rows": 0,
              "removed_in_helios": 0}
    out_rows = []
    for r in planned:
        out = _diff_row(r, rows_now, snap, exported_keys, outside_cells, before, totals)
        out_rows.append(out)
    if export:
        # Facts our export showed that the list has no column for get one only
        # when the file changes them.
        written = {c["key"] for r in out_rows for c in r["cells"]
                   if c["class"] in ("new", "changed", "conflict")}
        new_columns = [c for c in new_columns if c["kind"] != "corpus" or c["key"] in written]

    deleted = []
    has_ids = any(s["kind"] == "id" for specs in specs_by_table.values() for _, s in specs)
    if export and has_ids:
        for entry_id in snap:
            if entry_id not in seen_ids and entry_id in rows_now:
                name = (rows_now[entry_id]["cells"].get("name") or {}).get("value")
                deleted.append({"entry_id": str(entry_id), "label": name})
    totals["deleted_rows"] = len(deleted)

    names = ll.user_names(session, {export.exported_by}) if export else {}
    return {
        "kind": "list",
        "base_list_version": lst.head_version if lst else 0,
        "list": {"id": str(lst.id), "name": lst.name} if lst else None,
        "export": {"id": str(export.id), "list_version": export.list_version,
                   "by": export.exported_by,
                   "name": names.get(export.exported_by, export.exported_by),
                   "at": export.created_at.isoformat(),
                   # False when the hidden Helios ID column was deleted or unmapped:
                   # rows were then matched by company and deletions can't be found.
                   "has_ids": has_ids} if export else None,
        "summary": totals,
        "totals": {"new_rows": totals["new_rows"],
                   "changed_cells": totals["changed_cells"] + totals["new_cells"],
                   "conflicts": totals["conflicts"], "errors": totals["errors"]},
        "new_columns": new_columns,
        "rows": out_rows,
        "deleted": deleted,
    }


def _diff_row(r: dict, rows_now: dict, snap: dict, exported_keys: set[str],
              outside_cells: dict, before: dict, totals: dict) -> dict:
    entry_id, company_id = r["entry_id"], r["company_id"]
    on_list = entry_id in rows_now
    if r["errors"]:
        kind = "error"
    elif on_list:
        kind = "existing"
    elif r["by_id"]:
        kind = "removed_in_helios"
    else:
        kind = "new"
    out = {"key": r["key"], "sheet": r["sheet"], "row": r["row"],
           "entry_id": str(entry_id) if entry_id else None,
           "company_id": str(company_id) if company_id else None,
           "kind": kind, "match": r["match"], "cells": [], "errors": list(r["errors"]),
           "label": None}
    current_row = rows_now.get(entry_id, {}).get("cells", {}) if on_list else {}
    for spec, raw in zip(r["specs"], r["raw"], strict=True):
        if spec["key"] == "name" and not is_empty(raw):
            out["label"] = str(raw)
    if out["label"] is None:
        out["label"] = (current_row.get("name") or {}).get("value") or (
            (r["match"] or {}).get("label"))
    if kind in ("error", "removed_in_helios"):
        totals["errors" if kind == "error" else "removed_in_helios"] += 1
        return out

    owner = str(company_id) if company_id else (str(entry_id) if entry_id else None)
    for spec, raw in zip(r["specs"], r["raw"], strict=True):
        if spec["kind"] == "id":
            continue
        if on_list and not (spec["kind"] == "corpus" and spec.get("new")):
            current = (current_row.get(spec["key"]) or {}).get("value")
        elif company_id and spec["kind"] == "corpus":
            current = (outside_cells.get((company_id, spec["key"])) or {}).get("value")
        else:
            current = None
        cell = _classify(r, spec, raw, current, snap, exported_keys, before.get(
            (owner, spec["key"]), []))
        if cell["class"] == "unchanged":
            totals["unchanged"] += 1
            continue
        if cell["class"] == "error":
            out["errors"].append(f"{spec['label']}: {cell['error']}")
        out["cells"].append(cell)

    if kind == "new" and not company_id and not any(
            c["key"] == "name" and c.get("set") for c in out["cells"]):
        out["kind"] = "error"
        out["errors"].append("No company name in this row.")
    if out["errors"]:
        totals["errors"] += 1
    if out["kind"] == "new" and (company_id or any(c.get("set") is not None
                                                   for c in out["cells"])):
        totals["new_rows"] += 1
    elif out["kind"] == "existing":
        for c in out["cells"]:
            if c["class"] == "changed":
                totals["changed_cells"] += 1
            elif c["class"] == "new":
                totals["new_cells"] += 1
            elif c["class"] == "conflict":
                totals["conflicts"] += 1
            elif c["class"] == "kept":
                totals["kept"] += 1
    return out


def _classify(r: dict, spec: dict, raw: Any, current: Any, snap: dict,
              exported_keys: set[str], exported_before: list) -> dict:
    """One cell's class (see the module docstring) and the value to write."""
    entry_id, company_id = r["entry_id"], r["company_id"]
    if spec.get("scale") and isinstance(raw, (int, float)) and not isinstance(raw, bool):
        raw = round(raw * spec["scale"], 2)  # "12.3" in a column "in m"
    cur_w = exports.written(current, spec["type"])
    cell: dict[str, Any] = {"key": spec["key"], "label": spec["label"], "file": raw,
                            "current": cur_w}
    if r["by_id"] and spec["key"] in exported_keys:
        exp_w = snap.get(entry_id, {}).get(spec["key"])
        cell["exported"] = exp_w
        fe, ce = exports.same(raw, exp_w), exports.same(cur_w, exp_w)
        if fe and ce:
            cls = "unchanged"
        elif fe:
            cls = "kept"
        elif ce:
            cls = "new" if exports.empty(cur_w) else "changed"
            cell["source"] = "manual"  # the uploader edited our export
        elif exports.same(raw, cur_w):
            cls = "unchanged"
        else:
            cls = "conflict"
            cell["source"] = "manual"
    elif exports.empty(raw):
        cls = "unchanged"  # an empty cell in an outside file isn't a deletion
    elif exports.same(raw, cur_w):
        cls = "unchanged"
    elif any(exports.same(raw, v) for v in exported_before):
        cls = "unchanged"  # an older copy of a value we exported
    else:
        cls = "new" if exports.empty(cur_w) else "changed"
        cell["source"] = "file"
    if cls in ("new", "changed", "conflict"):
        try:
            cell["value"], cell["set"] = _apply_value(spec, raw, current)
        except Invalid as e:
            cell["error"] = str(e)
        if (cell.get("set") is None and "error" not in cell and spec["kind"] == "corpus"
                and company_id):
            cell["error"] = (f"{spec['label']} comes from the corpus and can't be "
                             "emptied from a file.")
        if "error" in cell:
            cls = "error"
    cell["class"] = cls
    return cell


# ── Commit ─────────────────────────────────────────────────────────────────


def commit(session: Session, imp: Import, author: str, progress=None) -> int | None:
    """The reviewed changes as one list version (a new list: its first).
    Returns the version number, None if nothing changed."""
    report = imp.report
    decisions = imp.decisions or {}
    doc = session.get(Document, imp.document_id)
    filename = doc.filename if doc else "file"
    as_of = imp.as_of or date.today()

    def source(kind: str) -> ll.Source:
        named = kind == "file" and imp.export_id is None
        return ll.Source(
            type=kind, as_of=as_of, file=filename, document_id=imp.document_id,
            # Outside data: the source the uploader named (default: the file).
            source_type=imp.source_type if named and imp.source_type != "file" else None,
            note=imp.source_note if named else None,
            by=(imp.source_by or imp.created_by) if named else None)

    # Corpus lock first, then the list (the order apply_changes uses).
    session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": ll.CORPUS_LOCK})
    lst = session.get(Longlist, imp.list_id) if imp.list_id else None
    if lst is not None:
        session.execute(select(Longlist.id).where(Longlist.id == lst.id).with_for_update())
        session.refresh(lst)
        if lst.head_version != report["base_list_version"]:
            raise StaleList()

    column_ops: list = []
    for c in report["new_columns"]:
        if c["kind"] == "custom":
            column_ops.append(ll.AddColumn(op="add_column", label=c["label"]))
        elif lst is not None:
            column_ops.append(ll.AddColumn(op="add_column", key=c["key"]))
    row_ops: list = []
    for r in report["rows"]:
        if r["kind"] == "existing":
            for c in r["cells"]:
                take = c["class"] in ("new", "changed") or (
                    c["class"] == "conflict" and decisions.get(f"c:{r['key']}:{c['key']}") == "file")
                if take and "error" not in c:
                    row_ops.append(ll.SetCell(op="set", entry_id=uuid.UUID(r["entry_id"]),
                                              key=c["key"], value=c.get("set"),
                                              source=source(c.get("source") or "file")))
        elif r["kind"] == "new":
            values = {c["key"]: c["set"] for c in r["cells"]
                      if c["class"] in ("new", "changed") and c.get("set") is not None}
            company_id = uuid.UUID(r["company_id"]) if r["company_id"] else None
            if company_id or values:
                row_ops.append(ll.AddEntry(op="add_entry", company_id=company_id,
                                           values=values, source=source("file"),
                                           corpus=True))
    for d in report["deleted"]:
        if decisions.get(f"d:{d['entry_id']}") == "remove":
            row_ops.append(ll.RemoveEntry(op="remove_entry", entry_id=uuid.UUID(d["entry_id"])))
    if progress:
        progress(0.4, "Writing the list version")

    message = f"Imported {filename}"
    if lst is None:
        keys = ["name", *[c["key"] for c in report["new_columns"] if c["kind"] != "custom"]]
        name = (imp.new_list_name or "").strip() or filename.rsplit(".", 1)[0][:255]
        lst, version = ll.create_list(session, name=name, owner=author, columns=keys,
                                      ops=[*column_ops, *row_ops], message=message,
                                      import_id=imp.id)
        imp.list_id = lst.id
        number: int | None = version.number
    else:
        try:
            with session.begin_nested():
                number = ll.apply_changes(session, lst, [*column_ops, *row_ops], author,
                                          message, import_id=imp.id).number
        except ll.ListError as e:
            if e.status != 409 or str(e) != "Nothing changed.":
                raise
            number = None
    imp.list_version = number
    imp.status = "committed"
    return number


def link_chat(import_id: uuid.UUID) -> None:
    """After a list import from a chat: the list joins the chat, and an
    import event in the log starts an agent turn that reports on it."""
    from app.db import session_scope

    emitted = []
    with session_scope() as s:
        imp = s.get(Import, import_id)
        if imp is None or imp.session_id is None or imp.list_id is None:
            return
        chat = s.get(ChatSession, imp.session_id)
        if chat is None:
            return
        ev.lock_chat(s, chat.id)
        s.refresh(chat)
        if str(imp.list_id) not in (chat.list_ids or []):
            chat.list_ids = [*(chat.list_ids or []), str(imp.list_id)]
        lst = s.get(Longlist, imp.list_id)
        doc = s.get(Document, imp.document_id)
        totals = (imp.report or {}).get("totals", {})
        emitted.append(ev.append(s, chat.id, ev.USER_IMPORT, {
            "import_id": str(imp.id), "list_id": str(imp.list_id),
            "list_name": lst.name if lst else None, "filename": doc.filename if doc else None,
            "version": imp.list_version, **{k: totals.get(k, 0) for k in
                                            ("new_rows", "changed_cells", "conflicts")}},
            processed=False))
        ev.touch(chat)
    for e in emitted:
        bus.publish(e.session_id, ev.public_event(e))
    # Like a message: the agent takes a turn to report on the import.
    from app.agent import runner
    runner.wake(imp.session_id)
