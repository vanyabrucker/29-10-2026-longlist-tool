"""Long import steps run in a background thread inside the API process (no job
queue). Each writes its step, progress and an estimated time left to the
import row, which the UI polls. Imports interrupted by a restart are marked
failed on startup.
"""

import threading
import time
import traceback
import uuid
from collections.abc import Callable

from sqlalchemy import delete, select, update

from app import storage
from app.catalogue import CATALOGUE_VERSION
from app.db import session_scope
from app.ingest import detect, mapping, parse
from app.ingest.commit import StaleReport, commit
from app.ingest.report import build
from app.models import Document, Import, RawRow

RUNNING = ("analysing", "remapping", "building_report", "committing")

Progress = Callable[[float, str], None]


def _tracker(import_id: uuid.UUID, start: float, span: float) -> Progress:
    """Report progress for one step, mapped into [start, start + span] of the
    whole bar, with an estimate of the time left for this step."""
    began = time.monotonic()
    last = [0.0]

    def report(fraction: float, step: str) -> None:
        now = time.monotonic()
        if now - last[0] < 0.4 and fraction < 1:
            return
        last[0] = now
        fraction = max(0.0, min(1.0, fraction))
        elapsed = now - began
        eta = int(elapsed / fraction * (1 - fraction)) if fraction > 0.05 else None
        with session_scope() as s:
            s.execute(update(Import).where(Import.id == import_id).values(
                progress=round(start + span * fraction, 3), step=step, eta_seconds=eta))

    return report


def _run(import_id: uuid.UUID, status: str, work: Callable[[Progress], None],
         done_status: str) -> None:
    def target() -> None:
        try:
            work(_tracker(import_id, 0, 1))
            with session_scope() as s:
                s.execute(update(Import).where(Import.id == import_id).values(
                    status=done_status, progress=1, eta_seconds=None, step=None))
        except StaleReport:
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
                    status="failed", error=f"{type(e).__name__}: {e}", eta_seconds=None))

    with session_scope() as s:
        s.execute(update(Import).where(Import.id == import_id).values(
            status=status, progress=0, error=None, eta_seconds=None, step="Starting"))
    threading.Thread(target=target, daemon=True, name=f"{status}-{import_id}").start()


def start_analysis(import_id: uuid.UUID) -> None:
    """Parse the file, find tables, store raw rows, propose column mappings."""

    def work(progress: Progress) -> None:
        with session_scope() as s:
            imp = s.get(Import, import_id)
            doc = s.get(Document, imp.document_id)
            filename, key = doc.filename, doc.storage_key
            feedback = [f["text"] for f in imp.feedback]
        progress(0.02, "Reading the file")
        data = storage.get(key)
        sheets, warnings = parse.parse(filename, data)
        progress(0.15, f"Read {len(sheets)} sheet(s)")

        tables: list[dict] = []
        for i, sheet in enumerate(sheets):
            progress(0.15 + 0.3 * i / len(sheets), f"Finding tables in '{sheet.name}'")
            found, warning = detect.detect(sheet)
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
                     f"Mapping columns of '{t['sheet']}' ({ti + 1}/{len(tables)})")
            rows = [cells for _, cells in detect.rows_of(by_name[t["sheet"]], t)]
            try:
                t["columns"], t["notes"] = mapping.propose(t, rows, filename, feedback)
            except Exception as e:  # noqa: BLE001
                warnings.append(f"Column mapping failed for '{t['sheet']}': {e}")
                for c in t["columns"]:
                    c.update(field=None, period=None, confidence=None, reason="",
                             suggested_field=None)
        with session_scope() as s:
            imp = s.get(Import, import_id)
            imp.tables = tables
            imp.warnings = warnings
            imp.catalogue_version = CATALOGUE_VERSION
            imp.report = None

    _run(import_id, "analysing", work, "mapping_review")


def start_remap(import_id: uuid.UUID) -> None:
    """Re-run the LLM mapping with the dev's feedback (tables stay as they are)."""

    def work(progress: Progress) -> None:
        with session_scope() as s:
            imp = s.get(Import, import_id)
            filename = s.get(Document, imp.document_id).filename
            tables = imp.tables
            feedback = [f["text"] for f in imp.feedback]
            raw = {}
            for rr in s.scalars(select(RawRow).where(RawRow.import_id == import_id)):
                raw.setdefault(rr.table_index, []).append(rr.cells)
        previous = {(ti, c["letter"]): c.get("field") for ti, t in enumerate(tables)
                    for c in t["columns"]}
        for ti, t in enumerate(tables):
            if not t.get("include"):
                continue
            progress(ti / len(tables), f"Re-mapping '{t['sheet']}'")
            t["columns"], t["notes"] = mapping.propose(t, raw.get(ti, []), filename, feedback)
            for c in t["columns"]:
                before = previous.get((ti, c["letter"]))
                c["changed_from"] = before if before != c.get("field") else None
        with session_scope() as s:
            imp = s.get(Import, import_id)
            imp.tables = tables
            imp.report = None

    _run(import_id, "remapping", work, "mapping_review")


def start_report(import_id: uuid.UUID, notice: str | None = None) -> None:
    def work(progress: Progress) -> None:
        progress(0.05, "Matching companies and people")
        with session_scope() as s:
            imp = s.get(Import, import_id)
            report = build(s, imp, progress)
            report["notice"] = notice
            imp.report = report
            imp.decisions = {}

    _run(import_id, "building_report", work, "report_review")


def start_commit(import_id: uuid.UUID, author: str) -> None:
    def work(progress: Progress) -> None:
        progress(0.05, "Waiting for other imports to finish")
        with session_scope() as s:
            imp = s.get(Import, import_id)
            commit(s, imp, author, progress)

    _run(import_id, "committing", work, "committed")


def fail_interrupted() -> None:
    """On startup: imports left mid-step by a restart can't resume."""
    with session_scope() as s:
        s.execute(update(Import).where(Import.status.in_(RUNNING)).values(
            status="failed", eta_seconds=None,
            error="Interrupted by a server restart. Please run this step again."))
