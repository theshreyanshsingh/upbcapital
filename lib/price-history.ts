import { prisma } from "@/lib/prisma";

// A live listing's asking price as it moved. Every reprice of a live listing passes through lib/watchers.ts
// watchReprice, which records it here: a desk edit, a seller's own reprice, or a step of the seller's price ladder
// (lib/price-ladder.ts). A pool's row is the ask across the loans that moved. A Pro buyer sees the history and a recent
// cut on the book; only the seller and the desk see who moved it, and no buyer sees a ladder or its floor.

export const PRICE_SOURCES = ["DESK", "SELLER", "LADDER"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const SOURCE_LABELS: Record<PriceSource, string> = {
  DESK: "Desk edit",
  SELLER: "Seller reprice",
  LADDER: "Price ladder",
};

// A cut this recent marks the listing's card on the book.
export const RECENT_CUT_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export type PriceRow = { before: number; after: number; loans: number; source: string; createdAt: Date };

// The move as a percent of the old ask, to one decimal: negative for a cut.
export function changePercent(before: number, after: number) {
  if (!(before > 0)) return 0;
  return Math.round(((after - before) / before) * 1000) / 10;
}

export function sourceLabel(source: string) {
  return SOURCE_LABELS[source as PriceSource] ?? "Reprice";
}

export async function recordPriceChange(input: { listingId: string; before: number; after: number; loans: number; source: PriceSource; actorId: string | null; at?: Date }) {
  if (input.loans < 1 || Math.round(input.before * 100) === Math.round(input.after * 100)) return null;
  return prisma.priceChange.create({
    data: {
      listingId: input.listingId,
      before: input.before,
      after: input.after,
      loans: input.loans,
      source: input.source,
      actorId: input.actorId,
      ...(input.at ? { createdAt: input.at } : {}),
    },
  });
}

// Oldest first.
export async function priceHistory(listingId: string): Promise<PriceRow[]> {
  return prisma.priceChange.findMany({
    where: { listingId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { before: true, after: true, loans: true, source: true, createdAt: true },
  });
}

// The latest move on each listing in the window, kept only where it was a cut: the book's "ask cut" line. One read of
// the window's rows, which stay few, rather than a read per card.
export function latestCuts(rows: { listingId: string; before: number; after: number; createdAt: Date }[]) {
  const latest = new Map<string, { before: number; after: number; createdAt: Date }>();
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) latest.set(row.listingId, row);
  const cuts = new Map<string, { percent: number; at: Date }>();
  for (const [listingId, row] of latest) {
    if (row.after < row.before) cuts.set(listingId, { percent: Math.abs(changePercent(row.before, row.after)), at: row.createdAt });
  }
  return cuts;
}

export async function recentCuts(now = new Date(), days = RECENT_CUT_DAYS) {
  const rows = await prisma.priceChange.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - days * DAY), lte: now } },
    select: { listingId: true, before: true, after: true, createdAt: true },
  });
  return latestCuts(rows);
}
