"""Integration tests run against a separate `helios_test` database (created
and migrated here) on the docker-compose Postgres, and the local object store.
The LLM is replaced by a rule-based stand-in and embeddings by a word-hashing
fake (embedded synchronously after each commit), so no API key is needed.

`HELIOS_TEST_PG` points the tests at another Postgres server (it needs
pgvector), e.g. a worktree's own container."""

import hashlib
import math
import os
import re

import pytest

PG = os.environ.get("HELIOS_TEST_PG", "postgresql://helios:helios@localhost:5433")
TEST_DB = PG.replace("postgresql://", "postgresql+psycopg://") + "/helios_test"
os.environ["DATABASE_URL"] = TEST_DB
os.environ["S3_BUCKET"] = "helios-test"
# Startup requires LLM / agent / Exa keys; tests replace the LLM and Exa.
os.environ.setdefault("DEEPSEEK_API_KEY", "test")
os.environ.setdefault("AZURE_FOUNDRY_ENDPOINT", "https://example.test/openai/v1")
os.environ.setdefault("AZURE_FOUNDRY_KEY", "test")
os.environ.setdefault("AZURE_FOUNDRY_DEPLOYMENT_NAME", "test-model")
os.environ.setdefault("EXA_API_KEY", "test")
os.environ.setdefault("EXPORT_SECRET", "test-export-secret-0123456789abcdef")
os.environ.setdefault("AZURE_FOUNDRY_EMBEDDING_DEPLOYMENT_NAME", "test-embedding")
os.environ["EMBED_IN_BACKGROUND"] = "false"


class FakeEmbedder:
    """Bag of words hashed into the vector (crude 5-letter stems), so texts
    sharing words are close and unrelated ones orthogonal. No network."""

    model = "fake-embedding"

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str], quick: bool = False) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self.vector(t) for t in texts]

    @staticmethod
    def vector(text: str) -> list[float]:
        v = [0.0] * 1536
        for word in re.findall(r"\w+", text.lower()):
            if len(word) < 3:
                continue
            h = int(hashlib.md5(word[:5].encode()).hexdigest(), 16)
            v[h % 1536] += 1.0
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / norm for x in v]


FAKE_EMBEDDER = FakeEmbedder()


def _install_fake_embeddings() -> None:
    from app import embeddings, llm

    llm.embedder = lambda: FAKE_EMBEDDER
    # Embed right after each commit instead of in a background thread.
    embeddings.wake = lambda: embeddings.embed_pending()


_install_fake_embeddings()


def _database_ready() -> bool:
    import psycopg

    try:
        with psycopg.connect(
            f"{PG}/helios", autocommit=True,
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
            "TRUNCATE list_export_cells, list_exports, company_search, value_pins, current_values, observations, "
            "list_entry_states, list_columns, list_entries, list_versions, entities, "
            "raw_rows, imports, versions, longlists, documents, "
            "session_events, sessions CASCADE"))
