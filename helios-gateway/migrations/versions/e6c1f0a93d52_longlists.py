"""real longlists: list versions, entries, temporal columns and entry states

Lists made by imports and their `list_entry` entities (relevance score and
explanation as corpus observations) move into the new tables as version 1 of
each list; the list_entry entities and their observations leave the corpus.

Revision ID: e6c1f0a93d52
Revises: d4e8a2f61b37
Create Date: 2026-11-17 18:00:00.000000

"""
import json
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e6c1f0a93d52"
down_revision: str | Sequence[str] | None = "d4e8a2f61b37"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copy of the default columns of a list without a kind.
COLUMNS = [
    ("name", "Company name", "text", "corpus:name"),
    ("relevance_score", "Relevance score", "percent", "list"),
    ("relevance_explanation", "Relevance explanation", "long_text", "list"),
    ("website", "Website", "domain", "corpus:website"),
    ("hq", "Headquarters", "location", "corpus:hq"),
]


def upgrade() -> None:
    op.add_column("longlists", sa.Column("target", sa.String(255), nullable=True))
    op.add_column("longlists", sa.Column("kind", sa.String(20), nullable=True))
    op.add_column("longlists", sa.Column("owner", sa.String(255), nullable=True))
    op.add_column("longlists", sa.Column("head_version", sa.Integer(),
                                         server_default="0", nullable=False))
    op.add_column("longlists", sa.Column("updated_at", sa.DateTime(timezone=True),
                                         server_default=sa.text("now()"), nullable=False))
    op.create_check_constraint("ck_longlists_kind", "longlists",
                               "kind IN ('financial', 'strategic')")

    op.create_table(
        "list_versions",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("list_id", sa.UUID(), sa.ForeignKey("longlists.id"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("author", sa.String(255), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("corpus_version", sa.Integer(), nullable=False),
        sa.Column("reverts", sa.Integer(), nullable=True),
        sa.Column("import_id", sa.UUID(), sa.ForeignKey("imports.id"), nullable=True),
        sa.Column("changes", sa.Integer(), nullable=False),
        sa.Column("corpus_edits", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("list_id", "number", name="uq_list_versions_number"),
    )
    op.create_table(
        "list_entries",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("list_id", sa.UUID(), sa.ForeignKey("longlists.id"), nullable=False),
        sa.Column("company_id", sa.UUID(), sa.ForeignKey("entities.id"), nullable=True),
        sa.Column("created_version", sa.Integer(), nullable=False),
    )
    op.create_index("ix_list_entries_list_id", "list_entries", ["list_id"])
    op.create_table(
        "list_columns",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("list_id", sa.UUID(), sa.ForeignKey("longlists.id"), nullable=False),
        sa.Column("key", sa.String(80), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(80), nullable=False),
        sa.Column("valid_from", sa.Integer(), nullable=False),
        sa.Column("valid_to", sa.Integer(), nullable=True),
    )
    op.create_index("ix_list_columns_list_valid_to", "list_columns", ["list_id", "valid_to"])
    op.create_table(
        "list_entry_states",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("entry_id", sa.UUID(), sa.ForeignKey("list_entries.id"), nullable=False),
        sa.Column("list_id", sa.UUID(), sa.ForeignKey("longlists.id"), nullable=False),
        sa.Column("valid_from", sa.Integer(), nullable=False),
        sa.Column("valid_to", sa.Integer(), nullable=True),
        sa.Column("relevance_score", sa.Float(), nullable=True),
        sa.Column("removed", sa.Boolean(), nullable=False),
        sa.Column("data", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_list_entry_states_entry_id", "list_entry_states", ["entry_id"])
    op.create_index("ix_list_entry_states_list_valid_to", "list_entry_states",
                    ["list_id", "valid_to"])

    _move_lists(op.get_bind())

    op.alter_column("longlists", "owner", nullable=False)
    op.drop_constraint("entities_list_id_fkey", "entities", type_="foreignkey")
    op.drop_column("entities", "list_id")
    op.drop_constraint("longlists_created_version_id_fkey", "longlists", type_="foreignkey")
    op.drop_column("longlists", "created_version_id")


def _move_lists(conn) -> None:
    corpus_version = conn.execute(sa.text("SELECT coalesce(max(id), 0) FROM versions")).scalar()
    lists = conn.execute(sa.text(
        "SELECT l.id, coalesce(v.author, 'unknown') FROM longlists l "
        "LEFT JOIN versions v ON v.id = l.created_version_id")).all()
    for list_id, owner in lists:
        conn.execute(sa.text("UPDATE longlists SET owner = :o, head_version = 1 WHERE id = :id"),
                     {"o": owner, "id": list_id})
        conn.execute(sa.text(
            "INSERT INTO list_versions (list_id, number, author, message, corpus_version, "
            "changes, corpus_edits) VALUES (:l, 1, :a, 'Brought over from imports', :c, 0, "
            "'[]')"), {"l": list_id, "a": owner, "c": corpus_version})
        for i, (key, label, type_, source) in enumerate(COLUMNS):
            conn.execute(sa.text(
                "INSERT INTO list_columns (list_id, key, label, type, position, source, "
                "valid_from) VALUES (:l, :k, :lb, :t, :p, :s, 1)"),
                {"l": list_id, "k": key, "lb": label, "t": type_, "p": i, "s": source})
        entries = conn.execute(sa.text(
            "SELECT id, company_id FROM entities WHERE kind = 'list_entry' AND list_id = :l"),
            {"l": list_id}).all()
        for entity_id, company_id in entries:
            values = dict(conn.execute(sa.text(
                "SELECT cv.field, o.value->'v' FROM current_values cv "
                "JOIN observations o ON o.id = cv.observation_id WHERE cv.entity_id = :e"),
                {"e": entity_id}).all())
            entry_id = uuid.uuid4()
            conn.execute(sa.text(
                "INSERT INTO list_entries (id, list_id, company_id, created_version) "
                "VALUES (:id, :l, :c, 1)"), {"id": entry_id, "l": list_id, "c": company_id})
            data = ({"relevance_explanation": values["relevance_explanation"]}
                    if values.get("relevance_explanation") is not None else {})
            score = values.get("relevance_score")
            conn.execute(sa.text(
                "INSERT INTO list_entry_states (entry_id, list_id, valid_from, "
                "relevance_score, removed, data) VALUES (:e, :l, 1, :s, false, "
                "CAST(:d AS jsonb))"),
                {"e": entry_id, "l": list_id, "s": float(score) if score is not None else None,
                 "d": json.dumps(data)})
    # The list data now lives in the list tables, not in the corpus.
    gone = "SELECT id FROM entities WHERE kind = 'list_entry'"
    conn.execute(sa.text(f"DELETE FROM current_values WHERE entity_id IN ({gone})"))
    conn.execute(sa.text(f"DELETE FROM value_pins WHERE entity_id IN ({gone})"))
    conn.execute(sa.text(f"DELETE FROM observations WHERE entity_id IN ({gone})"))
    conn.execute(sa.text("DELETE FROM entities WHERE kind = 'list_entry'"))


def downgrade() -> None:
    # List versions, states and custom columns have no place in the old schema.
    op.add_column("longlists", sa.Column("created_version_id", sa.Integer(),
                                         sa.ForeignKey("versions.id"), nullable=True))
    op.add_column("entities", sa.Column("list_id", sa.UUID(),
                                        sa.ForeignKey("longlists.id"), nullable=True))
    op.drop_table("list_entry_states")
    op.drop_table("list_columns")
    op.drop_table("list_entries")
    op.drop_table("list_versions")
    op.drop_constraint("ck_longlists_kind", "longlists", type_="check")
    for column in ("updated_at", "head_version", "owner", "kind", "target"):
        op.drop_column("longlists", column)
