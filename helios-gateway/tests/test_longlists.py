"""Longlists: an import onto a new list, apply_changes for every kind of edit,
reading and diffing versions, restore, corpus facts edited from a list
(manual value, prioritized), permissions and the Excel export."""

import io

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from tests.conftest import add_user, clear_corpus, install_fake_llm, sign_in
from tests.test_flow import upload, wait

BWK = "BWK GmbH Unternehmensbeteiligungsgesellschaft"


def import_to_list(client, name, source_type="internal", **settings):
    r = upload(client, name, source_type=source_type, allow_duplicate="true")
    assert r.status_code == 201, r.text
    iid = r.json()["id"]
    wait(client, iid, "mapping_review")
    assert client.patch(f"/imports/{iid}", json=settings).status_code == 200
    assert client.post(f"/imports/{iid}/report").status_code == 200
    wait(client, iid, "report_review")
    assert client.post(f"/imports/{iid}/commit").status_code == 200
    return wait(client, iid, "committed")


@pytest.fixture(scope="module")
def app_(database):
    from app.main import app

    clear_corpus()
    add_user("dev@helbling.ch", role="dev", name="Dana Dev")
    add_user("member@helbling.ch", name="Mia Member")
    patch = pytest.MonkeyPatch()
    install_fake_llm(patch)
    with TestClient(app) as c:
        sign_in(c, "dev@helbling.ch")
        import_to_list(c, "internal_longlist.xlsx", new_list_name="Project Cedar – Buyers")
    patch.undo()
    return app


@pytest.fixture
def member(app_):
    with TestClient(app_) as c:
        sign_in(c, "member@helbling.ch")
        yield c


@pytest.fixture
def dev(app_):
    with TestClient(app_) as c:
        sign_in(c, "dev@helbling.ch")
        yield c


def the_list(client) -> dict:
    lists = client.get("/longlists").json()
    assert len(lists) == 1
    return lists[0]


def row(table: dict, name: str) -> dict:
    return next(r for r in table["rows"]
                if r["cells"].get("name", {}).get("value") == name)


def change(client, list_id, *ops, status=200):
    r = client.post(f"/longlists/{list_id}/changes", json={"ops": list(ops)})
    assert r.status_code == status, r.text
    return r.json()


def test_import_creates_the_list(member):
    lst = the_list(member)
    assert lst["name"] == "Project Cedar – Buyers"
    assert lst["owner"] == {"email": "dev@helbling.ch", "name": "Dana Dev"}
    assert lst["head_version"] == 1
    table = member.get(f"/longlists/{lst['id']}").json()
    keys = [c["key"] for c in table["columns"]]
    assert keys[:3] == ["name", "relevance_score", "relevance_explanation"]
    assert {"website", "hq", "aum", "investor_type"} <= set(keys)
    assert lst["size"] == len(table["rows"]) == 9  # two Isarblick rows, one company
    bwk = row(table, BWK)
    assert bwk["cells"]["relevance_score"]["value"] == 94.0
    assert "level" not in bwk["cells"]["relevance_score"]  # a judgement, not a fact
    assert bwk["cells"]["relevance_explanation"]["value"].startswith("Long-standing")
    # Corpus columns carry the corpus's value and quality.
    assert bwk["cells"]["website"]["value"] == "bwk.de"
    assert bwk["cells"]["website"]["level"] == "high"
    assert table["rows"][0]["cells"]["name"]["value"] == BWK  # sorted by relevance
    versions = member.get(f"/longlists/{lst['id']}/versions").json()
    assert versions == [{**versions[0], "number": 1, "author": "dev@helbling.ch",
                         "author_name": "Dana Dev", "latest": True,
                         "message": "Imported internal_longlist.xlsx"}]


