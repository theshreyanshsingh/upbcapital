import type { Listing, User } from "@prisma/client";
import { deadlinePassed } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import { money, prettyDate } from "@/lib/format";
import { articleFor, marketRate, rateStale, type MarketRate } from "@/lib/indicative";
import { announceInquiry, checkOffer, logEligibility, writeInquiry } from "@/lib/inquiry";
import { ofacBlocks } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";
import { getSettings, isPro } from "@/lib/settings";
import { headlinePrices, type CashFlowInput } from "@/lib/underwriting";

// The book's indicative price solves for this yield when the desk hasn't set indicativeTargetYield.
export { DEFAULT_INDICATIVE_YIELD } from "@/lib/indicative";

const DAY = 24 * 60 * 60 * 1000;

export type StandingBox = {
  standingBids: boolean | null;
  bidBasis: string | null;
  bidPercent: number | null;
  bidCap: number | null;
  targetYield: number | null;
  // Basis SPREAD: points over the desk's 10-year Treasury rate.
  bidSpread?: number | null;
};

export type StandingRule =
  | { basis: "UPB"; percent: number; cap: number | null }
  | { basis: "YIELD"; target: number; cap: number | null }
  | { basis: "SPREAD"; spread: number; cap: number | null };

// The box's price rule, or null when it has none that can price. A yield rule prices for the box's target IRR, and
// a spread rule for the 10-year rate plus its spread.
export function ruleOf(box: StandingBox): StandingRule | null {
  if (box.standingBids !== true) return null;
  const cap = box.bidCap != null && box.bidCap > 0 ? box.bidCap : null;
  if (box.bidBasis === "UPB" && box.bidPercent != null && box.bidPercent > 0) return { basis: "UPB", percent: box.bidPercent, cap };
  if (box.bidBasis === "YIELD" && box.targetYield != null && box.targetYield > 0) return { basis: "YIELD", target: box.targetYield, cap };
  if (box.bidBasis === "SPREAD" && box.bidSpread != null && box.bidSpread > 0) return { basis: "SPREAD", spread: box.bidSpread, cap };
  return null;
}

function points(value: number) {
  return String(Math.round(value * 100) / 100);
}


// The IRR a yield or spread rule prices for, or null: a UPB rule has none, and a spread rule waits for a rate.
export function ruleTarget(rule: StandingRule | null, rate: MarketRate | null) {
  if (!rule || rule.basis === "UPB") return null;
  if (rule.basis === "YIELD") return rule.target;
  return rate ? Math.round((rate.rate + rule.spread) * 100) / 100 : null;
}

// A spread rule names the rate it used and its date, so a figure from an old rate reads as one.
export function ruleLabel(rule: StandingRule | null, rate: MarketRate | null = null) {
  if (!rule) return "Off";
  const cap = rule.cap != null ? `, at most ${money(rule.cap)} a loan` : "";
  if (rule.basis === "UPB") return `${rule.percent}% of UPB${cap}`;
  if (rule.basis === "YIELD") return `Price for ${articleFor(String(rule.target))} ${rule.target}% IRR${cap}`;
  const target = points(ruleTarget(rule, rate) ?? 0);
  const at = rate
    ? `, ${articleFor(target)} ${target}% IRR on the ${points(rate.rate)}% rate as of ${prettyDate(rate.asOf)}`
    : ", waiting for the desk's 10-year rate";
  return `10-year Treasury + ${points(rule.spread)} points${at}${cap}`;
}

// Standing bids are a Pro privilege for approved buyers. A lapsed membership keeps the rule on file but prices nothing.
export function ruleHolder(user: Pick<User, "role" | "accountStatus" | "subscriptionTier" | "subscriptionStatus" | "subscriptionCurrentPeriodEnd">) {
  return user.role === "BUYER" && user.accountStatus === "APPROVED" && isPro(user);
}

// Months left to maturity, the way the buy box scores a tape. No maturity date reads as 30 years.
export function remainingTerm(maturityDate: Date | null, now = new Date()) {
  if (!maturityDate) return 360;
  return Math.min(480, Math.max(12, Math.round((maturityDate.getTime() - now.getTime()) / (DAY * 30))));
}

