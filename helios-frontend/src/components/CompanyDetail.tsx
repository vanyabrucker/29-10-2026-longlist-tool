"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, Loader } from "react-feather";
import {
  DOT,
  LEVEL_WORD,
  QualityRow,
  SourceIcon,
  levelFor,
} from "@/components/DataQuality";
import {
  fieldLabel,
  formatDay,
  formatValue,
  provenance,
  sourceLabel,
  type Cell,
  type CompanyDetail,
  type Source,
} from "@/lib/corpus";
import { gw, json } from "@/lib/gateway";
import { useI18n } from "@/lib/i18n";
import { formatAge } from "@/lib/quality";
import { PinIcon } from "./PinIcon";

const EASE = [0.32, 0.72, 0, 1] as const;
const keyOf = (c: Cell) => `${c.field}:${c.period ?? 0}`;

/** One company: every data point with its shown value, quality and sources.
 * Anyone signed in can prioritize a source over the quality score. */
export function CompanyDetailPanel({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    gw<CompanyDetail>(`/companies/${encodeURIComponent(id)}`).then(
      (c) => live && setCompany(c),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [id]);

  const back = () =>
    // Back to the search as it was, or to the search page on a direct visit.
    window.history.length > 1 ? router.back() : router.push("/companies");

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const cell = (field: string) => company?.cells.find((c) => c.field === field);
  const subline = ["website", "hq", "sector"]
    .map((f) => cell(f))
    .filter((c): c is Cell => !!c)
    .map((c) => formatValue(c.value, t, lang))
    .filter(Boolean);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="min-h-0 flex-1 overflow-y-auto px-8 pt-8 pb-12 [scrollbar-width:none]"
    >
      <div className="mx-auto max-w-[880px]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={back}
            aria-label={t("Back to companies")}
            className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-subtle hover:text-ink"
          >
            <ArrowLeft size={17} strokeWidth={1.75} />
          </button>
          <h1 className="min-w-0 truncate font-serif text-[28px] leading-tight tracking-[-0.01em]">
            {company
              ? formatValue(company.name, t, lang) || t("Unnamed company")
              : missing
                ? t("Company not found")
                : " "}
          </h1>
        </div>
        {subline.length > 0 && (
          <p className="mt-1 pl-[34px] text-[13.5px] text-muted">
            {subline.join(" · ")}
          </p>
        )}

        {company && (
          <div className="mt-6 overflow-hidden rounded-xl border border-line">
            {company.cells.map((c, i) => (
              <DataPointRow
                key={keyOf(c)}
                cell={c}
                first={i === 0}
                open={open.has(keyOf(c))}
                onToggle={() => toggle(keyOf(c))}
                companyId={company.id}
                onChange={setCompany}
              />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function DataPointRow({
  cell,
  first,
  open,
  onToggle,
  companyId,
  onChange,
}: {
  cell: Cell;
  first: boolean;
  open: boolean;
  onToggle: () => void;
  companyId: string;
  onChange: (c: CompanyDetail) => void;
}) {
  const { t, lang } = useI18n();
  const text = formatValue(cell.value, t, lang, cell.type);
  const flagged = cell.level !== "high";
  return (
    <div className={first ? "" : "border-t border-line"}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid min-h-11 w-full grid-cols-[200px_1fr_auto] items-center gap-3 px-4 py-2.5 text-left text-[14px] transition-colors hover:bg-canvas"
      >
        <span className="text-muted">
          {fieldLabel(cell, lang)}
          {cell.period ? (
            <span className="ml-1.5 text-faint tabular-nums">
              {cell.period}
            </span>
          ) : null}
        </span>
        {/* Dot column as in the quality box: 7px dot, text 16px after it. */}
        <span className="grid min-w-0 grid-cols-[16px_1fr] items-center">
          <span
            aria-label={flagged ? t(LEVEL_WORD[cell.level]) : undefined}
            className={`size-[7px] rounded-full ${flagged ? DOT[cell.level] : ""}`}
          />
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="break-words">{text}</span>
            {cell.pinned && <PinnedMarker name={cell.pinned.name} />}
          </span>
        </span>
        <span className="flex items-center gap-2 text-[12.5px] text-faint">
          {t(cell.sources.length === 1 ? "{n} source" : "{n} sources", {
            n: cell.sources.length,
          })}
          <ChevronDown
            size={14}
            strokeWidth={1.75}
            className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <Expanded cell={cell} companyId={companyId} onChange={onChange} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A prioritized value's own marker, separate from the quality dot. */
function PinnedMarker({ name }: { name: string }) {
  const { t } = useI18n();
  const label = t("Prioritized by {name}", { name });
  return (
    <span className="group/pin relative flex shrink-0">
      <PinIcon size={12} strokeWidth={2} filled className="text-muted" />
      <span className="sr-only">{label}</span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-md bg-ink px-2 py-[3px] text-[12px] leading-[14px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity duration-150 group-hover/pin:opacity-100 group-hover/pin:delay-150"
      >
        {label}
      </span>
    </span>
  );
}

const daysSince = (iso: string) =>
  Math.max(
    0,
    Math.round(
      (Date.now() - new Date(`${iso.slice(0, 10)}T00:00:00`).getTime()) /
        86_400_000,
    ),
  );

/** Quality and every source, aligned under the value column. */
function Expanded({
  cell,
  companyId,
  onChange,
}: {
  cell: Cell;
  companyId: string;
  onChange: (c: CompanyDetail) => void;
}) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = cell.sources.find((s) => s.shown);

  const act = async (source: Source, remove: boolean) => {
    setBusy(source.observation_id);
    setError(null);
    try {
      const base = `/companies/${encodeURIComponent(companyId)}/pins`;
      const updated = remove
        ? await gw<CompanyDetail>(
            `${base}?${new URLSearchParams({
              field: cell.field,
              ...(cell.period ? { period: String(cell.period) } : {}),
            })}`,
            { method: "DELETE" },
          )
        : await gw<CompanyDetail>(base, {
            method: "PUT",
            ...json({
              field: cell.field,
              period: cell.period,
              observation_id: source.observation_id,
            }),
          });
      onChange(updated);
    } catch {
      setError(t("Couldn't save. Try again."));
    } finally {
      setBusy(null);
    }
  };

  return (
    // Starts at the value column: 16px padding + 200px label + 12px gap.
    <div className="pr-4 pb-3 pl-[228px] text-[12.5px] leading-snug">
      <div className="space-y-1 border-t border-line pt-2">
        <QualityRow
          head
          level={cell.level}
          label={t("Quality")}
          note={t(LEVEL_WORD[cell.level])}
          value={`${Math.round(cell.score)}/100`}
        />
        <QualityRow
          level={levelFor(cell.confidence)}
          label={t("Source confidence")}
          note={shown && sourceLabel(shown, lang)}
          value={`${cell.confidence}/100`}
        />
        <QualityRow
          level={levelFor(cell.freshness)}
          label={t("Freshness")}
          note={
            cell.as_of
              ? formatAge(Math.max(1, daysSince(cell.as_of)), t)
              : t("Never checked")
          }
          value={
            cell.freshness === null ? t("Unknown") : `${cell.freshness}/100`
          }
        />
      </div>

      <table className="mt-2 w-full table-fixed border-t border-line text-left text-[12px]">
        <colgroup>
          <col className="w-[16px]" />
          <col className="w-[34%]" />
          <col />
          <col className="w-[84px]" />
          <col className="w-[124px]" />
        </colgroup>
        <thead className="text-faint">
          <tr>
            <th />
            <th className="pt-1.5 pb-0.5 font-normal">{t("Source")}</th>
            <th className="pt-1.5 pb-0.5 font-normal">{t("Value")}</th>
            <th className="pt-1.5 pb-0.5 font-normal">{t("Updated")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cell.sources.map((s) => (
            <tr
              key={s.observation_id}
              className={`align-top ${s.shown ? "" : "text-muted"}`}
            >
              <td className="py-1">
                <span className="flex h-[16px] items-center">
                  <SourceIcon category={s.category} />
                </span>
              </td>
              <td className="py-1 pr-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{sourceLabel(s, lang)}</span>
                  {s.shown && (
                    <span className="shrink-0 rounded bg-subtle px-1 text-[10.5px] font-medium text-ink">
                      {t("Current")}
                    </span>
                  )}
                </span>
                {provenance(s) && (
                  <span className="block truncate text-faint">
                    {provenance(s)}
                  </span>
                )}
              </td>
              <td className="py-1 pr-2 break-words">
                {formatValue(s.value, t, lang, cell.type)}
                <span className="ml-1.5 text-faint tabular-nums">
                  {Math.round(s.score)}
                </span>
              </td>
              <td className="truncate py-1">
                {s.as_of ? formatDay(s.as_of, lang) : t("Unknown")}
              </td>
              <td className="py-0.5 text-right">
                {s.pinned ? (
                  <SmallButton
                    busy={busy === s.observation_id}
                    disabled={busy !== null}
                    onClick={() => act(s, true)}
                  >
                    {t("Remove priority")}
                  </SmallButton>
                ) : !s.shown ? (
                  <SmallButton
                    busy={busy === s.observation_id}
                    disabled={busy !== null}
                    onClick={() => act(s, false)}
                  >
                    {t("Prioritize")}
                  </SmallButton>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="mt-1.5 text-bad">{error}</p>}
    </div>
  );
}

function SmallButton({
  busy,
  disabled,
  onClick,
  children,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-white px-2.5 text-[12px] font-medium whitespace-nowrap text-ink transition-colors hover:bg-subtle disabled:opacity-60"
    >
      {busy && <Loader size={11} strokeWidth={1.75} className="animate-spin" />}
      {children}
    </button>
  );
}
