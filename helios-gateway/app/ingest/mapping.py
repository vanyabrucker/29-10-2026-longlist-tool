"""Map a table's columns to catalogue data points with the LLM.

The LLM sees each column's header and sample values plus the catalogue, and
proposes a data point (or none) per column with a confidence and a reason.
The dev always confirms; free-text feedback re-runs this with the feedback and
the current mapping included.
"""

import re
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from app import llm
from app.catalogue import CATALOGUE, MAPPABLE, as_prompt
from app.ingest import transforms as tf

SAMPLES = 8


class ColumnMapping(BaseModel):
    letter: str = Field(description="Column letter, e.g. 'C'")
    field: str | None = Field(description="Catalogue key, or null if none fits")
    period: int | None = Field(
        default=None, description="Fiscal year for per-year data points"
    )
    confidence: float = Field(ge=0, le=1)
    reason: str = ""
    transforms: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Transformations of this column's cells, in order (see the menu)",
    )


class TableMapping(BaseModel):
    columns: list[ColumnMapping]
    notes: str = ""


_SYSTEM = (
    "You map spreadsheet columns to a fixed catalogue of data points for an M&A "
    "buyer database. Use only catalogue keys; use null when no data point fits "
    "(do not force a match). Each key may be used for at most one column, except "
    "per-year data points (e.g. revenue), which may be used once per fiscal year "
    "with `period` set. Columns about people (contacts) map to person/role data "
    "points; fit scores and inclusion rationales for a specific mandate map to "
    "list_entry data points. Give a confidence from 0 to 1 and a short reason.\n"
    "Only when the samples show the need, a column may carry `transforms`, applied "
    "in order to its cells before they are read:\n"
    "- {\"kind\": \"empty_values\", \"values\": [\"0\"]}: these texts mean unknown "
    "(e.g. a founding year of 0).\n"
    "- {\"kind\": \"combine\", \"columns\": [\"H\", \"A\"], \"separator\": \", \"}: "
    "append the cells of other columns (by letter) to this one. Use it when a place "
    "is split over columns (city, region, country): put it on the column mapped to "
    "the location data point and map the other columns to nothing.\n"
    "- {\"kind\": \"scale\", \"factor\": 1000}: only on a column mapped to numbers or "
    "money, when the header says the figures are in thousands (factor 1000) or "
    "millions (factor 1000000).\n"
    "Leave `transforms` empty otherwise.\n"
    "Answer with JSON: {\"columns\": [{\"letter\": str, \"field\": str|null, "
    "\"period\": int|null, \"confidence\": float, \"reason\": str, "
    "\"transforms\": []}], \"notes\": str}.\n\nCatalogue:\n"
)


def samples(rows: list[list[Any]], col: int, n: int = SAMPLES) -> list[str]:
    seen: list[str] = []
    for row in rows:
        v = row[col] if col < len(row) else None
        if v is None:
            continue
        text = str(v)[:80]
        if text not in seen:
            seen.append(text)
        if len(seen) >= n:
            break
    return seen


def _year_in(header: str) -> int | None:
    m = re.search(r"(?:FY\s?)?(19[89]\d|20\d\d)", header)
    return int(m.group(1)) if m else None


def propose(
    table: dict,
    rows: list[list[Any]],
    filename: str,
    feedback: list[str],
) -> tuple[list[dict], str]:
    """Mapped columns for the table (merged into its column specs) and notes."""
    lines = []
    for c in table["columns"]:
        sample = ", ".join(repr(s) for s in samples(rows, c["index"]))
        current = (
            f" (currently mapped to {c['field']})" if c.get("field") else ""
        )
        lines.append(f"{c['letter']}: header {c['header']!r}{current}; samples: "
                     f"{sample or '(empty)'}")
    user = (
        f"File: {filename}\nSheet: {table['sheet']}\n"
        f"Title above the table: {table.get('title') or '(none)'}\n\n"
        "Columns:\n" + "\n".join(lines)
    )
    if feedback:
        user += "\n\nFeedback from the reviewer (follow it):\n" + "\n".join(
            f"- {f}" for f in feedback
        )
    answer = llm.ask(TableMapping, _SYSTEM + as_prompt(), user)
    return apply(table["columns"], answer), answer.notes


def apply(columns: list[dict], answer: TableMapping) -> list[dict]:
    """Merge the LLM's answer into the column specs, dropping unknown keys and
    keeping each non-periodic key on one column only (the most confident)."""
    by_letter = {m.letter.upper(): m for m in answer.columns}
    letters = {c["letter"]: c["index"] for c in columns if "index" in c}
    out = []
    for c in columns:
        m = by_letter.get(c["letter"])
        field = m.field if m and m.field in MAPPABLE else None
        period = None
        if field and CATALOGUE[field].periodic:
            period = (m.period if m else None) or _year_in(c["header"])
        out.append(
            {
                **c,
                "field": field,
                "period": period,
                "confidence": round(m.confidence, 2) if m and field else None,
                "reason": (m.reason if m else "") or "",
                "suggested_field": field,
                "transforms": m.transforms if m else [],
            }
        )
    best: dict[tuple, dict] = {}
    for c in out:
        if not c["field"]:
            continue
        key = (c["field"], c["period"])
        if key in best and (best[key]["confidence"] or 0) >= (c["confidence"] or 0):
            c["reason"] = f"{c['reason']} (also suggested for column {best[key]['letter']})"
            c["field"] = None
            continue
        if key in best:
            best[key]["field"] = None
        best[key] = c
    # Judged against the field each column ended up with.
    for c in out:
        c["transforms"] = _valid_transforms(c["transforms"], letters, c["letter"],
                                            c["field"])
    return out


def _valid_transforms(raw: list[dict], letters: dict[str, int], own: str,
                      field: str | None) -> list[dict]:
    """The suggested transforms that parse and fit the table and the column's
    field (scaling only on numbers and money, so not on an unmapped column);
    each is judged on its own, so one bad suggestion doesn't drop the others.
    The model may write letters in lower case, as the column letters it maps."""
    kept = []
    for item in raw:
        if isinstance(item, dict) and isinstance(item.get("columns"), list):
            item = {**item, "columns": [str(x).strip().upper() for x in item["columns"]]}
        try:
            parsed = tf.parse([item])
            tf.check(parsed, letters, own, field)
        except (ValidationError, ValueError):
            continue
        if isinstance(parsed[0], tf.Scale) and not tf.scalable(field):
            continue
        kept.append(parsed[0].model_dump())
        if len(kept) == tf.MAX_PER_COLUMN:
            break
    return kept
