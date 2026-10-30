"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { Activity, ArrowRight, ChevronRight } from "react-feather";
import {
  ISSUE_LABEL,
  LEVEL_LABEL,
  formatAge,
  qualityReason,
  type CellQuality,
  type QualityIssue,
  type QualityLevel,
  type QualitySummary,
} from "@/lib/quality";
import { COLUMNS, type SortKey } from "@/lib/research";
import { useDismiss } from "@/lib/useDismiss";

// Warning colours are reserved for quality; good data stays neutral.
const DOT: Record<QualityLevel, string> = {
  high: "bg-sky-ink",
  medium: "bg-warn",
  low: "bg-bad",
  unknown: "bg-[#d4d4d8]",
};

const LEVEL_WORD: Record<QualityLevel, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

// Same thresholds as the overall score, applied to one component.
const levelFor = (score: number | null): QualityLevel =>
  score === null
    ? "unknown"
    : score >= 70
      ? "high"
      : score >= 45
        ? "medium"
        : "low";

// Shared by the cell and the hover box so the dot doesn't move between them:
// vertically centred on the first text line, inside the cell's left padding.
const DOT_POSITION = "absolute top-[12.5px] left-[4px] size-[5px] rounded-full";

export const columnLabel = (key: SortKey) =>
  key === "name"
    ? "Buyer name"
    : (COLUMNS.find((c) => c.key === key)?.label ?? key);

/** Small dot left of the text; only for cells worth a look. */
export function QualityDot({ quality }: { quality: CellQuality }) {
  if (quality.level === "high") return null;
  return (
    <span
      aria-label={LEVEL_LABEL[quality.level]}
      className={`pointer-events-none ${DOT_POSITION} ${DOT[quality.level]}`}
    />
  );
}

/** Same dot, drawn in the hover box over the cell's own dot. */
export function QualityDotOverlay({ quality }: { quality: CellQuality }) {
  return (
    <span aria-hidden className={`${DOT_POSITION} ${DOT[quality.level]}`} />
  );
}

function Row({
  level,
  label,
  value,
  note,
  head = false,
}: {
  level: QualityLevel;
  label: string;
  value: string;
  note?: string;
  head?: boolean;
}) {
  return (
    <div className="grid grid-cols-[12px_1fr_auto] items-baseline gap-x-1">
      <span
        className={`size-[7px] -translate-y-px rounded-full ${DOT[level]}`}
      />
      <span className={head ? "font-medium" : "text-muted"}>{label}</span>
      <span className={`text-right tabular-nums ${head ? "font-medium" : ""}`}>
        {value}
      </span>
      {note && (
        <span className="col-start-2 col-end-4 text-[12px] text-faint">
          {note}
        </span>
      )}
    </div>
  );
}

const overall = (q: CellQuality) =>
  q.score === null
    ? LEVEL_WORD[q.level]
    : `${LEVEL_WORD[q.level]} · ${q.score}/100`;

/**
 * Quality section of a flagged cell's hover box. Collapsed it shows the
 * overall quality and why; clicking the cell expands it into the full table.
 */
