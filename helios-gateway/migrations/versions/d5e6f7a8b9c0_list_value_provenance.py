"""list-only values keep their source: provenance per cell, agent source type

Values a list holds itself (companies not in the corpus, custom columns) now
record where they came from, so the table can score them like corpus values.
Values written before this have no record and read as Unknown.

Revision ID: d5e6f7a8b9c0
Revises: c3d4e5f6a7b8
Create Date: 2026-11-18 09:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d5e6f7a8b9c0"
down_revision: str | Sequence[str] | None = "c3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("list_entry_states", sa.Column(
        "provenance", postgresql.JSONB(), nullable=False, server_default="{}"))
    # Facts the agent states without a page to back them.
    op.execute("INSERT INTO source_types (key, label, confidence, sort) "
               "VALUES ('agent', 'Agent, no source', 0.3, 8) ON CONFLICT DO NOTHING")


def downgrade() -> None:
    op.execute("DELETE FROM source_types WHERE key = 'agent'")
    op.drop_column("list_entry_states", "provenance")
