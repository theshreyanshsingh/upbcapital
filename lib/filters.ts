import { money } from "@/lib/format";
import { FORECLOSURES, labelOf, LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, PROPERTY_TYPES, US_STATES } from "@/lib/labels";
import { listingFigures } from "@/lib/metrics";
import { typedNumber } from "@/lib/money";

// A filter that takes several values matches any one of them. Older saved searches hold a single string.
type Many = string | string[];
export type Flag = "yes" | "no";

export type BookFilters = {
  state?: string;
  paymentStatus?: Many;
  lienPosition?: Many;
  propertyType?: Many;
  upbMin?: number;
  upbMax?: number;
  priceMin?: number;
  priceMax?: number;
  kind?: string;
  q?: string;
  // Facts from the loan file and tape v2.
  occupancy?: Many;
  foreclosureStatus?: Many;
  dlqMin?: number;
  dlqMax?: number;
  modified?: Flag;
  bankruptcy?: Flag;
  hoaLien?: Flag;
  taxDelinquent?: Flag;
  // How the listing trades.
  bidMode?: Many;
  deadline?: Flag;
  status?: string;
  // Figures beyond balance and price.
  rateMin?: number;
  rateMax?: number;
  ptuMin?: number;
  ptuMax?: number;
  yieldMin?: number;
  yieldMax?: number;
  valueMin?: number;
  valueMax?: number;
};

export const BID_MODES = [
  { value: "NONE", label: "Open offers" },
  { value: "SEALED", label: "Sealed bid" },
  { value: "BEST_AND_FINAL", label: "Best and final" },
] as const;

export const BOOK_STATUSES = [
  { value: "APPROVED", label: "Live" },
  { value: "PENDING", label: "In contract" },
] as const;

export const KINDS = [
  { value: "SINGLE", label: "Notes" },
  { value: "POOL", label: "Pools" },
] as const;

export const MULTI_KEYS = ["paymentStatus", "lienPosition", "propertyType", "occupancy", "foreclosureStatus", "bidMode"] as const;
export type MultiKey = (typeof MULTI_KEYS)[number];
export const FLAG_KEYS = ["modified", "bankruptcy", "hoaLien", "taxDelinquent", "deadline"] as const;

// Every figure a free member sees veiled. Filtering on one would reveal it, so these apply on Pro only.
export const FIGURE_KEYS = ["upbMin", "upbMax", "priceMin", "priceMax", "rateMin", "rateMax", "ptuMin", "ptuMax", "yieldMin", "yieldMax", "valueMin", "valueMax"] as const;

// Facts that show only on a listing the viewer can open: its loan file and tape flags.
export const FILE_KEYS = ["occupancy", "foreclosureStatus", "dlqMin", "dlqMax", "modified", "bankruptcy", "hoaLien", "taxDelinquent"] as const;

const KEY_ORDER: (keyof BookFilters)[] = [
  "q", "state", "kind", "status", "paymentStatus", "lienPosition", "propertyType", "occupancy", "foreclosureStatus",
  "dlqMin", "dlqMax", "modified", "bankruptcy", "hoaLien", "taxDelinquent", "bidMode", "deadline",
  "upbMin", "upbMax", "priceMin", "priceMax", "rateMin", "rateMax", "ptuMin", "ptuMax", "yieldMin", "yieldMax", "valueMin", "valueMax",
];

const CHOICES: Record<MultiKey, readonly { value: string }[]> = {
  paymentStatus: PAYMENT_STATUSES,
  lienPosition: LIEN_POSITIONS,
  propertyType: PROPERTY_TYPES,
  occupancy: OCCUPANCIES,
  foreclosureStatus: FORECLOSURES,
  bidMode: BID_MODES,
};

type Raw = Record<string, string | string[] | undefined>;

