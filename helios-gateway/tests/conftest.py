"""Integration tests run against a separate `helios_test` database (created
and migrated here) on the docker-compose Postgres, and the local object store.
The LLM is replaced by a rule-based stand-in, so no API key is needed."""

import os

import pytest

TEST_DB = "postgresql+psycopg://helios:helios@localhost:5433/helios_test"
os.environ["DATABASE_URL"] = TEST_DB
os.environ["S3_BUCKET"] = "helios-test"


def _database_ready() -> bool:
    import psycopg

    try:
        with psycopg.connect(
            "postgresql://helios:helios@localhost:5433/helios", autocommit=True,
            connect_timeout=3,
        ) as conn:
            conn.execute("DROP DATABASE IF EXISTS helios_test WITH (FORCE)")
            conn.execute("CREATE DATABASE helios_test")
        return True
    except Exception:
        return False


@pytest.fixture(scope="session")
def database():
    if not _database_ready():
        pytest.skip("Postgres from docker-compose isn't running")
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config("alembic.ini"), "head")
    yield


@pytest.fixture
def fake_llm(monkeypatch):
    """Map columns by catalogue synonyms; table detection falls back to the
    heuristic; unknown enum values get no fix."""
    from app import llm
    from app.catalogue import CATALOGUE
    from app.ingest import mapping

    def no_llm(*_a, **_k):
        raise llm.LLMError("no LLM in tests")

    def by_synonyms(table, rows, filename, feedback):
        cols = []
        for c in table["columns"]:
            header = c["header"].split(" / ")[-1].lower()
            field = next(
                (p.key for p in CATALOGUE.values()
                 if header in {s.lower() for s in (*p.synonyms, p.label, p.key)}),
                None,
            )
            cols.append(mapping.ColumnMapping(letter=c["letter"], field=field,
                                              confidence=0.9 if field else 0))
        return mapping.apply(table["columns"], mapping.TableMapping(columns=cols)), ""

    monkeypatch.setattr(llm, "ask", no_llm)
    monkeypatch.setattr(mapping, "propose", by_synonyms)
