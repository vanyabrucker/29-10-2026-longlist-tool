"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Download } from "react-feather";
import {
  gw,
  isListReport,
  RUNNING,
  type ImportDetail as Detail,
  type Report,
  type SourceType,
} from "@/lib/gateway";
import { ImportModal } from "../ImportModal";
import { Button, Notice, Page, Section, StatusPill, formatEta } from "./ui";

const REVIEWABLE = ["mapping_review", "report_review"];

/** One import, corpus or list, as history: its state, settings and outcome.
 * The review itself happens in the import dialog ("Open review" while the
 * import waits for a reviewer). */
export function ImportDetailPanel({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [sources, setSources] = useState<SourceType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await gw<Detail>(`/imports/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    gw<SourceType[]>("/source-types").then(setSources, () => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const running = !!data && RUNNING.includes(data.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [running, load]);

  async function cancel() {
    try {
      await gw(`/imports/${id}/cancel`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!data)
    return (
      <Page title="Import" back={{ href: "/admin/imports", label: "Imports" }}>
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : (
          <p className="text-[13.5px] text-muted">Loading…</p>
        )}
      </Page>
    );

  const isList = data.target === "list";
  const source =
    (sources.find((s) => s.key === data.source_type)?.label ??
      data.source_type) +
    (data.source_type === "other" && data.source_note
      ? ` (“${data.source_note}”)`
      : "");
  const facts: [string, React.ReactNode][] = [
    ["Into", isList ? listTarget(data) : "Corpus"],
    ["By", data.created_by],
    [
      "Source",
      data.export_id
        ? "A Helios export"
        : `${source}${data.source_by && data.source_by !== data.created_by ? ` (named by ${data.source_by})` : ""}`,
    ],
    ["Data as of", data.as_of ?? "–"],
    ["Catalogue", data.catalogue_version],
    [
      "Version",
      isList
        ? data.list_version
          ? `List version ${data.list_version}`
          : "–"
        : data.version_id
          ? `v${data.version_id}`
          : "–",
    ],
  ];

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
          {REVIEWABLE.includes(data.status) && (
            <>
              <Button variant="ghost" onClick={cancel}>
                Cancel import
              </Button>
              <Button variant="primary" onClick={() => setOpen(true)}>
                Open review
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
        <StatusPill status={data.status} />
        {data.list_id && (
          <Link
            href={`/longlists/${data.list_id}`}
            className="text-ink underline underline-offset-[3px]"
          >
            Open the list
          </Link>
        )}
        {!isList && data.status === "committed" && (
          <span>
            Revert it from the version history on the{" "}
            <Link
              href="/admin/imports"
              className="text-ink underline underline-offset-[3px]"
            >
              Imports
            </Link>{" "}
            page.
          </span>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {data.error && <Notice tone="error">{data.error}</Notice>}
      {data.warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}

      {running && (
        <div className="rounded-xl border border-line px-4 py-3.5 text-[13.5px]">
          <div className="flex items-baseline justify-between gap-4">
            <span>{data.step ?? "Starting"}</span>
            <span className="text-muted tabular-nums">
              {Math.round(data.progress * 100)}% · {formatEta(data.eta_seconds)}
            </span>
          </div>
        </div>
      )}

      <Section title="Details">
        <Tiles items={facts} />
      </Section>

      {data.report && !isListReport(data.report) && (
        <Section title="Report">
          <Tiles items={corpusSummary(data.report)} />
        </Section>
      )}
      {data.report?.totals && isListReport(data.report) && (
        <Section title="Report">
          <Tiles
            items={[
              ["New rows", data.report.totals.new_rows],
              ["Changed cells", data.report.totals.changed_cells],
              ["Conflicts", data.report.totals.conflicts],
              ["Errors", data.report.totals.errors],
            ]}
          />
        </Section>
      )}

      <ImportModal
        open={open}
        importId={data.id}
        cancelOnClose={false}
        target={
          isList ? { kind: "list", listId: data.list_id } : { kind: "corpus" }
        }
        onClose={() => {
          setOpen(false);
          load();
        }}
      />
    </Page>
  );
}

function listTarget(data: Detail) {
  const name = data.list_name ?? data.new_list_name;
  return `${data.list_id ? "Longlist" : "New longlist"}${name ? ` “${name}”` : ""}`;
}

const LEVEL_TEXT: Record<string, string> = {
  certain: "certain",
  likely: "likely",
  suggestion: "possible",
  none: "new",
  duplicate: "duplicate",
};

function corpusSummary(report: Report): [string, React.ReactNode][] {
  const s = report.summary;
  const join = (o: Record<string, number>, words?: Record<string, string>) =>
    Object.entries(o)
      .map(([k, n]) => `${n} ${words?.[k] ?? k}`)
      .join(" · ") || "–";
  return [
    ["Rows", s.rows],
    ["Rows with errors", s.rows_with_errors],
    ["Companies", join(s.companies, LEVEL_TEXT)],
    ["People", join(s.people, LEVEL_TEXT)],
    ["Values vs shown values", join(s.values)],
    ["Incoming quality", join(s.quality)],
  ];
}

function Tiles({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
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
