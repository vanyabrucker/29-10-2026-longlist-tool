"use client";

import { motion } from "motion/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Loader, Search } from "react-feather";
import { DOT } from "@/components/DataQuality";
import {
  formatValue,
  type CompanyHit,
  type CompanyPage,
  type ListCell,
  type SortKey,
} from "@/lib/corpus";
import { gw } from "@/lib/gateway";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { CompanyDetailPanel } from "./CompanyDetail";
import { PinIcon } from "./PinIcon";

const EASE = [0.32, 0.72, 0, 1] as const;
const PAGE = 50;
const DEBOUNCE_MS = 200;

// Columns of the results table: data point, header, sort key, width.
const COLUMNS: {
  field: string;
  label: MessageKey;
  sort: SortKey;
  width?: string;
  numeric?: boolean;
}[] = [
  { field: "name", label: "Name", sort: "name" },
  { field: "website", label: "Website", sort: "website", width: "w-[190px]" },
  { field: "hq", label: "Headquarters", sort: "hq", width: "w-[190px]" },
  { field: "sector", label: "Sector", sort: "sector", width: "w-[170px]" },
  {
    field: "revenue",
    label: "Revenue",
    sort: "revenue",
    width: "w-[120px]",
    numeric: true,
  },
  {
    field: "employee_count",
    label: "Employees",
    sort: "employees",
    width: "w-[120px]",
    numeric: true,
  },
];

/** /companies searches the corpus; /companies/[id] shows one company. */
export function CompaniesPanel() {
  const pathname = usePathname();
  const id = pathname.split("/")[2];
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white">
      {id ? (
        <CompanyDetailPanel key={id} id={decodeURIComponent(id)} />
      ) : (
        <CompanySearch />
      )}
    </div>
  );
}

type Sort = { key: SortKey; desc: boolean };

