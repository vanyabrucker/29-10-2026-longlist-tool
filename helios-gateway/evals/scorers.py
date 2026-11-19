"""Scorers for replays: harness numbers, overlap with the original list, and
an LLM judge with a written rubric (`rubric.md`).

Every scorer reads the replay the solver stored under `helios`. Scores are
dicts of numbers, so Inspect shows the mean of each key per run.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from inspect_ai.scorer import Score, Target, mean, scorer
from inspect_ai.solver import TaskState

HERE = Path(__file__).resolve().parent
RUBRIC = (HERE / "rubric.md").read_text()
CRITERIA = ("scoping", "relevance", "grounding", "no_invention")
SCORING_RUBRIC = (HERE / "rubric_scoring.md").read_text()
SCORING_CRITERIA = ("criteria_fit", "evidence", "uncertainty", "no_invention")
JUDGE_ROWS = 40  # rows per list the judge sees (the top ones by score)
# Inspect's sentinel for "not scored": left out of the means.
UNSCORED = float("nan")


def _replay(state: TaskState) -> dict[str, Any]:
    return state.store.get("helios") or {}


def harness_numbers(replay: dict[str, Any]) -> dict[str, float]:
    events = replay.get("events") or []
    usage = [e["payload"] for e in events if e["type"] == "agent.model_usage"]
    results = [e["payload"] for e in events
               if e["type"] == "agent.tool_result" and not e["payload"].get("skipped")]
    errors = sum(1 for r in results if r.get("is_error"))
    costs = [u.get("cost_usd") for u in usage]
    lists = replay.get("lists") or []
    rows = [r for lst in lists for r in lst["rows"]]
    answers = replay.get("answers") or []
    return {
        "model_calls": len(usage),
        "tool_calls": sum(1 for e in events if e["type"] == "agent.tool_use"),
        "tool_errors": errors,
        "tool_error_rate": round(errors / len(results), 4) if results else 0.0,
        "prompt_tokens": sum(u.get("prompt_tokens") or 0 for u in usage),
        "completion_tokens": sum(u.get("completion_tokens") or 0 for u in usage),
        "cost_usd": round(sum(c or 0 for c in costs), 6),
        # 0 when a call had no price (set TOKEN_PRICES for the model).
        "cost_known": float(all(c is not None for c in costs)),
        "model_latency_s": round(sum(u.get("latency_ms") or 0 for u in usage) / 1000, 2),
        "wall_s": replay.get("wall_s") or 0.0,
        "web_searches": sum(1 for r in results if r.get("name") == "web_research"
                            and not r.get("is_error")),
        "cards": len(answers),
        "fallback_answers": sum(1 for a in answers if a["source"] != "original"),
        "list_created": float(bool(lists)),
        "list_size": len(rows),
        "rows_outside_corpus": sum(1 for r in rows if not r.get("company_id")),
        "errored": float(replay.get("stop_reason") == "error"),
    }


@scorer(metrics={"*": [mean()]})
def harness_metrics():
    """Tool error rate, steps, model calls, tokens, cost, time, list size."""

    async def score(state: TaskState, target: Target) -> Score:
        replay = _replay(state)
        return Score(value=harness_numbers(replay),
                     explanation=replay.get("error") or replay.get("stop_reason"))

    return score


def _keys(lists: list[dict]) -> set[str]:
    """Buyers by company id, or by name for rows outside our data."""
    out = set()
    for lst in lists:
        for r in lst.get("rows") or []:
            if r.get("company_id"):
                out.add(r["company_id"])
            elif r.get("name"):
                out.add("name:" + " ".join(str(r["name"]).casefold().split()))
    return out


@scorer(metrics={"*": [mean()]})
def buyer_overlap():
    """How many of the original chat's buyers the replay found again
    (recall) and how much of the replay's list they make up (precision).
    Only for samples whose original chat built a list."""

    async def score(state: TaskState, target: Target) -> Score:
        original = _keys((state.metadata.get("sample") or {}).get("original", {})
                         .get("lists") or [])
        if not original:
            return Score(value=UNSCORED, explanation="The original chat built no list.")
        new = _keys(_replay(state).get("lists") or [])
        both = original & new
        return Score(value={
            "overlap_recall": round(len(both) / len(original), 4),
            "overlap_precision": round(len(both) / len(new), 4) if new else 0.0,
        }, explanation=f"{len(both)} of {len(original)} original buyers; "
                       f"{len(new)} in the replay")

    return score


# ── LLM judge ──────────────────────────────────────────────────────────────


def judge_material(state: TaskState) -> str:
    replay = _replay(state)
    answers = iter(replay.get("answers") or [])
    convo = []
    for e in replay.get("events") or []:
        p = e["payload"]
        if e["type"] == "user.message":
            convo.append(f"USER: {p.get('text')}")
        elif e["type"] == "agent.message" and p.get("text"):
            convo.append(f"ASSISTANT: {p['text']}")
        elif e["type"] == "user.tool_result":
            a = next(answers, None) or {}
            convo.append(f"CARD: {a.get('question', '')!r} → {p.get('answer')!r}")
        elif e["type"] == "session.error":
            convo.append(f"ERROR: {p.get('message')}")
    web = []
    for e in replay.get("events") or []:
        p = e["payload"]
        if (e["type"] == "agent.tool_result" and p.get("name") == "web_research"
                and not p.get("is_error")):
            try:
                hits = json.loads(p.get("content") or "{}").get("results") or []
            except json.JSONDecodeError:
                hits = []
            web += [{"title": h.get("title"), "url": h.get("url"),
                     "highlights": h.get("highlights")} for h in hits]
    lists = []
    for lst in replay.get("lists") or []:
        rows = sorted(lst["rows"], key=lambda r: -(r.get("relevance_score") or 0))
        lists.append({**lst, "rows": rows[:JUDGE_ROWS],
                      "rows_not_shown": max(0, len(rows) - JUDGE_ROWS)})
    return (
        f"# Mandate\n\n{state.input_text}\n\n"
        "# Conversation\n\n" + "\n\n".join(convo) + "\n\n"
        "# Lists built (rows with rationale; `corpus` = our internal facts)\n\n"
        + (json.dumps(lists, ensure_ascii=False, default=str) if lists else "None.")
        + "\n\n# Web results the assistant saw\n\n"
        + (json.dumps(web, ensure_ascii=False) if web else "None."))


def parse_verdict(text: str, criteria: tuple[str, ...] = CRITERIA) -> dict[str, dict]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("no JSON object in the judge's answer")
    data = json.loads(match.group(0))
    verdict = {}
    for c in criteria:
        item = data.get(c)
        if not isinstance(item, dict) or not 1 <= float(item.get("score", 0)) <= 5:
            raise ValueError(f"missing or invalid score for {c}")
        verdict[c] = {"score": float(item["score"]), "reason": str(item.get("reason", ""))}
    return verdict


def judge_provider(spec: str):
    if spec == "fake":
        from evals.fake import FakeJudge

        return FakeJudge()
    from app.llm import chat_provider_for

    provider, _, model = spec.partition(":")
    return chat_provider_for(provider, model or None)


async def _judge(state: TaskState, judge_model: str, rubric: str,
                 criteria: tuple[str, ...], mean_key: str) -> Score:
    provider = judge_provider(judge_model)
    messages = [{"role": "system", "content": rubric},
                {"role": "user", "content": judge_material(state)}]
    last_error = None
    for _ in range(2):
        result = await asyncio.to_thread(provider.complete, messages)
        try:
            verdict = parse_verdict(result.text, criteria)
            break
        except (ValueError, json.JSONDecodeError) as e:
            last_error = e
            messages += [{"role": "assistant", "content": result.text},
                         {"role": "user", "content": f"Invalid answer ({e}). "
                          "Reply with the JSON object only."}]
    else:
        return Score(value=UNSCORED, explanation=f"Judge failed: {last_error}")
    values = {c: v["score"] for c, v in verdict.items()}
    values[mean_key] = round(sum(values.values()) / len(criteria), 3)
    return Score(value=values, explanation="\n".join(
        f"{c}: {v['score']:g} – {v['reason']}" for c, v in verdict.items()),
        metadata={"judge_model": judge_model})


@scorer(metrics={"*": [mean()]})
def judge(judge_model: str):
    """Rubric scores 1–5 per criterion and their mean, from a fixed judge
    model (keep it the same across the runs you compare)."""

    async def score(state: TaskState, target: Target) -> Score:
        return await _judge(state, judge_model, RUBRIC, CRITERIA, "judge_mean")

    return score


def _behaviour(state: TaskState) -> str | None:
    return (state.metadata.get("sample") or {}).get("behaviour")


# ── Scenario: missing data when filtering ──────────────────────────────────

# Words that mark a row (or a mention of it) as needing a check.
FLAG_WORDS = re.compile(
    r"unknown|missing|not (known|available|stated|disclosed|listed|given)|unclear|"
    r"unverified|verify|to check|check (hq|headquarters|type|whether)|no (data|information)"
    r"|n/a|tbd|flag|unbekannt", re.IGNORECASE)


def _norm(name: Any) -> str:
    return " ".join(str(name or "").casefold().split())


def result_list(replay: dict[str, Any]) -> dict[str, Any] | None:
    """The list a filter request ended in: a list the agent created instead
    (the newest), else the one the chat started on."""
    lists = replay.get("lists") or []
    setup = replay.get("setup_list_id")
    created = [lst for lst in lists if lst["list_id"] != setup]
    return created[-1] if created else next(
        (lst for lst in lists if lst["list_id"] == setup), None)


def filter_numbers(expect: dict[str, list[str]], replay: dict[str, Any]) -> dict[str, float]:
    lst = result_list(replay) or {"rows": []}
    rows = {_norm(r["name"]): r for r in lst["rows"]}
    said = " ".join(e["payload"].get("text") or "" for e in replay.get("events") or []
                    if e["type"] == "agent.message")

    def flagged(name: str) -> bool:
        row = rows.get(_norm(name))
        if row is None:
            return False
        cells = " ".join(str(v) for v in [row.get("relevance_explanation"),
                                          *(row.get("values") or {}).values()] if v)
        if FLAG_WORDS.search(cells):
            return True
        # Or named in a sentence of the reply that says what's missing.
        return any(_norm(name) in _norm(s) and FLAG_WORDS.search(s)
                   for s in re.split(r"(?<=[.!?\n])\s+", said))

    def share(names: list[str], test) -> float:
        return round(sum(1 for n in names if test(n)) / len(names), 4) if names else 1.0

    keep, flag, drop = (expect.get(k) or [] for k in ("keep", "flag", "drop"))
    values = {
        "unknown_kept": share(flag, lambda n: _norm(n) in rows),
        "unknown_flagged": share(flag, flagged),
        "matches_kept": share(keep, lambda n: _norm(n) in rows),
        "non_matches_dropped": share(drop, lambda n: _norm(n) not in rows),
    }
    values["passed"] = float(all(v == 1.0 for v in values.values()))
    return values


@scorer(metrics={"*": [mean()]})
def filter_retention():
    """A filter keeps rows whose deciding value is unknown and flags them
    (in a cell or by name in the reply, next to a word like "unknown"),
    keeps the matches and drops the rest. `passed` needs all four."""

    async def score(state: TaskState, target: Target) -> Score:
        if _behaviour(state) != "missing_data_on_filter":
            return Score(value=UNSCORED, explanation="Not a filter scenario.")
        expect = (state.metadata.get("sample") or {}).get("expect") or {}
        replay = _replay(state)
        values = filter_numbers(expect, replay)
        lst = result_list(replay)
        left = ", ".join(r["name"] for r in (lst or {}).get("rows", [])) or "nothing"
        return Score(value=values, explanation=f"Rows left: {left}")

    return score


# ── Scenario: buyer fit scores with evidence ───────────────────────────────


def _score_of(row: dict[str, Any]) -> float | None:
    try:
        return None if row.get("relevance_score") is None else float(row["relevance_score"])
    except (TypeError, ValueError):
        return None


def scoring_numbers(expect: dict[str, Any], replay: dict[str, Any]) -> dict[str, float]:
    """Per the mandate criteria (see scenarios/scoring.jsonl):
    - scored / explained: every row has a score and a rationale;
    - criteria_named: each rationale names the criteria its buyer type is
      judged on (`mentions`: one regex per criterion, any match);
    - missing_stated: a row whose deciding inputs are missing says so and
      isn't scored 0 (an empty score with a stated reason is fine);
    - not_excluded: a loss-maker, foundation or listed owner stays on the
      list with a score above 0 (a consideration, not an exclusion);
    - flags_raised: a row with a `flag` regex (e.g. a second unit of one
      group) mentions it;
    - order_ok: each `better` pair is scored higher than its partner."""
    lst = result_list(replay) or {"rows": []}
    rows = {_norm(r["name"]): r for r in lst["rows"]}
    specs = expect.get("rows") or {}

    def text(name: str) -> str:
        return str((rows.get(_norm(name)) or {}).get("relevance_explanation") or "")

    def share(checks: list[bool]) -> float:
        return round(sum(checks) / len(checks), 4) if checks else 1.0

    names = list(specs)
    mentions = [bool(re.search(rx, text(n), re.IGNORECASE))
                for n in names for rx in specs[n].get("mentions") or []]
    missing = [bool(FLAG_WORDS.search(text(n))) and _score_of(rows.get(_norm(n)) or {}) != 0
               for n in names if specs[n].get("missing")]
    kept = [_norm(n) in rows and (_score_of(rows[_norm(n)]) or 0) > 0
            for n in names if specs[n].get("not_excluded")]
    flags = [bool(re.search(specs[n]["flag"], text(n), re.IGNORECASE))
             for n in names if specs[n].get("flag")]

    def higher(a: str, b: str) -> bool:
        sa, sb = (_score_of(rows.get(_norm(x)) or {}) for x in (a, b))
        return sa is not None and (sb is None or sa > sb)

    values = {
        "scored": share([_score_of(rows.get(_norm(n)) or {}) is not None
                         or bool(specs[n].get("missing")) for n in names]),
        "explained": share([len(text(n).strip()) >= 20 for n in names]),
        "criteria_named": share(mentions),
        "missing_stated": share(missing),
        "not_excluded": share(kept),
        "flags_raised": share(flags),
        "order_ok": share([higher(a, b) for a, b in expect.get("better") or []]),
    }
    values["scoring_passed"] = float(all(v == 1.0 for v in values.values()))
    return values


@scorer(metrics={"*": [mean()]})
def fit_scoring():
    """Fit scores and rationales follow the mandate criteria per buyer type,
    keep missing inputs unknown and treat losses and ownership as
    considerations, not exclusions (checks in `scoring_numbers`)."""

    async def score(state: TaskState, target: Target) -> Score:
        if _behaviour(state) != "fit_scoring":
            return Score(value=UNSCORED, explanation="Not a scoring scenario.")
        replay = _replay(state)
        values = scoring_numbers((state.metadata.get("sample") or {}).get("expect") or {},
                                 replay)
        lst = result_list(replay) or {"rows": []}
        return Score(value=values, explanation="\n".join(
            f"{r['name']}: {r.get('relevance_score')} – {r.get('relevance_explanation')}"
            for r in lst["rows"]))

    return score


@scorer(metrics={"*": [mean()]})
def scoring_judge(judge_model: str):
    """The judge on fit rationales (`rubric_scoring.md`): criteria per buyer
    type, evidence vs inference, uncertainty, no invention."""

    async def score(state: TaskState, target: Target) -> Score:
        if _behaviour(state) != "fit_scoring":
            return Score(value=UNSCORED, explanation="Not a scoring scenario.")
        return await _judge(state, judge_model, SCORING_RUBRIC, SCORING_CRITERIA,
                            "scoring_judge_mean")

    return score
