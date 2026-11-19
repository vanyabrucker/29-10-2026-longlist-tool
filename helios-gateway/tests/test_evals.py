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

    from evals.helios_eval import helios_scenarios

    task = helios_scenarios(agent_model="fake", web_cache=str(eval_env / "exa.json"),
                            reset_db=False)
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
