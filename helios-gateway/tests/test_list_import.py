"""List imports and round-trip exports: the export record and its signed
mark, the three-way diff per cell (unchanged keeps its provenance, file edit,
Helios-side change, conflict, new row, deleted row), a tampered mark and a
file without one falling back to company matching, and who may import what."""

import csv
import io
import time

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from tests.conftest import add_user, clear_corpus, install_fake_llm, sign_in
from tests.test_flow import upload, wait

BWK = "BWK GmbH Unternehmensbeteiligungsgesellschaft"


@pytest.fixture
def app_(database, monkeypatch):
    from app.main import app

    clear_corpus()
    add_user("dev@helbling.ch", role="dev", name="Dana Dev")
    add_user("member@helbling.ch", name="Mia Member")
    install_fake_llm(monkeypatch)
    with TestClient(app) as c:
        sign_in(c, "dev@helbling.ch")
        r = upload(c, "internal_longlist.xlsx", source_type="internal", allow_duplicate="true")
        iid = r.json()["id"]
        wait(c, iid, "mapping_review")
        c.patch(f"/imports/{iid}", json={"new_list_name": "Cedar"})
        c.post(f"/imports/{iid}/report")
        wait(c, iid, "report_review")
        c.post(f"/imports/{iid}/commit")
        wait(c, iid, "committed")
    return app


@pytest.fixture
def member(app_):
    with TestClient(app_) as c:
        sign_in(c, "member@helbling.ch")
        yield c


def the_list(client) -> dict:
    return client.get("/longlists").json()[0]


def table(client, lid) -> dict:
    return client.get(f"/longlists/{lid}").json()


def row(t: dict, name: str) -> dict:
    return next(r for r in t["rows"] if r["cells"].get("name", {}).get("value") == name)


def export(client, lid) -> bytes:
    r = client.get(f"/longlists/{lid}/export")
    assert r.status_code == 200, r.text
    return r.content


def edit(xlsx: bytes, fn) -> bytes:
    """The workbook with its first sheet's rows rewritten by fn(header, rows)."""
    wb = load_workbook(io.BytesIO(xlsx))
    ws = wb.worksheets[0]
    header = [c.value for c in ws[1]]
    rows = [list(r) for r in ws.iter_rows(min_row=2, values_only=True)]
    fn(header, rows)
    ws.delete_rows(2, ws.max_row)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def import_file(client, data: bytes, name: str, **form) -> dict:
    r = client.post("/imports", files={"file": (name, data)},
                    data={"target": "list", **form})
    assert r.status_code == 201, r.text
    iid = r.json()["id"]
    wait(client, iid, "mapping_review")
    assert client.post(f"/imports/{iid}/report").status_code == 200
    return wait(client, iid, "report_review")


def commit(client, iid, decisions=None) -> dict:
    if decisions:
        r = client.put(f"/imports/{iid}/decisions", json={"decisions": decisions})
        assert r.status_code == 200, r.text
    assert client.post(f"/imports/{iid}/commit").status_code == 200
    return wait(client, iid, "committed")


def cells_of(report: dict, label: str) -> dict:
    r = next(r for r in report["rows"] if r["label"] == label)
    return {c["key"]: c for c in r["cells"]}


def test_export_is_recorded_and_signed(member):
    from sqlalchemy import func, select

    from app import exports
    from app.db import session_scope
    from app.models import ListExport, ListExportCell

    lst = the_list(member)
    data = export(member, lst["id"])
    wb = load_workbook(io.BytesIO(data))
    assert wb["_helios"].sheet_state == "veryHidden"
    export_id = exports.verify(wb["_helios"]["A2"].value)
    assert export_id is not None
    ws = wb.worksheets[0]
    header = [c.value for c in ws[1]]
    assert header[-1] == "Helios ID"
    id_letter = ws.cell(row=1, column=len(header)).column_letter
    assert ws.column_dimensions[id_letter].hidden
    t = table(member, lst["id"])
    ids = {ws.cell(row=r, column=len(header)).value for r in range(2, ws.max_row + 1)}
    assert ids == {r["id"] for r in t["rows"]}

    with session_scope() as s:
        record = s.get(ListExport, export_id)
        assert (record.list_id.hex, record.list_version, record.exported_by, record.rows) == (
            lst["id"].replace("-", ""), lst["head_version"], "member@helbling.ch",
            len(t["rows"]))
        n = s.scalar(select(func.count()).select_from(ListExportCell)
                     .where(ListExportCell.export_id == export_id))
        assert n == len(t["rows"]) * len(t["columns"])
    # A token signed with another secret, or edited, doesn't verify.
    token = wb["_helios"]["A2"].value
    assert exports.verify(token[:-1] + ("0" if token[-1] != "0" else "1")) is None
    assert exports.verify(f"{export_id}.{'0' * 32}") is None


