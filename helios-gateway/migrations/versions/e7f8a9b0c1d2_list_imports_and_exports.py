"""list imports and round-trip exports

Imports get a target (corpus, dev-only; or a list, anyone signed in), the
verified export they came from and the chat they were dropped into. Every
list export is recorded with a snapshot of the cells it wrote, so a file
coming back can be diffed three ways. A `file` source type scores values
that come from an uploaded file.

Revision ID: e7f8a9b0c1d2
Revises: d5e6f7a8b9c0
Create Date: 2026-11-18 12:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e7f8a9b0c1d2"
down_revision: str | Sequence[str] | None = "d5e6f7a8b9c0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("INSERT INTO source_types (key, label, confidence, sort) "
               "VALUES ('file', 'Uploaded file', 0.5, 9) ON CONFLICT DO NOTHING")
    op.create_table(
        "list_exports",
        sa.Column("id", postgresql.UUID(), primary_key=True),
        sa.Column("list_id", postgresql.UUID(), sa.ForeignKey("longlists.id"), nullable=False,
                  index=True),
        sa.Column("list_version", sa.Integer(), nullable=False),
        sa.Column("corpus_version", sa.Integer(), nullable=False),
        sa.Column("exported_by", sa.String(255), nullable=False),
        sa.Column("columns", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
    )
    op.create_table(
        "list_export_cells",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("export_id", postgresql.UUID(),
                  sa.ForeignKey("list_exports.id", ondelete="CASCADE"), nullable=False,
                  index=True),
        sa.Column("entry_id", postgresql.UUID(), nullable=False),
        sa.Column("company_id", postgresql.UUID(), nullable=True),
        sa.Column("key", sa.String(80), nullable=False),
        sa.Column("value", postgresql.JSONB(), nullable=True),
    )
    op.create_index("ix_list_export_cells_company_key", "list_export_cells",
                    ["company_id", "key"])
    op.create_index("ix_list_export_cells_entry_key", "list_export_cells",
                    ["entry_id", "key"])
    op.add_column("imports", sa.Column("target", sa.String(10), nullable=False,
                                       server_default="corpus"))
    op.add_column("imports", sa.Column("export_id", postgresql.UUID(),
                                       sa.ForeignKey("list_exports.id"), nullable=True))
    op.add_column("imports", sa.Column("session_id", postgresql.UUID(),
                                       sa.ForeignKey("sessions.id", ondelete="SET NULL"),
                                       nullable=True))
    op.add_column("imports", sa.Column("list_version", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("imports", "list_version")
    op.drop_column("imports", "session_id")
    op.drop_column("imports", "export_id")
    op.drop_column("imports", "target")
    op.drop_table("list_export_cells")
    op.drop_table("list_exports")
    op.execute("DELETE FROM source_types WHERE key = 'file'")
