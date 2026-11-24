"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  RefreshCw,
  Table,
  X,
} from "@/components/icons";
import {
  GatewayError,
  gw,
  isListReport,
  json,
  RUNNING,
  show,
  type Catalogue,
  type ImportDetail,
  type ListCell,
  type ListReport,
  type Report,
  type ReportRow,
  type SourceType,
  type Table as SheetTable,
  type Transform,
} from "@/lib/gateway";
import { useI18n, type MessageKey, type Translate } from "@/lib/i18n";
import { columnLabel, type LonglistSummary } from "@/lib/longlists";
import { FIELD_DE, SOURCE_DE } from "@/lib/corpus";
import { InfoTip } from "./admin/ui";
import { TransformControls } from "./TransformEditor";
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
  | { kind: "corpus" };

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

/** ⌘↵ (Ctrl+Enter elsewhere) runs a step's main button. */
function useSubmitShortcut(run: () => void, enabled = true) {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.repeat) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/** The ⌘↵ hint inside a dark main button. */
function ShortcutHint() {
  return (
    <span
      aria-hidden
      className="ml-1 flex items-center gap-0.5 text-[12px] text-white/55"
    >
      {isMac() ? "⌘" : "Ctrl"}
      <CornerDownLeft size={11} strokeWidth={2} />
    </span>
  );
}