function CompanySearch() {
  const { t, formatNumber } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  // The query lives in the URL, so coming back from a company keeps it.
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(query.trim());
  const [sort, setSort] = useState<Sort>({ key: "relevance", desc: false });
  const [result, setResult] = useState<CompanyPage | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const q = query.trim();
      setDebounced(q);
      router.replace(
        q ? `/companies?q=${encodeURIComponent(q)}` : "/companies",
        {
          scroll: false,
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, router]);

  const path = (offset: number) => {
    const p = new URLSearchParams({
      sort: sort.key,
      dir: sort.desc ? "desc" : "asc",
      offset: String(offset),
      limit: String(PAGE),
    });
    if (debounced) p.set("q", debounced);
    return `/companies?${p}`;
  };
  const request = path(0);

  useEffect(() => {
    let live = true;
    gw<CompanyPage>(request).then(
      (page) => {
        if (!live) return;
        setResult(page);
        setError(false);
      },
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [request]);

  const loadMore = async () => {
    if (!result) return;
    setLoadingMore(true);
    try {
      const next = await gw<CompanyPage>(path(result.items.length));
      setResult({ ...next, items: [...result.items, ...next.items] });
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  // Without a query the list reads by name; relevance only ranks matches.
  const activeKey: SortKey =
    sort.key === "relevance" && !debounced ? "name" : sort.key;
  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key || (key === "name" && activeKey === "name")
        ? { key, desc: !s.desc }
        : // Numbers read biggest first, text A–Z.
          { key, desc: key === "revenue" || key === "employees" },
    );

  const empty = result && result.total === 0;
  const th = "h-9 px-3 font-normal";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="flex min-h-0 flex-1 flex-col px-8 pt-8"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-serif text-[28px] leading-tight tracking-[-0.01em]">
          {t("Companies")}
        </h1>
        {result && result.total > 0 && (
          <span className="text-[13px] text-muted tabular-nums">
            {t(result.total === 1 ? "{n} company" : "{n} companies", {
              n: formatNumber(result.total),
            })}
          </span>
        )}
      </div>
      <label className="mt-5 flex h-9 shrink-0 items-center gap-2.5 rounded-lg border border-line bg-white px-3 transition-shadow focus-within:border-[#c9d9ef] focus-within:ring-3 focus-within:ring-sky">
        <Search size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search by company name or website")}
          aria-label={t("Search by company name or website")}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
        />
      </label>

      {error && !result ? (
        <EmptyState
          title={t("Couldn't load companies")}
          text={t("The server isn't reachable. Try again in a moment.")}
        />
      ) : empty ? (
        debounced ? (
          <EmptyState
            title={t("No companies found")}
            text={t(
              "Nothing matches “{query}”. Try part of the name or the website.",
              { query: debounced },
            )}
          />
        ) : (
          <EmptyState
            title={t("No companies yet")}
            text={t("Companies appear here once a spreadsheet is imported.")}
          />
        )
      ) : (
        <div className="mt-4 min-h-0 flex-1 overflow-auto pb-8 [scrollbar-width:none]">
          <table className="w-full min-w-[920px] table-fixed border-separate border-spacing-0 text-left text-[14px]">
            <colgroup>
              {COLUMNS.map((c) => (
                <col key={c.field} className={c.width} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-white text-[12.5px] text-muted">
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.field}
                    aria-sort={
                      activeKey === c.sort
                        ? sort.desc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                    className={`${th} border-b border-line ${c.numeric ? "text-right" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.sort)}
                      className={`inline-flex items-center gap-1 transition-colors hover:text-ink ${activeKey === c.sort ? "text-ink" : ""}`}
                    >
                      {t(c.label)}
                      {activeKey === c.sort &&
                        (sort.desc ? (
                          <ArrowDown size={12} strokeWidth={2} />
                        ) : (
                          <ArrowUp size={12} strokeWidth={2} />
                        ))}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result?.items.map((company) => (
                <Row
                  key={company.id}
                  company={company}
                  onOpen={() => router.push(`/companies/${company.id}`)}
                />
              ))}
            </tbody>
          </table>
          {result && result.items.length < result.total && (
            <div className="flex justify-center pt-5">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="flex h-8 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13.5px] font-medium transition-colors hover:bg-subtle disabled:text-muted"
              >
                {loadingMore && (
                  <Loader
                    size={13}
                    strokeWidth={1.75}
                    className="animate-spin"
                  />
                )}
                {t("Show more")}
              </button>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function Row({ company, onOpen }: { company: CompanyHit; onOpen: () => void }) {
  return (
    <tr
      onClick={onOpen}
      className="h-11 cursor-pointer transition-colors hover:bg-canvas"
    >
      {COLUMNS.map((c) => (
        <ValueCell
          key={c.field}
          cell={company.values[c.field]}
          strong={c.field === "name"}
          numeric={c.numeric}
        />
      ))}
    </tr>
  );
}

/** A shown value with its quality dot (flagged values only, like the
 * research table: dot 12px in, text 28px in) and a pin when prioritized. */
function ValueCell({
  cell,
  strong,
  numeric,
}: {
  cell?: ListCell;
  strong?: boolean;
  numeric?: boolean;
}) {
  const { t, lang } = useI18n();
  const text = cell ? formatValue(cell.value, t, lang) : "";
  const flagged = !!cell && cell.level !== "high";
  return (
    <td
      className={`relative border-b border-line pr-3 ${flagged ? "pl-[28px]" : "pl-3"}`}
    >
      {flagged && (
        <span
          aria-label={t(LEVEL_LABEL[cell.level])}
          className={`absolute top-1/2 left-[12px] size-[7px] -translate-y-1/2 rounded-full ${DOT[cell.level]}`}
        />
      )}
      <span
        className={`flex min-w-0 items-center gap-1.5 ${numeric ? "justify-end tabular-nums" : ""}`}
      >
        <span className={`truncate ${strong ? "font-medium" : ""}`}>
          {text || <span className="text-faint">–</span>}
        </span>
        {cell?.pinned && (
          <PinIcon
            size={11}
            strokeWidth={2}
            filled
            className="shrink-0 text-muted"
          />
        )}
      </span>
    </td>
  );
}

const LEVEL_LABEL: Record<ListCell["level"], MessageKey> = {
  high: "High quality",
  medium: "Medium quality",
  low: "Low quality",
  unknown: "Unknown quality",
};

// Slightly above the middle, like the home greeting.
function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-[12vh] text-center">
      <span className="flex size-9 items-center justify-center rounded-lg border border-line bg-white">
        <Search size={16} strokeWidth={1.75} />
      </span>
      <h2 className="mt-5 text-[15px] font-medium">{title}</h2>
      <p className="mt-1.5 max-w-[360px] text-[13px] text-muted">{text}</p>
    </div>
  );
}