export function QualitySection({
  quality,
  expanded,
}: {
  quality: CellQuality;
  expanded: boolean;
}) {
  const reason = qualityReason(quality);
  return (
    <div className="mt-1.5 border-t border-line pt-1.5 text-[12.5px] leading-snug">
      <Row
        head
        level={quality.level}
        label="Quality"
        value={overall(quality)}
      />
      {!expanded && (
        <>
          {reason && <p className="mt-0.5 pl-4 text-muted">{reason}</p>}
          <p className="mt-0.5 pl-4 text-faint">Click for details</p>
        </>
      )}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 space-y-1.5 border-t border-line pt-1.5">
              <Row
                level={levelFor(quality.confidence)}
                label="Source confidence"
                value={`${quality.confidence}/100`}
                note={`${quality.sourceType} · ${quality.reliability} reliability`}
              />
              <Row
                level={levelFor(quality.freshness)}
                label="Freshness"
                value={
                  quality.freshness === null
                    ? "Unknown"
                    : `${quality.freshness}/100`
                }
                note={
                  quality.checkedDaysAgo === null
                    ? "No verification date on record"
                    : `Last checked ${formatAge(quality.checkedDaysAgo)}`
                }
              />
            </div>
            <dl className="mt-2 space-y-0.5 border-t border-line pt-1.5 pl-4">
              <Detail
                label="Source updated"
                value={quality.sourceUpdated ?? "Unknown"}
              />
              <Detail label="Verified by" value={quality.method} />
              <Detail label="Source" value={quality.source} />
            </dl>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 whitespace-nowrap text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}

const ISSUES: QualityIssue[] = ["stale", "lowConfidence", "unknown"];
const ISSUE_MARKER: Record<QualityIssue, string> = {
  stale: "border-t-warn",
  lowConfidence: "border-t-bad",
  unknown: "border-t-faint",
};

/** Toolbar button + panel: overall score, distribution, issues to filter by. */
export function DataQualityMenu({
  summary,
  previous,
  filter,
  onFilter,
}: {
  summary: QualitySummary;
  /** Previous version's score, for the trend line. */
  previous: { version: number; score: number } | null;
  filter: QualityIssue | null;
  onFilter: (issue: QualityIssue | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const attention =
    summary.distribution.medium + summary.distribution.low > 0.1;

  const shown = summary;

  const pick = (issue: QualityIssue) => {
    onFilter(filter === issue ? null : issue);
    close();
  };

  const staleCols = shown.staleColumns.map((k) => columnLabel(k)).join(" and ");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium transition-colors hover:bg-subtle ${open || filter ? "bg-subtle" : ""}`}
      >
        <span className="relative">
          <Activity size={14} strokeWidth={1.75} />
          {attention && (
            <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warn ring-2 ring-white" />
          )}
        </span>
        Data quality
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Data quality"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute top-full right-0 z-30 mt-2 w-[340px] origin-top-right rounded-xl border border-line bg-white p-3.5 text-[13.5px] shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">Data quality</span>
              <span
                className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                  attention
                    ? "bg-warn/15 text-[#9a6700]"
                    : "bg-sky text-[#5b7db1]"
                }`}
              >
                {attention ? "Needs attention" : "Good"}
              </span>
            </div>

            <div className="mt-2 flex items-baseline gap-2">
              <span className="font-serif text-[30px] leading-none tabular-nums">
                {shown.score}
              </span>
              <span className="text-muted">/100 overall</span>
            </div>
            {previous && (
              <p className="mt-1 text-[12.5px] text-muted">
                {shown.score >= previous.score ? "Up" : "Down"}{" "}
                {Math.abs(shown.score - previous.score)} since Version{" "}
                {previous.version}
              </p>
            )}

            {/* Distribution */}
            <div className="mt-3.5 flex h-1.5 overflow-hidden rounded-full bg-subtle">
              {(["high", "medium", "low", "unknown"] as const).map((l) => (
                <span
                  key={l}
                  className={DOT[l]}
                  style={{ width: `${shown.distribution[l] * 100}%` }}
                />
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-muted">
              {(["high", "medium", "low", "unknown"] as const).map((l) => (
                <span key={l} className="flex items-center gap-1.5">
                  <span className={`size-1.5 rounded-full ${DOT[l]}`} />
                  {l[0].toUpperCase() + l.slice(1)}
                  <span className="ml-auto text-ink tabular-nums">
                    {Math.round(shown.distribution[l] * 100)}%
                  </span>
                </span>
              ))}
            </div>

            {/* Issues */}
            <p className="mt-4 mb-1 text-[12px] text-muted">
              Issues to investigate
            </p>
            <div className="-mx-1.5">
              {ISSUES.map((issue) => (
                <button
                  key={issue}
                  type="button"
                  onClick={() => pick(issue)}
                  aria-pressed={filter === issue}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-subtle ${filter === issue ? "bg-subtle" : ""}`}
                >
                  <span className="relative size-3.5 shrink-0 rounded-[3px] border border-line">
                    <span
                      className={`absolute top-0 right-0 size-0 border-t-[6px] border-l-[6px] border-l-transparent ${ISSUE_MARKER[issue]}`}
                    />
                  </span>
                  <span className="flex-1">{ISSUE_LABEL[issue]}</span>
                  <span className="text-muted tabular-nums">
                    {shown.issues[issue].toLocaleString("en-US")} cells
                  </span>
                  <ChevronRight
                    size={14}
                    strokeWidth={1.75}
                    className="text-faint"
                  />
                </button>
              ))}
            </div>

            {/* Recommendation */}
            <div className="mt-3 rounded-lg bg-canvas p-3">
              <p className="text-[12px] text-muted">Recommended</p>
              <p className="mt-1 leading-snug">
                {shown.issues.stale.toLocaleString("en-US")} cells haven&apos;t
                been checked recently, mostly {staleCols}. Review those first.
              </p>
              <button
                type="button"
                onClick={() => pick("stale")}
                className="mt-2 flex items-center gap-1 font-medium hover:underline"
              >
                Review stale data
                <ArrowRight size={13} strokeWidth={1.75} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