/** The bar's 700ms glide to 100%, then a short pause on the full bar. */
const SETTLE_MS = 1100;

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
}: {
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
  const { t, lang } = useI18n();
  const [id, setId] = useState<string | null>(importId ?? null);
  const [data, setData] = useState<ImportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  // A corpus file uploaded before: the earlier imports, to upload anyway.
  const [duplicate, setDuplicate] = useState<
    { filename: string; status: string; created_at: string }[] | null
  >(null);
  const started = useRef(false);
  // When a step finishes faster than the bar can follow, the last progress
  // view stays up at 100% for a moment before the next step shows.
  const [settling, setSettling] = useState<ImportDetail | null>(null);
  const shown = useRef<ImportDetail | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const load = useCallback(
    async (which: string) => {
      try {
        const next = await gw<ImportDetail>(`/imports/${which}`);
        const prev = shown.current;
        // Before the first answer the bar shows the upload, so that counts too
        // (not when opening an import that already exists).
        const wasRunning = prev ? RUNNING.includes(prev.status) : !importId;
        const finished =
          !RUNNING.includes(next.status) &&
          next.status !== "failed" &&
          next.status !== "cancelled";
        if (wasRunning && finished && !settleTimer.current) {
          setSettling({
            ...(prev ?? next),
            step: prev?.step ?? null,
            progress: 1,
          });
          settleTimer.current = setTimeout(() => {
            settleTimer.current = null;
            setSettling(null);
          }, SETTLE_MS);
        }
        shown.current = next;
        setData(next);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [importId],
  );

  // Upload once per opening.
  useEffect(() => {
    if (!open || started.current) return;
    started.current = true;
    gw<Catalogue>("/catalogue").then(setCatalogue, () => {});
    if (importId) {
      void load(importId);
      return;
    }
    if (file) upload(file, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open, file, importId, load]);

  function upload(file: File, allowDuplicate: boolean) {
    const form = new FormData();
    form.append("file", file);
    form.append("last_modified", String(file.lastModified));
    form.append("target", target.kind);
    if (allowDuplicate) form.append("allow_duplicate", "true");
    if (target.kind === "list") {
      if (target.listId) form.append("list_id", target.listId);
      else if (target.newListName)
        form.append("new_list_name", target.newListName);
      if (target.sessionId) form.append("session_id", target.sessionId);
    }
    setDuplicate(null);
    gw<{ id: string }>("/imports", { method: "POST", body: form }).then(
      (r) => {
        setId(r.id);
        void load(r.id);
      },
      (e: Error) => {
        const previous =
          e instanceof GatewayError && e.status === 409
            ? (e.detail as { previous?: typeof duplicate })?.previous
            : null;
        if (previous) setDuplicate(previous);
        else setError(e.message);
      },
    );
  }

  const running = !!data && RUNNING.includes(data.status);
  useEffect(() => {
    if (!running || !id) return;
    const timer = setInterval(() => load(id), 800);
    return () => clearInterval(timer);
  }, [running, id, load]);

  async function act(path: string, init?: RequestInit) {
    if (!id) return false;
    try {
      await gw(`/imports/${id}${path}`, init);
      setError(null);
      await load(id);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
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

  const step = stepOf(settling ?? data);
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

      {!(done && !settling) && (
        <Steps at={step} done={false} failed={data?.status === "failed"} />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
        {error && <Banner tone="error">{error}</Banner>}
        {data?.status === "failed" && data.error && (
          <Banner tone="error">{data.error}</Banner>
        )}
        {/* Notes on reading the file belong to the mapping; the review has
            its own origin banner. */}
        {(step === "upload" || step === "map") &&
          data?.warnings.map((w) => (
            <Banner key={w} tone="warn">
              {w}
            </Banner>
          ))}
        {listReport?.notice && !done && (
          <Banner tone="warn">{listReport.notice}</Banner>
        )}

        {duplicate && file && (
          <Banner tone="warn">
            {t("This exact file was uploaded before ({when}).", {
              when: duplicate
                .map(
                  (p) =>
                    `${new Date(p.created_at).toLocaleDateString(
                      lang === "de" ? "de-CH" : "en-GB",
                      { day: "numeric", month: "short", year: "numeric" },
                    )}, ${p.status}`,
                )
                .join("; "),
            })}
            <button
              type="button"
              onClick={() => upload(file, true)}
              className={`${modalPrimary} mt-2 flex h-8 items-center px-4`}
            >
              {t("Upload anyway")}
            </button>
          </Banner>
        )}

        {(!data || running || settling) && !error && !duplicate && (
          <Progress data={settling ?? data} />
        )}

        {data &&
          !running &&
          !settling &&
          data.status === "mapping_review" &&
          catalogue && (
            <Mapping
              key={data.tables
                .map((tb) =>
                  tb.columns
                    .map(
                      (c) =>
                        `${c.field ?? ""}${JSON.stringify(c.transforms ?? [])}`,
                    )
                    .join(","),
                )
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
              onSettings={(body) => act("", { method: "PATCH", ...json(body) })}
            />
          )}

        {data && !running && !settling && data.status === "report_review" && (
          <Review
            data={data}
            catalogue={catalogue}
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

        {done && !settling && data && <Done data={data} onClose={onClose} />}
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
      transforms: c.transforms ?? [],
    })),
  }));
}

// ── Mapping ────────────────────────────────────────────────────────────────

type ColumnEdit = {
  letter: string;
  field: string | null;
  period: number | null;
  new_label: string | null;
  transforms: Transform[];
};

const ENTITY: Record<string, MessageKey> = {
  company: "Company",
  person: "Person",
  role: "Role (person at company)",
  transaction: "Transaction",
  project_ref: "Project reference",
  list_entry: "Longlist entry",
};

/** "0 · 1999 → – · 1999": both sides from the same rows, "–" where empty. */
function pairedSamples(before: unknown[], after: unknown[]) {
  if (before.length === 0) return "";
  const side = (vs: unknown[]) =>
    vs.map((v) => (v === null || v === undefined ? "–" : String(v))).join(" · ");
  return `${side(before)} → ${side(after)}`;
}

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
  onSettings,
}: {
  data: ImportDetail;
  catalogue: Catalogue;
  onSave: (tables: ReturnType<typeof unchangedTables>) => Promise<unknown>;
  onFeedback: (text: string) => Promise<unknown>;
  onConfirm: () => Promise<unknown>;
  onSettings: (body: Record<string, unknown>) => Promise<unknown>;
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
        transforms: c.transforms ?? [],
      })),
    })),
  );
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourcePending, setSourcePending] = useState(false);
  const [savingTransform, setSavingTransform] = useState(false);

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
  // A transformation is saved at once, so the preview shows its effect; if
  // the gateway refuses it, the row goes back to what it was.
  async function setTransforms(ti: number, letter: string, next: Transform[]) {
    const before = edits;
    const after = edits.map((tb, i) =>
      i !== ti
        ? tb
        : {
            ...tb,
            columns: tb.columns.map((c) =>
              c.letter === letter ? { ...c, transforms: next } : c,
            ),
          },
    );
    setEdits(after);
    setSavingTransform(true);
    try {
      const ok = await onSave(after);
      if (ok) setDirty(false);
      else setEdits(before);
    } finally {
      setSavingTransform(false);
    }
  }
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const confirm = () =>
    run(async () => {
      if (dirty) await save();
      await onConfirm();
    });
  useSubmitShortcut(() => void confirm(), !busy && !sourcePending);

  return (
    <div className="pt-1">
      <p className="mb-3 text-[13.5px] text-muted">
        {data.export_id
          ? edits.some((tb) => tb.columns.some((c) => c.field === HELIOS_ID))
            ? t(
                "Recognised as a Helios export: columns and rows match by their ids.",
              )
            : t(
                "Recognised as a Helios export, but its hidden Helios ID column is missing: rows will be matched by company.",
              )
          : t("Check where each column of the file goes.")}
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-line px-4 py-3">
        {/* A verified export holds Helios's own values and the uploader's
            edits, so it isn't asked where its data comes from. */}
        {!data.export_id && (
          <SourceSetting
            data={data}
            onSave={onSettings}
            onPending={setSourcePending}
          />
        )}
        {!isList && <LonglistSetting data={data} onSave={onSettings} />}
        <label className="flex flex-col gap-1 text-[12.5px] text-muted">
          {t("Data as of")}
          <input
            type="date"
            value={data.as_of ?? ""}
            onChange={(e) =>
              e.target.value && void onSettings({ as_of: e.target.value })
            }
            className={FIELD}
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
              // The hidden row-id column of our export maps itself; nothing to choose.
              if (field === HELIOS_ID) return null;
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
                      {(edit?.transforms.length ?? 0) > 0 &&
                      c.samples_before &&
                      c.samples_after
                        ? pairedSamples(c.samples_before, c.samples_after) ||
                          t("Empty")
                        : samples.join(" · ") || t("Empty")}
                    </span>
                  </span>
                  <ArrowRight
                    size={14}
                    strokeWidth={1.75}
                    className="shrink-0 text-faint"
                  />
                  <span className="relative flex shrink-0 flex-col items-start gap-1.5">
                    <span className="relative">
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
                      {field === NEW_COLUMN && (
                        // Marks a column the import adds to the list.
                        <span className="pointer-events-none absolute -top-[7px] right-2 rounded-full bg-sky px-1.5 text-[10.5px] leading-[14px] font-medium text-sky-ink">
                          {t("New")}
                        </span>
                      )}
                    </span>
                    {/* A verified export is never transformed (the gateway
                        refuses it); unmapped columns have nothing to change. */}
                    {!data.export_id && field && (
                      <TransformControls
                        letter={c.letter}
                        transforms={edit?.transforms ?? []}
                        others={tb.columns
                          .filter(
                            (o) =>
                              o.letter !== c.letter &&
                              edits[ti].columns.find(
                                (x) => x.letter === o.letter,
                              )?.field !== HELIOS_ID,
                          )
                          .map((o) => ({ letter: o.letter, header: o.header }))}
                        busy={savingTransform}
                        onChange={(next) =>
                          void setTransforms(ti, c.letter, next)
                        }
                      />
                    )}
                  </span>
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
        {sourcePending && (
          <span className="mr-auto text-[13px] text-muted">
            {t("Say which source “Other” is to continue.")}
          </span>
        )}
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
          disabled={busy || sourcePending}
          onClick={confirm}
          className={`${modalPrimary} flex h-10 items-center gap-1.5 px-5 disabled:opacity-50`}
        >
          {t("Confirm mapping")}
          <ShortcutHint />
        </button>
      </div>
    </div>
  );
}

