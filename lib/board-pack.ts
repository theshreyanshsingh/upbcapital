import { Prisma } from "@prisma/client";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { daysBetween } from "@/lib/analytics";
import { audit } from "@/lib/audit";
import { closingIsWhole, closingLoans } from "@/lib/closing";
import { closingStats } from "@/lib/closing-clock";
import { toCsv } from "@/lib/csv";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { feesFor, type FeeSettings } from "@/lib/fee-schedule";
import { money } from "@/lib/format";
import { deliverable } from "@/lib/mail-config";
import { pdfSafe, wrap } from "@/lib/memo-pdf";
import { loansForSale } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { reviewKey } from "@/lib/screening";
import { ownAccounts } from "@/lib/seats";
import { getSettings } from "@/lib/settings";

// The monthly board pack: one calendar month (UTC) of UPB's own records, with the month before and the trailing
// three months, worked out the same way every time. A month is locked into BoardSnapshot once it is over, so a later
// recount never changes what the board was shown; the page flags any figure a recount would now put differently.
//
// Money in the pack is whole cents. The ledger and invoices are kept in cents already; Note.upb, Note.askingPrice,
// Closing.salePrice, Listing.salePrice and Listing.reservePrice are dollars as Float and are converted here.
// Ratios are fractions (0.25 is 25%), and days are whole days per deal from lib/analytics daysBetween.

export const BOARD_PACK_VERSION = 1;
const DAY = 24 * 60 * 60 * 1000;
// A paying Pro subscriber has a ledger charge within a month's billing cycle of the date asked about.
const BILLING_DAYS = 31;
const COHORT_MONTHS = 6;
// The desk home's "Listings to review": filed or under review, not back with the seller.
const REVIEWING = ["SUBMITTED", "UNDER_REVIEW"];
// Statuses a listing passes through once live. Any other status with an approval date was taken down.
const AFTER_LIVE = ["APPROVED", "PENDING", "SOLD", "WITHDRAWN"];
const SELLER_ROLES = ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"] as const;
const FAULTS = ["BUYER", "SELLER", "NEITHER"] as const;

// ---------------------------------------------------------------------------------------------------------------
// Months.

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonth(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = MONTH_RE.exec(text);
  return match && Number(match[1]) >= 1900 ? text : null;
}

export function monthStart(month: string) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1, 1));
}

export function monthOf(date: Date) {
  return date.toISOString().slice(0, 7);
}

export function shiftMonth(month: string, by: number) {
  const start = monthStart(month);
  return monthOf(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + by, 1)));
}

