"""The eval database: where replays run, never the dev database.

`point_at_eval_db()` must run before anything imports `app.db` (its engine is
bound at import), so the eval task calls it first. `assert_eval_db()` then
refuses to run against any database whose name doesn't start with
`helios_eval` (or `helios_test`, for the smoke test).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from sqlalchemy.engine import make_url

HERE = Path(__file__).resolve().parent
GATEWAY = HERE.parent
DATA_DIR = HERE / "data"  # git-ignored: chats are private
CACHE_DIR = HERE / "cache"  # git-ignored: web results
LOG_DIR = HERE / "logs"  # git-ignored: Inspect logs

DEFAULT_EVAL_DB = "postgresql+psycopg://helios:helios@localhost:5433/helios_eval"
SAFE_PREFIXES = ("helios_eval", "helios_test")


def eval_database_url() -> str:
    return os.environ.get("HELIOS_EVAL_DATABASE_URL") or DEFAULT_EVAL_DB


def point_at_eval_db() -> None:
    """Make the gateway use the eval database (a no-op once `app.db` is
    imported; `assert_eval_db` catches that case)."""
    if "app.db" not in sys.modules:
        os.environ["DATABASE_URL"] = eval_database_url()


def assert_eval_db() -> str:
    from app.db import engine

    name = engine.url.database or ""
    if not name.startswith(SAFE_PREFIXES):
        raise RuntimeError(
            f"Refusing to run an eval against database {name!r}: replays create "
            "chats and lists, so they only run in a database named helios_eval* "
            "(set HELIOS_EVAL_DATABASE_URL).")
    return name


def database_name(url: str) -> str:
    return make_url(url).database or ""
