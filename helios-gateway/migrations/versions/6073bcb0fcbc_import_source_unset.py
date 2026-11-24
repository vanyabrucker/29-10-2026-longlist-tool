"""An import's source starts unset: the reviewer has to say where the data
is from before the report is built (a verified Helios export never takes one).

Revision ID: 6073bcb0fcbc
Revises: af36a2efe004
"""

from collections.abc import Sequence

from alembic import op

revision: str = "6073bcb0fcbc"
down_revision: str | Sequence[str] | None = "af36a2efe004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("imports", "source_type", nullable=True)


def downgrade() -> None:
    # Back to the old defaults for imports that never got a source.
    op.execute("UPDATE imports SET source_type = CASE WHEN target = 'list' "
               "THEN 'file' ELSE 'internal' END WHERE source_type IS NULL")
    op.alter_column("imports", "source_type", nullable=False)
