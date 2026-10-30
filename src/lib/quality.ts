// Fake per-cell data quality, derived deterministically from the row and
// column so every demo run shows the same picture.
//
// Model: source confidence C and freshness F (both 0–100) multiply into an
// overall score Q = C·F/100. Freshness decays per field with a half-life, so a
// legal name stays fresh for years while deal activity goes stale in months.
// Cells without a verification date are "unknown", which is not the same as
// bad: they get no score.

import type { BuyerList, BuyerRow, SortKey } from "./research";

export type QualityLevel = "high" | "medium" | "low" | "unknown";
export type QualityIssue = "stale" | "lowConfidence" | "unknown";

export type CellQuality = {
  level: QualityLevel;
  /** Overall 0–100; null when unknown. */
  score: number | null;
  confidence: number;
  /** 0–100; null when there's no verification date. */
  freshness: number | null;
  issue: QualityIssue | null;
  sourceType: string;
  reliability: "High" | "Medium" | "Low";
  method: string;
  /** Days since we last verified the value; null when unknown. */
  checkedDaysAgo: number | null;
  /** When the source itself last changed, if known. */
  sourceUpdated: string | null;
  source: string;
};

export const LEVEL_LABEL: Record<QualityLevel, string> = {
  high: "High quality",
  medium: "Medium quality",
  low: "Low quality",
  unknown: "Unknown quality",
};

export const ISSUE_LABEL: Record<QualityIssue, string> = {
  stale: "Stale information",
  lowConfidence: "Low source confidence",
  unknown: "Unverified information",
};

// Days until a field's freshness halves.
const HALF_LIFE: Record<SortKey, number> = {
  name: 1095,
  types: 365,
  rationale: 240,
  deals: 150,
  lastDeal: 120,
  hq: 730,
  founded: 3650,
  aum: 200,
  website: 540,
};

const SOURCES = [
  { type: "Company website", reliability: "High" },
  { type: "Registry filing", reliability: "High" },
  { type: "Deal database", reliability: "High" },
  { type: "Press release", reliability: "Medium" },
  { type: "Professional network profile", reliability: "Medium" },
  { type: "News article", reliability: "Low" },
] as const;

const METHODS = [
  "Agent",
  "Automated registry match",
  "Analyst review · Vanya Brucker",
];

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// FNV-1a → [0, 1).
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

const between = (r: number, lo: number, hi: number) =>
  Math.round(lo + r * (hi - lo));

// Freshness F = 100 · 2^(−t/h)  ⇔  t = −h · log2(F/100).
const daysFor = (freshness: number, halfLife: number) =>
  Math.max(1, Math.round(-halfLife * Math.log2(freshness / 100)));

export function cellQuality(row: BuyerRow, key: SortKey): CellQuality {
  const seed = `${row.id}:${key}`;
  const r = hash(seed);
  const r2 = hash(`${seed}:b`);
  const r3 = hash(`${seed}:c`);
  const halfLife = HALF_LIFE[key];

  // ~85% high, ~10% medium, ~4% low, ~1% unknown.
  const level: QualityLevel =
    r < 0.01 ? "unknown" : r < 0.05 ? "low" : r < 0.15 ? "medium" : "high";

  let confidence: number;
  let freshness: number | null;
  let issue: QualityIssue | null = null;
  if (level === "high") {
    confidence = between(r2, 86, 99);
    freshness = between(r3, 84, 100);
  } else if (level === "unknown") {
    confidence = between(r2, 55, 85);
    freshness = null;
    issue = "unknown";
  } else {
    // Medium lands at 45–69 overall, low below 45.
    // Slow-changing fields (name, founding year) don't go stale.
    issue = r2 < 0.65 && halfLife < 1000 ? "stale" : "lowConfidence";
    const [weakLo, weakHi] = level === "medium" ? [52, 74] : [18, 44];
    const strong = between(r3, 88, 97);
    confidence = issue === "stale" ? strong : between(r3, weakLo, weakHi);
    freshness =
      issue === "stale" ? between(r2, weakLo, weakHi) : between(r3, 90, 100);
  }

  const source =
    issue === "lowConfidence"
      ? SOURCES[5]
      : SOURCES[Math.floor(hash(`${seed}:s`) * 5)];
  const checkedDaysAgo =
    freshness === null ? null : daysFor(Math.max(freshness, 1), halfLife);
  const updatedMonthsBefore = Math.round(hash(`${seed}:u`) * 18);
  const sourceUpdated =
    checkedDaysAgo === null || hash(`${seed}:k`) < 0.35
      ? null
      : monthYear(checkedDaysAgo + updatedMonthsBefore * 30);

  return {
    level,
    score:
      freshness === null ? null : Math.round((confidence * freshness) / 100),
    confidence,
    freshness,
    issue,
    sourceType: source.type,
    reliability: source.reliability,
    method: METHODS[Math.floor(hash(`${seed}:m`) * METHODS.length)],
    checkedDaysAgo,
    sourceUpdated,
    source: sourceUrl(row, source.type),
  };
}

