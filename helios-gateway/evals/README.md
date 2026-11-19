# Helios agent evals

Benchmarks models on replays of our own chats with [Inspect AI](https://inspect.aisi.org.uk/), so a model choice rests on our work rather than public benchmarks. Dev tooling only: `inspect-ai` is a dev dependency and the app never imports `evals/`.

Each sample is one real chat. The replay sends its first message to the **real harness** (`app/agent/runner.py`, its tools and config) in a throwaway chat in a separate database, answers the agent's cards the way the user did, sends the user's later messages, and scores the result.

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

- `agent_model`: `deepseek[:model]` (DeepSeek's API, `DEEPSEEK_API_KEY`), `azure_foundry[:deployment]` (`AZURE_FOUNDRY_*`), or `fake` (scripted).
- `judge_model`: same format, default `deepseek`; `none` skips the judge. **Keep it the same across the runs you compare.** A judge from the same family as a contestant tends to favour it.
- `web`: `record` (default: cached query → cached hits, otherwise search Exa once and store), `replay` (cache only; a miss is a tool error) or `live`. The cache is `evals/cache/exa.json`.
- `reset_db=false` skips the database reset; `dataset=...` picks another file; `--limit N` runs the first N samples.

Logs go to `evals/logs` (git-ignored). Each run shows as model `helios/<agent_model>`.

## 4. Compare

```sh
uv run inspect view --log-dir evals/logs
```

Open both runs: the run list shows each scorer's mean side by side. Each sample has the replayed chat as messages (card answers marked `original`, `repeat` or `fallback`), the full event log under Store → `helios`, and the judge's reasons.

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

## Cost

Real runs cost money: each sample is a full chat (often 10–25 model calls with long contexts, plus a judge call) and new web searches cost Exa credits. Try `agent_model=fake` first, start with `--limit 2`, and look at `cost_usd` before scaling up.

## Files

- `dataset.py`: export chosen chats; `db.py`: snapshot and reset; `exa_cache.py`: web record/replay.
- `replay.py`: drives the harness for one sample; `helios_eval.py`: the Inspect task and solver.
- `scorers.py` and `rubric.md`; `fake.py`: scripted agent and judge for the smoke test (`tests/test_evals.py`).
