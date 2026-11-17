"""Creates the Helbling team's accounts with generated passwords.

    uv run python -m app.seed_users                      # create missing users
    uv run python -m app.seed_users --reset a@helbling.ch  # new password for one

Existing users keep their password. New passwords are printed and appended to
`.seed-users.local` (git-ignored) next to `.env`. Local development only.
"""

import argparse
from datetime import UTC, datetime

from sqlalchemy import select

from app.auth import generate_password, hash_password
from app.config import ROOT
from app.db import session_scope
from app.models import AuthSession, User

PASSWORD_FILE = ROOT / ".seed-users.local"

# (email, name, role). Vanya is the only dev (a dev is also an admin), as in
# the frontend's earlier allowlist; the other roles follow Settings → Members.
TEAM = [
    ("vanya.brucker@helbling.ch", "Vanya Brucker", "dev"),
    ("malte.jantz@helbling.ch", "Malte Jantz", "admin"),
    ("ivor.kramer@helbling.ch", "Ivor Kramer", "admin"),
    ("gabriel.schmidhaeusler@helbling.ch", "Gabriel Schmidhäusler", "member"),
    ("nicolas.gubler@helbling.ch", "Nicolas Gubler", "admin"),
    ("eduard.dorzweiler@helbling.ch", "Eduard Dorzweiler", "admin"),
]


def seed(reset: set[str]) -> list[tuple[str, str]]:
    """Creates missing users and resets the named ones; returns new passwords."""
    issued = []
    with session_scope() as session:
        for email, name, role in TEAM:
            user = session.scalar(select(User).where(User.email == email))
            if user is not None and email not in reset:
                continue
            password = generate_password()
            if user is None:
                session.add(User(email=email, name=name, role=role,
                                 language="en", password_hash=hash_password(password)))
            else:
                user.password_hash = hash_password(password)
                # A reset signs the user out everywhere.
                session.query(AuthSession).filter_by(user_id=user.id).delete()
            issued.append((email, password))
    return issued


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--reset", action="append", default=[], metavar="EMAIL",
                        help="issue a new password for this user (repeatable)")
    args = parser.parse_args()
    reset = {e.strip().lower() for e in args.reset}
    unknown = reset - {e for e, *_ in TEAM}
    if unknown:
        parser.error(f"not in the team list: {', '.join(sorted(unknown))}")

    issued = seed(reset)
    if not issued:
        print("Every user exists already; nothing changed.")
        return
    stamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    with PASSWORD_FILE.open("a") as f:
        f.write(f"# {stamp}\n")
        for email, password in issued:
            f.write(f"{email}  {password}\n")
    PASSWORD_FILE.chmod(0o600)
    print(f"{len(issued)} password(s) written to {PASSWORD_FILE}")


if __name__ == "__main__":
    main()
