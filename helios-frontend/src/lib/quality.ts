// Shared quality types and helpers for company / list cells (no demo data).

import type { MessageKey, Translate } from "./i18n";

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
  /** Days since we last verified the value; null when unknown. */
  checkedDaysAgo: number | null;
  sources: CellSource[];
};

/** Licensed databases, our own past work, or the open web. */
export type SourceCategory = "proprietary" | "internal" | "public";

export type CellSource = {
  label: string;
  url: string;
  type: string;
  category: SourceCategory;
  updated: string | null;
  current: boolean;
};

export type QualitySummary = {
  score: number;
  distribution: Record<QualityLevel, number>;
};

export const LEVEL_LABEL: Record<QualityLevel, MessageKey> = {
  high: "High quality",
  medium: "Medium quality",
  low: "Low quality",
  unknown: "Unknown quality",
};

/** "7 days ago" for quality boxes. */
export function formatAge(days: number | null, t: Translate): string {
  if (days === null) return t("Never checked");
  if (days === 1) return t("{n} day ago", { n: 1 });
  return t("{n} days ago", { n: days });
}
