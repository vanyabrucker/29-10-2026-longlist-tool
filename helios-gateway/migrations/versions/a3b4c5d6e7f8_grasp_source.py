"""Grasp as a source type, at low confidence

Grasp's data comes from web research and LLM output, so it scores like the
agent without a source (0.3, Low): below an uploaded file of unknown origin.

Revision ID: a3b4c5d6e7f8
Revises: f1a2b3c4d5e7
Create Date: 2026-11-19 17:00:00.000000

"""
from collections.abc import Sequence

from alembic import op

revision: str = "a3b4c5d6e7f8"
down_revision: str | Sequence[str] | None = "f1a2b3c4d5e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("INSERT INTO source_types (key, label, confidence, sort) "
               "VALUES ('grasp', 'Grasp', 0.3, 8) ON CONFLICT DO NOTHING")


def downgrade() -> None:
    op.execute("UPDATE imports SET source_type = 'file' WHERE source_type = 'grasp'")
    op.execute("DELETE FROM source_types WHERE key = 'grasp'")
