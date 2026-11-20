"use client";

import { useEffect, useState } from "react";
import { Search } from "@/components/icons";
import { gw, show, type Catalogue } from "@/lib/gateway";
import { Notice, Page, Section, td, th } from "./ui";

type Shown = {
  value: unknown;
  period: number;
  score: number;
  level: "high" | "medium" | "low" | "unknown";
  sources: number;
};
type CompanyRow = { id: string; values: Record<string, Shown> };
type Observation = {
  value: unknown;
  raw: string | null;
  period: number | null;
  source_type: string;
  document_id: string | null;
  sheet: string | null;
  row: number | null;
  col: string | null;
  as_of: string | null;
  version_id: number;
  retracted: boolean;
  score: number;
  shown: boolean;
};
type CompanyDetail = { id: string; fields: Record<string, Observation[]> };

const COLUMNS = [
  "buyer_category",
  "investor_type",
  "hq",
  "website",
  "revenue",
  "aum",
  "employee_count",
];

const DOT: Record<string, string> = {
  high: "bg-good",
  medium: "bg-warn",
  low: "bg-bad",
  unknown: "bg-[#d4d4d8]",
};

/** The master database: companies with their shown values and every source
 * behind each value. */
export function MasterPanel() {
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    gw<Catalogue>("/catalogue").then(setCatalogue, () => {});
    gw<{ items: CompanyRow[] }>("/companies?limit=1000").then(
      (page) => setCompanies(page.items),
      (e) => setError(e.message),
    );
  }, []);

  useEffect(() => {
    if (!selected) return;
    gw<CompanyDetail>(`/companies/${selected}`).then(setDetail, (e) =>
      setError(e.message),
    );
  }, [selected]);

  const label = (key: string) =>
    catalogue?.points.find((p) => p.key === key)?.label ?? key;
  const shown = companies.filter((c) =>
    String(c.values.name?.value ?? "")
      .toLowerCase()
      .includes(q.trim().toLowerCase()),
  );

  return (
    <Page
      title="Master data"
      back={{ href: "/admin/imports", label: "Imports" }}
    >
      {error && <Notice tone="error">{error}</Notice>}
      <label className="flex h-9 items-center gap-2.5 rounded-lg border border-line px-3">
        <Search size={15} strokeWidth={1.75} className="text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search companies"
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
        />
      </label>

      <Section
        title="Companies"
        aside={`${shown.length} of ${companies.length}`}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-[13.5px]">
            <thead>
              <tr>
                <th className={th}>Name</th>
                {COLUMNS.map((k) => (
                  <th key={k} className={th}>
                    {label(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c.id === selected ? null : c.id)}
                  className={`cursor-pointer transition-colors hover:bg-canvas ${c.id === selected ? "bg-canvas" : ""}`}
                >
                  <td className={`${td} max-w-[280px] truncate font-medium`}>
                    {show(c.values.name?.value)}
                  </td>
                  {COLUMNS.map((k) => (
                    <td key={k} className={`${td} max-w-[200px] truncate`}>
                      {c.values[k] ? (
                        <span className="inline-flex items-center gap-1.5">
                          {c.values[k].level !== "high" && (
                            <span
                              className={`size-1.5 rounded-full ${DOT[c.values[k].level]}`}
                            />
                          )}
                          {show(c.values[k].value)}
                          {c.values[k].period ? (
                            <span className="text-faint">
                              {c.values[k].period}
                            </span>
                          ) : null}
                          {c.values[k].sources > 1 && (
                            <span className="text-[11.5px] text-muted">
                              +{c.values[k].sources - 1}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-faint">–</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {selected && detail && detail.id === selected && (
        <Section
          title={`Sources for ${show(companies.find((c) => c.id === selected)?.values.name?.value)}`}
          aside="Every value ever imported; the shown one has the best quality score."
        >
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                <th className={th}>Data point</th>
                <th className={th}>Value</th>
                <th className={th}>Source</th>
                <th className={th}>From</th>
                <th className={th}>As of</th>
                <th className={`${th} text-right`}>Score</th>
                <th className={th}>Version</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(detail.fields).flatMap(([field, observations]) =>
                observations.map((o, i) => (
                  <tr
                    key={`${field}${i}`}
                    className={o.retracted ? "text-faint line-through" : ""}
                  >
                    <td className={`${td} whitespace-nowrap`}>
                      {i === 0 ? label(field) : ""}
                      {o.period ? ` ${o.period}` : ""}
                    </td>
                    <td
                      className={`${td} ${o.shown ? "font-medium" : "text-muted"}`}
                    >
                      {show(o.value)}
                      {o.shown && (
                        <span className="ml-2 rounded bg-subtle px-1 text-[11px] font-medium no-underline">
                          Shown
                        </span>
                      )}
                    </td>
                    <td className={`${td} text-muted`}>{o.source_type}</td>
                    <td className={`${td} text-muted`}>
                      {o.document_id ? (
                        <a
                          href={`/api/gateway/documents/${o.document_id}/file`}
                          className="underline decoration-[#b5b5ba] underline-offset-[3px] hover:decoration-ink"
                        >
                          {o.sheet} {o.col}
                          {o.row}
                        </a>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className={`${td} text-muted`}>{o.as_of ?? "–"}</td>
                    <td className={`${td} text-right tabular-nums`}>
                      {o.score}
                    </td>
                    <td className={`${td} text-muted`}>v{o.version_id}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </Section>
      )}
    </Page>
  );
}
