"""Long import steps run in a background thread inside the API process (no job
queue). Each writes its step, progress and an estimated time left to the
import row, which the UI polls, plus the step's named phases (`phases`:
[{key, label, state pending|current|done, done?, total?}]) where it has more
than one. Imports interrupted by a restart are marked failed on startup.
"""

import threading
import time
import traceback
import uuid
from collections.abc import Callable

from sqlalchemy import delete, select, update

from app import config, exports, storage
from app.catalogue import CATALOGUE_VERSION
from app.db import session_scope
from app.ingest import detect, listdiff, mapping, parse
from app.ingest import report as corpus_report
from app.ingest.commit import StaleReport, commit, commit_phases
from app.models import Document, Import, ListExport, Longlist, RawRow

RUNNING = ("analysing", "remapping", "building_report", "committing")

# progress(fraction, step, phase=None, done=None, total=None)
Progress = Callable[..., None]
Phases = list[tuple[str, str]]  # (key, English label); the UI translates by key


def _phase_list(phases: Phases) -> list[dict] | None:
    return [{"key": k, "label": label, "state": "pending"} for k, label in phases] or None


class _Tracker:
    """Writes one step's progress to the import row: the bar's fraction, the
    step text, an estimate of the time left and, when the step has named
    phases, which are done, which is current (with `done of total` when it
    counts something) and which are still to come. Writes at most every 0.4 s,
    except when the phase changes or the step finishes."""

    def __init__(self, import_id: uuid.UUID, phases: Phases) -> None:
        self.import_id = import_id
        self.began = time.monotonic()
        self.last = 0.0
        self.phases = _phase_list(phases)

    def _enter(self, phase: str, done: int | None, total: int | None) -> bool:
        """Mark `phase` current and the ones before it done; True if it changed."""
        keys = [p["key"] for p in self.phases or []]
        if phase not in keys:
            raise ValueError(f"Unknown import phase {phase!r} (have {keys})")
        at = keys.index(phase)
        changed = self.phases[at]["state"] != "current"
        for i, p in enumerate(self.phases):
            p["state"] = "done" if i < at else "current" if i == at else "pending"
            if i != at:
                p.pop("done", None)
                p.pop("total", None)
        if total is not None:
            self.phases[at].update(done=done or 0, total=total)
        return changed

    def __call__(self, fraction: float, step: str, phase: str | None = None,
                 done: int | None = None, total: int | None = None) -> None:
        # A new phase and a phase's last count are always written.
        changed = (self._enter(phase, done, total) if phase else False) or (
            total is not None and done == total)
        now = time.monotonic()
        if now - self.last < 0.4 and fraction < 1 and not changed:
            return
        self.last = now
        fraction = max(0.0, min(1.0, fraction))
        elapsed = now - self.began
        eta = int(elapsed / fraction * (1 - fraction)) if fraction > 0.05 else None
        with session_scope() as s:
            s.execute(update(Import).where(Import.id == self.import_id).values(
                progress=round(fraction, 3), step=step, eta_seconds=eta,
                phases=self.phases))


def _run(import_id: uuid.UUID, status: str, work: Callable[[Progress], None],
         done_status: str, phases: Phases = ()) -> None:
    def target() -> None:
        try:
            work(_Tracker(import_id, phases))
            with session_scope() as s:
                s.execute(update(Import).where(Import.id == import_id).values(
                    status=done_status, progress=1, eta_seconds=None, step=None,
                    phases=None))
        except (StaleReport, listdiff.StaleList):
            start_report(
                import_id,
                notice="The database changed while you were reviewing (another "
                "import was committed), so the report was rebuilt. Please review "
                "it again.",
            )
        except Exception as e:  # noqa: BLE001 - shown to the dev
            traceback.print_exc()
            with session_scope() as s:
                s.execute(update(Import).where(Import.id == import_id).values(
                    status="failed", error=f"{type(e).__name__}: {e}", eta_seconds=None,
                    phases=None))

    with session_scope() as s:
        s.execute(update(Import).where(Import.id == import_id).values(
            status=status, progress=0, error=None, eta_seconds=None, step="Starting",
            phases=_phase_list(list(phases))))
    threading.Thread(target=target, daemon=True, name=f"{status}-{import_id}").start()


