"""The longlists migration moves lists made by imports (list_entry entities
with relevance observations) into the list tables, on its own database."""

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from tests.conftest import PG

ADMIN = f"{PG}/helios"
URL = PG.replace("postgresql://", "postgresql+psycopg://") + "/helios_migration"


@pytest.fixture
def engine(database, monkeypatch):
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS helios_migration WITH (FORCE)")
        conn.execute("CREATE DATABASE helios_migration")
    monkeypatch.setenv("DATABASE_URL", URL)
    from app import config

    config.settings.cache_clear()
    yield create_engine(URL)
    config.settings.cache_clear()


def test_lists_move_into_the_list_tables(engine):
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "d4e8a2f61b37")
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO versions (id, kind, author, message, counts) VALUES "
            "(1, 'import', 'dev@helbling.ch', 'Imported x.xlsx', '{}')"))
        c.execute(text(
            "INSERT INTO longlists (id, name, created_version_id) VALUES "
            "('00000000-0000-0000-0000-00000000000a', 'Cedar', 1)"))
        c.execute(text(
            "INSERT INTO entities (id, kind, created_version_id) VALUES "
            "('00000000-0000-0000-0000-000000000001', 'company', 1)"))
        c.execute(text(
            "INSERT INTO entities (id, kind, company_id, list_id, created_version_id) VALUES "
            "('00000000-0000-0000-0000-000000000002', 'list_entry', "
            "'00000000-0000-0000-0000-000000000001', "
            "'00000000-0000-0000-0000-00000000000a', 1)"))
        for i, (field, value) in enumerate(
                [("relevance_score", "94"), ("relevance_explanation", '"Fits"')], 1):
            c.execute(text(
                "INSERT INTO observations (id, entity_id, field, value, source_type, "
                "version_id) VALUES (:id, '00000000-0000-0000-0000-000000000002', :f, "
                "CAST(:v AS jsonb), 'internal', 1)"),
                {"id": i, "f": field, "v": f'{{"v": {value}}}'})
            c.execute(text(
                "INSERT INTO current_values (entity_id, field, period, observation_id, "
                "score, sources) VALUES ('00000000-0000-0000-0000-000000000002', :f, 0, "
                ":id, 70, 1)"), {"id": i, "f": field})

    # Up to the revision before the Contacts column, which adds a version.
    command.upgrade(cfg, "f9a0b1c2d3e4")
    with engine.connect() as c:
        assert c.execute(text("SELECT name, owner, head_version FROM longlists")).one() \
            == ("Cedar", "dev@helbling.ch", 1)
        assert c.execute(text("SELECT number, author FROM list_versions")).one() \
            == (1, "dev@helbling.ch")
        assert c.execute(text(
            "SELECT company_id::text FROM list_entries")).scalar().endswith("0001")
        assert c.execute(text(
            "SELECT relevance_score, data, valid_to FROM list_entry_states")).one() \
            == (94.0, {"relevance_explanation": "Fits"}, None)
        assert c.execute(text(
            "SELECT array_agg(key ORDER BY position) FROM list_columns")).scalar()[:3] \
            == ["name", "relevance_score", "relevance_explanation"]
        assert c.execute(text(
            "SELECT count(*) FROM entities WHERE kind = 'list_entry'")).scalar() == 0
        assert c.execute(text("SELECT count(*) FROM observations")).scalar() == 0
    engine.dispose()


LIST_A = "00000000-0000-0000-0000-0000000000a1"
LIST_B = "00000000-0000-0000-0000-0000000000b1"
LIST_C = "00000000-0000-0000-0000-0000000000c1"


