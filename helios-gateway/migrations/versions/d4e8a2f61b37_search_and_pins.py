"""company search index and value pins

Revision ID: d4e8a2f61b37
Revises: b7d2e91c4a10
Create Date: 2026-11-17 16:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d4e8a2f61b37"
down_revision: str | Sequence[str] | None = "b7d2e91c4a10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


BACKFILL = """
INSERT INTO company_search
  (entity_id, name, website, sector, hq, description, revenue, employees, document)

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


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "value_pins",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("entity_id", sa.UUID(), nullable=False),
        sa.Column("field", sa.String(length=60), nullable=False),
        sa.Column("period", sa.Integer(), nullable=False),
        sa.Column("observation_id", sa.BigInteger(), nullable=True),
        sa.Column("pinned_by", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("version_id", sa.Integer(), nullable=False),
        sa.Column("retracted_version_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"]),
        sa.ForeignKeyConstraint(["observation_id"], ["observations.id"]),
        sa.ForeignKeyConstraint(["version_id"], ["versions.id"]),
        sa.ForeignKeyConstraint(["retracted_version_id"], ["versions.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_value_pins_entity_field", "value_pins",
                    ["entity_id", "field", "period"])
    op.create_index(op.f("ix_value_pins_version_id"), "value_pins", ["version_id"])
    op.create_index(op.f("ix_value_pins_retracted_version_id"), "value_pins",
                    ["retracted_version_id"])
    op.add_column("current_values", sa.Column("pin_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key("current_values_pin_id_fkey", "current_values", "value_pins",
                          ["pin_id"], ["id"])

    op.create_table(
        "company_search",
        sa.Column("entity_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("website", sa.Text(), nullable=True),
        sa.Column("sector", sa.Text(), nullable=True),
        sa.Column("hq", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("revenue", sa.Float(), nullable=True),
        sa.Column("employees", sa.BigInteger(), nullable=True),
        sa.Column("document", postgresql.TSVECTOR(), nullable=False),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"]),
        sa.PrimaryKeyConstraint("entity_id"),
    )
    op.execute("CREATE INDEX ix_company_search_document ON company_search USING gin (document)")
    op.execute("CREATE INDEX ix_company_search_name_trgm ON company_search "
               "USING gin (lower(name) gin_trgm_ops)")
    op.execute("CREATE INDEX ix_company_search_website_trgm ON company_search "
               "USING gin (website gin_trgm_ops)")
    # Fill it for companies imported before this migration (a frozen copy of
    # app/search.py's query, so later changes there don't alter history).
    op.execute(BACKFILL)


def downgrade() -> None:
    op.drop_table("company_search")
    op.drop_constraint("current_values_pin_id_fkey", "current_values", type_="foreignkey")
    op.drop_column("current_values", "pin_id")
    op.drop_table("value_pins")
