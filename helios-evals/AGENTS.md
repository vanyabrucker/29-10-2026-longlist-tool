# helios-evals — the eval dashboard

A small Next.js app for devs, run locally next to helios-gateway (`npm run dev`, port 3100; or the `evals` entry in `.claude/launch.json`). It's kept out of helios-frontend on purpose: the product and the eval tooling don't mix. Read `../helios-frontend/AGENTS.md` for the Next.js 16 caveats (read `node_modules/next/dist/docs/` before writing code).

## Stack and design

The frontend's packages at the same versions (Next.js 16, React 19, Tailwind v4 via `@tailwindcss/turbopack`; the lockfile started as a copy of the frontend's), nothing else: charts are hand-drawn SVG (`LineChart.tsx`), no chart library. Same tokens as the frontend (`src/app/globals.css`, keep them in sync), fonts (Lora headings, DM Sans, DM Mono), Feather icons copied into `src/components/icons.tsx`, `rounded-full` buttons, `rounded-lg` inputs. English only. Charts are the one place with more colours, on request: each agent·judge pair gets a slot of the dataviz skill's validated categorical order (`COLORS` in `src/app/(dash)/page.tsx`: blue, orange, aqua, yellow, magenta, green, violet, red; by when the pair first ran, so a pair keeps its colour; a 9th pair and later are grey). The selected pair (chips at the top) drives the tiles and the runs table and is always in the charts; the "In the charts" row adds other pairs (`?also=`) and is the legend. Model specs read as model and host (`src/lib/models.ts`, e.g. `deepseek:deepseek-flash` → DeepSeek-V4.1-Flash-1017 (DeepSeek API); plain `deepseek` is DeepSeek's own API with `deepseek-chat`, not Azure). The x axis is run order, evenly spaced across the lines shown (a time axis bunched same-day runs).

## Data

- **Eval record** (read from disk on every request, `src/lib/data.ts`; `EVALS_DIR`, default `../helios-gateway/evals`): `history/runs.csv` and `samples.csv` (from `python -m evals.history`), `history/critiques/<run id>.json` (from `evals.critique`), `scenarios/*.jsonl` and the local replay dataset `data/dataset.jsonl`.
- **Feedback** from helios-gateway (`GATEWAY_URL`, default `http://localhost:8010`; `GATEWAY_SECRET` if set): `GET /feedback`, `PATCH /feedback/{id}` through `src/app/api/gateway/[...path]` (only `feedback/*` passes).
- **Auth**: Helios accounts with the dev role only. `/api/auth/login` keeps the gateway token in its own httpOnly cookie (`helios_evals_session`); every page calls `requireDev()` itself (pages render alongside the layout, so the layout's check isn't enough).
- **Add to eval dataset** (`POST /api/dataset`): runs the gateway's exporter (`uv run python -m evals.dataset export --chat ID --append`) in the gateway folder on this machine, then sets the feedback row's `dataset_sample`. The exporter's reason is shown when it skips a chat (e.g. a chat that started on an existing list).

## Pages

- **Runs** (`/`): scenario runs per agent·judge pair: tiles for the latest run against the one before (scoring passed, scoring judge mean, filter passed, cost per chat, seconds per chat), line charts over runs (scoring, judge mean, weak sources disclosed, filtering, and speed: seconds per chat, output tokens per second) (hover for date, commit and note; click opens the run), the runs table.
- **Run** (`/runs/[id]`): per-chat scores with the judge's reasons, and the run's critique.
- **Improvements** (`/improvements`): the critique of a run: issues ranked by priority (points lost × expected gain), fix in the agent or in the eval, where, the proposal, and the shortfalls behind it.
- **Feedback** (`/feedback`): users' Bad / Fine / Good ratings and comments, by status (Todo, In progress, Done) and rating; a note per item; "Add to eval dataset".
- **Tests** (`/tests`): every scenario (what the user says, the starting list with unknowns, its web pages and answers, what's expected) and the replay dataset.