export function monthLabel(month: string) {
  return monthStart(month).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function monthShort(month: string) {
  return monthStart(month).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// A month is over once the next one has begun. Only a month that is over can be locked.
export function monthOver(month: string, now = new Date()) {
  return monthStart(shiftMonth(month, 1)).getTime() <= now.getTime();
}

// The page opens on the last whole month, which is the one a board meeting reads.
export function lastWholeMonth(now = new Date()) {
  return shiftMonth(monthOf(now), -1);
}

type Range = { start: Date; end: Date };

function monthRange(month: string): Range {
  return { start: monthStart(month), end: monthStart(shiftMonth(month, 1)) };
}

function within(date: Date | null | undefined, range: Range) {
  return Boolean(date) && date!.getTime() >= range.start.getTime() && date!.getTime() < range.end.getTime();
}

// ---------------------------------------------------------------------------------------------------------------
// Small arithmetic.

const cents = (dollars: number | null | undefined) => Math.round(Number(dollars ?? 0) * 100);
const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// ---------------------------------------------------------------------------------------------------------------
// When a listing was in review and when it was live, rebuilt from the dates on it. The record keeps no status history,
// so a decline or a send-back is dated by its review entry, and an award by its closing.

type Span = { from: Date; until: Date | null };

export type ListingDates = {
  status: string;
  submittedAt: Date;
  approvedAt: Date | null;
  launchAt?: Date | null;
  soldAt: Date | null;
  withdrawnAt: Date | null;
  // The first whole-listing contract: an award's closing that didn't fall through, or the desk marking it by hand.
  contractAt: Date | null;
  entries: { action: string; at: Date }[];
};

function earliest(dates: (Date | null | undefined)[]) {
  const known = dates.filter((date): date is Date => Boolean(date));
  return known.length ? new Date(Math.min(...known.map((date) => date.getTime()))) : null;
}

function latestEntry(listing: ListingDates, actions: string[], after: Date) {
  const hits = listing.entries.filter((entry) => actions.includes(entry.action) && entry.at.getTime() >= after.getTime());
  return hits.length ? new Date(Math.max(...hits.map((entry) => entry.at.getTime()))) : null;
}

function firstEntry(listing: ListingDates, actions: string[], after: Date) {
  const hits = listing.entries.filter((entry) => actions.includes(entry.action) && entry.at.getTime() >= after.getTime());
  return hits.length ? new Date(Math.min(...hits.map((entry) => entry.at.getTime()))) : null;
}

// On the book taking bids: from approval, or the launch date when later, until it went into contract, sold, was
// withdrawn or was taken down.
export function liveSpan(listing: ListingDates): Span | null {
  if (!listing.approvedAt) return null;
  const from = listing.launchAt && listing.launchAt.getTime() > listing.approvedAt.getTime() ? listing.launchAt : listing.approvedAt;
  const ends: (Date | null)[] = [listing.soldAt, listing.withdrawnAt, listing.contractAt];
  if (listing.status === "PENDING" || listing.status === "SOLD") ends.push(latestEntry(listing, ["MARK_PENDING"], listing.approvedAt));
  if (!AFTER_LIVE.includes(listing.status)) {
    const down = latestEntry(listing, ["REJECT", "REQUEST_CHANGES"], listing.approvedAt);
    if (!down) return null;
    ends.push(down);
  }
  const until = earliest(ends.filter((date) => date && date.getTime() >= from.getTime()));
  return { from, until };
}

// With the desk: from filing until approved, declined, sent back or withdrawn, and again after a resubmit for a
// listing that is in review now.
export function reviewSpans(listing: ListingDates): Span[] {
  const decided = earliest([
    listing.approvedAt && listing.approvedAt.getTime() >= listing.submittedAt.getTime() ? listing.approvedAt : null,
    listing.withdrawnAt,
    firstEntry(listing, ["REJECT", "REQUEST_CHANGES"], listing.submittedAt),
  ]);
  const reviewing = REVIEWING.includes(listing.status);
  if (!decided) return reviewing ? [{ from: listing.submittedAt, until: null }] : [];
  const spans: Span[] = [{ from: listing.submittedAt, until: decided }];
  if (reviewing) spans.push({ from: latestEntry(listing, ["RESUBMIT"], decided) ?? decided, until: null });
  return spans;
}

function overlaps(span: Span | null, range: Range) {
  return Boolean(span) && span!.from.getTime() < range.end.getTime() && (span!.until == null || span!.until.getTime() > range.start.getTime());
}

function holdsAt(span: Span | null, at: Date) {
  return Boolean(span) && span!.from.getTime() <= at.getTime() && (span!.until == null || span!.until.getTime() > at.getTime());
}

// ---------------------------------------------------------------------------------------------------------------
// The figures.

type Volume = { listings: number; loans: number; upbCents: number };

export type BoardFigures = {
  range: { start: string; end: string; asOf: string };
  volume: {
    listed: Volume;
    approved: Volume;
    awarded: { awards: number; loans: number; upbCents: number; priceCents: number };
    closed: { sales: number; loans: number; upbCents: number; gmvCents: number };
  };
  revenue: {
    buyerPremiumCents: number;
    sellerCommissionCents: number;
    subscriptionCents: number;
    creditsCents: number;
    netRevenueCents: number;
    brokerFeesCents: number;
    deskRevenueCents: number;
    takeRate: number | null;
    proMrrCents: number;
    proSubscribers: number;
    proLost: number;
    proChurn: number | null;
  };
  speed: {
    submitToApproveDays: number | null;
    liveToFirstBidDays: number | null;
    awardToCloseDays: number | null;
    failed: { total: number; buyer: number; seller: number; neither: number; unrecorded: number };
    fallThrough: number | null;
  };
  liquidity: {
    liveListings: number;
    bids: number;
    bidsPerLiveListing: number | null;
    threePlusShare: number | null;
    withReserve: number;
    clearedReserve: number;
    clearedReserveShare: number | null;
    priceToAskMedian: number | null;
  };
  people: {
    newSellers: number;
    newBuyers: number;
    approvedFiles: number;
    approvedFilesTotal: number;
    sellersSold: number;
    repeatSellers: number;
    activeBuyers: number;
  };
  pipeline: {
    review: { listings: number; loans: number; upbCents: number; askCents: number; feesCents: number };
    live: { listings: number; loans: number; upbCents: number; askCents: number; feesCents: number };
  };
  risk: {
    openDiscrepancies: number;
    discrepanciesRaised: number;
    strikes: number;
    depositsForfeited: number;
    depositsForfeitedCents: number;
    ofacHits: number;
    ofacConfirmed: number;
  };
};

export type BoardCohort = { month: string; signedUp: number; everBid: number; bidThisMonth: number; retention: number | null };

export type BoardPack = {
  version: number;
  month: string;
  generatedAt: string;
  current: BoardFigures;
  prior: BoardFigures;
  // The prior month as it was locked, when it was, so the board sees one number for it.
  priorLocked: boolean;
  trailing: BoardFigures;
  cohorts: BoardCohort[];
  // Accounts on undeliverable addresses when the pack was made, as the readiness check counts them. Not excluded.
  demoAccounts: number;
};

type Loan = { id: string; upb: number; askingPrice: number; tradeStatus: string };
type ClosingRow = {
  id: string;
  listingId: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  canceledAt: Date | null;
  cancelFault: string | null;
  noteId: string | null;
  noteIds: string[];
  salePrice: number;
};
type ListingRow = ListingDates & {
  id: string;
  kind: string;
  sellerId: string;
  salePrice: number | null;
  reservePrice: number | null;
  feeBuyerPremiumBps: number | null;
  feeSellerCommissionBps: number | null;
  feeSchedule: Prisma.JsonValue | null;
  feePayer: string | null;
  notes: Loan[];
  closings: ClosingRow[];
};

type Rows = {
  listings: ListingRow[];
  bids: { listingId: string; buyerId: string; createdAt: Date }[];
  revenue: { type: string; amountCents: number; userId: string | null; occurredAt: Date }[];
  invoices: { kind: string; amountCents: number; issuedAt: Date }[];
  users: { id: string; role: string; createdAt: Date }[];
  cohortBids: { buyerId: string; createdAt: Date }[];
  approvedFiles: { reviewedAt: Date | null }[];
  firstSale: Map<string, Date>;
  discrepancies: { status: string; createdAt: Date; closedAt: Date | null }[];
  strikes: { createdAt: Date }[];
  forfeits: { depositResolvedAt: Date | null; depositReceivedCents: number | null }[];
  ofac: { id: string; name: string; matched: string | null; userId: string | null; listingId: string | null; status: string | null; createdAt: Date }[];
  settings: FeeSettings;
  demoAccounts: number;
};

// Everything the window's figures read, in one pass. The window runs over the trailing three months; cohorts reach
// six months back for their signups.
async function loadRows(window: Range, cohortStart: Date): Promise<Rows> {
  const listings = await prisma.listing.findMany({
    where: {
      submittedAt: { lt: window.end },
      AND: [{ OR: [...unset("soldAt").OR, { soldAt: { gte: window.start } }] }, { OR: [...unset("withdrawnAt").OR, { withdrawnAt: { gte: window.start } }] }],
    },
    select: {
      id: true,
      kind: true,
      status: true,
      sellerId: true,
      submittedAt: true,
      approvedAt: true,
      launchAt: true,
      soldAt: true,
      withdrawnAt: true,
      salePrice: true,
      reservePrice: true,
      feeBuyerPremiumBps: true,
      feeSellerCommissionBps: true,
      feeSchedule: true,
      feePayer: true,
      notes: { select: { id: true, upb: true, askingPrice: true, tradeStatus: true } },
    },
  });
  const ids = listings.map((listing) => listing.id);
  const [closings, entries, bids] = await Promise.all([
    prisma.closing.findMany({
      where: { listingId: { in: ids } },
      select: { id: true, listingId: true, status: true, openedAt: true, closedAt: true, canceledAt: true, cancelFault: true, noteId: true, noteIds: true, salePrice: true },
    }),
    prisma.reviewComment.findMany({
      where: { listingId: { in: ids }, action: { in: ["REJECT", "REQUEST_CHANGES", "RESUBMIT", "MARK_PENDING"] } },
      select: { listingId: true, action: true, createdAt: true },
    }),
    prisma.inquiry.findMany({ where: { type: "OFFER", listingId: { in: ids }, createdAt: { lt: window.end } }, select: { listingId: true, buyerId: true, createdAt: true } }),
  ]);
  const closingsOf = new Map<string, ClosingRow[]>();
  for (const closing of closings) {
    const row = { ...closing, cancelFault: closing.cancelFault ?? null, noteIds: closing.noteIds ?? [], salePrice: Number(closing.salePrice) };
    closingsOf.set(closing.listingId, [...(closingsOf.get(closing.listingId) ?? []), row]);
  }
  const entriesOf = new Map<string, { action: string; at: Date }[]>();
  for (const entry of entries) entriesOf.set(entry.listingId, [...(entriesOf.get(entry.listingId) ?? []), { action: entry.action, at: entry.createdAt }]);
  const rows: ListingRow[] = listings.map((listing) => {
    const own = closingsOf.get(listing.id) ?? [];
    return {
      ...listing,
      launchAt: listing.launchAt ?? null,
      salePrice: listing.salePrice == null ? null : Number(listing.salePrice),
      reservePrice: listing.reservePrice == null ? null : Number(listing.reservePrice),
      feeBuyerPremiumBps: listing.feeBuyerPremiumBps ?? null,
      feeSellerCommissionBps: listing.feeSellerCommissionBps ?? null,
      feeSchedule: listing.feeSchedule ?? null,
      feePayer: listing.feePayer ?? null,
      notes: listing.notes.map((note) => ({ ...note, upb: Number(note.upb), askingPrice: Number(note.askingPrice) })),
      closings: own,
      // A single note's listing is in contract whichever way its one loan was bid for.
      contractAt: earliest(own.filter((closing) => closing.status !== "CANCELED" && (listing.kind === "SINGLE" || closingIsWhole(closing))).map((closing) => closing.openedAt)),
      entries: entriesOf.get(listing.id) ?? [],
    };
  });

  // Sellers who sold in the window, and when each first sold, for repeat sellers.
  const sold = new Set<string>();
  for (const listing of rows) {
    if (within(listing.soldAt, window) || listing.closings.some((closing) => closing.status === "COMPLETE" && within(closing.closedAt, window))) sold.add(listing.sellerId);
  }
  const [history, revenue, invoices, users, approvedFiles, discrepancies, strikes, forfeits, ofac, settings, emails] = await Promise.all([
    sold.size
      ? prisma.listing.findMany({ where: { sellerId: { in: [...sold] } }, select: { sellerId: true, soldAt: true, closings: { where: { status: "COMPLETE" }, select: { closedAt: true } } } })
      : Promise.resolve([]),
    prisma.revenueEvent.findMany({
      where: { mock: false, occurredAt: { gte: new Date(window.start.getTime() - BILLING_DAYS * DAY), lt: window.end } },
      select: { type: true, amountCents: true, userId: true, occurredAt: true },
    }),
    prisma.invoice.findMany({ where: { issuedAt: { gte: window.start, lt: window.end } }, select: { kind: true, amountCents: true, issuedAt: true } }),
    prisma.user.findMany({
      where: { createdAt: { gte: cohortStart, lt: window.end }, role: { in: ["BUYER", ...SELLER_ROLES] }, ...ownAccounts() },
      select: { id: true, role: true, createdAt: true },
    }),
    prisma.buyerProfile.findMany({ where: { status: "APPROVED", reviewedAt: { lt: window.end } }, select: { reviewedAt: true } }),
    prisma.fieldDiscrepancy.findMany({
      where: { createdAt: { lt: window.end }, OR: [{ status: "OPEN" }, { updatedAt: { gte: window.start } }, { resolvedAt: { gte: window.start } }] },
      select: { status: true, createdAt: true, resolvedAt: true, updatedAt: true },
    }),
    prisma.buyerStrike.findMany({ where: { createdAt: { gte: window.start, lt: window.end } }, select: { createdAt: true } }),
    prisma.closing.findMany({ where: { depositStatus: "FORFEITED", depositResolvedAt: { gte: window.start, lt: window.end } }, select: { depositResolvedAt: true, depositReceivedCents: true } }),
    prisma.ofacCheck.findMany({
      where: { result: "REVIEW", createdAt: { gte: window.start, lt: window.end } },
      select: { id: true, name: true, matched: true, userId: true, listingId: true, status: true, createdAt: true },
    }),
    getSettings(),
    prisma.user.findMany({ where: ownAccounts(), select: { email: true } }),
  ]);
  const firstSale = new Map<string, Date>();
  for (const listing of history) {
    const first = earliest([listing.soldAt, ...listing.closings.map((closing) => closing.closedAt)]);
    const known = firstSale.get(listing.sellerId);
    if (first && (!known || first < known)) firstSale.set(listing.sellerId, first);
  }
  // Cohorts that signed up before the window can have bid on listings long gone, so their bids are read on their own.
  // A later cohort's bids are all on listings live in the window, which are already loaded.
  const earlier = new Set(users.filter((user) => user.role === "BUYER" && user.createdAt < window.start).map((user) => user.id));
  const cohortBids = earlier.size
    ? await prisma.inquiry.findMany({ where: { type: "OFFER", buyerId: { in: [...earlier] }, createdAt: { lt: window.end } }, select: { buyerId: true, createdAt: true } })
    : [];
  return {
    listings: rows,
    bids,
    revenue,
    invoices,
    users,
    cohortBids: [...cohortBids, ...bids.filter((bid) => !earlier.has(bid.buyerId))],
    approvedFiles: approvedFiles.map((file) => ({ reviewedAt: file.reviewedAt ?? null })),
    firstSale,
    discrepancies: discrepancies.map((row) => ({ status: row.status, createdAt: row.createdAt, closedAt: row.status === "OPEN" ? null : (row.resolvedAt ?? row.updatedAt) })),
    strikes,
    forfeits: forfeits.map((row) => ({ depositResolvedAt: row.depositResolvedAt ?? null, depositReceivedCents: row.depositReceivedCents ?? null })),
    ofac: ofac.map((row) => ({ ...row, matched: row.matched ?? null, userId: row.userId ?? null, listingId: row.listingId ?? null, status: row.status ?? null })),
    settings,
    demoAccounts: emails.filter((user) => !deliverable(user.email)).length,
  };
}

function loanTotals(loans: Loan[]) {
  return { loans: loans.length, upbCents: sum(loans.map((loan) => cents(loan.upb))), askCents: sum(loans.map((loan) => cents(loan.askingPrice))) };
}

// Pro subscribers paying at a moment: accounts with a ledger charge in the billing cycle before it, each at its
// latest charge. A charge with no account counts on its own.
function payingAt(revenue: Rows["revenue"], at: Date) {
  const from = at.getTime() - BILLING_DAYS * DAY;
  const latest = new Map<string, { at: number; cents: number }>();
  for (const event of revenue) {
    const time = event.occurredAt.getTime();
    if (event.type !== "SUBSCRIPTION" || time < from || time >= at.getTime()) continue;
    const key = event.userId ?? `charge:${time}:${event.amountCents}`;
    const known = latest.get(key);
    if (!known || time >= known.at) latest.set(key, { at: time, cents: event.amountCents });
  }
  return latest;
}

function pipelineAt(rows: Rows, at: Date, live: boolean) {
  const out = { listings: 0, loans: 0, upbCents: 0, askCents: 0, feesCents: 0 };
  for (const listing of rows.listings) {
    const here = live ? holdsAt(liveSpan(listing), at) : reviewSpans(listing).some((span) => holdsAt(span, at));
    if (!here) continue;
    const totals = loanTotals(live ? loansForSale(listing.status, listing.notes) : listing.notes);
    const fees = totals.askCents > 0 ? feesFor(listing, rows.settings, totals.askCents / 100) : null;
    out.listings += 1;
    out.loans += totals.loans;
    out.upbCents += totals.upbCents;
    out.askCents += totals.askCents;
    out.feesCents += fees ? fees.premiumCents + fees.commissionCents : 0;
  }
  return out;
}

function figuresFor(rows: Rows, range: Range, now: Date): BoardFigures {
  // A month still running counts to now; month-end figures are read at this moment.
  const asOf = range.end.getTime() > now.getTime() ? now : range.end;
  const at = new Date(asOf.getTime() - 1);
  const listingOf = new Map(rows.listings.map((listing) => [listing.id, listing]));

  const filed = rows.listings.filter((listing) => within(listing.submittedAt, range));
  const approved = rows.listings.filter((listing) => within(listing.approvedAt, range));
  const volumeOf = (listings: ListingRow[]): Volume => {
    const totals = loanTotals(listings.flatMap((listing) => listing.notes));
    return { listings: listings.length, loans: totals.loans, upbCents: totals.upbCents };
  };

  const closings = rows.listings.flatMap((listing) => listing.closings.map((closing) => ({ closing, listing })));
  const awards = closings.filter(({ closing }) => within(closing.openedAt, range)).map(({ closing, listing }) => ({ closing, listing, loans: closingLoans(closing, listing.notes) }));
  const completed = closings.filter(({ closing }) => closing.status === "COMPLETE" && within(closing.closedAt, range));
  const canceled = closings.filter(({ closing }) => closing.status === "CANCELED" && within(closing.canceledAt, range));
  // A listing the desk marked sold by hand has no closing; its sale still closed and its fees are on the ledger.
  const byHand = rows.listings.filter((listing) => listing.status === "SOLD" && within(listing.soldAt, range) && !listing.closings.some((closing) => closing.status === "COMPLETE"));
  const sales = [
    ...completed.map(({ closing, listing }) => ({ sellerId: listing.sellerId, priceCents: cents(closing.salePrice), loans: closingLoans(closing, listing.notes) })),
    ...byHand.map((listing) => ({ sellerId: listing.sellerId, priceCents: cents(listing.salePrice), loans: listing.notes })),
  ];
  const gmvCents = sum(sales.map((sale) => sale.priceCents));

  const events = rows.revenue.filter((event) => within(event.occurredAt, range));
  const ledger = (type: string, positive = false) => sum(events.filter((event) => event.type === type && (!positive || event.amountCents > 0)).map((event) => event.amountCents));
  // Premiums and commissions as charged. The credit notes that took some back show on their own line.
  const buyerPremiumCents = ledger("BUYER_PREMIUM", true);
  const sellerCommissionCents = ledger("SELLER_COMMISSION", true);
  const subscriptionCents = ledger("SUBSCRIPTION");
  const brokerFeesCents = ledger("BROKER_FEE");
  const creditsCents = sum(rows.invoices.filter((invoice) => invoice.kind === "CREDIT_NOTE" && within(invoice.issuedAt, range)).map((invoice) => invoice.amountCents));
  const feeCents = buyerPremiumCents + sellerCommissionCents + creditsCents;
  const netRevenueCents = feeCents + subscriptionCents;
  const opening = payingAt(rows.revenue, range.start);
  const closingSubs = payingAt(rows.revenue, asOf);
  const lost = [...opening.keys()].filter((key) => !closingSubs.has(key)).length;

  const live = rows.listings.filter((listing) => overlaps(liveSpan(listing), range));
  const liveIds = new Set(live.map((listing) => listing.id));
  const bidsIn = rows.bids.filter((bid) => within(bid.createdAt, range));
  const liveBids = bidsIn.filter((bid) => liveIds.has(bid.listingId));
  const bidsBy = new Map<string, number>();
  for (const bid of rows.bids) if (bid.createdAt.getTime() < asOf.getTime()) bidsBy.set(bid.listingId, (bidsBy.get(bid.listingId) ?? 0) + 1);
  const firstBid = new Map<string, Date>();
  for (const bid of rows.bids) {
    const known = firstBid.get(bid.listingId);
    if (!known || bid.createdAt < known) firstBid.set(bid.listingId, bid.createdAt);
  }
  const reserved = awards.filter(({ closing, listing }) => (listing.kind === "SINGLE" || closingIsWhole(closing)) && (listing.reservePrice ?? 0) > 0);
  const cleared = reserved.filter(({ closing, listing }) => cents(closing.salePrice) >= cents(listing.reservePrice));
  const priceToAsk = awards.flatMap(({ closing, loans }) => {
    const ask = loanTotals(loans).askCents;
    return ask > 0 ? [cents(closing.salePrice) / ask] : [];
  });

  const firstBidDays = [...firstBid.entries()].flatMap(([listingId, bidAt]) => {
    const span = within(bidAt, range) ? liveSpan(listingOf.get(listingId)!) : null;
    return span ? [daysBetween(span.from, bidAt)] : [];
  });
  const stats = closingStats([...completed, ...canceled].map(({ closing }) => closing));
  const fault = (value: string | null) => canceled.filter(({ closing }) => closing.cancelFault === value).length;

  const sellersSold = new Set(sales.map((sale) => sale.sellerId));
  const repeat = [...sellersSold].filter((sellerId) => {
    const first = rows.firstSale.get(sellerId);
    return Boolean(first && first.getTime() < range.start.getTime());
  });
  const joined = rows.users.filter((user) => within(user.createdAt, range));

  const hits = rows.ofac.filter((row) => within(row.createdAt, range));
  const forfeits = rows.forfeits.filter((row) => within(row.depositResolvedAt, range));

  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString(), asOf: asOf.toISOString() },
    volume: {
      listed: volumeOf(filed),
      approved: volumeOf(approved),
      awarded: {
        awards: awards.length,
        loans: sum(awards.map((award) => award.loans.length)),
        upbCents: sum(awards.map((award) => loanTotals(award.loans).upbCents)),
        priceCents: sum(awards.map((award) => cents(award.closing.salePrice))),
      },
      closed: { sales: sales.length, loans: sum(sales.map((sale) => sale.loans.length)), upbCents: sum(sales.map((sale) => loanTotals(sale.loans).upbCents)), gmvCents },
    },
    revenue: {
      buyerPremiumCents,
      sellerCommissionCents,
      subscriptionCents,
      creditsCents,
      netRevenueCents,
      brokerFeesCents,
      deskRevenueCents: netRevenueCents - brokerFeesCents,
      takeRate: share(feeCents, gmvCents),
      proMrrCents: sum([...closingSubs.values()].map((charge) => charge.cents)),
      proSubscribers: closingSubs.size,
      proLost: lost,
      proChurn: share(lost, opening.size),
    },
    speed: {
      submitToApproveDays: median(approved.filter((listing) => listing.approvedAt! >= listing.submittedAt).map((listing) => daysBetween(listing.submittedAt, listing.approvedAt!))),
      liveToFirstBidDays: median(firstBidDays),
      awardToCloseDays: median(completed.map(({ closing }) => daysBetween(closing.openedAt, closing.closedAt!))),
      failed: { total: canceled.length, buyer: fault("BUYER"), seller: fault("SELLER"), neither: fault("NEITHER"), unrecorded: canceled.filter(({ closing }) => !FAULTS.includes(closing.cancelFault as (typeof FAULTS)[number])).length },
      fallThrough: stats.closeRate == null ? null : 1 - stats.closeRate,
    },
    liquidity: {
      liveListings: live.length,
      bids: liveBids.length,
      bidsPerLiveListing: live.length ? liveBids.length / live.length : null,
      threePlusShare: share(live.filter((listing) => (bidsBy.get(listing.id) ?? 0) >= 3).length, live.length),
      withReserve: reserved.length,
      clearedReserve: cleared.length,
      clearedReserveShare: share(cleared.length, reserved.length),
      priceToAskMedian: median(priceToAsk),
    },
    people: {
      newSellers: joined.filter((user) => (SELLER_ROLES as readonly string[]).includes(user.role)).length,
      newBuyers: joined.filter((user) => user.role === "BUYER").length,
      approvedFiles: rows.approvedFiles.filter((file) => within(file.reviewedAt, range)).length,
      // A file with no review date can't be placed in a month, so it isn't counted.
      approvedFilesTotal: rows.approvedFiles.filter((file) => file.reviewedAt && file.reviewedAt.getTime() < asOf.getTime()).length,
      sellersSold: sellersSold.size,
      repeatSellers: repeat.length,
      activeBuyers: new Set(bidsIn.map((bid) => bid.buyerId)).size,
    },
    pipeline: { review: pipelineAt(rows, at, false), live: pipelineAt(rows, at, true) },
    risk: {
      openDiscrepancies: rows.discrepancies.filter((row) => row.createdAt.getTime() < asOf.getTime() && (!row.closedAt || row.closedAt.getTime() >= asOf.getTime())).length,
      discrepanciesRaised: rows.discrepancies.filter((row) => within(row.createdAt, range)).length,
      strikes: rows.strikes.filter((row) => within(row.createdAt, range)).length,
      depositsForfeited: forfeits.length,
      depositsForfeitedCents: sum(forfeits.map((row) => row.depositReceivedCents ?? 0)),
      // Counted as the compliance page lists them: one per party, name and list entry.
      ofacHits: new Set(hits.map(reviewKey)).size,
      ofacConfirmed: new Set(hits.filter((row) => row.status === "CONFIRMED").map(reviewKey)).size,
    },
  };
}

