"""Smoke test for the model benchmarks (evals/): replay chats through the real
harness with the scripted fake model and judge, score them in Inspect, and
export a replayed chat back into a sample. No keys, no cost."""

from __future__ import annotations

import json
import math
import os

import pytest

from tests.conftest import TEST_DB, clear_corpus

# The eval points the gateway at its own database; here that is the test one.
os.environ["HELIOS_EVAL_DATABASE_URL"] = TEST_DB

CONSILIO = "Name: Consilio\nSAP consultancy in Germany, about 300 staff, for sale."


@pytest.fixture
def eval_env(database, tmp_path):
    from app import config, llm
    from app.agent import runner

    config.settings.cache_clear()
    llm.chat_provider.cache_clear()
    clear_corpus()
    yield tmp_path
    runner.use_chat_factory(None)
    runner.use_exa_search(None)


def _samples() -> list[dict]:
    return [
        {"id": "on-script", "title": "Consilio", "input": CONSILIO,
         "messages": [{"text": CONSILIO, "web_enabled": False},
                      {"text": "Thanks", "web_enabled": False}],
         "web_enabled_final": False,
         "answers": {
             "ask_user": [{"question": "Build longlists on this basis?",
                           "options": ["Yes", "No"], "answer": "Yes"}],
             "web_research": [{"question": "Search the web?", "scope": "turn",
                               "answer": "Allow web for this turn", "granted": "turn"}]},
         "original": {"lists": [{"name": "Consilio – Strategic buyers",
                                 "rows": [{"name": "Acme Consulting AG",
                                           "company_id": None},
                                          {"name": "Gone GmbH", "company_id": None}]}]}},
        {"id": "off-script", "title": "No answers", "input": CONSILIO,
         "messages": [{"text": CONSILIO, "web_enabled": False}],
         "web_enabled_final": False, "answers": {}, "original": {"lists": []}},
    ]


def test_fake_model_eval_end_to_end(eval_env):
    from inspect_ai import eval as inspect_eval

    from evals.dataset import export
    from evals.exa_cache import ExaCache
    from evals.helios_eval import helios_replay

    data = eval_env / "dataset.jsonl"
    data.write_text("".join(json.dumps(s) + "\n" for s in _samples()))
    cache_file = eval_env / "exa.json"
    ExaCache(cache_file).store("Buyers for consilio", [
        {"title": "SAP partners", "url": "https://example.com/sap", "highlights": ["x"]}])

    task = helios_replay(agent_model="fake", judge_model="fake", dataset=str(data),
                         web="replay", web_cache=str(cache_file), reset_db=False)
    [log] = inspect_eval(task, log_dir=str(eval_env / "logs"), display="none")
    assert log.status == "success", log.error
    assert log.eval.model == "helios/fake"

    by_id = {s.id: s for s in log.samples}
    on, off = by_id["on-script"], by_id["off-script"]
    m_on, m_off = on.scores["harness_metrics"].value, off.scores["harness_metrics"].value

    # On script: Yes, then web approved, one cached search, list built,
    # follow-up answered; every card answered from the original.
    assert m_on["list_created"] == 1 and m_on["list_size"] >= 1
    assert m_on["web_searches"] == 1 and m_on["tool_errors"] == 0
    assert m_on["fallback_answers"] == 0 and m_on["cards"] == 2
    assert m_on["model_calls"] >= 6 and m_on["prompt_tokens"] > 0
    assert on.store["helios"]["messages_sent"] == 2
    assert on.scores["buyer_overlap"].value["overlap_recall"] == 0.5
    assert on.scores["judge"].value["judge_mean"] == 3

    # Off script: the question gets the fallback, the web card a "No".
    answers = off.store["helios"]["answers"]
    assert [a["source"] for a in answers] == ["fallback", "fallback"]
    assert answers[0]["answer"] == "Use your judgement." and answers[1]["answer"] == "No"
    assert m_off["web_searches"] == 0 and m_off["list_created"] == 1
    assert math.isnan(off.scores["buyer_overlap"].value)

    # Run-level means per key show up in the log.
    names = {s.name for s in log.results.scores}
    assert "list_size" in names and "judge_mean" in names

    # The replayed chat exports back into a sample with the same user side.
    chat_id = on.store["helios"]["chat_id"]
    [sample] = export([chat_id], eval_env / "out.jsonl", source_url=TEST_DB,
                      exa_cache=eval_env / "seed.json")
    assert sample["input"] == CONSILIO.strip()
    assert [m["text"] for m in sample["messages"]] == [CONSILIO.strip(), "Thanks"]
    assert sample["answers"]["ask_user"][0]["answer"] == "Yes"
    assert sample["answers"]["web_research"][0]["granted"] == "turn"
    assert sample["original"]["lists"][0]["rows"][0]["name"] == "Acme Consulting AG"
    assert sample["original"]["usage"]["models"] == ["fake:fake-agent"]
    assert "buyers for consilio" in json.loads((eval_env / "seed.json").read_text())