def _seed_lists(c):
    """A: relevance block after the name; B: no relevance columns; C: already
    has an open Contacts column (made by the new code)."""
    c.execute(text(
        "INSERT INTO versions (id, kind, author, message, counts) VALUES "
        "(7, 'import', 'dev@helbling.ch', 'Imported x.xlsx', '{}')"))
    for list_id, name in [(LIST_A, "Cedar"), (LIST_B, "Birch"), (LIST_C, "Oak")]:
        c.execute(text(
            "INSERT INTO longlists (id, name, owner, head_version, updated_at) VALUES "
            "(:id, :name, 'dev@helbling.ch', 1, '2026-01-01T00:00:00+00:00')"),
            {"id": list_id, "name": name})
        c.execute(text(
            "INSERT INTO list_versions (list_id, number, author, message, "
            "corpus_version, changes, corpus_edits) VALUES "
            "(:id, 1, 'dev@helbling.ch', 'Created the list', 7, 4, '[]')"), {"id": list_id})
    columns = {
        LIST_A: [("name", "Company name", "text", "corpus:name"),
                 ("relevance_score", "Relevance score", "percent", "list"),
                 ("relevance_explanation", "Relevance explanation", "long_text", "list"),
                 ("hq", "Headquarters", "location", "corpus:hq")],
        LIST_B: [("name", "Company name", "text", "corpus:name"),
                 ("website", "Website", "domain", "corpus:website")],
        LIST_C: [("name", "Company name", "text", "corpus:name"),
                 ("contacts", "Contacts", "contacts", "contacts")],
    }
    for list_id, cols in columns.items():
        for position, (key, label, type_, source) in enumerate(cols):
            c.execute(text(
                "INSERT INTO list_columns (list_id, key, label, type, position, source, "
                "valid_from) VALUES (:id, :key, :label, :type, :pos, :source, 1)"),
                {"id": list_id, "key": key, "label": label, "type": type_,
                 "pos": position, "source": source})


def _keys_at(c, list_id, n):
    return c.execute(text(
        "SELECT array_agg(key ORDER BY position) FROM list_columns WHERE list_id = :id "
        "AND valid_from <= :n AND (valid_to IS NULL OR valid_to > :n)"),
        {"id": list_id, "n": n}).scalar()


def _list_state(c):
    return (
        c.execute(text("SELECT id::text, head_version, updated_at FROM longlists "
                       "ORDER BY id")).all(),
        c.execute(text("SELECT list_id::text, number, author FROM list_versions "
                       "ORDER BY list_id, number")).all(),
        c.execute(text("SELECT list_id::text, key, position, valid_from, valid_to "
                       "FROM list_columns ORDER BY list_id, key, valid_from")).all(),
    )


def test_contacts_column_added_as_a_quiet_version(engine):
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "f9a0b1c2d3e4")
    with engine.begin() as c:
        _seed_lists(c)

    command.upgrade(cfg, "head")
    with engine.connect() as c:
        heads = dict(c.execute(text(
            "SELECT id::text, head_version FROM longlists")).all())
        assert heads == {LIST_A: 2, LIST_B: 2, LIST_C: 1}
        assert c.execute(text(
            "SELECT author, message, corpus_version, changes, reverts, import_id, "
            "corpus_edits FROM list_versions WHERE list_id = :id AND number = 2"),
            {"id": LIST_A}).one() == ("Helios", "Added the Contacts column", 7, 1, None,
                                      None, [])
        assert _keys_at(c, LIST_A, 2) == ["name", "relevance_score",
                                          "relevance_explanation", "contacts", "hq"]
        assert _keys_at(c, LIST_A, 1) == ["name", "relevance_score",
                                          "relevance_explanation", "hq"]
        assert _keys_at(c, LIST_B, 2) == ["name", "contacts", "website"]
        assert c.execute(text(
            "SELECT label, type, source, position FROM list_columns WHERE list_id = :id "
            "AND key = 'contacts' AND valid_to IS NULL"), {"id": LIST_A}).one() \
            == ("Contacts", "contacts", "contacts", 3)
        # Columns that didn't move keep their version-1 row.
        assert c.execute(text(
            "SELECT valid_from, valid_to FROM list_columns WHERE list_id = :id "
            "AND key = 'relevance_score'"), {"id": LIST_A}).all() == [(1, None)]
        assert c.execute(text(
            "SELECT count(*) FROM list_versions WHERE list_id = :id"),
            {"id": LIST_C}).scalar() == 1
        assert {str(u.date()) for u in c.execute(text(
            "SELECT updated_at FROM longlists")).scalars()} == {"2026-01-01"}
    engine.dispose()