// Buyers who signed up in each of the six months before this one: how many have bid by the month end, and how many
// bid in it.
function cohortsFor(rows: Rows, month: string, now: Date): BoardCohort[] {
  const range = monthRange(month);
  const end = range.end.getTime() > now.getTime() ? now : range.end;
  return Array.from({ length: COHORT_MONTHS }, (_, index) => {
    const cohort = shiftMonth(month, index - COHORT_MONTHS);
    const ids = new Set(rows.users.filter((user) => user.role === "BUYER" && within(user.createdAt, monthRange(cohort))).map((user) => user.id));
    const bids = rows.cohortBids.filter((bid) => ids.has(bid.buyerId) && bid.createdAt.getTime() < end.getTime());
    const bidThisMonth = new Set(bids.filter((bid) => within(bid.createdAt, range)).map((bid) => bid.buyerId)).size;
    return { month: cohort, signedUp: ids.size, everBid: new Set(bids.map((bid) => bid.buyerId)).size, bidThisMonth, retention: share(bidThisMonth, ids.size) };
  });
}

// A locked pack as stored, or null when it isn't one this version reads.
export function readPack(value: unknown): BoardPack | null {
  if (!value || typeof value !== "object") return null;
  const pack = value as Partial<BoardPack>;
  if (pack.version !== BOARD_PACK_VERSION || !parseMonth(pack.month)) return null;
  if (!pack.current || !pack.prior || !pack.trailing || !Array.isArray(pack.cohorts)) return null;
  return pack as BoardPack;
}