def test_round_trip_diff_classes(member):
    lst = the_list(member)
    lid = lst["id"]
    t = table(member, lid)
    by_name = {r["cells"]["name"]["value"]: r for r in t["rows"]}
    alpen = by_name["Alpen Family Holding"]["id"]
    rheintal = by_name["Rheintal Growth Partners"]["id"]
    xlsx = export(member, lid)

    # In Helios, after the export: one rationale changes (kept), another
    # changes too and the file changes it differently (conflict).
    member.post(f"/longlists/{lid}/changes", json={"ops": [
        {"op": "set", "entry_id": alpen, "key": "relevance_explanation",
         "value": "Changed in Helios"},
        {"op": "set", "entry_id": rheintal, "key": "relevance_explanation",
         "value": "Helios says growth"}]})

    def change(header, rows):
        col = {h: i for i, h in enumerate(header)}
        named = {r[col["Company name"]]: r for r in rows}
        named["Rheintal Growth Partners"][col["Relevance explanation"]] = "File says growth"
        named[BWK][col["Relevance score"]] = 80  # a file edit
        named[BWK][col["Website"]] = "bwk-beteiligungen.de"  # a corpus fact edited
        rows.remove(named["Nordlicht Ventures"])  # deleted in the file
        rows.sort(key=lambda r: str(r[col["Company name"]]), reverse=True)  # ids move with rows
        new = [None] * len(header)
        new[col["Company name"]] = "Neue Beteiligungs AG"
        new[col["Relevance score"]] = 60
        rows.append(new)  # a row without an id

    data = import_file(member, edit(xlsx, change), "cedar.xlsx", list_id=lid)
    assert data["export_id"] and not data["warnings"]
    letters = {c["header"]: c["field"] for c in data["tables"][0]["columns"]}
    assert letters["Helios ID"] == "helios_id" and letters["Website"] == "website"
    report = data["report"]
    assert report["kind"] == "list" and report["export"]["has_ids"]

    alpen_cells = cells_of(report, "Alpen Family Holding")
    assert alpen_cells["relevance_explanation"]["class"] == "kept"
    rhein = cells_of(report, "Rheintal Growth Partners")["relevance_explanation"]
    assert rhein["class"] == "conflict"
    assert (rhein["exported"], rhein["current"], rhein["file"]) == (
        "Growth investor in DACH", "Helios says growth", "File says growth")
    bwk = cells_of(report, BWK)
    assert bwk["relevance_score"]["class"] == "changed"
    assert bwk["relevance_score"]["source"] == "manual"
    assert bwk["website"]["class"] == "changed"
    assert "relevance_explanation" not in bwk  # unchanged cells aren't listed
    new = next(r for r in report["rows"] if r["label"] == "Neue Beteiligungs AG")
    assert new["kind"] == "new" and new["entry_id"] is None
    assert [d["label"] for d in report["deleted"]] == ["Nordlicht Ventures"]
    assert report["totals"] == {"new_rows": 1, "changed_cells": 2, "conflicts": 1,
                                "errors": 0}

    before = row(table(member, lid), BWK)
    done = commit(member, data["id"], {
        f"c:{next(r['key'] for r in report['rows'] if r['label'] == 'Rheintal Growth Partners')}"
        f":relevance_explanation": "file",
        f"d:{by_name['Nordlicht Ventures']['id']}": "remove"})
    assert done["list_version"] == lst["head_version"] + 2

    after = table(member, lid)
    names = {r["cells"]["name"]["value"] for r in after["rows"]}
    assert "Nordlicht Ventures" not in names and "Neue Beteiligungs AG" in names
    assert row(after, "Alpen Family Holding")["cells"]["relevance_explanation"]["value"] == (
        "Changed in Helios")
    assert row(after, "Rheintal Growth Partners")["cells"]["relevance_explanation"][
        "value"] == "File says growth"
    b = row(after, BWK)["cells"]
    assert b["relevance_score"]["value"] == 80
    assert b["relevance_score"]["added"]["by"] == "member@helbling.ch"
    # Unchanged keeps its original provenance (the dev's import), not "file".
    assert b["relevance_explanation"] == before["cells"]["relevance_explanation"]
    assert b["investor_type"]["source"] == before["cells"]["investor_type"]["source"]
    # The corpus fact became a prioritized manual value, marked per cell.
    assert b["website"]["value"] == "bwk-beteiligungen.de"
    assert b["website"]["manual"]["by"] == "member@helbling.ch"
    assert b["website"]["pinned"]["by"] == "member@helbling.ch"
    new_row = row(after, "Neue Beteiligungs AG")
    assert new_row["company_id"] is None
    assert new_row["cells"]["name"]["source"] == "Uploaded file"
    version = member.get(f"/longlists/{lid}/versions").json()[0]
    assert version["message"] == "Imported cedar.xlsx"


