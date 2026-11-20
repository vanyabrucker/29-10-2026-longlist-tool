"""Contacts: writing them as corpus records (people, roles, relationships)
and reading them back (company contacts, /contacts, contact page)."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from tests.conftest import add_user, clear_corpus, install_fake_llm, sign_in
from tests.test_flow import run_import


@pytest.fixture(scope="module")
def corpus_with_company(database):
    """The internal sample list imported once; yields the app."""
    from app.main import app

    clear_corpus()
    add_user("dev@helbling.ch", role="dev")
    add_user("vanya@helbling.ch", name="Vanya Brucker")
    add_user("member@helbling.ch")
    patch = pytest.MonkeyPatch()
    install_fake_llm(patch)
    with TestClient(app) as c:
        sign_in(c, "dev@helbling.ch")
        run_import(c, "internal_longlist.xlsx")
    patch.undo()
    return app


@pytest.fixture
def dev(corpus_with_company):
    with TestClient(corpus_with_company) as c:
        sign_in(c, "dev@helbling.ch")
        yield c


@pytest.fixture
def company_id(dev):
    items = dev.get("/companies", params={"q": "BWK"}).json()["items"]
    return items[0]["id"]


def test_write_contacts_makes_people_roles_and_relationships(dev, company_id):
    import uuid

    from app.db import session_scope
    from app.models import Entity
    from app.seed_contacts import ContactSpec, write_contacts

    with session_scope() as s:
        v = write_contacts(s, [ContactSpec(
            company_id=uuid.UUID(company_id), first_name="Anna", last_name="Muster",
            email="anna@bwk.de", title="Head of M&A", known_by=("Vanya Brucker",))],
            "test@helbling.ch")
        kinds = sorted(e.kind for e in s.query(Entity).filter(Entity.created_version_id == v.id))
    assert kinds == ["person", "relationship", "role"]


def test_reverting_contacts_retracts_everything(dev, company_id):
    import uuid
    from datetime import date

    from app.db import session_scope
    from app.models import CurrentValue, Entity, Observation
    from app.seed_contacts import ContactSpec, write_contacts

    with session_scope() as s:
        v = write_contacts(s, [ContactSpec(
            company_id=uuid.UUID(company_id), first_name="Rita", last_name="Alt",
            function="CFO", primary=True, known_by=("Vanya Brucker", "Thomas Keller"),
            end_date=date(2024, 5, 1))], "test@helbling.ch")
        vid = v.id
        ids = list(s.scalars(select(Entity.id).where(Entity.created_version_id == vid)))
        assert s.query(CurrentValue).filter(CurrentValue.entity_id.in_(ids)).count() > 0
        role_fields = {o.field: o.value for o in s.query(Observation).filter(
            Observation.version_id == vid)}
        assert role_fields["is_primary_contact"] == {"v": True}
        assert role_fields["end_date"] == {"v": {"date": "2024-05-01", "precision": "day"}}
    assert dev.get("/versions").json()[0]["id"] == vid
    assert dev.post(f"/versions/{vid}/revert").status_code == 200
    with session_scope() as s:
        assert s.query(CurrentValue).filter(CurrentValue.entity_id.in_(ids)).count() == 0
        assert s.query(Observation).filter(
            Observation.version_id == vid, Observation.retracted_version_id.is_(None)
        ).count() == 0


def test_values_are_normalized_like_imports(dev, company_id):
    import uuid

    from app.db import session_scope
    from app.ingest.normalize import Invalid
    from app.models import Observation
    from app.seed_contacts import ContactSpec, write_contacts

    cid = uuid.UUID(company_id)
    with session_scope() as s:
        v = write_contacts(s, [ContactSpec(
            company_id=cid, first_name="Ben", last_name="Norm", email="  Ben.Norm@BWK.de ",
            phone="+41 44 123 45 67", function="CFO",
            known_by=("Vanya Brucker", "Vanya Brucker"))], "test@helbling.ch")
        got = {}
        for o in s.query(Observation).filter(Observation.version_id == v.id):
            got.setdefault(o.field, []).append(o.value["v"])
        assert got["email"] == ["ben.norm@bwk.de"]
        assert got["phone"] == ["+41441234567"]
        assert got["helbling_person"] == ["Vanya Brucker"]
        assert v.counts["values"] == sum(len(x) for x in got.values())
        with pytest.raises(Invalid):
            write_contacts(s, [ContactSpec(company_id=cid, first_name="X", last_name="Y",
                                           function="Wizard")], "test@helbling.ch")
        s.rollback()


# ── Reading contacts ───────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def seeded(corpus_with_company):
    """Petra Lang (primary, known by Vanya twice over and a former colleague),
    Ida Kurz (name only) and Tom Jansen (role ended) at BWK."""
    import uuid
    from datetime import date

    from app.db import session_scope
    from app.seed_contacts import ContactSpec, write_contacts

    with TestClient(corpus_with_company) as c:
        sign_in(c, "dev@helbling.ch")
        cid = c.get("/companies", params={"q": "BWK"}).json()["items"][0]["id"]
    company = uuid.UUID(cid)
    with session_scope() as s:
        write_contacts(s, [
            ContactSpec(company_id=company, first_name="Petra", last_name="Lang",
                        email="Petra.Lang@BWK.de", phone="+49 30 123 45 67",
                        title="Head of M&A", function="M&A", primary=True,
                        known_by=("vanya@helbling.ch", "VANYA BRUCKER", "Thomas Keller")),
            ContactSpec(company_id=company, first_name="Ida", last_name="Kurz"),
            ContactSpec(company_id=company, first_name="Tom", last_name="Jansen",
                        title="CFO", end_date=date(2024, 5, 1)),
        ], "test@helbling.ch")
    return cid


@pytest.fixture
def member(corpus_with_company):
    with TestClient(corpus_with_company) as c:
        sign_in(c, "member@helbling.ch")
        yield c


def _company_contact(member, cid, name):
    items = member.get(f"/companies/{cid}").json()["contacts"]
    return next(i for i in items if i["name"] == name)


def _contact_id(member, name):
    items = member.get("/contacts", params={"q": name}).json()["items"]
    return next(i["id"] for i in items if i["name"] == name)


def test_company_contacts_order_and_shape(member, seeded):
    body = member.get(f"/companies/{seeded}").json()
    assert "people" not in body
    # Person, role and relationship data points live on their own entities.
    assert not {c["field"] for c in body["cells"]} & {
        "first_name", "last_name", "full_name", "email", "phone", "title", "function",
        "end_date", "is_primary_contact", "helbling_person"}
    item = body["contacts"][0]
    assert item["name"] == "Petra Lang"
    assert (item["first_name"], item["last_name"]) == ("Petra", "Lang")
    assert item["email"] == "petra.lang@bwk.de" and item["phone"] == "+49301234567"
    assert item["role"] == {
        "id": item["role"]["id"], "company_id": seeded, "company_name": item["role"]["company_name"],
        "title": "Head of M&A", "function": "M&A", "primary": True, "current": True}
    assert "BWK" in item["role"]["company_name"]
    assert item["role"] in item["roles"]
    # The email and the name of the same member count once.
    assert item["known_by"] == [
        {"name": "Thomas Keller", "email": None, "user": False},
        {"name": "Vanya Brucker", "email": "vanya@helbling.ch", "user": True},
    ]
    others = [i["name"] for i in body["contacts"][1:]]
    assert others == sorted(others, key=str.lower)
    assert all(not i["role"]["primary"] for i in body["contacts"][1:])


def test_partial_contact_has_nulls_not_strings(member, seeded):
    item = _company_contact(member, seeded, "Ida Kurz")
    assert item["email"] is None and item["phone"] is None and item["linkedin"] is None
    assert item["role"]["title"] is None and item["role"]["function"] is None
    assert item["role"]["primary"] is False and item["known_by"] == []


def test_ended_role_hidden_from_company_but_on_contact_page(member, seeded):
    names = [i["name"] for i in member.get(f"/companies/{seeded}").json()["contacts"]]
    assert "Tom Jansen" not in names
    tom = _contact_id(member, "Tom Jansen")
    page = member.get(f"/contacts/{tom}").json()
    assert [(r["title"], r["current"]) for r in page["roles"]] == [("CFO", False)]
    assert any(c["field"] == "end_date" for c in page["roles"][0]["cells"])
    # Search items carry current roles only.
    item = next(i for i in member.get("/contacts", params={"q": "jansen"}).json()["items"])
    assert item["roles"] == []


def test_search_by_name_company_title_email(member, seeded):
    for q in ("lang", "bwk", "m&a", "@bwk.de", "PETRA"):
        body = member.get("/contacts", params={"q": q}).json()
        assert "Petra Lang" in [i["name"] for i in body["items"]], q
        assert "role" not in body["items"][0]
    # Ended roles don't make a contact findable by that company.
    assert "Tom Jansen" not in [i["name"] for i in member.get(
        "/contacts", params={"q": "bwk"}).json()["items"]]
    everyone = member.get("/contacts", params={"limit": 200}).json()
    names = [i["name"] for i in everyone["items"]]
    assert names == sorted(names, key=str.lower) and everyone["total"] == len(names)
    page = member.get("/contacts", params={"limit": 1, "offset": 1}).json()
    assert page["items"][0]["name"] == names[1] and page["total"] == everyone["total"]
    assert member.get("/contacts", params={"q": "nobody-like-this"}).json() == {
        "total": 0, "offset": 0, "limit": 50, "items": []}
    assert member.get("/contacts", params={"limit": 201}).status_code == 422


def test_contact_detail_cells_and_roles(member, seeded):
    petra = _contact_id(member, "Petra Lang")
    page = member.get(f"/contacts/{petra}").json()
    assert page["id"] == petra and page["name"] == "Petra Lang"
    email = next(c for c in page["cells"] if c["field"] == "email")
    assert email["value"] == "petra.lang@bwk.de" and email["sources"][0]["label"]
    role = page["roles"][0]
    assert role["company_id"] == seeded and role["current"] and role["primary"]
    assert {c["field"] for c in role["cells"]} >= {"title", "function", "is_primary_contact"}
    assert len(page["known_by"]) == 2
    assert member.get(f"/contacts/{seeded}").status_code == 404  # a company


def test_contacts_as_of_an_earlier_corpus_version(dev, seeded):
    import uuid

    from app.contacts import company_contacts
    from app.db import session_scope
    from app.seed_contacts import ContactSpec, write_contacts

    cid = uuid.UUID(seeded)
    before = dev.get("/versions").json()[0]["id"]
    with session_scope() as s:
        write_contacts(s, [ContactSpec(company_id=cid, first_name="Nina", last_name="Spaet",
                                       known_by=("Vanya Brucker",))], "test@helbling.ch")
    with session_scope() as s:
        live = [i["name"] for i in company_contacts(s, [cid])[cid]]
        then = company_contacts(s, [cid], corpus_version=before)[cid]
    assert "Nina Spaet" in live
    assert "Nina Spaet" not in [i["name"] for i in then]
    assert then[0]["name"] == "Petra Lang" and then[0]["role"]["primary"]
    assert then[0]["known_by"][1]["user"] is True


def test_revert_removes_contacts_everywhere(dev, member, seeded):
    import uuid

    from app.db import session_scope
    from app.seed_contacts import ContactSpec, write_contacts

    with session_scope() as s:
        vid = write_contacts(s, [ContactSpec(
            company_id=uuid.UUID(seeded), first_name="Zora", last_name="Revert",
            title="COO", known_by=("Vanya Brucker",))], "test@helbling.ch").id
    zora = _contact_id(member, "Zora Revert")
    assert dev.post(f"/versions/{vid}/revert").status_code == 200
    names = [i["name"] for i in member.get(f"/companies/{seeded}").json()["contacts"]]
    assert "Zora Revert" not in names
    assert member.get("/contacts", params={"q": "zora"}).json()["total"] == 0
    assert member.get(f"/contacts/{zora}").status_code == 404


def test_contacts_need_sign_in(corpus_with_company):
    import uuid

    with TestClient(corpus_with_company) as c:
        assert c.get("/contacts").status_code == 401
        assert c.get(f"/contacts/{uuid.uuid4()}").status_code == 401
