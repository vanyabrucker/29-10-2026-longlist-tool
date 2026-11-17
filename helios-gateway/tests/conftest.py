"""Integration tests run against a separate `helios_test` database (created
and migrated here) on the docker-compose Postgres, and the local object store.
The LLM is replaced by a rule-based stand-in, so no API key is needed."""

import os

import pytest

TEST_DB = "postgresql+psycopg://helios:helios@localhost:5433/helios_test"
os.environ["DATABASE_URL"] = TEST_DB
os.environ["S3_BUCKET"] = "helios-test"
# Startup requires an LLM key; tests replace the LLM, so any value will do.
os.environ.setdefault("DEEPSEEK_API_KEY", "test")


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
    except psycopg.Error:
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
    install_fake_llm(monkeypatch)


def install_fake_llm(monkeypatch) -> None:
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


def add_user(email: str, password: str = "test-password", *, role: str = "member",
             name: str = "Test User") -> None:
    """Creates (or recreates) a user in the test database."""
    from sqlalchemy import delete

    from app.auth import hash_password
    from app.db import session_scope
    from app.models import User

    with session_scope() as session:
        session.execute(delete(User).where(User.email == email))
        session.add(User(email=email, name=name, role=role,
                         language="en", password_hash=hash_password(password)))


def sign_in(client, email: str, password: str = "test-password") -> str:
    """Logs in through the API and sends the token on every later request."""
    r = client.post("/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    client.headers["Authorization"] = f"Bearer {token}"
    return token


def clear_corpus() -> None:
    """Empties imports, versions and all master data (users stay), so a test
    starts from an empty corpus."""
    from sqlalchemy import text

    from app.db import session_scope

    with session_scope() as session:
        session.execute(text(
            "TRUNCATE company_search, value_pins, current_values, observations, "
            "list_entry_states, list_columns, list_entries, list_versions, entities, "
            "raw_rows, imports, versions, longlists, documents CASCADE"))
