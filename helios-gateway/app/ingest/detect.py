"""Find the tables in each sheet.

Headers aren't always in row 1: there are title rows, notes, two-row headers,
several tables per sheet and totals rows. A heuristic proposes tables; the LLM
reviews the top of the sheet and corrects them. If the LLM fails, the
heuristic stands (and the dev can still fix ranges in the preview).
"""

import itertools
import re
from typing import Any

from pydantic import BaseModel, Field

from app import llm
from app.ingest.parse import Sheet, letter

TOTALS = re.compile(r"^\s*(total|totals|sum|summe|gesamt|grand total)\b", re.IGNORECASE)
PREVIEW_ROWS = 40
CELL_CHARS = 40


def _filled(row: list[Any]) -> list[int]:
    return [i for i, v in enumerate(row) if v is not None]


def _is_text(v: Any) -> bool:
    return isinstance(v, str) and not re.fullmatch(r"[\d.,'%€$£\s-]+", v)


def _header_like(row: list[Any]) -> bool:
    cells = [v for v in row if v is not None]
    return len(cells) >= 2 and sum(_is_text(v) for v in cells) / len(cells) >= 0.7


def _grouped(row: list[Any]) -> bool:
    filled = _filled(row)
    if not filled:
        return False
    span = row[filled[0] : filled[-1] + 1]
    gaps = any(v is None for v in span)
    repeats = any(a is not None and a == b for a, b in itertools.pairwise(span))
    return gaps or repeats


def heuristic_tables(sheet: Sheet) -> list[dict]:
    """Split the sheet into blocks at blank rows; in each, the first header-like
    row (after any title rows) starts a table."""
    rows = sheet.rows
    blocks: list[tuple[int, int]] = []
    start = None
    for i, row in enumerate(rows + [[]]):
        if _filled(row):
            start = i if start is None else start
        elif start is not None:
            blocks.append((start, i - 1))
            start = None

    tables = []
    title_parts: list[str] = []
    for b_start, b_end in blocks:
        header = next(
            (i for i in range(b_start, b_end + 1) if _header_like(rows[i])), None
        )
        if header is None or header == b_end:
            # A title or note block: remember it for the next table.
            title_parts += [str(v) for r in rows[b_start : b_end + 1] for v in r if v]
            continue
        title_parts += [str(v) for r in rows[b_start:header] for v in r if v]
        # A second header row right below (e.g. years under a merged
        # "Financials") only when the top row looks grouped: gaps or the same
        # label repeated across neighbouring columns.
        first = header + 1
        if (
            first < b_end
            and _grouped(rows[header])
            and _header_like(rows[first])
            and not any(isinstance(v, (int, float)) for v in rows[first])
        ):
            first += 1
        tables.append(
            _table(sheet, header, first, b_end, " · ".join(title_parts[-3:]))
        )
        title_parts = []
    return tables


def _table(
    sheet: Sheet, header_row: int, first: int, last: int, title: str = ""
) -> dict:
    """A table spec with 1-based rows (as Excel shows them). Every row from
    `header_row` up to `first` is a header row; stacked headers are joined,
    e.g. "Revenue" over "2024" becomes "Revenue / 2024"."""
    rows = sheet.rows
    stack = [rows[r] for r in range(header_row, first)]
    width = max((len(r) for r in stack), default=0)
    header_cells: list[Any] = []
    for c in range(width):
        parts: list[str] = []
        for r in stack:
            v = r[c] if c < len(r) else None
            if v is not None and str(v) not in parts:
                parts.append(str(v))
        header_cells.append(" / ".join(parts) if parts else None)
    # Totals rows at the bottom aren't data.
    while last >= first and rows[last] and TOTALS.match(str(rows[last][0] or "")):
        last -= 1
    columns = [
        {"index": c, "letter": letter(c), "header": h}
        for c, h in enumerate(header_cells)
        if h is not None
    ]
    return {
        "sheet": sheet.name,
        "title": title,
        "header_row": header_row + 1,
        "first_data_row": first + 1,
        "last_row": last + 1,
        "columns": columns,
        "include": True,
    }


class _LLMTable(BaseModel):
    header_row: int = Field(description="1-based row of the column headers")
    first_data_row: int
    last_row: int
    title: str = ""


class _LLMTables(BaseModel):
    tables: list[_LLMTable]


_SYSTEM = (
    "You find data tables in spreadsheet sheets. Rows are 1-based as in Excel. "
    "header_row is the first row of column headers; if headers span several "
    "rows, every row before first_data_row counts as a header row. Ignore title "
    "rows, notes, blank rows and totals rows. "
    "Answer with JSON: {\"tables\": [{\"header_row\": int, \"first_data_row\": "
    "int, \"last_row\": int, \"title\": str}]}."
)


def _excerpt(sheet: Sheet) -> str:
    lines = []
    for i, row in enumerate(sheet.rows[:PREVIEW_ROWS]):
        cells = [
            f"{letter(c)}={str(v)[:CELL_CHARS]!r}" for c, v in enumerate(row) if v
        ]
        lines.append(f"row {i + 1}: " + (", ".join(cells) if cells else "(blank)"))
    if len(sheet.rows) > PREVIEW_ROWS:
        lines.append(f"... {len(sheet.rows) - PREVIEW_ROWS} more rows, last row is "
                     f"{len(sheet.rows)}")
    return "\n".join(lines)


def detect(sheet: Sheet, use_llm: bool = True) -> tuple[list[dict], str | None]:
    """Tables in the sheet, and a warning if the LLM step failed."""
    proposal = heuristic_tables(sheet)
    if not use_llm:
        return proposal, None
    user = (
        f"Sheet '{sheet.name}' ({len(sheet.rows)} rows):\n{_excerpt(sheet)}\n\n"
        "Proposal from a heuristic (may be wrong):\n"
        + "\n".join(
            f"- header_row {t['header_row']}, data {t['first_data_row']}–"
            f"{t['last_row']}" for t in proposal
        )
        + "\n\nReturn the correct tables."
    )
    try:
        answer = llm.ask(_LLMTables, _SYSTEM, user)
    except llm.LLMError as e:
        return proposal, f"Table detection by the LLM failed on '{sheet.name}': {e}"
    tables = []
    n = len(sheet.rows)
    for t in answer.tables:
        h, f, last = t.header_row - 1, t.first_data_row - 1, min(t.last_row, n) - 1
        if not (0 <= h < f <= last < n):
            continue
        tables.append(_table(sheet, h, f, last, t.title))
    return (tables or proposal), None


def rows_of(sheet: Sheet, table: dict) -> list[tuple[int, list[Any]]]:
    """The table's data rows as (1-based row number, cells), skipping blanks."""
    out = []
    for r in range(table["first_data_row"] - 1, table["last_row"]):
        if r < len(sheet.rows) and _filled(sheet.rows[r]):
            out.append((r + 1, sheet.rows[r]))
    return out
