import type { Prisma } from "@prisma/client";
import { boxHasConstraint, parseList, scoreAgainstBox, seasoningMonths, type BoxCriteria, type BoxScore, type ScoreNote } from "@/lib/buy-box";
import { craCount, craCountLine, craReasonText, craShare, isCraEligible } from "@/lib/cra";
import { unset } from "@/lib/db-filters";
import { notify, notifyDesk } from "@/lib/email";
import { programLabel } from "@/lib/filters";
import { keepRegulated, REGULATED, regulatedOnly } from "@/lib/institutions";
import { launchPending } from "@/lib/launch-rules";
import { prisma } from "@/lib/prisma";
import { audienceOf, canSee, listingAccess } from "@/lib/private-listings";
import { marketRate, type MarketRate, type StandingPoint } from "@/lib/indicative";
import { getSettings } from "@/lib/settings";
import {
  claimStandingNotice,
  indicativeFor,
  remainingTerm,
  ruleHolder,
  ruleOf,
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
  maxLtv?: { toString(): string } | null;
  minSeasoningMonths?: number | null;
  programs?: string;
  craOnly?: boolean | null;
}): BoxRules {
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
    maxLtv: num(box.maxLtv ?? null),
    minSeasoningMonths: box.minSeasoningMonths ?? null,
    programs: parseList(box.programs ?? ""),
    craOnly: box.craOnly === true,
  };
}

// A box's limits with the loan programs it takes, and whether it takes CRA-eligible paper only. A box saved before
// programs or the CRA switch existed takes any.
export type BoxRules = BoxCriteria & { programs: string[]; craOnly?: boolean };
// A loan as a box scores it, with its program and CRA facts. Null or left out where the tape states none.
export type ProgramNote = ScoreNote & { loanProgram?: string | null; tractIncomeLevel?: string | null; lmiBorrower?: boolean | null };

// The loan programs a box takes, judged as its lien and performance are: a pool fits when at least half its UPB
// carries one of them. A loan whose tape states no program never counts toward the limit, as on the book's filter.
// The reason names the programs the paper carries, in the box's words.
export function programFit(notes: ProgramNote[], programs: string[]): { fit: boolean; reason: string | null } {
  if (!programs.length) return { fit: true, reason: null };
  const total = notes.reduce((sum, note) => sum + note.upb, 0);
  const carried = notes.filter((note) => note.loanProgram != null && programs.includes(note.loanProgram));
  const covered = total > 0 ? carried.reduce((sum, note) => sum + note.upb, 0) / total : 0;
  if (covered < 0.5) return { fit: false, reason: null };
  const named = programs.filter((program) => carried.some((note) => note.loanProgram === program)).map(programLabel);
  const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0];
  return { fit: true, reason: covered >= 0.999 ? `${list}, as your box asks` : `${Math.round(covered * 100)}% of UPB is ${list}, as your box asks` };
}

// A box that takes CRA-eligible paper only, judged as its programs are: a pool fits when at least half its UPB reads as
// CRA-eligible (lib/cra.ts, UPB's simplified reading). A loan whose tape states neither CRA fact never counts. The
// reason counts the loans, or names the single loan's reason.
export function craFit(notes: ProgramNote[], craOnly: boolean | undefined): { fit: boolean; reason: string | null } {
  if (!craOnly) return { fit: true, reason: null };
  if (craShare(notes) < 0.5) return { fit: false, reason: null };
  const count = craCount(notes);
  return { fit: true, reason: notes.length === 1 ? `CRA-eligible (${craReasonText(count.reasons)}), as your box asks` : `${craCountLine(count)}, as your box asks` };
}

// The box test with its programs and the CRA switch. A box whose only limits are these leaves lib/buy-box.ts nothing
// else to check, so the paper scores the base any fit starts at, 55, once it has a balance and a price, as every scored
// tape must.
export function scoreBox(notes: ProgramNote[], box: BoxRules): BoxScore | null {
  const programs = programFit(notes, box.programs);
  if (!programs.fit) return null;
  const cra = craFit(notes, box.craOnly);
  if (!cra.fit) return null;
  const upb = notes.reduce((sum, note) => sum + note.upb, 0);
  const price = notes.reduce((sum, note) => sum + note.askingPrice, 0);
  const own = box.programs.length > 0 || box.craOnly === true;
  const result = boxHasConstraint(box) ? scoreAgainstBox(notes, box) : own && upb > 0 && price > 0 ? { score: 55, reasons: [] } : null;
  const extra = [programs.reason, cra.reason].filter((reason): reason is string => Boolean(reason));
  if (!result || !extra.length) return result;
  return { score: result.score, reasons: [...result.reasons, ...extra] };
}