// The price at which a loan's performing cash flows return the target IRR: the deal analyzer's headline, from the
// same solver. The two can differ by a fraction of a percent, because this counts the remaining term in 30-day
// months. With the buyer premium passed, the target holds on what the buyer actually pays rather than on the bid.
export function yieldPrice(loan: Omit<CashFlowInput, "bid">, targetPct: number, premiumBps = 0) {
  if (!(loan.upb > 0) || !(loan.monthlyPi > 0) || !(targetPct > 0)) return null;
  const [bid] = headlinePrices(
    { upb: loan.upb, interestRate: loan.annualRate, monthlyPi: loan.monthlyPi, termMonths: loan.termMonths, paymentStatus: "PERFORMING" },
    [targetPct],
    { premiumBps },
  );
  return bid != null && Number.isFinite(bid) && bid > 0 ? bid : null;
}

export type StandingNote = {
  id: string;
  upb: number;
  askingPrice: number;
  interestRate: number;
  monthlyPi: number;
  paymentStatus: string;
  maturityDate: Date | null;
  tradeStatus: string;
};

export type PricedLoan = {
  noteId: string;
  price: number | null;
  // What set the price: the rule itself, the box's per-loan cap, or the seller's ask.
  limit: "rule" | "cap" | "ask" | null;
  skipped: "traded" | "status" | "data" | null;
};

function priceLoan(rule: StandingRule, target: number | null, note: StandingNote, now: Date, premiumBps: number, ignoreAsk: boolean): PricedLoan {
  const skip = (skipped: PricedLoan["skipped"]): PricedLoan => ({ noteId: note.id, price: null, limit: null, skipped });
  if (note.tradeStatus !== "AVAILABLE") return skip("traded");
  if (!(note.upb > 0)) return skip("data");
  // The performing model assumes every payment arrives. Nothing here prices a sub- or non-performing loan to a
  // yield the buyer could be held to, so a yield or spread rule leaves them unpriced.
  if (rule.basis !== "UPB" && note.paymentStatus !== "PERFORMING") return skip("status");
  const raw = rule.basis === "UPB"
    ? (note.upb * rule.percent) / 100
    : target == null
      ? null
      : yieldPrice({ upb: note.upb, annualRate: note.interestRate, monthlyPi: note.monthlyPi, termMonths: remainingTerm(note.maturityDate, now) }, target, premiumBps);
  if (raw == null || !(raw > 0)) return skip("data");
  // Never more than the box pays for one loan, and never more than the seller asks.
  let price = raw;
  let limit: PricedLoan["limit"] = "rule";
  if (rule.cap != null && rule.cap < price) {
    price = rule.cap;
    limit = "cap";
  }
  if (!ignoreAsk && note.askingPrice > 0 && note.askingPrice < price) {
    price = note.askingPrice;
    limit = "ask";
  }
  return { noteId: note.id, price: Math.round(price), limit, skipped: null };
}

function unpricedText(loans: PricedLoan[], kind: string) {
  const pool = kind === "POOL" && loans.length > 1;
  const count = (skipped: PricedLoan["skipped"]) => loans.filter((loan) => loan.skipped === skipped).length;
  const some = (n: number, many: string, one: string) => (pool ? `${n} of ${loans.length} loans ${many}` : `This loan ${one}`);
  if (count("traded")) return pool ? `${some(count("traded"), "have traded", "")}, so the pool can't be bid whole.` : "This loan has traded.";
  if (count("status")) return `${some(count("status"), "are", "is")} sub- or non-performing. A yield or spread rule prices performing loans only.`;
  return `${some(count("data"), "lack", "lacks")} the balance or payment to price.`;
}

export type Indicative = {
  price: number | null;
  upb: number;
  ofUpb: number | null;
  loans: PricedLoan[];
  why: string;
  // The IRR a yield or spread rule solved for, and for a spread rule the date of the 10-year rate it used.
  target: number | null;
  rateAsOf: Date | null;
};

export const NO_RATE = "The desk hasn't entered a 10-year rate yet, so a spread rule can't price.";

