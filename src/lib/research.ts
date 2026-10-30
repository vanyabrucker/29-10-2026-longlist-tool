// Fake research output: two buyer lists generated from a fixed seed, so the
// demo shows the same plausible-looking (but fictional) companies every time.

export type BuyerRow = {
  id: string;
  /** Position in the generated list; diffs are keyed on it. */
  index: number;
  name: string;
  types: string;
  rationale: string;
  deals: number;
  hq: string;
  founded: number;
  aum: string;
  lastDeal: string;
  website: string;
};

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
  title: string;
  unit: string;
  total: number;
  rows: BuyerRow[];
  /** Newest first; the first entry is the latest version. */
  versions: ListVersion[];
  /** Rows that later versions removed, shown struck through in their diff. */
  removedPool: BuyerRow[];
};

export type Column = {
  key: Exclude<keyof BuyerRow, "id" | "index" | "name">;
  label: string;
  group: string;
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
  "Zurich, CH",
  "Geneva, CH",
  "London, UK",
  "Munich, DE",
  "Frankfurt, DE",
  "Paris, FR",
  "Amsterdam, NL",
  "Stockholm, SE",
  "Milan, IT",
  "New York, US",
  "Boston, US",
  "San Francisco, US",
  "Vienna, AT",
  "Copenhagen, DK",
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

const FIN_FIRST = [
  "Alpine Peak",
  "Lakeview",
  "Granite",
  "Northgate",
  "Ridgeway",
  "Silverline",
  "Bergmann",
  "Harbourside",
  "Kestrel",
  "Meridian",
  "Larchmont",
  "Edelweiss",
  "Fjord",
  "Cobalt",
  "Ashford",
  "Brightwater",
  "Summit Crest",
  "Rheinland",
  "Oakhurst",
  "Westbrook",
  "Tessin",
  "Aurelius",
  "Pinecrest",
  "Montrose",
];
const FIN_LAST = [
  "Capital",
  "Equity Partners",
  "Growth Partners",
  "Capital Partners, LLC",
  "Investment Corp",
  "Partners",
  "Private Equity",
  "Growth Equity Fund IV",
  "Holdings AG",
  "Ventures",
];
const FIN_TYPES = [
  "Growth Equity, Private Equity",
  "Private Equity",
  "Growth Equity",
  "Family Office, Venture Capital",
  "Investment Holding Company",
  "Private Equity, Venture Capital",
  "Venture Capital",
];
const FIN_RATIONALE = [
  "Global search — all geographies",
  "Global search — all geographies",
  "Global search — all geographies",
  "Found by Helios agentic search",
  "Sector thesis — B2B software",
  "Prior deal in adjacent segment",
];

const STR_FIRST = [
  "Nordwind",
  "Helix",
  "Corvane",
  "Atlas",
  "Solano",
  "Brightline",
  "Vantor",
  "Quorum",
  "Lumen",
  "Stellar",
  "Arcadia",
  "Polaris",
  "Tandem",
  "Orbis",
  "Calyx",
  "Veritas",
  "Halden",
  "Merkur",
  "Sentinel",
  "Zephyr",
];
const STR_LAST = [
  "Software AG",
  "Systems",
  "Technologies",
  "Cloud Inc",
  "Group",
  "Labs",
  "Solutions GmbH",
  "Digital",
  "Platforms Ltd",
  "Networks",
];
const STR_TYPES = [
  "Strategic — enterprise software",
  "Strategic — CRM & front office",
  "Strategic — marketing automation",
  "Strategic — SMB platforms",
  "Strategic — IT services",
];
const STR_RATIONALE = [
  "Adjacent product line",
  "Direct competitor",
  "Recent acquirer in segment",
  "Customer overlap — mid-market",
  "Found by Helios agentic search",
];

function buildRows(
  seed: number,
  count: number,
  first: readonly string[],
  last: readonly string[],
  types: readonly string[],
  rationale: readonly string[],
  financial: boolean,
): BuyerRow[] {
  const rand = seeded(seed);
  const seen = new Set<string>();
  const rows: BuyerRow[] = [];
  while (rows.length < count) {
    const name = `${pick(rand, first)} ${pick(rand, last)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const slug = name
      .toLowerCase()
      .replace(/[^a-z]+/g, "")
      .slice(0, 16);
    rows.push({
      id: `${seed}-${rows.length}`,
      index: rows.length,
      name,
      types: pick(rand, types),
      rationale: pick(rand, rationale),
      deals: Math.round(5 + rand() ** 2 * 420),
      hq: pick(rand, HQS),
      founded: 1975 + Math.floor(rand() * 45),
      aum: financial
        ? `$${(0.4 + rand() * 38).toFixed(1)}B AUM`
        : `$${Math.round(40 + rand() * 4800)}M revenue`,
      lastDeal: `${pick(rand, MONTHS)} ${2023 + Math.floor(rand() * 4)}`,
      website: `${slug}.com`,
    });
  }
  return rows;
}

export const BUYER_LISTS: BuyerList[] = [
  {
    id: "financial",
    title: "Financial buyers",
    unit: "buyers",
    total: 1662,
    rows: buildRows(
      7,
      120,
      FIN_FIRST,
      FIN_LAST,
      FIN_TYPES,
      FIN_RATIONALE,
      true,
    ),
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
    removedPool: buildRows(
      23,
      3,
      FIN_FIRST,
      FIN_LAST,
      FIN_TYPES,
      FIN_RATIONALE,
      true,
    ),
  },
  {
    id: "strategic",
    title: "Strategic buyers",
    unit: "buyers",
    total: 1608,
    rows: buildRows(
      11,
      110,
      STR_FIRST,
      STR_LAST,
      STR_TYPES,
      STR_RATIONALE,
      false,
    ),
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
    removedPool: buildRows(
      29,
      5,
      STR_FIRST,
      STR_LAST,
      STR_TYPES,
      STR_RATIONALE,
      false,
    ),
  },
];

// What the research "does", with the share of the run each step starts at.
export const RESEARCH_STEPS = [
  { at: 0, label: "Reading the mandate and target profile" },
  { at: 0.12, label: "Searching deal databases and company registries" },
  { at: 0.35, label: "Screening 4,212 companies for sector and size fit" },
  { at: 0.6, label: "Verifying deal histories and ownership" },
  { at: 0.82, label: "Building the strategic and financial buyer lists" },
];

export const RESEARCH_DURATION_MS = 11000;

export type SortKey = Exclude<keyof BuyerRow, "id" | "index">;

// Comparable value for sorting: numbers as-is, money and months parsed,
// everything else case-insensitive text.
export function sortValue(row: BuyerRow, key: SortKey): number | string {
  const v = row[key];
  if (typeof v === "number") return v;
  if (key === "aum") {
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
    return v.includes("B") ? n * 1000 : n;
  }
  if (key === "lastDeal") return Date.parse(`1 ${v}`);
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
