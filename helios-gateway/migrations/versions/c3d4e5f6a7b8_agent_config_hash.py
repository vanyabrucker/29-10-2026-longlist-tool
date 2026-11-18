"""agent configs come from the repo: content hash per version

New versions are created by the gateway (`app.agent.config`) when the
prompt, skills, tools or model change, with the skill texts copied in, so
prompt edits no longer need a migration.

Revision ID: c3d4e5f6a7b8
Revises: b7c8d9e0f1a2
Create Date: 2026-11-18 10:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: str | Sequence[str] | None = "b7c8d9e0f1a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agent_configs", sa.Column("content_hash", sa.String(64)))
    op.create_index("ix_agent_configs_content_hash", "agent_configs", ["content_hash"])


def downgrade() -> None:
    op.drop_index("ix_agent_configs_content_hash", table_name="agent_configs")
    op.drop_column("agent_configs", "content_hash")