const FIELD =
  "h-9 rounded-lg border border-line bg-white px-2.5 text-[13.5px] text-ink outline-none focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky";
const OTHER = "other";

/** Where the file's data comes from: a known source, scored at its
 * confidence ("Uploaded file" by default for lists). "Other" asks what the
 * source is; that name is kept as a note on the values (never shown as their
 * source), so a source named often can become one of the list later. The
 * same control for corpus and list imports. */
function SourceSetting({
  data,
  onSave,
  onPending,
}: {
  data: ImportDetail;
  onSave: (body: Record<string, unknown>) => Promise<unknown>;
  /** "Other" is picked but not named yet: the mapping can't be confirmed. */
  onPending: (pending: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const [sources, setSources] = useState<SourceType[]>([]);
  const [other, setOther] = useState(data.source_type === OTHER);
  const [note, setNote] = useState(data.source_note ?? "");
  useEffect(() => {
    gw<SourceType[]>("/source-types").then(
      (all) => setSources(all.filter((s) => s.importable)),
      () => {},
    );
  }, []);
  const saved = data.source_type === OTHER && !!data.source_note;
  useEffect(() => {
    onPending(other && !saved);
  }, [other, saved, onPending]);
  const label = (s: SourceType) =>
    (lang === "de" && SOURCE_DE[s.key]) || s.label;
  function saveNote() {
    const name = note.trim();
    if (name && name !== data.source_note)
      void onSave({ source_type: OTHER, source_note: name });
  }
  return (
    <>
      <label className="flex flex-col gap-1 text-[12.5px] text-muted">
        {t("Where is this data from?")}
        <select
          value={other ? OTHER : data.source_type}
          onChange={(e) => {
            const v = e.target.value;
            setOther(v === OTHER);
            if (v === OTHER) {
              // Saved once it's named; a name typed before comes back.
              if (note.trim()) saveNote();
              return;
            }
            void onSave({ source_type: v });
          }}
          className={`${FIELD} w-[230px]`}
        >
          {sources.map((s) => (
            <option key={s.key} value={s.key}>
              {label(s)} · {Math.round(s.confidence * 100)}%
            </option>
          ))}
        </select>
      </label>
      {other && (
        <label className="flex flex-col gap-1 text-[12.5px] text-muted">
          {t("Which source?")}
          <input
            autoFocus={!saved}
            required
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("e.g. a broker's list")}
            onBlur={saveNote}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            aria-invalid={!saved}
            className={`${FIELD} w-[200px] ${saved ? "" : "border-[#c9d9ef] ring-3 ring-sky"}`}
          />
        </label>
      )}
    </>
  );
}

/** Corpus imports can also put the companies on a longlist: an existing
 * one or a new one (named here), as one new version of it. */
function LonglistSetting({
  data,
  onSave,
}: {
  data: ImportDetail;
  onSave: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [lists, setLists] = useState<LonglistSummary[]>([]);
  const [creating, setCreating] = useState(!!data.new_list_name);
  useEffect(() => {
    gw<LonglistSummary[]>("/longlists").then(setLists, () => {});
  }, []);
  return (
    <>
      <label className="flex flex-col gap-1 text-[12.5px] text-muted">
        {t("Also add to a longlist")}
        <select
          value={data.list_id ?? (creating ? "new" : "")}
          onChange={(e) => {
            const next = e.target.value;
            setCreating(next === "new");
            if (next === "new") void onSave({ list_id: null });
            else void onSave({ list_id: next || null, new_list_name: null });
          }}
          className={`${FIELD} w-[200px]`}
        >
          <option value="">{t("None")}</option>
          <option value="new">{t("New list…")}</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      {creating && !data.list_id && (
        <label className="flex flex-col gap-1 text-[12.5px] text-muted">
          {t("New list name")}
          <input
            autoFocus={!data.new_list_name}
            defaultValue={data.new_list_name ?? ""}
            placeholder={t("e.g. Project Cedar – Buyers")}
            onBlur={(e) => void onSave({ new_list_name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className={`${FIELD} w-[200px]`}
          />
        </label>
      )}
    </>
  );
}

// ── Review ─────────────────────────────────────────────────────────────────

function Review({
  data,
  catalogue,
  onDecide,
  onBack,
  onCommit,
}: {
  data: ImportDetail;
  catalogue: Catalogue | null;
  onDecide: (decisions: Record<string, string>) => Promise<unknown>;
  onBack: () => Promise<unknown>;
  onCommit: () => Promise<unknown>;
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
  const corpus = report && !isListReport(report) ? report : null;
  const corpusRows = corpus
    ? corpus.rows.filter(
        (r) => (data.decisions[r.key] ?? r.decision) !== "skip",
      ).length
    : 0;
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

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const blocked = !!corpus && corpusRows === 0;
  useSubmitShortcut(() => void run(onCommit), !busy && !blocked);

  return (
    <div className="pt-1">
      {list && (
        <Origin
          report={list}
          // The gateway's note on an export mark it couldn't use (both
          // versions end "…matched by company instead.").
          note={data.warnings.find((w) => w.includes("matched by company"))}
        />
      )}
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
        corpus && (
          <CorpusDetails
            report={corpus}
            data={data}
            catalogue={catalogue}
            onDecide={onDecide}
          />
        )
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => run(onBack)}
          aria-label={t("Back to mapping")}
          title={t("Back to mapping")}
          className="flex size-10 items-center justify-center rounded-full border border-line bg-white text-muted transition-colors hover:bg-subtle hover:text-ink disabled:opacity-50"
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          disabled={busy || blocked}
          onClick={() => run(onCommit)}
          className={`${modalPrimary} flex h-10 items-center gap-1.5 px-5 disabled:opacity-50`}
        >
          {nothing
            ? t("Finish without changes")
            : corpus
              ? t(corpusRows === 1 ? "Import 1 row" : "Import {n} rows", {
                  n: formatNumber(corpusRows),
                })
              : t("Import")}
          <ShortcutHint />
        </button>
      </div>
    </div>
  );
}

/** Where the rows were matched from: our own export (by row id) or, for an
 * outside file, by company. */
function Origin({
  report,
  note,
}: {
  report: ListReport;
  /** Why a file with a Helios export mark was matched by company anyway
   * (another list's export, or a mark that didn't verify). */
  note?: string;
}) {
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
          ) +
          (e.has_ids === false
            ? " " +
              t(
                "The hidden Helios ID column is missing, so rows were matched by company and rows deleted from the file can't be detected.",
              )
            : "")
        : note
          ? `${note} ${t("Values that differ from the list count as new data from this file.")}`
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
  onDecide: (decisions: Record<string, string>) => Promise<unknown>;
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

      {kept > 0 && (
        <p className="px-1 text-[13px] text-muted">
          {t(
            kept === 1
              ? "1 cell changed in Helios since the export stays as it is."
              : "{n} cells changed in Helios since the export stay as they are.",
            { n: kept },
          )}
        </p>
      )}
    </div>
  );
}

const MATCH_TEXT: Record<string, MessageKey> = {
  certain: "Certain match",
  likely: "Likely match",
  suggestion: "Possible match",
  none: "New company",
  duplicate: "Duplicate in the file",
};

type RowFilter = "all" | "errors" | "matches" | "duplicates" | "conflicts";
const ROW_FILTERS: { key: RowFilter; label: MessageKey }[] = [
  { key: "all", label: "All" },
  { key: "matches", label: "Matches" },
  { key: "duplicates", label: "Duplicates" },
  { key: "conflicts", label: "Lower-scored" },
  { key: "errors", label: "Errors" },
];

/** A corpus import's review: notes, columns left out, then every row with
 * its match and a decision (new company, merge, same as another row, skip);
 * a row opens to its values against the shown ones. */
function CorpusDetails({
  report,
  data,
  catalogue,
  onDecide,
}: {
  report: Report;
  data: ImportDetail;
  catalogue: Catalogue | null;
  onDecide: (decisions: Record<string, string>) => Promise<unknown>;
}) {
  const { t, formatNumber, lang } = useI18n();
  const [filter, setFilter] = useState<RowFilter>("all");
  const labels = useMemo(
    () =>
      Object.fromEntries(
        (catalogue?.points ?? []).map((p) => [
          p.key,
          (lang === "de" && FIELD_DE[p.key]) || p.label,
        ]),
      ),
    [catalogue, lang],
  );
  const decisions: Record<string, string> = {
    ...Object.fromEntries(report.rows.map((r) => [r.key, r.decision])),
    ...data.decisions,
  };
  const matches = (r: ReportRow) =>
    filter === "errors"
      ? r.errors.length > 0
      : filter === "matches"
        ? !!r.company && r.company.match.level !== "none"
        : filter === "duplicates"
          ? !!r.duplicate_of
          : filter === "conflicts"
            ? r.cells.some((c) => c.vs === "loses")
            : true;
  const rows = report.rows.filter(matches);
  const included = report.rows.filter(
    (r) => decisions[r.key] !== "skip",
  ).length;
  const gaps = report.formula_gaps.filter((g) => g.cells.length > 0);

  return (
    <div className="mt-4 flex flex-col gap-3">
      {report.notice && <Banner tone="warn">{report.notice}</Banner>}
      {gaps.length > 0 && (
        <Banner tone="warn">
          {t("Formulas without a saved result: {cells}", {
            cells: gaps
              .map((g) => `${g.sheet} ${g.cells.join(", ")}`)
              .join("; "),
          })}
        </Banner>
      )}

      {report.unmapped_columns.length > 0 && (
        <Section
          title={t("Columns left out")}
          aside={t("Not imported; map them to bring them in")}
        >
          {report.unmapped_columns.map((u) => (
            <div
              key={`${u.table}${u.letter}`}
              className="border-b border-hairline px-4 py-2 text-[13.5px] last:border-b-0"
            >
              <span className="font-medium">
                {u.letter} · {u.header}
              </span>
              <span className="text-muted">
                {" "}
                — {u.samples.join(" · ") || t("Empty")}
              </span>
            </div>
          ))}
        </Section>
      )}

      <Section
        title={t("Rows")}
        aside={t("{n} of {total} will be imported", {
          n: formatNumber(included),
          total: formatNumber(report.rows.length),
        })}
        open
      >
        <div className="flex gap-1 border-b border-hairline px-3 py-2">
          {ROW_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`h-7 rounded-full px-3 text-[13px] transition-colors ${filter === f.key ? "bg-subtle font-medium text-ink" : "text-muted hover:text-ink"}`}
            >
              {t(f.label)}
            </button>
          ))}
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-[13.5px] text-muted">
            {t("No rows here.")}
          </p>
        ) : (
          rows.map((r) => (
            <CorpusRow
              key={r.key}
              row={r}
              decision={decisions[r.key]}
              labels={labels}
              onDecide={(d) => onDecide({ [r.key]: d })}
            />
          ))
        )}
      </Section>
    </div>
  );
}

