"""The whole import flow through the API: upload, mapping, report, commit,
matching on a second import, and revert / re-apply."""

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def client(database, fake_llm):
    from app.main import app

    with TestClient(app, headers={"X-User-Email": "test@helbling.ch"}) as c:
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

    companies = client.get("/companies").json()
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
    helix = [c for c in client.get("/companies").json()
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
