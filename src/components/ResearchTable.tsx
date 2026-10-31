"use client";

import { AnimatePresence, motion, useAnimate } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Check,
  ChevronDown,
  Clock,
  CornerUpLeft,
  Columns,
  Download,
  Filter,
  Maximize2,
  Minimize2,
  MoreVertical,
  Search,
  Table,
  Trash2,
  X,
} from "react-feather";
import type { Refine } from "@/lib/chat";
import {
  BUYER_LISTS,
  COLUMNS,
  SAUVIGNON_COLUMN,
  cellDiff,
  refineStage,
  sortValue,
  withRemovedRows,
  type BuyerList,
  type CellDiff,
  type Column,
  type DiffRow,
  type ListVersion,
  type SortKey,
} from "@/lib/research";
import {
  cellQuality,
  isFlagged,
  summarize,
  versionQuality,
  type CellQuality,
} from "@/lib/quality";
import {
  DataQualityMenu,
  DOT_TEXT_INSET,
  QualityDot,
  QualityDotOverlay,
  QualitySection,
} from "./DataQuality";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useDismiss } from "@/lib/useDismiss";

const EASE = [0.32, 0.72, 0, 1] as const;
const CHECK_COL = 36;
const NAME_COL = 230;
// Count curve: COUNT_START * p + COUNT_ACCEL * p², capped at the total.
const COUNT_START = 1.6;
// Ellipsis truncation for cells. The empty block ::after stops Safari from
// adding its own native tooltip to clipped text; we show our own preview.
const TRUNCATE = "truncate after:block after:content-['']";
const COUNT_ACCEL = 2.5;

// The column the latest agent pass added keeps a blue outline: sides on
// every cell, plus the top on its header and the bottom on its last cell.
// Literal class names, so Tailwind picks them up.
const HIGHLIGHT_SIDES =
  "shadow-[inset_1px_0_0_var(--color-sky-ink),inset_-1px_0_0_var(--color-sky-ink)]";
const HIGHLIGHT_HEAD =
  "shadow-[inset_1px_0_0_var(--color-sky-ink),inset_-1px_0_0_var(--color-sky-ink),inset_0_1px_0_var(--color-sky-ink)]";
const HIGHLIGHT_LAST =
  "shadow-[inset_1px_0_0_var(--color-sky-ink),inset_-1px_0_0_var(--color-sky-ink),inset_0_-1px_0_var(--color-sky-ink)]";

