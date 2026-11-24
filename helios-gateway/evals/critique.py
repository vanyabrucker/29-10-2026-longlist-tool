"""Why a run lost points, and what to change: issues ranked by how often they
hit and how many points they cost.

    uv run python -m evals.critique                     # newest scenario run in evals/logs
    uv run python -m evals.critique LOG [--judge deepseek] [--grades XLSX]

Runs on its own after every scenario run that `python -m evals.history`
records (skip with `--no-critique`). It never waits for hand grading: pass
`--grades` with a graded workbook later to add your comments to the evidence.

1. **Shortfalls**: every judge criterion below 5 (with the judge's reason)
   and every scenario check below 1 (with what the scorer saw), per chat.
   Runs broken by our infrastructure are left out, as in the scores.
2. **Issues**: a model (the run's judge model by default) groups the
   shortfalls into issues, says for each whether the fix belongs to the
   **agent** (prompt, a skill, a tool) or to the **eval** (rubric, scenario,
   replay, scorer: the eval can be wrong too), and proposes one concrete
   change. It gets the agent's prompt and skills and the rubric, so the
   proposal can name the place to change.
3. **Ranking** (computed here, not by the model, from the shortfalls each
   issue claims): `chats` = how many chats it hit, `points_lost` = the sum of
   the gaps (a judge criterion's gap is (5 − score) / 4, a check's 1 − value,
   so each is 0–1), and `priority` = points_lost × the model's expected gain
   (low 0.5, medium 1, high 1.5).

Proposals are never applied. The result is written to
`evals/history/critiques/<run id>.json` (read by the eval dashboard) and
printed as a Markdown table. Replays hold private chats, so they aren't
critiqued (the file would quote them into git).
"""

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from inspect_ai.log import EvalLog, list_eval_logs, read_eval_log

from evals.env import HERE, LOG_DIR
from evals.scorers import SCORING_CRITERIA, infra_failure, judge_provider

GATEWAY = HERE.parent
CRITIQUE_DIR = HERE / "history" / "critiques"
JUDGE_SCORERS = {"scoring_judge": SCORING_CRITERIA, "judge": ("scoping", "relevance",
                                                              "grounding", "no_invention")}
# Scenario checks: (scorer, the checks that decide a pass). Keys missing from
# a sample's score (another behaviour) are skipped.
CHECKS = {
    "fit_scoring": ("scored", "explained", "criteria_named", "missing_stated",
                    "not_excluded", "flags_raised", "order_ok", "web_asked",
                    "weak_sources_flagged"),
    "filter_retention": ("unknown_kept", "unknown_flagged", "matches_kept",
                         "non_matches_dropped"),
}
GAIN = {"low": 0.5, "medium": 1.0, "high": 1.5}
MAX_ISSUES = 8
REASON_CHARS = 600

PROMPT = """You review the results of an evaluation run of Helios, an M&A deal-sourcing assistant (an LLM agent with tools). Below are the agent's instructions (system prompt and skills), the grading rubric, and a numbered list of shortfalls: every place a chat lost points, with the judge's reason or the automatic check that failed.

Group the shortfalls into at most {max_issues} issues (one root cause each). For each issue:
- say whether the fix belongs to the **agent** (its prompt, a skill, a tool) or to the **eval** (the rubric, a scenario, the replay, a scorer): if the agent did the right thing and the eval marked it down, the eval is wrong;
- name the exact place to change (e.g. "skill score_buyers, section 3", "rubric_scoring.md, transparency", "tools.py read_list result");
- propose one concrete change, specific enough to implement: the sentence to add, the rule to change, the check to add;
- estimate the expected gain if fixed: low, medium or high;
- list the shortfall ids it explains. Every shortfall belongs to at most one issue; leave out the ones that are noise.

Answer with JSON only:
{{"issues": [{{"title": "short name", "fix_in": "agent|eval", "where": "...", "diagnosis": "one or two sentences", "proposal": "...", "gain": "low|medium|high", "shortfalls": ["S1", "S4"]}}]}}

# Agent instructions

{agent}

# Rubric

{rubric}

# Shortfalls ({n} across {chats} chats)

{shortfalls}
"""


