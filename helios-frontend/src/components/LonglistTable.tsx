"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  Columns,
  CornerUpLeft,
  Download,
  Edit2,
  ExternalLink,
  Filter,
  Loader,
  MoreVertical,
  Trash2,
  Upload,
  X,
} from "react-feather";
import { formatDay, formatValue } from "@/lib/corpus";
import { gw, json } from "@/lib/gateway";
import { useI18n, type MessageKey } from "@/lib/i18n";
import {
  columnLabel,
  formatEdited,
  groupOf,
  isNumeric,
  sortValue,
  widthOf,
  type ListCell,
  type ListColumn,
  type ListRow,
  type ListTable,
  type ListVersion,
  type Marker,
  type Op,
} from "@/lib/longlists";
import { MEMBERS } from "@/lib/members";
import { useDismiss } from "@/lib/useDismiss";
import { Avatar } from "./Avatar";
import {
  DOT,
  DOT_TEXT_INSET,
  DataQualityMenu,
  LEVEL_WORD,
  QualityRow,
  levelFor,
} from "./DataQuality";
import type { QualityLevel, QualitySummary } from "@/lib/quality";
import { Modal, modalPrimary, modalSecondary } from "./Modal";
import { ImportModal, SPREADSHEET_ACCEPT } from "./ImportModal";
import { PinIcon } from "./PinIcon";

const EASE = [0.32, 0.72, 0, 1] as const;
const CHECK_COL = 36;
const NAME_COL = 230;
// Ellipsis truncation for cells. The empty block ::after stops Safari from
// adding its own native tooltip to clipped text; we show our own preview.
const TRUNCATE = "truncate after:block after:content-['']";
const STRUCK = "text-faint line-through decoration-faint";
const DOT_POSITION =
  "absolute top-[11.5px] left-[12px] size-[7px] rounded-full";

const photoFor = (email: string) =>
  MEMBERS.find((m) => m.email === email)?.photo;

type SortDir = "asc" | "desc";
type Sort = { key: string; dir: SortDir };

/** A list's table: the latest version (editable: cells, rows, columns and
 * their order, each change a new version) or an older one as the diff of
 * what it changed. `variant="panel"` is the chat research column (no back). */