def test_round_trip_unchanged_file_changes_nothing(member):
    lid = the_list(member)["id"]
    before = table(member, lid)
    data = import_file(member, export(member, lid), "same.xlsx", list_id=lid)
    assert data["report"]["totals"] == {"new_rows": 0, "changed_cells": 0, "conflicts": 0,
                                        "errors": 0}
    done = commit(member, data["id"])
    assert done["list_version"] is None
    after = table(member, lid)
    assert after["head_version"] == before["head_version"]
    assert after["rows"] == before["rows"]


def test_export_without_id_column_matches_by_company(member):
    lid = the_list(member)["id"]
    xlsx = export(member, lid)

    def drop(header, rows):
        col = {h: i for i, h in enumerate(header)}
        rows.remove(next(r for r in rows if r[col["Company name"]] == "Nordlicht Ventures"))

    wb = load_workbook(io.BytesIO(edit(xlsx, drop)))
    ws = wb.worksheets[0]
    ws.delete_cols(ws.max_column)  # the hidden Helios ID column
    buf = io.BytesIO()
    wb.save(buf)
    data = import_file(member, buf.getvalue(), "no-ids.xlsx", list_id=lid)
    report = data["report"]
    # Still our export, but without row ids: matched by company, and the row
    # deleted from the file can't be told apart from one that was never there.
    assert data["export_id"] and report["export"]["has_ids"] is False
    assert report["deleted"] == []
    assert all(r["kind"] == "existing" for r in report["rows"]), report["rows"]
    assert report["totals"]["new_rows"] == 0


def test_tampered_mark_falls_back_to_company_matching(member):
    lid = the_list(member)["id"]
    xlsx = export(member, lid)
    wb = load_workbook(io.BytesIO(xlsx))
    token = wb["_helios"]["A2"].value
    wb["_helios"]["A2"] = token[:-4] + "beef"
    buf = io.BytesIO()
    wb.save(buf)
    data = import_file(member, buf.getvalue(), "tampered.xlsx", list_id=lid)
    assert data["export_id"] is None
    assert any("couldn't be verified" in w for w in data["warnings"])
    report = data["report"]
    # Every row is found by company (or name); nothing is new or deleted.
    assert report["deleted"] == []
    assert all(r["kind"] == "existing" for r in report["rows"]), report["rows"]
    assert report["totals"]["new_rows"] == 0 and report["totals"]["changed_cells"] == 0


def test_no_mark_csv_matches_by_company(member):
    lid = the_list(member)["id"]
    t = table(member, lid)
    alpen = row(t, "Alpen Family Holding")["id"]
    export(member, lid)  # an earlier export holds "Long hold periods"
    member.post(f"/longlists/{lid}/changes", json={"ops": [
        {"op": "set", "entry_id": alpen, "key": "relevance_explanation",
         "value": "Changed since"}]})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Buyer", "Website", "Rationale", "Owner likes wine"])
    w.writerow(["Alpen Family Holding", "alpenholding.ch", "Long hold periods", "Yes"])
    w.writerow(["Rheintal Growth Partners", "rheintal-growth.ch", "New angle", ""])
    w.writerow(["Unbekannt Capital", "unbekannt-capital.de", "Fresh lead", "No"])
    data = import_file(member, buf.getvalue().encode(), "outside.csv", list_id=lid)
    fields = {c["header"]: (c["field"], c.get("new_label"))
              for c in data["tables"][0]["columns"]}
    assert fields["Owner likes wine"] == ("new_column", "Owner likes wine")
    report = data["report"]
    alpen_cells = cells_of(report, "Alpen Family Holding")
    # An old copy of a value we exported is unchanged, Helios's value stays.
    assert "relevance_explanation" not in alpen_cells
    assert alpen_cells["custom_owner_likes_wine"]["class"] == "new"
    rhein = cells_of(report, "Rheintal Growth Partners")
    assert rhein["relevance_explanation"]["class"] == "changed"
    assert rhein["relevance_explanation"]["source"] == "file"
    new = next(r for r in report["rows"] if r["label"] == "Unbekannt Capital")
    assert new["kind"] == "new"
    commit(member, data["id"])

    after = table(member, lid)
    assert row(after, "Alpen Family Holding")["cells"]["relevance_explanation"][
        "value"] == "Changed since"
    r = row(after, "Rheintal Growth Partners")["cells"]["relevance_explanation"]
    assert r["value"] == "New angle" and r["added"]["by"] == "member@helbling.ch"
    wine = row(after, "Alpen Family Holding")["cells"]["custom_owner_likes_wine"]
    assert (wine["value"], wine["source"], wine["file"]) == ("Yes", "Uploaded file",
                                                             "outside.csv")
    assert wine["confidence"] == 50
    assert row(after, "Unbekannt Capital")["cells"]["website"]["value"] == (
        "unbekannt-capital.de")