def start_analysis(import_id: uuid.UUID) -> None:
    """Parse the file, find tables, store raw rows, propose column mappings."""

    def work(progress: Progress) -> None:
        with session_scope() as s:
            imp = s.get(Import, import_id)
            doc = s.get(Document, imp.document_id)
            filename, key = doc.filename, doc.storage_key
            feedback = [f["text"] for f in imp.feedback]
            target, list_id = imp.target, imp.list_id
        progress(0.02, "Reading the file", phase="read")
        data = storage.get(key)
        sheets, warnings = parse.parse(filename, data)
        export_id, list_cols, export_cols = None, [], None
        if target == "list":
            export_id, list_cols, export_cols, note = _export_of(filename, data, list_id)
            if note:
                warnings.append(note)
        progress(0.15, f"Read {len(sheets)} sheet(s)")

        tables: list[dict] = []
        for i, sheet in enumerate(sheets):
            progress(0.15 + 0.3 * i / len(sheets), f"Finding tables in '{sheet.name}'",
                     phase="tables", done=i, total=len(sheets))
            # Our own export has one plain table per sheet: no LLM needed.
            found, warning = detect.detect(sheet, use_llm=export_id is None)
            if warning:
                warnings.append(warning)
            for t in found:
                t["formula_gaps"] = [
                    f"{parse.letter(c)}{r + 1}" for r, c in sheet.formula_gaps
                    if t["header_row"] <= r + 1 <= t["last_row"]
                ]
            tables += found
        if not tables:
            raise parse.ParseError("No table with a header row was found in the file.")

        by_name = {s.name: s for s in sheets}
        with session_scope() as s:
            s.execute(delete(RawRow).where(RawRow.import_id == import_id))
            for ti, t in enumerate(tables):
                for row_number, cells in detect.rows_of(by_name[t["sheet"]], t):
                    s.add(RawRow(import_id=import_id, table_index=ti, sheet=t["sheet"],
                                 row_number=row_number, cells=cells))
                t["row_count"] = len(detect.rows_of(by_name[t["sheet"]], t))

        for ti, t in enumerate(tables):
            progress(0.5 + 0.48 * ti / len(tables),
                     f"Mapping columns of '{t['sheet']}' ({ti + 1}/{len(tables)})",
                     phase="map", done=ti, total=len(tables))
            rows = [cells for _, cells in detect.rows_of(by_name[t["sheet"]], t)]
            if target == "list":
                _map_for_list(t, rows, filename, feedback, list_cols, export_cols, warnings)
                continue
            try:
                t["columns"], t["notes"] = mapping.propose(t, rows, filename, feedback)
            except Exception as e:  # noqa: BLE001
                warnings.append(f"Column mapping failed for '{t['sheet']}': {e}")
                for c in t["columns"]:
                    c.update(field=None, period=None, confidence=None, reason="",
                             suggested_field=None)
        with session_scope() as s:
            imp = s.get(Import, import_id)
            imp.export_id = export_id
            imp.tables = tables
            imp.warnings = warnings
            imp.catalogue_version = CATALOGUE_VERSION
            imp.report = None

    _run(import_id, "analysing", work, "mapping_review",
         [("read", "Reading the file"), ("tables", "Finding tables"),
          ("map", "Mapping columns")])


def _export_of(filename: str, data: bytes, list_id: uuid.UUID | None
               ) -> tuple[uuid.UUID | None, list[dict], list[dict] | None, str | None]:
    """The verified export a file came from, the list's columns, the export's
    columns, and a note for the reviewer when the file's mark can't be used."""
    token = exports.read_mark(filename, data)
    export_id = exports.verify(token)
    with session_scope() as s:
        lst = s.get(Longlist, list_id) if list_id else None
        list_cols = listdiff.current_columns(s, lst)
        record = s.get(ListExport, export_id) if export_id else None
        if token and record is None:
            return None, list_cols, None, ("This file carries a Helios export mark that couldn't be "
                                     "verified, so rows are matched by company instead.")
        if record is not None and record.list_id != list_id:
            name = s.get(Longlist, record.list_id).name
            return None, list_cols, None, (f"This file was exported from another list ({name}), "
                                     "so rows are matched by company instead.")
        if record is None:
            return None, list_cols, None, None
        return record.id, list_cols, record.columns, None