def test_export_needs_named_chats(eval_env):
    from evals.dataset import export, read_ids

    with pytest.raises(SystemExit):
        export([], eval_env / "x.jsonl", source_url=TEST_DB)
    ids = eval_env / "good.txt"
    ids.write_text("# good chats\nabc  # comment\n\ndef\n")
    assert read_ids(ids) == ["abc", "def"]


def test_eval_refuses_the_dev_database():
    from evals import env

    assert env.database_name(env.DEFAULT_EVAL_DB) == "helios_eval"
    assert not "helios".startswith(env.SAFE_PREFIXES)


def test_filter_scenarios_catch_silent_drops(eval_env):
    """The fake filters naively (drops every row without a Swiss HQ), so the
    scenario must report the unknown rows as lost."""
    from inspect_ai import eval as inspect_eval

    from evals.helios_eval import SCENARIOS, helios_scenarios

    task = helios_scenarios(agent_model="fake", judge_model="none",
                            dataset=str(SCENARIOS / "filters.jsonl"),
                            web_cache=str(eval_env / "exa.json"), reset_db=False)
    [log] = inspect_eval(task, log_dir=str(eval_env / "logs"), display="none")
    assert log.status == "success", log.error
    pe = next(s for s in log.samples if s.id == "filter-pe-switzerland")
    replay = pe.store["helios"]
    assert replay["setup_list_id"] in replay["list_ids"]
    v = pe.scores["filter_retention"].value
    # Lakeview (HQ unknown) dropped; Matterhorn (type unknown) kept, unflagged.
    assert v["unknown_kept"] == 0.5 and v["unknown_flagged"] == 0
    assert v["matches_kept"] == 1
    assert v["non_matches_dropped"] == 0.5  # the Swiss family office and VC stay
    assert v["passed"] == 0
    assert {s.name for s in log.results.scores} >= {"passed", "unknown_flagged"}

    from evals.report import runs, table

    report = table(runs(eval_env / "logs"))
    assert "### helios_scenarios" in report and "| fake |" in report


def test_filter_scorer_accepts_flags_in_cells_or_reply():
    from evals.scorers import filter_numbers

    expect = {"keep": ["A Capital"], "flag": ["B Equity", "C Partners"], "drop": ["D Fund"]}
    replay = {"setup_list_id": "l1", "lists": [{"list_id": "l1", "rows": [
        {"name": "A Capital", "values": {"hq": "Zurich, Switzerland"}},
        {"name": "B Equity", "relevance_explanation": "HQ unknown – please verify.",
         "values": {}},
        {"name": "C Partners", "values": {}},
    ]}], "events": [{"type": "agent.message", "payload": {
        "text": "I kept the Swiss PEs. C Partners has no headquarters on file, so "
                "I kept it: its HQ is unknown."}}]}
    assert filter_numbers(expect, replay)["passed"] == 1

    # Kept but never flagged, and the reply only names it in passing.
    replay["lists"][0]["rows"][1]["relevance_explanation"] = "Good fit."
    replay["events"][0]["payload"]["text"] = "Kept A Capital, B Equity and C Partners."
    v = filter_numbers(expect, replay)
    assert v["unknown_kept"] == 1 and v["unknown_flagged"] == 0 and v["passed"] == 0


def test_scoring_scenarios_catch_careless_scores(eval_env):
    """The fake scores 0 where revenue or ticket is missing and writes the
    same vague rationale everywhere; the scoring checks must fail it."""
    from inspect_ai import eval as inspect_eval

    from evals.helios_eval import SCENARIOS, helios_scenarios

    task = helios_scenarios(agent_model="fake", judge_model="fake",
                            dataset=str(SCENARIOS / "scoring.jsonl"),
                            web_cache=str(eval_env / "exa.json"), reset_db=False)
    [log] = inspect_eval(task, log_dir=str(eval_env / "logs"), display="none")
    assert log.status == "success", log.error
    strategic = next(s for s in log.samples if s.id == "scoring-strategic-buyers")
    lst = strategic.store["helios"]["lists"][0]
    assert lst["size"] == 6  # seeded, nothing dropped
    talvik = next(r for r in lst["rows"] if r["name"] == "Talvik Systems AB")
    assert talvik["values"]["ebitda"]  # a negative EBITDA seeds fine
    v = strategic.scores["fit_scoring"].value
    assert v["scored"] == 1 and v["explained"] == 0  # "Good fit overall." is no reason
    assert v["missing_stated"] == 0  # Lumen: 0 and no word on missing revenue
    assert v["criteria_named"] < 0.5 and v["flags_raised"] == 0
    assert v["scoring_passed"] == 0
    assert strategic.scores["scoring_judge"].value["scoring_judge_mean"] == 3
    assert math.isnan(strategic.scores["filter_retention"].value)