// The box's standing price for a listing: each loan by the rule, under the per-loan cap and the loan's ask, summed for
// a pool. A whole-listing bid needs every loan priced, so one loan the rule can't price leaves the listing unpriced.
// A spread rule prices on the rate passed in; ignoreAsk gives the box's own figure before the seller's ask caps it,
// for the seller's view of standing demand at upload.
export function indicativeFor(
  box: StandingBox,
  listing: { kind: string },
  notes: StandingNote[],
  now = new Date(),
  premiumBps = 0,
  rate: MarketRate | null = null,
  options: { ignoreAsk?: boolean } = {},
): Indicative | null {
  const rule = ruleOf(box);
  if (!rule) return null;
  const target = ruleTarget(rule, rate);
  const rateAsOf = rule.basis === "SPREAD" && rate ? rate.asOf : null;
  const upb = notes.reduce((sum, note) => sum + Math.max(note.upb, 0), 0);
  const none = (why: string, loans: PricedLoan[] = []): Indicative => ({ price: null, upb, ofUpb: null, loans, why, target, rateAsOf });
  if (rule.basis === "SPREAD" && !rate) return none(NO_RATE);
  const loans = notes.map((note) => priceLoan(rule, target, note, now, premiumBps, options.ignoreAsk === true));
  if (!loans.length) return none("There are no loans to price.", loans);
  if (loans.some((loan) => loan.price == null)) return none(unpricedText(loans, listing.kind), loans);
  const price = loans.reduce((sum, loan) => sum + (loan.price ?? 0), 0);
  return { price, upb, ofUpb: upb > 0 ? (price / upb) * 100 : null, loans, why: "", target, rateAsOf };
}

// The desk's 10-year rate from settings, for pricing spread rules.
export async function currentRate() {
  return marketRate(await getSettings());
}

export type RuleData = {
  standingBids: boolean;
  bidBasis?: string;
  bidPercent?: number;
  bidCap?: number | null;
  targetYield?: number;
  bidSpread?: number;
};

function figure(raw: string) {
  const clean = raw.replace(/[$,%\s]/g, "");
  if (!clean) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : Number.NaN;
}

// The buyer's rule from the form. Turning it off keeps the figures, so turning it back on starts where they left it.
export function readStandingRule(
  fields: { basis: string; percent: string; cap: string; target: string; spread?: string },
  box: { targetYield: number | null; maxPriceToUpb: number | null },
  pro: boolean,
): { error: string } | { error: null; data: RuleData } {
  if (fields.basis === "OFF") return { error: null, data: { standingBids: false } };
  if (fields.basis !== "UPB" && fields.basis !== "YIELD" && fields.basis !== "SPREAD") return { error: "Choose how the box prices a tape." };
  if (!pro) return { error: "Standing bids are a Pro privilege." };
  const cap = figure(fields.cap);
  if (cap != null && !(cap > 0)) return { error: "Enter the most for one loan in dollars, or leave it blank." };
  if (fields.basis === "UPB") {
    const percent = figure(fields.percent);
    if (percent == null || !(percent >= 1 && percent <= 110)) return { error: "Enter the bid as a percent of UPB, from 1 to 110." };
    if (box.maxPriceToUpb != null && percent > box.maxPriceToUpb) {
      return { error: `This box tops out at ${box.maxPriceToUpb}% of UPB, so the rule can't bid above it.` };
    }
    return { error: null, data: { standingBids: true, bidBasis: "UPB", bidPercent: percent, bidCap: cap } };
  }
  if (fields.basis === "SPREAD") {
    const spread = figure(fields.spread ?? "");
    if (spread == null || !(spread > 0 && spread <= 30)) return { error: "Enter the spread over the 10-year Treasury in percentage points, above 0 and up to 30." };
    return { error: null, data: { standingBids: true, bidBasis: "SPREAD", bidCap: cap, bidSpread: spread } };
  }
  const typed = figure(fields.target);
  if (typed != null && !(typed >= 1 && typed <= 50)) return { error: "Enter the target IRR as a percent, from 1 to 50." };
  const target = typed ?? box.targetYield;
  if (target == null || !(target > 0)) return { error: "Set a target IRR so the rule can price for it." };
  return { error: null, data: { standingBids: true, bidBasis: "YIELD", bidCap: cap, ...(typed != null ? { targetYield: typed } : {}) } };
}