def _map_for_list(t: dict, rows: list, filename: str, feedback: list[str],
                  list_cols: list[dict], export_cols: list[dict] | None,
                  warnings: list[str], use_llm: bool | None = None) -> None:
    """Headers of the export the file came from, of the list's columns (and
    the Helios ID) map directly; the LLM suggests the rest unless the file is
    our own export, in which case extra columns are the user's own and
    become list columns."""
    for c in t["columns"]:
        c.update(field=None, new_label=None)
    listdiff.premap(t, list_cols, export_cols)
    suggested = None
    if use_llm is None:
        use_llm = export_cols is None
    if use_llm and any(not c.get("field") for c in t["columns"]):
        try:
            suggested, t["notes"] = mapping.propose(t, rows, filename, feedback)
        except Exception as e:  # noqa: BLE001 - any LLM failure: the reviewer maps
            warnings.append(f"Column mapping failed for '{t['sheet']}': {e}")
    listdiff.finish_mapping(t, suggested, rows)


def start_remap(import_id: uuid.UUID) -> None:
    """Re-run the LLM mapping with the dev's feedback (tables stay as they are)."""

    def work(progress: Progress) -> None:
        with session_scope() as s:
            imp = s.get(Import, import_id)
            filename = s.get(Document, imp.document_id).filename
            tables = imp.tables
            feedback = [f["text"] for f in imp.feedback]
            target = imp.target
            list_cols = (listdiff.current_columns(s, s.get(Longlist, imp.list_id))
                         if imp.list_id else [])
            record = s.get(ListExport, imp.export_id) if imp.export_id else None
            export_cols = record.columns if record else None
            raw = {}
            for rr in s.scalars(select(RawRow).where(RawRow.import_id == import_id)):
                raw.setdefault(rr.table_index, []).append(rr.cells)
        previous = {(ti, c["letter"]): c.get("field") for ti, t in enumerate(tables)
                    for c in t["columns"]}
        for ti, t in enumerate(tables):
            if not t.get("include"):
                continue
            progress(ti / len(tables), f"Re-mapping '{t['sheet']}'")
            if target == "list":
                _map_for_list(t, raw.get(ti, []), filename, feedback, list_cols, export_cols, [],
                              use_llm=True)
            else:
                t["columns"], t["notes"] = mapping.propose(t, raw.get(ti, []), filename,
                                                           feedback)
            for c in t["columns"]:
                before = previous.get((ti, c["letter"]))
                c["changed_from"] = before if before != c.get("field") else None
        with session_scope() as s:
            imp = s.get(Import, import_id)
            imp.tables = tables
            imp.report = None

    _run(import_id, "remapping", work, "mapping_review")


def start_report(import_id: uuid.UUID, notice: str | None = None) -> None:
    with session_scope() as s:
        target = s.get(Import, import_id).target
    phases = (listdiff.PHASES if target == "list"
              else corpus_report.phases(config.settings().website_check))

    def work(progress: Progress) -> None:
        with session_scope() as s:
            imp = s.get(Import, import_id)
            report = (listdiff.build(s, imp, progress) if imp.target == "list"
                      else corpus_report.build(s, imp, progress))
            report["notice"] = notice
            imp.report = report
            imp.decisions = {}

    _run(import_id, "building_report", work, "report_review", phases)


def start_commit(import_id: uuid.UUID, author: str) -> None:
    with session_scope() as s:
        imp = s.get(Import, import_id)
        phases = (listdiff.COMMIT_PHASES if imp.target == "list"
                  else commit_phases(bool(imp.list_id or imp.new_list_name)))

    def work(progress: Progress) -> None:
        progress(0.05, "Waiting for other imports to finish", phase="wait")
        with session_scope() as s:
            imp = s.get(Import, import_id)
            if imp.target == "list":
                listdiff.commit(s, imp, author, progress)
            else:
                commit(s, imp, author, progress)
        try:
            listdiff.link_chat(import_id)
        except Exception:  # noqa: BLE001 - the import is committed; the note is extra
            traceback.print_exc()

    _run(import_id, "committing", work, "committed", phases)


def fail_interrupted() -> None:
    """On startup: imports left mid-step by a restart can't resume."""
    with session_scope() as s:
        s.execute(update(Import).where(Import.status.in_(RUNNING)).values(
            status="failed", eta_seconds=None,
            error="Interrupted by a server restart. Please run this step again."))
