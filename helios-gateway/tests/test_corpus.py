"""The corpus API: search (prefix, fuzzy, website, HQ), paging and sorting,
prioritizing a source over the score (and revert undoing it), permissions."""

import pytest
from fastapi.testclient import TestClient

from tests.conftest import add_user, clear_corpus, install_fake_llm, sign_in
from tests.test_flow import run_import


@pytest.fixture(scope="module")
def corpus(database):
    """Both sample files imported once by a dev; tests then sign in as needed."""
    from app.main import app

    clear_corpus()
    add_user("dev@helbling.ch", role="dev")
    add_user("member@helbling.ch", name="Mia Member")
    patch = pytest.MonkeyPatch()
    install_fake_llm(patch)
    with TestClient(app) as c:
        sign_in(c, "dev@helbling.ch")
        run_import(c, "internal_longlist.xlsx")
        run_import(c, "contacts.csv", source_type="crm")
    patch.undo()
    return app


@pytest.fixture
def member(corpus):
    with TestClient(corpus) as c:
        sign_in(c, "member@helbling.ch")
        yield c


@pytest.fixture
def dev(corpus):
    with TestClient(corpus) as c:
        sign_in(c, "dev@helbling.ch")
        yield c


def names(client, **params) -> list[str]:
    r = client.get("/companies", params=params)
    assert r.status_code == 200, r.text
    return [c["values"].get("name", {}).get("value") for c in r.json()["items"]]


def test_search(member):
    kw = {"mode": "keyword"}
    assert names(member, q="isar", **kw) == ["Isarblick Capital Partners"]
    assert names(member, q="Isarblik Capitl", **kw) == ["Isarblick Capital Partners"]
    assert "BWK GmbH Unternehmensbeteiligungsgesellschaft" in names(member, q="bwk.de")
    assert names(member, q="stuttgart", **kw) == [
        "BWK GmbH Unternehmensbeteiligungsgesellschaft"]
    assert names(member, q="it services")[0] == "Helix IT Services Group"
    assert names(member, q="zzqx") == []
    # Search input can't inject tsquery syntax.
    assert member.get("/companies", params={"q": "a & | ! :* ('"}).status_code == 200


def test_hybrid_search(member):
    r = member.get("/companies", params={"q": "Isarblik Capitl"}).json()
    assert r["mode"] == "hybrid"
    found = [c["values"]["name"]["value"] for c in r["items"]]
    assert found[0] == "Isarblick Capital Partners"
    # An exact website beats everything.
    assert names(member, q="bwk.de")[0] == "BWK GmbH Unternehmensbeteiligungsgesellschaft"
    # Every company got a vector right after the import's commit.
    from sqlalchemy import text

    from app.db import session_scope

    with session_scope() as session:
        assert session.execute(text(
            "SELECT count(*) FROM company_search s JOIN company_embeddings ce "
            "USING (entity_id)")).scalar_one() == 9


def test_filters(member):
    assert names(member, country="CH") == ["Alpen Family Holding",
                                           "Rheintal Growth Partners"]
    assert names(member, region="dach", investor_type="PE") == [
        "BWK GmbH Unternehmensbeteiligungsgesellschaft", "Isarblick Capital Partners",
        "Rheintal Growth Partners"]
    assert names(member, q="munich", buyer_category="Financial", country="DE",
                 mode="keyword") == ["Isarblick Capital Partners"]
    assert names(member, employees_min=1000) == ["Helix IT Services Group",
                                                 "Nordwind Business Consulting AG"]
    assert len(names(member, employees_max=1000, include_missing="true")) == 7
    assert member.get("/companies", params={"region": "mars"}).status_code == 422
    assert member.get("/companies", params={"country": "XX"}).status_code == 422
    facets = member.get("/companies/facets").json()
    assert facets["countries"][0] == {"value": "DE", "count": 4}
    assert facets["investor_types"][0] == {"value": "PE", "count": 3}
    assert "CHF" in facets["currencies"] and "dach" in facets["regions"]


def test_paging_and_sorting(member):
    page = member.get("/companies", params={"limit": 2}).json()
    assert page["total"] == 9 and len(page["items"]) == 2
    everyone = names(member, limit=100)
    assert everyone == sorted(everyone, key=str.lower)  # name order without a query
    assert names(member, limit=2, offset=2) == everyone[2:4]
    by_size = member.get("/companies", params={"sort": "employees", "dir": "desc"}).json()
    top = by_size["items"][0]["values"]
    assert top["name"]["value"] == "Helix IT Services Group"
    assert top["employee_count"]["value"] == 5400
    assert top["employee_count"]["level"] == "high"


def bwk(client) -> dict:
    cid = client.get("/companies", params={"q": "stuttgart"}).json()["items"][0]["id"]
    return client.get(f"/companies/{cid}").json()