// A draft at upload may not carry a value, an origination date or a loan program. Without them a box's LTV, seasoning
// or program limit can't be met, so it doesn't count the draft.
type ScoredLoan = Pick<StandingNote, "upb" | "askingPrice" | "monthlyPi" | "interestRate" | "maturityDate" | "paymentStatus"> & {
  state: string;
  lienPosition: string;
  estimatedValue?: number;
  originationDate?: Date | null;
  loanProgram?: string | null;
  tractIncomeLevel?: string | null;
  lmiBorrower?: boolean | null;
};

function notesOf(notes: ScoredLoan[], now: Date): ProgramNote[] {
  return notes.map((note) => ({
    state: note.state,
    lienPosition: note.lienPosition,
    paymentStatus: note.paymentStatus,
    upb: Number(note.upb),
    askingPrice: Number(note.askingPrice),
    monthlyPi: Number(note.monthlyPi),
    interestRate: Number(note.interestRate),
    termMonths: remainingTerm(note.maturityDate, now),
    estimatedValue: note.estimatedValue === undefined ? undefined : Number(note.estimatedValue),
    seasoningMonths: seasoningMonths(note.originationDate, now),
    loanProgram: note.loanProgram ?? null,
    tractIncomeLevel: note.tractIncomeLevel ?? null,
    lmiBorrower: note.lmiBorrower ?? null,
  }));
}

// A box with a standing price is scored at its own price, so its price limits apply to what it would pay rather than
// to the seller's ask, and a tape asking more than the box pays still gets the box's figure. A yield or spread rule
// meets its target IRR by construction, so that limit gives way to performing loans only. When the price misses the
// box's other limits, the box is scored at the ask as before, with no price. ignoreAsk prices before the ask caps it.
// A standing price is a bid for the whole listing, so a box that takes CRA-eligible paper only prices a listing only
// when every loan on it reads as CRA-eligible; a pool that fits on half its UPB is scored without a price.
export function scoreMatch(
  kind: string,
  standingNotes: StandingNote[],
  box: BoxRow,
  notes: ProgramNote[],
  now: Date,
  premiumBps: number,
  rate: MarketRate | null,
  options: { ignoreAsk?: boolean } = {},
) {
  const criteria = criteriaFrom(box);
  const ineligible = criteria.craOnly ? notes.filter((note) => !isCraEligible(note)).length : 0;
  const ruled = ruleHolder(box.user);
  const priced = ruled && !ineligible ? indicativeFor(box, { kind }, standingNotes, now, premiumBps, rate, options) : null;
  if (priced?.price != null) {
    const atBid = notes.map((note, index) => ({ ...note, askingPrice: priced.loans[index]?.price ?? note.askingPrice }));
    const solved = box.bidBasis === "YIELD" || box.bidBasis === "SPREAD";
    const limits = solved ? { ...criteria, targetYield: null, statuses: criteria.statuses.length ? criteria.statuses : ["PERFORMING"] } : criteria;
    const result = scoreBox(atBid, limits);
    if (result) return { result: { ...result, reasons: [...result.reasons, "At the standing price"] }, price: priced.price, rateAsOf: priced.rateAsOf };
  }
  const result = scoreBox(notes, criteria);
  // Say why a box with a standing rule sent no price, so the buyer doesn't read it as a miss.
  if (result && ineligible && ruled && ruleOf(box)) {
    const held = `${ineligible === 1 ? "1 loan isn't" : `${ineligible} loans aren't`} CRA-eligible, so no standing price`;
    return { result: { ...result, reasons: [...result.reasons, held] }, price: null, rateAsOf: null };
  }
  return { result, price: null, rateAsOf: null };
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

async function writeMatch(listing: ListingRow, box: BoxRow, notes: ProgramNote[], now: Date, premiumBps: number, rate: MarketRate | null) {
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
    // The top figure is a bid amount, so it stays behind the wall with the sheet.
    { capability: "sealedBids" },
  );
}

// Active boxes with their owners, read apart: deleting an account removes its boxes a moment later on MongoDB, and a
// required include on a box whose owner is gone fails the whole read. A box without its owner is skipped.
async function boxesWithOwners(where: Prisma.BuyBoxWhereInput, owners: Prisma.UserWhereInput = {}) {
  const boxes = await prisma.buyBox.findMany({ where });
  if (!boxes.length) return [];
  const users = await prisma.user.findMany({ where: { ...owners, id: { in: [...new Set(boxes.map((box) => box.userId))] } } });
  const byId = new Map(users.map((user) => [user.id, user]));
  return boxes.flatMap((box) => {
    const user = byId.get(box.userId);
    return user ? [{ ...box, user }] : [];
  });
}

