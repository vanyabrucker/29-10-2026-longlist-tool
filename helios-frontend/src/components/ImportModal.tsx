"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Table,
  X,
} from "react-feather";
import {
  gw,
  isListReport,
  json,
  RUNNING,
  show,
  type Catalogue,
  type ImportDetail,
  type ListCell,
  type ListReport,
  type Table as SheetTable,
} from "@/lib/gateway";
import { useI18n, type MessageKey, type Translate } from "@/lib/i18n";
import { columnLabel } from "@/lib/longlists";
import { FIELD_DE } from "@/lib/corpus";
import { InfoTip } from "./admin/ui";
import { Modal, modalPrimary, modalSecondary } from "./Modal";

/** Where an import goes: a list (anyone; an existing one or a new one,
 * optionally from a chat) or the corpus (devs). */
export type ImportTarget =
  | {
      kind: "list";
      listId?: string | null;
      newListName?: string;
      sessionId?: string | null;
    }
  | { kind: "corpus"; sourceType: string };

export type ImportResult = {
  id: string;
  listId: string | null;
  listVersion: number | null;
};

const HELIOS_ID = "helios_id";

/** The file types the gateway can import. */
export const SPREADSHEET_ACCEPT = ".xlsx,.xlsm,.xls,.xlsb,.ods,.csv";
export const isImportable = (name: string) =>
  /\.(xlsx|xlsm|xls|xlsb|ods|csv)$/i.test(name);
const NEW_COLUMN = "new_column";

type Step = "upload" | "map" | "review" | "import";
const STEPS: { key: Step; label: MessageKey }[] = [
  { key: "upload", label: "Upload" },
  { key: "map", label: "Map columns" },
  { key: "review", label: "Review" },
  { key: "import", label: "Import" },
];

function stepOf(d: ImportDetail | null): Step {
  if (!d) return "upload";
  switch (d.status) {
    case "uploaded":
    case "analysing":
      return "upload";
    case "remapping":
    case "mapping_review":
      return "map";
    case "building_report":
    case "report_review":
      return "review";
    case "failed":
      return d.report ? "import" : d.tables.length ? "review" : "upload";
    default:
      return "import";
  }
}

/**
 * The one import review, for lists and the corpus: upload a file (or open an
 * import in progress), check how its columns map, review what changes (new
 * rows, changed cells, conflicts to pick, rows missing from the file,
 * errors), then commit. Closing before the commit cancels the import.
 */
