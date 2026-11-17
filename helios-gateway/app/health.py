"""Liveness, readiness and version endpoints. None of them need the gateway
secret, so a platform or a dev can call them without credentials.

- `/health`: the process is up. Never touches anything else, so an outage of
  Postgres or storage never gets the gateway restarted.
- `/health/ready`: Postgres, storage and the schema are usable (200 or 503).
- `/version`: what code, catalogue and schema this process runs.

The LLM is deliberately not checked: calling it costs money and fails on
every provider hiccup, and a missing key already stops startup (config.py).
"""

import os
import subprocess
import tomllib
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from functools import cache

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import storage
from app.catalogue import CATALOGUE_VERSION
from app.config import ROOT
from app.db import engine

TIMEOUT_SECONDS = 2

router = APIRouter()
# Checks run here so a hung dependency can't hold the request past the timeout.
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="health")


@cache
def schema_head() -> str:
    """The newest migration in the code."""
    script = ScriptDirectory.from_config(Config(ROOT / "alembic.ini"))
    return script.get_current_head() or "none"


def _db() -> str | None:
    """Pings Postgres; returns the schema revision it's at."""
    with engine.connect() as conn:
        conn.execute(text(f"SET LOCAL statement_timeout = {TIMEOUT_SECONDS * 1000}"))
        conn.execute(text("SELECT 1"))
        if conn.execute(text("SELECT to_regclass('alembic_version')")).scalar() is None:
            return None  # never migrated
        return conn.execute(text("SELECT version_num FROM alembic_version")).scalar()


def _error(e: BaseException) -> str:
    if isinstance(e, FutureTimeout):
        return f"no answer within {TIMEOUT_SECONDS}s"
    return str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__


@router.get("/health")
def health() -> dict:
    return {"ok": True}


@router.get("/health/ready")
def ready() -> JSONResponse:
    db = _pool.submit(_db)
    bucket = _pool.submit(storage.ping, TIMEOUT_SECONDS)
    status: dict[str, str] = {}
    detail: dict[str, str] = {}

    try:
        revision = db.result(timeout=TIMEOUT_SECONDS + 0.5)
        status["db"] = "ok"
        head = schema_head()
        if revision == head:
            status["migrations"] = "ok"
        else:
            status["migrations"] = "behind"
            detail["migrations"] = (
                f"database at {revision or 'no revision'}, code at {head}; "
                "run `uv run alembic upgrade head`"
            )
    except Exception as e:  # noqa: BLE001 - any failure means "down"
        status["db"] = "down"
        status["migrations"] = "unknown"
        detail["db"] = _error(e)

    try:
        bucket.result(timeout=TIMEOUT_SECONDS + 0.5)
        status["storage"] = "ok"
    except Exception as e:  # noqa: BLE001 - any failure means "down"
        status["storage"] = "down"
        detail["storage"] = _error(e)

    body: dict = {**status}
    if detail:
        body["detail"] = detail
    return JSONResponse(body, status_code=503 if detail else 200)


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=2,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip()


@cache
def build_info() -> dict:
    """Read once per process. GIT_COMMIT overrides git for deployments that
    ship without a .git folder."""
    with (ROOT / "pyproject.toml").open("rb") as f:
        version = tomllib.load(f)["project"]["version"]
    commit = os.environ.get("GIT_COMMIT") or _git("rev-parse", "--short", "HEAD")
    dirty = None
    if not os.environ.get("GIT_COMMIT") and commit:
        dirty = bool(_git("status", "--porcelain", "--", "."))
    return {
        "version": version,
        "commit": commit,
        "dirty": dirty,
        "catalogue": CATALOGUE_VERSION,
        "schema": schema_head(),
    }


@router.get("/version")
def version() -> dict:
    return build_info()