def test_contacts_column_downgrade_keeps_lists_edited_since(engine):
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "f9a0b1c2d3e4")
    with engine.begin() as c:
        _seed_lists(c)
    with engine.connect() as c:
        before = _list_state(c)

    command.upgrade(cfg, "head")
    with engine.begin() as c:  # B is edited after the migration: version 3
        c.execute(text("UPDATE longlists SET head_version = 3 WHERE id = :id"),
                  {"id": LIST_B})
        c.execute(text(
            "INSERT INTO list_versions (list_id, number, author, message, "
            "corpus_version, changes, corpus_edits) VALUES "
            "(:id, 3, 'dev@helbling.ch', 'Edited', 7, 1, '[]')"), {"id": LIST_B})

    command.downgrade(cfg, "f9a0b1c2d3e4")
    with engine.connect() as c:
        lists, versions, columns = _list_state(c)
        assert [r for r in lists if r[0] == LIST_A] == [r for r in before[0]
                                                         if r[0] == LIST_A]
        assert [r for r in columns if r[0] == LIST_A] == [r for r in before[2]
                                                           if r[0] == LIST_A]
        assert [r[1:] for r in versions if r[0] == LIST_A] == [(1, "dev@helbling.ch")]
        assert {r[0]: r[1] for r in lists}[LIST_B] == 3
        assert _keys_at(c, LIST_B, 3) == ["name", "contacts", "website"]
        assert [r for r in lists if r[0] == LIST_C] == [r for r in before[0]
                                                         if r[0] == LIST_C]
    engine.dispose()


