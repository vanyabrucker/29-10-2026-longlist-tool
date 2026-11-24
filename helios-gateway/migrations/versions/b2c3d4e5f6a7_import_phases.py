"""Imports show the running step's named phases (Reading rows → Matching
companies → Checking websites → Scoring values) under the progress bar.

Revision ID: b2c3d4e5f6a7
Revises: 6073bcb0fcbc
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b2c3d4e5f6a7"
down_revision: str | Sequence[str] | None = "6073bcb0fcbc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("imports", sa.Column("phases", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("imports", "phases")
