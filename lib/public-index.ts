import type { Prisma } from "@prisma/client";
import { unset } from "@/lib/db-filters";
import { labelOf, LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { publicListing } from "@/lib/private-listings";
import { upbBucket } from "@/lib/strata";

// The public inventory index at /open, and the listings a deal announcement may name: live, public, and past any
// launch time. A card shows only what the listing's own /open/[id] page already shows: city and state, lien,
// performance, collateral type and a UPB band. Never the street, the borrower, the price or the seller.

export const INDEX_PAGE_SIZE = 24;
// The index reads at most this many listings before it filters by band and pages.
const INDEX_SCAN = 1000;

// The bands are upbBucket's, so a card and its filter always agree.
export const BALANCE_BANDS = [
  { value: "under-100k", label: upbBucket(0) },
  { value: "100-250k", label: upbBucket(100_000) },
  { value: "250-500k", label: upbBucket(250_000) },
  { value: "500k-up", label: upbBucket(500_000) },
] as const;

// Approved, public, and not waiting on a launch time. Merged with AND, so a caller's own OR stays its own.
export function liveListingWhere(now = new Date()): Prisma.ListingWhereInput {
  return {
    status: "APPROVED",
    AND: [publicListing(), { OR: [...unset("launchAt").OR, { launchAt: { lte: now } }] }],
  };
}

export type IndexFilters = { state: string; lien: string; performance: string; band: string; page: number };

function pick(value: unknown, allowed: readonly string[]) {
  const text = typeof value === "string" ? value : Array.isArray(value) ? String(value[0] ?? "") : "";
  return allowed.includes(text) ? text : "";
}

// Anything not on the lists reads as no filter, so a hand-edited address can't reach the query.
export function readIndexFilters(params: Record<string, string | string[] | undefined>): IndexFilters {
  const rawPage = Number(typeof params.page === "string" ? params.page : "1");
  return {
    state: pick(typeof params.state === "string" ? params.state.toUpperCase() : "", US_STATES),
    lien: pick(params.lien, LIEN_POSITIONS.map((item) => item.value)),
    performance: pick(params.performance, PAYMENT_STATUSES.map((item) => item.value)),
    band: pick(params.band, BALANCE_BANDS.map((item) => item.value)),
    page: Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 1000 ? rawPage : 1,
  };
}

type IndexLoan = { city: string; state: string; lienPosition: string; paymentStatus: string; propertyType: string; upb: unknown };
type IndexRow = { id: string; kind: string; notes: IndexLoan[] };

export type IndexCard = {
  id: string;
  kind: "Note" | "Pool";
  city: string;
  state: string;
  states: string;
  loans: number;
  lien: string;
  performance: string;
  collateral: string;
  band: string;
};

// The same reading as /open/[id]: the largest loan leads, and a pool's band is its total.
export function indexCard(listing: IndexRow): IndexCard | null {
  if (!listing.notes.length) return null;
  const lead = [...listing.notes].sort((a, b) => Number(b.upb) - Number(a.upb))[0];
  const total = listing.notes.reduce((sum, note) => sum + Number(note.upb), 0);
  const pool = listing.kind === "POOL";
  return {
    id: listing.id,
    kind: pool ? "Pool" : "Note",
    city: lead.city,
    state: lead.state,
    states: [...new Set(listing.notes.map((note) => note.state))].join(", "),
    loans: listing.notes.length,
    lien: labelOf("lien", lead.lienPosition),
    performance: labelOf("payment", lead.paymentStatus),
    collateral: labelOf("property", lead.propertyType),
    band: upbBucket(pool ? total : Number(lead.upb)),
  };
}

const CARD_SELECT = {
  id: true,
  kind: true,
  notes: { select: { city: true, state: true, lienPosition: true, paymentStatus: true, propertyType: true, upb: true } },
} as const;

export type IndexPage = { cards: IndexCard[]; total: number; page: number; pages: number };

export async function loadIndex(filters: IndexFilters, now = new Date()): Promise<IndexPage> {
  const loan: Prisma.NoteWhereInput = {
    ...(filters.state ? { state: filters.state } : {}),
    ...(filters.lien ? { lienPosition: filters.lien as "FIRST" } : {}),
    ...(filters.performance ? { paymentStatus: filters.performance as "PERFORMING" } : {}),
  };
  const rows = await prisma.listing.findMany({
    where: { ...liveListingWhere(now), notes: { some: loan } },
    select: CARD_SELECT,
    orderBy: { approvedAt: "desc" },
    take: INDEX_SCAN,
  });
  const band = BALANCE_BANDS.find((item) => item.value === filters.band)?.label;
  const cards = rows.map(indexCard).filter((card): card is IndexCard => card != null && (!band || card.band === band));
  const pages = Math.max(1, Math.ceil(cards.length / INDEX_PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  return { cards: cards.slice((page - 1) * INDEX_PAGE_SIZE, page * INDEX_PAGE_SIZE), total: cards.length, page, pages };
}

// Live public listings by id, as cards. Ids that aren't live and public drop out.
export async function liveCards(ids: string[] | null, now = new Date(), take = 100) {
  const rows = await prisma.listing.findMany({
    where: { ...liveListingWhere(now), ...(ids ? { id: { in: ids } } : {}), notes: { some: {} } },
    select: CARD_SELECT,
    orderBy: { approvedAt: "desc" },
    take,
  });
  return rows.map(indexCard).filter((card): card is IndexCard => card != null);
}

// The address with one filter changed, for the filter links and the pager.
export function indexHref(filters: IndexFilters, change: Partial<IndexFilters> = {}) {
  const next = { ...filters, ...change };
  const query = new URLSearchParams();
  if (next.state) query.set("state", next.state);
  if (next.lien) query.set("lien", next.lien);
  if (next.performance) query.set("performance", next.performance);
  if (next.band) query.set("band", next.band);
  if (next.page > 1) query.set("page", String(next.page));
  const text = query.toString();
  return text ? `/open?${text}` : "/open";
}
