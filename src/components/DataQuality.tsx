"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ChevronRight,
  ExternalLink,
  X,
} from "react-feather";
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

// Warning colours are reserved for quality markers; good data stays neutral.
const MARKER: Record<Exclude<QualityLevel, "high">, string> = {
  medium: "border-t-warn",
  low: "border-t-bad",
  unknown: "border-t-faint",
};

const DOT: Record<QualityLevel, string> = {
  high: "bg-sky-ink",
  medium: "bg-warn",
  low: "bg-bad",
  unknown: "bg-[#d4d4d8]",
};

const columnLabel = (key: SortKey) =>
  key === "name"
    ? "Buyer name"
    : (COLUMNS.find((c) => c.key === key)?.label ?? key);

/** Small triangle in a cell's top-right corner; only for cells worth a look. */
export function QualityMarker({ quality }: { quality: CellQuality }) {
  if (quality.level === "high") return null;
  return (
    <span
      aria-label={LEVEL_LABEL[quality.level]}
      className={`pointer-events-none absolute top-0 right-0 size-0 border-t-[7px] border-l-[7px] border-l-transparent ${MARKER[quality.level]}`}
    />
  );
}

function LevelBadge({ quality }: { quality: CellQuality }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-2 rounded-full ${DOT[quality.level]}`} />
      <span className="font-medium">{LEVEL_LABEL[quality.level]}</span>
      {quality.score !== null && (
        <span className="text-muted tabular-nums">· {quality.score}/100</span>
      )}
    </span>
  );
}

/** Extra lines under the full-text hover preview for flagged cells. */
export function QualityHoverSection({ quality }: { quality: CellQuality }) {
  const reason = qualityReason(quality);
  return (
    <div className="mt-1.5 border-t border-line pt-1.5 text-[12.5px] leading-snug">
      <LevelBadge quality={quality} />
      {reason && <p className="mt-0.5 text-muted">{reason}</p>}
      <p className="mt-0.5 text-faint">Click for details</p>
    </div>
  );
}

export type PinnedCell = {
  top: number;
  left: number;
  value: React.ReactNode;
  column: SortKey;
  quality: CellQuality;
};

/** Click-to-open evidence card for one cell. */
export function QualityDetails({
  pinned,
  onClose,
}: {
  pinned: PinnedCell | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, pinned !== null, onClose);

  return (
    <AnimatePresence>
      {pinned && (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label="Data quality details"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          style={{
            top: Math.min(pinned.top, window.innerHeight - 340),
            left: Math.min(pinned.left, window.innerWidth - 316),
          }}
          className="fixed z-[70] w-[300px] rounded-xl border border-line bg-white p-3.5 text-[13px] shadow-[0_8px_28px_rgba(0,0,0,0.1)]"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-muted">
                {columnLabel(pinned.column)}
              </p>
              <p className="mt-0.5 leading-snug font-medium break-words">
                {pinned.value}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mt-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-[#5d5d63] hover:bg-subtle"
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>

          <div className="mt-3 text-[13.5px]">
            <LevelBadge quality={pinned.quality} />
          </div>

          <dl className="mt-3 space-y-2.5">
            <Metric
              label="Source confidence"
              value={`${pinned.quality.confidence}/100`}
              note={`${pinned.quality.sourceType} · ${pinned.quality.reliability} reliability`}
            />
            <Metric
              label="Freshness"
              value={
                pinned.quality.freshness === null
                  ? "Unknown"
                  : `${pinned.quality.freshness}/100`
              }
              note={
                pinned.quality.checkedDaysAgo === null
                  ? "No verification date on record"
                  : `Last checked ${formatAge(pinned.quality.checkedDaysAgo)}`
              }
            />
            <Metric
              label="Source updated"
              value={pinned.quality.sourceUpdated ?? "Unknown"}
            />
            <Metric label="Verified by" value={pinned.quality.method} />
          </dl>

          <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5">
            <span className="min-w-0 flex-1 truncate text-muted">
              {pinned.quality.source}
            </span>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 font-medium hover:underline"
            >
              View evidence
              <ExternalLink size={12} strokeWidth={1.75} />
            </button>
          </div>
          <p className="mt-2 text-[11.5px] leading-snug text-faint">
            Estimates of trustworthiness from the available evidence, not
            measured accuracy.
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="shrink-0 whitespace-nowrap text-muted">{label}</dt>
        <dd className="text-right font-medium tabular-nums">{value}</dd>
      </div>
      {note && <p className="mt-0.5 text-[12px] text-faint">{note}</p>}
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
