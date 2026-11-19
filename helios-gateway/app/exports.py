"""List exports that imports can trace back.

Every export is recorded (`list_exports`) with a snapshot of each cell as it
was written to Excel (`list_export_cells`). The workbook carries the export
id, signed with `EXPORT_SECRET` (HMAC-SHA256), on a very hidden `_helios`
sheet, and each row's entry id in a hidden "Helios ID" column at the end
(inside the autofilter range, so it moves with the row when the user sorts).

A file that comes back with a valid mark is diffed three ways per cell
(exported vs file vs the list now); without one, rows are matched by company
and a value we exported before counts as unchanged. Values are compared as
written, so 1'200'000 "EUR" in Excel equals the 1200000 the file reads back.
"""

import hashlib
import hmac
import io
import re
import uuid
from datetime import date, datetime
from pathlib import PurePath
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ListExport, ListExportCell, Longlist

MARK_SHEET = "_helios"
MARK_TITLE = "Helios export"
ID_HEADER = "Helios ID"


# ── Values as written ──────────────────────────────────────────────────────


def excel_value(value: Any, type_: str) -> tuple[Any, str | None]:
    """A cell's value for Excel and its number format: money stays a number
    with its currency in the format, locations and lists read as text."""
    if value is None:
        return None, None
    if isinstance(value, list):
        return ", ".join(str(excel_value(v, type_)[0]) for v in value), None
    if isinstance(value, dict):
        if "amount" in value:
            currency = value.get("currency")
            return value["amount"], f'#,##0 "{currency}"' if currency else "#,##0"
        if "date" in value:
            try:
                return date.fromisoformat(str(value["date"])[:10]), "yyyy-mm-dd"
            except ValueError:
                return str(value["date"]), None
        if "city" in value or "country" in value:
            return ", ".join(str(value[k]) for k in ("city", "region", "country")
                             if value.get(k)), None
        return str(value), None
    if isinstance(value, bool):
        return ("Yes" if value else "No"), None
    if type_ == "percent" and isinstance(value, (int, float)):
        return value, "0"
    if isinstance(value, (int, float)):
        return value, None if type_ == "year" else "#,##0"
    return str(value), None


def written(value: Any, type_: str) -> Any:
    """The JSON-safe value an export writes for a normalised value."""
    v, _ = excel_value(value, type_)
    if isinstance(v, (date, datetime)):
        return v.isoformat()[:10]
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        return int(v)
    return v


_NUMBER = re.compile(r"^-?[\d'’,. ]*\d[\d'’,. ]*$")


def _canon(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, float)):
        return round(float(v), 6)
    if isinstance(v, (date, datetime)):
        return v.isoformat()[:10]
    s = re.sub(r"\s+", " ", str(v)).strip()
    if not s:
        return None
    if _NUMBER.match(s) and not re.match(r"^\d{4}-\d{2}-\d{2}", s):
        try:
            return round(float(re.sub(r"['’ ,]", "", s)), 6)
        except ValueError:
            pass
    if re.match(r"^\d{4}-\d{2}-\d{2}(T00:00(:00)?)?$", s):
        return s[:10]
    return s


def same(a: Any, b: Any) -> bool:
    """Two cells as written are the same value (numbers by value, text with
    whitespace collapsed, dates by day)."""
    return _canon(a) == _canon(b)


def empty(v: Any) -> bool:
    return _canon(v) is None


# ── The signed mark ────────────────────────────────────────────────────────


def _mac(export_id: uuid.UUID) -> str:
    secret = (settings().export_secret or "").encode()
    return hmac.new(secret, str(export_id).encode(), hashlib.sha256).hexdigest()[:32]


def sign(export_id: uuid.UUID) -> str:
    return f"{export_id}.{_mac(export_id)}"


def verify(token: str | None) -> uuid.UUID | None:
    """The export id, if the token was signed by this gateway."""
    if not token or "." not in token:
        return None
    raw, mac = str(token).strip().rsplit(".", 1)
    try:
        export_id = uuid.UUID(raw)
    except ValueError:
        return None
    return export_id if hmac.compare_digest(mac, _mac(export_id)) else None


