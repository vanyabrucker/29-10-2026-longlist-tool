// The real corpus from helios-gateway (GET /companies, /companies/{id}) and
// how its values read in the interface. Types mirror the gateway's JSON.

import type { Translate } from "./i18n";

export type Level = "high" | "medium" | "low" | "unknown";

/** A shown value in the search results. */
export type ListCell = {
  value: unknown;
  period: number;
  score: number;
  level: Level;
  sources: number;
  pinned: boolean;
};

export type CompanyHit = { id: string; values: Record<string, ListCell> };

export type CompanyPage = {
  total: number;
  offset: number;
  limit: number;
  items: CompanyHit[];
};

/** Licensed databases, our own records, or the open web. */
export type SourceCategory = "proprietary" | "internal" | "public";

export type Source = {
  observation_id: number;
  value: unknown;
  raw: string | null;
  source_type: string;
  /** "S&P Capital IQ", "Internal file", … */
  label: string;
  category: SourceCategory;
  /** The uploaded file the value came from, with its sheet, row and column. */
  document: string | null;
  sheet: string | null;
  row: number | null;
  col: string | null;
  as_of: string | null;
  score: number;
  shown: boolean;
  pinned: boolean;
};

/** One data point of a company with its shown value and all live sources. */
export type Cell = {
  field: string;
  label: string;
  type: string;
  period: number | null;
  value: unknown;
  score: number;
  level: Level;
  /** 0–100. */
  confidence: number;
  /** 0–100; null without an as-of date. */
  freshness: number | null;
  as_of: string | null;
  pinned: { by: string; name: string; at: string } | null;
  /** The shown one first. */
  sources: Source[];
};

export type CompanyDetail = {
  id: string;
  name: string | null;
  cells: Cell[];
};

export type SortKey =
  | "relevance"
  | "name"
  | "website"
  | "hq"
  | "sector"
  | "revenue"
  | "employees";

const localeOf = (lang: string) => (lang === "de" ? "de-CH" : "en-US");

/** A normalised gateway value as text: "€410M", "Munich, DE", "1,250". */
export function formatValue(
  value: unknown,
  t: Translate,
  lang: string,
  /** The data point's type from the catalogue; years read without 1’000s. */
  type?: string,
): string {
  const locale = localeOf(lang);
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value))
    return value.map((v) => formatValue(v, t, lang, type)).join(", ");
  if (typeof value === "boolean") return value ? t("Yes") : t("No");
  if (typeof value === "number")
    return type === "year" ? String(value) : value.toLocaleString(locale);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("amount" in v) return formatMoney(Number(v.amount), v.currency, locale);
    if ("date" in v) return formatDay(String(v.date), lang, String(v.precision));
    if ("city" in v || "country" in v)
      return [v.city, v.region, v.country].filter(Boolean).join(", ");
    return JSON.stringify(value);
  }
  return String(value);
}

function formatMoney(amount: number, currency: unknown, locale: string) {
  const options: Intl.NumberFormatOptions = {
    notation: "compact",
    maximumFractionDigits: 1,
  };
  if (typeof currency === "string") {
    try {
      return new Intl.NumberFormat(locale, {
        ...options,
        style: "currency",
        currency,
      }).format(amount);
    } catch {
      // An unknown currency code: fall back to the bare amount.
    }
  }
  return new Intl.NumberFormat(locale, options).format(amount);
}

/** "30 Sep 2026" (or month/year precision), German month names in German. */
export function formatDay(iso: string, lang: string, precision = "day") {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(lang === "de" ? "de-CH" : "en-GB", {
    day: precision === "day" ? "numeric" : undefined,
    month: precision === "year" ? undefined : "short",
    year: "numeric",
  });
}

/** Where in the file a value was found: "longlist.xlsx · Financial buyers!H5". */
export function provenance(s: Source) {
  const cell =
    s.sheet && s.row
      ? `${s.sheet}!${s.col ?? ""}${s.row}`
      : s.row
        ? `${s.col ?? ""}${s.row}`
        : null;
  return [s.document, cell].filter(Boolean).join(" · ");
}

// The gateway's catalogue and source types are in English; German labels for
// the company data points and sources shown here (Swiss spelling).
export const FIELD_DE: Record<string, string> = {
  name: "Firmenname",
  legal_name: "Rechtlicher Name",
  website: "Website",
  registry_id: "Handelsregisternummer",
  capiq_id: "Capital-IQ-ID",
  orbis_id: "Orbis-ID",
  linkedin_url: "LinkedIn-Seite",
  description: "Beschreibung",
  founded: "Gründungsjahr",
  buyer_category: "Käuferkategorie",
  investor_type: "Investorentyp",
  vc_role: "VC-Rolle",
  sector: "Branche",
  sub_sector: "Teilbranche",
  industry_keywords: "Branchen-Stichwörter",
  value_chain_position: "Position in der Wertschöpfungskette",
  end_market: "Endmarkt",
  revenue: "Umsatz",
  ebitda: "EBITDA",
  ebit: "EBIT",
  aum: "Verwaltetes Vermögen",
  ticket_size_min: "Ticketgrösse (min.)",
  ticket_size_max: "Ticketgrösse (max.)",
  employee_count: "Mitarbeitende",
  owner_type: "Eigentümertyp",
  ownership_structure: "Eigentümerstruktur",
  hq: "Hauptsitz",
  markets: "Märkte",
  production_sites: "Produktionsstandorte",
  business_units: "Geschäftsbereiche",
  products: "Produkte",
  services: "Dienstleistungen",
  acquisition_interest: "Akquisitionsinteresse",
  investment_focus: "Investitionsfokus",
};

const SOURCE_DE: Record<string, string> = {
  manual: "Manuelle Änderung",
  internal: "Interne Datei",
  web: "Öffentliches Web",
  news: "News",
};

export const fieldLabel = (cell: Cell, lang: string) =>
  (lang === "de" && FIELD_DE[cell.field]) || cell.label;

export const sourceLabel = (source: Source, lang: string) =>
  (lang === "de" && SOURCE_DE[source.source_type]) || source.label;