def test_employee_ranges_migration(engine):
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "d1e2f3a4b5c6")
    company = "00000000-0000-0000-0000-0000000000c1"
    entry = "00000000-0000-0000-0000-0000000000e1"
    edits = ('[{"entry_id": "x", "field": "employee_count", "old": 150, "new": 200},'
             ' {"entry_id": "x", "field": "revenue", "old": 1, "new": 2}]')
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO versions (id, kind, author, message, counts) VALUES "
            "(1, 'import', 'dev@helbling.ch', 'x', '{}')"))
        c.execute(text("INSERT INTO entities (id, kind, created_version_id) "
                       f"VALUES ('{company}', 'company', 1)"))
        c.execute(text(
            "INSERT INTO observations (id, entity_id, field, value, source_type, "
            "version_id) VALUES (1, :e, 'employee_count', '{\"v\": 200}', 'internal', 1),"
            " (2, :e, 'name', '{\"v\": \"Acme\"}', 'internal', 1)"), {"e": company})
        c.execute(text("INSERT INTO current_values (entity_id, field, period, "
                       "observation_id, score, sources) VALUES "
                       f"('{company}', 'employee_count', 0, 1, 0.5, 1),"
                       f"('{company}', 'name', 0, 2, 0.5, 1)"))
        c.execute(text(
            "INSERT INTO company_search (entity_id, name, employees, document) "
            f"VALUES ('{company}', 'Acme', 200, to_tsvector('simple', 'Acme'))"))
        c.execute(text(
            "INSERT INTO longlists (id, name, owner, head_version) VALUES "
            f"('{LIST_A}', 'Cedar', 'dev@helbling.ch', 1)"))
        c.execute(text(
            "INSERT INTO list_versions (list_id, number, author, message, "
            "corpus_version, changes, corpus_edits) VALUES "
            f"('{LIST_A}', 1, 'dev@helbling.ch', 'x', 1, 2, :edits)"), {"edits": edits})
        c.execute(text(
            f"INSERT INTO list_entries (id, list_id, created_version) VALUES "
            f"('{entry}', '{LIST_A}', 1)"))
        c.execute(text(
            "INSERT INTO list_entry_states (entry_id, list_id, valid_from, removed, data) "
            "VALUES "
            f"('{entry}', '{LIST_A}', 1, false, '{{\"employee_count\": 200, \"hq\": \"Bern\"}}')"))
        for position, (key, type_, source) in enumerate([
                ("name", "text", "corpus:name"), ("employee_count", "int",
                                                  "corpus:employee_count"),
                ("custom_staff", "text", "custom")]):
            c.execute(text(
                "INSERT INTO list_columns (list_id, key, label, type, position, source, "
                "valid_from) VALUES (:id, :key, :key, :type, :pos, :source, 1)"),
                {"id": LIST_A, "key": key, "type": type_, "pos": position,
                 "source": source})
        c.execute(text(
            "INSERT INTO documents (id, filename, sha256, size, storage_key, uploaded_by) "
            "VALUES ('00000000-0000-0000-0000-0000000000d1', 'x.xlsx', 'x', 1, 'k', 'dev')"))
        for imp, status in [("00000000-0000-0000-0000-0000000000a1", "report_review"),
                            ("00000000-0000-0000-0000-0000000000a2", "committed")]:
            c.execute(text(
                "INSERT INTO imports (id, document_id, status, progress, warnings, "
                "source_type, target, catalogue_version, tables, feedback, report, "
                "decisions, created_by) VALUES (:id, '00000000-0000-0000-0000-0000000000d1',"
                " :status, 1, '[]', 'internal', 'corpus', '1', '[]', '[]', "
                "'{\"kind\": \"corpus\"}', '{}', 'dev')"), {"id": imp, "status": status})

    command.upgrade(cfg, "head")
    with engine.connect() as c:
        assert c.execute(text("SELECT value FROM observations WHERE id = 1")).scalar() \
            == {"v": {"low": 200, "high": 200}}
        assert c.execute(text("SELECT value FROM observations WHERE id = 2")).scalar() \
            == {"v": "Acme"}
        assert c.execute(text("SELECT data FROM list_entry_states")).scalar() \
            == {"employee_count": {"low": 200, "high": 200}, "hq": "Bern"}
        assert c.execute(text("SELECT corpus_edits FROM list_versions")).scalar() == [
            {"entry_id": "x", "field": "employee_count",
             "old": {"low": 150, "high": 150}, "new": {"low": 200, "high": 200}},
            {"entry_id": "x", "field": "revenue", "old": 1, "new": 2}]
        assert c.execute(text(
            "SELECT employees_low, employees_high FROM company_search")).one() == (200, 200)
        assert c.execute(text("SELECT key, type FROM list_columns ORDER BY position")) \
            .all() == [("name", "text"), ("employee_count", "int_range"),
                       ("custom_staff", "text")]
        # A pending review goes back to the mapping; its report is rebuilt.
        assert c.execute(text("SELECT status, report FROM imports ORDER BY id")).all() == [
            ("mapping_review", None), ("committed", {"kind": "corpus"})]

    with engine.begin() as c:  # written by the new code: open ends
        c.execute(text(
            "INSERT INTO observations (id, entity_id, field, value, source_type, "
            "version_id) VALUES (3, :e, 'employee_count', "
            "'{\"v\": {\"low\": null, \"high\": 9}}', 'internal', 1), "
            "(4, :e, 'employee_count', '{\"v\": {\"low\": null, \"high\": null}}', "
            "'internal', 1)"), {"e": company})
        c.execute(text(
            "UPDATE list_entry_states SET data = data || "
            "'{\"employee_count\": {\"low\": null, \"high\": 9}}'"))
        c.execute(text(
            "UPDATE list_versions SET corpus_edits = jsonb_build_array("
            "'{\"field\": \"employee_count\", \"old\": {\"low\": null, \"high\": 9}, "
            "\"new\": {\"low\": null, \"high\": null}}'::jsonb)"))

    command.downgrade(cfg, "d1e2f3a4b5c6")
    with engine.connect() as c:
        assert c.execute(text("SELECT value FROM observations WHERE id = 1")).scalar() \
            == {"v": 200}
        assert c.execute(text("SELECT value FROM observations WHERE id = 3")).scalar() \
            == {"v": 9}
        assert c.execute(text("SELECT value FROM observations WHERE id = 4")).scalar() \
            == {"v": {"low": None, "high": None}}
        assert c.execute(text("SELECT data FROM list_entry_states")).scalar() \
            == {"employee_count": 9, "hq": "Bern"}
        assert c.execute(text("SELECT corpus_edits->0 FROM list_versions")).scalar() \
            == {"field": "employee_count", "old": 9,
                "new": {"low": None, "high": None}}
        assert c.execute(text("SELECT employees FROM company_search")).scalar() == 200
        assert c.execute(text(
            "SELECT type FROM list_columns WHERE key = 'employee_count'")).scalar() == "int"
    engine.dispose()
