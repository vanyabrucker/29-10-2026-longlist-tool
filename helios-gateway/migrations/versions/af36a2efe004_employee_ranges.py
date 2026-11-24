"""Employees become a range: {"low": int|None, "high": int|None}.

Stored numbers become ranges with equal bounds (observations, list-only cells
and the old/new of list versions' corpus edits); the search table's single
`employees` column becomes `employees_low` and `employees_high`. Lists'
Employees columns get the type int_range, and imports waiting in report
review go back to mapping review with their report cleared, so the report is
rebuilt with ranges.

Downgrade: a range goes back to one number, its low bound, or its high bound
when the low is open ("up to 9" comes back as 9), so a band such as 11-50
comes back as 11. A range with neither bound has no figure and stays as it is.
Lists' Employees columns go back to the type int.

Revision ID: af36a2efe004
Revises: c9d0e1f2a3b4
"""
import sqlalchemy as sa
from alembic import op

revision = "af36a2efe004"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None

# Frozen copy of app.search.SELECT_ROWS and INSERT at this revision.
BACKFILL = """
INSERT INTO company_search
  (entity_id, name, website, sector, sub_sector, hq, country, description, revenue,
   revenue_currency, employees_low, employees_high, buyer_category, investor_type,
   embed_text, document)
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

TO_RANGE = "jsonb_build_object('low', {x}, 'high', {x})"
FROM_RANGE = ("coalesce(to_jsonb(coalesce(({x}->>'low')::bigint, ({x}->>'high')::bigint)),"
              " {x})")


def _edits(new_value: str, is_old: str) -> None:
    """Rewrite old/new of the employee_count entries in corpus_edits."""
    op.execute(f"""
        UPDATE list_versions v SET corpus_edits = (
          SELECT jsonb_agg(CASE WHEN e->>'field' = 'employee_count' THEN
              e || jsonb_build_object(
                'old', CASE WHEN {is_old.format(x="(e->'old')")} THEN
                       {new_value.format(x="(e->'old')")} ELSE e->'old' END,
                'new', CASE WHEN {is_old.format(x="(e->'new')")} THEN
                       {new_value.format(x="(e->'new')")} ELSE e->'new' END)
            ELSE e END ORDER BY n)
          FROM jsonb_array_elements(v.corpus_edits) WITH ORDINALITY AS t(e, n))
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(v.corpus_edits) e
                      WHERE e->>'field' = 'employee_count')""")


def upgrade() -> None:
    op.execute(f"""
        UPDATE observations SET value = jsonb_set(value, '{{v}}',
          {TO_RANGE.format(x="value->'v'")})
        WHERE field = 'employee_count' AND jsonb_typeof(value->'v') = 'number'""")
    op.execute(f"""
        UPDATE list_entry_states SET data = jsonb_set(data, '{{employee_count}}',
          {TO_RANGE.format(x="data->'employee_count'")})
        WHERE jsonb_typeof(data->'employee_count') = 'number'""")
    _edits(TO_RANGE, "jsonb_typeof({x}) = 'number'")
    # Lists keep a copy of the column type: compare and export Employees as ranges.
    op.execute("UPDATE list_columns SET type = 'int_range' "
               "WHERE source = 'corpus:employee_count'")
    # A report built before holds numeric employee values: send pending
    # reviews back to the mapping so the report is rebuilt with ranges.
    op.execute("UPDATE imports SET status = 'mapping_review', report = NULL "
               "WHERE status = 'report_review'")

    op.drop_index("ix_company_search_employees", "company_search")
    op.drop_column("company_search", "employees")
    op.add_column("company_search", sa.Column("employees_low", sa.BigInteger()))
    op.add_column("company_search", sa.Column("employees_high", sa.BigInteger()))
    op.create_index("ix_company_search_employees_low", "company_search", ["employees_low"])
    op.execute("DELETE FROM company_search")
    op.execute(BACKFILL)


def downgrade() -> None:
    op.execute(f"""
        UPDATE observations SET value = jsonb_set(value, '{{v}}',
          {FROM_RANGE.format(x="value->'v'")})
        WHERE field = 'employee_count' AND jsonb_typeof(value->'v') = 'object'""")
    op.execute(f"""
        UPDATE list_entry_states SET data = jsonb_set(data, '{{employee_count}}',
          {FROM_RANGE.format(x="data->'employee_count'")})
        WHERE jsonb_typeof(data->'employee_count') = 'object'""")
    _edits(FROM_RANGE, "jsonb_typeof({x}) = 'object'")
    op.execute("UPDATE list_columns SET type = 'int' "
               "WHERE source = 'corpus:employee_count'")

    op.add_column("company_search", sa.Column("employees", sa.BigInteger()))
    op.execute("UPDATE company_search SET employees = coalesce(employees_low, "
               "employees_high)")
    op.drop_index("ix_company_search_employees_low", "company_search")
    op.drop_column("company_search", "employees_high")
    op.drop_column("company_search", "employees_low")
    op.create_index("ix_company_search_employees", "company_search", ["employees"])
