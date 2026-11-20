# Helios agent evals

Benchmarks models on replays of our own chats with [Inspect AI](https://inspect.aisi.org.uk/), so a model choice rests on our work rather than public benchmarks. Dev tooling only: `inspect-ai` is a dev dependency and the app never imports `evals/`.

Two tasks:
- **`helios_replay`**: each sample is one real chat you picked.
- **`helios_scenarios`**: hand-written scenarios with a known right answer, scored without a judge ([scenarios/](scenarios/)). Fictional companies, so they're committed and need no snapshot.

For replays, each sample is one real chat. The replay sends its first message to the **real harness** (`app/agent/runner.py`, its tools and config) in a throwaway chat in a separate database, answers the agent's cards the way the user did, sends the user's later messages, and scores the result.

## Setup (once)

```sh
docker compose up -d
ln -s /path/to/main/checkout/helios-gateway/.env .env   # keys; never committed
uv sync
```

## 1. Choose chats

Chats are private. Nothing goes into the dataset unless you name it.

```sh
uv run python -m evals.dataset chats --owner you@helbling.ch     # id, date, events, title
uv run python -m evals.dataset export --chat <id> --chat <id>
uv run python -m evals.dataset export --from evals/good_chats.txt  # one id per line, # comments
```

This reads the dev database read-only and writes `evals/data/dataset.jsonl` (git-ignored). Each sample holds the user's side of the chat (messages, card answers, the web switch), the lists the original run built and its usage. The original web searches seed the web cache. Chats that started on an existing list are skipped; spreadsheet imports are left out.

## 2. Freeze the world

```sh
uv run python -m evals.db refresh   # pg_dump dev → helios_eval_base (chats removed) → helios_eval
```

Every run starts by recreating `helios_eval` from `helios_eval_base` (a Postgres template copy, about a second), so all compared runs see the same corpus, even though replays create lists. Refresh only when you want a newer corpus, and then rerun every model you compare. The eval refuses to run against a database not named `helios_eval*`.

## 3. Run one command per model

```sh
uv run inspect eval evals/helios_eval.py -T agent_model=deepseek --max-samples 2 --log-dir evals/logs
uv run inspect eval evals/helios_eval.py -T agent_model=azure_foundry --max-samples 2 --log-dir evals/logs
uv run inspect eval evals/helios_eval.py -T agent_model=fake -T judge_model=fake --log-dir evals/logs  # free
```

- `agent_model`: `deepseek[:model]` (DeepSeek's API, `DEEPSEEK_API_KEY`), `azure_foundry[:deployment]` (`AZURE_FOUNDRY_*`), `openrouter:<model>` (`OPENROUTER_API_KEY`; the model is required, e.g. `openrouter:qwen/qwen3.8-27b`), or `fake` (scripted).
- `judge_model`: same format, default `deepseek`; `none` skips the judge. **Keep it the same across the runs you compare.** A judge from the same family as a contestant tends to favour it.
- `web`: `record` (default: cached query → cached hits, otherwise search Exa once and store), `replay` (cache only; a miss is a tool error) or `live`. The cache is `evals/cache/exa.json`.
- `reset_db=false` skips the database reset; `dataset=...` picks another file; `--limit N` runs the first N samples.

Logs go to `evals/logs` (git-ignored). Each run shows as model `helios/<agent_model>`.

## Scenarios

```sh
uv run inspect eval evals/helios_eval.py@helios_scenarios -T agent_model=deepseek --log-dir evals/logs
```

Each scenario starts the chat on a seeded list and sends one instruction. `scenarios/filters.jsonl` tests **missing data when filtering**: "Reduce the list to only PEs which are headquartered in Switzerland" on a list where some PEs have no headquarters (or a Swiss company has no investor type). The right answer keeps the matches, drops the clear non-matches, and **keeps and flags** the unknown rows instead of silently dropping them. `filter_retention` scores `unknown_kept`, `unknown_flagged`, `matches_kept`, `non_matches_dropped` and `passed` (all four perfect). A row counts as flagged when one of its cells, or a sentence of the reply that names it, says it's unknown, missing, unclear or needs checking. `scenarios/scoring.jsonl` tests **buyer fit scoring with evidence** (Helbling's requirements): the user gives the mandate (Novatec, CHF 40m revenue) and asks to score every buyer on a seeded list. The strategic list has a buyer with no revenue, a loss-maker, two units of one group, a foundation-owned and a listed buyer; the financial list has a fitting PE, a seed-stage VC, a fund whose tickets are far too big, and a family office with no published ticket. `fit_scoring` checks `scored`, `explained`, `criteria_named` (each rationale names its buyer type's criteria: sector and size for strategics, ticket and scope for sponsors, stage for VCs), `missing_stated` (missing inputs said and not scored 0), `not_excluded` (loss, foundation and listed are considerations, not a score of 0 or removal), `flags_raised` (the second Ferrum unit mentions the group), `order_ok` (e.g. the fitting PE above the oversized fund) and `scoring_passed`. `scoring_judge` grades the rationales with [rubric_scoring.md](rubric_scoring.md): criteria per buyer type, evidence vs inference, uncertainty, no invention.

Scorers apply by each scenario's `behaviour` (`missing_data_on_filter`, `fit_scoring`); `-T dataset=evals/scenarios/scoring.jsonl` runs one file. Add a scenario by adding a line: `setup.list` (rows of catalogue fields; leave a field out to make it unknown), `input`, `behaviour`, and `expect` (filters: `keep`, `flag`, `drop` by name; scoring: per-row `mentions`, `missing`, `not_excluded`, `flag`, and `better` pairs).

## 4. Look at the results

```sh
uv run python -m evals.report                 # newest run per task and model, as a Markdown table
uv run inspect view --log-dir evals/logs      # the viewer, at http://localhost:7575
```

The report is the quick comparison (paste it into a PR or a note). In the viewer, the run list shows each scorer's mean side by side. Each sample has the replayed chat as messages (card answers marked `original`, `repeat` or `fallback`), the full event log under Store → `helios`, and the judge's reasons.

## 5. Track runs over time

```sh
uv run python -m evals.history --note "what changed in this run"
```

Reads the logs in `evals/logs`, adds each run not recorded yet to `evals/history/runs.csv` (one row per run) and `samples.csv` (one per scenario/chat and epoch), and rebuilds `evals/history/history.xlsx`: a **Trend** sheet with line charts (one line per agent model *and judge model*, so changing the judge shows as a new line you can compare), plus **Runs** and **Samples** tables. A run row has the date, git commit (clean/dirty), task, agent model, **judge model**, hashes of the agent's setup (prompt, skills, tools), the judge's rubrics and the dataset, epochs, samples, your note, every score's mean and the standard error of the headline ones. Scenario samples keep the judge's reasons; replays keep numbers only (private chats stay in the local logs).

Runs stay in the order they were recorded (oldest on the left of every chart; new runs by date among themselves), so for runs that overlapped, record the earlier one first or move its row in `runs.csv`. The CSVs are the record and are committed, so the history diffs in git and survives deleting old logs; the workbook is rebuilt each time, so don't edit it (hand-made graphics go in another workbook; the `note` column in `runs.csv` is yours, or `--set-note RUN_ID "text"`). Only compare runs with the same agent model, judge model and dataset hash, and read the standard error before calling a difference real: with a few chats per run, one bad chat moves a mean a lot. Runs from before the hashes existed leave them empty.

## How the replay answers

- **Question cards** get the user's recorded answers in order. When the new model asks more questions than the user answered, the extra ones get "Use your judgement." (`fallback`). Check `fallback_answers`: a run with many fallbacks went off script.
- **Web approval cards** get the user's recorded button, so the same consent: approving one search, this run or the whole chat. Beyond those, the user's last web answer is repeated, or "No" if the user never approved the web.
- **Messages:** the next recorded message is sent each time the agent ends its turn, with the chat header's web switch as it was when the user sent it.

## Scores

| Scorer | Keys |
| --- | --- |
| `harness_metrics` | `model_calls`, `tool_calls`, `tool_errors`, `tool_error_rate`, `prompt_tokens`, `completion_tokens`, `cost_usd` (`cost_known` is 0 when the model has no price: set `TOKEN_PRICES` in `.env`), `model_latency_s`, `wall_s`, `web_searches`, `cards`, `fallback_answers`, `list_created`, `list_size`, `rows_outside_corpus`, `errored` |
| `buyer_overlap` | `overlap_recall` (share of the original chat's buyers found again), `overlap_precision`; skipped when the original built no list |
| `judge` | 1–5 for `scoping`, `relevance`, `grounding`, `no_invention`, and `judge_mean` ([rubric.md](rubric.md)). The judge sees the mandate, the chat, the lists (top 40 rows each) with our internal facts per company, and the web results the agent saw |

## Running it regularly

- **Every commit (free):** `tests/test_evals.py` runs both tasks with the scripted model inside `./scripts/check.sh`, so the eval plumbing can't silently break.
- **When the agent changes (prompt, skills, tools, model):** run `helios_scenarios` with the models in use. It's a few cents and a minute or two, and catches regressions like dropping unknown rows. This is the run worth wiring into CI later (it needs a Postgres service and the API key as a secret, not the dev snapshot or any chat).
- **Weekly, or before switching models:** both tasks on the candidate models, then `python -m evals.report`. Replays need the local dev snapshot and your private chats, so they run on your machine, not in CI or the cloud: a scheduled Claude Code task on this Mac can run them and send you the report.

## Cost

Real runs cost money: each sample is a full chat (often 10–25 model calls with long contexts, plus a judge call) and new web searches cost Exa credits. Try `agent_model=fake` first, start with `--limit 2`, and look at `cost_usd` before scaling up.

## Files

- `dataset.py`: export chosen chats; `db.py`: snapshot and reset; `exa_cache.py`: web record/replay.
- `replay.py`: drives the harness for one sample; `helios_eval.py`: the Inspect task and solver.
- `history.py`: the run history and its Excel workbook.
- `scorers.py` and `rubric.md`; `scenarios/`: scenario datasets; `report.py`: the comparison table.
- `fake.py`: scripted agent (a naive filter for scenarios) and judge for the smoke test (`tests/test_evals.py`).