// The desk's line about a tape's standing bids, with the best as a share of UPB.
export function standingNotice(title: string, bids: { userId: string; ofUpb: number | null }[]) {
  const top = Math.max(...bids.map((bid) => bid.ofUpb ?? 0));
  const buyers = new Set(bids.map((bid) => bid.userId)).size;
  const from = buyers < bids.length ? ` from ${buyers} buyer${buyers === 1 ? "" : "s"}` : "";
  return `${bids.length} standing bid${bids.length === 1 ? "" : "s"}${from} on ${title}, top ${Math.round(top)}% of UPB.`;
}

// The desk hears about a tape's standing bids once. Only the scoring run that sets the listing's notice date sends;
// a second run, or a resubmission, finds it set.
export async function claimStandingNotice(listingId: string, now = new Date()) {
  const claimed = await prisma.listing.updateMany({ where: { id: listingId, ...unset("standingBidsNotifiedAt") }, data: { standingBidsNotifiedAt: now } });
  return claimed.count === 1;
}

// The desk sees standing bids while a tape is in review or live. Later statuses have nothing left to price.
export function sheetShows(status: string) {
  return status === "SUBMITTED" || status === "UNDER_REVIEW" || status === "APPROVED";
}

// Why the desk can't send this standing bid to its buyer, or null when it can. A bid needs a live listing, so a
// tape in review shows its standing bids and the invites wait for approval.
export function inviteBlock(input: {
  status: string;
  bidMode: string;
  bidDeadline: Date | null;
  price: number | null;
  invitedAt: Date | null;
  answeredAt: Date | null;
  buyer: { role: string; accountStatus: string };
  held: boolean;
  now?: Date;
}) {
  if (input.answeredAt) return "The buyer has answered.";
  if (input.invitedAt) return "Sent to the buyer.";
  if (input.price == null) return "There is no standing price to send.";
  if (input.status !== "APPROVED") return "Invites open once the listing is live.";
  if (input.bidMode !== "NONE" && deadlinePassed(input.bidDeadline, input.now)) return "The bid deadline has passed.";
  if (input.buyer.role !== "BUYER" || input.buyer.accountStatus !== "APPROVED") return "That buyer's account is not approved.";
  if (input.held) return OFAC_HOLD_MESSAGE;
  return null;
}

export type SheetRow = {
  matchId: string;
  buyerName: string;
  boxName: string;
  rule: string;
  price: number | null;
  ofUpb: number | null;
  ofAsk: number | null;
  pricedAt: Date | null;
  // For a spread rule: the 10-year rate's date behind the price, and whether it is over a week old.
  rateAsOf: Date | null;
  rateStale: boolean;
  invitedAt: Date | null;
  answeredAt: Date | null;
  inquiryId: string | null;
  why: string;
  flags: string[];
  canInvite: boolean;
  block: string;
};

type SheetListing = Pick<Listing, "id" | "kind" | "status" | "bidMode" | "bidDeadline" | "sellerId"> & { notes: StandingNote[] };

