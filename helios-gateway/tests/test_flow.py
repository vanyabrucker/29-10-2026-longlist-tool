"""The whole import flow through the API: upload, mapping, report, commit,
matching on a second import, and revert / re-apply."""

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import add_user, clear_corpus, sign_in

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def client(database, fake_llm):
    from app.main import app

    add_user("dev@helbling.ch", role="dev")
    clear_corpus()
    with TestClient(app) as c:
        sign_in(c, "dev@helbling.ch")
        yield c


def wait(client, import_id, status, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        d = client.get(f"/imports/{import_id}").json()
        if d["status"] == status:
            return d
        assert d["status"] != "failed", d["error"]
        time.sleep(0.3)
    raise AssertionError(f"import stuck in {d['status']}")


def upload(client, name, **data):
    with open(FIXTURES / name, "rb") as f:
        return client.post("/imports", files={"file": (name, f)}, data=data)


def run_import(client, name, source_type="internal"):
    r = upload(client, name, source_type=source_type, allow_duplicate="true")
    assert r.status_code == 201, r.text
    iid = r.json()["id"]
    wait(client, iid, "mapping_review")
    assert client.post(f"/imports/{iid}/report").status_code == 200
    report = wait(client, iid, "report_review")["report"]
    assert client.post(f"/imports/{iid}/commit").status_code == 200
    return iid, report, wait(client, iid, "committed")


def test_full_flow(client):
    _iid, report, done = run_import(client, "internal_longlist.xlsx")
    rows = {r["key"]: r for r in report["rows"]}
    # The second Isarblick row (same website) is a duplicate within the file.
    assert rows["t0:r9"]["decision"] == "dup:t0:r6"
    # An unknown investor type is an error, not a guess.
    assert any("Unicorn Fund" in e for e in rows["t0:r11"]["errors"])
    assert done["version_id"]

    companies = client.get("/companies?limit=100").json()["items"]
    names = {c["values"]["name"]["value"] for c in companies}
    assert "Isarblick Capital Partners" in names
    assert len([n for n in names if n.startswith("Isarblick")]) == 1

    # Re-uploading the same file needs confirmation.
    assert upload(client, "internal_longlist.xlsx").status_code == 409

    # A CRM export matches existing companies and people.
    _, report2, done2 = run_import(client, "contacts.csv", source_type="crm")
    bwk = next(r for r in report2["rows"] if r["company"]["label"] == "BWK GmbH")
    assert bwk["company"]["match"]["level"] == "likely"
    assert bwk["person"]["match"]["level"] == "certain"
    # CRM (0.6) loses to the internal file (0.7) on the company name.
    assert any(c["field"] == "name" and c["vs"] == "loses" for c in bwk["cells"])

    # Revert withdraws the version's values; re-applying brings them back.
    before = client.get("/stats").json()
    revert = client.post(f"/versions/{done2['version_id']}/revert").json()
    assert client.get("/stats").json()["observations"] == before["observations"]
    helix = [c for c in client.get("/companies?q=helix").json()["items"]
             if c["values"]["name"]["value"].startswith("Helix")]
    assert helix  # its company data came from the first import and stays
    again = client.post(f"/versions/{revert['id']}/revert").json()
    assert again["message"].startswith("Re-applied")
    assert client.get("/stats").json() == before


def test_health_ready_and_version(client):
    assert client.get("/health").json() == {"ok": True}
    ready = client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json() == {"db": "ok", "migrations": "ok", "storage": "ok"}
    from app.catalogue import CATALOGUE_VERSION
    from app.health import schema_head

    info = client.get("/version").json()
    assert set(info) == {"version", "commit", "dirty", "catalogue", "schema"}
    assert info["catalogue"] == CATALOGUE_VERSION
    assert info["schema"] == schema_head()


def test_relationship_mapping_is_refused(client):
    r = upload(client, "internal_longlist.xlsx", source_type="internal",
               allow_duplicate="true")
    iid = r.json()["id"]
    before = wait(client, iid, "mapping_review")["tables"]
    edits = [{"columns": [{"letter": "A", "field": "helbling_person"}]}
             for _ in before]
    r = client.put(f"/imports/{iid}/tables", json=edits)
    assert r.status_code == 400
    assert r.json()["detail"] == "'Known by' can't be imported yet."
    assert client.get(f"/imports/{iid}").json()["tables"] == before
    edits[0]["columns"][0]["field"] = "nonsense"
    r = client.put(f"/imports/{iid}/tables", json=edits)
    assert r.status_code == 400 and "Unknown data point" in r.json()["detail"]


def test_put_tables_with_transforms(client):
    r = upload(client, "swiss_business_list.csv", source_type="internal",
               allow_duplicate="true")
    iid = r.json()["id"]
    data = wait(client, iid, "mapping_review")
    cols = data["tables"][0]["columns"]
    letters = {c["header"]: c["letter"] for c in cols}
    assert letters["locality"] == "F" and letters["region"] == "H"
    assert all(c["transforms"] == [] and "samples_after" not in c for c in cols)
    keep = [{"letter": c["letter"], "field": c["field"], "period": c["period"]}
            for c in cols]

    def put(transforms, header_row=None):
        edit = [{"columns": [{**k, **({"transforms": transforms} if k["letter"] == "F" else {})}
                             for k in keep]}]
        if header_row:
            edit[0]["header_row"] = header_row
        return client.put(f"/imports/{iid}/tables", json=edit)

    combine = {"kind": "combine", "columns": ["H", "A"], "separator": ", "}
    assert put([combine]).status_code == 200
    col = {c["letter"]: c for c in client.get(f"/imports/{iid}").json()["tables"][0]["columns"]}
    assert col["F"]["transforms"] == [combine]
    assert col["F"]["samples_after"][0] == "zürich, zürich, switzerland"
    assert len(col["F"]["samples_after"]) <= 3
    assert "samples_after" not in col["A"]

    r = put([{"kind": "combine", "columns": ["Z"]}])
    assert r.status_code == 400 and r.json()["detail"] == "Column Z isn't in this table."
    r = put([{"kind": "combine", "columns": ["F"]}])
    assert r.status_code == 400 and "can't be combined with itself" in r.json()["detail"]
    assert put([{"kind": "nonsense"}]).status_code == 400
    # Nothing was stored by the failed puts.
    col = client.get(f"/imports/{iid}").json()["tables"][0]["columns"]
    assert next(c for c in col if c["letter"] == "F")["transforms"] == [combine]

    # A geometry change keeps them (the letters still exist).
    h = data["tables"][0]["header_row"]
    r = client.put(f"/imports/{iid}/tables", json=[{
        "header_row": h, "first_data_row": h + 2, "columns": []}])
    assert r.status_code == 200, r.text
    col = client.get(f"/imports/{iid}").json()["tables"][0]["columns"]
    assert next(c for c in col if c["letter"] == "F")["transforms"] == [combine]


def test_stored_transforms_that_no_longer_fit_fail_the_next_put(client):
    r = upload(client, "swiss_business_list.csv", source_type="internal",
               allow_duplicate="true")
    iid = r.json()["id"]
    wait(client, iid, "mapping_review")
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Import
    with SessionLocal() as s:
        imp = s.scalar(select(Import).where(Import.id == iid))
        tables = [dict(t) for t in imp.tables]
        tables[0]["columns"] = [
            {**c, "transforms": [{"kind": "combine", "columns": ["Z"]}]}
            if c["letter"] == "F" else c for c in tables[0]["columns"]]
        imp.tables = tables
        s.commit()
    r = client.put(f"/imports/{iid}/tables", json=[{}])
    assert r.status_code == 400 and r.json()["detail"] == "Column Z isn't in this table."
    r = client.put(f"/imports/{iid}/tables", json=[{"columns": [
        {"letter": "F", "field": None, "transforms": []}]}])
    assert r.status_code == 200
