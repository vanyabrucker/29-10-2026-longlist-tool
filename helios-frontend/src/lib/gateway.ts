// Client helpers for the dev-only import area, talking to helios-gateway
// through the /api/gateway proxy. Types mirror the gateway's JSON.

import { getUser } from "./auth";

export class GatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export async function gw<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-user-email", getUser() ?? "dev");
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  const response = await fetch(`/api/gateway${path}`, { ...init, headers });
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : ((detail as { message?: string } | undefined)?.message ??
          `Request failed (${response.status})`);
    throw new GatewayError(message, response.status, detail);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

export const json = (body: unknown) => ({ body: JSON.stringify(body) });

export type ImportStatus =
  | "uploaded"
  | "analysing"
  | "remapping"
  | "mapping_review"
  | "building_report"
  | "report_review"
  | "committing"
  | "committed"
  | "failed"
  | "cancelled";

export const RUNNING: ImportStatus[] = [
  "uploaded",
  "analysing",
  "remapping",
  "building_report",
  "committing",
];

export type ImportSummary = {
  id: string;
  filename: string;
  document_id: string;
  size: number;
  status: ImportStatus;
  step: string | null;
  progress: number;
  eta_seconds: number | null;
  error: string | null;
  source_type: string;
  as_of: string | null;
  version_id: number | null;
  created_by: string;
  created_at: string;
  rows: number | null;
};

export type Column = {
  index: number;
  letter: string;
  header: string;
  field: string | null;
  period: number | null;
  confidence: number | null;
  reason: string;
  suggested_field: string | null;
  changed_from?: string | null;
};

export type Table = {
  sheet: string;
  title: string;
  header_row: number;
  first_data_row: number;
  last_row: number;
  row_count: number;
  include: boolean;
  columns: Column[];
  notes?: string;
  formula_gaps?: string[];
  preview: { row: number; cells: unknown[] }[];
};

export type Match = {
  level: "certain" | "likely" | "suggestion" | "none";
  entity_id: string | null;
  label: string | null;
  reason: string;
};

export type ReportCell = {
  letter: string;
  field: string;
  entity: string;
  raw: string;
  value?: unknown;
  error?: string;
  score?: number;
  period?: number | null;
  vs?: "new" | "same" | "wins" | "loses";
  current?: unknown;
  current_score?: number;
  derived?: boolean;
};

export type ReportRow = {
  key: string;
  table: number;
  sheet: string;
  row: number;
  company: { label: string | null; match: Match } | null;
  person: { label: string; match: Match } | null;
  duplicate_of: string | null;
  cells: ReportCell[];
  errors: string[];
  decision: string;
};

export type Report = {
  base_version: number;
  notice?: string | null;
  summary: {
    rows: number;
    rows_with_errors: number;
    rows_skipped: number;
    companies: Record<string, number>;
    people: Record<string, number>;
    values: Record<string, number>;
    quality: Record<string, number>;
  };
  unmapped_columns: {
    table: number;
    sheet: string;
    letter: string;
    header: string;
    samples: string[];
  }[];
  formula_gaps: { sheet: string; cells: string[] }[];
  rows: ReportRow[];
};

export type ImportDetail = ImportSummary & {
  warnings: string[];
  list_id: string | null;
  new_list_name: string | null;
  catalogue_version: string;
  tables: Table[];
  feedback: { text: string; by: string; at: string }[];
  report: Report | null;
  decisions: Record<string, string>;
};

export type DataPoint = {
  key: string;
  entity: string;
  label: string;
  type: string;
  many: boolean;
  options: string[];
  description: string;
  applies_to: string | null;
  periodic: boolean;
};

export type Catalogue = { version: string; points: DataPoint[] };

export type SourceType = { key: string; label: string; confidence: number };

export type Version = {
  id: number;
  kind: "import" | "revert" | "manual";
  author: string;
  message: string;
  counts: Record<string, number>;
  created_at: string;
  import_id: string | null;
  filename: string | null;
  reverts_version_id: number | null;
  reverted_by_version_id: number | null;
};

/** Shows a normalised value compactly (money, locations, dates, lists). */
export function show(value: unknown): string {
  if (value === null || value === undefined) return "–";
  if (Array.isArray(value)) return value.map(show).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("amount" in v) {
      const n = Number(v.amount);
      const short =
        Math.abs(n) >= 1e9
          ? `${(n / 1e9).toFixed(1)}B`
          : Math.abs(n) >= 1e6
            ? `${(n / 1e6).toFixed(1)}M`
            : n.toLocaleString("en-US");
      return `${v.currency ? `${v.currency} ` : ""}${short}`;
    }
    if ("date" in v)
      return v.precision === "year"
        ? String(v.date).slice(0, 4)
        : v.precision === "month"
          ? String(v.date).slice(0, 7)
          : String(v.date);
    if ("city" in v || "country" in v)
      return [v.city, v.region, v.country].filter(Boolean).join(", ") || "–";
    return JSON.stringify(v);
  }
  return String(value);
}