function CorpusRow({
  row,
  decision,
  labels,
  onDecide,
}: {
  row: ReportRow;
  decision: string;
  labels: Record<string, string>;
  onDecide: (decision: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const match = row.company?.match;
  const level = row.duplicate_of ? "duplicate" : (match?.level ?? "none");
  const skipped = decision === "skip";
  return (
    <div className="border-b border-hairline last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={t("Show values")}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown
              size={14}
              strokeWidth={1.75}
              className="shrink-0 text-muted"
            />
          ) : (
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              className="shrink-0 text-muted"
            />
          )}
          <span className="min-w-0">
            <span
              className={`block truncate text-[14px] font-medium ${skipped ? "text-faint line-through" : ""}`}
            >
              {row.company?.label ?? row.person?.label ?? "–"}
            </span>
            <span className="block truncate text-[12.5px] text-muted">
              {t("Row {n}", { n: row.row })} · {t(MATCH_TEXT[level])}
              {match?.label && level !== "none" && level !== "duplicate"
                ? ` · ${match.label} (${match.reason})`
                : ""}
              {row.duplicate_of
                ? ` · ${t("same as {row}", { row: row.duplicate_of })}`
                : ""}
              {row.person?.label
                ? ` · ${t("Contact")}: ${row.person.label} (${t(row.person.match.level === "none" ? "New contact" : MATCH_TEXT[row.person.match.level])})`
                : ""}
            </span>
            {row.errors.length > 0 && (
              <span className="block truncate text-[12.5px] text-bad">
                {row.errors.join("; ")}
              </span>
            )}
          </span>
        </button>
        {row.company ? (
          <select
            value={decision}
            onChange={(e) => onDecide(e.target.value)}
            aria-label={t("Decision for row {n}", { n: row.row })}
            className={`${FIELD} w-[210px] shrink-0`}
          >
            <option value="new">{t("Create a new company")}</option>
            {match?.entity_id && (
              <option value={match.entity_id}>
                {t("Merge into {name}", { name: match.label ?? "–" })}
              </option>
            )}
            {row.duplicate_of && (
              <option value={`dup:${row.duplicate_of}`}>
                {t("Same as {row}", { row: row.duplicate_of })}
              </option>
            )}
            <option value="skip">{t("Skip this row")}</option>
          </select>
        ) : (
          <span className="shrink-0 text-[12.5px] text-muted">
            {skipped ? t("Skipped") : "–"}
          </span>
        )}
      </div>
      {open && (
        <table className="mb-2 ml-[38px] w-[calc(100%-54px)] text-[12.5px]">
          <thead className="text-muted">
            <tr>
              <th className="py-1 text-left font-normal">{t("Data point")}</th>
              <th className="py-1 text-left font-normal">{t("Imported as")}</th>
              <th className="py-1 text-right font-normal">{t("Quality")}</th>
              <th className="py-1 pl-4 text-left font-normal">
                {t("Against the shown value")}
              </th>
            </tr>
          </thead>
          <tbody>
            {row.cells.map((c, i) => (
              <tr key={`${c.field}${i}`} className="align-top">
                <td className="py-1 pr-3">
                  {labels[c.field] ?? c.field}
                  {c.period ? ` ${c.period}` : ""}
                  {c.derived && (
                    <span className="text-muted"> ({t("derived")})</span>
                  )}
                </td>
                <td
                  className={`max-w-[200px] truncate py-1 pr-3 ${c.error ? "text-bad" : ""}`}
                  title={c.raw}
                >
                  {c.error ?? show(c.value)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {c.score ?? "–"}
                </td>
                <td className="py-1 pl-4 text-muted">
                  {c.vs === "wins"
                    ? t("Replaces “{value}” ({score})", {
                        value: show(c.current),
                        score: c.current_score ?? "–",
                      })
                    : c.vs === "loses"
                      ? t("“{value}” ({score}) stays; kept as another source", {
                          value: show(c.current),
                          score: c.current_score ?? "–",
                        })
                      : c.vs === "same"
                        ? t("Same value (adds a source)")
                        : c.vs === "new"
                          ? t("New")
                          : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        {/* One baseline for the title and its note (sizes differ). */}
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[14px] font-medium">{title}</span>
          {aside && (
            <span className="min-w-0 truncate text-[13px] text-muted">
              {aside}
            </span>
          )}
        </span>
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

function Done({ data, onClose }: { data: ImportDetail; onClose: () => void }) {
  const { t } = useI18n();
  const list = isListReport(data.report) ? data.report : null;
  useSubmitShortcut(onClose);
  return (
    <div className="flex flex-col items-center px-4 pt-12 pb-8 text-center">
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
      <button
        type="button"
        onClick={onClose}
        className={`${modalPrimary} mt-6 flex h-9 items-center px-5`}
      >
        {t("Done")}
        <ShortcutHint />
      </button>
    </div>
  );
}
