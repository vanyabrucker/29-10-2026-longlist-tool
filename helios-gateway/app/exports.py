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

import pycountry
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.longlists import CONTACTS_KEY
from app.models import ListExport, ListExportCell, Longlist

MARK_SHEET = "_helios"
MARK_TITLE = "Helios export"
ID_HEADER = "Helios ID"


# ── Values as written ──────────────────────────────────────────────────────


def excel_value(value: Any, type_: str, scale: int = 1) -> tuple[Any, str | None]:
    """A cell's value for Excel and its number format: money stays a number
    with its currency in the format, locations and lists read as text. With a
    scale (1_000_000), money is written in millions ("12.3 EUR m")."""
    if value is None:
        return None, None
    if isinstance(value, list):
        return ", ".join(str(excel_value(v, type_)[0]) for v in value), None
    if isinstance(value, dict):
        if "amount" in value:
            currency = value.get("currency")
            if scale != 1 and isinstance(value["amount"], (int, float)):
                unit = f"{currency} m" if currency else "m"
                return value["amount"] / scale, f'#,##0.0 "{unit}"'
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


MILLIONS = 1_000_000

# The client export: a fixed set of columns for the client's eyes. Columns
# with a key are data points and come back on import like any export column
# (money in millions is scaled back); the others (`key` None) are worked out
# for reading only, or left empty until Helios holds the data, and are
# skipped on import.
CLIENT_COLUMNS: list[dict] = [
    {"label": "No.", "key": None, "type": "int", "show": "number"},
    {"label": "Country", "key": None, "type": "text", "show": "country"},
    {"label": "Logo", "key": None, "type": "text"},
    {"label": "Company Name", "key": "name", "type": "text"},
    {"label": "Business Description", "key": "description", "type": "long_text"},
    {"label": "Headquarter", "key": "hq", "type": "location"},
    {"label": "Homepage", "key": "website", "type": "url"},
    {"label": "Shareholders/Group", "key": "ownership_structure", "type": "long_text"},
    {"label": "Latest Account Date", "key": None, "type": "year", "show": "accounts_year"},
    {"label": "Sales in m", "key": "revenue", "type": "money", "scale": MILLIONS},
    {"label": "Gross Profit in m", "key": None, "type": "money"},
    {"label": "EBITDA Margin in %", "key": None, "type": "percent", "show": "ebitda_margin"},
    {"label": "No. of Employees", "key": "employee_count", "type": "int"},
    {"label": "Helbling Contact", "key": None, "type": "text", "show": "helbling_contact"},
]
# Data points the client export reads besides the list's own columns.
CLIENT_FIELDS = ["description", "hq", "website", "ownership_structure", "revenue",
                 "ebitda", "employee_count"]


def _country_name(code: str | None) -> str | None:
    if not code:
        return None
    hit = pycountry.countries.get(alpha_2=code)
    return hit.name if hit else code


CONTACT_PARTS = ("name", "role", "phone", "email", "relationship")


def contact_blocks(rows: list[dict]) -> list[dict]:
    """The columns that replace the Contacts column: one block of five per
    contact, as many blocks as the most contacts on any row. Display-only
    (`key` None), so an import never reads them back."""
    most = max((len((r["cells"].get(CONTACTS_KEY) or {}).get("contacts") or [])
                for r in rows), default=0)
    return [{"key": None, "label": f"Contact person {n} {part}", "type": "text",
             "contact": (n - 1, part)}
            for n in range(1, most + 1) for part in CONTACT_PARTS]


def _contact_part(contact: dict, part: str) -> str | None:
    if part == "role":
        role = contact["role"]
        return role.get("title") or role.get("function")
    if part == "relationship":
        return ", ".join(k["name"] for k in contact["known_by"]) or None
    return contact.get(part)


