"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { Activity, Briefcase, DollarSign, Globe } from "react-feather";
import {
  LEVEL_LABEL,
  formatAge,
  type CellQuality,
  type QualityLevel,
  type QualitySummary,
  type SourceCategory,
} from "@/lib/quality";
import { useDismiss } from "@/lib/useDismiss";

// Warning colours are reserved for quality; good data stays neutral.
const DOT: Record<QualityLevel, string> = {
  high: "bg-good",
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

// One dot geometry everywhere, so the cell's dot, the hover box's dot and the
// table rows inside the box all line up: 7px dot 12px from the left edge,
// text 28px in (DOT_TEXT_INSET). Only flagged cells get the extra inset.
export const DOT_TEXT_INSET = "pl-[28px]";
const DOT_POSITION =
  "absolute top-[11.5px] left-[12px] size-[7px] rounded-full";

/** Dot left of a flagged cell's text. */
export function QualityDot({ quality }: { quality: CellQuality }) {
  if (quality.level === "high") return null;
  return (
    <span
      aria-label={LEVEL_LABEL[quality.level]}
      className={`pointer-events-none ${DOT_POSITION} ${DOT[quality.level]}`}
    />
  );
}

/** Same dot, drawn in the hover box exactly over the cell's own dot. */
export function QualityDotOverlay({ quality }: { quality: CellQuality }) {
  return (
    <span aria-hidden className={`${DOT_POSITION} ${DOT[quality.level]}`} />
  );
}

// Dot column 16px wide (7px dot + gap), so labels start at the same 28px as
// the cell text above them.
function Row({
  level,
  label,
  note,
  value,
  head = false,
}: {
  level: QualityLevel;
  label: string;
  note?: string;
  value: string;
  head?: boolean;
}) {
  return (
    <div className="grid grid-cols-[16px_1fr_auto] items-center">
      <span className={`size-[7px] rounded-full ${DOT[level]}`} />
      <span className="min-w-0 truncate">
        <span className={head ? "font-medium" : "text-muted"}>{label}</span>
        {note && <span className="ml-1.5 text-faint">{note}</span>}
      </span>
      <span
        className={`pl-3 text-right tabular-nums ${head ? "font-medium" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Quality section of a flagged cell's hover box: the overall quality while
 * hovering; clicking the cell expands it with its components and sources.
 */
export function QualitySection({
  quality,
  expanded,
}: {
  quality: CellQuality;
  expanded: boolean;
}) {
  return (
    <div className="mt-1.5 border-t border-line pt-1.5 text-[12.5px] leading-snug">
      <Row
        head
        level={quality.level}
        label="Quality"
        // Level next to the label, score on the right, like the rows below.
        note={quality.score === null ? undefined : LEVEL_WORD[quality.level]}
        value={quality.score === null ? "Unknown" : `${quality.score}/100`}
      />
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 space-y-1 border-t border-line pt-1.5">
              <Row
                level={levelFor(quality.confidence)}
                label="Source confidence"
                note={`${quality.reliability} reliability`}
                value={`${quality.confidence}/100`}
              />
              <Row
                level={levelFor(quality.freshness)}
                label="Freshness"
                note={
                  quality.checkedDaysAgo === null
                    ? "Never checked"
                    : formatAge(quality.checkedDaysAgo)
                }
                value={
                  quality.freshness === null
                    ? "Unknown"
                    : `${quality.freshness}/100`
                }
              />
            </div>
            <SourcesTable sources={quality.sources} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Where a source comes from, as a grey icon in the dot column.
const CATEGORY: Record<SourceCategory, { icon: typeof Globe; label: string }> =
  {
    proprietary: { icon: DollarSign, label: "Proprietary data" },
    internal: { icon: Briefcase, label: "Internal data" },
    public: { icon: Globe, label: "Public data" },
  };

function SourceIcon({ category }: { category: SourceCategory }) {
  const { icon: Icon, label } = CATEGORY[category];
  return (
    <span className="group/source relative flex">
      {/* Centred on the 7px dots above (12px icon, 2.5px back). */}
      <Icon
        size={12}
        strokeWidth={1.75}
        aria-label={label}
        className="-ml-[2.5px] text-muted"
      />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full -left-[2.5px] z-10 mb-1 rounded-md bg-ink px-2 py-[3px] text-[12px] leading-[14px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity duration-150 group-hover/source:opacity-100 group-hover/source:delay-150"
      >
        {label}
      </span>
    </span>
  );
}

function SourcesTable({ sources }: { sources: CellQuality["sources"] }) {
  return (
    <table className="mt-2 w-full table-fixed border-t border-line text-left text-[12px]">
      <colgroup>
        <col className="w-[16px]" />
        <col />
        <col className="w-[66px]" />
      </colgroup>
      <thead className="text-faint">
        <tr>
          <th />
          <th className="pt-1.5 pb-0.5 font-normal">Source</th>
          <th className="pt-1.5 pb-0.5 font-normal">Updated</th>
        </tr>
      </thead>
      <tbody>
        {sources.map((s) => (
          <tr key={s.label + s.type} className={s.current ? "" : "text-muted"}>
            <td className="py-0.5">
              <SourceIcon category={s.category} />
            </td>
            <td className="py-0.5 pr-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{s.label}</span>
                {s.current && (
                  <span className="shrink-0 rounded bg-subtle px-1 text-[10.5px] font-medium text-ink">
                    Current
                  </span>
                )}
              </span>
            </td>
            <td className="truncate py-0.5">{s.updated ?? "Unknown"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Toolbar button with the overall score; opens the level distribution. */
export function DataQualityMenu({ summary }: { summary: QualitySummary }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`}
      >
        <Activity size={14} strokeWidth={1.75} />
        Data quality
        <span className="text-muted tabular-nums">{summary.score}</span>
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
            className="absolute top-full right-0 z-30 mt-2 w-[300px] origin-top-right rounded-xl border border-line bg-white p-3.5 text-[13.5px] shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="font-serif text-[30px] leading-none tabular-nums">
                {summary.score}
              </span>
              <span className="text-muted">/100</span>
            </div>

            <div className="mt-3.5 flex h-1.5 overflow-hidden rounded-full bg-subtle">
              {LEVELS.map((l) => (
                <span
                  key={l}
                  className={DOT[l]}
                  style={{ width: `${summary.distribution[l] * 100}%` }}
                />
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-muted">
              {LEVELS.map((l) => (
                <span key={l} className="flex items-center gap-1.5">
                  <span className={`size-1.5 rounded-full ${DOT[l]}`} />
                  {LEVEL_WORD[l]}
                  <span className="ml-auto text-ink tabular-nums">
                    {Math.round(summary.distribution[l] * 100)}%
                  </span>
                </span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const LEVELS: QualityLevel[] = ["high", "medium", "low", "unknown"];
