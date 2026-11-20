"""the read-only Contacts column on every existing longlist

Each list without an open Contacts column gets it as one new list version
(author "Helios"), placed like `create_list` places it for new lists: right
after the name and, when present, the relevance columns. Columns after it
move one place right (closed and re-inserted, as a normal version writes
them). `longlists.updated_at` stays as it was, so the Longlists order and
"last edited" don't change.

Revision ID: b8c9d0e1f2a3
Revises: f9a0b1c2d3e4
Create Date: 2026-11-20 12:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8c9d0e1f2a3"
down_revision: str | Sequence[str] | None = "f9a0b1c2d3e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copies of app.longlists at this revision.
AUTHOR = "Helios"
MESSAGE = "Added the Contacts column"
BLOCK = ("name", "relevance_score", "relevance_explanation")
CONTACTS = {"key": "contacts", "label": "Contacts", "type": "contacts",
            "source": "contacts"}


def upgrade() -> None:
    bind = op.get_bind()
    corpus_version = bind.execute(sa.text("SELECT coalesce(max(id), 0) FROM versions")).scalar()
    lists = bind.execute(sa.text(
        "SELECT id, head_version FROM longlists l WHERE NOT EXISTS ("
        " SELECT 1 FROM list_columns c WHERE c.list_id = l.id"
        " AND c.key = 'contacts' AND c.valid_to IS NULL) ORDER BY id")).all()
    for list_id, head in lists:
        n = head + 1
        cols = bind.execute(sa.text(
            "SELECT id, key, label, type, position, source FROM list_columns"
            " WHERE list_id = :id AND valid_to IS NULL ORDER BY position, id"),
            {"id": list_id}).mappings().all()
        order = [c["key"] for c in cols]
        block = [i for i, k in enumerate(order) if k in BLOCK]
        if not block:
            raise RuntimeError(f"List {list_id} has no name column.")
        order.insert(max(block) + 1, CONTACTS["key"])
        bind.execute(sa.text(
            "INSERT INTO list_versions (list_id, number, author, message, corpus_version,"
            " changes, corpus_edits) VALUES (:id, :n, :author, :message, :cv, 1,"
            " CAST('[]' AS jsonb))"),
            {"id": list_id, "n": n, "author": AUTHOR, "message": MESSAGE,
             "cv": corpus_version})
        by_key = {c["key"]: c for c in cols}
        for position, key in enumerate(order):
            cur = by_key.get(key)
            if cur is not None and cur["position"] == position:
                continue
            if cur is not None:
                bind.execute(sa.text("UPDATE list_columns SET valid_to = :n WHERE id = :cid"),
                             {"n": n, "cid": cur["id"]})
            spec = CONTACTS if cur is None else cur
            bind.execute(sa.text(
                "INSERT INTO list_columns (list_id, key, label, type, position, source,"
                " valid_from) VALUES (:id, :key, :label, :type, :pos, :source, :n)"),
                {"id": list_id, "key": spec["key"], "label": spec["label"],
                 "type": spec["type"], "pos": position, "source": spec["source"], "n": n})
        bind.execute(sa.text("UPDATE longlists SET head_version = :n WHERE id = :id"),
                     {"n": n, "id": list_id})


def downgrade() -> None:
    """Undo the version only where it is still the list's latest; lists edited
    since keep it (and their Contacts column)."""
    bind = op.get_bind()
    rows = bind.execute(sa.text(
        "SELECT l.id, l.head_version FROM longlists l JOIN list_versions v"
        " ON v.list_id = l.id AND v.number = l.head_version"
        " WHERE v.author = :author AND v.message = :message"),
        {"author": AUTHOR, "message": MESSAGE}).all()
    for list_id, n in rows:
        params = {"id": list_id, "n": n}
        bind.execute(sa.text(
            "DELETE FROM list_columns WHERE list_id = :id AND valid_from = :n"), params)
        bind.execute(sa.text(
            "UPDATE list_columns SET valid_to = NULL WHERE list_id = :id AND valid_to = :n"),
            params)
        bind.execute(sa.text(
            "DELETE FROM list_versions WHERE list_id = :id AND number = :n"), params)
        bind.execute(sa.text(
            "UPDATE longlists SET head_version = :n - 1 WHERE id = :id"), params)