def test_scoring_checks_accept_a_careful_answer():
    import json
    from pathlib import Path

    from evals.scorers import scoring_numbers

    sample = json.loads(Path("evals/scenarios/scoring.jsonl").read_text()
                         .splitlines()[1])
    rows = [
        {"name": "Alpine Growth Partners", "relevance_score": 85,
         "relevance_explanation": "Ticket EUR 20–80m fits the deal; focus on DACH "
                                  "industrial tech buyouts matches."},
        {"name": "Seedling Ventures", "relevance_score": 10,
         "relevance_explanation": "Seed and Series A investor; Novatec is far past that stage."},
        {"name": "Megafund Capital", "relevance_score": 15,
         "relevance_explanation": "Ticket from EUR 500m is too large for this deal."},
        {"name": "Quiet Harbour Family Office", "relevance_score": None,
         "relevance_explanation": "Swiss SME focus fits, but its ticket size is unknown, "
                                  "so I can't score size fit yet."},
    ]
    replay = {"setup_list_id": "l1", "lists": [{"list_id": "l1", "rows": rows}]}
    assert scoring_numbers(sample["expect"], replay)["scoring_passed"] == 1
    rows[3]["relevance_score"] = 0
    assert scoring_numbers(sample["expect"], replay)["missing_stated"] == 0


@pytest.mark.parametrize("sentence", [
    "Kestrel Solutions and Orbis have no headquarters on record, so I kept them.",
    "Seegarten Beteiligungen — Konstanz, type not recorded.",
    "Matterhorn Equity (Lugano) — Swiss, but its investor type is blank.",
    "Plus Kestrel and Orbis, which I can't place.",
    "Ostsee Family Office: country unknown, kept for review.",
    "Three of those still show no headquarters: Kestrel Solutions and Orbis.",
    "But no stated ticket size, so worth a call, not a first-round priority.",
])
def test_flag_words_match_real_replies(sentence):
    """Phrasings real models used to flag unknown rows (first runs, Nov 2026)."""
    from evals.scorers import FLAG_WORDS

    assert FLAG_WORDS.search(sentence)


def test_flag_words_ignore_plain_matches():
    from evals.scorers import FLAG_WORDS

    assert not FLAG_WORDS.search("Alpenblick Capital — Zurich, PE.")
    assert not FLAG_WORDS.search("Kronberg IT Services is in Frankfurt, Germany.")


def test_history_records_runs_once_and_builds_the_workbook(eval_env):
    import csv

    from inspect_ai import eval as inspect_eval
    from openpyxl import load_workbook

    from evals import history
    from evals.helios_eval import SCENARIOS, helios_scenarios

    task = helios_scenarios(agent_model="fake", judge_model="fake",
                            dataset=str(SCENARIOS / "scoring.jsonl"),
                            web_cache=str(eval_env / "exa.json"), reset_db=False)
    [log] = inspect_eval(task, log_dir=str(eval_env / "logs"), display="none")
    assert log.status == "success", log.error
    out = eval_env / "history"

    assert history.update(eval_env / "logs", out, note="fake baseline") == 1
    assert history.update(eval_env / "logs", out) == 0  # the same run isn't added twice
    runs = list(csv.DictReader((out / "runs.csv").open()))
    assert len(runs) == 1
    run = runs[0]
    # The judge and what was tested are recorded, so runs can be told apart.
    assert (run["agent_model"], run["judge_model"]) == ("fake", "fake")
    assert run["task"] == "helios_scenarios" and run["note"] == "fake baseline"
    assert run["dataset"] == "scoring.jsonl" and len(run["agent_config"]) == 10
    assert len(run["rubric"]) == 10 and len(run["dataset_hash"]) == 10
    assert float(run["scoring_passed"]) == 0  # the fake scores carelessly
    assert "scoring_passed_se" in run and "scoring_judge_mean" in run
    samples = list(csv.DictReader((out / "samples.csv").open()))
    assert {s["sample"] for s in samples} == {"scoring-strategic-buyers",
                                              "scoring-financial-buyers"}
    assert all(s["judge_model"] == "fake" for s in samples)
    assert any(s["reason"] for s in samples)  # scenarios keep the judge's reasons

    history.set_note(out, run["run_id"][:6], "renamed")
    [renamed] = csv.DictReader((out / "runs.csv").open())
    assert renamed["note"] == "renamed"

    wb = load_workbook(history.build_workbook(out))
    assert wb.sheetnames == ["Trend", "ChartData", "Runs", "Samples"]
    assert len(wb["Trend"]._charts) >= 2
    header = [c.value for c in wb["Runs"][1]]
    assert "judge_model" in header and "scoring_passed" in header
