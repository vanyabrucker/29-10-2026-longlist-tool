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
SCORING_CRITERIA = ("criteria_fit", "evidence", "uncertainty", "no_invention",
                    "transparency")
# `scoring_judge_mean` stays the mean of the first four, so it compares with
# runs from before `transparency` was added; that one is reported on its own.
SCORING_MEAN_OF = SCORING_CRITERIA[:4]
JUDGE_ROWS = 40  # rows per list the judge sees (the top ones by score)
# Inspect's sentinel for "not scored": left out of the means.
UNSCORED = float("nan")


def _replay(state: TaskState) -> dict[str, Any]:
    return state.store.get("helios") or {}


def infra_failure(replay: dict[str, Any]) -> str | None:
    """Why the run says nothing about the agent, or None: a tool failed on our
    side (a bug, an outage) or the model provider gave up after its retries.
    Behaviour scorers leave such runs unscored instead of scoring them low."""
    for e in replay.get("events") or []:
        p = e["payload"]
        if e["type"] == "agent.tool_result" and p.get("error_kind") == "system":
            return f"{p.get('name')} failed on our side"
        if e["type"] == "session.error" and str(p.get("detail") or "").startswith("LLMError"):
            return "the model provider failed"
    return None


def _unscored_if_broken(replay: dict[str, Any]) -> Score | None:
    why = infra_failure(replay)
    return None if why is None else Score(
        value=UNSCORED, explanation=f"Infrastructure failure ({why}): not scored.")


