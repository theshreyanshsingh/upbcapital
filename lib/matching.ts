import type { Prisma } from "@prisma/client";
import { parseList, scoreAgainstBox, type BoxCriteria, type ScoreNote } from "@/lib/buy-box";
import { unset } from "@/lib/db-filters";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { marketRate, type MarketRate, type StandingPoint } from "@/lib/indicative";
import { getSettings } from "@/lib/settings";
import {
  claimStandingNotice,
  indicativeFor,
  remainingTerm,
  ruleHolder,
  sheetShows,
  standingNotice,
  type StandingNote,
} from "@/lib/standing-bids";

type BoxRow = Prisma.BuyBoxGetPayload<{ include: { user: true } }>;
type ListingRow = Prisma.ListingGetPayload<{ include: { notes: true } }>;

function num(value: { toString(): string } | null) {
  if (value == null) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

export function criteriaFrom(box: {
  states: string;
  liens: string;
  statuses: string;
  upbMin: { toString(): string } | null;
  upbMax: { toString(): string } | null;
  priceMin: { toString(): string } | null;
  priceMax: { toString(): string } | null;
  maxPriceToUpb: { toString(): string } | null;
  targetYield: { toString(): string } | null;
}): BoxCriteria {
  return {
    states: parseList(box.states),
    liens: parseList(box.liens),
    statuses: parseList(box.statuses),
    upbMin: num(box.upbMin),
    upbMax: num(box.upbMax),
    priceMin: num(box.priceMin),
    priceMax: num(box.priceMax),
    maxPriceToUpb: num(box.maxPriceToUpb),
    targetYield: num(box.targetYield),
  };
}

type ScoredLoan = Pick<StandingNote, "upb" | "askingPrice" | "monthlyPi" | "interestRate" | "maturityDate" | "paymentStatus"> & { state: string; lienPosition: string };

function notesOf(notes: ScoredLoan[], now: Date): ScoreNote[] {
  return notes.map((note) => ({
    state: note.state,
    lienPosition: note.lienPosition,
    paymentStatus: note.paymentStatus,
    upb: Number(note.upb),
    askingPrice: Number(note.askingPrice),
    monthlyPi: Number(note.monthlyPi),
    interestRate: Number(note.interestRate),
    termMonths: remainingTerm(note.maturityDate, now),
  }));
}

// A box with a standing price is scored at its own price, so its price limits apply to what it would pay rather than
// to the seller's ask, and a tape asking more than the box pays still gets the box's figure. A yield or spread rule
// meets its target IRR by construction, so that limit gives way to performing loans only. When the price misses the
// box's other limits, the box is scored at the ask as before, with no price. ignoreAsk prices before the ask caps it.
export function scoreMatch(
  kind: string,
  standingNotes: StandingNote[],
  box: BoxRow,
  notes: ScoreNote[],
  now: Date,
  premiumBps: number,
  rate: MarketRate | null,
  options: { ignoreAsk?: boolean } = {},
) {
  const priced = ruleHolder(box.user) ? indicativeFor(box, { kind }, standingNotes, now, premiumBps, rate, options) : null;
  if (priced?.price != null) {
    const criteria = criteriaFrom(box);
    const atBid = notes.map((note, index) => ({ ...note, askingPrice: priced.loans[index]?.price ?? note.askingPrice }));
    const solved = box.bidBasis === "YIELD" || box.bidBasis === "SPREAD";
    const limits = solved ? { ...criteria, targetYield: null, statuses: criteria.statuses.length ? criteria.statuses : ["PERFORMING"] } : criteria;
    const result = scoreAgainstBox(atBid, limits);
    if (result) return { result: { ...result, reasons: [...result.reasons, "At the standing price"] }, price: priced.price, rateAsOf: priced.rateAsOf };
  }
  return { result: scoreAgainstBox(notes, criteriaFrom(box)), price: null, rateAsOf: null };
}

function sameTime(a: Date | null | undefined, b: Date | null | undefined) {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

// The standing price on a match nobody has answered. A bid or a pass keeps the figure it answered, and a price that
// moves withdraws the desk's invite, so a buyer never confirms a figure the desk didn't send. A spread price carries
// the date of the rate it used; a new rate that leaves the price where it was only moves that date.
async function reprice(
  match: { id: string; indicativePrice: number | null; answeredAt: Date | null; rateAsOf?: Date | null },
  price: number | null,
  rateAsOf: Date | null,
  now: Date,
) {
  if (match.answeredAt) return;
  const stamp = price == null ? null : rateAsOf;
  if (match.indicativePrice === price) {
    if (sameTime(match.rateAsOf, stamp)) return;
    await prisma.listingMatch.updateMany({ where: { id: match.id, indicativePrice: price, ...unset("answeredAt") }, data: { rateAsOf: stamp } });
    return;
  }
  await prisma.listingMatch.updateMany({
    where: { id: match.id, ...unset("answeredAt") },
    data: { indicativePrice: price, indicativeAt: price == null ? null : now, invitedAt: null, rateAsOf: stamp },
  });
}

async function writeMatch(listing: ListingRow, box: BoxRow, notes: ScoreNote[], now: Date, premiumBps: number, rate: MarketRate | null) {
  const { result, price, rateAsOf } = scoreMatch(listing.kind, listing.notes, box, notes, now, premiumBps, rate);
  if (!result) {
    await prisma.listingMatch.deleteMany({ where: { listingId: listing.id, buyBoxId: box.id } });
    return null;
  }
  const match = await prisma.listingMatch.upsert({
    where: { listingId_buyBoxId: { listingId: listing.id, buyBoxId: box.id } },
    create: { listingId: listing.id, buyBoxId: box.id, userId: box.userId, score: result.score, reasons: result.reasons.join(" · ") },
    update: { score: result.score, reasons: result.reasons.join(" · "), userId: box.userId },
  });
  await reprice(match, price, rateAsOf, now);
  return { ...result, price };
}

// The desk hears once per tape that standing bids are waiting, from whichever scoring run finds them first.
async function tellDeskOfStandingBids(listing: ListingRow, bids: { userId: string; ofUpb: number | null }[], now: Date) {
  if (!bids.length || !sheetShows(listing.status)) return;
  if (!(await claimStandingNotice(listing.id, now))) return;
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/admin/listings/${listing.id}#standing-bids`;
  await notifyDesk(
    `Standing bids · ${listing.title}`,
    `${standingNotice(listing.title, bids)} They are indicative until each buyer confirms. Review them and invite buyers here: ${link}`,
  );
}

export async function rescoreListing(listingId: string, alert: boolean) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
  if (!listing || listing.status === "REJECTED") return;
  const boxes = await prisma.buyBox.findMany({ where: { active: true }, include: { user: true } });
  const now = new Date();
  // Yield and spread rules hold on what the buyer pays, premium included. Spread rules price on the desk's rate.
  const settings = await getSettings();
  const premiumBps = settings.buyerPremiumBps;
  const rate = marketRate(settings);
  const notes = notesOf(listing.notes, now);
  const upb = notes.reduce((sum, note) => sum + note.upb, 0);
  const mailed = new Map<string, { email: string; score: number; name: string }>();
  const standing: { userId: string; ofUpb: number | null }[] = [];
  for (const box of boxes) {
    const result = await writeMatch(listing, box, notes, now, premiumBps, rate);
    if (result?.price != null) standing.push({ userId: box.userId, ofUpb: upb > 0 ? (result.price / upb) * 100 : null });
    if (!result || !alert || listing.status !== "APPROVED") continue;
    if (box.user.role !== "BUYER" || box.user.accountStatus !== "APPROVED") continue;
    const prior = mailed.get(box.userId);
    if (!prior || result.score > prior.score) mailed.set(box.userId, { email: box.user.email, score: result.score, name: box.name });
  }
  for (const hit of mailed.values()) {
    await notify(
      hit.email,
      `Buy box match · ${listing.title}`,
      `${listing.title} is live and scores ${hit.score} against “${hit.name}”. ${hit.score >= 80 ? "It sits close to the box." : "Open the book to underwrite it."}`,
    );
  }
  await tellDeskOfStandingBids(listing, standing, now);
}

// Scores the box against every open listing, which also reprices its open matches when its rule changes. A rule
// change is quiet, since the buyer just made it.
export async function rescoreBox(boxId: string, options: { quiet?: boolean } = {}) {
  const box = await prisma.buyBox.findUnique({ where: { id: boxId }, include: { user: true } });
  if (!box) return 0;
  const listings = await prisma.listing.findMany({
    where: { status: { in: ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING"] } },
    include: { notes: true },
  });
  const now = new Date();
  // Yield and spread rules hold on what the buyer pays, premium included. Spread rules price on the desk's rate.
  const settings = await getSettings();
  const premiumBps = settings.buyerPremiumBps;
  const rate = marketRate(settings);
  let live = 0;
  for (const listing of listings) {
    const result = await writeMatch(listing, box, notesOf(listing.notes, now), now, premiumBps, rate);
    if (result && listing.status === "APPROVED") live += 1;
  }
  if (!options.quiet && live > 0 && box.active && box.user.role === "BUYER") {
    await notify(box.user.email, `Buy box · ${box.name}`, `${live} live listing${live === 1 ? "" : "s"} currently fit this box.`);
  }
  return live;
}

// A new 10-year rate reprices every spread rule's open matches, quietly. Returns how many boxes it rescored.
export async function rescoreSpreadBoxes() {
  const boxes = await prisma.buyBox.findMany({ where: { active: true, standingBids: true, bidBasis: "SPREAD" }, select: { id: true } });
  for (const box of boxes) await rescoreBox(box.id, { quiet: true });
  return boxes.length;
}

export type DraftLoan = StandingNote & { state: string; lienPosition: string };

export type StandingDemand = {
  // Each fitting box's own price for the whole draft, before the ask caps it. No buyer or box is named.
  standing: StandingPoint[];
  // Boxes that fit at the ask, with or without a standing price.
  fits: number;
};

// What standing demand on UPB would make of paper not yet listed: every active box of an approved buyer, scored as a
// new tape would be. Server only, and for the seller's own view at upload; it reads every box but returns no names.
export async function standingDemand(kind: string, loans: DraftLoan[], now = new Date()): Promise<StandingDemand> {
  if (!loans.length) return { standing: [], fits: 0 };
  const [boxes, settings] = await Promise.all([
    prisma.buyBox.findMany({ where: { active: true, user: { role: "BUYER", accountStatus: "APPROVED" } }, include: { user: true } }),
    getSettings(),
  ]);
  const rate = marketRate(settings);
  const notes = notesOf(loans, now);
  const standing: StandingPoint[] = [];
  let fits = 0;
  for (const box of boxes) {
    const own = scoreMatch(kind, loans, box, notes, now, settings.buyerPremiumBps, rate, { ignoreAsk: true });
    if (own.price != null && own.result) standing.push({ price: own.price, rateAsOf: own.rateAsOf, pricedAt: now });
    if (own.result) fits += 1;
  }
  return { standing, fits };
}