def test_edits_versions_diff_and_restore(member):
    lst = the_list(member)
    lid, start = lst["id"], lst["head_version"]
    table = member.get(f"/longlists/{lid}").json()
    bwk = row(table, BWK)["id"]
    nordlicht = row(table, "Nordlicht Ventures")["id"]

    # A list-only field: a list version, old versions keep the old value.
    t = change(member, lid, {"op": "set", "entry_id": bwk, "key": "relevance_score",
                             "value": "88"})
    assert t["head_version"] == start + 1
    assert row(t, BWK)["cells"]["relevance_score"]["value"] == 88
    old = member.get(f"/longlists/{lid}", params={"version": start}).json()
    assert row(old, BWK)["cells"]["relevance_score"]["value"] == 94
    d = member.get(f"/longlists/{lid}", params={"version": start + 1, "diff": True}).json()
    assert d["changes"] == 1
    cell = row(d, BWK)["cells"]["relevance_score"]
    assert {k: cell[k] for k in ("value", "old", "changed")} == {
        "value": 88, "old": 94, "changed": True}

    # A custom column, list-only.
    t = change(member, lid, {"op": "add_column", "label": "Owner likes Sauvignon",
                             "after": "relevance_score"})
    keys = [c["key"] for c in t["columns"]]
    assert keys[2] == "custom_owner_likes_sauvignon"
    change(member, lid, {"op": "set", "entry_id": bwk, "key": "custom_owner_likes_sauvignon",
                         "value": "Yes"})
    # Remove a row and a column, reorder.
    t = change(member, lid, {"op": "remove_entry", "entry_id": nordlicht})
    assert all(r["id"] != nordlicht for r in t["rows"]) and t["size"] == 8
    t = change(member, lid, {"op": "remove_column", "key": "website"})
    assert "website" not in [c["key"] for c in t["columns"]]
    order = [c["key"] for c in t["columns"]]
    moved = [order[0], *order[2:], order[1]]  # relevance score to the end
    t = change(member, lid, {"op": "order_columns", "keys": moved})
    assert [c["key"] for c in t["columns"]] == moved

    versions = member.get(f"/longlists/{lid}/versions").json()
    assert [v["message"] for v in versions[:6]] == [
        "Moved column Relevance score",
        "Removed column Website",
        "Removed Nordlicht Ventures",
        f"Edited Owner likes Sauvignon of {BWK}",
        "Added column Owner likes Sauvignon",
        f"Edited Relevance score of {BWK}",
    ]
    assert [v["changes"] for v in versions[:6]] == [1, 1, 1, 1, 1, 1]
    head = versions[0]["number"]

    # The diff of a removal shows the removed row and column.
    d = member.get(f"/longlists/{lid}", params={"version": head - 2, "diff": True}).json()
    assert row(d, "Nordlicht Ventures")["diff"] == "removed"
    d = member.get(f"/longlists/{lid}", params={"version": head - 1, "diff": True}).json()
    website = next(c for c in d["columns"] if c["key"] == "website")
    assert website["diff"] == "removed"
    assert row(d, BWK)["cells"]["website"]["value"] == "bwk.de"

    # Restore the version before all of this, as a new version.
    r = member.post(f"/longlists/{lid}/restore", json={"version": start})
    assert r.status_code == 200, r.text
    t = r.json()
    assert t["head_version"] == head + 1
    original = member.get(f"/longlists/{lid}", params={"version": start}).json()
    assert t["columns"] == original["columns"]
    assert [x["cells"] for x in t["rows"]] == [x["cells"] for x in original["rows"]]
    latest = member.get(f"/longlists/{lid}/versions").json()[0]
    assert latest["message"] == f"Restored version {start}" and latest["reverts"] == start
    assert latest["author_name"] == "Mia Member"
    # Nothing was deleted: the edited versions still read as they were.
    again = member.get(f"/longlists/{lid}", params={"version": head}).json()
    assert row(again, BWK)["cells"]["custom_owner_likes_sauvignon"]["value"] == "Yes"
    # A column brought back by restore keeps its key; its values return too.
    change(member, lid, {"op": "add_column", "label": "Owner likes Sauvignon"})
    t = member.get(f"/longlists/{lid}").json()
    assert "custom_owner_likes_sauvignon_2" in [c["key"] for c in t["columns"]]