def _agent_text() -> str:
    parts = [(GATEWAY / "app" / "agent" / "prompt.md").read_text()]
    for f in sorted((GATEWAY / "app" / "agent" / "skills").glob("*.md")):
        parts.append(f"## Skill file {f.stem}\n\n{f.read_text()}")
    return "\n\n".join(parts)


def _nan(v: Any) -> bool:
    return isinstance(v, float) and math.isnan(v)


def shortfalls(log: EvalLog) -> tuple[list[dict[str, Any]], int]:
    """Every point lost, per chat, and how many chats were scored."""
    out: list[dict[str, Any]] = []
    chats = 0
    for s in log.samples or []:
        if infra_failure(s.store.get("helios") or {}):
            continue
        scored = False
        for name, score in (s.scores or {}).items():
            value = score.value
            if _nan(value) or not isinstance(value, dict):
                continue
            if name in JUDGE_SCORERS:
                scored = True
                reasons = dict(re.findall(r"^(\w+): [\d.]+ – (.*)$", score.explanation or "",
                                          re.MULTILINE))
                for c in JUDGE_SCORERS[name]:
                    v = value.get(c)
                    if isinstance(v, (int, float)) and v < 5:
                        out.append({"sample": s.id, "epoch": s.epoch, "kind": "judge",
                                    "name": c, "value": v, "gap": round((5 - v) / 4, 3),
                                    "reason": reasons.get(c, "")[:REASON_CHARS]})
            elif name in CHECKS:
                scored = True
                for c in CHECKS[name]:
                    v = value.get(c)
                    if isinstance(v, (int, float)) and v < 1:
                        out.append({"sample": s.id, "epoch": s.epoch, "kind": "check",
                                    "name": c, "value": v, "gap": round(1 - v, 3),
                                    "reason": (score.explanation or "")[:REASON_CHARS]})
        chats += scored
    for i, item in enumerate(out, 1):
        item["id"] = f"S{i}"
    return out, chats


def hand_comments(path: Path) -> list[dict[str, Any]]:
    """Comments from a graded workbook (evals.grading), as extra evidence."""
    from openpyxl import load_workbook

    from evals.grading import _rows

    wb = load_workbook(path, data_only=True)
    out = []
    for sheet in ("Chats", "Rationales", "Filters"):
        for r in _rows(wb[sheet]):
            if r.get("Your comment"):
                out.append({"sample": r["Sample"], "epoch": r["Epoch"], "kind": "human",
                            "name": f"comment ({sheet.lower()}"
                                    + (f", {r['Buyer']})" if r.get("Buyer") else ")"),
                            "value": None, "gap": 0.0,
                            "reason": str(r["Your comment"])[:REASON_CHARS]})
    return out


def _line(s: dict[str, Any]) -> str:
    value = "" if s["value"] is None else f" = {s['value']:g}"
    return f"{s['id']} [{s['sample']} #{s['epoch']}] {s['kind']} {s['name']}{value}: {s['reason']}"


def parse_issues(text: str, ids: set[str]) -> list[dict[str, Any]]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("no JSON object in the answer")
    issues = json.loads(match.group(0)).get("issues")
    if not isinstance(issues, list):
        raise TypeError("no issues list")
    seen: set[str] = set()
    out = []
    for item in issues[:MAX_ISSUES]:
        if not isinstance(item, dict):
            raise TypeError("an issue is not an object")
        claimed = [x for x in item.get("shortfalls") or [] if x in ids and x not in seen]
        seen.update(claimed)
        out.append({
            "title": str(item.get("title") or "Untitled"),
            "fix_in": "eval" if item.get("fix_in") == "eval" else "agent",
            "where": str(item.get("where") or ""),
            "diagnosis": str(item.get("diagnosis") or ""),
            "proposal": str(item.get("proposal") or ""),
            "gain": item.get("gain") if item.get("gain") in GAIN else "medium",
            "shortfalls": claimed,
        })
    return out


