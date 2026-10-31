// Fake research output for the demo mandate (the sale of Consilio, an SAP
// consultancy): two buyer lists. The best fits are written out by hand with
// detailed rationales; the rest are generated from a fixed seed, so the demo
// shows the same plausible companies every time. All buyers are fictional
// except BWK, the real acquirer of Consilio, which the demo must surface.

import type { MessageKey } from "./i18n";
import type { ScopingQuestion } from "./scoping";

export type BuyerRow = {
  id: string;
  /** Position in the generated list; diffs are keyed on it. */
  index: number;
  name: string;
  types: string;
  rationale: string;
  /** 0–100: how well the buyer matches the buyer profile. */
  fit: number;
  /** Hand-written top buyer (always well sourced). */
  featured?: boolean;
  deals: number;
  hq: string;
  founded: number;
  aum: string;
  lastDeal: string;
  website: string;
  /** Added by the refine pass; missing until then. */
  sauvignon?: Sauvignon;
};

export type Sauvignon = "Yes" | "No" | "Unknown";

// What a version changed, used to render its diff on the sample rows.
export type VersionDiff =
  | { kind: "addedRows" }
  | { kind: "addedColumns"; keys: Column["key"][] }
  | { kind: "changedCells"; key: Column["key"]; every: number }
  | { kind: "removedRows"; count: number };

export type ListVersion = {
  number: number;
  author: "Agent" | "Vanya Brucker";
  date: string;
  message: string;
  /** Cells changed across the full list, like a commit's line count. */
  changes: number;
  diff: VersionDiff;
};

export type BuyerList = {
  id: "financial" | "strategic";
  /** Interface labels, translated where shown. */
  title: MessageKey;
  unit: MessageKey;
  total: number;
  rows: BuyerRow[];
  /** Newest first; the first entry is the latest version. */
  versions: ListVersion[];
  /** Rows that later versions removed, shown struck through in their diff. */
  removedPool: BuyerRow[];
};

export type Column = {
  key: Exclude<keyof BuyerRow, "id" | "index" | "name" | "featured">;
  label: MessageKey;
  group: MessageKey;
  width: number;
};

export const COLUMNS: Column[] = [
  {
    key: "types",
    label: "Buyer types",
    group: "Buyer company information",
    width: 200,
  },
  {
    key: "rationale",
    label: "Inclusion rationale",
    group: "Buyer company information",
    width: 300,
  },
  {
    key: "fit",
    label: "Fit score",
    group: "Buyer company information",
    width: 140,
  },
  {
    key: "deals",
    label: "Buyer number of deals",
    group: "Deal activity",
    width: 200,
  },
  { key: "lastDeal", label: "Last deal", group: "Deal activity", width: 140 },
  { key: "hq", label: "Headquarters", group: "Buyer profile", width: 170 },
  { key: "founded", label: "Founded", group: "Buyer profile", width: 110 },
  { key: "aum", label: "AUM / Revenue", group: "Buyer profile", width: 150 },
  { key: "website", label: "Website", group: "Buyer profile", width: 200 },
];

// mulberry32: tiny deterministic PRNG.
function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, list: readonly T[]) =>
  list[Math.floor(rand() * list.length)];