// Reads the address bar or a saved search. Anything that isn't a known value is no filter rather than an error.
export function parseFilters(input: Raw): BookFilters {
  const first = (key: string) => {
    const value = input[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  };
  const many = (key: MultiKey) => {
    const picked = new Set(listOf(input[key]));
    const known = CHOICES[key].map((choice) => choice.value).filter((value) => picked.has(value));
    return known.length ? known : undefined;
  };
  const amount = (key: string) => {
    const parsed = typedNumber(first(key));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  // Months behind may be zero: "at most 0 months late" means current.
  const months = (key: string) => {
    const raw = first(key);
    if (raw == null) return undefined;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 600 ? parsed : undefined;
  };
  const flag = (key: string): Flag | undefined => {
    const value = first(key);
    return value === "yes" || value === "no" ? value : undefined;
  };
  const oneOf = (key: string, allowed: readonly { value: string }[]) => {
    const value = first(key);
    return allowed.some((choice) => choice.value === value) ? value : undefined;
  };
  const state = first("state")?.toUpperCase();
  const dlqMin = months("dlqMin");
  const filters: BookFilters = {
    state: state && (US_STATES as readonly string[]).includes(state) ? state : undefined,
    paymentStatus: many("paymentStatus"),
    lienPosition: many("lienPosition"),
    propertyType: many("propertyType"),
    upbMin: amount("upbMin"),
    upbMax: amount("upbMax"),
    priceMin: amount("priceMin"),
    priceMax: amount("priceMax"),
    kind: oneOf("kind", KINDS),
    q: first("q")?.slice(0, 80),
    occupancy: many("occupancy"),
    foreclosureStatus: many("foreclosureStatus"),
    dlqMin: dlqMin ? dlqMin : undefined,
    dlqMax: months("dlqMax"),
    modified: flag("modified"),
    bankruptcy: flag("bankruptcy"),
    hoaLien: flag("hoaLien"),
    taxDelinquent: flag("taxDelinquent"),
    bidMode: many("bidMode"),
    deadline: flag("deadline"),
    status: oneOf("status", BOOK_STATUSES),
    rateMin: amount("rateMin"),
    rateMax: amount("rateMax"),
    ptuMin: amount("ptuMin"),
    ptuMax: amount("ptuMax"),
    yieldMin: amount("yieldMin"),
    yieldMax: amount("yieldMax"),
    valueMin: amount("valueMin"),
    valueMax: amount("valueMax"),
  };
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as BookFilters;
}

// A saved search's JSON, back into filters. Numbers and lists come back through the same parser as the URL.
export function filtersFromSaved(json: unknown): BookFilters {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  return parseFilters(Object.fromEntries(Object.entries(json).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.map(String) : value == null ? undefined : String(value),
  ])));
}

export function listOf(value: Many | undefined | null): string[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : String(value).split(",")).map((item) => String(item).trim()).filter(Boolean);
}

function active(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== "";
}

export function filtersActive(filters: BookFilters) {
  return Object.values(filters).some(active);
}

export function fileFiltersActive(filters: BookFilters) {
  return FILE_KEYS.some((key) => active(filters[key]));
}

export type MatchNote = {
  city: string;
  state: string;
  paymentStatus: string;
  lienPosition: string;
  propertyType: string;
  upb: number;
  askingPrice: number;
  tradeStatus?: string;
  // The rest is optional, since some callers pass only the card's fields. A filter on a fact the caller left
  // out never matches, so a saved search can't alert on something nobody checked.
  occupancy?: string;
  foreclosureStatus?: string;
  monthsDelinquent?: number;
  interestRate?: number;
  monthlyPi?: number;
  estimatedValue?: number;
  modified?: boolean | null;
  bankruptcyChapter?: string | null;
  bankruptcyFiledAt?: Date | string | null;
  hoaLien?: boolean | null;
  taxDelinquent?: boolean | null;
};

export type MatchListing = {
  kind: string;
  notes: MatchNote[];
  status?: string;
  bidMode?: string;
  bidDeadline?: Date | string | null;
};

function inList(value: string | undefined, wanted: Many | undefined) {
  const list = listOf(wanted);
  return list.length === 0 || (value !== undefined && list.includes(value));
}

function inRange(value: number | null | undefined, min?: number, max?: number) {
  if (min == null && max == null) return true;
  if (value == null || !Number.isFinite(value)) return false;
  return (min == null || value >= min) && (max == null || value <= max);
}

// "no" means the tape doesn't mark it, which is not the same as the desk having checked.
function flagMatches(value: boolean | null | undefined, wanted?: Flag) {
  if (!wanted) return true;
  if (value === undefined) return false;
  return wanted === "yes" ? value === true : value !== true;
}

function bankruptcyOf(note: MatchNote) {
  if (note.bankruptcyChapter === undefined && note.bankruptcyFiledAt === undefined) return undefined;
  return Boolean(note.bankruptcyChapter || note.bankruptcyFiledAt);
}

