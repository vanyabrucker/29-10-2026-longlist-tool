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
} from "react-feather";
import {
  BUYER_LISTS,
  COLUMNS,
  cellDiff,
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

export function ResearchTable({
  progress,
  activeId,
  onActiveChange,
}: {
  progress: number;
  activeId: BuyerList["id"];
  onActiveChange: (id: BuyerList["id"]) => void;
}) {
  const { scope, slotRef, fixedFrom, expanded, toggleFullscreen } =
    useFullscreen();
  const list = BUYER_LISTS.find((l) => l.id === activeId) ?? BUYER_LISTS[0];
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<Column["key"]>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Chosen version per list; defaults to the latest.
  const [versions, setVersions] = useState<
    Partial<Record<BuyerList["id"], number>>
  >({});
  const qualityKeys: SortKey[] = ["name", ...COLUMNS.map((c) => c.key)];
  const summary = summarize(list, qualityKeys);
  const qualityOf = (n: number) =>
    versionQuality(summary.score, list.versions[0].number, n);
  const viewing =
    list.versions.find((v) => v.number === versions[list.id]) ??
    list.versions[0];
  // Older versions render as a diff of what that version changed.
  const diffing = viewing.number !== list.versions[0].number;
  const diffOf = (r: (typeof rows)[number], key: SortKey) =>
    diffing ? cellDiff(list, viewing, r, key) : null;

  // Rows and the headline count fill in as the research progresses.
  const loaded = Math.ceil(list.rows.length * progress);
  // The count starts faster than the rows and accelerates, reaching the
  // total at ~39% of the run.
  const count = Math.round(
    list.total *
      Math.min(1, COUNT_START * progress + COUNT_ACCEL * progress ** 2),
  );
  // Sorted by fit by default, shown by the arrow in the Fit score header.
  const [sort, setSort] = useState<Sort | null>({ key: "fit", dir: "desc" });
  const [filters, setFilters] = useState<Partial<Record<SortKey, string>>>({});
  // Small lists (~120 rows), so this is recomputed each render.
  const rows = (() => {
    const q = query.trim().toLowerCase();
    // Removed rows only exist in that version's diff, not in the latest list.
    const loadedRows = list.rows.slice(0, loaded);
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
    const q = diffing || r.removed ? null : cellQuality(r, key);
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

  const headerProps = (key: SortKey, label: string) => ({
    label,
    sort: sort?.key === key ? sort.dir : null,
    filter: filters[key] ?? "",
    onSort: (dir: SortDir | null) => setSort(dir ? { key, dir } : null),
    onFilter: (value: string) => setFilters((f) => ({ ...f, [key]: value })),
  });
  const columns = COLUMNS.filter((c) => !hidden.has(c.key));

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
  const groups = columns.reduce<{ label: string; span: number }[]>((acc, c) => {
    const last = acc.at(-1);
    if (last && last.label === c.group) last.span += 1;
    else acc.push({ label: c.group, span: 1 });
    return acc;
  }, []);
  const tableWidth =
    CHECK_COL + NAME_COL + columns.reduce((w, c) => w + c.width, 0);

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
        className={`flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-white ${fixedFrom ? "" : "my-3 mr-3 flex-1"}`}
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
                {l.title}
              </button>
            );
          })}
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={expanded ? "Exit full screen" : "Full screen"}
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
          <h2 className="truncate text-[16px] font-medium">{list.title}</h2>
          <Bell
            size={14}
            strokeWidth={1.75}
            className="shrink-0 text-[#5d5d63]"
          />
          <span className="shrink-0 rounded-md bg-sky px-1.5 py-0.5 text-[11px] font-medium text-[#5b7db1]">
            New
          </span>
          <VersionMenu
            versions={list.versions}
            selected={viewing.number}
            onSelect={(n) => setVersions((v) => ({ ...v, [list.id]: n }))}
            qualityOf={qualityOf}
          />
          <button
            type="button"
            className="flex h-[30px] items-center gap-1.5 rounded-lg border border-line px-3 text-[14px] font-medium transition-colors hover:bg-subtle"
          >
            <Download size={14} strokeWidth={1.75} />
            Export
          </button>
        </div>

        {/* Count + search + columns */}
        <div className="flex shrink-0 items-center gap-3 px-[13px] pt-1.5 pb-2">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-[24px] leading-none tabular-nums">
              {count.toLocaleString("en-US")}
            </span>
            <span className="text-[14px] text-muted">{list.unit}</span>
          </div>
          {/* Same styling as the header search bar. */}
          <label className="ml-auto flex h-[28px] w-[210px] items-center gap-2 rounded-lg bg-subtle px-2.5">
            <Search size={14} strokeWidth={2} className="shrink-0 text-ink" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find companies..."
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
            />
          </label>
          <DataQualityMenu summary={summary} />
          <ColumnsMenu hidden={hidden} onChange={setHidden} />
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
                  Version {viewing.number}
                </span>
                <span className="min-w-0 truncate text-muted">
                  {viewing.message}
                </span>
                <span className="shrink-0 text-muted">
                  · {viewing.changes.toLocaleString("en-US")} changes
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setVersions((v) => ({ ...v, [list.id]: undefined }))
                  }
                  className="ml-auto shrink-0 rounded-md px-2 py-0.5 font-medium transition-colors hover:bg-subtle"
                >
                  Back to latest
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        <div
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
                  Buyer company information
                </th>
                {groups.map((g, i) => (
                  <th
                    key={`${g.label}-${i}`}
                    colSpan={g.span}
                    className="border-r border-b border-line px-3 font-normal last:border-r-0"
                  >
                    {g.label}
                  </th>
                ))}
              </tr>
              <tr className="h-[34px] text-[13.5px] font-normal text-muted">
                <th className="sticky left-0 z-10 border-b border-line bg-white pl-3">
                  <Checkbox
                    checked={allSelected}
                    onChange={toggleAll}
                    label="Select all rows"
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
                    className="border-r last:border-r-0"
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="group h-[31px] animate-[row-in_0.35s_ease-out] hover:bg-canvas"
                >
                  <td className="sticky left-0 z-10 border-b border-line bg-white pl-3 group-hover:bg-canvas">
                    <Checkbox
                      checked={selected.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                      label={`Select ${r.name}`}
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
                      className="relative"
                    >
                      <DiffValue diff={diffOf(r, c.key)}>{r[c.key]}</DiffValue>
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
              aria-label={peeked.expanded ? "Data quality details" : undefined}
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
              {query ? `No companies match “${query}”.` : "Searching…"}
            </p>
          )}
        </div>
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
  hidden,
  onChange,
}: {
  hidden: Set<Column["key"]>;
  onChange: (next: Set<Column["key"]>) => void;
}) {
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
        Columns
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
            {COLUMNS.map((c) => (
              <button
                key={c.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={!hidden.has(c.key)}
                onClick={() => toggle(c.key)}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle"
              >
                <span className="flex-1 truncate">{c.label}</span>
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
  className = "",
  style,
}: {
  label: string;
  sort: SortDir | null;
  filter: string;
  onSort: (dir: SortDir | null) => void;
  onFilter: (value: string) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
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
          aria-label={`${label} column options`}
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
                  placeholder={`Filter ${label.toLowerCase()}...`}
                  className="h-[28px] w-full rounded-lg bg-subtle px-2.5 text-[13px] outline-none placeholder:text-muted"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => onFilter("")}
                    className={`${item} mt-1 h-8 text-[13.5px]`}
                  >
                    Clear filter
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
                  Filter
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
                  Sort Ascending
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
                  Sort Descending
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
                  Clear Sort
                </button>
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
        Version {selected}
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
                    Version {v.number}
                  </span>
                  {v.number === latest && (
                    <span className="rounded-md bg-sky px-1.5 py-0.5 text-[11px] font-medium text-[#5b7db1]">
                      Latest
                    </span>
                  )}
                  {v.number !== latest && (
                    <div className="group/restore relative ml-auto">
                      <button
                        type="button"
                        aria-label={`Restore version ${v.number}`}
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
                        Restore this version
                      </span>
                    </div>
                  )}
                </div>
                <p className="mt-0.5 text-[13.5px] leading-snug">{v.message}</p>
                {/* Stats wrap onto their own line when the author and date are long. */}
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted">
                  <span className="whitespace-nowrap">
                    {v.author} · {v.date}
                  </span>
                  <span className="ml-auto shrink-0">
                    Quality{" "}
                    <span className="font-medium text-ink tabular-nums">
                      {qualityOf(v.number)}
                    </span>{" "}
                    · Changes{" "}
                    <span className="font-medium text-ink tabular-nums">
                      {v.changes.toLocaleString("en-US")}
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
              Restore version {version.number}?
            </h3>
            <p className="mt-2 text-[14px] leading-relaxed text-muted">
              This creates Version {latest + 1} with the contents of Version{" "}
              {version.number} ({version.message.toLowerCase()}). The current
              version stays in the history, so you can switch back anytime.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-[32px] rounded-lg border border-line px-3 text-[14px] font-medium transition-colors hover:bg-subtle"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={onClose}
                className="h-[32px] rounded-lg bg-ink px-3 text-[14px] font-medium text-white transition-colors hover:bg-[#26262a]"
              >
                Restore
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
