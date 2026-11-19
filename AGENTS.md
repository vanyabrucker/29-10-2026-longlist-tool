# Helios — repository overview

Two apps:

- `helios-frontend/` — the Next.js app (demo UI, dev import UI). Notes: `helios-frontend/AGENTS.md`.
- `helios-gateway/` — the Python FastAPI service: Excel ingestion into the master database, and its read API. Notes: `helios-gateway/AGENTS.md`.

Run each from its own folder. Secrets live in each app's `.env` (never committed).

## New dependencies need human sign-off

Never add a dependency (npm package, Python package, Docker image, Postgres extension, or any other external library or service) without asking a human first and getting a clear yes. Say what it is, why it's needed and what the alternative is (usually the standard library or what we already have). This covers dev dependencies too. An approval covers that one dependency, not later ones.

## No fallbacks unless asked

Don't build fallbacks (a default value, a second source for a setting, a quiet retry with something else, a degraded mode) unless explicitly requested. If something required is missing or fails, fail fast with a clear error instead.

## Before every commit

There are no PRs or CI yet, so a commit is the gate: run the checks of every app the commit touches, and commit only when they pass.

- `helios-gateway/`: `./scripts/check.sh` (ruff, then pytest; needs `docker compose up -d`).
- `helios-frontend/`: `npm run check` (eslint, then `tsc --noEmit`); UI changes also get the visual check described in its notes.

Fix every ruff and lint error, including ones that were already there; never commit around them. A `# noqa` or `eslint-disable` is only for a deliberate exception and names the reason on the same line (e.g. `# noqa: BLE001 - any parser error on untrusted bytes`). Never skip hooks or checks to get a commit through.

## Harness or LLM changes: run the evals, update the worksheet, report

Whenever a change can alter how the agent behaves (its prompt, skills, tools, the tool validation, `app/agent/runner.py`, `app/llm.py`, the agent model or provider settings, or the eval scorers and scenarios themselves), do all three before calling it done:

1. **Run the evals** (`helios-gateway/evals/README.md`): `helios_scenarios` on the changed tree and, for a before/after, on the unchanged tree too (a throwaway worktree of the parent commit) with the same agent model, judge model and dataset. Several epochs (3) so one chat doesn't decide it. Scenario runs cost cents, so just run them; ask before the replays (`helios_replay`), which cost more and need private chats.
2. **Update the worksheet:** `uv run python -m evals.history --note "what changed"` records each run once in `helios-gateway/evals/history/` (CSVs plus `history.xlsx`) and rebuilds the workbook. Record the earlier run first so the charts read oldest to newest, and commit the updated files with the change.
3. **Report the results** to the user: before and after for the scores that matter (pass rate, judge mean, cost), the number of chats and epochs, and what the numbers can't show (small samples, same-family judge, behaviour no scorer checks). Say plainly when a score got worse or a run errored.

If a change should show up in the scores and the eval has no check for it, say so and propose one.