def test_corpus_fact_edited_in_a_list(member, dev):
    lst = the_list(member)
    lid = lst["id"]
    table = member.get(f"/longlists/{lid}").json()
    bwk = row(table, BWK)
    before = lst["head_version"]
    t = change(member, lid, {"op": "set", "entry_id": bwk["id"], "key": "hq",
                             "value": "Stuttgart-Mitte, DE"})
    hq = row(t, BWK)["cells"]["hq"]
    assert hq["value"] == {"city": "Stuttgart-Mitte", "region": None, "country": "DE"}
    assert hq["manual"]["by"] == "member@helbling.ch" and hq["manual"]["name"] == "Mia Member"
    assert hq["source"] == "Manual edit" and hq["pinned"]

    # Everywhere else too: the company page shows it prioritized.
    company = member.get(f"/companies/{bwk['company_id']}").json()
    cell = next(c for c in company["cells"] if c["field"] == "hq")
    assert cell["value"]["city"] == "Stuttgart-Mitte"
    assert cell["sources"][0]["source_type"] == "manual" and cell["sources"][0]["pinned"]

    # The list version records it; the older version reads the old value.
    v = member.get(f"/longlists/{lid}/versions").json()[0]
    assert v["message"] == f"Edited Headquarters of {BWK}" and v["changes"] == 1
    old = member.get(f"/longlists/{lid}", params={"version": before}).json()
    assert row(old, BWK)["cells"]["hq"]["value"]["city"] == "Stuttgart"
    d = member.get(f"/longlists/{lid}", params={"version": before + 1, "diff": True}).json()
    assert row(d, BWK)["cells"]["hq"]["old"]["city"] == "Stuttgart"

    # One global version holds the value and its priority: reverting it undoes both.
    corpus_version = dev.get("/versions").json()[0]
    assert corpus_version["kind"] == "manual"
    assert corpus_version["message"] == f"Edited Headquarters of {BWK} (in {lst['name']})"
    assert dev.post(f"/versions/{corpus_version['id']}/revert").status_code == 200
    t = member.get(f"/longlists/{lid}").json()
    assert row(t, BWK)["cells"]["hq"]["value"]["city"] == "Stuttgart"
    assert row(t, BWK)["cells"]["hq"]["manual"] is None

    # Bad input is refused, and corpus facts can't be emptied from a list.
    change(member, lid, {"op": "set", "entry_id": bwk["id"], "key": "founded",
                         "value": "long ago"}, status=400)
    change(member, lid, {"op": "set", "entry_id": bwk["id"], "key": "hq", "value": ""},
           status=400)
    change(member, lid, {"op": "set", "entry_id": bwk["id"], "key": "relevance_score",
                         "value": "140"}, status=400)


def test_refusals_and_permissions(app_, member):
    lst = the_list(member)
    lid = lst["id"]
    table = member.get(f"/longlists/{lid}").json()
    bwk = row(table, BWK)
    score = bwk["cells"]["relevance_score"]["value"]
    # Nothing changed: no version.
    change(member, lid, {"op": "set", "entry_id": bwk["id"], "key": "relevance_score",
                         "value": score}, status=409)
    change(member, lid, {"op": "remove_column", "key": "name"}, status=400)
    change(member, lid, {"op": "restore", "version": 1}, status=400)
    assert member.post(f"/longlists/{lid}/restore",
                       json={"version": lst["head_version"]}).status_code == 400
    assert member.get(f"/longlists/{lid}", params={"version": 999}).status_code == 404
    with TestClient(app_) as anonymous:
        assert anonymous.get("/longlists").status_code == 401
        assert anonymous.get(f"/longlists/{lid}").status_code == 401
        assert anonymous.get(f"/longlists/{lid}/export").status_code == 401
        assert anonymous.post(f"/longlists/{lid}/changes", json={"ops": [
            {"op": "remove_entry", "entry_id": bwk["id"]}]}).status_code == 401
        assert anonymous.post(f"/longlists/{lid}/restore",
                              json={"version": 1}).status_code == 401
    # Members can make lists; importing onto one stays with devs.
    r = member.post("/longlists", json={"name": "Consilio – Financial buyers",
                                        "target": "Consilio", "kind": "financial",
                                        "company_ids": [bwk["company_id"]]})
    assert r.status_code == 201, r.text
    made = r.json()
    assert [c["key"] for c in made["columns"]][:4] == [
        "name", "investor_type", "relevance_explanation", "relevance_score"]
    assert made["size"] == 1 and made["owner"]["email"] == "member@helbling.ch"
    assert member.get("/imports").status_code == 403