function deadlineOf(listing: MatchListing) {
  if (listing.bidDeadline === undefined) return undefined;
  return Boolean(listing.bidDeadline) && listing.bidMode !== "NONE";
}

export function noteMatches(note: MatchNote, filters: BookFilters) {
  if (filters.state && note.state !== filters.state) return false;
  if (!inList(note.paymentStatus, filters.paymentStatus)) return false;
  if (!inList(note.lienPosition, filters.lienPosition)) return false;
  if (!inList(note.propertyType, filters.propertyType)) return false;
  if (!inRange(note.upb, filters.upbMin, filters.upbMax)) return false;
  if (!inRange(note.askingPrice, filters.priceMin, filters.priceMax)) return false;
  if (filters.q && !`${note.city} ${note.state}`.toLowerCase().includes(filters.q.toLowerCase())) return false;
  if (!inList(note.occupancy, filters.occupancy)) return false;
  if (!inList(note.foreclosureStatus, filters.foreclosureStatus)) return false;
  if (!inRange(note.monthsDelinquent, filters.dlqMin, filters.dlqMax)) return false;
  if (!inRange(note.interestRate, filters.rateMin, filters.rateMax)) return false;
  if (!flagMatches(note.modified, filters.modified)) return false;
  if (!flagMatches(bankruptcyOf(note), filters.bankruptcy)) return false;
  if (!flagMatches(note.hoaLien, filters.hoaLien)) return false;
  if (!flagMatches(note.taxDelinquent, filters.taxDelinquent)) return false;
  return true;
}

// A listing is judged on what its row shows. A pool's balance, price, ratio, yield and value are the totals of
// the loans still for sale, while place, performance, lien, property and the file's facts can match any one loan.
export function listingMatches(listing: MatchListing, filters: BookFilters) {
  if (filters.kind && listing.kind !== filters.kind) return false;
  if (filters.status && listing.status !== filters.status) return false;
  if (!inList(listing.bidMode, filters.bidMode)) return false;
  if (!flagMatches(deadlineOf(listing), filters.deadline)) return false;
  const open = listing.notes.filter((note) => !note.tradeStatus || note.tradeStatus === "AVAILABLE");
  const notes = open.length ? open : listing.notes;
  const { ptuMin, ptuMax, yieldMin, yieldMax, valueMin, valueMax } = filters;
  if ([ptuMin, ptuMax, yieldMin, yieldMax, valueMin, valueMax].some((value) => value != null)) {
    if (notes.some((note) => note.monthlyPi === undefined || note.estimatedValue === undefined || note.interestRate === undefined)) return false;
    const figures = listingFigures(listing.kind, notes.map((note) => ({
      upb: note.upb,
      askingPrice: note.askingPrice,
      estimatedValue: note.estimatedValue ?? 0,
      monthlyPi: note.monthlyPi ?? 0,
      interestRate: note.interestRate ?? 0,
      paymentStatus: note.paymentStatus,
    })));
    if (!inRange(figures.priceToUpb, ptuMin, ptuMax) || !inRange(figures.yield, yieldMin, yieldMax) || !inRange(figures.value, valueMin, valueMax)) return false;
  }
  if (listing.kind !== "POOL") return notes.some((note) => noteMatches(note, filters));
  const { upbMin, upbMax, priceMin, priceMax, ...rest } = filters;
  const upb = notes.reduce((sum, note) => sum + note.upb, 0);
  const price = notes.reduce((sum, note) => sum + note.askingPrice, 0);
  if (!inRange(upb, upbMin, upbMax) || !inRange(price, priceMin, priceMax)) return false;
  return notes.some((note) => noteMatches(note, rest));
}

// Balance, price, rate, ratio, yield and value filters would reveal the figures free members see veiled, so they
// apply on Pro only.
export function filtersFor(filters: BookFilters, pro: boolean): BookFilters {
  if (pro) return filters;
  const veiled: BookFilters = { ...filters, upbMin: undefined, upbMax: undefined, priceMin: undefined, priceMax: undefined };
  for (const key of FIGURE_KEYS) if (key in veiled) veiled[key] = undefined;
  return veiled;
}

