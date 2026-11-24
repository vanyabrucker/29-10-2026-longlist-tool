// Server-only: the eval record the gateway writes (helios-gateway/evals/):
// history CSVs, critiques, scenarios and the replay dataset. Read straight
// from disk on every request, so a new run shows on reload.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const EVALS_DIR =
  process.env.EVALS_DIR ?? path.resolve(process.cwd(), "../helios-gateway/evals");
export const GATEWAY_DIR = path.dirname(EVALS_DIR);
export const DATASET_FILE = path.join(EVALS_DIR, "data", "dataset.jsonl");

/** RFC 4180: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows;
  if (!head) return [];
  return body
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

async function readCsv(file: string) {
  return parseCsv(await readFile(path.join(EVALS_DIR, "history", file), "utf8"));
}

export type Run = Record<string, string>;
export type SampleRow = Record<string, string>;

export const num = (v: string | undefined): number | null =>
  v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

export async function runs(): Promise<Run[]> {
  return readCsv("runs.csv");
}

export async function samples(runId?: string): Promise<SampleRow[]> {
  const all = await readCsv("samples.csv");
  return runId ? all.filter((s) => s.run_id === runId) : all;
}

/** The agent and judge pair a run used: runs only compare within one. */
export const pairOf = (r: Run) => `${r.agent_model} · judge ${r.judge_model || "none"}`;

// ── Critiques (evals.critique) ────────────────────────────────────────────

export type Shortfall = {
  id: string;
  sample: string;
  epoch: number;
  kind: "judge" | "check" | "human";
  name: string;
  value: number | null;
  gap: number;
  reason: string;
};

export type Issue = {
  title: string;
  fix_in: "agent" | "eval";
  where: string;
  diagnosis: string;
  proposal: string;
  gain: "low" | "medium" | "high";
  shortfalls: string[];
  chats: number;
  points_lost: number;
  criteria: string[];
  priority: number;
};

export type Critique = {
  run_id: string;
  task: string;
  created: string;
  agent_model: string;
  critic_model: string;
  chats: number;
  shortfalls: Shortfall[];
  issues: Issue[];
  unexplained: string[];
};

export async function critiques(): Promise<Critique[]> {
  const dir = path.join(EVALS_DIR, "history", "critiques");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (e) {
    // No run has been critiqued yet: the folder doesn't exist.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8")) as Critique),
  );
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

export async function critique(runId: string): Promise<Critique | null> {
  return (await critiques()).find((c) => c.run_id === runId) ?? null;
}

// ── Scenarios and the replay dataset ──────────────────────────────────────

export type Scenario = {
  id: string;
  title?: string;
  behaviour?: string;
  input: string;
  file: string;
  setup?: {
    list?: { name: string; kind?: string; rows: Record<string, unknown>[] };
    web?: { match: string; results: { title?: string; url?: string; highlights?: string[] }[] }[];
  };
  answers?: Record<string, { answer: string }[]>;
  expect?: Record<string, unknown>;
};

function jsonl<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export async function scenarios(): Promise<Scenario[]> {
  const dir = path.join(EVALS_DIR, "scenarios");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  const out: Scenario[] = [];
  for (const f of files) {
    for (const s of jsonl<Omit<Scenario, "file">>(await readFile(path.join(dir, f), "utf8")))
      out.push({ ...s, file: f });
  }
  return out;
}

export type DatasetSample = {
  id: string;
  title?: string;
  input: string;
  messages?: { text: string }[];
  original?: { lists?: { name: string; rows: unknown[] }[] };
};

/** The replay dataset (local, git-ignored); empty until chats are exported. */
export async function dataset(): Promise<DatasetSample[]> {
  try {
    return jsonl<DatasetSample>(await readFile(DATASET_FILE, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