const HQS = [
  "Munich, DE",
  "Stuttgart, DE",
  "Frankfurt, DE",
  "Hamburg, DE",
  "Düsseldorf, DE",
  "Berlin, DE",
  "Zurich, CH",
  "Basel, CH",
  "Vienna, AT",
  "Amsterdam, NL",
  "London, UK",
  "Paris, FR",
  "Stockholm, SE",
  "Boston, US",
  "New York, US",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

type Kind = BuyerList["id"];

// Name parts that read like the buyers an SAP consultancy would attract:
// mid-market investors on one side, consultancies and IT service groups on
// the other.
const NAMES: Record<Kind, { first: string[]; last: string[] }> = {
  financial: {
    first: [
      "Alpine Peak",
      "Lakeview",
      "Granite",
      "Ridgeway",
      "Silverline",
      "Bergmann",
      "Harbourside",
      "Meridian",
      "Larchmont",
      "Edelweiss",
      "Fjord",
      "Cobalt",
      "Ashford",
      "Summit Crest",
      "Oakhurst",
      "Westbrook",
      "Tessin",
      "Aurelius",
      "Pinecrest",
      "Montrose",
      "Donautal",
      "Feldberg",
    ],
    last: [
      "Capital",
      "Equity Partners",
      "Growth Partners",
      "Capital Partners",
      "Beteiligungen GmbH",
      "Partners",
      "Private Equity",
      "Mittelstand Fund III",
      "Holding AG",
      "Ventures",
    ],
  },
  strategic: {
    first: [
      "Corvane",
      "Solano",
      "Vantor",
      "Quorum",
      "Lumen",
      "Stellar",
      "Arcadia",
      "Tandem",
      "Calyx",
      "Halden",
      "Sentinel",
      "Zephyr",
      "Brightline",
      "Aurora",
      "Keystone",
      "Ostwind",
      "Teralis",
      "Novaris",
    ],
    last: [
      "Consulting AG",
      "IT Services GmbH",
      "Business Solutions",
      "Process Consulting",
      "Digital Group",
      "Technology Partners",
      "Systems Integration",
      "Supply Chain Solutions",
      "Engineering Group",
      "Advisory",
    ],
  },
};

const between = (rand: () => number, lo: number, hi: number) =>
  Math.round(lo + rand() * (hi - lo));

// One rationale per buyer, built from the profile in the intake reply:
// strategics are judged on size, sector interest and financing capacity,
// investors on their published scope, ticket size and stage. Stronger
// arguments come with higher fit scores.
type Template = (rand: () => number) => {
  types: string;
  rationale: string;
  fit: number;
};

const TEMPLATES: Record<Kind, Template[]> = {
  financial: [
    (r) => ({
      types: "Private Equity",
      rationale: `Published scope: majority stakes in DACH B2B and IT services companies with €${between(r, 3, 5)}–${between(r, 12, 20)}M EBITDA, equity tickets of €${between(r, 10, 20)}–${between(r, 40, 70)}M, which fits the expected deal size. Has completed ${between(r, 2, 5)} services buyouts since ${between(r, 2021, 2023)}.`,
      fit: between(r, 62, 76),
    }),
    (r) => ({
      types: "Private Equity",
      rationale: `Holds an IT services platform in ${pick(r, ["Germany", "Austria", "Switzerland"])} with a stated buy-and-build strategy; Consilio would be an add-on that brings S/4HANA and supply chain expertise. Add-on tickets of €${between(r, 15, 25)}–${between(r, 60, 90)}M.`,
      fit: between(r, 64, 76),
    }),
    (r) => ({
      types: "Growth Equity, Private Equity",
      rationale: `Invests in technology-enabled services across Europe, majority or significant minority. Prefers EBITDA above €${between(r, 6, 10)}M, so Consilio sits at the lower edge of its range.`,
      fit: between(r, 50, 66),
    }),
    (r) => ({
      types: "Family Office",
      rationale: `Single family office with a published focus on succession deals in the German Mittelstand; long holding periods, sector-agnostic. Tickets up to €${between(r, 40, 80)}M.`,
      fit: between(r, 52, 68),
    }),
    (r) => ({
      types: "Private Equity",
      rationale: `Generalist mid-market buyout fund (EV €${between(r, 20, 40)}–${between(r, 120, 200)}M). Size fits, but no IT services or consulting deals in its portfolio so far.`,
      fit: between(r, 40, 55),
    }),
    (r) => ({
      types: "Private Equity",
      rationale: `Large-cap fund with a minimum equity ticket of about €${between(r, 150, 300)}M; only relevant through an IT services portfolio company that could buy Consilio as an add-on.`,
      fit: between(r, 25, 40),
    }),
    (r) => ({
      types: "Venture Capital",
      rationale: `Publishes a ${pick(r, ["Seed to Series B", "Series A to C", "Series A and B"])} focus on enterprise software. A mature, profitable consultancy is outside its stated stage and model.`,
      fit: between(r, 8, 22),
    }),
    (r) => ({
      types: "Investment Holding Company",
      rationale: `Found by Helios agentic search: recent press and LinkedIn posts mention a new DACH IT services thesis that isn't in its published scope yet.`,
      fit: between(r, 35, 52),
    }),
  ],
  strategic: [
    (r) => ({
      types: "Strategic — SAP consulting",
      rationale: `SAP ${pick(r, ["Gold", "Platinum"])} partner with about €${between(r, 250, 900)}M revenue, so a €30–60M deal is a bolt-on. Consilio's supply chain and production planning team would deepen its S/4HANA offer for ${pick(r, ["manufacturing", "automotive", "process industry", "machinery"])} clients. Net cash position.`,
      fit: between(r, 64, 76),
    }),
    (r) => ({
      types: "Strategic — IT services & integration",
      rationale: `IT services group (€${(r() * 1.6 + 0.5).toFixed(1)}B revenue) that has bought ${between(r, 2, 4)} SAP boutiques since ${between(r, 2020, 2023)}; Consilio fits its stated DACH buy-and-build. Undrawn credit lines cover a deal of this size.`,
      fit: between(r, 62, 75),
    }),
    (r) => ({
      types: "Strategic — ERP & supply chain software",
      rationale: `Supply chain planning software vendor with a services arm; strong interest in implementation capacity, but leverage of about ${(2.6 + r() * 0.8).toFixed(1)}× EBITDA limits room for a €30–60M acquisition.`,
      fit: between(r, 48, 64),
    }),
    (r) => ({
      types: "Strategic — engineering services",
      rationale: `Engineering services group (€${between(r, 200, 700)}M revenue) moving into digital factory and MES; production planning know-how and industrial clients are a natural fit, SAP delivery would be new.`,
      fit: between(r, 50, 66),
    }),
    (r) => ({
      types: "Strategic — management consulting",
      rationale: `Management consultancy with a small SAP practice; big enough to buy Consilio, but SAP delivery isn't a stated priority.`,
      fit: between(r, 30, 46),
    }),
    (r) => ({
      types: "Strategic — SAP consulting",
      rationale: `SAP partner of similar size (about €${between(r, 30, 70)}M revenue); a merger of equals is possible, but it couldn't fund an acquisition without outside capital.`,
      fit: between(r, 22, 38),
    }),
  ],
};

// The best fits, written out in full like an analyst would. Generated buyers
// score at most 76, so these stay at the top of each list.
type Featured = Omit<BuyerRow, "id" | "index">;

const FEATURED: Record<Kind, Featured[]> = {
  financial: [
    {
      name: "BWK GmbH Unternehmensbeteiligungsgesellschaft",
      types: "Private Equity",
      rationale:
        "One of Germany's longest-standing Mittelstand investors (Stuttgart, since 1990). Its published scope covers majority and minority stakes in established, profitable mid-sized companies, with succession situations, MBOs, MBIs and spin-offs as typical entry points. That matches Consilio well: a founder-built consultancy with more than 200 employees and a clear market position. BWK focuses on long-term equity, so it can back a multi-year S/4HANA growth phase rather than aiming for a quick exit. Its recent deals include engineering and technical service firms such as R&K Ingenieure, so it knows people-based service models where the value sits in consultants and client relationships. The southern German focus is a further plus, close to Consilio's base in Aschheim near Munich. To confirm: BWK doesn't publish ticket sizes, and IT consulting would be a new segment for its portfolio.",
      fit: 94,
      deals: 42,
      lastDeal: "2024",
      hq: "Stuttgart, DE",
      founded: 1990,
      aum: "Not disclosed",
      website: "bwk.de",
    },
    {
      name: "Isarblick Capital Partners",
      types: "Private Equity",
      rationale:
        "Munich-based buyout investor whose published strategy is buy-and-build in DACH IT services and B2B software, with majority stakes in companies at €3–15M EBITDA and equity tickets of €15–80M, which brackets Consilio's expected value. Its current platform, Velora Business Consulting, is an SAP partner focused on finance and HR processes; Consilio would add the supply chain and production planning depth Velora lacks, plus a nearshore delivery base in Bulgaria. The fund closed in 2024 and is roughly 40% deployed, so there is fresh capital. It has bought three IT consultancies in the last two years, all founder-led, and typically keeps founders on with a rollover stake.",
      fit: 91,
      deals: 37,
      lastDeal: "Mar 2026",
      hq: "Munich, DE",
      founded: 2011,
      aum: "€2.1B AUM",
      website: "isarblick-capital.de",
    },
    {
      name: "Rheintal Growth Partners",
      types: "Growth Equity, Private Equity",
      rationale:
        "Zurich-based growth investor that publishes a focus on tech-enabled services in DACH, taking majority or significant minority stakes with tickets of €10–50M. It backs companies growing more than 10% a year with an international footprint, which fits Consilio's sites in Switzerland and the US. It has two SAP-adjacent holdings (a data migration specialist and an SAP training provider), so it already understands the partner ecosystem. Slightly lower fit because it prefers minority growth rounds over full succession deals.",
      fit: 86,
      deals: 29,
      lastDeal: "Feb 2026",
      hq: "Zurich, CH",
      founded: 2008,
      aum: "€1.4B AUM",
      website: "rheintal-growth.ch",
    },
    {
      name: "Neckar Mittelstand Beteiligungen",
      types: "Family Office",
      rationale:
        "Family office that publishes a focus on succession solutions for owner-managed companies in southern Germany, sector-agnostic, with tickets up to €60M and no fixed holding period. A good match for founders who care about continuity, though it has no IT services experience and would rely on management to drive the SAP business.",
      fit: 82,
      deals: 18,
      lastDeal: "Nov 2025",
      hq: "Stuttgart, DE",
      founded: 2004,
      aum: "€0.9B AUM",
      website: "neckar-beteiligungen.de",
    },
    {
      name: "Kestrel Equity Partners",
      types: "Private Equity",
      rationale:
        "Pan-European buyout fund with an IT services platform in the Netherlands looking for a DACH entry. Its published EV range of €50–300M puts Consilio at the lower end, so it would most likely buy it as an add-on rather than a new platform.",
      fit: 77,
      deals: 64,
      lastDeal: "Jun 2026",
      hq: "London, UK",
      founded: 2002,
      aum: "€6.8B AUM",
      website: "kestrel-equity.co.uk",
    },
  ],
  strategic: [
    {
      name: "Nordwind Business Consulting AG",
      types: "Strategic — SAP consulting",
      rationale:
        "SAP Platinum partner with €640M revenue and about 3,800 consultants, roughly 15 times Consilio's size, so the deal is a bolt-on rather than a strategic bet. Interest is high: Nordwind's stated 2027 strategy is to double its S/4HANA business with industrial mid-market clients, and its offering is strongest in finance and HR while supply chain management and production planning are thin. That is exactly Consilio's niche. The client bases overlap in machinery and automotive suppliers in southern Germany. Financing is not a constraint: net cash of about €85M and an undrawn €150M credit line. In 2025 it bought Corvane Logistics IT, an SAP supply chain boutique of similar size, a direct precedent for this deal.",
      fit: 93,
      deals: 14,
      lastDeal: "Sep 2025",
      hq: "Hamburg, DE",
      founded: 1994,
      aum: "€640M revenue",
      website: "nordwind-consulting.de",
    },
    {
      name: "Helix IT Services Group",
      types: "Strategic — IT services & integration",
      rationale:
        "Listed IT services group with €1.8B revenue that has made eight acquisitions since 2021, four of them SAP consultancies, under a published DACH buy-and-build plan. Consilio would add supply chain and production planning expertise, and its Bulgarian site would complement Helix's nearshore centre in Romania. Leverage is low (about 1.2× EBITDA), so a €30–60M deal can be funded from existing facilities.",
      fit: 89,
      deals: 21,
      lastDeal: "May 2026",
      hq: "Basel, CH",
      founded: 1988,
      aum: "€1.8B revenue",
      website: "helix-itservices.ch",
    },
    {
      name: "Merkur Digital Consulting GmbH",
      types: "Strategic — SAP consulting",
      rationale:
        "SAP Gold partner (€320M revenue) serving automotive and machinery clients. Strong interest in production planning, and its private equity owner has committed capital for add-ons, which covers financing. Some client overlap could make integration easier but also creates conflicts to check.",
      fit: 84,
      deals: 9,
      lastDeal: "Jan 2026",
      hq: "Stuttgart, DE",
      founded: 2001,
      aum: "€320M revenue",
      website: "merkur-digital.de",
    },
    {
      name: "Polaris Supply Chain Solutions",
      types: "Strategic — ERP & supply chain software",
      rationale:
        "Supply chain planning software vendor (€450M revenue) that wants more SAP implementation capacity for its own product. Sector interest is high; financing would need its new credit facility.",
      fit: 78,
      deals: 6,
      lastDeal: "Oct 2025",
      hq: "Munich, DE",
      founded: 1999,
      aum: "€450M revenue",
      website: "polaris-scs.de",
    },
  ],
};

function generatedRows(
  kind: Kind,
  seed: number,
  count: number,
  taken: Set<string>,
): Featured[] {
  const rand = seeded(seed);
  const { first, last } = NAMES[kind];
  const rows: Featured[] = [];
  while (rows.length < count) {
    const name = `${pick(rand, first)} ${pick(rand, last)}`;
    if (taken.has(name)) continue;
    taken.add(name);
    const slug = name
      .toLowerCase()
      .replace(/[^a-z]+/g, "")
      .slice(0, 16);
    const { types, rationale, fit } = pick(rand, TEMPLATES[kind])(rand);
    rows.push({
      name,
      types,
      rationale,
      fit,
      deals: Math.round(5 + rand() ** 2 * (kind === "financial" ? 160 : 40)),
      hq: pick(rand, HQS),
      founded: 1975 + Math.floor(rand() * 45),
      aum:
        kind === "financial"
          ? `€${(0.3 + rand() * 12).toFixed(1)}B AUM`
          : `€${Math.round(30 + rand() * 1800)}M revenue`,
      lastDeal: `${pick(rand, MONTHS)} ${2023 + Math.floor(rand() * 4)}`,
      website: `${slug}.com`,
    });
  }
  return rows;
}

// Featured buyers plus generated ones, ordered by fit like the agent would
// present them. Ids follow generation order, so data quality stays stable.
function buildRows(
  kind: Kind,
  seed: number,
  count: number,
  featured: Featured[] = [],
): BuyerRow[] {
  const taken = new Set(featured.map((f) => f.name));
  const all = [
    ...featured.map((f) => ({ ...f, featured: true })),
    ...generatedRows(kind, seed, count - featured.length, taken),
  ].map((row, i) => ({ ...row, id: `${seed}-${i}` }));
  return all
    .sort((a, b) => b.fit - a.fit)
    .map((row, index) => ({ ...row, index }));
}

export const BUYER_LISTS: BuyerList[] = [
  {
    id: "financial",
    title: "Financial buyers",
    unit: "buyers",
    total: 1662,
    rows: buildRows("financial", 7, 120, FEATURED.financial),
    versions: [
      {
        number: 4,
        author: "Agent",
        date: "30 Oct 2026, 09:12",
        message: "Removed the current owner and off-thesis investors",
        changes: 27,
        diff: { kind: "removedRows", count: 3 },
      },
      {
        number: 3,
        author: "Vanya Brucker",
        date: "29 Oct 2026, 18:40",
        message: "Relabelled inclusion rationale for web-found buyers",
        changes: 214,
        diff: { kind: "changedCells", key: "rationale", every: 4 },
      },
      {
        number: 2,
        author: "Agent",
        date: "29 Oct 2026, 16:05",
        message: "Added deal activity columns",
        changes: 3324,
        diff: { kind: "addedColumns", keys: ["deals", "lastDeal"] },
      },
      {
        number: 1,
        author: "Agent",
        date: "29 Oct 2026, 15:58",
        message: "Initial longlist from deal databases and registries",
        changes: 14958,
        diff: { kind: "addedRows" },
      },
    ],
    removedPool: buildRows("financial", 23, 3),
  },
  {
    id: "strategic",
    title: "Strategic buyers",
    unit: "buyers",
    total: 1608,
    rows: buildRows("strategic", 11, 110, FEATURED.strategic),
    versions: [
      {
        number: 4,
        author: "Vanya Brucker",
        date: "30 Oct 2026, 08:47",
        message: "Removed direct competitors with no M&A history",
        changes: 45,
        diff: { kind: "removedRows", count: 5 },
      },
      {
        number: 3,
        author: "Agent",
        date: "29 Oct 2026, 18:22",
        message: "Updated buyer types after segment review",
        changes: 402,
        diff: { kind: "changedCells", key: "types", every: 3 },
      },
      {
        number: 2,
        author: "Agent",
        date: "29 Oct 2026, 16:05",
        message: "Added last deal and headquarters columns",
        changes: 3216,
        diff: { kind: "addedColumns", keys: ["lastDeal", "hq"] },
      },
      {
        number: 1,
        author: "Agent",
        date: "29 Oct 2026, 15:58",
        message: "Initial longlist from deal databases and registries",
        changes: 14472,
        diff: { kind: "addedRows" },
      },
    ],
    removedPool: buildRows("strategic", 29, 5),
  },
];

// What the research "does", with the share of the run each step starts at.
export const RESEARCH_STEPS = [
  { at: 0, label: "Reading the mandate and target profile" },
  { at: 0.12, label: "Searching deal databases and company registries" },
  { at: 0.35, label: "Screening 4,212 companies against the buyer profiles" },
  { at: 0.6, label: "Verifying deal histories and ownership" },
  { at: 0.82, label: "Scoring fit and writing inclusion rationales" },
];

export const RESEARCH_DURATION_MS = 11000;

export type SortKey = Exclude<keyof BuyerRow, "id" | "index" | "featured">;

// Comparable value for sorting: numbers as-is, money and months parsed,
// everything else case-insensitive text.
export function sortValue(row: BuyerRow, key: SortKey): number | string {
  const v = row[key] ?? "";
  if (typeof v === "number") return v;
  if (key === "aum") {
    // "Not disclosed" sorts below every figure.
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
    if (Number.isNaN(n)) return -1;
    return v.includes("B") ? n * 1000 : n;
  }
  // "Mar 2026", or just a year when the month isn't known.
  if (key === "lastDeal")
    return Date.parse(/^\d{4}$/.test(v) ? `1 Jan ${v}` : `1 ${v}`);
  return v.toLowerCase();
}

export type DiffRow = BuyerRow & { removed?: boolean };

// Spreads a version's removed rows through the list so they show in place.
export function withRemovedRows(
  list: BuyerList,
  version: ListVersion,
  rows: BuyerRow[],
): DiffRow[] {
  if (version.diff.kind !== "removedRows") return rows;
  const out: DiffRow[] = [...rows];
  list.removedPool.slice(0, version.diff.count).forEach((row, i) => {
    out.splice(Math.min(out.length, 2 + i * 7), 0, {
      ...row,
      id: `removed-${row.id}`,
      removed: true,
    });
  });
  return out;
}

export type CellDiff =
  | { kind: "added" }
  | { kind: "removed" }
  | { kind: "changed"; old: string }
  | null;

// How one cell changed in this version, if at all.
export function cellDiff(
  list: BuyerList,
  version: ListVersion,
  row: DiffRow,
  key: SortKey,
): CellDiff {
  if (row.removed) return { kind: "removed" };
  const d = version.diff;
  if (d.kind === "addedRows") return { kind: "added" };
  if (d.kind === "addedColumns")
    return key !== "name" && d.keys.includes(key) ? { kind: "added" } : null;
  if (d.kind === "changedCells" && key === d.key && row.index % d.every === 1) {
    // The previous value: borrowed from another row, so it looks plausible.
    const donor =
      list.rows.find((r) => r[key] !== row[key] && r.index > row.index) ??
      list.rows[0];
    return { kind: "changed", old: String(donor[key]) };
  }
  return null;
}

// The third exchange: the user narrows the scope to Europe and asks for an
// "Owner likes Sauvignon" column (a joke requirement for the demo) that feeds
// into fit and rationale. The pass runs over REFINE_DURATION_MS; the table
// shows its stages via refineStage, and the finished lists become Version 5.

export const REFINE_STEPS = [
  { at: 0, label: "Reading the new scope" },
  { at: 0.15, label: "Removing buyers headquartered outside Europe" },
  { at: 0.4, label: "Adding the Owner likes Sauvignon column" },
  {
    at: 0.55,
    label:
      "Searching interviews, CRM notes and social posts for wine preferences",
  },
  { at: 0.85, label: "Rescoring fit and updating inclusion rationales" },
];

export const REFINE_DURATION_MS = 9000;

export const SAUVIGNON_COLUMN: Column = {
  key: "sauvignon",
  label: "Owner likes Sauvignon",
  group: "Buyer company information",
  width: 190,
};

// Progress at which each stage shows in the table.
const REMOVE_AT = 0.2;
const COLUMN_AT = 0.42;
const RESCORE_AT = 0.88;

const outsideEurope = (row: BuyerRow) => row.hq.endsWith(", US");

// FNV-1a → [0, 1), so every run finds the same preferences.
function hashUnit(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

// Mostly unknown: few owners leave a public trace of their taste in wine.
// BWK, the demo's star buyer, gets a Sauvignon Blanc lover (a joke, on request).
function sauvignonOf(row: BuyerRow): Sauvignon {
  if (row.name.startsWith("BWK")) return "Yes";
  const r = hashUnit(`${row.id}:sauvignon`);
  if (r < 0.62) return "Unknown";
  // The hand-written top buyers aren't knocked out by a no.
  if (r < 0.86 || row.featured) return "Yes";
  return "No";
}

const SAUVIGNON_NOTE: Record<Sauvignon, string> = {
  Yes: "Owner likes Sauvignon Blanc (CRM notes and a podcast interview), which adds to the fit.",
  No: "Owner has said they don't like Sauvignon Blanc, which counts heavily against the fit.",
  Unknown:
    "No trace of the owner's view on Sauvignon Blanc; worth asking before outreach.",
};

// A yes adds 2 points, a no takes 20 off; unknown leaves the score alone.
function rescored(row: BuyerRow): BuyerRow {
  const sauvignon = row.sauvignon ?? sauvignonOf(row);
  const fit =
    sauvignon === "Yes"
      ? Math.min(99, row.fit + 2)
      : sauvignon === "No"
        ? Math.max(0, row.fit - 20)
        : row.fit;
  return {
    ...row,
    sauvignon,
    fit,
    rationale: `${row.rationale} ${SAUVIGNON_NOTE[sauvignon]}`,
  };
}

const REFINE_VERSION: Record<BuyerList["id"], Omit<ListVersion, "changes">> = {
  financial: {
    number: 5,
    author: "Agent",
    date: "30 Oct 2026, 11:04",
    message: "Europe only; added Owner likes Sauvignon",
    diff: { kind: "addedColumns", keys: ["sauvignon"] },
  },
  strategic: {
    number: 5,
    author: "Agent",
    date: "30 Oct 2026, 11:04",
    message: "Europe only; added Owner likes Sauvignon",
    diff: { kind: "addedColumns", keys: ["sauvignon"] },
  },
};

export type RefineStage = {
  /** The list as the table should show it at this point of the pass. */
  list: BuyerList;
  /** Whether the Sauvignon column has appeared yet. */
  showColumn: boolean;
};

/** The list partway through (or after) the refine pass. */
export function refineStage(
  base: BuyerList,
  progress: number,
  done: boolean,
): RefineStage {
  const kept = base.rows.filter((r) => !outsideEurope(r));
  const share = kept.length / base.rows.length;
  const total = Math.round(base.total * share);
  if (done || progress >= RESCORE_AT) {
    const rows = kept
      .map(rescored)
      .sort((a, b) => b.fit - a.fit)
      .map((row, index) => ({ ...row, index }));
    const removed = base.total - total;
    const version: ListVersion = {
      ...REFINE_VERSION[base.id],
      // Every cell of a removed row, plus the new column and rescored fit.
      changes: removed * (COLUMNS.length + 1) + total * 2,
    };
    return {
      list: {
        ...base,
        rows,
        total,
        versions: done ? [version, ...base.versions] : base.versions,
      },
      showColumn: true,
    };
  }
  if (progress < REMOVE_AT) return { list: base, showColumn: false };
  // The column fills in from the top as the preferences are found.
  const filled = Math.max(
    0,
    Math.floor(
      (kept.length * (progress - COLUMN_AT)) / (RESCORE_AT - COLUMN_AT),
    ),
  );
  return {
    list: {
      ...base,
      total,
      rows: kept.map((row, i) =>
        i < filled ? { ...row, sauvignon: sauvignonOf(row) } : row,
      ),
    },
    showColumn: progress >= COLUMN_AT,
  };
}

/** Counts for the agent's summary of the pass. */
export function refineSummary() {
  const [financial, strategic] = (["financial", "strategic"] as const).map(
    (id) => {
      const base = BUYER_LISTS.find((l) => l.id === id)!;
      const { list } = refineStage(base, 1, true);
      return { removed: base.total - list.total, total: list.total };
    },
  );
  return { financial, strategic };
}

// The fourth exchange: the user drops a spreadsheet with one buyer and asks
// to merge it. The file isn't read; the demo file always holds this row.

export const MERGE_OPTIONS = [
  "Merge into Financial buyers",
  "Create a new list",
  "Cancel",
] as const;

export const MERGE_QUESTION: ScopingQuestion = {
  label: "Merge",
  question: "What should I do with it?",
  options: [...MERGE_OPTIONS],
};

export const MERGE_STEPS = [
  { at: 0, label: "Reading the uploaded file" },
  { at: 0.25, label: "Matching its columns to the financial buyers list" },
  { at: 0.5, label: "Checking for duplicates" },
  { at: 0.72, label: "Scoring fit and writing the rationale" },
];

export const MERGE_DURATION_MS = 6000;

export const MERGED_ROW_ID = "merged-0";

// The file only has a name and a type; the other cells stay empty.
const EMPTY = "" as unknown as number;

/** The financial list with the merged row on top, as a new version. */
export function withMergedRow(list: BuyerList, file: string): BuyerList {
  if (list.id !== "financial") return list;
  const row: BuyerRow = {
    id: MERGED_ROW_ID,
    index: -1,
    name: "Vanya Brucker",
    types: "Angel Investor",
    rationale: "Likes Sauvignon",
    fit: 99,
    sauvignon: "Yes",
    // Hand-entered, so it carries no quality flags.
    featured: true,
    deals: EMPTY,
    hq: "",
    founded: EMPTY,
    aum: "",
    lastDeal: "",
    website: "",
  };
  return {
    ...list,
    rows: [row, ...list.rows],
    total: list.total + 1,
    versions: [
      {
        number: list.versions[0].number + 1,
        author: "Agent",
        date: "30 Oct 2026, 11:20",
        message: `Merged 1 row from ${file}`,
        changes: COLUMNS.length + 2,
        diff: { kind: "addedRows" },
      },
      ...list.versions,
    ],
  };
}
