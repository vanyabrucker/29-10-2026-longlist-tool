"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download } from "react-feather";
import {
  gw,
  json,
  RUNNING,
  show,
  type Catalogue,
  type ImportDetail as Detail,
  type ReportRow,
  type SourceType,
  type Table,
} from "@/lib/gateway";
import {
  Button,
  Notice,
  Page,
  Section,
  StatusPill,
  formatEta,
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
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
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
    gw<{ id: string; name: string }[]>("/longlists").then(setLists, () => {});
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

  return (
    <Page
      title={data.filename}
      back={{ href: "/admin/imports", label: "Imports" }}
      actions={
        <>
          <a
            href={`/api/gateway/documents/${data.document_id}/file`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13.5px] font-medium transition-colors hover:bg-subtle"
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
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
        <StatusPill status={data.status} />
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
            lists={lists}
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
          <Summary report={data.report} />
        </Section>
      )}
    </Page>
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
  lists,
  onSave,
}: {
  data: Detail;
  sources: SourceType[];
  lists: { id: string; name: string }[];
  onSave: (body: Record<string, unknown>) => void;
}) {
  const target = data.list_id ?? (data.new_list_name ? "new" : "");
  const [newName, setNewName] = useState(data.new_list_name ?? "");
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
        <label className="flex flex-col gap-1 text-muted">
          Also add rows to a longlist
          <select
            value={target}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "new")
                onSave({
                  list_id: null,
                  new_list_name:
                    newName || data.filename.replace(/\.[^.]+$/, ""),
                });
              else onSave({ list_id: v || null, new_list_name: null });
            }}
            className={`${inputClass} text-ink`}
          >
            <option value="">No longlist</option>
            <option value="new">New longlist…</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {target === "new" && (
          <label className="flex flex-col gap-1 text-muted">
            New longlist name
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => newName && onSave({ new_list_name: newName })}
              className={`${inputClass} w-[220px] text-ink`}
            />
          </label>
        )}
      </div>
    </Section>
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
                          <div className="font-medium text-ink">
                            {c.letter} · {c.header}
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
                          <div className="mt-1 text-[11.5px] leading-snug font-normal whitespace-normal text-muted">
                            {c.suggested_field
                              ? `LLM: ${labels[c.suggested_field] ?? c.suggested_field}${c.period ? ` ${c.period}` : ""} (${Math.round((c.confidence ?? 0) * 100)}%)`
                              : "LLM: no match"}
                            {c.changed_from !== undefined &&
                              c.changed_from !== null && (
                                <span className="text-ink">
                                  {" "}
                                  · was{" "}
                                  {labels[c.changed_from] ?? "not imported"}
                                </span>
                              )}
                            {c.reason && (
                              <div className="text-faint">{c.reason}</div>
                            )}
                          </div>
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

      <Section
        title="Feedback for the LLM"
        aside="Re-runs the column mapping with your note; changes are marked."
      >
        {data.feedback.length > 0 && (
          <ul className="mb-2 space-y-1 text-[13px] text-muted">
            {data.feedback.map((f) => (
              <li key={f.at}>
                “{f.text}” — {f.by}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. Column F is EBITDA, not revenue. The Strategics sheet has no investors."
            rows={2}
            className="min-w-0 flex-1 resize-y rounded-lg border border-line px-3 py-2 text-[13.5px] outline-none focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky"
          />
          <Button
            disabled={!feedback.trim()}
            onClick={async () => {
              if (dirty) await save();
              onFeedback(feedback);
              setFeedback("");
            }}
          >
            Re-run mapping
          </Button>
        </div>
      </Section>

      <div className="flex justify-end gap-2">
        {dirty && <Button onClick={save}>Save changes</Button>}
        <Button
          variant="primary"
          onClick={async () => {
            if (dirty) await save();
            onReport();
          }}
        >
          Confirm mapping and build report
        </Button>
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

function Summary({ report }: { report: NonNullable<Detail["report"]> }) {
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
  const report = data.report!;
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
              className={`h-7 rounded-lg px-2.5 text-[13px] capitalize transition-colors ${filter === f ? "bg-subtle font-medium" : "text-muted hover:text-ink"}`}
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