def _outside(client, lid: str, settings: dict) -> dict:
    """An outside CSV imported with the source the uploader picked."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Buyer", "Website", "Owner likes wine"])
    w.writerow(["Alpen Family Holding", "alpenholding.ch", "Yes"])
    w.writerow(["Unbekannt Capital", "unbekannt-capital.de", "No"])
    r = client.post("/imports", files={"file": ("grasp.csv", buf.getvalue().encode())},
                    data={"target": "list", "list_id": lid})
    iid = r.json()["id"]
    wait(client, iid, "mapping_review")
    r = client.patch(f"/imports/{iid}", json=settings)
    assert r.status_code == 200, r.text
    assert client.post(f"/imports/{iid}/report").status_code == 200
    wait(client, iid, "report_review")
    return commit(client, iid)


def test_other_source_keeps_its_name_as_a_note(member):
    lid = the_list(member)["id"]
    data = _outside(member, lid, {"source_type": "other", "source_note": " Grasp "})
    assert (data["source_type"], data["source_note"], data["source_by"]) == (
        "other", "Grasp", "member@helbling.ch")
    after = table(member, lid)
    # Shown as "Other" at the file's confidence; the name is only a note.
    wine = row(after, "Alpen Family Holding")["cells"]["custom_owner_likes_wine"]
    assert (wine["source"], wine["confidence"]) == ("Other", 50)
    site = row(after, "Unbekannt Capital")["cells"]["website"]
    assert (site["source"], site["confidence"]) == ("Other", 50)

    from app.db import session_scope
    from app.models import ListEntryState
    with session_scope() as s:
        provs = [st.provenance for st in s.query(ListEntryState).filter(
            ListEntryState.list_id == lid, ListEntryState.valid_to.is_(None))]
    noted = [p["custom_owner_likes_wine"] for p in provs if "custom_owner_likes_wine" in p]
    assert noted and all((p["type"], p["note"], p["claimed_by"]) == (
        "other", "Grasp", "member@helbling.ch") for p in noted)


def test_picked_source_scores_at_its_confidence(member):
    lid = the_list(member)["id"]
    _outside(member, lid, {"source_type": "capiq"})
    wine = row(table(member, lid), "Alpen Family Holding")["cells"][
        "custom_owner_likes_wine"]
    assert (wine["source"], wine["confidence"]) == ("S&P Capital IQ", 95)


def test_grasp_scores_low(member):
    # Grasp is web research and LLM output: Low, below an unknown file.
    lid = the_list(member)["id"]
    _outside(member, lid, {"source_type": "grasp"})
    wine = row(table(member, lid), "Alpen Family Holding")["cells"][
        "custom_owner_likes_wine"]
    assert (wine["source"], wine["confidence"]) == ("Grasp", 30)


def test_source_choice_rules(member):
    lid = the_list(member)["id"]
    csv_data = (b"Buyer,Website\nAlpen Family Holding,alpenholding.ch\n"
                b"Rheintal Growth Partners,rheintal-growth.ch\n")
    r = member.post("/imports", files={"file": ("x.csv", csv_data)},
                    data={"target": "list", "list_id": lid})
    iid = r.json()["id"]
    wait(member, iid, "mapping_review")
    assert member.patch(f"/imports/{iid}", json={"source_type": "manual"}).status_code == 400
    assert member.patch(f"/imports/{iid}", json={"source_type": "other"}).status_code == 400
    assert member.patch(f"/imports/{iid}", json={
        "source_type": "capiq", "source_note": "Grasp"}).status_code == 400
    # A verified export doesn't take a source.
    data = import_file(member, export(member, lid), "back.xlsx", list_id=lid)
    assert member.patch(f"/imports/{data['id']}",
                        json={"source_type": "capiq"}).status_code == 409


def test_permissions(app_, member):
    lid = the_list(member)["id"]
    xlsx = export(member, lid)
    r = member.post("/imports", files={"file": ("x.xlsx", xlsx)},
                    data={"target": "corpus"})
    assert r.status_code == 403
    r = member.post("/imports", files={"file": ("x.xlsx", xlsx)})  # corpus by default
    assert r.status_code == 403
    assert member.get("/imports").status_code == 403
    # A member's list import works; they can't see a dev's corpus import.
    data = import_file(member, xlsx, "x.xlsx", list_id=lid)
    assert data["target"] == "list"
    with TestClient(app_) as dev:
        sign_in(dev, "dev@helbling.ch")
        assert dev.get(f"/imports/{data['id']}").status_code == 200
        corpus = dev.get("/imports").json()
        corpus_id = next(i["id"] for i in corpus if i["target"] == "corpus")
    assert member.get(f"/imports/{corpus_id}").status_code == 404
    assert member.post(f"/imports/{corpus_id}/commit").status_code == 404


def test_chat_drop_links_the_list(member):
    import uuid

    from app.agent import config as agent_config
    from app.agent import runner as agent_runner
    from app.db import session_scope
    from app.models import ChatSession, SessionEvent
    from tests.test_agent import install_script, wait_idle

    lid = the_list(member)["id"]
    sid = uuid.uuid4()
    with session_scope() as s:
        s.add(ChatSession(id=sid, owner="member@helbling.ch", title="Drop",
                          agent_config_version=agent_config.current_version(s),
                          list_ids=[]))
    fake = install_script([{"text": "I imported x.xlsx into Cedar; nothing changed."}])
    data = import_file(member, export(member, lid), "x.xlsx", list_id=lid,
                       session_id=str(sid))
    commit(member, data["id"])
    with session_scope() as s:
        assert s.get(ChatSession, sid).list_ids == [lid]
        note = s.query(SessionEvent).filter_by(session_id=sid, type="user.import").one()
        assert note.payload["list_id"] == lid and note.payload["filename"] == "x.xlsx"
    # The import starts a turn: the agent reports on it in its own words.
    deadline = time.time() + 8
    while time.time() < deadline and not fake.calls:
        time.sleep(0.05)
    chat = wait_idle(member, str(sid))
    agent_runner.use_chat_factory(None)
    assert chat["stop_reason"] == "end_turn"
    seen = fake.calls[0]
    assert "after-import skill" in seen[-1]["content"]
    assert "Skill: after an import" in seen[0]["content"]
    with session_scope() as s:
        reply = s.query(SessionEvent).filter_by(session_id=sid, type="agent.message").one()
        assert reply.payload["text"].startswith("I imported x.xlsx")
    # Someone else's chat can't be the target.
    r = member.post("/imports", files={"file": ("x.xlsx", b"x")},
                    data={"target": "list", "list_id": lid, "session_id": str(uuid.uuid4())})
    assert r.status_code == 404


def client_export(client, lid) -> bytes:
    r = client.get(f"/longlists/{lid}/export?format=client")
    assert r.status_code == 200, r.text
    assert "Client" in r.headers["content-disposition"]
    return r.content


def with_financials(client, lid) -> None:
    """Revenue and EBITDA for Nordwind (the fixture's headers don't map them)."""
    nordwind = row(table(client, lid), "Nordwind Business Consulting AG")["id"]
    r = client.post(f"/longlists/{lid}/changes", json={"ops": [
        {"op": "add_column", "key": "revenue"}, {"op": "add_column", "key": "ebitda"},
        {"op": "set", "entry_id": nordwind, "key": "revenue", "value": "EUR 410000000"},
        {"op": "set", "entry_id": nordwind, "key": "ebitda", "value": "EUR 52000000"},
        {"op": "remove_column", "key": "ebitda"}]})
    assert r.status_code == 200, r.text


def test_client_export_columns_and_values(member):
    lid = the_list(member)["id"]
    with_financials(member, lid)
    revenue = row(table(member, lid), "Nordwind Business Consulting AG")["cells"]["revenue"]
    wb = load_workbook(io.BytesIO(client_export(member, lid)))
    assert wb["_helios"].sheet_state == "veryHidden"
    ws = wb.worksheets[0]
    header = [c.value for c in ws[1]]
    assert header == ["No.", "Country", "Logo", "Company Name", "Business Description",
                      "Headquarter", "Homepage", "Shareholders/Group", "Latest Account Date",
                      "Sales in m", "Gross Profit in m", "EBITDA Margin in %",
                      "No. of Employees", "Helbling Contact", "Helios ID"]
    col = {h: i + 1 for i, h in enumerate(header)}
    rows = {ws.cell(row=r, column=col["Company Name"]).value: r
            for r in range(2, ws.max_row + 1)}
    assert [ws.cell(row=r, column=1).value for r in range(2, ws.max_row + 1)] == list(
        range(1, ws.max_row))
    nordwind = rows["Nordwind Business Consulting AG"]
    sales = ws.cell(row=nordwind, column=col["Sales in m"])
    assert sales.value == 410 and sales.number_format == '#,##0.0 "EUR m"'
    assert ws.cell(row=nordwind, column=col["Latest Account Date"]).value == revenue["period"]
    margin = ws.cell(row=nordwind, column=col["EBITDA Margin in %"]).value
    assert margin == round(100 * 52 / 410, 1)
    assert ws.cell(row=nordwind, column=col["No. of Employees"]).value == 1250
    bwk = rows[BWK]
    assert ws.cell(row=bwk, column=col["Country"]).value == "Germany"
    assert ws.cell(row=bwk, column=col["Headquarter"]).value == "Stuttgart, DE"
    assert ws.cell(row=bwk, column=col["Homepage"]).value
    for empty in ("Logo", "Gross Profit in m", "Helbling Contact"):
        assert ws.cell(row=bwk, column=col[empty]).value is None
    assert ws.column_dimensions[ws.cell(row=1, column=col["Helios ID"]).column_letter].hidden


def test_client_export_round_trip(member):
    lid = the_list(member)["id"]
    with_financials(member, lid)
    member.post(f"/longlists/{lid}/changes",
                json={"ops": [{"op": "remove_column", "key": "revenue"}]})
    before = table(member, lid)
    xlsx = client_export(member, lid)

    # Unchanged: nothing to do, no columns added for the facts it showed.
    data = import_file(member, xlsx, "client.xlsx", list_id=lid)
    fields = {c["header"]: c["field"] for c in data["tables"][0]["columns"]}
    assert fields["Sales in m"] == "revenue" and fields["Company Name"] == "name"
    for shown in ("No.", "Country", "Logo", "Latest Account Date", "EBITDA Margin in %",
                  "Gross Profit in m", "Helbling Contact"):
        assert fields[shown] is None, shown
    report = data["report"]
    assert report["export"]["has_ids"] is True
    assert report["new_columns"] == []
    assert report["totals"] == {"new_rows": 0, "changed_cells": 0, "conflicts": 0,
                                "errors": 0}, report["rows"]
    assert commit(member, data["id"])["list_version"] is None

    # A consultant's edit in millions comes back in full; a fact the list had
    # no column for gets one.
    def change(header, rows):
        col = {h: i for i, h in enumerate(header)}
        r = next(r for r in rows if r[col["Company Name"]] == "Nordwind Business Consulting AG")
        r[col["Sales in m"]] = 420.5
        r[col["Shareholders/Group"]] = "Founders 60%, management 40%"
        r[col["EBITDA Margin in %"]] = 99  # display only: ignored

    data = import_file(member, edit(xlsx, change), "client-edited.xlsx", list_id=lid)
    report = data["report"]
    cells = cells_of(report, "Nordwind Business Consulting AG")
    assert cells["revenue"]["value"]["amount"] == 420_500_000
    assert cells["revenue"]["value"]["currency"] == "EUR"
    assert cells["ownership_structure"]["class"] == "new"
    assert {c["key"] for c in report["new_columns"]} == {"revenue", "ownership_structure"}
    assert report["totals"]["changed_cells"] == 2, report["rows"]
    commit(member, data["id"])
    after = table(member, lid)
    nordwind = row(after, "Nordwind Business Consulting AG")
    assert nordwind["cells"]["ownership_structure"]["value"] == "Founders 60%, management 40%"
    assert len(after["columns"]) >= len(before["columns"])
