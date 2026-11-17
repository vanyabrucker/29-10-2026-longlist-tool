"""Password login, sessions, the profile and who may use the import area."""

import pytest
from fastapi.testclient import TestClient

from tests.conftest import add_user, sign_in


@pytest.fixture
def client(database):
    from app.main import app

    add_user("member@helbling.ch", name="Mia Member")
    add_user("admin@helbling.ch", role="admin")
    add_user("dev@helbling.ch", role="dev")
    with TestClient(app) as c:
        yield c


def test_password_hash_roundtrip():
    from app.auth import hash_password, verify_password

    stored = hash_password("correct horse")
    assert stored.startswith("scrypt$")
    assert verify_password("correct horse", stored)
    assert not verify_password("wrong horse", stored)
    assert not verify_password("anything", "not-a-hash")
    assert hash_password("same") != hash_password("same")  # salted


def test_login_profile_logout(client):
    assert client.get("/me").status_code == 401

    wrong = client.post("/auth/login",
                        json={"email": "member@helbling.ch", "password": "nope"})
    unknown = client.post("/auth/login",
                          json={"email": "ghost@helbling.ch", "password": "nope"})
    # Same answer for a wrong password and an unknown email.
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()

    # Email is case-insensitive.
    sign_in(client, "Member@Helbling.ch")
    me = client.get("/me").json()
    assert me["email"] == "member@helbling.ch" and me["name"] == "Mia Member"
    assert me["role"] == "member" and "password_hash" not in me
    assert me["is_admin"] is False and me["is_dev"] is False

    r = client.patch("/me", json={"name": "  Mia M.  ", "language": "de"})
    assert r.status_code == 200
    me = client.get("/me").json()
    assert (me["name"], me["language"]) == ("Mia M.", "de")
    assert client.patch("/me", json={"language": "fr"}).status_code == 422
    assert client.patch("/me", json={"name": "   "}).status_code == 422

    assert client.post("/auth/logout").status_code == 204
    assert client.get("/me").status_code == 401


def test_import_area_is_dev_only(client):
    sign_in(client, "member@helbling.ch")
    assert client.get("/imports").status_code == 403
    assert client.get("/catalogue").status_code == 200  # reading is for everyone

    sign_in(client, "admin@helbling.ch")
    assert client.get("/imports").status_code == 403

    # A dev holds admin rights too.
    sign_in(client, "dev@helbling.ch")
    me = client.get("/me").json()
    assert me["is_admin"] is True and me["is_dev"] is True
    assert client.get("/imports").status_code == 200


def test_expired_session_is_rejected(client):
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    from app.db import session_scope
    from app.models import AuthSession

    sign_in(client, "member@helbling.ch")
    with session_scope() as session:
        session.execute(update(AuthSession).values(
            expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    assert client.get("/me").status_code == 401


def test_gateway_secret_is_checked(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings(), "gateway_secret", "s3cret")
    body = {"email": "member@helbling.ch", "password": "test-password"}
    assert client.post("/auth/login", json=body).status_code == 401
    r = client.post("/auth/login", json=body, headers={"X-Gateway-Secret": "s3cret"})
    assert r.status_code == 200


def test_admins_add_and_remove_members(client):
    sign_in(client, "member@helbling.ch")
    assert client.get("/users").status_code == 200  # everyone sees the team
    body = {"email": "new.person@helbling.ch", "role": "member"}
    assert client.post("/users", json=body).status_code == 403

    sign_in(client, "admin@helbling.ch")
    r = client.post("/users", json={"email": " New.Person@helbling.ch ", "role": "admin"})
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["user"]["email"] == "new.person@helbling.ch"
    assert created["user"]["name"] == "New Person"
    assert created["user"]["role"] == "admin" and len(created["password"]) >= 12
    # The password is shown once: listings never include it.
    assert "password" not in str(client.get("/users").json())

    assert client.post("/users", json=body).status_code == 409
    assert client.post("/users", json={"email": "nope", "role": "member"}).status_code == 422
    assert client.post("/users", json={"email": "x@helbling.ch", "role": "dev"}) \
        .status_code == 422

    # The new account can sign in with the generated password.
    other = TestClient(client.app)
    sign_in(other, "new.person@helbling.ch", created["password"])

    # Admins can't remove themselves or a dev; removing signs the user out.
    assert client.delete(f"/users/{_id(client, 'admin@helbling.ch')}").status_code == 409
    assert client.delete(f"/users/{_id(client, 'dev@helbling.ch')}").status_code == 403
    assert client.delete(f"/users/{created['user']['id']}").status_code == 204
    assert other.get("/me").status_code == 401
    assert _id(client, "new.person@helbling.ch") is None


def _id(client, email):
    return next((u["id"] for u in client.get("/users").json() if u["email"] == email),
                None)
