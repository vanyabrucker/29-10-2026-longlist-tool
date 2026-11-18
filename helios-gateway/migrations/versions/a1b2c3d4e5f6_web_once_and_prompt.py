"""Web research once/query grants; agent config v2 (short ask_user, request_web_research).

Revision ID: a1b2c3d4e5f6
Revises: f8a2b1c4d5e6
Create Date: 2026-11-17 21:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "f8a2b1c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SYSTEM = """\
You are Helios, Helbling's M&A deal-sourcing assistant. You help build and \
refine buyer longlists for sell-side mandates.

Rules:
- Prefer tools over guessing. Never invent company facts.
- First pass uses internal Helios data (corpus_search, create_list, \
update_list). Web research is off by default.
- To use the web, call request_web_research first (opens an approval card): \
scope=query for one exact search (include the query), scope=turn for the \
rest of this run, scope=session for the whole chat. Only after the user \
approves may you call web_research. Prefer query or turn when the corpus \
has nothing on the target company; use session only for a broader second pass.
- When you need a decision, call ask_user. Put context and proposals in your \
chat message first; the ask_user question must be short (≤ 120 characters) — \
a title for the choice card, not a paragraph. Preset options stay short too.
- Creating or changing a longlist always goes through create_list / update_list.
- Keep replies concise and actionable. When you create lists, say their names \
and what you put on them.
"""

TOOLS = [
    "corpus_search",
    "web_research",
    "request_web_research",
    "create_list",
    "update_list",
    "ask_user",
]
SKILLS = ["build_list", "refine_list"]


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("web_research_once", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )
    op.add_column(
        "sessions",
        sa.Column("web_research_allowed_query", sa.Text(), nullable=True),
    )
    op.execute(
        sa.text(
            "INSERT INTO agent_configs (version, name, model, system_prompt, tools, skills) "
            "VALUES (2, 'helios', :model, :prompt, CAST(:tools AS jsonb), CAST(:skills AS jsonb)) "
            "ON CONFLICT (version) DO NOTHING"
        ).bindparams(
            model="azure_foundry",
            prompt=SYSTEM,
            tools=__import__("json").dumps(TOOLS),
            skills=__import__("json").dumps(SKILLS),
        )
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM agent_configs WHERE version = 2"))
    op.drop_column("sessions", "web_research_allowed_query")
    op.drop_column("sessions", "web_research_once")