// Every box with a rule that fits the listing, best price first, with what the desk should know before inviting.
export async function standingSheet(listing: SheetListing, now = new Date()): Promise<SheetRow[]> {
  const matches = await prisma.listingMatch.findMany({
    where: { listingId: listing.id },
    include: { buyBox: { include: { user: { include: { buyerProfile: true } } } } },
  });
  const shown = matches.filter((match) => ruleOf(match.buyBox) || match.indicativePrice != null || match.invitedAt || match.answeredAt);
  if (!shown.length) return [];
  const buyerIds = [...new Set(shown.map((match) => match.buyBox.userId))];
  const [checks, bids, listingHeld, rate] = await Promise.all([
    prisma.ofacCheck.findMany({ where: { result: "REVIEW", userId: { in: buyerIds } } }),
    prisma.inquiry.findMany({ where: { listingId: listing.id, type: "OFFER", buyerId: { in: buyerIds }, status: { in: ["OPEN", "REVIEWED", "ACCEPTED"] } }, select: { buyerId: true } }),
    ofacHold({ listingId: listing.id, userIds: [listing.sellerId] }),
    currentRate(),
  ]);
  const held = new Set(checks.filter(ofacBlocks).map((check) => check.userId));
  const bidders = new Set(bids.map((bid) => bid.buyerId));
  const upb = listing.notes.reduce((sum, note) => sum + note.upb, 0);
  const ask = listing.notes.reduce((sum, note) => sum + note.askingPrice, 0);
  const rows = shown.map((match): SheetRow => {
    const box = match.buyBox;
    const buyer = box.user;
    const rule = ruleOf(box);
    const price = match.indicativePrice;
    const flags: string[] = [];
    if (held.has(buyer.id)) flags.push("OFAC review open");
    if (buyer.buyerProfile?.status !== "APPROVED") flags.push("Buyer file not approved");
    if (bidders.has(buyer.id) && !match.inquiryId) flags.push("Already bid on this listing");
    let why = "";
    if (price == null) {
      if (!rule) why = "The rule is off.";
      else if (!ruleHolder(buyer)) why = "The buyer isn't on Pro, so the rule prices nothing.";
      else why = indicativeFor(box, listing, listing.notes, now, 0, rate)?.why || "The standing price falls outside the box's own limits.";
    }
    const block = inviteBlock({
      status: listing.status,
      bidMode: listing.bidMode,
      bidDeadline: listing.bidDeadline,
      price,
      invitedAt: match.invitedAt,
      answeredAt: match.answeredAt,
      buyer,
      held: held.has(buyer.id) || Boolean(listingHeld),
      now,
    });
    return {
      matchId: match.id,
      buyerName: buyer.buyerProfile?.entityName || buyer.companyName || buyer.name,
      boxName: box.name,
      rule: ruleLabel(rule, rate),
      price,
      ofUpb: price != null && upb > 0 ? (price / upb) * 100 : null,
      ofAsk: price != null && ask > 0 ? (price / ask) * 100 : null,
      pricedAt: match.indicativeAt,
      rateAsOf: price != null ? match.rateAsOf : null,
      rateStale: price != null && match.rateAsOf != null && rateStale(match.rateAsOf, now),
      invitedAt: match.invitedAt,
      answeredAt: match.answeredAt,
      inquiryId: match.inquiryId,
      why,
      flags,
      canInvite: block === null,
      block: block ?? "",
    };
  });
  return rows.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
}

// The desk sends a standing price to its buyer to confirm. Nothing binds until the buyer does.
export async function inviteToConfirm(matchId: string, listingId: string, actorId: string, now = new Date()) {
  const match = await prisma.listingMatch.findUnique({
    where: { id: matchId },
    include: { listing: { include: { notes: { select: { upb: true } } } }, buyBox: { include: { user: true } } },
  });
  if (!match || match.listingId !== listingId) return { error: "That standing bid is gone. The box may have changed or been retired." } as const;
  const buyer = match.buyBox.user;
  const price = match.indicativePrice;
  const held = Boolean(await ofacHold({ listingId, userIds: [buyer.id, match.listing.sellerId] }));
  const block = inviteBlock({
    status: match.listing.status,
    bidMode: match.listing.bidMode,
    bidDeadline: match.listing.bidDeadline,
    price,
    invitedAt: match.invitedAt,
    answeredAt: match.answeredAt,
    buyer,
    held,
    now,
  });
  if (block || price == null) return { error: block ?? "There is no standing price to send." } as const;
  // Claimed at the price the desk saw, so a reprice landing at the same moment wins and no stale figure goes out.
  const claimed = await prisma.listingMatch.updateMany({
    where: { id: match.id, indicativePrice: price, AND: [unset("invitedAt"), unset("answeredAt")] },
    data: { invitedAt: now },
  });
  if (claimed.count !== 1) return { error: "That standing bid changed a moment ago. Reload and check it." } as const;
  const upb = match.listing.notes.reduce((sum, note) => sum + note.upb, 0);
  const share = upb > 0 ? `, ${((price / upb) * 100).toFixed(1)}% of UPB` : "";
  // A spread price names the rate's date, so the buyer can tell how fresh it is.
  const onRate = match.rateAsOf ? `, on the 10-year rate as of ${prettyDate(match.rateAsOf)}` : "";
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/buyer/buy-box#invitations`;
  await notify(
    buyer.email,
    `Confirm a standing bid · ${match.listing.title}`,
    `Your buy box “${match.buyBox.name}” prices ${match.listing.title} at ${money(price)}${share}${onRate}. The desk invites you to confirm it as a bid. It stays indicative until you confirm, and you can pass. Answer here: ${link}`,
  );
  await audit(actorId, "STANDING_INVITE", "listing", listingId, `${buyer.name} · ${match.buyBox.name} · ${money(price)}`);
  return { error: null } as const;
}