export async function boardPack(month: string, options: { now?: Date } = {}): Promise<BoardPack> {
  const now = options.now ?? new Date();
  const chosen = parseMonth(month);
  if (!chosen) throw new Error("Choose a month as YYYY-MM.");
  if (monthStart(chosen).getTime() > now.getTime()) throw new Error("That month hasn't started.");
  const prior = shiftMonth(chosen, -1);
  const window = { start: monthStart(shiftMonth(chosen, -2)), end: monthRange(chosen).end };
  const [rows, priorLock] = await Promise.all([loadRows(window, monthStart(shiftMonth(chosen, -COHORT_MONTHS))), prisma.boardSnapshot.findUnique({ where: { month: prior } })]);
  const locked = priorLock ? readPack(priorLock.data) : null;
  return {
    version: BOARD_PACK_VERSION,
    month: chosen,
    generatedAt: now.toISOString(),
    current: figuresFor(rows, monthRange(chosen), now),
    prior: locked?.current ?? figuresFor(rows, monthRange(prior), now),
    priorLocked: Boolean(locked),
    trailing: figuresFor(rows, window, now),
    cohorts: cohortsFor(rows, chosen, now),
    demoAccounts: rows.demoAccounts,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The figures as the page, the PDF and the CSV list them. One list, so the three never disagree on a label or a unit.

export type MetricUnit = "count" | "cents" | "ratio" | "days" | "number";

export type BoardMetric = {
  key: string;
  section: string;
  label: string;
  unit: MetricUnit;
  // Which way is good news, for the change's colour. Neither means it stays neutral.
  better?: "up" | "down";
  // A month-end figure, which has no three-month total.
  stock?: boolean;
  digits?: number;
};

export const BOARD_SECTIONS = ["Volume", "Revenue", "Speed and fall-through", "Liquidity", "Supply and demand", "Pipeline", "Risk"] as const;

const define = (section: (typeof BOARD_SECTIONS)[number], key: string, label: string, unit: MetricUnit, extra: Partial<BoardMetric> = {}): BoardMetric => ({ key, section, label, unit, ...extra });

export const BOARD_METRICS: BoardMetric[] = [
  define("Volume", "volume.listed.listings", "New listings", "count", { better: "up" }),
  define("Volume", "volume.listed.loans", "Loans listed", "count", { better: "up" }),
  define("Volume", "volume.listed.upbCents", "UPB listed", "cents", { better: "up" }),
  define("Volume", "volume.approved.listings", "Listings approved", "count", { better: "up" }),
  define("Volume", "volume.approved.loans", "Loans approved", "count", { better: "up" }),
  define("Volume", "volume.approved.upbCents", "UPB approved", "cents", { better: "up" }),
  define("Volume", "volume.awarded.awards", "Awards", "count", { better: "up" }),
  define("Volume", "volume.awarded.loans", "Loans awarded", "count", { better: "up" }),
  define("Volume", "volume.awarded.upbCents", "UPB awarded", "cents", { better: "up" }),
  define("Volume", "volume.awarded.priceCents", "Awarded price", "cents", { better: "up" }),
  define("Volume", "volume.closed.sales", "Sales closed", "count", { better: "up" }),
  define("Volume", "volume.closed.loans", "Loans closed", "count", { better: "up" }),
  define("Volume", "volume.closed.upbCents", "UPB closed", "cents", { better: "up" }),
  define("Volume", "volume.closed.gmvCents", "GMV, closed sale price", "cents", { better: "up" }),
  define("Revenue", "revenue.buyerPremiumCents", "Buyer premium", "cents", { better: "up" }),
  define("Revenue", "revenue.sellerCommissionCents", "Seller commission", "cents", { better: "up" }),
  define("Revenue", "revenue.subscriptionCents", "Pro subscriptions", "cents", { better: "up" }),
  define("Revenue", "revenue.creditsCents", "Credits and refunds", "cents", { better: "up" }),
  define("Revenue", "revenue.netRevenueCents", "Net revenue", "cents", { better: "up" }),
  define("Revenue", "revenue.brokerFeesCents", "Broker fees owed", "cents"),
  define("Revenue", "revenue.deskRevenueCents", "Desk revenue after broker fees", "cents", { better: "up" }),
  define("Revenue", "revenue.takeRate", "Take rate", "ratio", { better: "up", digits: 2 }),
  define("Revenue", "revenue.proMrrCents", "Pro MRR", "cents", { better: "up", stock: true }),
  define("Revenue", "revenue.proSubscribers", "Pro subscribers", "count", { better: "up", stock: true }),
  define("Revenue", "revenue.proLost", "Pro subscribers lost", "count", { better: "down" }),
  define("Revenue", "revenue.proChurn", "Pro churn", "ratio", { better: "down" }),
  define("Speed and fall-through", "speed.submitToApproveDays", "Median days, submitted to approved", "days", { better: "down" }),
  define("Speed and fall-through", "speed.liveToFirstBidDays", "Median days, approved to first bid", "days", { better: "down" }),
  define("Speed and fall-through", "speed.awardToCloseDays", "Median days, award to close", "days", { better: "down" }),
  define("Speed and fall-through", "speed.failed.total", "Closings failed", "count", { better: "down" }),
  define("Speed and fall-through", "speed.failed.buyer", "Failed on the buyer", "count", { better: "down" }),
  define("Speed and fall-through", "speed.failed.seller", "Failed on the seller", "count", { better: "down" }),
  define("Speed and fall-through", "speed.failed.neither", "Failed, neither side", "count", { better: "down" }),
  define("Speed and fall-through", "speed.failed.unrecorded", "Failed, fault not recorded", "count", { better: "down" }),
  define("Speed and fall-through", "speed.fallThrough", "Fall-through rate", "ratio", { better: "down" }),
  define("Liquidity", "liquidity.liveListings", "Live listings", "count", { better: "up" }),
  define("Liquidity", "liquidity.bids", "Bids on live listings", "count", { better: "up" }),
  define("Liquidity", "liquidity.bidsPerLiveListing", "Bids per live listing", "number", { better: "up", digits: 1 }),
  define("Liquidity", "liquidity.threePlusShare", "Live listings with 3 or more bids", "ratio", { better: "up" }),
  define("Liquidity", "liquidity.withReserve", "Awards with a reserve", "count"),
  define("Liquidity", "liquidity.clearedReserveShare", "Awards that cleared reserve", "ratio", { better: "up" }),
  define("Liquidity", "liquidity.priceToAskMedian", "Median awarded price over ask", "ratio", { better: "up" }),
  define("Supply and demand", "people.newSellers", "New sellers", "count", { better: "up" }),
  define("Supply and demand", "people.newBuyers", "New buyers", "count", { better: "up" }),
  define("Supply and demand", "people.approvedFiles", "Buyer files approved", "count", { better: "up" }),
  define("Supply and demand", "people.approvedFilesTotal", "Approved buyer files on record", "count", { better: "up", stock: true }),
  define("Supply and demand", "people.sellersSold", "Sellers who sold", "count", { better: "up" }),
  define("Supply and demand", "people.repeatSellers", "Repeat sellers", "count", { better: "up" }),
  define("Supply and demand", "people.activeBuyers", "Active buyers", "count", { better: "up" }),
  define("Pipeline", "pipeline.review.listings", "Listings in review", "count", { stock: true }),
  define("Pipeline", "pipeline.review.loans", "Loans in review", "count", { stock: true }),
  define("Pipeline", "pipeline.review.upbCents", "UPB in review", "cents", { stock: true }),
  define("Pipeline", "pipeline.review.feesCents", "Expected fees in review", "cents", { better: "up", stock: true }),
  define("Pipeline", "pipeline.live.listings", "Listings live", "count", { stock: true }),
  define("Pipeline", "pipeline.live.loans", "Loans live", "count", { stock: true }),
  define("Pipeline", "pipeline.live.upbCents", "UPB live", "cents", { stock: true }),
  define("Pipeline", "pipeline.live.askCents", "Ask, live", "cents", { stock: true }),
  define("Pipeline", "pipeline.live.feesCents", "Expected fees, live", "cents", { better: "up", stock: true }),
  define("Risk", "risk.openDiscrepancies", "Open discrepancies", "count", { better: "down", stock: true }),
  define("Risk", "risk.discrepanciesRaised", "Discrepancies raised", "count", { better: "down" }),
  define("Risk", "risk.strikes", "Strikes issued", "count", { better: "down" }),
  define("Risk", "risk.depositsForfeited", "Deposits forfeited", "count", { better: "down" }),
  define("Risk", "risk.depositsForfeitedCents", "Deposits forfeited, amount", "cents", { better: "down" }),
  define("Risk", "risk.ofacHits", "OFAC hits", "count", { better: "down" }),
  define("Risk", "risk.ofacConfirmed", "OFAC matches confirmed", "count", { better: "down" }),
];

// The headline tiles, in order.
export const BOARD_TILES = [
  "volume.closed.gmvCents",
  "revenue.netRevenueCents",
  "revenue.takeRate",
  "volume.closed.sales",
  "revenue.proMrrCents",
  "liquidity.bidsPerLiveListing",
  "speed.fallThrough",
  "people.activeBuyers",
] as const;

export function boardMetric(key: string) {
  return BOARD_METRICS.find((metric) => metric.key === key);
}

// One figure by its key, from a live or a locked pack. Missing reads as null.
export function metricValue(figures: unknown, key: string): number | null {
  let value: unknown = figures;
  for (const part of key.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function plainNumber(value: number, digits: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatMetric(metric: BoardMetric, value: number | null) {
  if (value == null) return "—";
  if (metric.unit === "cents") return money(value / 100);
  if (metric.unit === "ratio") return `${plainNumber(value * 100, metric.digits ?? 1)}%`;
  if (metric.unit === "days") return `${plainNumber(value, 1)} days`;
  if (metric.unit === "number") return plainNumber(value, metric.digits ?? 1);
  return plainNumber(value, 0);
}

export type MetricChange = { text: string; direction: "up" | "down" | "flat"; tone: "good" | "bad" | "neutral"; delta: number; relative: number | null };

// The change from the prior month: a percent for counts and money when the prior wasn't zero, points for a rate,
// days for a median.
export function metricChange(metric: BoardMetric, value: number | null, prior: number | null): MetricChange | null {
  if (value == null || prior == null) return null;
  const delta = value - prior;
  const flat = Math.abs(delta) < 1e-9;
  const direction = flat ? "flat" : delta > 0 ? "up" : "down";
  const tone = flat || !metric.better ? "neutral" : (direction === metric.better ? "good" : "bad");
  const relative = (metric.unit === "count" || metric.unit === "cents" || metric.unit === "number") && prior > 0 ? delta / prior : null;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  let text: string;
  if (flat) text = "No change";
  else if (metric.unit === "ratio") text = `${sign}${plainNumber(Math.abs(delta) * 100, 1)} pts`;
  else if (metric.unit === "days") text = `${sign}${plainNumber(Math.abs(delta), 1)} days`;
  else if (relative != null) text = `${sign}${plainNumber(Math.abs(relative) * 100, 0)}%`;
  else text = `${sign}${metric.unit === "cents" ? money(Math.abs(delta) / 100) : plainNumber(Math.abs(delta), metric.unit === "number" ? (metric.digits ?? 1) : 0)}`;
  return { text, direction, tone, delta, relative };
}

function sameValue(a: number | null, b: number | null) {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) < 1e-9;
}

export type BoardDifference = { key: string; label: string; locked: number | null; live: number | null };

// Where a live recount of the month now differs from what was locked, figure by figure, cohorts included.
export function packDifferences(locked: BoardPack, live: BoardPack): BoardDifference[] {
  const out: BoardDifference[] = [];
  for (const metric of BOARD_METRICS) {
    const was = metricValue(locked.current, metric.key);
    const now = metricValue(live.current, metric.key);
    if (!sameValue(was, now)) out.push({ key: metric.key, label: metric.label, locked: was, live: now });
  }
  for (const cohort of live.cohorts) {
    const was = locked.cohorts.find((row) => row.month === cohort.month);
    for (const field of ["signedUp", "everBid", "bidThisMonth"] as const) {
      const before = was ? was[field] : null;
      if (!sameValue(before, cohort[field])) out.push({ key: `cohort.${cohort.month}.${field}`, label: `${monthShort(cohort.month)} cohort, ${COHORT_LABELS[field].toLowerCase()}`, locked: before, live: cohort[field] });
    }
  }
  return out;
}

export const COHORT_LABELS = { signedUp: "Signed up", everBid: "Have bid", bidThisMonth: "Bid this month" } as const;

// ---------------------------------------------------------------------------------------------------------------
// Locking. One snapshot per month, saved by a desk member who runs fees and settings. Locking again replaces it and
// needs a note, and both go in the audit log with what changed.

export type BoardLock = { id: string; month: string; lockedById: string; note: string; createdAt: Date };

function figureLine(pack: BoardPack) {
  const gmv = metricValue(pack.current, "volume.closed.gmvCents") ?? 0;
  const net = metricValue(pack.current, "revenue.netRevenueCents") ?? 0;
  return `GMV ${money(gmv / 100)}, net revenue ${money(net / 100)}, ${pack.current.volume.closed.sales} sale${pack.current.volume.closed.sales === 1 ? "" : "s"} closed`;
}

function changeLine(differences: BoardDifference[]) {
  if (!differences.length) return "No figure changed.";
  const shown = differences.slice(0, 4).map((row) => {
    const metric = boardMetric(row.key);
    const say = (value: number | null) => (metric ? formatMetric(metric, value) : value == null ? "—" : String(value));
    return `${row.label} ${say(row.locked)} to ${say(row.live)}`;
  });
  const more = differences.length > shown.length ? `, and ${differences.length - shown.length} more` : "";
  return `${differences.length} figure${differences.length === 1 ? "" : "s"} changed: ${shown.join("; ")}${more}.`;
}

export async function lockBoardMonth(actor: Staff & { id: string }, input: { month: unknown; note?: unknown }, options: { now?: Date } = {}) {
  if (!deskCan(actor, "admin")) return { error: DESK_DENIED } as const;
  const now = options.now ?? new Date();
  const month = parseMonth(input.month);
  if (!month) return { error: "Choose a month to lock." } as const;
  if (!monthOver(month, now)) return { error: `Lock ${monthLabel(month)} once it is over, from ${monthLabel(shiftMonth(month, 1))}.` } as const;
  const note = String(input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const existing = await prisma.boardSnapshot.findUnique({ where: { month } });
  if (existing && note.length < 10) return { error: "Say why the month is locked again, in a sentence. The note stays with the pack." } as const;
  const pack = await boardPack(month, { now });
  const data = JSON.parse(JSON.stringify(pack)) as Prisma.InputJsonValue;
  if (existing) {
    const before = readPack(existing.data);
    const differences = before ? packDifferences(before, pack) : [];
    // Two re-locks at once: the one that finds the snapshot as it read it wins, and the other is told.
    const claimed = await prisma.boardSnapshot.updateMany({ where: { id: existing.id, createdAt: existing.createdAt }, data: { data, lockedById: actor.id, note, createdAt: now } });
    if (claimed.count !== 1) return { error: "Someone locked this month a moment ago. Reload the page to see their figures." } as const;
    await audit(actor.id, "BOARD_RELOCK", "board", month, `${monthLabel(month)} locked again. Note: ${note} ${before ? changeLine(differences) : "The earlier pack couldn't be read."} ${figureLine(pack)}.`);
    return { error: null, relocked: true, pack, differences } as const;
  }
  try {
    await prisma.boardSnapshot.create({ data: { month, data, lockedById: actor.id, note, createdAt: now } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { error: "This month was locked a moment ago. Reload the page to see the figures." } as const;
    throw error;
  }
  await audit(actor.id, "BOARD_LOCK", "board", month, `${monthLabel(month)} locked. ${figureLine(pack)}.${note ? ` Note: ${note}` : ""}`);
  return { error: null, relocked: false, pack, differences: [] as BoardDifference[] } as const;
}

// The month as the page shows it: the locked pack when there is one, with a live recount beside it to compare.
export async function boardView(month: string, now = new Date()) {
  const [snapshot, live] = await Promise.all([prisma.boardSnapshot.findUnique({ where: { month } }), boardPack(month, { now })]);
  const locked = snapshot ? readPack(snapshot.data) : null;
  const lockedBy = snapshot ? await prisma.user.findUnique({ where: { id: snapshot.lockedById }, select: { name: true } }) : null;
  return {
    pack: locked ?? live,
    live,
    lock: snapshot ? { lockedAt: snapshot.createdAt, lockedBy: lockedBy?.name ?? "A removed account", note: snapshot.note, readable: Boolean(locked) } : null,
    differences: locked ? packDifferences(locked, live) : [],
  };
}

// What an export carries: the locked figures when the month is locked, else a live count, and a line saying which.
export async function exportPack(month: string, now = new Date()) {
  const snapshot = await prisma.boardSnapshot.findUnique({ where: { month } });
  const locked = snapshot ? readPack(snapshot.data) : null;
  if (snapshot && locked) {
    const by = await prisma.user.findUnique({ where: { id: snapshot.lockedById }, select: { name: true } });
    return { pack: locked, basis: `Locked ${snapshot.createdAt.toISOString().slice(0, 10)} by ${by?.name ?? "a removed account"}` };
  }
  return { pack: await boardPack(month, { now }), basis: `Live count ${now.toISOString().slice(0, 16).replace("T", " ")} UTC, not locked` };
}

// ---------------------------------------------------------------------------------------------------------------
// Exports. The CSV is one row per figure, money in dollars to the cent and rates in percent, with the unit on each row.

export const BOARD_CSV_COLUMNS = ["section", "metric", "unit", "value", "prior_month", "change", "change_pct", "trailing_three_months", "basis"] as const;

const CSV_UNITS: Record<MetricUnit, string> = { count: "count", cents: "USD", ratio: "percent", days: "days", number: "number" };

function csvValue(metric: BoardMetric, value: number | null) {
  if (value == null) return "";
  if (metric.unit === "cents") return Math.round(value) / 100;
  if (metric.unit === "ratio") return Math.round(value * 10000) / 100;
  if (metric.unit === "days" || metric.unit === "number") return Math.round(value * 100) / 100;
  return value;
}

export function boardCsv(pack: BoardPack, basis: string) {
  const rows: Record<string, string | number>[] = BOARD_METRICS.map((metric) => {
    const value = metricValue(pack.current, metric.key);
    const prior = metricValue(pack.prior, metric.key);
    const change = metricChange(metric, value, prior);
    return {
      section: metric.section,
      metric: metric.label,
      unit: CSV_UNITS[metric.unit],
      value: csvValue(metric, value),
      prior_month: csvValue(metric, prior),
      change: change ? csvValue(metric, change.delta) : "",
      change_pct: change?.relative == null ? "" : Math.round(change.relative * 10000) / 100,
      trailing_three_months: metric.stock ? "" : csvValue(metric, metricValue(pack.trailing, metric.key)),
      basis,
    };
  });
  for (const cohort of pack.cohorts) {
    const row = (label: string, unit: string, value: number | string) => ({ section: "Buyer cohorts", metric: `${cohort.month} signups, ${label}`, unit, value, prior_month: "", change: "", change_pct: "", trailing_three_months: "", basis });
    rows.push(row("signed up", "count", cohort.signedUp), row("have bid", "count", cohort.everBid), row("bid this month", "count", cohort.bidThisMonth));
    rows.push(row("retention", "percent", cohort.retention == null ? "" : Math.round(cohort.retention * 10000) / 100));
  }
  return toCsv(rows);
}

export async function boardPdf(pack: BoardPack, basis: string) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  const soft = rgb(0.4, 0.38, 0.34);
  let page: PDFPage = pdf.addPage([612, 792]);
  let y = 0;
  const text = (value: string, x: number, size = 9, face: PDFFont = font, color = ink) => page.drawText(pdfSafe(value, face), { x, y, size, font: face, color });
  const right = (value: string, edge: number, size = 9, face: PDFFont = font, color = ink) => {
    const safe = pdfSafe(value, face);
    page.drawText(safe, { x: edge - face.widthOfTextAtSize(safe, size), y, size, font: face, color });
  };
  const fresh = () => {
    page = pdf.addPage([612, 792]);
    y = 744;
  };
  const room = (needed: number) => {
    if (y - needed < 56) fresh();
  };
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
  page.drawText("UPB CAPITAL  ·  BOARD PACK", { x: 48, y: 762, size: 11, font, color: gold });
  y = 704;
  text(monthLabel(pack.month), 48, 22, bold);
  y -= 20;
  text(`${basis}. Prior month ${pack.priorLocked ? "as locked" : "as counted now"}. Money in US dollars.`, 48, 10, font, soft);
  y -= 26;

  const columns = [
    { label: monthShort(pack.month), edge: 372 },
    { label: monthShort(shiftMonth(pack.month, -1)), edge: 444 },
    { label: "Change", edge: 498 },
    { label: "3 months", edge: 564 },
  ];
  for (const section of BOARD_SECTIONS) {
    room(40);
    text(section, 48, 12, bold, gold);
    y -= 16;
    text("Figure", 48, 8, bold, soft);
    for (const column of columns) right(column.label, column.edge, 8, bold, soft);
    y -= 12;
    for (const metric of BOARD_METRICS.filter((row) => row.section === section)) {
      room(14);
      const value = metricValue(pack.current, metric.key);
      const prior = metricValue(pack.prior, metric.key);
      text(metric.label, 48);
      right(formatMetric(metric, value), columns[0].edge);
      right(formatMetric(metric, prior), columns[1].edge, 9, font, soft);
      right(metricChange(metric, value, prior)?.text ?? "—", columns[2].edge, 9, font, soft);
      right(metric.stock ? "—" : formatMetric(metric, metricValue(pack.trailing, metric.key)), columns[3].edge, 9, font, soft);
      y -= 13;
    }
    y -= 12;
  }

  room(40 + pack.cohorts.length * 13);
  text("Buyer cohorts", 48, 12, bold, gold);
  y -= 16;
  text("Signed up in", 48, 8, bold, soft);
  ["Buyers", "Have bid", `Bid in ${monthShort(pack.month).split(" ")[0]}`, "Retention"].forEach((label, index) => right(label, [372, 444, 498, 564][index], 8, bold, soft));
  y -= 12;
  for (const cohort of pack.cohorts) {
    text(monthLabel(cohort.month), 48);
    right(String(cohort.signedUp), 372);
    right(String(cohort.everBid), 444);
    right(String(cohort.bidThisMonth), 498);
    right(cohort.retention == null ? "—" : `${(cohort.retention * 100).toFixed(1)}%`, 564);
    y -= 13;
  }
  y -= 12;

  room(40);
  text("Definitions", 48, 12, bold, gold);
  y -= 16;
  for (const group of boardDefinitions(pack.demoAccounts)) {
    room(28);
    text(group.section, 48, 10, bold);
    y -= 14;
    for (const item of group.items) {
      const lines = wrap(pdfSafe(`${item.term}: ${item.text}`, font), font, 8.5, 516);
      room(lines.length * 11 + 4);
      for (const line of lines) {
        text(line, 48, 8.5, font, soft);
        y -= 11;
      }
      y -= 3;
    }
    y -= 6;
  }
  const pages = pdf.getPages();
  pages.forEach((each, index) => {
    each.drawText(pdfSafe(`UPB Capital board pack, ${monthLabel(pack.month)}. From UPB's own records. Page ${index + 1} of ${pages.length}.`, font), { x: 48, y: 30, size: 8, font, color: soft });
  });
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------------------------------------------
// The definitions, for the page and the PDF. Where a figure differs from analytics or the desk home, it says so.

export function boardDefinitions(demoAccounts: number) {
  return [
    {
      section: "How the pack is counted",
      items: [
        { term: "Months", text: "Calendar months in UTC, as the finance export counts them. A month still running counts to now." },
        {
          term: "Units",
          text: "Money shows in dollars and is kept in the pack in cents. Ledger rows and invoices are stored in cents. Loan balances, asks, sale prices and reserves are stored in dollars and are converted to cents, rounded to the cent.",
        },
        {
          term: "Prior month and trailing three months",
          text: "The prior month is the month before. When it is locked, the pack shows it as locked, so the board reads one number for it. The trailing three months run through this month: counts and money add up, and rates and medians are worked out over the three months together. Month-end figures show for this month only.",
        },
        {
          term: "Demo and test accounts",
          text: `Not excluded. Analytics has no filter for demo or test accounts, so this pack has none either. ${demoAccounts.toLocaleString("en-US")} account${demoAccounts === 1 ? " is" : "s are"} on undeliverable addresses, as the readiness check counts them. Remove them before reading the pack as the real business.`,
        },
        { term: "Locking", text: "Locking saves the pack as it stands. The page then shows the locked figures and marks each one a live recount now puts differently. Locking again replaces the pack and needs a note. Every lock is in the audit log." },
      ],
    },
    {
      section: "Volume",
      items: [
        { term: "Listed", text: "Listings by the date they were submitted, with their loans and UPB as the tape stands now." },
        { term: "Approved", text: "Listings by the date the desk last approved them. A listing approved again after changes counts in the month of the later approval." },
        { term: "Awarded", text: "Closings opened in the month, which is when a bid is awarded. Loans and UPB are the loans each closing covers. Desk purchases for UPB's own book count." },
        { term: "Closed and GMV", text: "Closings completed in the month, and listings the desk marked sold by hand without a closing. GMV is the sale price, before the buyer premium." },
      ],
    },
    {
      section: "Revenue",
      items: [
        { term: "Premium, commission and subscriptions", text: "Ledger rows dated in the month, as in the finance export's revenue by month. Simulated checkout charges are left out, since no money moved. Premiums and commissions post when a sale closes." },
        { term: "Credits and refunds", text: "Credit notes issued in the month, as a negative amount. The finance export nets them out of premiums and commissions. Here premiums and commissions are as charged, and credits have their own line." },
        { term: "Net revenue", text: "Premium, commission and Pro subscriptions, less credits." },
        { term: "Desk revenue after broker fees", text: "Net revenue less the broker fees posted in the month, which are owed to brokers. It matches the finance export's desk revenue." },
        { term: "Take rate", text: "Premium and commission, less credits, over GMV." },
        {
          term: "Pro MRR, subscribers and churn",
          text: "A paying subscriber is an account with a Pro charge on the ledger in the 31 days to the month end. MRR adds each one's latest charge. Churn is the share of the month's opening subscribers with no charge by its end. The desk home counts Pro accounts active right now at today's price instead; a past month can only be read from the ledger. Comped accounts pay nothing and don't count.",
        },
      ],
    },
    {
      section: "Speed and fall-through",
      items: [
        { term: "Submitted to approved", text: "Median days, for listings approved in the month." },
        { term: "Approved to first bid", text: "Median days from approval, or from the launch date when that was later, since no one can bid before it, to the first bid, for listings whose first bid came in the month." },
        { term: "Award to close", text: "Median days, for closings completed in the month. The desk home shows the mean over 180 days, and analytics the mean from filing to sold." },
        { term: "Failed and fall-through", text: "Closings canceled in the month, by the fault the desk recorded. Fall-through is canceled over canceled and completed, for closings that ended in the month: the desk home's close rate, turned round." },
      ],
    },
    {
      section: "Liquidity",
      items: [
        { term: "Live listings", text: "Listings on the book at any point in the month: approved and launched, and not yet in contract, sold, withdrawn or taken down. Rebuilt from each listing's dates and review entries, since the record keeps no status history." },
        { term: "Bids per live listing", text: "Bids placed in the month on live listings, over live listings. The desk home divides every bid on the listings live right now instead." },
        { term: "3 or more bids", text: "Live listings with three or more bids by the month end." },
        { term: "Cleared reserve", text: "Awards in the month on a whole listing with a reserve, where the price met it. Awards with no reserve, and part-pool or one-loan awards from a pool, are left out." },
        { term: "Awarded price over ask", text: "The median of each award's price over the ask of the loans it covers, at the ask as it stands now." },
      ],
    },
    {
      section: "Supply and demand",
      items: [
        { term: "New sellers and buyers", text: "Accounts opened in the month as a seller, individual or institutional, or as a buyer. Seats on a firm's account and brokers are not counted." },
        { term: "Buyer files", text: "Approved this month counts files whose latest review, an approval, fell in the month. On record counts files approved by the month end, as analytics counts verified buyers, less any approved file with no review date, which can't be placed in a month." },
        { term: "Repeat sellers", text: "Sellers who closed a sale in the month and had also closed one in an earlier month." },
        { term: "Active buyers", text: "Accounts that placed a bid in the month." },
        { term: "Buyer cohorts", text: "Buyers who signed up in each of the six months before this one: how many have bid by the month end, and how many bid in this month. Retention is the second over the cohort." },
      ],
    },
    {
      section: "Pipeline",
      items: [
        {
          term: "In review and live",
          text: "Listings in review, meaning filed or under review as the desk home counts them, and listings live at the month end, or now for a month still running. Expected fees are the buyer premium and seller commission on the ask: at the listing's own terms when it kept them at go-live, and at today's fee schedule otherwise.",
        },
      ],
    },
    {
      section: "Risk",
      items: [
        { term: "Discrepancies", text: "Open counts tape discrepancies still open at the month end. Raised counts those opened in the month." },
        { term: "Strikes", text: "Strikes issued in the month, whether or not they were later cleared." },
        { term: "Deposits forfeited", text: "Forfeits approved in the month, and the deposits received on them." },
        { term: "OFAC hits", text: "Screens that needed review, opened in the month, one per party, name and list entry, as the compliance page counts them. Confirmed are those the desk confirmed as a true match." },
      ],
    },
  ];
}