def harness_numbers(replay: dict[str, Any]) -> dict[str, float]:
    events = replay.get("events") or []
    usage = [e["payload"] for e in events if e["type"] == "agent.model_usage"]
    results = [e["payload"] for e in events
               if e["type"] == "agent.tool_result" and not e["payload"].get("skipped")]
    errors = sum(1 for r in results if r.get("is_error"))
    # Runs from before the split have errors without a kind: in the total only.
    agent_errors = sum(1 for r in results if r.get("error_kind") == "agent")
    costs = [u.get("cost_usd") for u in usage]
    lists = replay.get("lists") or []
    rows = [r for lst in lists for r in lst["rows"]]
    answers = replay.get("answers") or []
    return {
        "model_calls": len(usage),
        "tool_calls": sum(1 for e in events if e["type"] == "agent.tool_use"),
        "tool_errors": errors,
        "tool_error_rate": round(errors / len(results), 4) if results else 0.0,
        # The model's own mistakes (it gets them back and can fix the call)…
        "tool_errors_agent": agent_errors,
        "tool_error_rate_agent": round(agent_errors / len(results), 4) if results else 0.0,
        # …and ours (a bug or an outage; the run ends).
        "tool_errors_system": sum(1 for r in results if r.get("error_kind") == "system"),
        "infra_broken": float(infra_failure(replay) is not None),
        "prompt_tokens": sum(u.get("prompt_tokens") or 0 for u in usage),
        "completion_tokens": sum(u.get("completion_tokens") or 0 for u in usage),
        "cost_usd": round(sum(c or 0 for c in costs), 6),
        # 0 when a call had no price (set TOKEN_PRICES for the model).
        "cost_known": float(all(c is not None for c in costs)),
        "model_latency_s": round(sum(u.get("latency_ms") or 0 for u in usage) / 1000, 2),
        # Speed: output tokens per second the model spent on its calls (the
        # whole call, prompt processing included), and seconds per call.
        "output_tokens_per_s": speed(usage),
        "s_per_model_call": round(sum(u.get("latency_ms") or 0 for u in usage)
                                  / 1000 / len(usage), 2) if usage else 0.0,
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


def speed(usage: list[dict[str, Any]]) -> float:
    """Output tokens per second of model time, over a chat's calls."""
    seconds = sum(u.get("latency_ms") or 0 for u in usage) / 1000
    tokens = sum(u.get("completion_tokens") or 0 for u in usage)
    return round(tokens / seconds, 1) if seconds else 0.0


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
        if broken := _unscored_if_broken(_replay(state)):
            return broken
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
        # Half points (the rubric's steps); anything finer is rounded to them.
        verdict[c] = {"score": round(float(item["score"]) * 2) / 2,
                      "reason": str(item.get("reason", ""))}
    return verdict


def judge_provider(spec: str):
    if spec == "fake":
        from evals.fake import FakeJudge

        return FakeJudge()
    from app.llm import chat_provider_for

    provider, _, model = spec.partition(":")
    return chat_provider_for(provider, model or None)


async def _judge(state: TaskState, judge_model: str, rubric: str,
                 criteria: tuple[str, ...], mean_key: str,
                 mean_of: tuple[str, ...] | None = None) -> Score:
    if broken := _unscored_if_broken(_replay(state)):
        return broken
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
    mean_of = mean_of or criteria
    values[mean_key] = round(sum(values[c] for c in mean_of) / len(mean_of), 3)
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
    r"unknown|missing|blank|unclear|unconfirmed|unverified|uncertain|verify|to check"
    r"|check (hq|headquarters|type|whether|its)|flag"
    r"|not (known|available|stated|disclosed|listed|given|recorded|confirmed|on file)"
    r"|no (data|information|figures?|hq|headquarters|country|location|(investor )?type"
    r"|ticket( size)?|revenue|ebitda)\b|no (stated|published|known|disclosed|public) \w+"
    r"|no \w+( \w+)? (on record|on file|recorded|listed|given|published)"
    r"|can(no|')t (place|confirm|verify|tell|be shown)|couldn't (place|confirm|verify)"
    r"|n/a|tbd|unbekannt", re.IGNORECASE)


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
        # Or named (in full, or by its first word, as replies shorten names)
        # in a sentence of the reply that says what's missing.
        short = _norm(name).split()[0]
        return any((_norm(name) in _norm(s) or re.search(rf"\b{re.escape(short)}\b",
                                                          _norm(s)))
                   and FLAG_WORDS.search(s) for s in re.split(r"(?<=[.!?\n])\s+", said))

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
        if broken := _unscored_if_broken(replay):
            return broken
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
    - order_ok: each `better` pair is scored higher than its partner;
    - web_asked (with `ask_web`): inputs are missing, so it offered to
      search the web for them (or searched);
    - weak_sources_flagged: every row holding a value the agent wrote below
      High quality (web page, no source) is called out as weaker data."""
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

    weak = weak_rows(lst)
    values = {
        "scored": share([_score_of(rows.get(_norm(n)) or {}) is not None
                         or bool(specs[n].get("missing")) for n in names]),
        "explained": share([len(text(n).strip()) >= 20 for n in names]),
        "criteria_named": share(mentions),
        "missing_stated": share(missing),
        "not_excluded": share(kept),
        "flags_raised": share(flags),
        "order_ok": share([higher(a, b) for a, b in expect.get("better") or []]),
        "web_asked": share([asked_for_web(replay)] if expect.get("ask_web") else []),
        "weak_sources_flagged": share([disclosed(replay, lst, name) for name in weak]),
    }
    values["scoring_passed"] = float(all(v == 1.0 for v in values.values()))
    return values


def asked_for_web(replay: dict[str, Any]) -> bool:
    """It offered to search the web (an approval card) or searched."""
    return any(e["type"] == "agent.tool_use"
               and e["payload"].get("name") in ("request_web_research", "web_research")
               for e in replay.get("events") or [])


# A citation of a web page: [[source | http… | evidence]].
WEB_CITATION = re.compile(r"\[\[[^|\]]*\|\s*https?://[^|\]]*\|")


def weak_rows(lst: dict[str, Any]) -> list[str]:
    """Rows resting on weaker data the agent brought in, which it should
    disclose: a value it wrote below High quality (a web page is Medium at
    best, no source Low), or a rationale citing a web page."""
    return [r["name"] for r in lst.get("rows") or []
            if any(q.get("by") == "agent" for q in (r.get("quality") or {}).values())
            or WEB_CITATION.search(str(r.get("relevance_explanation") or ""))]


# Words that tell the user a fact rests on a weaker source.
WEAK_WORDS = re.compile(
    r"\bweb\b|online|website|unverified|not (been )?verified|verify|weak(er)?\b"
    r"|(low|lower|medium|limited|moderate) (quality|confidence|reliability)"
    r"|single source|one source|stale|outdated|dated|old(er)? (figure|data|source)"
    r"|estimate|unconfirmed|indicative|treat with caution|caution|data quality"
    r"|source quality|not from our (internal )?data|not in our data", re.IGNORECASE)


def _plain(text: str) -> str:
    """Text without citation markers: a "[[Web research | …]]" chip is not a
    caveat the user reads."""
    return re.sub(r"\[\[.*?\]\]", "", text or "")


def disclosed(replay: dict[str, Any], lst: dict[str, Any], name: str) -> bool:
    """The weak data on `name` is called out: in its rationale, or in a
    sentence of a reply that names it (in full or by its first word)."""
    row = next((r for r in lst.get("rows") or [] if _norm(r["name"]) == _norm(name)), {})
    if WEAK_WORDS.search(_plain(str(row.get("relevance_explanation") or ""))):
        return True
    said = _plain(" ".join(e["payload"].get("text") or "" for e in replay.get("events") or []
                           if e["type"] == "agent.message"))
    short = _norm(name).split()[0]
    return any((_norm(name) in _norm(s) or re.search(rf"\b{re.escape(short)}\b", _norm(s)))
               and WEAK_WORDS.search(s) for s in re.split(r"(?<=[.!?\n])\s+", said))


@scorer(metrics={"*": [mean()]})
def fit_scoring():
    """Fit scores and rationales follow the mandate criteria per buyer type,
    keep missing inputs unknown and treat losses and ownership as
    considerations, not exclusions (checks in `scoring_numbers`)."""

    async def score(state: TaskState, target: Target) -> Score:
        if _behaviour(state) != "fit_scoring":
            return Score(value=UNSCORED, explanation="Not a scoring scenario.")
        replay = _replay(state)
        if broken := _unscored_if_broken(replay):
            return broken
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
    type and their weights, evidence vs inference (and asking for missing
    data), uncertainty, no invention, and disclosing weaker sources."""

    async def score(state: TaskState, target: Target) -> Score:
        if _behaviour(state) != "fit_scoring":
            return Score(value=UNSCORED, explanation="Not a scoring scenario.")
        return await _judge(state, judge_model, SCORING_RUBRIC, SCORING_CRITERIA,
                            "scoring_judge_mean", SCORING_MEAN_OF)

    return score