def read_mark(filename: str, data: bytes) -> str | None:
    """The token on the `_helios` sheet of an .xlsx/.xlsm, if there is one
    (None for other formats: a CSV or an .xls can't carry it)."""
    if PurePath(filename).suffix.lower() not in (".xlsx", ".xlsm"):
        return None
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception:  # noqa: BLE001 - any parser error on untrusted bytes
        return None
    try:
        if MARK_SHEET not in wb.sheetnames:
            return None
        for row in wb[MARK_SHEET].iter_rows(min_row=1, max_row=5, max_col=2,
                                           values_only=True):
            for v in row:
                if isinstance(v, str) and v.count(".") == 1 and len(v) > 40:
                    return v
        return None
    finally:
        wb.close()


# ── Writing an export ──────────────────────────────────────────────────────


def export(session: Session, lst: Longlist, data: dict, user: str) -> bytes:
    """The .xlsx of the list table `data` (from `longlists.table`), recorded
    as an export with every written cell."""
    record = ListExport(id=uuid.uuid4(), list_id=lst.id, list_version=data["version"],
                        corpus_version=data["corpus_version"], exported_by=user,
                        columns=[{"key": c["key"], "label": c["label"], "type": c["type"]}
                                 for c in data["columns"]],
                        rows=len(data["rows"]))
    session.add(record)
    session.flush()

    wb = Workbook()
    ws = wb.active
    ws.title = re.sub(r"[\[\]:*?/\\]", "", lst.name)[:31] or "Longlist"
    columns = data["columns"]
    ws.append([c["label"] for c in columns] + [ID_HEADER])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    cells: list[dict] = []
    for row in data["rows"]:
        values, formats = [], []
        company_id = uuid.UUID(row["company_id"]) if row["company_id"] else None
        entry_id = uuid.UUID(row["id"])
        for c in columns:
            raw = (row["cells"].get(c["key"]) or {}).get("value")
            value, fmt = excel_value(raw, c["type"])
            values.append(value)
            formats.append(fmt)
            cells.append({"export_id": record.id, "entry_id": entry_id,
                          "company_id": company_id, "key": c["key"],
                          "value": written(raw, c["type"])})
        ws.append([*values, row["id"]])
        for cell, fmt in zip(ws[ws.max_row], formats, strict=False):
            if fmt:
                cell.number_format = fmt
            if isinstance(cell.value, str) and len(cell.value) > 60:
                cell.alignment = Alignment(wrap_text=True, vertical="top")
    if cells:
        session.execute(ListExportCell.__table__.insert(), cells)
    for i, c in enumerate(columns, start=1):
        ws.column_dimensions[get_column_letter(i)].width = (
            60 if c["type"] == "long_text" else 32 if c["key"] == "name" else 18)
    id_letter = get_column_letter(len(columns) + 1)
    ws.column_dimensions[id_letter].hidden = True
    ws.column_dimensions[id_letter].width = 38
    ws.freeze_panes = "B2"
    # The filter range includes the hidden id column, so sorting moves it.
    ws.auto_filter.ref = f"A1:{id_letter}{max(1, ws.max_row)}"

    mark = wb.create_sheet(MARK_SHEET)
    mark["A1"] = MARK_TITLE
    mark["A2"] = sign(record.id)
    mark["A3"] = "Lets Helios recognise this file when it is imported again."
    mark.sheet_state = "veryHidden"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ── Reading exports back ───────────────────────────────────────────────────


def snapshot(session: Session, export_id: uuid.UUID) -> dict[uuid.UUID, dict[str, Any]]:
    """{entry id: {column key: value as written}} of one export."""
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for entry_id, key, value in session.execute(
            select(ListExportCell.entry_id, ListExportCell.key, ListExportCell.value)
            .where(ListExportCell.export_id == export_id)):
        out.setdefault(entry_id, {})[key] = value
    return out


def exported_before(session: Session, company_ids: set[uuid.UUID],
                    entry_ids: set[uuid.UUID]) -> dict[tuple[str, str], list[Any]]:
    """Every value any export wrote, per (company id or entry id, key): a
    file value equal to one of them is an old copy of ours, not new data."""
    out: dict[tuple[str, str], list[Any]] = {}
    if company_ids:
        for company_id, key, value in session.execute(
                select(ListExportCell.company_id, ListExportCell.key, ListExportCell.value)
                .where(ListExportCell.company_id.in_(company_ids)).distinct()):
            out.setdefault((str(company_id), key), []).append(value)
    if entry_ids:
        for entry_id, key, value in session.execute(
                select(ListExportCell.entry_id, ListExportCell.key, ListExportCell.value)
                .where(ListExportCell.entry_id.in_(entry_ids)).distinct()):
            out.setdefault((str(entry_id), key), []).append(value)
    return out