type Buyer = Pick<User, "id" | "name" | "email" | "role" | "accountStatus" | "subscriptionTier" | "subscriptionStatus" | "subscriptionCurrentPeriodEnd">;

// The buyer turns an invitation into a real bid at the standing price. It runs every check the bid form runs.
export async function confirmStanding(input: { matchId: string; user: Buyer; price: number; goodUntil: string; now?: Date }) {
  const now = input.now ?? new Date();
  const match = await prisma.listingMatch.findUnique({ where: { id: input.matchId }, include: { listing: { include: { seller: true } } } });
  if (!match || match.userId !== input.user.id) return { error: "That invitation isn't yours.", verification: false } as const;
  if (match.answeredAt) return { error: "You already answered this invitation.", verification: false } as const;
  const price = match.indicativePrice;
  if (!match.invitedAt || price == null) return { error: "The desk hasn't sent this standing bid to confirm.", verification: false } as const;
  // The buyer binds to the figure they saw. A reprice since the page loaded asks them to look again.
  if (Math.round(input.price) !== price) return { error: "The standing price changed. Check the new figure and confirm again.", verification: false } as const;
  const check = await checkOffer({ user: input.user, listing: match.listing, noteId: "", amount: price, goodUntil: input.goodUntil, now });
  if (check.error !== null) return check;
  // A double click or a second tab: one claim lands, so one bid is written.
  const claimed = await prisma.listingMatch.updateMany({
    where: { id: match.id, userId: input.user.id, invitedAt: { not: null }, indicativePrice: price, ...unset("answeredAt") },
    data: { answeredAt: now },
  });
  if (claimed.count !== 1) return { error: "You answered this invitation a moment ago.", verification: false } as const;
  const bid = { user: input.user, listing: match.listing, type: "OFFER", noteId: "", amount: price, message: "Confirmed from a standing bid.", expiresAt: check.expiresAt };
  let inquiry: Awaited<ReturnType<typeof writeInquiry>>;
  try {
    inquiry = await writeInquiry(bid);
  } catch (error) {
    // No bid was written, so the invitation opens again for another try.
    await prisma.listingMatch.updateMany({ where: { id: match.id, answeredAt: now, ...unset("inquiryId") }, data: { answeredAt: null } });
    throw error;
  }
  await prisma.listingMatch.update({ where: { id: match.id }, data: { inquiryId: inquiry.id } });
  await announceInquiry(inquiry, bid);
  // The same record a direct bid keeps of the notices and acknowledgement the buyer was shown.
  await logEligibility(input.user.id, inquiry.id, check);
  await audit(input.user.id, "STANDING_BID", "inquiry", inquiry.id, `${match.listing.title} · ${money(price)}`);
  return { error: null, inquiryId: inquiry.id, listingId: match.listingId } as const;
}

export async function passStanding(matchId: string, userId: string, now = new Date()) {
  const match = await prisma.listingMatch.findUnique({ where: { id: matchId }, select: { userId: true, invitedAt: true } });
  if (!match || match.userId !== userId) return { error: "That invitation isn't yours." } as const;
  if (!match.invitedAt) return { error: "The desk hasn't sent this standing bid to confirm." } as const;
  const claimed = await prisma.listingMatch.updateMany({
    where: { id: matchId, userId, invitedAt: { not: null }, ...unset("answeredAt") },
    data: { answeredAt: now },
  });
  if (claimed.count !== 1) return { error: "That invitation is already answered." } as const;
  await audit(userId, "STANDING_PASS", "listingMatch", matchId);
  return { error: null } as const;
}

// Invitations the buyer hasn't answered, on listings still taking bids.
export function openInvitations(userId: string) {
  return prisma.listingMatch.findMany({
    where: { userId, invitedAt: { not: null }, indicativePrice: { not: null }, listing: { status: "APPROVED" }, ...unset("answeredAt") },
    include: { listing: { include: { notes: { select: { upb: true } } } }, buyBox: true },
    orderBy: { invitedAt: "desc" },
  });
}