export function ImportModal({
  open,
  file,
  importId,
  target,
  onClose,
  onDone,
  cancelOnClose = true,
  showOpenList = true,
}: {
  /** Off when the dialog was opened from the list itself. */
  showOpenList?: boolean;
  open: boolean;
  /** Closing before the commit cancels the import (off when reopening
   * someone's import from the admin area). */
  cancelOnClose?: boolean;
  /** A file to upload when the dialog opens. */
  file?: File | null;
  /** Or an import already uploaded. */
  importId?: string | null;
  target: ImportTarget;
  onClose: () => void;
  onDone?: (result: ImportResult) => void;
}) {
  const { t } = useI18n();
  const [id, setId] = useState<string | null>(importId ?? null);
  const [data, setData] = useState<ImportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const started = useRef(false);

  const load = useCallback(async (which: string) => {
    try {
      setData(await gw<ImportDetail>(`/imports/${which}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Upload once per opening.
  useEffect(() => {
    if (!open || started.current) return;
    started.current = true;
    gw<Catalogue>("/catalogue").then(setCatalogue, () => {});
    if (importId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load sets state after its fetch resolves
      void load(importId);
      return;
    }
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("last_modified", String(file.lastModified));
    form.append("target", target.kind);
    if (target.kind === "corpus") form.append("source_type", target.sourceType);
    else {
      if (target.listId) form.append("list_id", target.listId);
      else if (target.newListName)
        form.append("new_list_name", target.newListName);
      if (target.sessionId) form.append("session_id", target.sessionId);
    }
    gw<{ id: string }>("/imports", { method: "POST", body: form }).then(
      (r) => {
        setId(r.id);
        void load(r.id);
      },
      (e: Error) => setError(e.message),
    );
  }, [open, file, importId, target, load]);

  const running = !!data && RUNNING.includes(data.status);
  useEffect(() => {
    if (!running || !id) return;
    const timer = setInterval(() => load(id), 800);
    return () => clearInterval(timer);
  }, [running, id, load]);

  async function act(path: string, init?: RequestInit) {
    if (!id) return;
    try {
      await gw(`/imports/${id}${path}`, init);
      setError(null);
      await load(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const done = data?.status === "committed";
  const committing = data?.status === "committing";
  const doneReported = useRef(false);
  useEffect(() => {
    if (!done || !data || doneReported.current) return;
    doneReported.current = true;
    onDone?.({
      id: data.id,
      listId: data.list_id,
      listVersion: data.list_version,
    });
  }, [done, data, onDone]);

  function close() {
    if (committing) return;
    // Closing before the commit discards the import.
    if (cancelOnClose && id && data && !done && data.status !== "cancelled")
      void gw(`/imports/${id}/cancel`, { method: "POST" }).catch(() => {});
    onClose();
  }

  const step = stepOf(data);
  const filename = data?.filename ?? file?.name ?? "";
  const listReport = data && isListReport(data.report) ? data.report : null;
  const into =
    data?.target === "list"
      ? (data.list_name ?? listReport?.list?.name ?? data.new_list_name ?? null)
      : null;

  return (
    <Modal open={open} onClose={close} labelledBy="import-title" size="lg">
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-6 pt-5 pb-4">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-line text-sheet">
          <Table size={16} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="import-title"
            className="truncate text-[16px] leading-tight font-medium"
          >
            {t("Import {file}", { file: filename })}
          </h2>
          <p className="mt-1 truncate text-[13px] text-muted">
            {data?.target === "corpus"
              ? t("Into the corpus")
              : into
                ? data?.list_id
                  ? t("Into {list}", { list: into })
                  : t("Into a new list: {list}", { list: into })
                : t("Into a list")}
          </p>
        </div>
        <button
          type="button"
          aria-label={t("Close")}
          onClick={close}
          disabled={committing}
          className="-mt-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-subtle hover:text-ink disabled:opacity-40"
        >
          <X size={17} strokeWidth={1.75} />
        </button>
      </div>

      <Steps at={step} done={done} failed={data?.status === "failed"} />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
        {error && <Banner tone="error">{error}</Banner>}
        {data?.status === "failed" && data.error && (
          <Banner tone="error">{data.error}</Banner>
        )}
        {data?.warnings.map((w) => (
          <Banner key={w} tone="warn">
            {w}
          </Banner>
        ))}
        {listReport?.notice && <Banner tone="warn">{listReport.notice}</Banner>}

        {(!data || running) && !error && <Progress data={data} />}

        {data && !running && data.status === "mapping_review" && catalogue && (
          <Mapping
            key={data.tables
              .map((tb) => tb.columns.map((c) => c.field ?? "").join(","))
              .join("|")}
            data={data}
            catalogue={catalogue}
            onSave={(tables) =>
              act("/tables", { method: "PUT", ...json(tables) })
            }
            onFeedback={(text) =>
              act("/feedback", { method: "POST", ...json({ text }) })
            }
            onConfirm={() => act("/report", { method: "POST" })}
            onAsOf={(as_of) => act("", { method: "PATCH", ...json({ as_of }) })}
          />
        )}

        {data && !running && data.status === "report_review" && (
          <Review
            data={data}
            onDecide={(decisions) =>
              act("/decisions", { method: "PUT", ...json({ decisions }) })
            }
            onBack={() =>
              act("/tables", {
                method: "PUT",
                ...json(unchangedTables(data.tables)),
              })
            }
            onCommit={() => act("/commit", { method: "POST" })}
          />
        )}

        {done && data && (
          <Done data={data} onClose={onClose} showOpenList={showOpenList} />
        )}
      </div>
    </Modal>
  );
}

// ── Steps and small parts ──────────────────────────────────────────────────

function Steps({
  at,
  done,
  failed,
}: {
  at: Step;
  done: boolean;
  failed: boolean;
}) {
  const { t } = useI18n();
  const index = STEPS.findIndex((s) => s.key === at);
  return (
    <ol className="flex shrink-0 items-center gap-2.5 px-6 py-3.5">
      {STEPS.map((s, i) => {
        const isDone = i < index || (i === index && done);
        const current = i === index && !done;
        const bad = current && failed;
        return (
          <li
            key={s.key}
            className="flex min-w-0 flex-1 items-center gap-2.5 last:flex-none"
          >
            <span className="flex items-center gap-2">
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums ${
                  bad
                    ? "bg-bad text-white"
                    : isDone || current
                      ? "bg-ink text-white"
                      : "border border-line text-faint"
                }`}
              >
                {bad ? (
                  <X size={11} strokeWidth={2.5} />
                ) : isDone ? (
                  <Check size={11} strokeWidth={2.5} />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={`text-[13px] whitespace-nowrap ${current ? "font-medium text-ink" : isDone ? "text-ink" : "text-faint"}`}
              >
                {t(s.label)}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span
                className={`h-px min-w-4 flex-1 ${i < index ? "bg-ink" : "bg-line"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "error" | "warn" | "info";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`mb-3 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[13.5px] ${
        tone === "error"
          ? "border-[#f0c4ca] bg-[#fdf5f6]"
          : tone === "warn"
            ? "border-line bg-canvas"
            : "border-[#c9d9ef] bg-sky-wash"
      }`}
    >
      {tone !== "info" && (
        <AlertCircle
          size={15}
          strokeWidth={1.75}
          className={`mt-[2px] shrink-0 ${tone === "error" ? "text-bad" : "text-warn"}`}
        />
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Progress({ data }: { data: ImportDetail | null }) {
  const { t } = useI18n();
  const progress = data?.progress ?? 0;
  return (
    <div className="mt-2 rounded-xl border border-line px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-4 text-[13.5px]">
        <span>{data?.step ?? t("Uploading…")}</span>
        <span className="text-muted tabular-nums">
          {Math.round(progress * 100)}%
        </span>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-subtle">
        <div
          className="h-full rounded-full bg-sky-ink transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(3, progress * 100)}%` }}
        />
      </div>
    </div>
  );
}

function unchangedTables(tables: SheetTable[]) {
  return tables.map((tb) => ({
    include: tb.include,
    columns: tb.columns.map((c) => ({
      letter: c.letter,
      field: c.field,
      period: c.period,
      new_label: c.new_label ?? null,
    })),
  }));
}

// ── Mapping ────────────────────────────────────────────────────────────────

type ColumnEdit = {
  letter: string;
  field: string | null;
  period: number | null;
  new_label: string | null;
};

const ENTITY: Record<string, MessageKey> = {
  company: "Company",
  person: "Person",
  role: "Role (person at company)",
  transaction: "Transaction",
  project_ref: "Project reference",
  list_entry: "Longlist entry",
};

function samplesOf(tb: SheetTable, index: number) {
  const out: string[] = [];
  for (const r of tb.preview) {
    const v = r.cells[index];
    if (v === null || v === undefined || v === "") continue;
    const text = String(v);
    if (!out.includes(text)) out.push(text);
    if (out.length >= 3) break;
  }
  return out;
}

function Mapping({
  data,
  catalogue,
  onSave,
  onFeedback,
  onConfirm,
  onAsOf,
}: {
  data: ImportDetail;
  catalogue: Catalogue;
  onSave: (tables: ReturnType<typeof unchangedTables>) => Promise<void>;
  onFeedback: (text: string) => Promise<void>;
  onConfirm: () => Promise<void>;
  onAsOf: (asOf: string) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const isList = data.target === "list";
  const [edits, setEdits] = useState(() =>
    data.tables.map((tb) => ({
      include: tb.include,
      columns: tb.columns.map((c): ColumnEdit => ({
        letter: c.letter,
        field: c.field,
        period: c.period,
        new_label: c.new_label ?? null,
      })),
    })),
  );
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  const labelOf = useCallback(
    (key: string, label: string) => (lang === "de" && FIELD_DE[key]) || label,
    [lang],
  );
  const listKeys = new Set(data.list_columns.map((c) => c.key));
  const points = useMemo(
    () =>
      catalogue.points.filter((p) =>
        isList
          ? ["company", "list_entry"].includes(p.entity) && !listKeys.has(p.key)
          : true,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listKeys follows data
    [catalogue, isList, data.list_columns],
  );
  const grouped = useMemo(() => {
    const groups: Record<string, typeof points> = {};
    for (const p of points) (groups[p.entity] ??= []).push(p);
    return groups;
  }, [points]);
  const pointLabel = useMemo(
    () =>
      Object.fromEntries(
        catalogue.points.map((p) => [p.key, labelOf(p.key, p.label)]),
      ),
    [catalogue, labelOf],
  );
  const targetLabel = (field: string | null) => {
    if (!field) return t("Not imported");
    if (field === HELIOS_ID) return t("Helios ID (row id)");
    if (field === NEW_COLUMN) return t("New column");
    const col = data.list_columns.find((c) => c.key === field);
    return col ? columnLabel(col, lang) : (pointLabel[field] ?? field);
  };

  function setField(ti: number, letter: string, field: string | null) {
    setEdits((all) =>
      all.map((tb, i) =>
        i !== ti
          ? tb
          : {
              ...tb,
              columns: tb.columns.map((c) =>
                c.letter === letter ? { ...c, field } : c,
              ),
            },
      ),
    );
    setDirty(true);
  }
  async function save() {
    await onSave(edits);
    setDirty(false);
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pt-1">
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-[13.5px] text-muted">
          {data.export_id
            ? t(
                "Recognised as a Helios export: columns and rows match by their ids.",
              )
            : t("Check where each column of the file goes.")}
        </p>
        <label className="flex shrink-0 items-center gap-2 text-[13px] text-muted">
          {t("Data as of")}
          <input
            type="date"
            value={data.as_of ?? ""}
            onChange={(e) => e.target.value && void onAsOf(e.target.value)}
            className="h-8 rounded-lg border border-line px-2 text-[13px] text-ink outline-none focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky"
          />
        </label>
      </div>

      {data.tables.map((tb, ti) => (
        <div key={ti} className="mb-4 rounded-xl border border-line">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[13px]">
            {data.tables.length > 1 && (
              <input
                type="checkbox"
                checked={edits[ti].include}
                aria-label={t("Import this table")}
                onChange={(e) => {
                  setEdits((all) =>
                    all.map((x, i) =>
                      i === ti ? { ...x, include: e.target.checked } : x,
                    ),
                  );
                  setDirty(true);
                }}
                className="size-4 accent-ink"
              />
            )}
            <span className="min-w-0 truncate font-medium">
              {tb.sheet}
              {tb.title ? ` · ${tb.title}` : ""}
            </span>
            <span className="ml-auto shrink-0 text-muted">
              {t(tb.row_count === 1 ? "{n} row" : "{n} rows", {
                n: tb.row_count,
              })}
            </span>
          </div>
          <ul className={edits[ti].include ? "" : "opacity-50"}>
            {tb.columns.map((c) => {
              const edit = edits[ti].columns.find((x) => x.letter === c.letter);
              const field = edit?.field ?? null;
              const samples = samplesOf(tb, c.index);
              return (
                <li
                  key={c.letter}
                  className="flex items-center gap-3 border-b border-hairline px-4 py-2 last:border-b-0"
                >
                  <span className="w-6 shrink-0 text-[12px] text-faint tabular-nums">
                    {c.letter}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">
                      {c.header}
                    </span>
                    <span className="block truncate text-[12.5px] text-muted">
                      {samples.join(" · ") || t("Empty")}
                    </span>
                  </span>
                  <ArrowRight
                    size={14}
                    strokeWidth={1.75}
                    className="shrink-0 text-faint"
                  />
                  <select
                    value={field ?? ""}
                    aria-label={t("Column {letter} goes to", {
                      letter: c.letter,
                    })}
                    onChange={(e) =>
                      setField(ti, c.letter, e.target.value || null)
                    }
                    className={`h-9 w-[240px] shrink-0 rounded-lg border border-line bg-white px-2.5 text-[13.5px] outline-none focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky ${field ? "text-ink" : "text-muted"}`}
                  >
                    <option value="">{t("Not imported")}</option>
                    {isList &&
                      (field === HELIOS_ID ||
                        c.header.trim().toLowerCase() === "helios id") && (
                        <option value={HELIOS_ID}>
                          {t("Helios ID (row id)")}
                        </option>
                      )}
                    {isList && (
                      <option value={NEW_COLUMN}>
                        {t("New column “{name}”", {
                          name: edit?.new_label || c.header,
                        })}
                      </option>
                    )}
                    {isList && data.list_columns.length > 0 && (
                      <optgroup label={t("This list")}>
                        {data.list_columns.map((col) => (
                          <option key={col.key} value={col.key}>
                            {columnLabel(col, lang)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {Object.entries(grouped).map(([entity, ps]) => (
                      <optgroup
                        key={entity}
                        label={
                          isList
                            ? t("Other data points")
                            : t(ENTITY[entity] ?? "Company")
                        }
                      >
                        {ps.map((p) => (
                          <option key={p.key} value={p.key}>
                            {pointLabel[p.key]}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <span className="w-5 shrink-0">
                    {(c.reason || c.suggested_field) && (
                      <InfoTip
                        label={t("Why this column")}
                        marked={!!c.changed_from}
                      >
                        <span className="block font-medium">
                          {c.suggested_field
                            ? `${t("Suggested")}: ${targetLabel(c.suggested_field)}${
                                c.confidence !== null &&
                                c.confidence !== undefined &&
                                c.confidence < 1
                                  ? ` (${Math.round(c.confidence * 100)}%)`
                                  : ""
                              }`
                            : t("No suggestion")}
                        </span>
                        {c.reason && (
                          <span className="mt-0.5 block text-white/75">
                            {c.reason}
                          </span>
                        )}
                      </InfoTip>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="rounded-xl border border-line px-4 pt-3.5 pb-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[14px] font-medium">
            {t("Corrections or additional context")}
          </span>
          <span className="rounded-full bg-subtle px-2 py-0.5 text-[12px] text-muted">
            {t("Optional")}
          </span>
        </div>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={t("e.g. Column F contains EBITDA, not revenue.")}
          rows={2}
          className="mt-2.5 block w-full resize-y rounded-xl border border-line bg-subtle px-3.5 py-2.5 text-[14px] outline-none placeholder:text-faint focus:border-[#c9d9ef] focus:bg-white focus:ring-3 focus:ring-sky"
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={!feedback.trim() || busy}
          onClick={() =>
            run(async () => {
              if (dirty) await save();
              await onFeedback(feedback);
              setFeedback("");
            })
          }
          className={`${modalSecondary} flex h-10 items-center gap-1.5 px-4 disabled:opacity-50`}
        >
          <RefreshCw size={14} strokeWidth={1.75} />
          {t("Re-run mapping")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (dirty) await save();
              await onConfirm();
            })
          }
          className={`${modalPrimary} flex h-10 items-center gap-1.5 px-5`}
        >
          {t("Confirm mapping")}
          <ArrowRight size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

// ── Review ─────────────────────────────────────────────────────────────────

function Review({
  data,
  onDecide,
  onBack,
  onCommit,
}: {
  data: ImportDetail;
  onDecide: (decisions: Record<string, string>) => Promise<void>;
  onBack: () => Promise<void>;
  onCommit: () => Promise<void>;
}) {
  const { t, formatNumber } = useI18n();
  const report = data.report;
  const [busy, setBusy] = useState(false);
  const totals = report?.totals ?? {
    new_rows: 0,
    changed_cells: 0,
    conflicts: 0,
    errors: 0,
  };
  const list = isListReport(report) ? report : null;
  const tiles: { label: MessageKey; n: number; tone?: string }[] = [
    { label: "New rows", n: totals.new_rows },
    { label: "Changed cells", n: totals.changed_cells },
    {
      label: list ? "Conflicts" : "Lower-scored values",
      n: totals.conflicts,
      tone: totals.conflicts ? "text-warn" : undefined,
    },
    {
      label: "Errors",
      n: totals.errors,
      tone: totals.errors ? "text-bad" : undefined,
    },
  ];
  const nothing =
    list &&
    totals.new_rows + totals.changed_cells === 0 &&
    !list.rows.some((r) => r.cells.some((c) => c.class === "conflict")) &&
    !list.deleted.some((d) => data.decisions[`d:${d.entry_id}`] === "remove");

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pt-1">
      {list && <Origin report={list} />}
      <div className="grid grid-cols-4 gap-2">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border border-line px-3.5 py-3"
          >
            <div
              className={`font-serif text-[24px] leading-none tabular-nums ${tile.tone ?? ""}`}
            >
              {formatNumber(tile.n)}
            </div>
            <div className="mt-1.5 text-[13px] text-muted">{t(tile.label)}</div>
          </div>
        ))}
      </div>

      {list ? (
        <ListDetails report={list} data={data} onDecide={onDecide} />
      ) : (
        <p className="mt-4 text-[13.5px] text-muted">
          {t(
            "Matches, duplicates and per-row decisions are in the full report.",
          )}{" "}
          <Link
            href={`/admin/imports/${data.id}`}
            className="text-ink underline underline-offset-[3px]"
          >
            {t("Open the full report")}
          </Link>
        </p>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => run(onBack)}
          className={`${modalSecondary} h-10 px-4`}
        >
          {t("Back to mapping")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(onCommit)}
          className={`${modalPrimary} flex h-10 items-center gap-1.5 px-5`}
        >
          {nothing ? t("Finish without changes") : t("Import")}
          <ArrowRight size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

/** Where the rows were matched from: our own export (by row id) or, for an
 * outside file, by company. */
function Origin({ report }: { report: ListReport }) {
  const { t, lang } = useI18n();
  const e = report.export;
  const when = e
    ? new Date(e.at).toLocaleString(lang === "de" ? "de-CH" : "en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  return (
    <Banner tone="info">
      {e
        ? t(
            "Exported by {name} on {date} (version {n}). Each cell is compared with what was exported, so edits made in Helios since then are kept.",
            {
              name: e.name,
              date: when,
              n: e.list_version,
            },
          )
        : t(
            "Not a Helios export: rows were matched by company, and values that differ from the list count as new data from this file.",
          )}
    </Banner>
  );
}

function display(v: unknown, t: Translate) {
  if (v === null || v === undefined || v === "") return t("empty");
  return typeof v === "object" ? show(v) : String(v);
}

function ListDetails({
  report,
  data,
  onDecide,
}: {
  report: ListReport;
  data: ImportDetail;
  onDecide: (decisions: Record<string, string>) => Promise<void>;
}) {
  const { t } = useI18n();
  const decisions = data.decisions;
  const conflicts = report.rows.flatMap((r) =>
    r.cells
      .filter((c) => c.class === "conflict")
      .map((c) => ({ row: r, cell: c })),
  );
  const newRows = report.rows.filter((r) => r.kind === "new");
  const changes = report.rows.flatMap((r) =>
    r.kind === "existing"
      ? r.cells
          .filter((c) => c.class === "new" || c.class === "changed")
          .map((c) => ({ row: r, cell: c }))
      : [],
  );
  const errors = report.rows.filter((r) => r.errors.length > 0);
  const kept = report.summary.kept ?? 0;

  return (
    <div className="mt-4 flex flex-col gap-3">
      {conflicts.length > 0 && (
        <Section
          title={t("Conflicts")}
          aside={t("Changed in Helios and in the file since the export")}
          open
        >
          {conflicts.map(({ row, cell }) => {
            const key = `c:${row.key}:${cell.key}`;
            const pick = decisions[key] ?? "helios";
            return (
              <div
                key={key}
                className="border-b border-hairline px-4 py-3 last:border-b-0"
              >
                <div className="text-[14px]">
                  <span className="font-medium">{row.label ?? "–"}</span>
                  <span className="text-muted"> · {cell.label}</span>
                </div>
                <div className="mt-1 text-[12.5px] text-muted">
                  {t("When exported")}:{" "}
                  <span className="text-faint line-through">
                    {display(cell.exported, t)}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Choice
                    selected={pick === "helios"}
                    label={t("Keep Helios")}
                    value={display(cell.current, t)}
                    onClick={() => onDecide({ [key]: "helios" })}
                  />
                  <Choice
                    selected={pick === "file"}
                    label={t("Use the file")}
                    value={display(cell.file, t)}
                    onClick={() => onDecide({ [key]: "file" })}
                  />
                </div>
              </div>
            );
          })}
        </Section>
      )}

      {report.deleted.length > 0 && (
        <Section
          title={t("Missing from the file")}
          aside={t("Rows that were exported but aren't in the file any more")}
          open
        >
          {report.deleted.map((d) => {
            const key = `d:${d.entry_id}`;
            const remove = decisions[key] === "remove";
            return (
              <div
                key={key}
                className="flex items-center gap-3 border-b border-hairline px-4 py-2.5 last:border-b-0"
              >
                <span
                  className={`min-w-0 flex-1 truncate text-[14px] ${remove ? "text-faint line-through" : ""}`}
                >
                  {d.label ?? "–"}
                </span>
                <Toggle
                  options={[
                    { value: "keep", label: t("Keep") },
                    { value: "remove", label: t("Remove") },
                  ]}
                  value={remove ? "remove" : "keep"}
                  onChange={(v) => onDecide({ [key]: v })}
                />
              </div>
            );
          })}
        </Section>
      )}

      {newRows.length > 0 && (
        <Section
          title={t("New rows")}
          aside={t("{n} from the file", { n: newRows.length })}
        >
          {newRows.map((r) => (
            <div
              key={r.key}
              className="flex items-center gap-3 border-b border-hairline px-4 py-2 text-[14px] last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate">{r.label ?? "–"}</span>
              <span className="shrink-0 text-[12.5px] text-muted">
                {r.company_id ? t("Company in Helios") : t("Not in Helios yet")}
              </span>
            </div>
          ))}
        </Section>
      )}

      {changes.length > 0 && (
        <Section
          title={t("Changed cells")}
          aside={t(changes.length === 1 ? "1 cell" : "{n} cells", {
            n: changes.length,
          })}
        >
          {changes.map(({ row, cell }) => (
            <ChangeRow key={`${row.key}:${cell.key}`} row={row} cell={cell} />
          ))}
        </Section>
      )}

      {errors.length > 0 && (
        <Section title={t("Errors")} aside={t("Skipped; fix them in the file")}>
          {errors.map((r) => (
            <div
              key={r.key}
              className="border-b border-hairline px-4 py-2 text-[13.5px] last:border-b-0"
            >
              <span className="font-medium">
                {t("Row {n}", { n: r.row })}
                {r.label ? ` · ${r.label}` : ""}
              </span>
              <span className="text-muted"> — {r.errors.join("; ")}</span>
            </div>
          ))}
        </Section>
      )}

      {(kept > 0 || (report.summary.unchanged ?? 0) > 0) && (
        <p className="px-1 text-[13px] text-muted">
          {[
            (report.summary.unchanged ?? 0) > 0 &&
              t(
                report.summary.unchanged === 1
                  ? "1 unchanged cell keeps its sources."
                  : "{n} unchanged cells keep their sources.",
                { n: report.summary.unchanged },
              ),
            kept > 0 &&
              t(
                kept === 1
                  ? "1 cell changed in Helios since the export stays as it is."
                  : "{n} cells changed in Helios since the export stay as they are.",
                { n: kept },
              ),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
    </div>
  );
}

function ChangeRow({
  row,
  cell,
}: {
  row: ListReport["rows"][number];
  cell: ListCell;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 border-b border-hairline px-4 py-2 text-[13.5px] last:border-b-0">
      <span className="w-[34%] min-w-0 shrink-0">
        <span className="block truncate font-medium">{row.label ?? "–"}</span>
        <span className="block truncate text-[12.5px] text-muted">
          {cell.label}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate">
        {cell.class === "changed" && (
          <span className="mr-1.5 text-faint line-through">
            {display(cell.current, t)}
          </span>
        )}
        {display(cell.value ?? cell.file, t)}
      </span>
      <span className="shrink-0 rounded-full bg-subtle px-2 py-0.5 text-[12px] text-muted">
        {cell.source === "manual" ? t("Your edit") : t("From the file")}
      </span>
    </div>
  );
}

function Section({
  title,
  aside,
  open: initial = false,
  children,
}: {
  title: string;
  aside?: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="rounded-xl border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
      >
        {open ? (
          <ChevronDown size={15} strokeWidth={1.75} className="text-muted" />
        ) : (
          <ChevronRight size={15} strokeWidth={1.75} className="text-muted" />
        )}
        <span className="text-[14px] font-medium">{title}</span>
        {aside && (
          <span className="min-w-0 truncate text-[13px] text-muted">
            {aside}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-line"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Choice({
  selected,
  label,
  value,
  onClick,
}: {
  selected: boolean;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-ink bg-white"
          : "border-line bg-white hover:bg-subtle"
      }`}
    >
      <span
        className={`mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border ${selected ? "border-ink bg-ink" : "border-line"}`}
      >
        {selected && <span className="size-1.5 rounded-full bg-white" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] text-muted">{label}</span>
        <span className="block text-[14px] break-words">{value}</span>
      </span>
    </button>
  );
}

function Toggle({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex shrink-0 rounded-full border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => value !== o.value && onChange(o.value)}
          className={`h-7 rounded-full px-3 text-[13px] font-medium transition-colors ${
            value === o.value
              ? "bg-ink text-white"
              : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Done ───────────────────────────────────────────────────────────────────

function Done({
  data,
  onClose,
  showOpenList,
}: {
  data: ImportDetail;
  onClose: () => void;
  showOpenList: boolean;
}) {
  const { t } = useI18n();
  const list = isListReport(data.report) ? data.report : null;
  return (
    <div className="flex flex-col items-center px-4 pt-6 pb-2 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-sky text-sky-ink">
        <Check size={18} strokeWidth={2} />
      </span>
      <p className="mt-3 text-[15px] font-medium">
        {data.target === "corpus"
          ? t("Imported as version v{n}", { n: data.version_id ?? "–" })
          : data.list_version
            ? t("Imported as version {n} of the list", {
                n: data.list_version,
              })
            : t("Nothing changed, so no new version was made")}
      </p>
      {list && data.list_version && (
        <p className="mt-1 text-[13.5px] text-muted">
          {t(
            "Every change is part of that version; restore an older one from the version menu to undo it.",
          )}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        {data.list_id && showOpenList && (
          <Link
            href={`/longlists/${data.list_id}`}
            onClick={onClose}
            className={`${modalSecondary} flex h-9 items-center px-4`}
          >
            {t("Open the list")}
          </Link>
        )}
        <button
          type="button"
          onClick={onClose}
          className={`${modalPrimary} h-9 px-5`}
        >
          {t("Done")}
        </button>
      </div>
    </div>
  );
}
