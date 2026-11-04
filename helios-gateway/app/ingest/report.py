"""The review report shown before an import is committed.

For every data row: its normalised values (or errors), which company and
person it is (new, or a match with its level), duplicates within the file, and
whether each incoming value would become the shown value (its quality score
against the current winner's). Plus totals, unmapped columns and quality.
"""

import uuid
from collections import Counter
from datetime import date
from typing import Any

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import llm
from app.catalogue import CATALOGUE
from app.ingest.mapping import samples
from app.ingest.match import Index, build_index, norm_id, norm_name, person_name
from app.ingest.normalize import Invalid, is_empty, normalize, split_name
from app.models import CurrentValue, Import, Observation, RawRow, SourceType, Version
from app.quality import level, score

CHILD_KINDS = ("role", "transaction", "project_ref", "list_entry")


class _EnumFix(BaseModel):
    mapping: dict[str, str | None]


def _enum_fixes(table: dict, rows: list[list[Any]]) -> dict[str, dict[str, str | None]]:
    """Ask the LLM to map enum values our rules didn't recognise, per column."""
    fixes: dict[str, dict[str, str | None]] = {}
    for col in table["columns"]:
        point = CATALOGUE.get(col.get("field") or "")
        if not point or point.type != "enum":
            continue
        unknown: set[str] = set()
        for row in rows:
            raw = row[col["index"]] if col["index"] < len(row) else None
            if is_empty(raw):
                continue
            try:
                normalize(point, raw)
            except Invalid:
                parts = [raw] if not point.many else str(raw).replace(";", ",").split(",")
                unknown.update(str(p).strip() for p in parts if str(p).strip())
        if not unknown or len(unknown) > 60:
            continue
        try:
            answer = llm.ask(
                _EnumFix,
                "Map each value to exactly one of the allowed options, or null if "
                "none fits. Answer with JSON: {\"mapping\": {value: option|null}}.",
                f"Data point: {point.label} — {point.description}\n"
                f"Allowed options: {list(point.options)}\n"
                f"Values: {sorted(unknown)}",
            )
        except llm.LLMError:
            continue
        fixes[col["letter"]] = {
            k: v for k, v in answer.mapping.items() if v is None or v in point.options
        }
    return fixes


def _normalize_cell(point, raw: Any, fixes: dict[str, str | None]) -> Any:
    try:
        return normalize(point, raw)
    except Invalid:
        if point.type != "enum" or not fixes:
            raise
        parts = [raw] if not point.many else str(raw).replace(";", ",").split(",")
        out = []
        for p in parts:
            p = str(p).strip()
            if not p:
                continue
            fixed = fixes.get(p)
            if fixed is None:
                raise
            out.append(fixed)
        return out if point.many else out[0]


def _key(company: dict) -> str | None:
    """Identity of a company within one file, to spot duplicate rows."""
    for k in ("registry_id", "capiq_id", "orbis_id"):
        if company.get(k):
            return f"{k}:{norm_id(company[k])}"
    if company.get("website"):
        return f"web:{company['website']}"
    name = company.get("name") or company.get("legal_name")
    if name:
        return f"name:{norm_name(name)}:{(company.get('hq') or {}).get('country') or ''}"
    return None


def _existing_scores(
    session: Session, entity_ids: set[str]
) -> dict[tuple[str, str, int], tuple[float, Any]]:
    if not entity_ids:
        return {}
    rows = session.execute(
        select(CurrentValue.entity_id, CurrentValue.field, CurrentValue.period,
               CurrentValue.score, Observation.value)
        .join(Observation, Observation.id == CurrentValue.observation_id)
        .where(CurrentValue.entity_id.in_([uuid.UUID(e) for e in entity_ids]))
    ).all()
    return {(str(e), f, p): (s, v.get("v")) for e, f, p, s, v in rows}


