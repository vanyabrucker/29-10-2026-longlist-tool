"""Company search: one `company_search` row per company with its shown values,
the columns structured filters need, a weighted tsvector and the text it is
embedded from. `values.recompute` keeps it current (same transaction as every
import commit, pin and revert); vectors follow right after commit
(`app/embeddings.py`).

Ranking is hybrid. Two retrievers run over the rows that pass the filters:
- **keywords:** word prefixes in the tsvector (name and website weigh most,
  then sector, sub-sector, HQ and keywords, then description and offerings),
  the website as typed, or a fuzzy trigram match on the name (typos);
- **vectors:** cosine similarity between the query's embedding and each
  company's (pgvector HNSW): of the nearest `VECTOR_K`, those within
  `VECTOR_MARGIN` of the best match and above `MIN_SIMILARITY`. Business
  texts all look somewhat alike to embedding models, so an absolute cutoff
  keeps most of the corpus; relevant hits sit close to the best one (tuned
  on evals/search_queries.json: Qwen3-Embedding-0.6B with the company
  instruction needs a margin of 0.15 for recall 0.99, text-embedding-3-large
  reaches it from 0.10; both are flat for MIN_SIMILARITY 0.20-0.45).
They are fused by reciprocal rank (RRF, k=60). Exact name or website hits come
first, then names starting with the query, then the fused order. If the query
can't be embedded (provider down), search runs on keywords alone.

Filters (HQ country, sector words, buyer category, investor type, revenue and
employee ranges) are SQL conditions on both retrievers, and with no query
they list every company that passes. Revenue ranges compare across
currencies with fixed approximate rates (see `app/regions.py`).
"""

import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

from sqlalchemy import Connection, text
from sqlalchemy.orm import Session

from app import embeddings, llm
from app.regions import APPROX_EUR_PER_UNIT

# The shown values pivoted into columns, plus the embedding text; the
# migration that added each column backfills with its own frozen copy.
# Revenue is the latest fiscal year, in its own currency.
SELECT_ROWS = """
SELECT e.id, v.name, v.website, v.sector, v.sub_sector, v.hq, v.country, v.description,
  v.revenue, v.revenue_currency, v.employees_low,
  v.employees_high, v.buyer_category, v.investor_type,
  nullif(concat_ws(E'\\n',
    v.name,
    CASE WHEN v.legal_name IS DISTINCT FROM v.name THEN v.legal_name END,
    'Sector: ' || nullif(concat_ws(' / ', v.sector, v.sub_sector), ''),
    'Keywords: ' || v.industry_keywords,
    'Buyer: ' || nullif(concat_ws(', ', v.buyer_category, v.investor_type,
      v.owner_type), ''),
    'Business: ' || nullif(concat_ws(', ', v.value_chain_position, v.end_market), ''),
    'Headquarters: ' || nullif(v.hq, ''),
    v.description,
    'Products: ' || v.products,
    'Services: ' || v.services,
    'Business units: ' || v.business_units,
    'Investment focus: ' || v.investment_focus), ''),
  setweight(to_tsvector('simple', coalesce(v.name, '')), 'A')
  || setweight(to_tsvector('simple', coalesce(v.website, '')), 'A')
  || setweight(to_tsvector('simple', concat_ws(' ', v.sector, v.sub_sector, v.hq,
       v.industry_keywords)), 'B')
  || setweight(to_tsvector('simple', concat_ws(' ', v.description, v.products,
       v.services, v.investment_focus)), 'C')
FROM entities e
CROSS JOIN LATERAL (
  SELECT
    max(CASE WHEN cv.field = 'name' THEN t.txt END) AS name,
    max(CASE WHEN cv.field = 'legal_name' THEN t.txt END) AS legal_name,
    max(CASE WHEN cv.field = 'website' THEN t.txt END) AS website,
    max(CASE WHEN cv.field = 'sector' THEN t.txt END) AS sector,
    max(CASE WHEN cv.field = 'sub_sector' THEN t.txt END) AS sub_sector,
    max(CASE WHEN cv.field = 'industry_keywords' THEN t.txt END) AS industry_keywords,
    max(CASE WHEN cv.field = 'buyer_category' THEN t.txt END) AS buyer_category,
    max(CASE WHEN cv.field = 'investor_type' THEN t.txt END) AS investor_type,
    max(CASE WHEN cv.field = 'owner_type' THEN t.txt END) AS owner_type,
    max(CASE WHEN cv.field = 'value_chain_position' THEN t.txt END)
      AS value_chain_position,
    max(CASE WHEN cv.field = 'end_market' THEN t.txt END) AS end_market,
    max(CASE WHEN cv.field = 'products' THEN t.txt END) AS products,
    max(CASE WHEN cv.field = 'services' THEN t.txt END) AS services,
    max(CASE WHEN cv.field = 'business_units' THEN t.txt END) AS business_units,
    max(CASE WHEN cv.field = 'investment_focus' THEN t.txt END) AS investment_focus,
    max(CASE WHEN cv.field = 'hq' THEN concat_ws(', ', o.value->'v'->>'city',
        o.value->'v'->>'region', o.value->'v'->>'country') END) AS hq,
    max(CASE WHEN cv.field = 'hq' THEN o.value->'v'->>'country' END) AS country,
    max(CASE WHEN cv.field = 'description' THEN t.txt END) AS description,
    (array_agg((o.value->'v'->>'amount')::float ORDER BY cv.period DESC)
      FILTER (WHERE cv.field = 'revenue'))[1] AS revenue,
    (array_agg(o.value->'v'->>'currency' ORDER BY cv.period DESC)
      FILTER (WHERE cv.field = 'revenue'))[1] AS revenue_currency,
    max(CASE WHEN cv.field = 'employee_count' THEN (o.value->'v'->>'low')::bigint END)
      AS employees_low,
    max(CASE WHEN cv.field = 'employee_count' THEN (o.value->'v'->>'high')::bigint END)
      AS employees_high
  FROM current_values cv
  JOIN observations o ON o.id = cv.observation_id
  CROSS JOIN LATERAL (SELECT CASE jsonb_typeof(o.value->'v')
      WHEN 'array' THEN (SELECT string_agg(x, ', ')
                         FROM jsonb_array_elements_text(o.value->'v') x)
      WHEN 'string' THEN o.value->>'v' END AS txt) t
  WHERE cv.entity_id = e.id
) v
WHERE e.kind = 'company'
"""

