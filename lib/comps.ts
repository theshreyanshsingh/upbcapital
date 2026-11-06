import { closingLoans } from "@/lib/closing";

export type Comp = { state: string; paymentStatus: string; upb: number; askingPrice: number };

// Live asks near the subject's size. Asks, not trades: closed-trade comps are compCells and compsFor below.
export function suggestedPrice(subject: Comp, book: Comp[]) {
  const peers = book.filter(
    (row) =>
      row !== subject &&
      row.state === subject.state &&
      row.paymentStatus === subject.paymentStatus &&
      row.upb > 0 &&
      row.askingPrice > 0 &&
      row.upb >= subject.upb * 0.6 &&
      row.upb <= subject.upb * 1.4,
  );
  if (peers.length < 2 || subject.upb <= 0) return null;
  const ratios = peers.map((row) => row.askingPrice / row.upb).sort((a, b) => a - b);
  const mid = ratios[Math.floor(ratios.length / 2)];
  return { price: Math.round(subject.upb * mid), sample: peers.length, priceToUpb: mid * 100 };
}

// ---------------------------------------------------------------------------------------------------------------
// Closed-trade comps. A trade is a COMPLETE closing, or a SOLD listing with no complete closing on file. Nothing
// here names a trade: a cell shows only with at least MIN_TRADES trades in it, prices show as a percent of UPB, and
// amounts show only as bands.

export const MIN_TRADES = 3;
export const COMP_WINDOW_MONTHS = 24;

export type ClosedTrade = {
  price: number;
  upb: number;
  lienPosition: string;
  paymentStatus: string;
  state: string;
  closedAt: Date;
};

// U.S. Census Bureau regions.
const REGIONS: Record<string, string[]> = {
  Northeast: ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"],
  Midwest: ["IL", "IN", "MI", "OH", "WI", "IA", "KS", "MN", "MO", "NE", "ND", "SD"],
  South: ["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV", "AL", "KY", "MS", "TN", "AR", "LA", "OK", "TX"],
  West: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY", "AK", "CA", "HI", "OR", "WA"],
};
const REGION_OF = new Map(Object.entries(REGIONS).flatMap(([region, states]) => states.map((state) => [state, region])));

export function regionOf(state: string) {
  return REGION_OF.get((state || "").toUpperCase()) ?? "Other";
}

const BANDS: [number, string][] = [
  [50_000, "Under $50k"],
  [100_000, "$50–100k"],
  [250_000, "$100–250k"],
  [500_000, "$250–500k"],
  [1_000_000, "$500k–1M"],
];

export function upbBand(upb: number) {
  for (const [limit, label] of BANDS) if (upb < limit) return label;
  return "$1M and up";
}

const LIEN_WORDS: Record<string, string> = { FIRST: "First lien", SECOND: "Second lien", THIRD: "Third lien", OTHER: "Other lien" };
const STATUS_WORDS: Record<string, string> = { PERFORMING: "Performing", SUB_PERFORMING: "Sub-performing", NON_PERFORMING: "Non-performing" };

export type Geo = "state" | "region" | "national";

export type CompCell = {
  lienPosition: string;
  paymentStatus: string;
  // A state code, a Census region, or "National".
  place: string;
  geo: Geo;
  label: string;
  count: number;
  // Price over UPB at the trade, in whole percent: gross, before the buyer premium and seller commission.
  median: number;
  low: number;
  high: number;
  // The band of the median trade's UPB.
  upbBand: string;
};

function placeOf(trade: ClosedTrade, geo: Geo) {
  if (geo === "state") return trade.state.toUpperCase();
  if (geo === "region") return regionOf(trade.state);
  return "National";
}

function median(sorted: number[]) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cellLabel(lien: string, status: string, place: string) {
  return `${LIEN_WORDS[lien] ?? lien}, ${(STATUS_WORDS[status] ?? status).toLowerCase()}, ${place === "National" ? "all states" : place}`;
}

function usable(trade: ClosedTrade) {
  return trade.upb > 0 && trade.price > 0 && Number.isFinite(trade.price / trade.upb);
}

