"""Feedback on chats: Bad / Fine / Good with an optional comment, and the
dev's triage status.

Revision ID: d1e2f3a4b5c6
Revises: c9d0e1f2a3b4
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "d1e2f3a4b5c6"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "session_feedback",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("session_id", UUID, sa.ForeignKey("sessions.id", ondelete="SET NULL"),
                  unique=True),
        sa.Column("owner", sa.String(255), nullable=False, index=True),
        sa.Column("session_title", sa.String(255), nullable=False, server_default=""),
        sa.Column("agent_config_version", sa.Integer),
        sa.Column("rating", sa.String(10)),
        sa.Column("comment", sa.Text),
        sa.Column("status", sa.String(20), nullable=False, server_default="todo"),
        sa.Column("note", sa.Text),
        sa.Column("analyzed_by", sa.String(255)),
        sa.Column("dataset_sample", sa.String(80)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.CheckConstraint("rating IS NULL OR rating IN ('bad', 'fine', 'good')",
                           name="ck_session_feedback_rating"),
        sa.CheckConstraint("status IN ('todo', 'in_progress', 'done')",
                           name="ck_session_feedback_status"),
    )


def downgrade() -> None:
    op.drop_table("session_feedback")