def build(session: Session, imp: Import, progress=None) -> dict:
    confidence = session.get(SourceType, imp.source_type).confidence
    as_of: date | None = imp.as_of
    index: Index = build_index(session)
    base_version = session.scalar(select(func.max(Version.id))) or 0

    raw_by_table: dict[int, list[RawRow]] = {}
    for rr in session.scalars(
        select(RawRow).where(RawRow.import_id == imp.id).order_by(RawRow.id)
    ):
        raw_by_table.setdefault(rr.table_index, []).append(rr)

    rows_out: list[dict] = []
    unmapped: list[dict] = []
    enum_fixes: dict[int, dict] = {}
    seen: dict[str, str] = {}
    included = [(i, t) for i, t in enumerate(imp.tables) if t.get("include")]
    for n, (ti, table) in enumerate(included):
        raw_rows = raw_by_table.get(ti, [])
        cells_only = [r.cells for r in raw_rows]
        enum_fixes[ti] = _enum_fixes(table, cells_only)
        for col in table["columns"]:
            if not col.get("field"):
                unmapped.append({
                    "table": ti, "sheet": table["sheet"], "letter": col["letter"],
                    "header": col["header"], "samples": samples(cells_only, col["index"], 4),
                })
        for rr in raw_rows:
            rows_out.append(
                _row(ti, table, rr, enum_fixes[ti], index, seen, confidence, as_of)
            )
        if progress:
            progress(0.2 + 0.6 * (n + 1) / max(1, len(included)), f"Checked {table['sheet']}")

    # Compare incoming values with the current winners of matched records.
    matched = {
        r["company"]["match"]["entity_id"]
        for r in rows_out if r["company"] and r["company"]["match"]["entity_id"]
    } | {
        r["person"]["match"]["entity_id"]
        for r in rows_out if r["person"] and r["person"]["match"]["entity_id"]
    }
    existing = _existing_scores(session, matched)
    value_stats: Counter = Counter()
    quality_stats: Counter = Counter()
    for r in rows_out:
        for cell in r["cells"]:
            if cell.get("error") or cell["entity"] not in ("company", "person"):
                continue
            quality_stats[level(cell["score"])] += 1
            target = r[cell["entity"]]["match"]["entity_id"] if r.get(cell["entity"]) else None
            current = existing.get((target, cell["field"], cell.get("period") or 0)) if target else None
            if current is None:
                cell["vs"] = "new"
            elif current[1] == cell["value"]:
                cell["vs"] = "same"
            else:
                cell["vs"] = "wins" if cell["score"] > current[0] else "loses"
                cell["current"] = current[1]
                cell["current_score"] = current[0]
            value_stats[cell["vs"]] += 1

    companies = Counter(
        ("duplicate" if r["duplicate_of"] else r["company"]["match"]["level"])
        for r in rows_out if r["company"]
    )
    people = Counter(r["person"]["match"]["level"] for r in rows_out if r["person"])
    formula_gaps = [
        {"sheet": t["sheet"], "cells": t.get("formula_gaps", [])}
        for t in imp.tables if t.get("include") and t.get("formula_gaps")
    ]
    return {
        "base_version": base_version,
        "summary": {
            "rows": len(rows_out),
            "rows_with_errors": sum(1 for r in rows_out if r["errors"]),
            "rows_skipped": sum(1 for r in rows_out if r["decision"] == "skip"),
            "companies": dict(companies),
            "people": dict(people),
            "values": dict(value_stats),
            "quality": dict(quality_stats),
        },
        "unmapped_columns": unmapped,
        "formula_gaps": formula_gaps,
        "rows": rows_out,
    }


def _row(ti, table, rr: RawRow, fixes, index: Index, seen, confidence, as_of) -> dict:
    key = f"t{ti}:r{rr.row_number}"
    values: dict[str, dict] = {k: {} for k in ("company", "person", *CHILD_KINDS)}
    cells: list[dict] = []
    errors: list[str] = []
    for col in table["columns"]:
        field = col.get("field")
        if not field:
            continue
        point = CATALOGUE[field]
        raw = rr.cells[col["index"]] if col["index"] < len(rr.cells) else None
        if is_empty(raw):
            continue
        cell = {"letter": col["letter"], "field": field, "entity": point.entity,
                "raw": str(raw), "period": col.get("period")}
        try:
            cell["value"] = _normalize_cell(point, raw, fixes.get(col["letter"], {}))
            cell["score"] = score(confidence, field, as_of)
            values[point.entity][field] = cell["value"]
        except Invalid as e:
            cell["error"] = str(e)
            errors.append(f"{col['letter']} ({point.label}): {e}")
        cells.append(cell)

    person = values["person"]
    if "full_name" in person and not ("first_name" in person or "last_name" in person):
        first, last = split_name(person["full_name"])
        person.update({"first_name": first or None, "last_name": last})
        cells += [
            {"letter": next(c["letter"] for c in cells if c["field"] == "full_name"),
             "field": f, "entity": "person", "raw": person["full_name"], "value": v,
             "score": score(confidence, f, as_of), "derived": True}
            for f, v in (("first_name", first), ("last_name", last)) if v
        ]
    company = values["company"]
    if company.get("investor_type") and "buyer_category" not in company:
        category = "Strategic" if company["investor_type"] == "Strategic Investor" else "Financial"
        company["buyer_category"] = category
        cells.append({"letter": next(c["letter"] for c in cells if c["field"] == "investor_type"),
                      "field": "buyer_category", "entity": "company", "raw": company["investor_type"],
                      "value": category, "score": score(confidence, "buyer_category", as_of),
                      "derived": True})

    has_company = bool(company) or any(values[k] for k in CHILD_KINDS if k != "role")
    company_out = None
    duplicate_of = None
    if has_company:
        if not (company.get("name") or company.get("legal_name") or _key(company)):
            errors.append("No company name or identifier in this row.")
        match = index.match_company(company)
        k = _key(company)
        if k and k in seen and match.level != "certain":
            duplicate_of = seen[k]
        elif k:
            seen[k] = key
        company_out = {"label": company.get("name") or company.get("legal_name"),
                       "match": vars(match)}
    person_out = None
    if person:
        company_id = company_out["match"]["entity_id"] if company_out else None
        match = index.match_person(person, company_id)
        person_out = {"label": person_name(person), "match": vars(match)}
        if not person_name(person) and not person.get("email"):
            errors.append("Contact without a name or email.")

    blocking = any(e.startswith(("No company", "Contact without")) for e in errors)
    if blocking or not (company_out or person_out):
        decision = "skip"
    elif duplicate_of:
        decision = f"dup:{duplicate_of}"
    elif company_out and company_out["match"]["level"] in ("certain", "likely"):
        decision = company_out["match"]["entity_id"]
    else:
        decision = "new"
    return {
        "key": key, "table": ti, "sheet": table["sheet"], "row": rr.row_number,
        "company": company_out, "person": person_out, "duplicate_of": duplicate_of,
        "cells": cells, "errors": errors, "decision": decision,
    }