INSERT = """

INSERT INTO company_search
  (entity_id, name, website, sector, sub_sector, hq, country, description, revenue,
   revenue_currency, employees_low, employees_high, buyer_category, investor_type,
   embed_text, document)
"""


def refresh(session: Session, entity_ids: Iterable[uuid.UUID]) -> None:
    """Rebuild the search rows of these entities (non-companies are ignored);
    their embeddings are redone after commit if their text changed."""
    ids = list(entity_ids)
    if not ids:
        return
    session.execute(text("DELETE FROM company_search WHERE entity_id = ANY(:ids)"),
                    {"ids": ids})
    session.execute(text(INSERT + SELECT_ROWS + " AND e.id = ANY(:ids)"), {"ids": ids})
    embeddings.mark(session)


def refresh_all(conn: Connection | Session) -> None:
    conn.execute(text("DELETE FROM company_search"))
    conn.execute(text(INSERT + SELECT_ROWS))
    if isinstance(conn, Session):
        embeddings.mark(conn)


Sort = Literal["relevance", "name", "website", "hq", "sector", "revenue", "employees"]
SORT_COLUMNS = {"name": "lower(s.name)", "website": "s.website",
                "hq": "lower(s.hq)",
                "sector": "lower(s.sector)", "revenue": "s.revenue",
                "employees": "CASE WHEN s.employees_low IS NULL AND s.employees_high IS NULL "
                             "THEN NULL ELSE coalesce(s.employees_low, 0) END"}
Mode = Literal["hybrid", "keyword"]

RRF_K = 60
VECTOR_K = 100
MIN_SIMILARITY = 0.30
VECTOR_MARGIN = 0.15
KEYWORD_CAP = 2000


