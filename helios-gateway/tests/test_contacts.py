"""Contacts: writing them as corpus records (people, roles, relationships)."""

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
