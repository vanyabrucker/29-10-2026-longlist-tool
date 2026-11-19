// Real longlists from helios-gateway (GET /longlists, /longlists/{id}, its
// versions, changes, restore and export). Types mirror the gateway's JSON.

import { FIELD_DE } from "./corpus";
import type { Level } from "./corpus";
import type { MessageKey, Translate } from "./i18n";

export type Person = { email: string; name: string };

export type LonglistSummary = {
  id: string;
  name: string;
  target: string | null;
  kind: "financial" | "strategic" | null;
  owner: Person;
  size: number;
  head_version: number;
  created_at: string;
  edited_at: string;
};

export type Diff = "added" | "removed" | null;

export type ListColumn = {
  key: string;
  label: string;
  type: string;
  position: number;
  /** corpus:<data point>, list (relevance) or custom (list-only). */
  source: string;
  diff?: Diff;
};

/** Who prioritized a corpus value (or typed it in, for a manual value). */
export type Marker = { by: string; name: string; at: string | null };

export type ListCell = {
  value: unknown;
  /** In a diff: the value before this version. */
  old?: unknown;
  changed?: boolean;
  // Corpus cells only:
  score?: number;
  level?: Level;
  confidence?: number;
  freshness?: number | null;
  as_of?: string | null;
  source?: string;
  sources?: number;
  pinned?: Marker | null;
  manual?: Marker | null;
  // List-only values (rows not in the corpus, custom columns):
  /** Who put the value on the list, and when. */
  added?: Marker | null;
  /** The web page it came from. */
  url?: string | null;
  source_title?: string | null;
};

export type ListRow = {
  id: string;
  company_id: string | null;
  cells: Record<string, ListCell>;
  diff: Diff;
};

export type ListTable = LonglistSummary & {
  version: number;
  columns: ListColumn[];
  rows: ListRow[];
  corpus_version: number;
  /** Cells, rows and columns this version changed (diff reads only). */
  changes: number | null;
};

export type ListVersion = {
  number: number;
  /** Email, or "agent". */
  author: string;
  author_name: string;
  message: string;
  created_at: string;
  changes: number;
  reverts: number | null;
  latest: boolean;
};

export type Op =
  | { op: "set"; entry_id: string; key: string; value: string }
  | { op: "remove_entry"; entry_id: string }
  | { op: "remove_column"; key: string }
  | { op: "order_columns"; keys: string[] };

const LIST_DE: Record<string, string> = {
  relevance_score: "Relevanz",
  relevance_explanation: "Begründung",
};

/** A column's label: catalogue data points in German too, custom columns
 * as written. */
export function columnLabel(
  c: Pick<ListColumn, "key" | "label" | "source">,
  lang: string,
) {
  if (lang !== "de" || c.source === "custom") return c.label;
  return LIST_DE[c.key] ?? FIELD_DE[c.key] ?? c.label;
}

/** The research table's header groups. */
export function groupOf(c: ListColumn): MessageKey {
  if (
    c.source !== "custom" &&
    /revenue|ebitda|ebit|aum|ticket_size/.test(c.key)
  )
    return "Financials";
  if (
    c.source === "custom" ||
    c.source === "list" ||
    ["investor_type", "sector", "sub_sector", "buyer_category"].includes(c.key)
  )
    return "Buyer company information";
  return "Buyer profile";
}

export function widthOf(c: ListColumn) {
  if (c.type === "long_text") return 300;
  if (c.type === "domain" || c.type === "url") return 200;
  if (c.type === "year") return 100;
  if (["int", "decimal", "money", "percent"].includes(c.type)) return 130;
  return 160;
}

export const isNumeric = (c: ListColumn) =>
  ["int", "decimal", "money", "percent", "year"].includes(c.type);

/** A value to sort by: money by amount, text lower-cased. */
export function sortValue(value: unknown): number | string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return value;
  if (typeof value === "object" && value && "amount" in value)
    return Number((value as { amount: unknown }).amount);
  if (typeof value === "object") return JSON.stringify(value).toLowerCase();
  return String(value).toLowerCase();
}

/** "Today, 09:12", "Yesterday, 16:40", then the date. */
export function formatEdited(iso: string, t: Translate, lang: string) {
  const locale = lang === "de" ? "de-CH" : "en-GB";
  const at = new Date(iso);
  const time = at.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const days = Math.round(
    (new Date(new Date().toDateString()).getTime() -
      new Date(at.toDateString()).getTime()) /
      86_400_000,
  );
  if (days === 0) return t("Today, {time}", { time });
  if (days === 1) return t("Yesterday, {time}", { time });
  return at.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