def _shown(how: str, number: int, cells: dict[str, dict],
           contacts: list[dict] | None = None) -> Any:
    """A display-only client column's value for one row."""
    if how == "number":
        return number
    if how == "helbling_contact":
        names = dict.fromkeys(k["name"] for c in contacts or [] for k in c["known_by"])
        return ", ".join(names) or None
    if how == "country":
        hq = (cells.get("hq") or {}).get("value")
        return _country_name(hq.get("country")) if isinstance(hq, dict) else None
    revenue = cells.get("revenue") or {}
    if how == "accounts_year":
        return revenue.get("period")
    if how == "ebitda_margin":
        ebitda = cells.get("ebitda") or {}
        r, e = revenue.get("value"), ebitda.get("value")
        if not (isinstance(r, dict) and isinstance(e, dict)) or not r.get("amount"):
            return None
        if revenue.get("period") != ebitda.get("period") or r.get("currency") != e.get("currency"):
            return None  # different years or currencies don't make a margin
        return round(100 * e["amount"] / r["amount"], 1)
    raise ValueError(how)


def export(session: Session, lst: Longlist, data: dict, user: str,
           client: bool = False, corpus: dict | None = None,
           contacts: dict[uuid.UUID, list[dict]] | None = None) -> bytes:
    """The .xlsx of the list table `data` (from `longlists.table`), recorded
    as an export with every written cell. `client` writes CLIENT_COLUMNS
    instead of the list's columns, reading facts the list doesn't show from
    `corpus` ({(company id, field): cell}, from `longlists.corpus_cells`) and
    the Helbling Contact column from `contacts` (company id → its contacts).
    The full export spreads the Contacts column into numbered blocks."""
    if client:
        columns = CLIENT_COLUMNS
    else:
        columns = []
        for c in data["columns"]:
            if c["key"] == CONTACTS_KEY:
                columns += contact_blocks(data["rows"])
            else:
                columns.append({"key": c["key"], "label": c["label"], "type": c["type"]})
    record = ListExport(id=uuid.uuid4(), list_id=lst.id, list_version=data["version"],
                        corpus_version=data["corpus_version"], exported_by=user,
                        columns=[{k: c[k] for k in ("key", "label", "type", "scale") if k in c}
                                 for c in columns],
                        rows=len(data["rows"]))
    session.add(record)
    session.flush()

    wb = Workbook()
    ws = wb.active
    ws.title = re.sub(r"[\[\]:*?/\\]", "", lst.name)[:31] or "Longlist"
    ws.append([c["label"] for c in columns] + [ID_HEADER])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    cells: list[dict] = []
    for number, row in enumerate(data["rows"], start=1):
        values, formats = [], []
        company_id = uuid.UUID(row["company_id"]) if row["company_id"] else None
        entry_id = uuid.UUID(row["id"])
        row_cells = dict(row["cells"])
        if client and company_id:
            for field in CLIENT_FIELDS:
                if field not in row_cells and (company_id, field) in (corpus or {}):
                    row_cells[field] = corpus[(company_id, field)]
        for c in columns:
            if c["key"] is None:
                if "contact" in c:
                    n, part = c["contact"]
                    people = (row_cells.get(CONTACTS_KEY) or {}).get("contacts") or []
                    raw = _contact_part(people[n], part) if n < len(people) else None
                elif "show" in c:
                    raw = _shown(c["show"], number, row_cells,
                                 (contacts or {}).get(company_id))
                else:
                    raw = None
                value, fmt = excel_value(raw, c["type"])
                if c.get("contact", (0, ""))[1] == "phone" and value is not None:
                    fmt = "@"  # text: a leading + or 0 must survive
                if c["type"] == "percent" and value is not None:
                    fmt = "0.0"
            else:
                raw = (row_cells.get(c["key"]) or {}).get("value")
                value, fmt = excel_value(raw, c["type"], c.get("scale", 1))
                # Recorded unscaled: an import scales the file's value back first.
                cells.append({"export_id": record.id, "entry_id": entry_id,
                              "company_id": company_id, "key": c["key"],
                              "value": written(raw, c["type"])})
            values.append(value)
            formats.append(fmt)
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
            60 if c["type"] == "long_text" else 32 if c["key"] == "name"
            else 8 if c["label"] == "No." else 18)
    id_letter = get_column_letter(len(columns) + 1)
    ws.column_dimensions[id_letter].hidden = True
    ws.column_dimensions[id_letter].width = 38
    name_col = next((i for i, c in enumerate(columns, start=1) if c["key"] == "name"), 1)
    ws.freeze_panes = f"{get_column_letter(name_col + 1)}2"
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
