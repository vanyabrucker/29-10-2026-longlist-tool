"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, X } from "react-feather";
import type { Facets } from "@/lib/corpus";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useDismiss } from "@/lib/useDismiss";

/** Filters of the company search, as the gateway's GET /companies takes
 * them. Numbers stay strings while typed; empty means no bound. */
export type CompanyFilters = {
  regions: string[];
  countries: string[];
  sectors: string[];
  buyer: "Strategic" | "Financial" | null;
  investorTypes: string[];
  revenueMin: string;
  revenueMax: string;
  currency: string;
  employeesMin: string;
  employeesMax: string;
  includeMissing: boolean;
};

export const NO_FILTERS: CompanyFilters = {
  regions: [],
  countries: [],
  sectors: [],
  buyer: null,
  investorTypes: [],
  revenueMin: "",
  revenueMax: "",
  currency: "EUR",
  employeesMin: "",
  employeesMax: "",
  includeMissing: false,
};

const REGION_LABEL: Record<string, MessageKey> = {
  dach: "DACH",
  europe: "Europe",
  eu: "EU",
  nordics: "Nordics",
  benelux: "Benelux",
  uk_ireland: "UK & Ireland",
  north_america: "North America",
  asia_pacific: "Asia-Pacific",
};

const number = (s: string) => {
  const n = Number(s.replace(/['’,\s]/g, ""));
  return s.trim() && Number.isFinite(n) && n >= 0 ? n : null;
};

const hasRevenue = (f: CompanyFilters) =>
  number(f.revenueMin) !== null || number(f.revenueMax) !== null;
const hasEmployees = (f: CompanyFilters) =>
  number(f.employeesMin) !== null || number(f.employeesMax) !== null;

export function isFiltered(f: CompanyFilters) {
  return (
    f.regions.length > 0 ||
    f.countries.length > 0 ||
    f.sectors.length > 0 ||
    f.buyer !== null ||
    f.investorTypes.length > 0 ||
    hasRevenue(f) ||
    hasEmployees(f)
  );
}

/** The filters as query parameters (gateway names, also kept in the URL). */
export function filterParams(f: CompanyFilters, p: URLSearchParams) {
  f.regions.forEach((r) => p.append("region", r));
  f.countries.forEach((c) => p.append("country", c));
  f.sectors.forEach((s) => p.append("sector", s));
  if (f.buyer) p.set("buyer_category", f.buyer);
  f.investorTypes.forEach((i) => p.append("investor_type", i));
  const bounds: [string, string][] = [
    ["revenue_min_m", f.revenueMin],
    ["revenue_max_m", f.revenueMax],
    ["employees_min", f.employeesMin],
    ["employees_max", f.employeesMax],
  ];
  for (const [key, value] of bounds) {
    const n = number(value);
    if (n !== null) p.set(key, String(n));
  }
  if (hasRevenue(f)) p.set("revenue_currency", f.currency);
  if ((hasRevenue(f) || hasEmployees(f)) && f.includeMissing)
    p.set("include_missing", "true");
  return p;
}

export function filtersFrom(p: URLSearchParams): CompanyFilters {
  const buyer = p.get("buyer_category");
  return {
    regions: p.getAll("region"),
    countries: p.getAll("country"),
    sectors: p.getAll("sector"),
    buyer: buyer === "Strategic" || buyer === "Financial" ? buyer : null,
    investorTypes: p.getAll("investor_type"),
    revenueMin: p.get("revenue_min_m") ?? "",
    revenueMax: p.get("revenue_max_m") ?? "",
    currency: p.get("revenue_currency") ?? "EUR",
    employeesMin: p.get("employees_min") ?? "",
    employeesMax: p.get("employees_max") ?? "",
    includeMissing: p.get("include_missing") === "true",
  };
}

const toggled = (list: string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/** One summary for a chip: the first value and "+N" for the rest. */
const summary = (values: string[]) =>
  values.length > 1 ? `${values[0]} +${values.length - 1}` : values[0];

/** The row of filter chips under the search field. */
export function FilterBar({
  filters,
  facets,
  onChange,
}: {
  filters: CompanyFilters;
  facets: Facets | null;
  onChange: (next: CompanyFilters) => void;
}) {
  const { t, lang, formatNumber } = useI18n();
  const set = (patch: Partial<CompanyFilters>) =>
    onChange({ ...filters, ...patch });
  const countryName = useMemo(() => {
    const names = new Intl.DisplayNames([lang === "de" ? "de-CH" : "en"], {
      type: "region",
    });
    return (code: string) => names.of(code) ?? code;
  }, [lang]);

  const places = [
    ...filters.regions.map((r) => t(REGION_LABEL[r] ?? "Europe")),
    ...filters.countries.map(countryName),
  ];
  const buyerParts = [
    ...(filters.buyer ? [t(filters.buyer)] : []),
    ...filters.investorTypes,
  ];
  const range = (min: string, max: string, unit = "") => {
    const lo = number(min);
    const hi = number(max);
    const f = (n: number) => formatNumber(n) + unit;
    if (lo !== null && hi !== null) return `${f(lo)}–${f(hi)}`;
    if (lo !== null) return `≥ ${f(lo)}`;
    return hi !== null ? `≤ ${f(hi)}` : "";
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <Chip
        label={t("Location")}
        value={places.length ? summary(places) : null}
        onClear={() => set({ regions: [], countries: [] })}
      >
        <Section title={t("Regions")}>
          {Object.keys(REGION_LABEL)
            .filter((r) => !facets || r in facets.regions)
            .map((r) => (
              <Option
                key={r}
                label={t(REGION_LABEL[r])}
                checked={filters.regions.includes(r)}
                onClick={() => set({ regions: toggled(filters.regions, r) })}
              />
            ))}
        </Section>
        <Section title={t("Countries")}>
          {facets?.countries.map((c) => (
            <Option
              key={c.value}
              label={countryName(c.value)}
              count={formatNumber(c.count)}
              checked={filters.countries.includes(c.value)}
              onClick={() =>
                set({ countries: toggled(filters.countries, c.value) })
              }
            />
          ))}
        </Section>
      </Chip>
      <Chip
        label={t("Sector")}
        value={filters.sectors.length ? summary(filters.sectors) : null}
        onClear={() => set({ sectors: [] })}
      >
        {facets?.sectors.map((s) => (
          <Option
            key={s.value}
            label={s.value}
            count={formatNumber(s.count)}
            checked={filters.sectors.includes(s.value)}
            onClick={() => set({ sectors: toggled(filters.sectors, s.value) })}
          />
        ))}
        {facets && facets.sectors.length === 0 && (
          <p className="px-2.5 py-2 text-[13px] text-muted">
            {t("No sectors in the data yet.")}
          </p>
        )}
      </Chip>
      <Chip
        label={t("Buyer type")}
        value={buyerParts.length ? summary(buyerParts) : null}
        onClear={() => set({ buyer: null, investorTypes: [] })}
      >
        <Section>
          {(["Strategic", "Financial"] as const).map((b) => (
            <Option
              key={b}
              label={t(b)}
              count={(() => {
                const n = facets?.buyer_categories.find(
                  (c) => c.value === b,
                )?.count;
                return n === undefined ? undefined : formatNumber(n);
              })()}
              checked={filters.buyer === b}
              onClick={() => set({ buyer: filters.buyer === b ? null : b })}
            />
          ))}
        </Section>
        {facets && facets.investor_types.length > 0 && (
          <Section title={t("Investor type")}>
            {facets.investor_types.map((i) => (
              <Option
                key={i.value}
                label={i.value}
                count={formatNumber(i.count)}
                checked={filters.investorTypes.includes(i.value)}
                onClick={() =>
                  set({
                    investorTypes: toggled(filters.investorTypes, i.value),
                  })
                }
              />
            ))}
          </Section>
        )}
      </Chip>
      <Chip
        label={t("Revenue")}
        value={
          hasRevenue(filters)
            ? `${filters.currency} ${range(filters.revenueMin, filters.revenueMax, "m")}`
            : null
        }
        onClear={() => set({ revenueMin: "", revenueMax: "" })}
        wide
      >
        <RangeForm
          unit={t("m")}
          min={filters.revenueMin}
          max={filters.revenueMax}
          onMin={(revenueMin) => set({ revenueMin })}
          onMax={(revenueMax) => set({ revenueMax })}
          currency={filters.currency}
          currencies={facets?.currencies ?? ["EUR"]}
          onCurrency={(currency) => set({ currency })}
          includeMissing={filters.includeMissing}
          onIncludeMissing={(includeMissing) => set({ includeMissing })}
          note={t("Other currencies are compared at approximate fixed rates.")}
        />
      </Chip>
      <Chip
        label={t("Employees")}
        value={
          hasEmployees(filters)
            ? range(filters.employeesMin, filters.employeesMax)
            : null
        }
        onClear={() => set({ employeesMin: "", employeesMax: "" })}
        wide
      >
        <RangeForm
          min={filters.employeesMin}
          max={filters.employeesMax}
          onMin={(employeesMin) => set({ employeesMin })}
          onMax={(employeesMax) => set({ employeesMax })}
          includeMissing={filters.includeMissing}
          onIncludeMissing={(includeMissing) => set({ includeMissing })}
        />
      </Chip>
      {isFiltered(filters) && (
        <button
          type="button"
          onClick={() =>
            onChange({ ...NO_FILTERS, currency: filters.currency })
          }
          className="h-8 rounded-full px-2.5 text-[13.5px] text-muted transition-colors hover:bg-subtle hover:text-ink"
        >
          {t("Clear filters")}
        </button>
      )}
    </div>
  );
}

/** A rounded filter button opening a popover; with a value it turns light
 * blue, shows the value and gets an × that clears it. */
function Chip({
  label,
  value,
  onClear,
  wide,
  children,
}: {
  label: string;
  value: string | null;
  onClear: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const active = value !== null;

  return (
    <div ref={ref} className="relative">
      <div
        className={`flex h-8 items-center rounded-full border text-[13.5px] transition-colors ${
          active
            ? "border-transparent bg-sky text-sky-ink"
            : `border-line ${open ? "bg-subtle" : "hover:bg-subtle"}`
        }`}
      >
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`flex h-full items-center gap-1 ${active ? "pr-1 pl-3" : "px-3"}`}
        >
          <span className={active ? "" : "text-ink"}>
            {active ? `${label}: ${value}` : label}
          </span>
          {!active && (
            <ChevronDown size={14} strokeWidth={1.75} className="text-muted" />
          )}
        </button>
        {active && (
          <button
            type="button"
            aria-label={t("Remove filter")}
            onClick={onClear}
            className="mr-1 flex size-6 items-center justify-center rounded-full transition-colors hover:bg-white/70"
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label={label}
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className={`absolute top-full left-0 z-30 mt-2 max-h-[380px] origin-top-left overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)] [scrollbar-width:thin] ${wide ? "w-72" : "w-64"}`}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-line not-first:mt-1 not-first:border-t not-first:pt-1">
      {title && (
        <p className="px-2.5 pt-1.5 pb-1 text-[12px] text-muted">{title}</p>
      )}
      {children}
    </div>
  );
}

function Option({
  label,
  count,
  checked,
  onClick,
}: {
  label: string;
  count?: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle"
    >
      <span className="flex-1 truncate">{label}</span>
      {count && (
        <span className="text-[12.5px] text-faint tabular-nums">{count}</span>
      )}
      <span className="flex w-[15px] justify-center">
        {checked && <Check size={15} strokeWidth={2} />}
      </span>
    </button>
  );
}

const field =
  "h-9 w-full min-w-0 rounded-lg border border-line bg-white px-2.5 text-[14px] outline-none transition-shadow placeholder:text-faint focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky";

function RangeForm({
  unit,
  min,
  max,
  onMin,
  onMax,
  currency,
  currencies,
  onCurrency,
  includeMissing,
  onIncludeMissing,
  note,
}: {
  unit?: string;
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
  currency?: string;
  currencies?: string[];
  onCurrency?: (v: string) => void;
  includeMissing: boolean;
  onIncludeMissing: (v: boolean) => void;
  note?: string;
}) {
  const { t } = useI18n();
  const bound = (
    label: string,
    value: string,
    onValue: (v: string) => void,
  ) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="relative">
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onValue(e.target.value)}
          placeholder={t("Any")}
          className={`${field} ${unit ? "pr-7" : ""}`}
        />
        {unit && (
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[13px] text-muted">
            {unit}
          </span>
        )}
      </span>
    </label>
  );
  return (
    <div className="p-2">
      <div className="flex items-end gap-2">
        {currency && currencies && onCurrency && (
          <label className="flex w-[76px] shrink-0 flex-col gap-1">
            <span className="text-[12px] text-muted">{t("Currency")}</span>
            <select
              value={currency}
              onChange={(e) => onCurrency(e.target.value)}
              className={`${field} cursor-pointer pr-1`}
            >
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        )}
        {bound(t("Min"), min, onMin)}
        {bound(t("Max"), max, onMax)}
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13.5px]">
        <span className="relative block size-4 shrink-0">
          <input
            type="checkbox"
            checked={includeMissing}
            onChange={(e) => onIncludeMissing(e.target.checked)}
            className="peer block size-4 cursor-pointer appearance-none rounded-[3px] border border-[#d4d4d8] bg-white transition-colors outline-none checked:border-ink checked:bg-ink hover:border-faint focus-visible:ring-3 focus-visible:ring-sky"
          />
          <Check
            size={12}
            strokeWidth={3}
            className="pointer-events-none absolute inset-0 m-auto text-white opacity-0 peer-checked:opacity-100"
          />
        </span>
        {t("Include companies without a figure")}
      </label>
      {note && <p className="mt-2 text-[12px] text-muted">{note}</p>}
    </div>
  );
}
