"""Agent configs, private chat sessions and append-only session events.

Revision ID: f8a2b1c4d5e6
Revises: e6c1f0a93d52
Create Date: 2026-11-17 20:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f8a2b1c4d5e6"
down_revision: str | Sequence[str] | None = "e6c1f0a93d52"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SYSTEM = """\
You are Helios, Helbling's M&A deal-sourcing assistant. You help build and \
refine buyer longlists for sell-side mandates.

Rules:
- Prefer tools over guessing. Never invent company facts.
- First pass uses internal Helios data only (corpus_search, create_list, \
update_list). Do not call web_research until the user has approved a second \
pass; web research is off by default and the tool will error if it is still off.
- When you need a decision from the user, call ask_user (question + optional \
preset answers). Free text also comes back as the answer.
- Creating or changing a longlist always goes through create_list / update_list.
- Keep replies concise and actionable. When you create lists, say their names \
and what you put on them.
"""

TOOLS = [
    "corpus_search",
    "web_research",
    "create_list",
    "update_list",
    "ask_user",
]
SKILLS = ["build_list", "refine_list"]


def upgrade() -> None:
    op.create_table(
        "agent_configs",
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False, server_default="helios"),
        sa.Column("model", sa.String(120), nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("tools", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("skills", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
    )
    op.create_table(
        "sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("owner", sa.String(255), nullable=False),
        sa.Column("title", sa.String(255), nullable=False, server_default=""),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("status", sa.String(20), nullable=False, server_default="idle"),
        sa.Column("stop_reason", sa.String(40)),
        sa.Column("agent_config_version", sa.Integer(),
                  sa.ForeignKey("agent_configs.version"), nullable=False),
        sa.Column("list_ids", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("web_research_enabled", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("web_searches_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pending_tool_call_id", sa.String(80)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.CheckConstraint("status IN ('running', 'idle')", name="ck_sessions_status"),
        sa.CheckConstraint(
            "stop_reason IS NULL OR stop_reason IN "
            "('end_turn', 'requires_action', 'interrupted', 'error')",
            name="ck_sessions_stop_reason",
        ),
    )
    op.create_index("ix_sessions_owner", "sessions", ["owner"])
    op.create_table(
        "session_events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("session_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(40), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("processed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.UniqueConstraint("session_id", "seq", name="uq_session_events_seq"),
    )
    op.create_index("ix_session_events_session_id", "session_events", ["session_id"])
    op.create_index("ix_session_events_session_seq", "session_events",
                    ["session_id", "seq"])

    # Seed config version 1. Model is a placeholder; the live agent uses Settings.
    op.execute(
        sa.text(
            "INSERT INTO agent_configs (version, name, model, system_prompt, tools, skills) "
            "VALUES (1, 'helios', :model, :prompt, CAST(:tools AS jsonb), CAST(:skills AS jsonb))"
        ).bindparams(
            model="azure_foundry",
            prompt=SYSTEM,
            tools=__import__("json").dumps(TOOLS),
            skills=__import__("json").dumps(SKILLS),
        )
    )


def downgrade() -> None:
    op.drop_table("session_events")
    op.drop_table("sessions")
    op.drop_table("agent_configs")