def test_import_onto_an_existing_list(dev, fake_llm):
    lists = {x["name"]: x for x in dev.get("/longlists").json()}
    consilio = lists["Consilio – Financial buyers"]  # BWK only, made above
    cedar = lists["Project Cedar – Buyers"]
    import_to_list(dev, "contacts.csv", source_type="crm", list_id=consilio["id"])
    after = dev.get(f"/longlists/{consilio['id']}").json()
    assert after["head_version"] == 2 and after["size"] == 3
    assert {r["cells"]["name"]["value"] for r in after["rows"]} == {
        BWK, "Helix IT Services Group", "Nordwind Business Consulting AG"}
    version = dev.get(f"/longlists/{consilio['id']}/versions").json()[0]
    assert version["message"] == "Imported contacts.csv" and version["changes"] == 2
    # Onto a list that has every company already: no new version.
    import_to_list(dev, "contacts.csv", source_type="crm", list_id=cedar["id"])
    assert dev.get(f"/longlists/{cedar['id']}").json()["head_version"] == \
        cedar["head_version"]


def test_export(member):
    lst = next(x for x in member.get("/longlists").json()
               if x["name"] == "Project Cedar – Buyers")
    lid = lst["id"]
    table = member.get(f"/longlists/{lid}").json()
    r = member.get(f"/longlists/{lid}/export")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml")
    assert "filename*=UTF-8''Project%20Cedar" in r.headers["content-disposition"]
    ws = load_workbook(io.BytesIO(r.content)).active
    rows = list(ws.iter_rows(values_only=True))
    # The list's columns, then the hidden row ids (see test_list_import.py).
    # The Contacts column spreads into blocks: one contact at most here (Dr. Anna
    # Muster, from the imported file).
    parts = ("name", "role", "phone", "email", "relationship")
    labels = [x for c in table["columns"]
              for x in ([f"Contact person 1 {p}" for p in parts] if c["key"] == "contacts"
                        else [c["label"]])]
    assert list(rows[0]) == [*labels, "Helios ID"]
    assert len(rows) == 1 + len(table["rows"])
    first = dict(zip(rows[0], rows[1], strict=True))
    assert first["Company name"] == table["rows"][0]["cells"]["name"]["value"]
    assert first["Helios ID"] == table["rows"][0]["id"]
    # An older version exports as it was (version 1 had the Website column).
    v1 = load_workbook(io.BytesIO(member.get(
        f"/longlists/{lid}/export", params={"version": 1}).content)).active
    header = [c.value for c in v1[1]]
    assert "Website" in header
    bwk = next(r for r in v1.iter_rows(min_row=2, values_only=True) if r[0] == BWK)
    assert bwk[header.index("Relevance score")] == 94
    assert bwk[header.index("Website")] == "bwk.de"


# ── Contacts column ────────────────────────────────────────────────────────

READ_ONLY = "Contacts come from the corpus and can't be edited on a list."


def _cedar(client) -> dict:
    return next(x for x in client.get("/longlists").json()
                if x["name"] == "Project Cedar – Buyers")


def _write_contacts(company_id: str, *specs: dict) -> None:
    import uuid

    from app.db import session_scope
    from app.seed_contacts import ContactSpec, write_contacts

    with session_scope() as s:
        write_contacts(s, [ContactSpec(company_id=uuid.UUID(company_id), **spec)
                           for spec in specs], "test@helbling.ch")


@pytest.fixture(scope="module")
def bwk_contacts(app_):
    """Ida Kurz and Petra Lang (primary) at BWK, which has Dr. Anna Muster
    from the imported file already; returns BWK's company id."""
    with TestClient(app_) as c:
        sign_in(c, "member@helbling.ch")
        cid = row(c.get(f"/longlists/{_cedar(c)['id']}").json(), BWK)["company_id"]
    _write_contacts(
        cid,
        {"first_name": "Ida", "last_name": "Kurz", "email": "ida@bwk.de"},
        {"first_name": "Petra", "last_name": "Lang", "title": "Head of M&A",
         "function": "M&A", "primary": True, "known_by": ("Mia Member",)})
    return cid


def test_new_list_has_contacts_column_after_main_facts(member):
    table = member.get(f"/longlists/{_cedar(member)['id']}").json()
    assert [c["key"] for c in table["columns"]][:4] == [
        "name", "relevance_score", "relevance_explanation", "contacts"]
    contacts = next(c for c in table["columns"] if c["key"] == "contacts")
    assert {k: contacts[k] for k in ("label", "type", "source")} == {
        "label": "Contacts", "type": "contacts", "source": "contacts"}
    r = member.post("/longlists", json={"name": "Strategic buyers", "kind": "strategic",
                                        "company_ids": []})
    assert r.status_code == 201, r.text
    assert [c["key"] for c in r.json()["columns"]][:5] == [
        "name", "sector", "relevance_explanation", "relevance_score", "contacts"]


