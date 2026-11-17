"""Company search: one `company_search` row per company with its shown values
and a weighted tsvector, kept current by `values.recompute` (so in the same
transaction as every import commit, pin and revert).

A query matches word prefixes in the tsvector (name and website weigh most,
then sector and headquarters, then the description) or a fuzzy trigram match
on the name, so typos still find the company. Sorting and paging run in SQL.
"""

import re
import uuid
from collections.abc import Iterable
from typing import Literal

from sqlalchemy import Connection, text
from sqlalchemy.orm import Session

# The shown values pivoted into columns; shared with the migration's backfill
# (which keeps its own frozen copy). Revenue is the latest fiscal year.
SELECT_ROWS = """
SELECT e.id, v.name, v.website, v.sector, v.hq, v.description, v.revenue, v.employees,
  setweight(to_tsvector('simple', coalesce(v.name, '')), 'A')
  || setweight(to_tsvector('simple', coalesce(v.website, '')), 'A')
  || setweight(to_tsvector('simple', coalesce(v.sector, '') || ' ' || coalesce(v.hq, '')), 'B')
  || setweight(to_tsvector('simple', coalesce(v.description, '')), 'C')
FROM entities e
CROSS JOIN LATERAL (
  SELECT
    max(CASE WHEN cv.field = 'name' THEN o.value->>'v' END) AS name,
    max(CASE WHEN cv.field = 'website' THEN o.value->>'v' END) AS website,
    max(CASE WHEN cv.field = 'sector' THEN o.value->>'v' END) AS sector,
    max(CASE WHEN cv.field = 'hq' THEN concat_ws(', ', o.value->'v'->>'city',
        o.value->'v'->>'region', o.value->'v'->>'country') END) AS hq,
    max(CASE WHEN cv.field = 'description' THEN o.value->>'v' END) AS description,
    (array_agg((o.value->'v'->>'amount')::float ORDER BY cv.period DESC)
      FILTER (WHERE cv.field = 'revenue'))[1] AS revenue,
    max(CASE WHEN cv.field = 'employee_count' THEN (o.value->>'v')::numeric END)::bigint
      AS employees
  FROM current_values cv JOIN observations o ON o.id = cv.observation_id
  WHERE cv.entity_id = e.id
) v
WHERE e.kind = 'company'
"""

INSERT = """
INSERT INTO company_search
  (entity_id, name, website, sector, hq, description, revenue, employees, document)
"""


def refresh(session: Session, entity_ids: Iterable[uuid.UUID]) -> None:
    """Rebuild the search rows of these entities (non-companies are ignored)."""
    ids = list(entity_ids)
    if not ids:
        return
    session.execute(text("DELETE FROM company_search WHERE entity_id = ANY(:ids)"),
                    {"ids": ids})
    session.execute(text(INSERT + SELECT_ROWS + " AND e.id = ANY(:ids)"), {"ids": ids})


def refresh_all(conn: Connection | Session) -> None:
    conn.execute(text("DELETE FROM company_search"))
    conn.execute(text(INSERT + SELECT_ROWS))


Sort = Literal["relevance", "name", "website", "hq", "sector", "revenue", "employees"]
SORT_COLUMNS = {"name": "lower(name)", "website": "website", "hq": "lower(hq)",
                "sector": "lower(sector)", "revenue": "revenue", "employees": "employees"}


def prefix_query(q: str) -> str | None:
    """'isar cap' → 'isar:* & cap:*' (only letters and digits, so user input
    can't inject tsquery syntax)."""
    words = [w for w in re.split(r"[^\w]+", q.lower()) if w]
    return " & ".join(f"{w}:*" for w in words) or None


def search(session: Session, q: str | None, sort: Sort, descending: bool,
           offset: int, limit: int) -> tuple[int, list[uuid.UUID]]:
    """Total matches and one page of company ids."""
    q = (q or "").strip()
    params: dict = {"limit": limit, "offset": offset}
    where = "TRUE"
    rank = "0"
    if q:
        params.update(q=q.lower(), tsq=prefix_query(q) or "")
        # Prefix words anywhere (name, website, sector, HQ, description), the
        # website as typed, or a fuzzy match on the name (pg_trgm thresholds).
        where = ("(document @@ to_tsquery('simple', :tsq)"
                 " OR website LIKE :q || '%'"
                 " OR lower(name) % :q OR :q <% lower(name))")
        rank = ("(ts_rank(document, to_tsquery('simple', :tsq))"
                " + word_similarity(:q, lower(coalesce(name, '')))"
                " + CASE WHEN lower(name) LIKE :q || '%' THEN 1 ELSE 0 END)")
    if sort == "relevance" and not q:
        sort = "name"
    if sort == "relevance":
        order = f"{rank} DESC, lower(name)"
    else:
        direction = "DESC" if descending else "ASC"
        order = f"{SORT_COLUMNS[sort]} {direction} NULLS LAST, lower(name), entity_id"
    total = session.execute(text(f"SELECT count(*) FROM company_search WHERE {where}"),
                            params).scalar_one()
    ids = session.execute(text(
        f"SELECT entity_id FROM company_search WHERE {where} "
        f"ORDER BY {order} LIMIT :limit OFFSET :offset"), params).scalars().all()
    return total, list(ids)