// A held listing can't be screened on its loan file without telling a free member what the file says. With any
// file filter on, it drops out of the results instead.
export function bookMatches(listing: MatchListing, filters: BookFilters, held: boolean) {
  if (held && fileFiltersActive(filters)) return false;
  return listingMatches(listing, filters);
}

export type BookRow = { listing: MatchListing; held: boolean };

// How many listings a chip would leave, given every other filter. Picking it replaces that filter's choices.
export function facetCount(rows: BookRow[], filters: BookFilters, key: MultiKey | "kind" | "status" | "deadline", value: string) {
  const probe: BookFilters = { ...filters, [key]: (MULTI_KEYS as readonly string[]).includes(key) ? [value] : value };
  return rows.filter((row) => bookMatches(row.listing, probe, row.held)).length;
}

// Listings by state for the map, with every filter but the state. A pool counts once in each state it lends in.
export function stateCounts(rows: BookRow[], filters: BookFilters) {
  const probe: BookFilters = { ...filters, state: undefined };
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!bookMatches(row.listing, probe, row.held)) continue;
    const open = row.listing.notes.filter((note) => !note.tradeStatus || note.tradeStatus === "AVAILABLE");
    for (const state of new Set((open.length ? open : row.listing.notes).map((note) => note.state))) {
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
  }
  return counts;
}

// The filters as a query string, in one fixed order so the same view always has the same address.
export function filtersQuery(filters: BookFilters) {
  const search = new URLSearchParams();
  for (const key of KEY_ORDER) {
    const value = filters[key];
    if (Array.isArray(value)) value.forEach((item) => search.append(key, item));
    else if (value !== undefined && value !== "") search.set(key, String(value));
  }
  return search;
}

// Adds a value to a filter's choices, or takes it off.
export function toggleValue(filters: BookFilters, key: MultiKey, value: string): BookFilters {
  const current = listOf(filters[key]);
  const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
  return { ...filters, [key]: next.length ? next : undefined };
}

const FLAG_COPY: Record<(typeof FLAG_KEYS)[number], [string, string]> = {
  modified: ["Modified", "Not marked modified"],
  bankruptcy: ["Bankruptcy on the tape", "No bankruptcy on the tape"],
  hoaLien: ["HOA lien", "No HOA lien marked"],
  taxDelinquent: ["Tax delinquent", "No tax delinquency marked"],
  deadline: ["Dated deadline", "No deadline"],
};

function choiceLabel(key: MultiKey, value: string) {
  if (key === "bidMode") return BID_MODES.find((mode) => mode.value === value)?.label ?? value;
  if (key === "lienPosition") return `${labelOf("lien", value)} lien`;
  if (key === "foreclosureStatus") return `Foreclosure: ${labelOf("foreclosure", value)}`;
  if (key === "occupancy") return labelOf("occupancy", value);
  if (key === "propertyType") return labelOf("property", value);
  return labelOf("payment", value);
}

function rangeLabel(name: string, min: number | undefined, max: number | undefined, show: (value: number) => string) {
  if (min != null && max != null) return `${name} ${show(min)} to ${show(max)}`;
  if (min != null) return `${name} from ${show(min)}`;
  return `${name} up to ${show(max as number)}`;
}