def rank(issues: list[dict[str, Any]], items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {s["id"]: s for s in items}
    for issue in issues:
        hit = [by_id[i] for i in issue["shortfalls"]]
        issue["chats"] = len({(s["sample"], s["epoch"]) for s in hit})
        issue["points_lost"] = round(sum(s["gap"] for s in hit), 3)
        issue["criteria"] = sorted({s["name"] for s in hit if s["kind"] != "human"})
        issue["priority"] = round(issue["points_lost"] * GAIN[issue["gain"]], 3)
    return sorted(issues, key=lambda i: (-i["priority"], -i["chats"]))


def critique(log: EvalLog, judge: str | None = None,
             grades: Path | None = None) -> dict[str, Any]:
    items, chats = shortfalls(log)
    if grades:
        items += hand_comments(grades)
        for i, item in enumerate(items, 1):
            item["id"] = f"S{i}"
    judge = judge or (log.eval.task_args or {}).get("judge_model") or "deepseek"
    result: dict[str, Any] = {
        "run_id": log.eval.eval_id, "task": log.eval.task,
        "created": datetime.now(UTC).isoformat(timespec="seconds"),
        "agent_model": (log.eval.task_args or {}).get("agent_model", ""),
        "critic_model": judge, "chats": chats, "shortfalls": items, "issues": [],
        "unexplained": [],
    }
    if not items:
        return result
    from evals.scorers import SCORING_RUBRIC

    prompt = PROMPT.format(max_issues=MAX_ISSUES, agent=_agent_text(), rubric=SCORING_RUBRIC,
                           n=len(items), chats=chats,
                           shortfalls="\n".join(_line(s) for s in items))
    provider = judge_provider(judge)
    messages = [{"role": "user", "content": prompt}]
    ids = {s["id"] for s in items}
    for attempt in range(2):
        answer = provider.complete(messages)
        try:
            issues = parse_issues(answer.text, ids)
            break
        except (ValueError, TypeError) as e:  # JSONDecodeError is a ValueError
            if attempt:
                raise SystemExit(f"The critic's answer couldn't be read: {e}") from e
            messages += [{"role": "assistant", "content": answer.text},
                         {"role": "user", "content": f"Invalid answer ({e}). "
                          "Reply with the JSON object only."}]
    result["issues"] = rank(issues, items)
    claimed = {i for issue in issues for i in issue["shortfalls"]}
    result["unexplained"] = sorted(ids - claimed, key=lambda x: int(x[1:]))
    return result


def save(result: dict[str, Any], out_dir: Path = CRITIQUE_DIR) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{result['run_id']}.json"
    path.write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n")
    return path


def markdown(result: dict[str, Any]) -> str:
    head = (f"{len(result['shortfalls'])} shortfalls in {result['chats']} chats; "
            f"critic {result['critic_model']}")
    lines = [head, "",
             "| # | issue | fix in | chats | points lost | gain | priority | proposal |",
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for n, i in enumerate(result["issues"], 1):
        lines.append(f"| {n} | {i['title']} | {i['fix_in']}: {i['where']} | {i['chats']} | "
                     f"{i['points_lost']:g} | {i['gain']} | {i['priority']:g} | "
                     f"{i['proposal']} |")
    if result["unexplained"]:
        lines.append(f"\nNot grouped (noise): {', '.join(result['unexplained'])}")
    return "\n".join(lines)


def run_for(log: EvalLog, out_dir: Path = CRITIQUE_DIR) -> Path | None:
    """Critique a recorded run (history calls this): scenario runs only."""
    if log.eval.task != "helios_scenarios" or log.status != "success":
        return None
    if (log.eval.task_args or {}).get("judge_model") == "none":
        return None
    return save(critique(log), out_dir)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m evals.critique", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("log", nargs="?", type=Path, help="an Inspect log (default: newest "
                   "scenario run in evals/logs)")
    p.add_argument("--judge", help="critic model (default: the run's judge model)")
    p.add_argument("--grades", type=Path, help="a graded workbook to add your comments")
    args = p.parse_args(argv)
    if args.log:
        log = read_eval_log(str(args.log))
    else:
        logs = [read_eval_log(i) for i in list_eval_logs(str(LOG_DIR))]
        logs = [lg for lg in logs if lg.eval.task == "helios_scenarios"
                and lg.status == "success"]
        if not logs:
            raise SystemExit("No finished scenario run in evals/logs.")
        log = max(logs, key=lambda lg: lg.eval.created)
    if log.eval.task == "helios_replay":
        raise SystemExit("Replays hold private chats: not critiqued.")
    result = critique(log, args.judge, args.grades)
    path = save(result)
    print(markdown(result))
    print(f"\nWritten to {path}")


if __name__ == "__main__":
    main()
