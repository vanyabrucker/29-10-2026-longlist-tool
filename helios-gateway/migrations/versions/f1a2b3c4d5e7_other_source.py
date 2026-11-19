"""an "Other" source with a note

An uploader whose source isn't listed picks "Other" (scored like an
uploaded file) and names it. The name is kept as a note on the import and
on every observation it writes, never shown as the source, so a source
named often can later become a source type of its own. `source_by` records
who claimed the source, so a wrong claim is traceable.

Revision ID: f1a2b3c4d5e7
Revises: e7f8a9b0c1d2
Create Date: 2026-11-19 10:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e7"
down_revision: str | Sequence[str] | None = "e7f8a9b0c1d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("INSERT INTO source_types (key, label, confidence, sort) "
               "VALUES ('other', 'Other', 0.5, 10) ON CONFLICT DO NOTHING")
    for table in ("imports", "observations"):
        op.add_column(table, sa.Column("source_note", sa.String(120)))
        op.add_column(table, sa.Column("source_by", sa.String(255)))


def downgrade() -> None:
    for table in ("imports", "observations"):
        op.drop_column(table, "source_by")
        op.drop_column(table, "source_note")
    op.execute("UPDATE imports SET source_type = 'file' WHERE source_type = 'other'")
    op.execute("DELETE FROM source_types WHERE key = 'other'")
