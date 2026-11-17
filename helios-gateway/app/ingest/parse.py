"""Read an uploaded file into sheets of plain cell values.

Formulas are never evaluated: we use the result Excel saved in the file, and
flag formulas that have none. Macros are never run. Merged cells are filled
with their top-left value, so a header spanning two columns labels both.
"""

import csv
import io
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import PurePath
from typing import Any

import msoffcrypto
import openpyxl
from openpyxl.utils import get_column_letter
from python_calamine import CalamineWorkbook

SUPPORTED = {".xlsx", ".xlsm", ".xls", ".xlsb", ".ods", ".csv"}

# Above this, skip openpyxl's extra pass (merged cells, formula check): it
# loads the whole workbook in memory.
OPENPYXL_LIMIT = 25 * 1024 * 1024


class ParseError(Exception):
    """A file we can't read; the message is shown to the dev as is."""


@dataclass
class Sheet:
    name: str
    rows: list[list[Any]]
    hidden: bool = False
    # (row, col) 0-based cells holding a formula without a saved result.
    formula_gaps: list[tuple[int, int]] = field(default_factory=list)

    @property
    def n_cols(self) -> int:
        return max((len(r) for r in self.rows), default=0)


def letter(col: int) -> str:
    """0-based column index → Excel letter."""
    return get_column_letter(col + 1)


def _plain(value: Any) -> Any:
    """Cell value → JSON-safe value (dates as ISO strings, floats that are whole
    numbers as ints)."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date().isoformat() if value.time() == time() else value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (time, timedelta)):
        return str(value)
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return int(value)
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _trim(rows: list[list[Any]]) -> list[list[Any]]:
    """Drop trailing empty rows and cells."""
    rows = [list(r) for r in rows]
    for r in rows:
        while r and r[-1] is None:
            r.pop()
    while rows and not rows[-1]:
        rows.pop()
    return rows


def is_encrypted(data: bytes) -> bool:
    try:
        return msoffcrypto.OfficeFile(io.BytesIO(data)).is_encrypted()
    except Exception:  # noqa: BLE001 - any parser error on untrusted bytes
        # Not an OLE container (e.g. a plain .xlsx zip): not encrypted.
        return False


def parse(filename: str, data: bytes) -> tuple[list[Sheet], list[str]]:
    """Return the sheets and any warnings for the dev."""
    ext = PurePath(filename).suffix.lower()
    if ext not in SUPPORTED:
        raise ParseError(
            f"Unsupported file type '{ext}'. Upload .xlsx, .xlsm, .xls, .xlsb, "
            ".ods or .csv."
        )
    if ext != ".csv" and is_encrypted(data):
        raise ParseError(
            "The file is password-protected. Please upload an unprotected copy."
        )
    warnings: list[str] = []
    if ext == ".csv":
        sheets = [_parse_csv(filename, data)]
    else:
        sheets = _parse_workbook(data)
        if ext in {".xlsx", ".xlsm"} and len(data) <= OPENPYXL_LIMIT:
            _apply_openpyxl(data, sheets)
        elif ext in {".xlsx", ".xlsm"}:
            warnings.append(
                "Large file: merged cells and missing formula results weren't checked."
            )
    if ext == ".xlsm":
        warnings.append("The file contains macros; they were not run.")
    hidden = [s.name for s in sheets if s.hidden]
    if hidden:
        warnings.append(f"Hidden sheets skipped: {', '.join(hidden)}.")
    sheets = [s for s in sheets if not s.hidden and s.rows]
    if not sheets:
        raise ParseError("The file has no visible sheet with data.")
    return sheets, warnings


def _parse_csv(filename: str, data: bytes) -> Sheet:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover - latin-1 always decodes
        raise ParseError("Couldn't read the CSV's text encoding.")
    sample = text[:20000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = [[_plain(c) for c in row] for row in csv.reader(io.StringIO(text), dialect)]
    return Sheet(PurePath(filename).stem or "CSV", _trim(rows))


def _parse_workbook(data: bytes) -> list[Sheet]:
    try:
        wb = CalamineWorkbook.from_filelike(io.BytesIO(data))
    except Exception as e:
        raise ParseError(f"The file couldn't be read as a spreadsheet ({e}).") from e
    sheets = []
    for meta in wb.sheets_metadata:
        visible = str(getattr(meta, "visible", "Visible")).lower()
        try:
            raw = wb.get_sheet_by_name(meta.name).to_python(skip_empty_area=False)
        except Exception as e:
            raise ParseError(f"Sheet '{meta.name}' couldn't be read ({e}).") from e
        rows = _trim([[_plain(v) for v in row] for row in raw])
        sheets.append(Sheet(meta.name, rows, hidden="hidden" in visible))
    return sheets


def _apply_openpyxl(data: bytes, sheets: list[Sheet]) -> None:
    """Fill merged ranges and find formulas without a saved result."""
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=False)
    except Exception:  # noqa: BLE001 - any parser error on untrusted bytes
        # Not readable by openpyxl (.xls, .ods...): the calamine parse stands.
        return
    by_name = {s.name: s for s in sheets}
    for ws in wb.worksheets:
        sheet = by_name.get(ws.title)
        if sheet is None:
            continue
        for rng in ws.merged_cells.ranges:
            r0, c0 = rng.min_row - 1, rng.min_col - 1
            if r0 >= len(sheet.rows):
                continue
            value = sheet.rows[r0][c0] if c0 < len(sheet.rows[r0]) else None
            if value is None:
                continue
            for r in range(r0, min(rng.max_row, len(sheet.rows))):
                row = sheet.rows[r]
                while len(row) < rng.max_col:
                    row.append(None)
                for c in range(c0, rng.max_col):
                    if row[c] is None:
                        row[c] = value
        for row in ws.iter_rows():
            for cell in row:
                if cell.data_type != "f":
                    continue
                r, c = cell.row - 1, cell.column - 1
                cached = (
                    sheet.rows[r][c]
                    if r < len(sheet.rows) and c < len(sheet.rows[r])
                    else None
                )
                if cached is None:
                    sheet.formula_gaps.append((r, c))
