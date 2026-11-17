"""The longlists migration moves lists made by imports (list_entry entities
with relevance observations) into the list tables, on its own database."""

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

ADMIN = "postgresql://helios:helios@localhost:5433/helios"
URL = "postgresql+psycopg://helios:helios@localhost:5433/helios_migration"


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

    command.upgrade(cfg, "head")
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