export function LonglistDetail({
  id,
  variant = "page",
}: {
  id: string;
  variant?: "page" | "panel";
}) {
  const { t, lang, formatNumber } = useI18n();
  const router = useRouter();
  const base = `/longlists/${encodeURIComponent(id)}`;
  const [head, setHead] = useState<ListTable | null>(null);
  const [missing, setMissing] = useState(false);
  const [versions, setVersions] = useState<ListVersion[]>([]);
  // null follows the latest version; a number shows that version's diff.
  const [viewing, setViewing] = useState<number | null>(null);
  const [older, setOlder] = useState<ListTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadVersions = useCallback(
    () => gw<ListVersion[]>(`${base}/versions`).then(setVersions, () => {}),
    [base],
  );
  const loadHead = useCallback(() => {
    gw<ListTable>(base).then(setHead, () => setMissing(true));
  }, [base]);
  useEffect(() => {
    let live = true;
    gw<ListTable>(base).then(
      (l) => live && setHead(l),
      () => live && setMissing(true),
    );
    loadVersions();
    return () => {
      live = false;
    };
  }, [base, loadVersions]);
  // In the chat panel, pick up new agent versions without a full remount.
  useEffect(() => {
    if (variant !== "panel") return;
    const tick = setInterval(() => {
      if (viewing !== null) return;
      loadHead();
      loadVersions();
    }, 2500);
    return () => clearInterval(tick);
  }, [variant, viewing, loadHead, loadVersions]);
  useEffect(() => {
    if (viewing === null) return;
    let live = true;
    gw<ListTable>(`${base}?version=${viewing}&diff=true`).then(
      (l) => live && setOlder(l),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [base, viewing]);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  const diffing = viewing !== null;
  const shown = diffing ? (older?.version === viewing ? older : null) : head;

  /** Every change is one new version; the table shows the latest after it. */
  async function save(path: string, body: unknown) {
    setSaving(true);
    try {
      const next = await gw<ListTable>(`${base}${path}`, {
        method: "POST",
        ...json(body),
      });
      setHead(next);
      setViewing(null);
      loadVersions();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }
  const apply = (ops: Op[]) => save("/changes", { ops });

  const back = () =>
    window.history.length > 1 ? router.back() : router.push("/longlists");

  // Columns hidden in this view (this session only; not a list change).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const summary = shown ? qualitySummary(shown) : null;
  const versionMenu = head && (
    <VersionMenu
      versions={versions}
      selected={viewing ?? head.head_version}
      onSelect={(n) => setViewing(n === head.head_version ? null : n)}
      onRestore={(n) => save("/restore", { version: n })}
    />
  );
  const exportButton = (
    <>
      <ImportButton
        listId={id}
        onDone={() => {
          setViewing(null);
          loadHead();
          loadVersions();
        }}
      />
      <ExportButton
        href={`/api/gateway${base}/export${diffing ? `?version=${viewing}` : ""}`}
      />
    </>
  );
  const count = head && (
    <span className="flex items-baseline gap-2">
      <span className="font-serif text-[24px] leading-none tabular-nums">
        {formatNumber(
          shown
            ? shown.rows.filter((r) => r.diff !== "removed").length
            : head.size,
        )}
      </span>
      <span className="text-[14px] text-muted">{t("buyers")}</span>
    </span>
  );
  const columnsMenu = shown && (
    <ColumnsMenu columns={shown.columns} hidden={hidden} onChange={setHidden} />
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {variant === "panel" ? (
        <>
          {/* As in the research panel's reference: name with Version and
              Export on the right, then the count with the table tools. */}
          <div className="flex h-[42px] shrink-0 items-center gap-2 px-[13px] pt-2.5">
            <h2 className="min-w-0 flex-1 truncate text-[16px] font-medium">
              {head ? head.name : missing ? t("Longlist not found") : ""}
            </h2>
            {head && versions.length > 0 && versionMenu}
            {head && exportButton}
          </div>
          <div className="flex h-[38px] shrink-0 items-center gap-1 px-[13px] pt-1.5 pb-2">
            {head && count}
            <div className="ml-auto" />
            {summary && <DataQualityMenu summary={summary} />}
            {shown && columnsMenu}
          </div>
        </>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 px-8 pt-8">
            <button
              type="button"
              onClick={back}
              aria-label={t("Back to longlists")}
              className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-subtle hover:text-ink"
            >
              <ArrowLeft size={17} strokeWidth={1.75} />
            </button>
            <h1 className="min-w-0 truncate font-serif text-[28px] leading-tight tracking-[-0.01em]">
              {head ? head.name : missing ? t("Longlist not found") : " "}
            </h1>
            {head && versions.length > 0 && versionMenu}
            {head && exportButton}
          </div>
          {head && (
            <div className="flex shrink-0 items-center gap-2 px-8 pt-3 pb-3 pl-[66px]">
              {count}
              <span className="ml-3 text-[13px] text-muted">
                {t("Owner")}: {head.owner.name} · {t("Last edited")}{" "}
                {formatEdited(head.edited_at, t, lang)}
              </span>
              <div className="ml-auto" />
              {summary && <DataQualityMenu summary={summary} />}
              {shown && columnsMenu}
            </div>
          )}
        </>
      )}

      <AnimatePresence initial={false}>
        {diffing && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="shrink-0 overflow-hidden"
          >
            <div className="flex items-center gap-2 border-t border-line bg-canvas px-8 py-1.5 text-[13px]">
              <span className="shrink-0 font-medium">
                {t("Version {n}", { n: viewing })}
              </span>
              <span className="min-w-0 truncate text-muted">
                {versions.find((v) => v.number === viewing)?.message}
              </span>
              {shown?.changes !== null && shown?.changes !== undefined && (
                <span className="shrink-0 text-muted">
                  ·{" "}
                  {t(shown.changes === 1 ? "{n} change" : "{n} changes", {
                    n: formatNumber(shown.changes),
                  })}
                </span>
              )}
              <button
                type="button"
                onClick={() => setViewing(null)}
                className="ml-auto shrink-0 rounded-full px-2.5 py-0.5 font-medium transition-colors hover:bg-subtle"
              >
                {t("Back to latest")}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {shown ? (
        <Grid
          key={diffing ? `v${viewing}` : "latest"}
          table={{
            ...shown,
            columns: shown.columns.filter(
              (c) => c.key === "name" || !hidden.has(c.key),
            ),
          }}
          diffing={diffing}
          saving={saving}
          onApply={apply}
          onOpenCompany={(cid) =>
            router.push(`/companies/${encodeURIComponent(cid)}`)
          }
        />
      ) : (
        <div className="flex-1 border-t border-line" />
      )}

      <AnimatePresence>
        {error && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
            className="absolute bottom-16 left-1/2 z-40 flex max-w-[560px] -translate-x-1/2 items-center gap-2 rounded-full bg-ink py-2 pr-2 pl-4 text-[13.5px] text-white shadow-[0_4px_20px_rgba(0,0,0,0.16)]"
          >
            <span className="min-w-0 truncate">{error}</span>
            <button
              type="button"
              aria-label={t("Close")}
              onClick={() => setError(null)}
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"
            >
              <X size={13} strokeWidth={1.75} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── The table ──────────────────────────────────────────────────────────────

function Grid({
  table,
  diffing,
  saving,
  onApply,
  onOpenCompany,
}: {
  table: ListTable;
  diffing: boolean;
  saving: boolean;
  onApply: (ops: Op[]) => Promise<boolean>;
  onOpenCompany: (companyId: string) => void;
}) {
  const { t, lang, formatNumber } = useI18n();
  const nameColumn = table.columns.find((c) => c.key === "name");
  const columns = table.columns.filter((c) => c.key !== "name");
  const [sort, setSort] = useState<Sort | null>({
    key: "relevance_score",
    dir: "desc",
  });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ row: string; key: string } | null>(
    null,
  );

  const text = (cell: ListCell | undefined, c?: ListColumn) =>
    cell ? formatValue(cell.value, t, lang, c?.type) : "";

  const rows = (() => {
    let visible = table.rows;
    for (const [key, value] of Object.entries(filters)) {
      const f = value.trim().toLowerCase();
      if (f)
        visible = visible.filter((r) =>
          text(r.cells[key]).toLowerCase().includes(f),
        );
    }
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      visible = [...visible].sort((a, b) => {
        const x = sortValue(a.cells[sort.key]?.value);
        const y = sortValue(b.cells[sort.key]?.value);
        // Empty values last, either way.
        if (x === "" || y === "") return x === y ? 0 : x === "" ? 1 : -1;
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    return visible;
  })();

  // Hovering a truncated (or flagged) cell shows its full text over the
  // cell; a flagged cell adds its quality, and clicking expands the box.
  const [peeked, setPeeked] = useState<{
    top: number;
    left: number;
    width: number;
    content: React.ReactNode;
    cell: ListCell | null;
    companyId: string | null;
    expanded: boolean;
    wide: boolean;
    /** Double-clicking the box edits its cell, as on the cell itself. */
    onEdit?: () => void;
  } | null>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  const peekExpanded = peeked?.expanded ?? false;
  function peek(
    el: HTMLElement,
    content: React.ReactNode,
    cell: ListCell | null,
    companyId: string | null,
    expand = false,
    onEdit?: () => void,
  ) {
    if (!cell && el.scrollWidth <= el.clientWidth) return setPeeked(null);
    const { top, left: cellLeft, width } = el.getBoundingClientRect();
    const wide = (el.textContent?.length ?? 0) > 180;
    const boxWidth = expand
      ? Math.min(Math.max(width + 2, 340), wide ? 480 : 420)
      : wide
        ? 480
        : 0;
    const left = Math.min(cellLeft, window.innerWidth - boxWidth - 8);
    setPeeked({
      top,
      left,
      width,
      content,
      cell,
      companyId,
      expanded: expand,
      wide,
      onEdit,
    });
  }
  useLayoutEffect(() => {
    const box = peekRef.current;
    if (!box || !peeked) return;
    const overflow = peeked.top + box.offsetHeight - (window.innerHeight - 8);
    const top = Math.max(8, peeked.top - Math.max(0, overflow));
    if (top !== peeked.top) setPeeked({ ...peeked, top });
  }, [peeked]);
  const unpeek = () => setPeeked((p) => (p?.expanded ? p : null));
  const closePeek = useCallback(() => setPeeked(null), []);
  useDismiss(peekRef, peekExpanded, closePeek);

  // Columns can be dragged into a new order: a version.
  const [drag, setDrag] = useState<{
    key: string;
    over?: string;
    side?: "before" | "after";
  } | null>(null);
  function dropColumn() {
    if (!drag?.over || drag.over === drag.key) return setDrag(null);
    const keys = columns.map((c) => c.key).filter((k) => k !== drag.key);
    const at = keys.indexOf(drag.over) + (drag.side === "after" ? 1 : 0);
    keys.splice(at, 0, drag.key);
    setDrag(null);
    if (keys.join() !== columns.map((c) => c.key).join())
      onApply([{ op: "order_columns", keys: ["name", ...keys] }]);
  }
  const dragProps = (key: string) =>
    diffing
      ? undefined
      : {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", key);
            closePeek();
            setDrag({ key });
          },
          onDragOver: (e: React.DragEvent<HTMLTableCellElement>) => {
            if (!drag) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const side = e.clientX < r.left + r.width / 2 ? "before" : "after";
            if (drag.over !== key || drag.side !== side)
              setDrag({ ...drag, over: key, side });
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            dropColumn();
          },
          onDragEnd: () => setDrag(null),
        };

  const headerProps = (key: string, label: string) => ({
    label,
    sort: sort?.key === key ? sort.dir : null,
    filter: filters[key] ?? "",
    onSort: (dir: SortDir | null) => setSort(dir ? { key, dir } : null),
    onFilter: (value: string) => setFilters((f) => ({ ...f, [key]: value })),
  });

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  async function removeSelected() {
    const ok = await onApply(
      selectedRows.map((r) => ({ op: "remove_entry", entry_id: r.id })),
    );
    if (ok) setSelected(new Set());
  }

  const groups = columns.reduce<{ label: MessageKey; span: number }[]>(
    (acc, c) => {
      const last = acc.at(-1);
      const label = groupOf(c);
      if (last && last.label === label) last.span += 1;
      else acc.push({ label, span: 1 });
      return acc;
    },
    [],
  );
  const tableWidth =
    CHECK_COL + NAME_COL + columns.reduce((w, c) => w + widthOf(c), 0);

  function cell(r: ListRow, c: ListColumn, sticky = false) {
    const value = r.cells[c.key];
    const removed = r.diff === "removed" || c.diff === "removed";
    const shownText = text(value, c);
    const content = (
      <CellText
        cell={value}
        column={c}
        text={shownText}
        removed={removed}
        oldText={
          value?.changed ? formatValue(value.old, t, lang, c.type) : null
        }
      />
    );
    const flagged =
      !diffing && value?.level && value.level !== "high" ? value : null;
    const editable = !diffing && !saving;
    const isEditing =
      editable && editing?.row === r.id && editing.key === c.key;
    // Flagged values, and values someone prioritized or typed in, show
    // their quality on hover. A click inspects any value that has a source
    // (good ones too); a double-click edits.
    const details =
      flagged ?? (!diffing && (value?.manual || value?.pinned) ? value : null);
    const inspectable =
      !diffing && (value?.level || value?.added) ? value : null;
    const edit = editable
      ? () => {
          closePeek();
          setEditing({ row: r.id, key: c.key });
        }
      : undefined;
    return (
      <td
        key={c.key}
        style={sticky ? { left: CHECK_COL } : undefined}
        onDoubleClick={edit}
        onMouseEnter={(e) => {
          if (!peekExpanded && !isEditing)
            peek(e.currentTarget, content, details, r.company_id);
        }}
        onMouseLeave={unpeek}
        onClick={
          inspectable
            ? (e) => {
                // The second click of a double-click edits instead.
                if (e.detail > 1) return;
                peek(
                  e.currentTarget,
                  content,
                  inspectable,
                  r.company_id,
                  true,
                  edit,
                );
              }
            : undefined
        }
        className={`relative border-b border-hairline px-3 ${TRUNCATE} ${
          isNumeric(c) ? "text-right tabular-nums" : ""
        } ${flagged ? DOT_TEXT_INSET : ""} ${inspectable ? "cursor-pointer" : ""} ${
          sticky
            ? "sticky z-10 border-r border-r-line bg-white group-hover:bg-canvas"
            : ""
        }`}
      >
        {content}
        {flagged && (
          <span
            className={`pointer-events-none ${DOT_POSITION} ${DOT[flagged.level!]}`}
          />
        )}
        {isEditing && (
          <CellEditor
            value={
              c.source.startsWith("corpus:")
                ? shownText
                : value?.value === undefined || value.value === null
                  ? ""
                  : String(value.value)
            }
            onDone={(next) => {
              setEditing(null);
              if (next !== null && next.trim() !== shownText.trim())
                onApply([
                  { op: "set", entry_id: r.id, key: c.key, value: next },
                ]);
            }}
          />
        )}
      </td>
    );
  }

  return (
    <>
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
              <col key={c.key} style={{ width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-20 bg-white">
            <tr className="h-7 text-[12px] font-normal text-muted">
              <th className="sticky left-0 z-10 border-b border-hairline bg-white" />
              <th
                className="sticky z-10 border-r border-b border-r-line border-b-hairline bg-white px-3 font-normal"
                style={{ left: CHECK_COL }}
              >
                {t("Buyer company information")}
              </th>
              {groups.map((g, i) => (
                <th
                  key={`${g.label}-${i}`}
                  colSpan={g.span}
                  className="truncate border-r border-b border-r-line border-b-hairline px-3 font-normal whitespace-nowrap last:border-r-0"
                >
                  {t(g.label)}
                </th>
              ))}
            </tr>
            <tr className="h-[34px] text-[13.5px] font-normal text-muted">
              <th className="sticky left-0 z-10 border-b border-hairline bg-white pl-3">
                {!diffing && (
                  <Checkbox
                    checked={allSelected}
                    onChange={() =>
                      setSelected(
                        allSelected
                          ? new Set()
                          : new Set(rows.map((r) => r.id)),
                      )
                    }
                    label={t("Select all rows")}
                  />
                )}
              </th>
              <HeaderCell
                {...headerProps("name", t("Buyer name"))}
                className="sticky z-10 border-r"
                style={{ left: CHECK_COL }}
              />
              {columns.map((c) => (
                <HeaderCell
                  key={c.key}
                  {...headerProps(c.key, columnLabel(c, lang))}
                  struck={c.diff === "removed"}
                  onRemove={
                    diffing
                      ? undefined
                      : () => onApply([{ op: "remove_column", key: c.key }])
                  }
                  drag={dragProps(c.key)}
                  dragging={drag?.key === c.key}
                  dropSide={
                    drag && drag.over === c.key && drag.key !== c.key
                      ? drag.side
                      : undefined
                  }
                  className="border-r last:border-r-0"
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="group h-[31px] hover:bg-canvas">
                <td className="sticky left-0 z-10 border-b border-hairline bg-white pl-3 group-hover:bg-canvas">
                  {(diffing || !selected.has(r.id)) && (
                    <span
                      aria-hidden
                      className={`pointer-events-none absolute top-1/2 left-5 -translate-x-1/2 -translate-y-1/2 text-[12px] text-faint tabular-nums ${diffing ? "" : "group-hover:opacity-0"}`}
                    >
                      {i + 1}
                    </span>
                  )}
                  {!diffing && (
                    <Checkbox
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      label={t("Select {name}", {
                        name: text(r.cells.name),
                      })}
                      className="opacity-0 group-hover:opacity-100 has-checked:opacity-100 has-focus-visible:opacity-100"
                    />
                  )}
                </td>
                {nameColumn && cell(r, nameColumn, true)}
                {columns.map((c) => cell(r, c))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-4 py-8 text-center text-[13.5px] text-muted">
            {t("No buyers on this version.")}
          </p>
        )}
        {peeked && (
          <div
            ref={peekRef}
            onDoubleClick={peeked.onEdit}
            aria-hidden={!peeked.expanded}
            role={peeked.expanded ? "dialog" : undefined}
            aria-label={peeked.expanded ? t("Data quality details") : undefined}
            style={{
              top: peeked.top - 1,
              left: peeked.left - 1,
              minWidth: peeked.expanded
                ? Math.max(peeked.width + 2, 340)
                : peeked.width + 2,
            }}
            className={`fixed z-[60] animate-[row-in_0.12s_ease-out] rounded-md border border-line bg-white px-3 py-[4.875px] text-[13.5px] leading-[1.5] break-words shadow-[0_4px_16px_rgba(0,0,0,0.08)] ${peeked.expanded ? `${peeked.wide ? "max-w-[480px]" : "max-w-[420px]"} pb-2.5` : `pointer-events-none ${peeked.wide ? "max-w-[480px]" : "max-w-[340px]"}`}`}
          >
            {peeked.cell?.level && peeked.cell.level !== "high" && (
              <span
                aria-hidden
                className={`${DOT_POSITION} ${DOT[peeked.cell.level]}`}
              />
            )}
            <div
              className={
                peeked.cell?.level && peeked.cell.level !== "high" ? "pl-4" : ""
              }
            >
              {peeked.content}
            </div>
            {peeked.cell && (
              <QualityDetails
                cell={peeked.cell}
                expanded={peeked.expanded}
                onOpenCompany={
                  peeked.companyId
                    ? () => onOpenCompany(peeked.companyId!)
                    : undefined
                }
              />
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {selectedRows.length > 0 && !diffing && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: EASE }}
            className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full bg-ink p-1.5 pl-4 text-[13.5px] whitespace-nowrap text-white shadow-[0_4px_20px_rgba(0,0,0,0.16)]"
          >
            <span className="tabular-nums">
              {t("{n} selected", { n: formatNumber(selectedRows.length) })}
            </span>
            <span className="mx-2.5 h-4 w-px bg-white/20" />
            <button
              type="button"
              onClick={removeSelected}
              disabled={saving}
              className="flex h-8 items-center gap-1.5 rounded-full px-3 font-medium transition-colors hover:bg-white/10 disabled:opacity-60"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {t(selectedRows.length === 1 ? "Remove row" : "Remove rows")}
            </button>
            <button
              type="button"
              aria-label={t("Clear selection")}
              onClick={() => setSelected(new Set())}
              className="flex size-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** A cell's text with its markers; in a diff, removed text is struck
 * through and a changed cell shows the old value before the new one. */
function CellText({
  cell,
  column,
  text,
  removed,
  oldText,
}: {
  cell: ListCell | undefined;
  column: ListColumn;
  text: string;
  removed: boolean;
  oldText: string | null;
}) {
  const { t } = useI18n();
  const strong = column.key === "name";
  if (removed)
    return (
      <span className={`${STRUCK} ${strong ? "font-medium" : ""}`}>{text}</span>
    );
  return (
    <>
      {oldText !== null && oldText !== "" && (
        <>
          <span className={STRUCK}>{oldText}</span>{" "}
        </>
      )}
      <span className={strong ? "font-medium" : ""}>{text}</span>
      {cell?.manual ? (
        <MarkerIcon
          label={t("Edited by {name}", { name: cell.manual.name })}
          marker={cell.manual}
          manual
        />
      ) : (
        cell?.pinned && (
          <MarkerIcon
            label={t("Prioritized by {name}", { name: cell.pinned.name })}
            marker={cell.pinned}
          />
        )
      )}
    </>
  );
}

function MarkerIcon({
  label,
  manual = false,
}: {
  label: string;
  marker: Marker;
  manual?: boolean;
}) {
  return (
    <span
      aria-label={label}
      className="ml-1.5 inline-flex align-[-1px] text-muted"
    >
      {manual ? (
        <Edit2 size={11} strokeWidth={2} />
      ) : (
        <PinIcon size={11} strokeWidth={2} filled />
      )}
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

/** The quality of a corpus value: the overall level while hovering; on
 * click its source confidence, freshness and where it comes from. */
function QualityDetails({
  cell,
  expanded,
  onOpenCompany,
}: {
  cell: ListCell;
  expanded: boolean;
  onOpenCompany?: () => void;
}) {
  const { t, lang, formatNumber } = useI18n();
  const editHint = expanded && (
    <p className="mt-1.5 text-[12px] text-faint">{t("Double-click to edit")}</p>
  );
  if (!cell.level) {
    // A judgement (relevance score or rationale): who set it, no score.
    if (!expanded || !cell.added) return null;
    return (
      <div className="mt-1.5 border-t border-line pt-1.5 text-[12.5px] leading-snug text-muted">
        {t("Added by {name}", { name: cell.added.name })}
        {cell.added.at && ` · ${formatDay(cell.added.at, lang)}`}
        {editHint}
      </div>
    );
  }
  const marker = cell.manual ?? cell.pinned;
  return (
    <div className="mt-1.5 border-t border-line pt-1.5 text-[12.5px] leading-snug">
      <QualityRow
        head
        level={cell.level}
        label={t("Quality")}
        note={cell.level === "unknown" ? undefined : t(LEVEL_WORD[cell.level])}
        value={
          cell.level === "unknown"
            ? t("Unknown")
            : `${Math.round(cell.score ?? 0)}/100`
        }
      />
      {marker && (
        <p className="mt-1 pl-4 text-muted">
          {cell.manual
            ? t("Edited by {name}", { name: marker.name })
            : t("Prioritized by {name}", { name: marker.name })}
        </p>
      )}
      {expanded && (
        <div className="mt-1.5 space-y-1 border-t border-line pt-1.5">
          <QualityRow
            level={levelFor(cell.confidence ?? null)}
            label={t("Source confidence")}
            note={cell.source}
            value={
              cell.confidence === null || cell.confidence === undefined
                ? t("Unknown")
                : `${cell.confidence}/100`
            }
          />
          <QualityRow
            level={levelFor(cell.freshness ?? null)}
            label={t("Freshness")}
            note={
              cell.as_of
                ? `${formatDay(cell.as_of, lang)} · ${t("{n} days ago", {
                    n: formatNumber(daysSince(cell.as_of)),
                  })}`
                : t("Never checked")
            }
            value={
              cell.freshness === null || cell.freshness === undefined
                ? t("Unknown")
                : `${cell.freshness}/100`
            }
          />
          {cell.added && !cell.manual && (
            <p className="pl-4 text-muted">
              {t("Added by {name}", { name: cell.added.name })}
            </p>
          )}
          {cell.url && (
            <a
              href={cell.url}
              target="_blank"
              rel="noreferrer"
              className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-ink transition-colors hover:bg-subtle"
            >
              <ExternalLink
                size={12}
                strokeWidth={1.75}
                className="ml-[1px] shrink-0"
              />
              <span className="truncate pl-1">
                {t("View source")} · {cell.source_title || hostOf(cell.url)}
              </span>
            </a>
          )}
          {onOpenCompany && (
            <button
              type="button"
              onClick={onOpenCompany}
              className="-ml-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-ink transition-colors hover:bg-subtle"
            >
              <ExternalLink size={12} strokeWidth={1.75} className="ml-[1px]" />
              <span className="pl-1">
                {t(cell.sources === 1 ? "{n} source" : "{n} sources", {
                  n: formatNumber(cell.sources ?? 0),
                })}{" "}
                · {t("Open company")}
              </span>
            </button>
          )}
        </div>
      )}
      {editHint}
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// ── Controls ───────────────────────────────────────────────────────────────

const LEVELS: QualityLevel[] = ["high", "medium", "low", "unknown"];

/** The shown table's overall score (mean of its scored values) and how its
 * values spread over the levels; null when nothing has a source to score. */
function qualitySummary(table: ListTable): QualitySummary | null {
  const cells = table.rows
    .filter((r) => r.diff !== "removed")
    .flatMap((r) => Object.values(r.cells))
    .filter((c) => c.level);
  if (!cells.length) return null;
  const scored = cells.filter((c) => typeof c.score === "number");
  // -1 when no value has a score (all Unknown): the menu shows a dash.
  const score = scored.length
    ? Math.round(
        scored.reduce((sum, c) => sum + (c.score ?? 0), 0) / scored.length,
      )
    : -1;
  const distribution = Object.fromEntries(
    LEVELS.map((l) => [
      l,
      cells.filter((c) => c.level === l).length / cells.length,
    ]),
  ) as Record<QualityLevel, number>;
  return { score, distribution };
}

/** Show or hide columns in this view (the name column always shows). */
function ColumnsMenu({
  columns,
  hidden,
  onChange,
}: {
  columns: ListColumn[];
  hidden: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  function toggle(key: string) {
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
        className={`flex h-[30px] items-center gap-1.5 rounded-full px-2.5 text-[14px] font-medium transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`}
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
            className="absolute top-full right-0 z-30 mt-2 max-h-[360px] w-56 origin-top-right overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            {columns
              .filter((c) => c.key !== "name" && c.diff !== "removed")
              .map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={!hidden.has(c.key)}
                  onClick={() => toggle(c.key)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle"
                >
                  <span className="flex-1 truncate">
                    {columnLabel(c, lang)}
                  </span>
                  {!hidden.has(c.key) && <Check size={15} strokeWidth={2} />}
                </button>
              ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  className = "",
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  className?: string;
}) {
  return (
    <span className={`relative block size-4 ${className}`}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={onChange}
        className="peer block size-4 cursor-pointer appearance-none rounded-[3px] border border-[#d4d4d8] bg-white transition-colors outline-none hover:border-faint checked:border-ink checked:bg-ink focus-visible:ring-3 focus-visible:ring-sky"
      />
      <Check
        size={12}
        strokeWidth={3}
        className="pointer-events-none absolute inset-0 m-auto text-white opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}

const MENU_WIDTH = 220;
const DROP_BEFORE = "!shadow-[inset_2px_0_0_var(--color-sky-ink)]";
const DROP_AFTER = "!shadow-[inset_-2px_0_0_var(--color-sky-ink)]";

// Column header: hover reveals a ⋮ button whose menu filters, sorts and
// removes the column.
function HeaderCell({
  label,
  sort,
  filter,
  onSort,
  onFilter,
  onRemove,
  drag,
  dragging = false,
  dropSide,
  struck = false,
  className = "",
  style,
}: {
  label: string;
  sort: SortDir | null;
  filter: string;
  onSort: (dir: SortDir | null) => void;
  onFilter: (value: string) => void;
  onRemove?: () => void;
  drag?: React.HTMLAttributes<HTMLTableCellElement>;
  dragging?: boolean;
  dropSide?: "before" | "after";
  struck?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t, lang } = useI18n();
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
      {...drag}
      className={`group/th border-b border-b-hairline border-r-line bg-white pr-1.5 pl-3 font-normal ${drag ? "cursor-grab active:cursor-grabbing" : ""} ${dragging ? "opacity-40" : ""} ${dropSide === "before" ? DROP_BEFORE : dropSide === "after" ? DROP_AFTER : ""} ${className}`}
    >
      <div className="flex items-center gap-1">
        <span className={`min-w-0 truncate ${struck ? STRUCK : ""}`}>
          {label}
        </span>
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

// Inline editor laid over the cell, its text where the cell's text was.
function CellEditor({
  value,
  onDone,
}: {
  value: string;
  /** The new value, or null when cancelled. */
  onDone: (value: string | null) => void;
}) {
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          finish(null);
        }
      }}
      className="absolute inset-0 z-10 w-full bg-white px-3 text-left text-[13.5px] font-normal text-ink no-underline ring-1 ring-sky-ink outline-none ring-inset"
    />
  );
}

function VersionMenu({
  versions,
  selected,
  onSelect,
  onRestore,
}: {
  versions: ListVersion[];
  selected: number;
  onSelect: (n: number) => void;
  onRestore: (n: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const { t, lang, formatNumber } = useI18n();
  const [restoring, setRestoring] = useState<ListVersion | null>(null);
  const [busy, setBusy] = useState(false);
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
        className={`flex h-[30px] items-center gap-1.5 rounded-full px-2.5 text-[14px] font-medium transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`}
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
            className="absolute top-full right-0 z-30 mt-2 flex max-h-[420px] w-[380px] origin-top-right flex-col gap-0.5 overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
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
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <AuthorAvatar version={v} />
                    {formatEdited(v.created_at, t, lang)}
                  </span>
                  <span className="ml-auto shrink-0">
                    {t("Changes")}{" "}
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

      <Modal
        open={!!restoring}
        onClose={busy ? undefined : () => setRestoring(null)}
        labelledBy="restore-title"
      >
        {restoring && (
          <>
            <h3 id="restore-title" className="text-[16px] font-medium">
              {t("Restore version {n}?", { n: restoring.number })}
            </h3>
            <p className="mt-2 text-[14px] leading-relaxed text-muted">
              {t(
                "This creates Version {next} with the contents of Version {n} ({message}). The current version stays in the history, so you can switch back anytime.",
                {
                  next: latest + 1,
                  n: restoring.number,
                  message:
                    lang === "de"
                      ? restoring.message
                      : restoring.message.charAt(0).toLowerCase() +
                        restoring.message.slice(1),
                },
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRestoring(null)}
                disabled={busy}
                className={modalSecondary}
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                autoFocus
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await onRestore(restoring.number);
                  setBusy(false);
                  setRestoring(null);
                }}
                className={modalPrimary}
              >
                {t("Restore")}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

// Who made a version: the agent as a light blue circle, people by portrait
// or initials; the full name shows on hover.
function AuthorAvatar({ version }: { version: ListVersion }) {
  const { t } = useI18n();
  const agent = version.author === "agent";
  const name = agent ? t("Agent") : version.author_name;
  return (
    <span className="group/author relative flex">
      {agent ? (
        <span
          aria-label={name}
          className="size-5 shrink-0 rounded-full bg-brand"
        />
      ) : (
        <Avatar name={name} photo={photoFor(version.author)} size={20} />
      )}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 rounded-md bg-ink px-2 py-1 text-[12px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity duration-150 group-hover/author:opacity-100 group-hover/author:delay-150"
      >
        {name}
      </span>
    </span>
  );
}

/** Picks a spreadsheet and opens the import review for this list: an
 * exported file comes back cell by cell, any other file is matched by
 * company. */
function ImportButton({
  listId,
  onDone,
}: {
  listId: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept={SPREADSHEET_ACCEPT}
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) setFile(picked);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex h-[30px] items-center gap-1.5 rounded-full border border-line px-3.5 text-[14px] font-medium transition-colors hover:bg-subtle"
      >
        <Upload size={14} strokeWidth={1.75} />
        {t("Import")}
      </button>
      {file && (
        <ImportModal
          open
          file={file}
          target={{ kind: "list", listId }}
          showOpenList={false}
          onClose={() => setFile(null)}
          onDone={onDone}
        />
      )}
    </>
  );
}

/** Downloads the shown version as .xlsx, built by the gateway. */
function ExportButton({ href }: { href: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error();
      const disposition = response.headers.get("content-disposition") ?? "";
      const name =
        decodeURIComponent(
          disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? "",
        ) || "longlist.xlsx";
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={busy}
      aria-busy={busy}
      className="flex h-[30px] items-center gap-1.5 rounded-full border border-line px-3.5 text-[14px] font-medium transition-colors hover:bg-subtle disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent"
    >
      {busy ? (
        <Loader size={14} strokeWidth={1.75} className="animate-spin" />
      ) : (
        <Download size={14} strokeWidth={1.75} />
      )}
      {t("Export")}
    </button>
  );
}