@dataclass(frozen=True)
class Filters:
    """Structured conditions; empty means no condition. Revenue bounds are in
    millions of `revenue_currency`; companies without the figure (or with a
    currency we have no rate for) only pass a range with `include_missing`."""

    countries: tuple[str, ...] = ()
    sectors: tuple[str, ...] = ()
    buyer_category: str | None = None
    investor_types: tuple[str, ...] = ()
    revenue_min_m: float | None = None
    revenue_max_m: float | None = None
    revenue_currency: str = "EUR"
    employees_min: int | None = None
    employees_max: int | None = None
    include_missing: bool = False

    def sql(self) -> tuple[list[str], dict]:
        where: list[str] = []
        params: dict = {}
        if self.countries:
            where.append("s.country = ANY(:f_countries)")
            params["f_countries"] = list(self.countries)
        if self.sectors:
            # Whole words, case-insensitive, in sector or sub-sector:
            # "IT services" matches "IT Services & Consulting", "IT" not "Capital".
            alts = []
            for i, term in enumerate(t.strip() for t in self.sectors if t.strip()):
                params[f"f_sector{i}"] = r"\m" + _regex_escape(term) + r"\M"
                alts.append(f"concat_ws(' ', s.sector, s.sub_sector) ~* :f_sector{i}")
            if alts:
                where.append("(" + " OR ".join(alts) + ")")
        if self.buyer_category:
            where.append("s.buyer_category = :f_buyer")
            params["f_buyer"] = self.buyer_category
        if self.investor_types:
            where.append("s.investor_type = ANY(:f_investor)")
            params["f_investor"] = list(self.investor_types)
        if self.revenue_min_m is not None or self.revenue_max_m is not None:
            rate = APPROX_EUR_PER_UNIT[self.revenue_currency]
            cases = " ".join(f"WHEN '{c}' THEN {r!r}"
                             for c, r in APPROX_EUR_PER_UNIT.items())
            eur = f"(s.revenue * CASE s.revenue_currency {cases} END)"
            parts = []
            if self.revenue_min_m is not None:
                parts.append(f"{eur} >= :f_rev_min")
                params["f_rev_min"] = self.revenue_min_m * 1e6 * rate
            if self.revenue_max_m is not None:
                parts.append(f"{eur} <= :f_rev_max")
                params["f_rev_max"] = self.revenue_max_m * 1e6 * rate
            where.append(_range(" AND ".join(parts), f"{eur} IS NULL",
                                self.include_missing))
        if self.employees_min is not None or self.employees_max is not None:
            # A figure is a range with open ends; it matches when it overlaps
            # the asked range. No bound at all means no figure.
            parts = ["(s.employees_low IS NOT NULL OR s.employees_high IS NOT NULL)"]
            if self.employees_min is not None:
                parts.append(
                    "(s.employees_high IS NULL OR s.employees_high >= :f_emp_min)")
                params["f_emp_min"] = self.employees_min
            if self.employees_max is not None:
                parts.append(
                    "(s.employees_low IS NULL OR s.employees_low <= :f_emp_max)")
                params["f_emp_max"] = self.employees_max
            where.append(_range(" AND ".join(parts),
                                "s.employees_low IS NULL AND s.employees_high IS NULL",
                                self.include_missing))
        return where, params


def _range(condition: str, missing: str, include_missing: bool) -> str:
    return f"({condition} OR ({missing}))" if include_missing else f"({condition})"


def _regex_escape(term: str) -> str:
    """Escape for a Postgres ARE: a backslash before any non-alphanumeric
    character makes it literal."""
    return re.sub(r"([^\w\s])", r"\\\1", term)


@dataclass
class Result:
    total: int
    ids: list[uuid.UUID]
    # "keyword" when the query couldn't be embedded or no query was given.
    mode: Mode = "keyword"
    # Per id: which retrievers found it (for the eval and debugging).
    found_by: dict[uuid.UUID, list[str]] = field(default_factory=dict)


def prefix_query(q: str) -> str | None:
    """'isar cap' → 'isar:* & cap:*' (only letters and digits, so user input
    can't inject tsquery syntax)."""
    words = [w for w in re.split(r"[^\w]+", q.lower()) if w]
    return " & ".join(f"{w}:*" for w in words) or None


KEYWORD_WHERE = ("(s.document @@ to_tsquery('simple', :tsq)"
                 " OR s.website LIKE :q || '%'"
                 " OR lower(s.name) % :q OR :q <% lower(s.name))")
KEYWORD_RANK = ("(ts_rank(s.document, to_tsquery('simple', :tsq))"
                " + word_similarity(:q, lower(coalesce(s.name, ''))))")