export async function rescoreListing(listingId: string, alert: boolean, now = new Date()) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
  if (!listing || listing.status === "REJECTED") return;
  // A coming-soon listing is scored quietly. Its buyers hear, and the desk's standing-bid notice goes, at the launch.
  const coming = launchPending(listing, now);
  const mail = alert && !coming;
  const boxes = await boxesWithOwners({ active: true });
  // A private listing matches its invitees' boxes only, and none of a buyer its seller excludes. Their open matches
  // go, so neither the buyer nor the desk's standing-bid sheet keeps them (lib/private-listings.ts). A sale open to banks
  // and credit unions only matches theirs alone (lib/institutions.ts).
  const shown = new Set((await keepRegulated(listing, await audienceOf(listing, [...new Map(boxes.map((box) => [box.userId, box.user])).values()]))).map((user) => user.id));
  // Yield and spread rules hold on what the buyer pays, premium included. Spread rules price on the desk's rate.
  const settings = await getSettings();
  const premiumBps = settings.buyerPremiumBps;
  const rate = marketRate(settings);
  const notes = notesOf(listing.notes, now);
  const upb = notes.reduce((sum, note) => sum + note.upb, 0);
  const mailed = new Map<string, { email: string; score: number; name: string; boxId: string }>();
  const standing: { userId: string; ofUpb: number | null }[] = [];
  for (const box of boxes) {
    if (!shown.has(box.userId)) {
      await prisma.listingMatch.deleteMany({ where: { listingId: listing.id, buyBoxId: box.id, ...unset("answeredAt") } });
      continue;
    }
    const result = await writeMatch(listing, box, notes, now, premiumBps, rate);
    if (result?.price != null) standing.push({ userId: box.userId, ofUpb: upb > 0 ? (result.price / upb) * 100 : null });
    if (!result || !mail || listing.status !== "APPROVED") continue;
    if (box.user.role !== "BUYER" || box.user.accountStatus !== "APPROVED") continue;
    const prior = mailed.get(box.userId);
    if (!prior || result.score > prior.score) mailed.set(box.userId, { email: box.user.email, score: result.score, name: box.name, boxId: box.id });
  }
  for (const hit of mailed.values()) {
    await notify(
      hit.email,
      `Buy box match · ${listing.title}`,
      `${listing.title} is live and scores ${hit.score} against “${hit.name}”. ${hit.score >= 80 ? "It sits close to the box." : "Open the book to underwrite it."}`,
    );
  }
  // Buyers on Pro hear the same match on their own webhooks, with ids and the listing's public terms only.
  if (mailed.size) {
    const { emitBuyerWebhook } = await import("@/lib/webhooks");
    for (const [userId, hit] of mailed) {
      await emitBuyerWebhook(userId, "listing.matched", {
        listingId: listing.id,
        title: listing.title,
        buyBoxId: hit.boxId,
        score: hit.score,
        saleFormat: listing.bidMode,
        bidDeadline: listing.bidMode !== "NONE" && listing.bidDeadline ? listing.bidDeadline.toISOString() : null,
        webUrl: `${process.env.NEXT_PUBLIC_APP_URL || ""}/marketplace/${listing.id}`,
      });
    }
  }
  if (!coming) await tellDeskOfStandingBids(listing, standing, now);
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
  // Listings hidden from the box's owner don't match it, as in rescoreListing.
  const access = await listingAccess(box.user);
  // Nor do sales open to banks and credit unions only, unless the owner has one on file (lib/institutions.ts).
  const regulated = (await keepRegulated({ buyerLimit: REGULATED }, [box.user])).length > 0;
  let live = 0;
  for (const listing of listings) {
    if (!canSee(access, listing) || (regulatedOnly(listing) && !regulated)) {
      await prisma.listingMatch.deleteMany({ where: { listingId: listing.id, buyBoxId: box.id, ...unset("answeredAt") } });
      continue;
    }
    const result = await writeMatch(listing, box, notesOf(listing.notes, now), now, premiumBps, rate);
    if (result && listing.status === "APPROVED" && !launchPending(listing, now)) live += 1;
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

// A draft without its CRA facts doesn't fit a box that takes CRA-eligible paper only, as with the program.
export type DraftLoan = StandingNote & { state: string; lienPosition: string; loanProgram?: string | null; tractIncomeLevel?: string | null; lmiBorrower?: boolean | null };

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
    boxesWithOwners({ active: true }, { role: "BUYER", accountStatus: "APPROVED" }),
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