def test_contacts_cell_lists_names_and_details(member, bwk_contacts):
    table = member.get(f"/longlists/{_cedar(member)['id']}").json()
    cell = row(table, BWK)["cells"]["contacts"]
    assert cell["value"] == ["Petra Lang", "Dr. Anna Muster", "Ida Kurz"]  # primary first
    petra = cell["contacts"][0]
    assert petra["role"]["title"] == "Head of M&A" and petra["role"]["primary"] is True
    assert petra["role"]["company_id"] == bwk_contacts
    assert [k["name"] for k in petra["known_by"]] == ["Mia Member"]
    assert cell["contacts"][2]["email"] == "ida@bwk.de"
    # No contacts in the corpus, or no corpus company: no cell.
    assert "contacts" not in row(table, "Nordlicht Ventures")["cells"]


def test_contacts_cell_is_read_only(member, bwk_contacts):
    lid = _cedar(member)["id"]
    bwk = row(member.get(f"/longlists/{lid}").json(), BWK)
    for op in ({"op": "set", "entry_id": bwk["id"], "key": "contacts", "value": "X"},
               {"op": "add_entry", "values": {"name": "New Co", "contacts": "X"}}):
        r = member.post(f"/longlists/{lid}/changes", json={"ops": [op]})
        assert r.status_code == 400 and r.json()["detail"] == READ_ONLY, r.text


def test_contacts_column_can_be_removed_and_restored(member, bwk_contacts):
    lid = _cedar(member)["id"]
    t = change(member, lid, {"op": "remove_column", "key": "contacts"})
    removed_at = t["head_version"]
    assert "contacts" not in [c["key"] for c in t["columns"]]
    assert "contacts" not in row(t, BWK)["cells"]
    versions = member.get(f"/longlists/{lid}/versions").json()
    assert versions[0]["message"] == "Removed column Contacts"
    assert versions[0]["changes"] == 1
    # Added back by key, then restored from before the removal.
    t = change(member, lid, {"op": "add_column", "key": "contacts", "after": "name"})
    assert [c["key"] for c in t["columns"]][:2] == ["name", "contacts"]
    assert row(t, BWK)["cells"]["contacts"]["value"] == ["Petra Lang", "Dr. Anna Muster", "Ida Kurz"]
    change(member, lid, {"op": "remove_column", "key": "contacts"})
    r = member.post(f"/longlists/{lid}/restore", json={"version": removed_at - 1})
    assert r.status_code == 200, r.text
    t = r.json()
    assert "contacts" in [c["key"] for c in t["columns"]]
    assert row(t, BWK)["cells"]["contacts"]["value"] == ["Petra Lang", "Dr. Anna Muster", "Ida Kurz"]


def test_older_version_shows_contacts_as_of_its_corpus_version(member, bwk_contacts):
    lid = _cedar(member)["id"]
    nordlicht = row(member.get(f"/longlists/{lid}").json(), "Nordlicht Ventures")["id"]
    then = change(member, lid, {"op": "set", "entry_id": nordlicht,
                                "key": "relevance_score", "value": 11})["head_version"]
    _write_contacts(bwk_contacts, {"first_name": "Karl", "last_name": "Neu"})
    change(member, lid, {"op": "set", "entry_id": nordlicht, "key": "relevance_score",
                         "value": 12})
    latest = member.get(f"/longlists/{lid}").json()
    assert row(latest, BWK)["cells"]["contacts"]["value"] == [
        "Petra Lang", "Dr. Anna Muster", "Ida Kurz", "Karl Neu"]
    old = member.get(f"/longlists/{lid}", params={"version": then}).json()
    assert row(old, BWK)["cells"]["contacts"]["value"] == ["Petra Lang", "Dr. Anna Muster", "Ida Kurz"]
    # Version 1 has only the contact the imported file brought.
    v1 = member.get(f"/longlists/{lid}", params={"version": 1}).json()
    assert row(v1, BWK)["cells"]["contacts"]["value"] == ["Dr. Anna Muster"]