export function ResearchTable({
  progress,
  refine,
  activeId,
  onActiveChange,
}: {
  progress: number;
  /** The scope change pass, which reshapes the latest lists in stages. */
  refine?: Refine;
  activeId: BuyerList["id"];
  onActiveChange: (id: BuyerList["id"]) => void;
}) {
  const { t, formatNumber } = useI18n();
  const { scope, slotRef, fixedFrom, expanded, toggleFullscreen } =
    useFullscreen();
  const base = BUYER_LISTS.find((l) => l.id === activeId) ?? BUYER_LISTS[0];
  const stage = refine ? refineStage(base, refine.progress, refine.done) : null;
  const latest = stage?.list ?? base;
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<Column["key"]>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Chosen version per list; defaults to the latest.
  const [versions, setVersions] = useState<
    Partial<Record<BuyerList["id"], number>>
  >({});
  const viewing =
    latest.versions.find((v) => v.number === versions[base.id]) ??
    latest.versions[0];
  // Older versions render as a diff of what that version changed. They
  // predate the scope change: original rows, no Sauvignon column.
  const diffing = viewing.number !== latest.versions[0].number;
  const list = diffing ? { ...base, versions: latest.versions } : latest;
  const diffOf = (r: (typeof rows)[number], key: SortKey) =>
    diffing ? cellDiff(list, viewing, r, key) : null;

  // Every column this version has, the pass's new one right after Fit score.
  const showSauvignon = !!stage?.showColumn && !diffing;
  const listColumns = showSauvignon
    ? COLUMNS.flatMap((c) => (c.key === "fit" ? [c, SAUVIGNON_COLUMN] : [c]))
    : COLUMNS;
  const highlightKey =
    showSauvignon && refine?.highlight ? SAUVIGNON_COLUMN.key : null;

  // Manual removals edit the latest version only.
  const [removedRows, setRemovedRows] = useState<Set<string>>(new Set());
  const [removedColumns, setRemovedColumns] = useState<
    Partial<Record<BuyerList["id"], Set<Column["key"]>>>
  >({});
  const removedHere = diffing
    ? new Set<Column["key"]>()
    : (removedColumns[base.id] ?? new Set<Column["key"]>());
  const presentColumns = listColumns.filter((c) => !removedHere.has(c.key));

  const qualityKeys = (cols: Column[]): SortKey[] => [
    "name",
    ...cols.map((c) => c.key),
  ];
  const summary = summarize(latest, qualityKeys(listColumns));
  // The pass's version scores on its own data; earlier ones trend up to
  // the original latest, as before.
  const baseSummary = refine?.done
    ? summarize(base, qualityKeys(COLUMNS))
    : summary;
  const qualityOf = (n: number) =>
    refine?.done && n === latest.versions[0].number
      ? summary.score
      : versionQuality(baseSummary.score, base.versions[0].number, n);

  // Rows and the headline count fill in as the research progresses.
  const loaded = Math.ceil(list.rows.length * progress);
  // The count starts faster than the rows and accelerates, reaching the
  // total at ~39% of the run.
  const removedCount = diffing
    ? 0
    : list.rows.filter((r) => removedRows.has(r.id)).length;
  const count =
    Math.round(
      list.total *
        Math.min(1, COUNT_START * progress + COUNT_ACCEL * progress ** 2),
    ) - removedCount;
  // Sorted by fit by default, shown by the arrow in the Fit score header.
  const [sort, setSort] = useState<Sort | null>({ key: "fit", dir: "desc" });
  const [filters, setFilters] = useState<Partial<Record<SortKey, string>>>({});
  // Small lists (~120 rows), so this is recomputed each render.
  const rows = (() => {
    const q = query.trim().toLowerCase();
    // Removed rows only exist in that version's diff, not in the latest list.
    let loadedRows = list.rows.slice(0, loaded);
    if (!diffing) loadedRows = loadedRows.filter((r) => !removedRows.has(r.id));
    let visible = diffing
      ? withRemovedRows(list, viewing, loadedRows)
      : loadedRows;
    if (q) visible = visible.filter((r) => r.name.toLowerCase().includes(q));
    for (const [key, value] of Object.entries(filters)) {
      const f = value?.trim().toLowerCase();
      if (f)
        visible = visible.filter((r) =>
          String(r[key as SortKey])
            .toLowerCase()
            .includes(f),
        );
    }
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      visible = [...visible].sort((a, b) => {
        const x = sortValue(a, sort.key);
        const y = sortValue(b, sort.key);
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    return visible;
  })();

  // Hovering a truncated cell shows its full text, wrapped, over the cell.
  // Flagged cells also show their quality; clicking expands that same box
  // into the full quality details and keeps it open until dismissed.
  const [peeked, setPeeked] = useState<{
    top: number;
    left: number;
    width: number;
    content: React.ReactNode;
    quality: CellQuality | null;
    expanded: boolean;
    /** Long text (detailed rationales) gets a wider box. */
    wide: boolean;
  } | null>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  const peekExpanded = peeked?.expanded ?? false;
  function peek(
    cell: HTMLElement,
    content: React.ReactNode,
    quality: CellQuality | null,
    expand = false,
  ) {
    if (!quality && cell.scrollWidth <= cell.clientWidth)
      return setPeeked(null);
    const { top, left: cellLeft, width } = cell.getBoundingClientRect();
    // The expanded box is wider; near the window's right edge shift it left
    // just enough to fit (it stays aligned with the cell everywhere else).
    const wide = (cell.textContent?.length ?? 0) > 180;
    const boxWidth = expand
      ? Math.min(Math.max(width + 2, 380), wide ? 480 : 420)
      : wide
        ? 480
        : 0;
    const left = Math.min(cellLeft, window.innerWidth - boxWidth - 8);
    setPeeked({ top, left, width, content, quality, expanded: expand, wide });
  }
  // A tall box (long rationale) near the bottom moves up just enough to
  // stay in the window; everywhere else it sits exactly over its cell.
  useLayoutEffect(() => {
    const box = peekRef.current;
    if (!box || !peeked) return;
    const overflow = peeked.top + box.offsetHeight - (window.innerHeight - 8);
    const top = Math.max(8, peeked.top - Math.max(0, overflow));
    // Only when it moves, so this settles after one pass.
    if (top !== peeked.top) setPeeked({ ...peeked, top });
  }, [peeked]);
  const unpeek = () => setPeeked((p) => (p?.expanded ? p : null));
  const closePeek = useCallback(() => setPeeked(null), []);
  useDismiss(peekRef, peekExpanded, closePeek);

  // Quality markers describe the latest data, so they're hidden in diffs.
  function cellProps(r: DiffRow, key: SortKey, value: React.ReactNode) {
    // A Sauvignon cell has no quality until the pass has found its value.
    const pending = key === "sauvignon" && !r.sauvignon;
    const q = diffing || r.removed || pending ? null : cellQuality(r, key);
    const flagged = q && isFlagged(q) ? q : null;
    return {
      flagged,
      handlers: {
        onMouseEnter: (e: React.MouseEvent<HTMLTableCellElement>) => {
          if (!peekExpanded) peek(e.currentTarget, value, flagged);
        },
        onMouseLeave: unpeek,
        onClick: flagged
          ? (e: React.MouseEvent<HTMLTableCellElement>) =>
              peek(e.currentTarget, value, flagged, true)
          : undefined,
      },
    };
  }

  const headerProps = (key: SortKey, label: MessageKey) => ({
    label: t(label),
    sort: sort?.key === key ? sort.dir : null,
    filter: filters[key] ?? "",
    onSort: (dir: SortDir | null) => setSort(dir ? { key, dir } : null),
    onFilter: (value: string) => setFilters((f) => ({ ...f, [key]: value })),
  });
  const columns = presentColumns.filter((c) => !hidden.has(c.key));

  function removeColumn(key: Column["key"]) {
    setRemovedColumns((prev) => ({
      ...prev,
      [base.id]: new Set(prev[base.id]).add(key),
    }));
    if (sort?.key === key) setSort(null);
    setFilters((f) => {
      const next = { ...f };
      delete next[key];
      return next;
    });
  }

  // The selection bar acts on the selected rows in view.
  const selectedRows = rows.filter((r) => selected.has(r.id));
  function removeSelected() {
    setRemovedRows((prev) => {
      const next = new Set(prev);
      selectedRows.forEach((r) => next.add(r.id));
      return next;
    });
    setSelected(new Set());
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      rows.forEach((r) => (allSelected ? next.delete(r.id) : next.add(r.id)));
      return next;
    });
  }
  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Merge neighbouring columns that share a group into one header cell.
  const groups = columns.reduce<{ label: MessageKey; span: number }[]>(
    (acc, c) => {
      const last = acc.at(-1);
      if (last && last.label === c.group) last.span += 1;
      else acc.push({ label: c.group, span: 1 });
      return acc;
    },
    [],
  );
  const tableWidth =
    CHECK_COL + NAME_COL + columns.reduce((w, c) => w + c.width, 0);

  // When the pass adds its column, scroll it into view next to the sticky
  // name column, so the new data is on screen while it fills in.
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightIndex = columns.findIndex((c) => c.key === highlightKey);
  const highlightLeft = columns
    .slice(0, Math.max(0, highlightIndex))
    .reduce((w, c) => w + c.width, 0);
  useEffect(() => {
    if (highlightIndex < 0) return;
    // Keep the column before it (Fit score) visible too, for context.
    const prev = columns[highlightIndex - 1]?.width ?? 0;
    scrollRef.current?.scrollTo({
      left: Math.max(0, highlightLeft - prev),
      behavior: "smooth",
    });
    // Once per appearance and list, not on every progress tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIndex >= 0, base.id]);

  return (
    <>
      {/* Holds the panel's place in the layout while it's lifted out full screen. */}
      {fixedFrom && <div ref={slotRef} className="my-3 mr-3 min-w-0 flex-1" />}
      <motion.section
        ref={scope}
        initial={{ opacity: 0, x: 48 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 48 }}
        transition={{ duration: 0.6, ease: EASE, delay: 0.15 }}
        style={
          fixedFrom
            ? { position: "fixed", zIndex: 50, ...fixedFrom }
            : undefined
        }
        className={`relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-white ${fixedFrom ? "" : "my-3 mr-3 flex-1"}`}
      >
        {/* Tabs */}
        <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-canvas">
          {BUYER_LISTS.map((l) => {
            const active = l.id === list.id;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onActiveChange(l.id)}
                className={`relative -mb-px flex items-center gap-2 border-r border-line px-3 text-[13.5px] transition-colors ${
                  active ? "bg-white text-ink" : "text-muted hover:text-ink"
                }`}
              >
                <Table
                  size={13}
                  strokeWidth={1.75}
                  className={active ? "text-sheet" : "text-faint"}
                />
                {t(l.title)}
              </button>
            );
          })}
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={expanded ? t("Exit full screen") : t("Full screen")}
            className="ml-auto flex w-9 items-center justify-center text-[#5d5d63] transition-colors hover:text-ink"
          >
            {expanded ? (
              <Minimize2 size={14} strokeWidth={1.75} />
            ) : (
              <Maximize2 size={14} strokeWidth={1.75} />
            )}
          </button>
        </div>

        {/* Title + actions */}
        <div className="flex shrink-0 items-center gap-2 px-[13px] pt-2.5">
          <h2 className="truncate text-[16px] font-medium">{t(list.title)}</h2>
          <Bell
            size={14}
            strokeWidth={1.75}
            className="shrink-0 text-[#5d5d63]"
          />
          <span className="shrink-0 rounded-md bg-sky px-1.5 py-0.5 text-[11px] font-medium text-[#5b7db1]">
            {t("New")}
          </span>
          <VersionMenu
            versions={latest.versions}
            selected={viewing.number}
            onSelect={(n) => setVersions((v) => ({ ...v, [base.id]: n }))}
            qualityOf={qualityOf}
          />
          <button
            type="button"
            className="flex h-[30px] items-center gap-1.5 rounded-lg border border-line px-3 text-[14px] font-medium transition-colors hover:bg-subtle"
          >
            <Download size={14} strokeWidth={1.75} />
            {t("Export")}
          </button>
        </div>

        {/* Count + search + columns */}
        <div className="flex shrink-0 items-center gap-3 px-[13px] pt-1.5 pb-2">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-[24px] leading-none tabular-nums">
              {formatNumber(count)}
            </span>
            <span className="text-[14px] text-muted">{t(list.unit)}</span>
          </div>
          {/* Same styling as the header search bar. */}
          <label className="ml-auto flex h-[28px] w-[210px] items-center gap-2 rounded-lg bg-subtle px-2.5">
            <Search size={14} strokeWidth={2} className="shrink-0 text-ink" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Find companies...")}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
            />
          </label>
          <DataQualityMenu summary={summary} />
          <ColumnsMenu
            columns={presentColumns}
            hidden={hidden}
            onChange={setHidden}
          />
        </div>

        <AnimatePresence initial={false}>
          {diffing && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="shrink-0 overflow-hidden"
            >
              <div className="flex items-center gap-2 border-t border-line bg-canvas px-[13px] py-1.5 text-[13px]">
                <span className="shrink-0 font-medium">
                  {t("Version {n}", { n: viewing.number })}
                </span>
                <span className="min-w-0 truncate text-muted">
                  {viewing.message}
                </span>
                <span className="shrink-0 text-muted">
                  · {t("{n} changes", { n: formatNumber(viewing.changes) })}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setVersions((v) => ({ ...v, [base.id]: undefined }))
                  }
                  className="ml-auto shrink-0 rounded-md px-2 py-0.5 font-medium transition-colors hover:bg-subtle"
                >
                  {t("Back to latest")}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        <div
          ref={scrollRef}
          onScroll={closePeek}
          className="min-h-0 flex-1 overflow-auto border-t border-line"
        >
          <table
            className="table-fixed border-separate border-spacing-0 text-left text-[13.5px]"
            style={{ width: tableWidth }}
          >
            <colgroup>
              <col style={{ width: CHECK_COL }} />
              <col style={{ width: NAME_COL }} />
              {columns.map((c) => (
                <col key={c.key} style={{ width: c.width }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-20 bg-white">
              <tr className="h-7 text-[12px] font-normal text-muted">
                <th className="sticky left-0 z-10 border-b border-line bg-white" />
                <th
                  className="sticky z-10 border-r border-b border-line bg-white px-3 font-normal"
                  style={{ left: CHECK_COL }}
                >
                  {t("Buyer company information")}
                </th>
                {groups.map((g, i) => (
                  <th
                    key={`${g.label}-${i}`}
                    colSpan={g.span}
                    className="border-r border-b border-line px-3 font-normal last:border-r-0"
                  >
                    {t(g.label)}
                  </th>
                ))}
              </tr>
              <tr className="h-[34px] text-[13.5px] font-normal text-muted">
                <th className="sticky left-0 z-10 border-b border-line bg-white pl-3">
                  <Checkbox
                    checked={allSelected}
                    onChange={toggleAll}
                    label={t("Select all rows")}
                  />
                </th>
                <HeaderCell
                  {...headerProps("name", "Buyer name")}
                  className="sticky z-10 border-r"
                  style={{ left: CHECK_COL }}
                />
                {columns.map((c) => (
                  <HeaderCell
                    key={c.key}
                    {...headerProps(c.key, c.label)}
                    onRemove={diffing ? undefined : () => removeColumn(c.key)}
                    className={`border-r last:border-r-0 ${c.key === highlightKey ? HIGHLIGHT_HEAD : ""}`}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.id}
                  className="group h-[31px] animate-[row-in_0.35s_ease-out] hover:bg-canvas"
                >
                  <td className="sticky left-0 z-10 border-b border-line bg-white pl-3 group-hover:bg-canvas">
                    <Checkbox
                      checked={selected.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                      label={t("Select {name}", { name: r.name })}
                    />
                  </td>
                  <Cell
                    {...cellProps(
                      r,
                      "name",
                      <DiffValue diff={diffOf(r, "name")}>{r.name}</DiffValue>,
                    )}
                    className="sticky z-10 border-r bg-white group-hover:bg-canvas"
                    style={{ left: CHECK_COL }}
                  >
                    <DiffValue diff={diffOf(r, "name")}>
                      <span className="cursor-pointer underline decoration-[#b5b5ba] underline-offset-[3px] hover:decoration-ink">
                        {r.name}
                      </span>
                    </DiffValue>
                  </Cell>
                  {columns.map((c) => (
                    <Cell
                      key={c.key}
                      {...cellProps(
                        r,
                        c.key,
                        <DiffValue diff={diffOf(r, c.key)}>
                          {r[c.key]}
                        </DiffValue>,
                      )}
                      className={`relative ${
                        c.key !== highlightKey
                          ? ""
                          : i === rows.length - 1
                            ? HIGHLIGHT_LAST
                            : HIGHLIGHT_SIDES
                      }`}
                    >
                      {c.key === "sauvignon" && !r.sauvignon ? (
                        // Still being looked up by the pass.
                        <span className="animate-pulse text-faint">…</span>
                      ) : (
                        <DiffValue diff={diffOf(r, c.key)}>
                          {r[c.key]}
                        </DiffValue>
                      )}
                    </Cell>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {peeked && (
            <div
              ref={peekRef}
              aria-hidden={!peeked.expanded}
              role={peeked.expanded ? "dialog" : undefined}
              aria-label={
                peeked.expanded ? t("Data quality details") : undefined
              }
              // Offset by the 1px border, and match the cell's line height and
              // vertical inset, so the text sits exactly where it was.
              style={{
                top: peeked.top - 1,
                left: peeked.left - 1,
                minWidth: peeked.expanded
                  ? Math.max(peeked.width + 2, 380)
                  : peeked.width + 2,
              }}
              className={`fixed z-[60] animate-[row-in_0.12s_ease-out] rounded-md border border-line bg-white px-3 py-[4.875px] text-[13.5px] leading-[1.5] break-words shadow-[0_4px_16px_rgba(0,0,0,0.08)] ${peeked.expanded ? `${peeked.wide ? "max-w-[480px]" : "max-w-[420px]"} pb-2.5` : `pointer-events-none ${peeked.wide ? "max-w-[480px]" : "max-w-[340px]"}`}`}
            >
              {peeked.quality && <QualityDotOverlay quality={peeked.quality} />}
              {/* Same inset as the flagged cell, so the text doesn't move. */}
              <div className={peeked.quality ? "pl-4" : ""}>
                {peeked.content}
              </div>
              {peeked.quality && (
                <QualitySection
                  quality={peeked.quality}
                  expanded={peeked.expanded}
                />
              )}
            </div>
          )}
          {rows.length === 0 && (
            <p className="px-4 py-8 text-center text-[13.5px] text-muted">
              {query
                ? t("No companies match “{query}”.", { query })
                : t("Searching…")}
            </p>
          )}
        </div>

        {/* Bulk actions for the selected rows, floating over the table. */}
        <AnimatePresence>
          {selectedRows.length > 0 && !diffing && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
              transition={{ duration: 0.2, ease: EASE }}
              className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center rounded-xl bg-ink p-1 pl-3.5 text-[13.5px] whitespace-nowrap text-white shadow-[0_4px_20px_rgba(0,0,0,0.16)]"
            >
              <span className="tabular-nums">
                {t("{n} selected", { n: formatNumber(selectedRows.length) })}
              </span>
              <span className="mx-2.5 h-4 w-px bg-white/20" />
              <button
                type="button"
                onClick={removeSelected}
                className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 font-medium transition-colors hover:bg-white/10"
              >
                <Trash2 size={14} strokeWidth={1.75} />
                {t(selectedRows.length === 1 ? "Remove row" : "Remove rows")}
              </button>
              <button
                type="button"
                aria-label={t("Clear selection")}
                onClick={() => setSelected(new Set())}
                className="flex size-8 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>
    </>
  );
}

type Rect = { top: number; left: number; width: number; height: number };

const rectOf = (el: Element): Rect => {
  const { top, left, width, height } = el.getBoundingClientRect();
  return { top, left, width, height };
};

// Lifts the panel out of the layout into a fixed layer and grows it from its
// current box to the whole window (over the header and sidebar), animating
// top/left/width/height so the content reflows instead of being scaled.
function useFullscreen() {
  const [scope, animate] = useAnimate<HTMLElement>();
  const slotRef = useRef<HTMLDivElement>(null);
  const [fixedFrom, setFixedFrom] = useState<Rect | null>(null);
  const [expanded, setExpanded] = useState(false);
  const busy = useRef(false);

  const toggleFullscreen = useCallback(async () => {
    const el = scope.current;
    if (!el || busy.current) return;
    busy.current = true;
    const transition = { duration: 0.5, ease: EASE };
    if (!expanded) {
      flushSync(() => {
        setFixedFrom(rectOf(el));
        setExpanded(true);
      });
      await animate(
        el,
        {
          top: 0,
          left: 0,
          width: window.innerWidth,
          height: window.innerHeight,
          borderRadius: 0,
        },
        transition,
      );
      // Track the window from here on, so resizing while full screen works.
      Object.assign(el.style, { width: "100vw", height: "100vh" });
    } else {
      setExpanded(false);
      Object.assign(el.style, {
        width: `${window.innerWidth}px`,
        height: `${window.innerHeight}px`,
      });
      const slot = slotRef.current;
      if (slot)
        await animate(el, { ...rectOf(slot), borderRadius: 12 }, transition);
      flushSync(() => setFixedFrom(null));
      Object.assign(el.style, { top: "", left: "", width: "", height: "" });
    }
    busy.current = false;
  }, [animate, expanded, scope]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && toggleFullscreen();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded, toggleFullscreen]);

  return { scope, slotRef, fixedFrom, expanded, toggleFullscreen };
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onChange}
      className="block size-4 cursor-pointer accent-ink"
    />
  );
}

function ColumnsMenu({
  columns,
  hidden,
  onChange,
}: {
  /** The list's columns, minus any removed ones. */
  columns: Column[];
  hidden: Set<Column["key"]>;
  onChange: (next: Set<Column["key"]>) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  function toggle(key: Column["key"]) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`}
      >
        <Columns size={14} strokeWidth={1.75} />
        {t("Columns")}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute top-full right-0 z-30 mt-2 w-56 origin-top-right rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            {columns.map((c) => (
              <button
                key={c.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={!hidden.has(c.key)}
                onClick={() => toggle(c.key)}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle"
              >
                <span className="flex-1 truncate">{t(c.label)}</span>
                {!hidden.has(c.key) && <Check size={15} strokeWidth={2} />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type SortDir = "asc" | "desc";
type Sort = { key: SortKey; dir: SortDir };

const MENU_WIDTH = 220;

// Column header: hover reveals a ⋮ button whose menu filters and sorts.
function HeaderCell({
  label,
  sort,
  filter,
  onSort,
  onFilter,
  onRemove,
  className = "",
  style,
}: {
  label: string;
  sort: SortDir | null;
  filter: string;
  onSort: (dir: SortDir | null) => void;
  onFilter: (value: string) => void;
  /** Absent for the name column and while viewing an older version. */
  onRemove?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t, lang } = useI18n();
  // Fixed position so the menu isn't clipped by the scrolling table.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [mode, setMode] = useState<"menu" | "filter">("menu");
  const ref = useRef<HTMLTableCellElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  useDismiss(ref, anchor !== null, close);

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    if (anchor) return close();
    const r = e.currentTarget.getBoundingClientRect();
    setMode("menu");
    setAnchor({ top: r.bottom + 6, left: r.right - MENU_WIDTH });
  }

  const item =
    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] text-ink transition-colors hover:bg-subtle";

  return (
    <th
      ref={ref}
      style={style}
      className={`group/th border-b border-line bg-white pr-1.5 pl-3 font-normal ${className}`}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 truncate">{label}</span>
        {filter && (
          <Filter size={12} strokeWidth={2} className="shrink-0 text-sky-ink" />
        )}
        {sort && (
          <span className="shrink-0 text-ink">
            {sort === "asc" ? (
              <ArrowUp size={13} strokeWidth={1.75} />
            ) : (
              <ArrowDown size={13} strokeWidth={1.75} />
            )}
          </span>
        )}
        <button
          type="button"
          aria-label={t("{label} column options", { label })}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          onClick={toggle}
          className={`ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-ink transition-opacity hover:bg-subtle ${
            anchor
              ? "bg-subtle opacity-100"
              : "opacity-0 group-hover/th:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <MoreVertical size={14} strokeWidth={2} />
        </button>
      </div>

      <AnimatePresence>
        {anchor && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            style={{ top: anchor.top, left: anchor.left, width: MENU_WIDTH }}
            className="fixed z-[60] origin-top-right rounded-xl border border-line bg-white p-1 text-left shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            {mode === "filter" ? (
              <div className="p-1">
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => onFilter(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && close()}
                  // German nouns keep their capital.
                  placeholder={t("Filter {label}...", {
                    label: lang === "de" ? label : label.toLowerCase(),
                  })}
                  className="h-[28px] w-full rounded-lg bg-subtle px-2.5 text-[13px] outline-none placeholder:text-muted"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => onFilter("")}
                    className={`${item} mt-1 h-8 text-[13.5px]`}
                  >
                    {t("Clear filter")}
                  </button>
                )}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setMode("filter")}
                  className={item}
                >
                  <Filter size={15} strokeWidth={1.75} />
                  {t("Filter")}
                </button>
                <div className="my-1 border-t border-line" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSort("asc");
                    close();
                  }}
                  className={item}
                >
                  <ArrowUp size={15} strokeWidth={1.75} />
                  {t("Sort Ascending")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSort("desc");
                    close();
                  }}
                  className={item}
                >
                  <ArrowDown size={15} strokeWidth={1.75} />
                  {t("Sort Descending")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSort(null);
                    close();
                  }}
                  className={`${item} pl-[35px] disabled:text-faint disabled:hover:bg-transparent`}
                  disabled={!sort}
                >
                  {t("Clear Sort")}
                </button>
                {onRemove && (
                  <>
                    <div className="my-1 border-t border-line" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        close();
                        onRemove();
                      }}
                      className={item}
                    >
                      <Trash2 size={15} strokeWidth={1.75} />
                      {t("Remove column")}
                    </button>
                  </>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </th>
  );
}

// A cell's value, marked up like a diff: removed text grey and struck through,
// added text plain; a changed cell shows the old value struck before the new.
function DiffValue({
  diff,
  children,
}: {
  diff: CellDiff;
  children: React.ReactNode;
}) {
  if (!diff || diff.kind === "added") return <>{children}</>;
  const removed = "text-faint line-through decoration-faint";
  if (diff.kind === "removed")
    return <span className={removed}>{children}</span>;
  return (
    <>
      <span className={removed}>{diff.old}</span> {children}
    </>
  );
}

function VersionMenu({
  versions,
  selected,
  onSelect,
  qualityOf,
}: {
  versions: ListVersion[];
  selected: number;
  onSelect: (n: number) => void;
  /** Data quality score of each version, for the trend across versions. */
  qualityOf: (n: number) => number;
}) {
  const [open, setOpen] = useState(false);
  const { t, formatNumber, formatDate } = useI18n();
  const [restoring, setRestoring] = useState<ListVersion | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const latest = versions[0].number;

  return (
    <div ref={ref} className="relative ml-auto">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`}
      >
        <Clock size={14} strokeWidth={1.75} className="text-[#5d5d63]" />
        {t("Version {n}", { n: selected })}
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute top-full right-0 z-30 mt-2 flex max-h-[380px] w-[380px] origin-top-right flex-col gap-0.5 overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            {versions.map((v) => (
              <div
                key={v.number}
                role="menuitemradio"
                aria-checked={v.number === selected}
                tabIndex={0}
                onClick={() => {
                  onSelect(v.number);
                  close();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(v.number);
                    close();
                  }
                }}
                className={`cursor-pointer rounded-lg px-2.5 py-2 transition-colors outline-none hover:bg-subtle focus-visible:bg-subtle ${v.number === selected ? "bg-subtle" : ""}`}
              >
                <div className="flex h-6 items-center gap-2">
                  <span className="text-[14px] font-medium tabular-nums">
                    {t("Version {n}", { n: v.number })}
                  </span>
                  {v.number === latest && (
                    <span className="rounded-md bg-sky px-1.5 py-0.5 text-[11px] font-medium text-[#5b7db1]">
                      {t("Latest")}
                    </span>
                  )}
                  {v.number !== latest && (
                    <div className="group/restore relative ml-auto">
                      <button
                        type="button"
                        aria-label={t("Restore version {n}", { n: v.number })}
                        onClick={(e) => {
                          e.stopPropagation();
                          close();
                          setRestoring(v);
                        }}
                        className="flex size-6 items-center justify-center rounded-md text-[#5d5d63] transition-colors hover:bg-white hover:text-ink"
                      >
                        <CornerUpLeft size={14} strokeWidth={1.75} />
                      </button>
                      <span
                        role="tooltip"
                        className="pointer-events-none absolute top-1/2 right-full mr-1.5 -translate-y-1/2 rounded-md bg-ink px-2 py-1 text-[12px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity duration-150 group-hover/restore:opacity-100 group-hover/restore:delay-150"
                      >
                        {t("Restore this version")}
                      </span>
                    </div>
                  )}
                </div>
                <p className="mt-0.5 text-[13.5px] leading-snug">{v.message}</p>
                {/* Stats wrap onto their own line when the author and date are long. */}
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <AuthorAvatar author={v.author} />
                    {formatDate(v.date)}
                  </span>
                  <span className="ml-auto shrink-0">
                    {t("Quality")}{" "}
                    <span className="font-medium text-ink tabular-nums">
                      {qualityOf(v.number)}
                    </span>{" "}
                    · {t("Changes")}{" "}
                    <span className="font-medium text-ink tabular-nums">
                      {formatNumber(v.changes)}
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <RestoreDialog
        version={restoring}
        latest={latest}
        onClose={() => setRestoring(null)}
      />
    </div>
  );
}

// Who made a version: the agent as a light blue circle (the logo's colour),
// people by their initials; the full name shows on hover, opening rightwards
// so the scrolling menu doesn't clip it.
function AuthorAvatar({ author }: { author: ListVersion["author"] }) {
  const { t } = useI18n();
  const agent = author === "Agent";
  const name = agent ? t("Agent") : author;
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("");
  return (
    <span className="group/author relative flex">
      <span
        aria-label={name}
        className={`flex size-[18px] items-center justify-center rounded-full text-[8.5px] font-medium ${agent ? "bg-brand" : "bg-sky text-[#41526b]"}`}
      >
        {!agent && initials}
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 rounded-md bg-ink px-2 py-1 text-[12px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity duration-150 group-hover/author:opacity-100 group-hover/author:delay-150"
      >
        {name}
      </span>
    </span>
  );
}

// Confirmation only; restoring isn't implemented in the demo.
function RestoreDialog({
  version,
  latest,
  onClose,
}: {
  version: ListVersion | null;
  latest: number;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  useEffect(() => {
    if (!version) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [version, onClose]);

  return (
    <AnimatePresence>
      {version && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 px-4"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-title"
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ duration: 0.2, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[400px] rounded-xl border border-line bg-white p-5 text-left shadow-[0_12px_40px_rgba(0,0,0,0.12)]"
          >
            <h3 id="restore-title" className="text-[16px] font-medium">
              {t("Restore version {n}?", { n: version.number })}
            </h3>
            <p className="mt-2 text-[14px] leading-relaxed text-muted">
              {t(
                "This creates Version {next} with the contents of Version {n} ({message}). The current version stays in the history, so you can switch back anytime.",
                {
                  next: latest + 1,
                  n: version.number,
                  // Commit messages are English; only lowercase them mid-sentence there.
                  message:
                    lang === "de"
                      ? version.message
                      : version.message.toLowerCase(),
                },
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-[32px] rounded-lg border border-line px-3 text-[14px] font-medium transition-colors hover:bg-subtle"
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                autoFocus
                onClick={onClose}
                className="h-[32px] rounded-lg bg-ink px-3 text-[14px] font-medium text-white transition-colors hover:bg-[#26262a]"
              >
                {t("Restore")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Data cell: truncates, previews on hover and, when flagged, shows a quality
// marker and opens its details on click.
function Cell({
  flagged,
  handlers,
  className = "",
  style,
  children,
}: {
  flagged: CellQuality | null;
  handlers: React.HTMLAttributes<HTMLTableCellElement>;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <td
      {...handlers}
      style={style}
      className={`border-b border-line px-3 ${TRUNCATE} ${flagged ? `cursor-pointer ${DOT_TEXT_INSET}` : ""} ${className}`}
    >
      {children}
      {flagged && <QualityDot quality={flagged} />}
    </td>
  );
}
