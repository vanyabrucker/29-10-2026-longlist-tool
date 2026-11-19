"""The frozen world: a snapshot of the dev corpus that every compared run sees.

    uv run python -m evals.db refresh            # dump dev → helios_eval_base → helios_eval
    uv run python -m evals.db refresh --dump F   # restore an existing dump instead
    uv run python -m evals.db reset              # helios_eval = a fresh copy of the base

`refresh` dumps the dev database (read-only `pg_dump` inside the docker
Postgres container), restores it into `helios_eval_base`, migrates it to this
branch's head and removes every chat (chats are private; the dataset holds
the chosen ones) and login session. `reset` recreates `helios_eval` from that
base as a Postgres template, in about a second, so each run starts from the
same data even though replays create lists (and may edit corpus facts). The
eval task resets before it runs unless told not to.

The dev database is only ever read. Nothing here touches the gateway ports.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import psycopg
from sqlalchemy.engine import make_url

from evals.env import DATA_DIR, GATEWAY, SAFE_PREFIXES, eval_database_url

COMPOSE = ["docker", "compose", "-f", str(GATEWAY / "docker-compose.yml")]
SCRUB = "TRUNCATE session_events, sessions, auth_sessions CASCADE"


def _names() -> tuple[str, str]:
    name = make_url(eval_database_url()).database or ""
    if not name.startswith(SAFE_PREFIXES):
        raise SystemExit(f"Eval database must be named helios_eval*, not {name!r}.")
    return name, f"{name}_base"


def _admin_dsn() -> str:
    url = make_url(eval_database_url()).set(drivername="postgresql", database="postgres")
    return url.render_as_string(hide_password=False)


def _pg(*args: str, stdin=None, stdout=None) -> None:
    """Run a Postgres client tool inside the docker-compose container, so no
    local Postgres install (or version match) is needed."""
    user = make_url(eval_database_url()).username or "helios"
    subprocess.run([*COMPOSE, "exec", "-T", "postgres", *args, "-U", user],
                   stdin=stdin, stdout=stdout, check=True)


def _recreate(name: str, template: str | None = None) -> None:
    with psycopg.connect(_admin_dsn(), autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{name}"'
                     + (f' TEMPLATE "{template}"' if template else ""))


def _database_url(name: str) -> str:
    return make_url(eval_database_url()).set(database=name).render_as_string(
        hide_password=False)


def dump(source: str, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        _pg("pg_dump", "-Fc", "--no-owner", "-d", source, stdout=f)
    print(f"Dumped {source} → {out} ({out.stat().st_size // 1024} KB)")
    return out


def restore_base(dump_file: Path) -> None:
    _, base = _names()
    _recreate(base)
    with dump_file.open("rb") as f:
        _pg("pg_restore", "--no-owner", "--exit-on-error", "-d", base, stdin=f)
    env = {**os.environ, "DATABASE_URL": _database_url(base)}
    migrated = subprocess.run(["uv", "run", "alembic", "upgrade", "head"], cwd=GATEWAY,
                              env=env, check=False)
    if migrated.returncode:
        print("Warning: couldn't migrate the snapshot to this branch's head (is the "
              "dev database on a newer migration?). Replays may fail.", file=sys.stderr)
    with psycopg.connect(_database_url(base).replace("+psycopg", ""), autocommit=True) as c:
        c.execute(SCRUB)
    print(f"Restored {dump_file.name} into {base} (chats and logins removed)")


def reset() -> str:
    """helios_eval as a fresh copy of the base snapshot."""
    name, base = _names()
    with psycopg.connect(_admin_dsn(), autocommit=True) as conn:
        found = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s",
                             (base,)).fetchone()
    if not found:
        raise SystemExit(f"No {base} yet: run `uv run python -m evals.db refresh`.")
    _recreate(name, template=base)
    return name


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m evals.db", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("refresh", help="snapshot the dev corpus into the eval base")
    r.add_argument("--source", default="helios", help="database to dump (read only)")
    r.add_argument("--dump", type=Path, help="restore this dump instead of dumping")
    sub.add_parser("reset", help="recreate helios_eval from the base")
    args = p.parse_args(argv)

    if args.cmd == "refresh":
        dump_file = args.dump or dump(args.source,
                                      DATA_DIR / f"corpus-{date.today():%Y-%m-%d}.dump")
        restore_base(dump_file)
    print(f"Reset {reset()} from the snapshot")


if __name__ == "__main__":
    main()