// The applied filters as removable chips: what each says, and the filters left once it is removed.
export function appliedChips(filters: BookFilters) {
  const chips: { label: string; without: BookFilters }[] = [];
  const drop = (...keys: (keyof BookFilters)[]) => {
    const next = { ...filters };
    keys.forEach((key) => delete next[key]);
    return next;
  };
  for (const key of KEY_ORDER) {
    const value = filters[key];
    if (!active(value)) continue;
    if ((MULTI_KEYS as readonly string[]).includes(key)) {
      for (const item of listOf(value as Many)) chips.push({ label: choiceLabel(key as MultiKey, item), without: toggleValue(filters, key as MultiKey, item) });
    } else if ((FLAG_KEYS as readonly string[]).includes(key)) {
      const [yes, no] = FLAG_COPY[key as (typeof FLAG_KEYS)[number]];
      chips.push({ label: value === "yes" ? yes : no, without: drop(key) });
    } else if (key === "q") chips.push({ label: `Place: ${value}`, without: drop("q") });
    else if (key === "state") chips.push({ label: String(value), without: drop("state") });
    else if (key === "kind") chips.push({ label: KINDS.find((kind) => kind.value === value)?.label ?? String(value), without: drop("kind") });
    else if (key === "status") chips.push({ label: BOOK_STATUSES.find((status) => status.value === value)?.label ?? String(value), without: drop("status") });
  }
  if (filters.dlqMin != null || filters.dlqMax != null) {
    const { dlqMin: low, dlqMax: high } = filters;
    const label = low != null && high != null ? `${low} to ${high} months late` : low != null ? `${low}+ months late` : high === 0 ? "Current, 0 months late" : `Up to ${high} months late`;
    chips.push({ label, without: drop("dlqMin", "dlqMax") });
  }
  const ranges: [string, keyof BookFilters, keyof BookFilters, (value: number) => string][] = [
    ["UPB", "upbMin", "upbMax", (value) => money(value)],
    ["Price", "priceMin", "priceMax", (value) => money(value)],
    ["Note rate", "rateMin", "rateMax", (value) => `${value}%`],
    ["Price / UPB", "ptuMin", "ptuMax", (value) => `${value}%`],
    ["Yield", "yieldMin", "yieldMax", (value) => `${value}%`],
    ["Value", "valueMin", "valueMax", (value) => money(value)],
  ];
  for (const [name, min, max, show] of ranges) {
    const low = filters[min] as number | undefined;
    const high = filters[max] as number | undefined;
    if (low == null && high == null) continue;
    chips.push({ label: rangeLabel(name, low, high, show), without: drop(min, max) });
  }
  return chips;
}

export const SORTS = [
  { value: "new", label: "Newest", pro: false, dir: "desc" },
  { value: "deadline", label: "Deadline soonest", pro: false, dir: "asc" },
  { value: "state", label: "State", pro: false, dir: "asc" },
  { value: "discount", label: "Deepest discount", pro: true, dir: "asc" },
  { value: "yield", label: "Highest yield", pro: true, dir: "desc" },
  { value: "upb", label: "Largest UPB", pro: true, dir: "desc" },
  { value: "ask", label: "Largest ask", pro: true, dir: "desc" },
  { value: "value", label: "Largest value", pro: true, dir: "desc" },
] as const;

export type SortKey = (typeof SORTS)[number]["value"];
export type BookSort = { key: SortKey; dir: "asc" | "desc" };

export function defaultDir(key: SortKey) {
  return SORTS.find((sort) => sort.value === key)?.dir ?? "desc";
}

// Ordering by a figure would rank what a free member sees veiled, so those orders are Pro only.
export function sortFor(raw: string | undefined, rawDir: string | undefined, pro: boolean): BookSort {
  const spec = SORTS.find((sort) => sort.value === raw);
  if (!spec || (spec.pro && !pro)) return { key: "new", dir: "desc" };
  return { key: spec.value, dir: rawDir === "asc" || rawDir === "desc" ? rawDir : spec.dir };
}

export type SortRow = {
  approvedAt: number;
  deadline: number | null;
  state: string;
  figures: { upb: number; asking: number; value: number; priceToUpb: number | null; yield: number | null };
};

function sortValue(row: SortRow, key: SortKey): number | string | null {
  if (key === "new") return row.approvedAt;
  if (key === "deadline") return row.deadline;
  if (key === "state") return row.state || null;
  if (key === "discount") return row.figures.priceToUpb;
  if (key === "yield") return row.figures.yield;
  if (key === "upb") return row.figures.upb;
  if (key === "ask") return row.figures.asking;
  return row.figures.value;
}

// Rows with nothing to sort on go last in either direction, then newest first.
export function sortRows<T extends SortRow>(rows: T[], sort: BookSort): T[] {
  const newest = (a: T, b: T) => b.approvedAt - a.approvedAt;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x == null || y == null) return x == null && y == null ? newest(a, b) : x == null ? 1 : -1;
    const order = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y;
    return (sort.dir === "asc" ? order : -order) || newest(a, b);
  });
}

// The page a link asked for, kept inside the pages there are. "Showing 13–24 of 31" is always true.
export function pageWindow(total: number, raw: string | undefined, size: number) {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const asked = Math.floor(Number(raw || "1"));
  const page = Math.min(pageCount, Math.max(1, Number.isFinite(asked) ? asked : 1));
  const start = (page - 1) * size;
  return { page, pageCount, start, end: Math.min(total, start + size), first: total ? start + 1 : 0 };
}