// Today in the demo's world.
const TODAY = new Date(2026, 9, 30);

function monthYear(daysAgo: number) {
  const d = new Date(TODAY.getTime() - daysAgo * 86_400_000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function sourceUrl(row: BuyerRow, type: string) {
  if (type === "Company website") return row.website;
  if (type === "Registry filing") return "registry.example/filings";
  if (type === "Deal database") return "deals.example/transactions";
  if (type === "News article") return "news.example/markets";
  if (type === "Press release") return `${row.website}/press`;
  return "network.example/company";
}

export function formatAge(days: number) {
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

// One-line reason shown in the hover card.
export function qualityReason(q: CellQuality) {
  if (q.issue === "unknown") return "No verification date on record";
  if (q.issue === "stale" && q.checkedDaysAgo !== null)
    return `Last checked ${formatAge(q.checkedDaysAgo)}`;
  if (q.issue === "lowConfidence")
    return `Single ${q.reliability.toLowerCase()}-reliability source (${q.sourceType.toLowerCase()})`;
  return null;
}

export const isFlagged = (q: CellQuality) => q.level !== "high";

export type QualitySummary = {
  score: number;
  /** Share of cells per level, 0–1. */
  distribution: Record<QualityLevel, number>;
  /** Cells per issue, scaled to the full list. */
  issues: Record<QualityIssue, number>;
  /** Columns with the most stale cells, for the recommendation. */
  staleColumns: SortKey[];
};

// Aggregates the sample rows and scales counts up to the list's full size.
export function summarize(list: BuyerList, keys: SortKey[]): QualitySummary {
  const levels: Record<QualityLevel, number> = {
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };
  const issues: Record<QualityIssue, number> = {
    stale: 0,
    lowConfidence: 0,
    unknown: 0,
  };
  const stalePerKey = new Map<SortKey, number>();
  let scoreSum = 0;
  let scored = 0;
  let cells = 0;
  for (const row of list.rows) {
    for (const key of keys) {
      const q = cellQuality(row, key);
      cells++;
      levels[q.level]++;
      if (q.issue) issues[q.issue]++;
      if (q.issue === "stale")
        stalePerKey.set(key, (stalePerKey.get(key) ?? 0) + 1);
      if (q.score !== null) {
        scoreSum += q.score;
        scored++;
      }
    }
  }
  const scale = list.total / list.rows.length;
  return {
    score: Math.round(scoreSum / Math.max(1, scored)),
    distribution: {
      high: levels.high / cells,
      medium: levels.medium / cells,
      low: levels.low / cells,
      unknown: levels.unknown / cells,
    },
    issues: {
      stale: Math.round(issues.stale * scale),
      lowConfidence: Math.round(issues.lowConfidence * scale),
      unknown: Math.round(issues.unknown * scale),
    },
    staleColumns: [...stalePerKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => k),
  };
}

// Earlier versions were less polished: the score climbs with each iteration.
const VERSION_OFFSETS = [0, 4, 9, 17];
export function versionQuality(
  latestScore: number,
  latest: number,
  version: number,
) {
  return latestScore - (VERSION_OFFSETS[latest - version] ?? 20);
}
