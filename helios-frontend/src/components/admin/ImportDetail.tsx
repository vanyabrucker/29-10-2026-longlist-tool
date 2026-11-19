"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  RefreshCw,
  X,
} from "react-feather";
import {
  gw,
  json,
  RUNNING,
  show,
  type Catalogue,
  type ImportDetail as Detail,
  type Report,
  type ReportRow,
  type SourceType,
  type Table,
} from "@/lib/gateway";
import type { LonglistSummary } from "@/lib/longlists";
import { ImportModal } from "../ImportModal";
import {
  Button,
  Notice,
  Page,
  Section,
  StatusPill,
  formatEta,
  InfoTip,
  inputClass,
  td,
  th,
} from "./ui";

const ENTITY_LABEL: Record<string, string> = {
  company: "Company",
  person: "Person",
  role: "Role (person at company)",
  transaction: "Transaction",
  project_ref: "Project reference",
  list_entry: "Longlist entry",
};

export function ImportDetailPanel({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [sources, setSources] = useState<SourceType[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await gw<Detail>(`/imports/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    gw<Catalogue>("/catalogue").then(setCatalogue, () => {});
    gw<SourceType[]>("/source-types").then(setSources, () => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Poll while a step runs in the background.
  const running = !!data && RUNNING.includes(data.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [running, load]);

  async function act(path: string, init?: RequestInit) {
    try {
      await gw(`/imports/${id}${path}`, init);
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!data)
    return (
      <Page title="Import" back={{ href: "/admin/imports", label: "Imports" }}>
        {error ? <Notice tone="error">{error}</Notice> : <Loading />}
      </Page>
    );
  if (data.target === "list") return <ListImport data={data} onChange={load} />;

  return (
    <Page
      title={data.filename}
      back={{ href: "/admin/imports", label: "Imports" }}
      actions={
        <>
          <a
            href={`/api/gateway/documents/${data.document_id}/file`}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13.5px] font-medium transition-colors hover:bg-subtle"
          >
            <Download size={14} strokeWidth={1.75} />
            Original file
          </a>
          {!["committed", "committing", "cancelled"].includes(data.status) && (
            <Button
              variant="ghost"
              onClick={() => act("/cancel", { method: "POST" })}
            >
              Cancel import
            </Button>
          )}
        </>
      }
    >
      <Steps
        data={data}
        onBackToMapping={
          data.status === "report_review"
            ? () =>
                act("/tables", {
                  method: "PUT",
                  ...json(unchanged(data.tables)),
                })
            : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
        {data.status === "cancelled" && <StatusPill status={data.status} />}
        <span>
          by {data.created_by} · catalogue {data.catalogue_version}
        </span>
        {data.version_id && (
          <span className="font-medium text-ink">
            Version v{data.version_id}
          </span>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {data.status === "failed" && data.error && (
        <Notice tone="error">
          <p>{data.error}</p>
          <div className="mt-2 flex gap-2">
            {data.tables.length > 0 ? (
              <Button onClick={() => act("/report", { method: "POST" })}>
                Build the report again
              </Button>
            ) : null}
          </div>
        </Notice>
      )}
      {data.warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}

      {running && <ProgressBar data={data} />}

      {!running &&
        ["mapping_review", "report_review", "failed"].includes(data.status) && (
          <SettingsBar
            data={data}
            sources={sources}
            onSave={(body) => act("", { method: "PATCH", ...json(body) })}
          />
        )}

      {!running && data.status === "mapping_review" && catalogue && (
        <MappingReview
          data={data}
          catalogue={catalogue}
          onSave={(tables) =>
            act("/tables", { method: "PUT", ...json(tables) })
          }
          onFeedback={(text) =>
            act("/feedback", { method: "POST", ...json({ text }) })
          }
          onReport={() => act("/report", { method: "POST" })}
        />
      )}

      {!running && data.status === "report_review" && data.report && (
        <ReportReview
          data={data}
          onDecide={(decisions) =>
            act("/decisions", { method: "PUT", ...json({ decisions }) })
          }
          onBack={() =>
            act("/tables", { method: "PUT", ...json(unchanged(data.tables)) })
          }
          onCommit={() => act("/commit", { method: "POST" })}
        />
      )}

      {data.status === "committed" && data.report && (
        <Section title="Committed">
          <p className="text-[14px]">
            Imported as version v{data.version_id}. Revert it from the version
            history on the{" "}
            <Link
              href="/admin/imports"
              className="underline underline-offset-[3px]"
            >
              Imports
            </Link>{" "}
            page; see the result under{" "}
            <Link
              href="/admin/master"
              className="underline underline-offset-[3px]"
            >
              Master data
            </Link>
            .
          </p>
          <Summary report={data.report as Report} />
        </Section>
      )}
    </Page>
  );
}

/** A list import (anyone's) seen from the admin area: its state, and the
 * import dialog to review or commit it. */
function ListImport({
  data,
  onChange,
}: {
  data: Detail;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Page
      title={data.filename}
      back={{ href: "/admin/imports", label: "Imports" }}
      actions={
        data.status === "mapping_review" || data.status === "report_review" ? (
          <Button variant="primary" onClick={() => setOpen(true)}>
            Open review
          </Button>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
        <StatusPill status={data.status} />
        <span>
          List import by {data.created_by}
          {data.new_list_name ? ` · new list “${data.new_list_name}”` : ""}
          {data.list_version ? ` · list version ${data.list_version}` : ""}
          {data.export_id ? " · from a Helios export" : ""}
        </span>
        {data.list_id && (
          <Link
            href={`/longlists/${data.list_id}`}
            className="text-ink underline underline-offset-[3px]"
          >
            Open the list
          </Link>
        )}
      </div>
      {data.error && <Notice tone="error">{data.error}</Notice>}
      <ImportModal
        open={open}
        importId={data.id}
        cancelOnClose={false}
        target={{ kind: "list", listId: data.list_id }}
        onClose={() => {
          setOpen(false);
          onChange();
        }}
      />
    </Page>
  );
}

const STEPS = ["Upload", "Map columns", "Review", "Import"] as const;

// Where the import stands: the step index, and whether that step is still
// working, waiting for the dev, done or failed.
function stepOf(data: Detail): {
  at: number;
  state: "working" | "waiting" | "done" | "failed";
} {
  switch (data.status) {
    case "uploaded":
    case "analysing":
      return { at: 0, state: "working" };
    case "remapping":
      return { at: 1, state: "working" };
    case "mapping_review":
      return { at: 1, state: "waiting" };
    case "building_report":
      return { at: 2, state: "working" };
    case "report_review":
      return { at: 2, state: "waiting" };
    case "committing":
      return { at: 3, state: "working" };
    case "committed":
      return { at: 3, state: "done" };
    case "failed":
      return {
        at: data.report ? 3 : data.tables.length ? 2 : 0,
        state: "failed",
      };
    default:
      return { at: 1, state: "waiting" };
  }
}

/** Upload → Map columns → Review → Import, like other import flows: done
 * steps get a check, the current one is black, later ones grey. During
 * review, "Map columns" goes back to the mapping. */
function Steps({
  data,
  onBackToMapping,
}: {
  data: Detail;
  onBackToMapping?: () => void;
}) {
  const { at, state } = stepOf(data);
  return (
    <ol className="flex items-center gap-3 rounded-2xl border border-line px-5 py-3.5">
      {STEPS.map((label, i) => {
        const done = i < at || (i === at && state === "done");
        const current = i === at && state !== "done";
        const failed = current && state === "failed";
        const back = i === 1 && onBackToMapping;
        const content = (
          <>
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-medium tabular-nums ${
                failed
                  ? "bg-bad text-white"
                  : done || current
                    ? "bg-ink text-white"
                    : "border border-line text-faint"
              }`}
            >
              {failed ? (
                <X size={13} strokeWidth={2.5} />
              ) : done ? (
                <Check size={13} strokeWidth={2.5} />
              ) : (
                i + 1
              )}
            </span>
            <span className="flex flex-col text-left leading-tight">
              <span
                className={`text-[14px] ${current ? "font-medium text-ink" : done ? "text-ink" : "text-faint"}`}
              >
                {label}
              </span>
              {current && (
                <span className="mt-0.5 text-[12px] text-muted">
                  {state === "working"
                    ? "Working…"
                    : state === "failed"
                      ? "Failed"
                      : "Your turn"}
                </span>
              )}
            </span>
          </>
        );
        return (
          <li
            key={label}
            className="flex min-w-0 flex-1 items-center gap-3 last:flex-none"
          >
            {back ? (
              <button
                type="button"
                onClick={onBackToMapping}
                className="-mx-2 flex items-center gap-2.5 rounded-full px-2 py-1 transition-colors hover:bg-subtle"
              >
                {content}
              </button>
            ) : (
              <span className="flex items-center gap-2.5">{content}</span>
            )}
            {i < STEPS.length - 1 && (
              <span
                className={`h-px min-w-6 flex-1 ${i < at ? "bg-ink" : "bg-line"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function unchanged(tables: Table[]) {
  return tables.map((t) => ({
    include: t.include,
    columns: t.columns.map((c) => ({
      letter: c.letter,
      field: c.field,
      period: c.period,
    })),
  }));
}

function Loading() {
  return <p className="text-[13.5px] text-muted">Loading…</p>;
}

function ProgressBar({ data }: { data: Detail }) {
  return (
    <div className="rounded-xl border border-line px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-4 text-[13.5px]">
        <span>{data.step ?? "Starting"}</span>
        <span className="text-muted tabular-nums">
          {Math.round(data.progress * 100)}% · {formatEta(data.eta_seconds)}
        </span>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-subtle">
        <div
          className="h-full rounded-full bg-sky-ink transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(3, data.progress * 100)}%` }}
        />
      </div>
    </div>
  );
}

function SettingsBar({
  data,
  sources,
  onSave,
}: {
  data: Detail;
  sources: SourceType[];
  onSave: (body: Record<string, unknown>) => void;
}) {
  return (
    <Section
      title="Import settings"
      aside="Source confidence and the as-of date drive each value's quality score."
    >
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-line px-4 py-3 text-[13px]">
        <label className="flex flex-col gap-1 text-muted">
          Source
          <select
            value={data.source_type}
            onChange={(e) => onSave({ source_type: e.target.value })}
            className={`${inputClass} text-ink`}
          >
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label} ({s.confidence})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted">
          Data as of
          <input
            type="date"
            value={data.as_of ?? ""}
            onChange={(e) =>
              e.target.value && onSave({ as_of: e.target.value })
            }
            className={`${inputClass} text-ink`}
          />
        </label>
        <LonglistSetting data={data} onSave={onSave} />
      </div>
    </Section>
  );
}

/** Optionally put the imported companies on a longlist: an existing one or
 * a new one (named here). The list gets them as one new version. */
function LonglistSetting({
  data,
  onSave,
}: {
  data: Detail;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [lists, setLists] = useState<LonglistSummary[]>([]);
  const [creating, setCreating] = useState(!!data.new_list_name);
  useEffect(() => {
    gw<LonglistSummary[]>("/longlists").then(setLists, () => {});
  }, []);
  const value = data.list_id ?? (creating ? "new" : "");
  return (
    <>
      <label className="flex flex-col gap-1 text-muted">
        Longlist
        <select
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setCreating(next === "new");
            if (next === "new") onSave({ list_id: null });
            else onSave({ list_id: next || null, new_list_name: null });
          }}
          className={`${inputClass} max-w-[260px] text-ink`}
        >
          <option value="">None</option>
          <option value="new">New list…</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      {creating && !data.list_id && (
        <label className="flex flex-col gap-1 text-muted">
          New list name
          <input
            defaultValue={data.new_list_name ?? ""}
            placeholder="e.g. Project Cedar – Buyers"
            onBlur={(e) => onSave({ new_list_name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className={`${inputClass} w-[240px] text-ink`}
          />
        </label>
      )}
    </>
  );
}

function MappingReview({
  data,
  catalogue,
  onSave,
  onFeedback,
  onReport,
}: {
  data: Detail;
  catalogue: Catalogue;
  onSave: (tables: ReturnType<typeof unchanged>) => Promise<void>;
  onFeedback: (text: string) => void;
  onReport: () => void;
}) {
  // Local copy of the dev's edits; saved before re-mapping or reporting.
  const [edits, setEdits] = useState(() =>
    data.tables.map((t) => ({
      include: t.include,
      header_row: t.header_row,
      first_data_row: t.first_data_row,
      last_row: t.last_row,
      columns: t.columns.map((c) => ({
        letter: c.letter,
        field: c.field,
        period: c.period,
      })),
    })),
  );
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState("");
  const grouped = useMemo(() => {
    const groups: Record<string, Catalogue["points"]> = {};
    for (const p of catalogue.points) (groups[p.entity] ??= []).push(p);
    return groups;
  }, [catalogue]);
  const labels = useMemo(
    () => Object.fromEntries(catalogue.points.map((p) => [p.key, p.label])),
    [catalogue],
  );

  function update(ti: number, patch: Partial<(typeof edits)[number]>) {
    setEdits((e) => e.map((t, i) => (i === ti ? { ...t, ...patch } : t)));
    setDirty(true);
  }
  function setField(ti: number, letter: string, field: string | null) {
    setEdits((e) =>
      e.map((t, i) =>
        i !== ti
          ? t
          : {
              ...t,
              columns: t.columns.map((c) =>
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

  return (
    <>
      {data.tables.map((t, ti) => (
        <Section
          key={ti}
          title={`${t.sheet}${t.title ? ` · ${t.title}` : ""}`}
          aside={`${t.row_count} rows`}
        >
          <div className="rounded-xl border border-line">
            <div className="flex flex-wrap items-center gap-4 border-b border-line px-4 py-2.5 text-[13px]">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={edits[ti].include}
                  onChange={(e) => update(ti, { include: e.target.checked })}
                  className="size-4 accent-ink"
                />
                Import this table
              </label>
              {(["header_row", "first_data_row", "last_row"] as const).map(
                (k) => (
                  <label
                    key={k}
                    className="flex items-center gap-1.5 text-muted"
                  >
                    {k === "header_row"
                      ? "Header row"
                      : k === "first_data_row"
                        ? "Data from row"
                        : "to row"}
                    <input
                      type="number"
                      min={1}
                      value={edits[ti][k]}
                      onChange={(e) =>
                        update(ti, { [k]: Number(e.target.value) })
                      }
                      className={`${inputClass} w-[72px] text-ink`}
                    />
                  </label>
                ),
              )}
              {t.formula_gaps && t.formula_gaps.length > 0 && (
                <span className="text-muted">
                  Formulas without a saved result: {t.formula_gaps.join(", ")}
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={`${th} w-12`}>Row</th>
                    {t.columns.map((c) => {
                      const edit = edits[ti].columns.find(
                        (x) => x.letter === c.letter,
                      );
                      return (
                        <th
                          key={c.letter}
                          className={`${th} min-w-[190px] align-top`}
                        >
                          <div className="flex items-center gap-1 font-medium text-ink">
                            <span className="min-w-0 truncate">
                              {c.letter} · {c.header}
                            </span>
                            <InfoTip
                              label="Why the LLM suggested this"
                              marked={!!c.changed_from}
                            >
                              <span className="block font-medium">
                                {c.suggested_field
                                  ? `LLM: ${labels[c.suggested_field] ?? c.suggested_field}${c.period ? ` ${c.period}` : ""} (${Math.round((c.confidence ?? 0) * 100)}%)`
                                  : "LLM: no match"}
                              </span>
                              {c.reason && (
                                <span className="mt-0.5 block text-white/75">
                                  {c.reason}
                                </span>
                              )}
                              {c.changed_from && (
                                <span className="mt-0.5 block text-white/75">
                                  Changed by your feedback; was{" "}
                                  {labels[c.changed_from] ?? "not imported"}.
                                </span>
                              )}
                            </InfoTip>
                          </div>
                          <select
                            value={edit?.field ?? ""}
                            onChange={(e) =>
                              setField(ti, c.letter, e.target.value || null)
                            }
                            className={`${inputClass} mt-1.5 w-full text-ink ${edit?.field ? "" : "text-muted"}`}
                          >
                            <option value="">Not imported</option>
                            {Object.entries(grouped).map(([entity, points]) => (
                              <optgroup
                                key={entity}
                                label={ENTITY_LABEL[entity] ?? entity}
                              >
                                {points.map((p) => (
                                  <option key={p.key} value={p.key}>
                                    {p.label}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {t.preview.map((r) => (
                    <tr key={r.row}>
                      <td className={`${td} text-faint tabular-nums`}>
                        {r.row}
                      </td>
                      {t.columns.map((c) => (
                        <td
                          key={c.letter}
                          className={`${td} max-w-[240px] truncate`}
                        >
                          {r.cells[c.index] === null ||
                          r.cells[c.index] === undefined
                            ? ""
                            : String(r.cells[c.index])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {t.row_count > t.preview.length && (
              <p className="px-4 py-2 text-[12.5px] text-muted">
                Showing the first {t.preview.length} of {t.row_count} rows.
              </p>
            )}
            {t.notes && (
              <p className="border-t border-line px-4 py-2 text-[12.5px] text-muted">
                LLM notes: {t.notes}
              </p>
            )}
          </div>
        </Section>
      ))}

      {/* One card: feedback that re-runs the mapping, then confirm. */}
      <div className="rounded-2xl border border-line px-6 pt-5 pb-5">
        <h2 className="text-[16px] font-medium">Feedback</h2>
        <p className="mt-1.5 text-[14px] text-muted">
          Check the suggested column mappings. You can correct the LLM if it
          misunderstood your data.
        </p>

        <div className="mt-5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[14px] font-medium">
              Corrections or additional context
            </span>
            <span className="rounded-full bg-subtle px-2 py-0.5 text-[12px] text-muted">
              Optional
            </span>
          </div>
          {data.feedback.length > 0 && (
            <ul className="mt-2.5 space-y-1 text-[13px] text-muted">
              {data.feedback.map((f) => (
                <li key={f.at}>
                  “{f.text}” — {f.by}
                </li>
              ))}
            </ul>
          )}
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. Column F contains EBITDA, not revenue. The Strategics sheet has no investors."
            rows={3}
            className="mt-3 block w-full resize-y rounded-xl border border-line bg-subtle px-3.5 py-3 text-[14px] outline-none placeholder:text-faint focus:border-[#c9d9ef] focus:bg-white focus:ring-3 focus:ring-sky"
          />
        </div>

        {/* Re-run (with the feedback) sits left of Confirm, same height. */}
        <div className="mt-5 flex items-center justify-end gap-2">
          {dirty && (
            <Button
              variant="ghost"
              className="h-10 px-4 text-[14px]"
              onClick={save}
            >
              Save changes
            </Button>
          )}
          <Button
            className="h-10 px-5 text-[14px]"
            disabled={!feedback.trim()}
            onClick={async () => {
              if (dirty) await save();
              onFeedback(feedback);
              setFeedback("");
            }}
          >
            <RefreshCw size={14} strokeWidth={1.75} />
            Re-run mapping
          </Button>
          <Button
            variant="primary"
            className="h-10 px-5 text-[14px]"
            onClick={async () => {
              if (dirty) await save();
              onReport();
            }}
          >
            Confirm mapping
            <ArrowRight size={15} strokeWidth={2} />
          </Button>
        </div>
      </div>
    </>
  );
}

const LEVEL_TEXT: Record<string, string> = {
  certain: "Certain match",
  likely: "Likely match",
  suggestion: "Possible match",
  none: "New",
  duplicate: "Duplicate in file",
};

function Summary({ report }: { report: Report }) {
  const s = report.summary;
  const tiles: [string, React.ReactNode][] = [
    ["Rows", s.rows],
    ["Rows with errors", s.rows_with_errors],
    [
      "Companies",
      Object.entries(s.companies)
        .map(([k, n]) => `${n} ${LEVEL_TEXT[k]?.toLowerCase() ?? k}`)
        .join(" · ") || "–",
    ],
    [
      "People",
      Object.entries(s.people)
        .map(([k, n]) => `${n} ${LEVEL_TEXT[k]?.toLowerCase() ?? k}`)
        .join(" · ") || "–",
    ],
    [
      "Values vs shown values",
      Object.entries(s.values)
        .map(([k, n]) => `${n} ${k}`)
        .join(" · ") || "–",
    ],
    [
      "Incoming quality",
      Object.entries(s.quality)
        .map(([k, n]) => `${n} ${k}`)
        .join(" · ") || "–",
    ],
  ];
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3">
      {tiles.map(([label, value]) => (
        <div
          key={label}
          className="rounded-xl border border-line px-3.5 py-2.5"
        >
          <div className="text-[12px] text-muted">{label}</div>
          <div className="mt-0.5 text-[14px]">{value}</div>
        </div>
      ))}
    </div>
  );
}

type Filter = "all" | "errors" | "matches" | "duplicates" | "conflicts";

function ReportReview({
  data,
  onDecide,
  onBack,
  onCommit,
}: {
  data: Detail;
  onDecide: (d: Record<string, string>) => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const report = data.report as Report;
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const decisions = {
    ...Object.fromEntries(report.rows.map((r) => [r.key, r.decision])),
    ...data.decisions,
  };
  const rows = report.rows.filter((r) =>
    filter === "errors"
      ? r.errors.length > 0
      : filter === "matches"
        ? r.company && r.company.match.level !== "none"
        : filter === "duplicates"
          ? !!r.duplicate_of
          : filter === "conflicts"
            ? r.cells.some((c) => c.vs === "wins" || c.vs === "loses")
            : true,
  );
  const included = report.rows.filter(
    (r) => decisions[r.key] !== "skip",
  ).length;

  return (
    <>
      {report.notice && <Notice tone="warn">{report.notice}</Notice>}
      <Section title="Review before import">
        <Summary report={report} />
      </Section>

      {report.unmapped_columns.length > 0 && (
        <Section title="Columns that won't be imported">
          <ul className="space-y-1 text-[13px]">
            {report.unmapped_columns.map((u) => (
              <li key={`${u.table}${u.letter}`}>
                <span className="font-medium">
                  {u.sheet} {u.letter} · {u.header}
                </span>{" "}
                <span className="text-muted">
                  e.g. {u.samples.join(", ") || "(empty)"}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Rows"
        aside={`${included} of ${report.rows.length} rows will be imported`}
      >
        <div className="mb-2 flex gap-1">
          {(
            ["all", "errors", "matches", "duplicates", "conflicts"] as Filter[]
          ).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`h-7 rounded-full px-3 text-[13px] capitalize transition-colors ${filter === f ? "bg-subtle font-medium" : "text-muted hover:text-ink"}`}
            >
              {f}
            </button>
          ))}
        </div>
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className={`${th} w-6`} />
              <th className={th}>Row</th>
              <th className={th}>Company</th>
              <th className={th}>Match</th>
              <th className={th}>Decision</th>
              <th className={th}>Contact</th>
              <th className={th}>Problems</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <RowView
                key={r.key}
                row={r}
                decision={decisions[r.key]}
                open={open.has(r.key)}
                onToggle={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(r.key)) n.delete(r.key);
                    else n.add(r.key);
                    return n;
                  })
                }
                onDecide={(d) => onDecide({ [r.key]: d })}
              />
            ))}
          </tbody>
        </table>
      </Section>

      <div className="flex justify-end gap-2">
        <Button onClick={onBack}>Back to mapping</Button>
        <Button variant="primary" onClick={onCommit} disabled={included === 0}>
          Import {included} rows
        </Button>
      </div>
    </>
  );
}

function RowView({
  row,
  decision,
  open,
  onToggle,
  onDecide,
}: {
  row: ReportRow;
  decision: string;
  open: boolean;
  onToggle: () => void;
  onDecide: (d: string) => void;
}) {
  const match = row.company?.match;
  const level = row.duplicate_of ? "duplicate" : (match?.level ?? "none");
  return (
    <>
      <tr className="transition-colors hover:bg-canvas">
        <td className={td}>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Show values"
            className="text-muted hover:text-ink"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td className={`${td} whitespace-nowrap text-muted tabular-nums`}>
          {row.sheet} · {row.row}
        </td>
        <td className={`${td} max-w-[260px] truncate font-medium`}>
          {row.company?.label ?? "–"}
        </td>
        <td className={`${td} text-muted`}>
          {LEVEL_TEXT[level]}
          {match?.label && level !== "none" && level !== "duplicate" && (
            <div className="text-[12px]">
              {match.label} · {match.reason}
            </div>
          )}
          {row.duplicate_of && (
            <div className="text-[12px]">same as {row.duplicate_of}</div>
          )}
        </td>
        <td className={td}>
          {row.company ? (
            <select
              value={decision}
              onChange={(e) => onDecide(e.target.value)}
              className={`${inputClass} max-w-[220px]`}
            >
              <option value="new">Create a new company</option>
              {match?.entity_id && (
                <option value={match.entity_id}>
                  Merge into {match.label}
                </option>
              )}
              {row.duplicate_of && (
                <option value={`dup:${row.duplicate_of}`}>
                  Same as {row.duplicate_of}
                </option>
              )}
              <option value="skip">Skip this row</option>
            </select>
          ) : (
            <span className="text-muted">
              {decision === "skip" ? "Skipped" : "–"}
            </span>
          )}
        </td>
        <td className={`${td} text-muted`}>
          {row.person ? (
            <>
              {row.person.label || "–"}
              <div className="text-[12px]">
                {LEVEL_TEXT[row.person.match.level]}
              </div>
            </>
          ) : (
            "–"
          )}
        </td>
        <td className={`${td} max-w-[280px] text-bad`}>
          {row.errors.map((e) => (
            <div key={e} className="text-[12.5px]">
              {e}
            </div>
          ))}
        </td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={6} className="border-b border-hairline px-3 pb-3">
            <table className="w-full text-[12.5px]">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 text-left font-normal">Data point</th>
                  <th className="py-1 text-left font-normal">In the file</th>
                  <th className="py-1 text-left font-normal">Imported as</th>
                  <th className="py-1 text-right font-normal">Quality</th>
                  <th className="py-1 pl-4 text-left font-normal">
                    Against the shown value
                  </th>
                </tr>
              </thead>
              <tbody>
                {row.cells.map((c, i) => (
                  <tr key={`${c.field}${i}`}>
                    <td className="py-1">
                      {c.field}
                      {c.period ? ` ${c.period}` : ""}
                      {c.derived && (
                        <span className="text-muted"> (derived)</span>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate py-1 text-muted">
                      {c.raw}
                    </td>
                    <td className={`py-1 ${c.error ? "text-bad" : ""}`}>
                      {c.error ?? show(c.value)}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {c.score ?? "–"}
                    </td>
                    <td className="py-1 pl-4 text-muted">
                      {c.vs === "wins"
                        ? `Wins over “${show(c.current)}” (${c.current_score})`
                        : c.vs === "loses"
                          ? `Stays “${show(c.current)}” (${c.current_score}); kept as a second source`
                          : c.vs === "same"
                            ? "Same value (adds a source)"
                            : c.vs === "new"
                              ? "New"
                              : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
