"""Users, password login and sessions.

The frontend's login route posts email and password to `/auth/login` and keeps
the returned token in an httpOnly cookie; its gateway proxy sends it back as
`Authorization: Bearer <token>`. The browser never sees the token in script.
Passwords are scrypt hashes (stdlib, no extra dependency).
"""

import hashlib
import hmac
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_session
from app.models import AuthSession, User

SESSION_DAYS = 30
# scrypt cost: 2^14 × 8 × 128 B = 16 MiB and ~50 ms per check.
_N, _R, _P, _DKLEN = 2**14, 8, 1, 32

Db = Annotated[Session, Depends(get_session)]


# ── Passwords and tokens ───────────────────────────────────────────────────


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${key.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        kind, n, r, p, salt, key = stored.split("$")
        if kind != "scrypt":
            return False
        expected = bytes.fromhex(key)
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),
                             n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except ValueError:
        return False
    return hmac.compare_digest(got, expected)


# Checked when the email is unknown, so a wrong email takes as long as a
# wrong password and doesn't reveal which accounts exist.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def generate_password() -> str:
    return secrets.token_urlsafe(12)


# ── Dependencies ───────────────────────────────────────────────────────────


def check_secret(x_gateway_secret: Annotated[str | None, Header()] = None) -> None:
    """The shared secret between frontend and gateway (when configured)."""
    secret = settings().gateway_secret
    if secret and not hmac.compare_digest(x_gateway_secret or "", secret):
        raise HTTPException(401, "Missing or wrong gateway secret.")


def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip() or None
    return None


def current_user(
    session: Db,
    _: Annotated[None, Depends(check_secret)],
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    token = _bearer(authorization)
    row = session.get(AuthSession, _token_hash(token)) if token else None
    if row is None or row.expires_at <= datetime.now(UTC):
        raise HTTPException(401, "Not signed in.")
    user = session.get(User, row.user_id)
    if user is None:
        raise HTTPException(401, "Not signed in.")
    return user


def dev_email(user: Annotated[User, Depends(current_user)]) -> str:
    """The signed-in user's email, if they may use the import area."""
    if not user.is_dev:
        raise HTTPException(403, "Only devs can use the import area.")
    return user.email


def admin_user(user: Annotated[User, Depends(current_user)]) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Only admins can manage members.")
    return user


SignedIn = Annotated[User, Depends(current_user)]
Admin = Annotated[User, Depends(admin_user)]
Dev = Annotated[str, Depends(dev_email)]


# ── Endpoints ──────────────────────────────────────────────────────────────

router = APIRouter()


def public(user: User) -> dict:
    return {"id": str(user.id), "email": user.email, "name": user.name,
            "role": user.role, "is_admin": user.is_admin, "is_dev": user.is_dev,
            "language": user.language}


class Login(BaseModel):
    email: str = Field(max_length=255)
    password: str = Field(max_length=200)


@router.post("/auth/login", dependencies=[Depends(check_secret)])
def login(body: Login, session: Db) -> dict:
    user = session.scalar(select(User).where(User.email == body.email.strip().lower()))
    ok = verify_password(body.password, user.password_hash if user else _DUMMY_HASH)
    if user is None or not ok:
        raise HTTPException(401, "Wrong email or password.")
    now = datetime.now(UTC)
    token = secrets.token_urlsafe(32)
    expires = now + timedelta(days=SESSION_DAYS)
    session.execute(delete(AuthSession).where(AuthSession.expires_at <= now))
    session.add(AuthSession(token_hash=_token_hash(token), user_id=user.id,
                            expires_at=expires))
    user.last_login_at = now
    return {"token": token, "expires_at": expires.isoformat(), "user": public(user)}


@router.post("/auth/logout", status_code=204, dependencies=[Depends(check_secret)])
def logout(
    session: Db, authorization: Annotated[str | None, Header()] = None
) -> Response:
    token = _bearer(authorization)
    if token:
        session.execute(
            delete(AuthSession).where(AuthSession.token_hash == _token_hash(token))
        )
    return Response(status_code=204)


@router.get("/me")
def me(user: SignedIn) -> dict:
    return public(user)


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    language: Literal["en", "de"] | None = None


@router.patch("/me")
def update_me(body: ProfileUpdate, user: SignedIn) -> dict:
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(422, "The name can't be empty.")
        user.name = name
    if body.language is not None:
        user.language = body.language
    return public(user)


# ── Members ────────────────────────────────────────────────────────────────

# Higher ranks hold the rights of lower ones; nobody can remove a user who
# outranks them (an admin can't remove a dev).
RANK = {"member": 0, "admin": 1, "dev": 2}
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def name_from_email(email: str) -> str:
    """"Ivor Kramer" from ivor.kramer@helbling.ch; users can rename themselves."""
    local = email.split("@")[0]
    return " ".join(w.capitalize() for w in re.split(r"[._-]+", local) if w) or email


@router.get("/users")
def list_users(_: SignedIn, session: Db) -> list[dict]:
    rows = session.scalars(select(User).order_by(User.name)).all()
    return [public(u) | {"created_at": u.created_at.isoformat(),
                         "last_login_at": u.last_login_at.isoformat()
                         if u.last_login_at else None} for u in rows]


class NewUser(BaseModel):
    email: str = Field(max_length=255)
    role: Literal["member", "admin"]


@router.post("/users", status_code=201)
def add_user(body: NewUser, _: Admin, session: Db) -> dict:
    """Creates the account with a generated password, returned only here."""
    email = body.email.strip().lower()
    if not _EMAIL.match(email):
        raise HTTPException(422, "That isn't a valid email address.")
    if session.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "A user with this email exists already.")
    password = generate_password()
    user = User(email=email, name=name_from_email(email), role=body.role,
                language="en", password_hash=hash_password(password))
    session.add(user)
    session.flush()
    return {"user": public(user), "password": password}


@router.delete("/users/{user_id}", status_code=204)
def remove_user(user_id: uuid.UUID, actor: Admin, session: Db) -> Response:
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(404, "User not found.")
    if user.id == actor.id:
        raise HTTPException(409, "You can't remove yourself.")
    if RANK[user.role] > RANK[actor.role]:
        raise HTTPException(403, "You can't remove someone with a higher role.")
    session.delete(user)  # their sessions go with them (ON DELETE CASCADE)
    return Response(status_code=204)