# 0: the name or website is the query; 1: the name starts with it; 2: the rest.
TIER = ("CASE WHEN lower(s.name) = :q OR s.website = :q THEN 0"
        " WHEN lower(s.name) LIKE :q || '%' THEN 1 ELSE 2 END")


def search(session: Session, q: str | None, sort: Sort, descending: bool,
           offset: int, limit: int, filters: Filters | None = None,
           mode: Mode = "hybrid") -> Result:
    """Total matches and one page of company ids."""
    q = (q or "").strip()
    where, params = (filters or Filters()).sql()
    base = " AND ".join(where) or "TRUE"

    if not q:
        order = _order("name" if sort == "relevance" else sort, descending)
        total = session.execute(text(f"SELECT count(*) FROM company_search s "
                                     f"WHERE {base}"), params).scalar_one()
        ids = session.execute(text(
            f"SELECT s.entity_id FROM company_search s WHERE {base} "
            f"ORDER BY {order} LIMIT :limit OFFSET :offset"),
            {**params, "limit": limit, "offset": offset}).scalars().all()
        return Result(total, list(ids))

    ranked, found_by, used = _ranked(session, q, base, params, mode)
    if sort == "relevance":
        return Result(len(ranked), ranked[offset:offset + limit], used, found_by)
    ids = session.execute(text(
        f"SELECT s.entity_id FROM company_search s WHERE s.entity_id = ANY(:ids) "
        f"ORDER BY {_order(sort, descending)} LIMIT :limit OFFSET :offset"),
        {"ids": ranked, "limit": limit, "offset": offset}).scalars().all()
    return Result(len(ranked), list(ids), used, found_by)


def _order(sort: str, descending: bool) -> str:
    direction = "DESC" if descending else "ASC"
    return f"{SORT_COLUMNS[sort]} {direction} NULLS LAST, lower(s.name), s.entity_id" \
        if sort != "name" else f"{SORT_COLUMNS[sort]} {direction} NULLS LAST, s.entity_id"


def _ranked(session: Session, q: str, base: str, params: dict, mode: Mode
            ) -> tuple[list[uuid.UUID], dict[uuid.UUID, list[str]], Mode]:
    """Every match in relevance order: tier, then reciprocal rank fusion."""
    params = {**params, "q": q.lower(), "tsq": prefix_query(q) or ""}
    keyword = session.execute(text(
        f"SELECT s.entity_id, {TIER} FROM company_search s "
        f"WHERE {base} AND {KEYWORD_WHERE} "
        f"ORDER BY {KEYWORD_RANK} DESC, lower(s.name) LIMIT {KEYWORD_CAP}"),
        params).all()
    tiers = {i: t for i, t in keyword}
    lists: dict[str, list[uuid.UUID]] = {"keyword": [i for i, _ in keyword]}

    used: Mode = "keyword"
    vector = embeddings.embed_query(q) if mode == "hybrid" else None
    if vector is not None:
        used = "hybrid"
        # Filtered HNSW scans keep looking until enough rows pass (pgvector 0.8).
        session.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
        near = session.execute(text(
            f"SELECT s.entity_id, {TIER}, 1 - (ce.embedding <=> CAST(:qv AS vector)) "
            f"FROM company_search s JOIN company_embeddings ce "
            f"ON ce.entity_id = s.entity_id "
            f"WHERE {base} AND ce.model = :model "
            f"ORDER BY ce.embedding <=> CAST(:qv AS vector) LIMIT {VECTOR_K}"),
            {**params, "qv": vector, "model": llm.embedder().model}).all()
        cutoff = max(MIN_SIMILARITY, (near[0][2] if near else 0) - VECTOR_MARGIN)
        near = [(i, t) for i, t, sim in near if sim >= cutoff]
        tiers.update(dict(near))
        lists["vector"] = [i for i, _ in near]

    score: dict[uuid.UUID, float] = {}
    found_by: dict[uuid.UUID, list[str]] = {}
    for name, ids in lists.items():
        for rank, i in enumerate(ids, 1):
            score[i] = score.get(i, 0) + 1 / (RRF_K + rank)
            found_by.setdefault(i, []).append(name)
    ranked = sorted(score, key=lambda i: (tiers[i], -score[i]))
    return ranked, found_by, used
