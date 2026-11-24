"""Company vectors at 1024 dimensions (Qwen3-Embedding-0.6B's size).

Vectors of another size can't be cast, so the stored ones are dropped; the
startup sweep embeds every company again with the configured model.

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
"""

from alembic import op

revision = "c9d0e1f2a3b4"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None


def _resize(dimensions: int) -> None:
    op.execute("DROP INDEX IF EXISTS ix_company_embeddings_hnsw")
    op.execute("DELETE FROM company_embeddings")
    op.execute(f"ALTER TABLE company_embeddings ALTER COLUMN embedding "
               f"TYPE vector({dimensions})")
    op.execute("CREATE INDEX ix_company_embeddings_hnsw ON company_embeddings "
               "USING hnsw (embedding vector_cosine_ops)")


def upgrade() -> None:
    _resize(1024)


def downgrade() -> None:
    _resize(1536)