// Group trades by lien, performance and place. Cells under minTrades are dropped and counted, never shown.
export function compCells(trades: ClosedTrade[], geo: Geo = "region", minTrades = MIN_TRADES) {
  const groups = new Map<string, ClosedTrade[]>();
  for (const trade of trades.filter(usable)) {
    const key = [trade.lienPosition, trade.paymentStatus, placeOf(trade, geo)].join("|");
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  const cells: CompCell[] = [];
  let suppressed = 0;
  for (const [key, rows] of groups) {
    if (rows.length < Math.max(MIN_TRADES, minTrades)) {
      suppressed += rows.length;
      continue;
    }
    const [lienPosition, paymentStatus, place] = key.split("|");
    const ratios = rows.map((row) => (row.price / row.upb) * 100).sort((a, b) => a - b);
    const upbs = rows.map((row) => row.upb).sort((a, b) => a - b);
    cells.push({
      lienPosition,
      paymentStatus,
      place,
      geo,
      label: cellLabel(lienPosition, paymentStatus, place),
      count: rows.length,
      median: Math.round(median(ratios)),
      low: Math.round(ratios[0]),
      high: Math.round(ratios[ratios.length - 1]),
      upbBand: upbBand(median(upbs)),
    });
  }
  const order = (cell: CompCell) => `${Object.keys(LIEN_WORDS).indexOf(cell.lienPosition)}${Object.keys(STATUS_WORDS).indexOf(cell.paymentStatus)}${cell.place}`;
  cells.sort((a, b) => order(a).localeCompare(order(b)));
  return { cells, suppressed };
}

// The narrowest cell that holds enough trades for a loan like the subject: its state, then its region, then all
// states. Null when even the national cell is too small.
export function compsFor(subject: { state: string; lienPosition: string; paymentStatus: string }, trades: ClosedTrade[], minTrades = MIN_TRADES) {
  for (const geo of ["state", "region", "national"] as Geo[]) {
    const place = placeOf({ ...subject, price: 0, upb: 0, closedAt: new Date(0) }, geo);
    const cell = compCells(trades, geo, minTrades).cells.find(
      (row) => row.lienPosition === subject.lienPosition && row.paymentStatus === subject.paymentStatus && row.place === place,
    );
    if (cell) return cell;
  }
  return null;
}

export type MarketView = {
  asOf: string;
  windowMonths: number;
  total: number;
  // Lien by performance across all states, then by region.
  national: CompCell[];
  regional: CompCell[];
  // Trades in regional cells too small to show.
  suppressed: number;
};

export function marketView(trades: ClosedTrade[], now = new Date(), windowMonths = COMP_WINDOW_MONTHS): MarketView {
  const since = new Date(now);
  since.setMonth(since.getMonth() - windowMonths);
  const recent = trades.filter((trade) => usable(trade) && trade.closedAt >= since && trade.closedAt <= now);
  const regional = compCells(recent, "region");
  return {
    asOf: now.toISOString().slice(0, 10),
    windowMonths,
    total: recent.length,
    national: compCells(recent, "national").cells,
    regional: regional.cells,
    suppressed: regional.suppressed,
  };
}

// One trade from a closing or a sale. A pool trades as one only when one lien, one performance and one state hold at
// least 80% of its UPB; a mixed pool would blur every cell it touched.
export function tradeFromLoans(
  price: number,
  loans: { upb: number; lienPosition: string; paymentStatus: string; state: string }[],
  closedAt: Date,
): ClosedTrade | null {
  const upb = loans.reduce((sum, loan) => sum + Math.max(0, loan.upb), 0);
  if (!(price > 0) || upb <= 0) return null;
  const leading = (pick: (loan: (typeof loans)[number]) => string) => {
    const shares = new Map<string, number>();
    for (const loan of loans) shares.set(pick(loan), (shares.get(pick(loan)) ?? 0) + Math.max(0, loan.upb));
    const [top, amount] = [...shares.entries()].sort((a, b) => b[1] - a[1])[0];
    return amount / upb >= 0.8 ? top : null;
  };
  const lienPosition = leading((loan) => loan.lienPosition);
  const paymentStatus = leading((loan) => loan.paymentStatus);
  const state = leading((loan) => loan.state.toUpperCase());
  if (!lienPosition || !paymentStatus || !state) return null;
  return { price, upb, lienPosition, paymentStatus, state, closedAt };
}

// Every closed trade in the window. Server only: it reads the database, which it imports here so the pure helpers
// above stay safe to import anywhere.
export async function loadClosedTrades(now = new Date(), windowMonths = COMP_WINDOW_MONTHS): Promise<ClosedTrade[]> {
  const { prisma } = await import("@/lib/prisma");
  const since = new Date(now);
  since.setMonth(since.getMonth() - windowMonths);
  const loanFields = { id: true, upb: true, lienPosition: true, paymentStatus: true, state: true } as const;
  const [closings, sold] = await Promise.all([
    prisma.closing.findMany({
      where: { status: "COMPLETE" },
      select: { listingId: true, noteId: true, salePrice: true, closedAt: true, openedAt: true, listing: { select: { notes: { select: loanFields } } } },
      orderBy: { openedAt: "desc" },
      take: 5000,
    }),
    prisma.listing.findMany({
      where: { status: "SOLD" },
      select: { id: true, salePrice: true, soldAt: true, updatedAt: true, notes: { select: loanFields } },
      orderBy: { updatedAt: "desc" },
      take: 5000,
    }),
  ]);
  const trades: ClosedTrade[] = [];
  const closed = new Set<string>();
  for (const closing of closings) {
    closed.add(closing.listingId);
    const at = closing.closedAt ?? closing.openedAt;
    if (at < since) continue;
    const trade = tradeFromLoans(closing.salePrice, closingLoans(closing, closing.listing.notes), at);
    if (trade) trades.push(trade);
  }
  for (const listing of sold) {
    if (closed.has(listing.id) || listing.salePrice == null) continue;
    const at = listing.soldAt ?? listing.updatedAt;
    if (at < since) continue;
    const trade = tradeFromLoans(listing.salePrice, listing.notes, at);
    if (trade) trades.push(trade);
  }
  return trades;
}