def name_cell(company: dict) -> dict:
    return next(c for c in company["cells"] if c["field"] == "name")


def test_prioritize_and_remove(member):
    company = bwk(member)
    cell = name_cell(company)
    assert cell["value"] == "BWK GmbH Unternehmensbeteiligungsgesellschaft"
    assert cell["pinned"] is None and cell["level"] == "high"
    assert [s["source_type"] for s in cell["sources"]] == ["internal", "crm"]
    crm = cell["sources"][1]
    assert not crm["shown"] and crm["category"] == "internal"
    assert cell["confidence"] == 70 and cell["freshness"] == 100

    r = member.put(f"/companies/{company['id']}/pins",
                   json={"field": "name", "observation_id": crm["observation_id"]})
    assert r.status_code == 200, r.text
    cell = name_cell(r.json())
    assert cell["value"] == "BWK GmbH"
    assert cell["pinned"]["by"] == "member@helbling.ch"
    assert cell["pinned"]["name"] == "Mia Member"
    assert cell["score"] == 60.0 and cell["confidence"] == 60  # the real score
    assert cell["sources"][0]["pinned"] and cell["sources"][0]["source_type"] == "crm"
    # The search index follows the shown value, in the same transaction.
    listed = member.get("/companies", params={"q": "stuttgart"}).json()["items"][0]
    assert listed["values"]["name"] == {**listed["values"]["name"], "value": "BWK GmbH",
                                        "pinned": True}
    # Pinning it again is refused.
    again = member.put(f"/companies/{company['id']}/pins",
                       json={"field": "name", "observation_id": crm["observation_id"]})
    assert again.status_code == 409

    r = member.delete(f"/companies/{company['id']}/pins", params={"field": "name"})
    assert r.status_code == 200, r.text
    cell = name_cell(r.json())
    assert cell["value"] == "BWK GmbH Unternehmensbeteiligungsgesellschaft"
    assert cell["pinned"] is None
    assert member.delete(f"/companies/{company['id']}/pins",
                         params={"field": "name"}).status_code == 409


def test_revert_undoes_a_pin(member, dev):
    company = bwk(member)
    crm = name_cell(company)["sources"][1]
    member.put(f"/companies/{company['id']}/pins",
               json={"field": "name", "observation_id": crm["observation_id"]})
    version = dev.get("/versions").json()[0]
    assert version["kind"] == "pin" and version["author"] == "member@helbling.ch"
    assert version["message"] == (
        "Prioritized Helbling CRM for Company name of "
        "BWK GmbH Unternehmensbeteiligungsgesellschaft")

    revert = dev.post(f"/versions/{version['id']}/revert")
    assert revert.status_code == 200, revert.text
    assert name_cell(bwk(member))["pinned"] is None
    assert names(member, q="stuttgart") == ["BWK GmbH Unternehmensbeteiligungsgesellschaft"]

    dev.post(f"/versions/{revert.json()['id']}/revert")  # re-apply
    cell = name_cell(bwk(member))
    assert cell["value"] == "BWK GmbH" and cell["pinned"]["by"] == "member@helbling.ch"

    # Reverting the CRM import withdraws the pinned source: the score decides
    # again, and re-applying the import brings the pin back.
    crm_import = next(v for v in dev.get("/versions").json()
                      if v["kind"] == "import" and v["filename"] == "contacts.csv")
    undo = dev.post(f"/versions/{crm_import['id']}/revert").json()
    cell = name_cell(bwk(member))
    assert cell["value"] == "BWK GmbH Unternehmensbeteiligungsgesellschaft"
    assert cell["pinned"] is None
    dev.post(f"/versions/{undo['id']}/revert")
    assert name_cell(bwk(member))["value"] == "BWK GmbH"
    member.delete(f"/companies/{company['id']}/pins", params={"field": "name"})


def test_permissions(corpus, member):
    company = bwk(member)
    cell = name_cell(company)
    with TestClient(corpus) as anonymous:
        assert anonymous.get("/companies").status_code == 401
        assert anonymous.get(f"/companies/{company['id']}").status_code == 401
        assert anonymous.put(f"/companies/{company['id']}/pins", json={
            "field": "name", "observation_id": cell["sources"][1]["observation_id"],
        }).status_code == 401
    # Members can prioritize, but reverting stays with devs.
    assert member.post("/versions/1/revert").status_code == 403
    # A source of another data point can't be pinned here.
    other = next(c for c in company["cells"] if c["field"] == "website")
    wrong = member.put(f"/companies/{company['id']}/pins", json={
        "field": "name", "observation_id": other["sources"][0]["observation_id"]})
    assert wrong.status_code == 404
