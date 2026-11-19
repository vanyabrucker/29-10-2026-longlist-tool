"""hybrid company search: filter columns, embedding text and pgvector embeddings

`company_search` gains the columns structured filters need (HQ country,
sub-sector, revenue currency, buyer category, investor type) and
`embed_text`, the descriptive text a company is embedded from. Embeddings
live in their own table keyed by company, since search rows are rebuilt on
every change: an embedding is only redone when its text hash changes.

Needs the pgvector extension (docker-compose runs pgvector/pgvector:pg16).

Revision ID: f9a0b1c2d3e4
Revises: a3b4c5d6e7f8
Create Date: 2026-11-19 10:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f9a0b1c2d3e4"
down_revision: str | Sequence[str] | None = "a3b4c5d6e7f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DIMENSIONS = 1536

# Frozen copy of app.search.SELECT_ROWS at this revision.
BACKFILL = """
INSERT INTO company_search
  (entity_id, name, website, sector, sub_sector, hq, country, description, revenue,
   revenue_currency, employees, buyer_category, investor_type, embed_text, document)
SELECT e.id, v.name, v.website, v.sector, v.sub_sector, v.hq, v.country, v.description,
  v.revenue, v.revenue_currency, v.employees, v.buyer_category, v.investor_type,
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
    max(CASE WHEN cv.field = 'employee_count' THEN (o.value->>'v')::numeric END)::bigint
      AS employees
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


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    for name, kind in (("sub_sector", sa.Text()), ("country", sa.String(2)),
                       ("revenue_currency", sa.String(3)),
                       ("buyer_category", sa.Text()), ("investor_type", sa.Text()),
                       ("embed_text", sa.Text())):
        op.add_column("company_search", sa.Column(name, kind, nullable=True))
    op.create_index("ix_company_search_country", "company_search", ["country"])
    op.create_index("ix_company_search_revenue", "company_search", ["revenue"])
    op.create_index("ix_company_search_employees", "company_search", ["employees"])
    op.create_table(
        "company_embeddings",
        sa.Column("entity_id", sa.UUID(), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("text_hash", sa.String(length=32), nullable=False),
        sa.Column("embedded_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("entity_id"),
    )
    op.execute(f"ALTER TABLE company_embeddings ADD COLUMN embedding vector({DIMENSIONS}) "
               "NOT NULL")
    op.execute("CREATE INDEX ix_company_embeddings_hnsw ON company_embeddings "
               "USING hnsw (embedding vector_cosine_ops)")
    op.execute("DELETE FROM company_search")
    op.execute(BACKFILL)


def downgrade() -> None:
    op.drop_table("company_embeddings")
    op.drop_index("ix_company_search_employees", "company_search")
    op.drop_index("ix_company_search_revenue", "company_search")
    op.drop_index("ix_company_search_country", "company_search")
    for name in ("embed_text", "investor_type", "buyer_category", "revenue_currency",
                 "country", "sub_sector"):
        op.drop_column("company_search", name)
