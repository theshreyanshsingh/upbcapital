import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { fundsCredential } from "@/lib/verification";

// Graduated bid caps, as Xome holds a new bidder to a ceiling until they have closed. A buyer's largest single bid
// is held to the lowest of three limits that apply: the funds the desk verified, a cap the desk set for this buyer,
// and the new-bidder cap until the buyer has closed enough deals. The funds limit keeps its own check across every
// open bid (lib/inquiry.ts fundsLimitBlock); the two caps here each hold one bid's price.

export const DEFAULT_NEW_BIDDER_CLOSES = 1;
export const MAX_NEW_BIDDER_CLOSES = 20;
export const ASK_THE_DESK = "Write the desk to ask for a higher limit.";

export function newBidderClosesOf(value: number | null | undefined) {
  return value != null && Number.isInteger(value) && value >= 0 && value <= MAX_NEW_BIDDER_CLOSES ? value : DEFAULT_NEW_BIDDER_CLOSES;
}

function positive(cents: number | null | undefined) {
  return cents != null && Number.isFinite(cents) && cents > 0 ? Math.round(cents) : null;
}

export type CapSource = "funds" | "desk" | "newBidder";

export type CapInput = {
  // The verified funds, in cents, while the proof is current. Null when there is none.
  fundsCents: number | null;
  // User.bidCapCents.
  deskCapCents: number | null | undefined;
  // PlatformSettings.newBidderCapCents and newBidderCloses.
  newBidderCapCents: number | null | undefined;
  newBidderCloses: number | null | undefined;
  // Closings the buyer completed, as winning buyer or as a funder.
  closes: number;
  // User.bidCapLifted.
  lifted: boolean | null | undefined;
};

export type BidCap = {
  // The largest single bid, in cents, and the limit that sets it. Null when nothing limits it.
  capCents: number | null;
  source: CapSource | null;
  deskCapCents: number | null;
  newBidderCapCents: number | null;
  // Whether the new-bidder cap holds this buyer, and why not when it doesn't.
  newBidder: "applies" | "lifted" | "graduated" | "off";
  closes: number;
  closesNeeded: number;
};

// The rule, with no database. The lowest limit wins; on a tie the desk's own cap is named, then the new-bidder cap,
// since those are the ones this check enforces.
export function bidCapRule(input: CapInput): BidCap {
  const closesNeeded = newBidderClosesOf(input.newBidderCloses);
  const newCap = positive(input.newBidderCapCents);
  const newBidder = !newCap ? "off" : input.lifted ? "lifted" : input.closes >= closesNeeded ? "graduated" : "applies";
  const limits: [CapSource, number | null][] = [
    ["desk", positive(input.deskCapCents)],
    ["newBidder", newBidder === "applies" ? newCap : null],
    ["funds", positive(input.fundsCents)],
  ];
  let capCents: number | null = null;
  let source: CapSource | null = null;
  for (const [name, cents] of limits) {
    if (cents != null && (capCents == null || cents < capCents)) {
      capCents = cents;
      source = name;
    }
  }
  return { capCents, source, deskCapCents: positive(input.deskCapCents), newBidderCapCents: newCap, newBidder, closes: input.closes, closesNeeded };
}

function deals(count: number) {
  return `${count} deal${count === 1 ? "" : "s"}`;
}

// Why a bid of this price is over the cap, or null. Where a bid also meets the funds check across every open bid
// (lib/inquiry.ts), that check runs first and refuses a price over the funds in its own words, so this one names
// the funds only for a group seat, which that check leaves out.
export function capBlock(cap: BidCap, amountCents: number) {
  if (cap.capCents == null || cap.source == null) return null;
  // A cent of slack for rounding.
  if (amountCents <= cap.capCents + 1) return null;
  const limit = money(cap.capCents / 100);
  if (cap.source === "funds") return `Your verified funds are ${limit}, so no single bid can be larger. Bid ${limit} or less, or send the desk a larger proof of funds.`;
  if (cap.source === "desk") return `The desk set your largest single bid at ${limit}. Bid ${limit} or less. ${ASK_THE_DESK}`;
  const left = Math.max(1, cap.closesNeeded - cap.closes);
  return `New bidders bid up to ${limit} on one bid until they have closed ${deals(cap.closesNeeded)} on UPB. You have closed ${deals(cap.closes)}. Bid ${limit} or less. Close ${left === 1 ? "a deal" : deals(left)} to lift it, or write the desk to ask for a review.`;
}

// One line for the buyer's own pages. Null when no cap holds them below their verified funds, which the pages
// already show.
export function capLine(cap: BidCap) {
  if (cap.capCents == null || cap.source == null || cap.source === "funds") return null;
  const limit = money(cap.capCents / 100);
  if (cap.source === "desk") return `The desk set your largest single bid at ${limit}. ${ASK_THE_DESK}`;
  return `Your largest single bid is ${limit} until you have closed ${deals(cap.closesNeeded)} on UPB. You have closed ${deals(cap.closes)}. Close a deal to lift it, or write the desk to ask for a review.`;
}

// The cap as the bid forms show it, beside the bid box: one line and the figure. Null unless a cap below the
// verified funds applies.
export function capHint(cap: BidCap) {
  if (cap.capCents == null || cap.source == null || cap.source === "funds") return null;
  const limit = money(cap.capCents / 100);
  const raise = cap.source === "desk" ? "Ask the desk to raise it." : "Close a deal or ask the desk to raise it.";
  return { cents: cap.capCents, line: `Your largest bid right now: ${limit}. ${raise}` };
}

// The new-bidder cap as the desk reads it on a buyer's profile.
export function newBidderLine(cap: BidCap) {
  if (cap.newBidder === "off") return "No new-bidder cap is set.";
  const limit = money((cap.newBidderCapCents ?? 0) / 100);
  if (cap.newBidder === "lifted") return `The new-bidder cap of ${limit} is lifted for this buyer.`;
  if (cap.newBidder === "graduated") return `Past the new-bidder cap: ${deals(cap.closes)} closed of ${cap.closesNeeded} needed.`;
  return `Held to the new-bidder cap of ${limit} until ${deals(cap.closesNeeded)} close. ${deals(cap.closes)} closed so far.`;
}

// A dollar figure from a desk form, as cents. Blank is no cap.
export function readCapDollars(raw: unknown) {
  const text = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!text) return { error: null, cents: null } as const;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 1000 || value > 1_000_000_000) return { error: "Enter a cap between $1,000 and $1,000,000,000, or leave it blank for none." } as const;
  return { error: null, cents: Math.round(value * 100) } as const;
}

// A short reason for a desk change, which the audit log keeps.
export function readReason(raw: unknown) {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  return text.length < 3 ? ({ error: "Give a short reason. The audit log keeps it." } as const) : ({ error: null, reason: text } as const);
}

// ---------------------------------------------------------------------------------------------------------------
// The database side.

// Closings this buyer finished: as the winning bidder, or as a funder on a group's closing. A group's lead is both,
// so each closing counts once.
export async function completedCloses(userId: string) {
  const [bids, funded] = await Promise.all([
    prisma.inquiry.findMany({ where: { buyerId: userId, type: "OFFER" }, select: { id: true } }),
    prisma.closingFunder.findMany({ where: { userId }, select: { closingId: true } }),
  ]);
  if (!bids.length && !funded.length) return 0;
  const done = await prisma.closing.findMany({
    where: { status: "COMPLETE", OR: [...(bids.length ? [{ inquiryId: { in: bids.map((bid) => bid.id) } }] : []), ...(funded.length ? [{ id: { in: funded.map((row) => row.closingId) } }] : [])] },
    select: { id: true },
  });
  return new Set(done.map((closing) => closing.id)).size;
}

type CapSettings = { newBidderCapCents?: number | null; newBidderCloses?: number | null };

// The cap for one buyer now. Desk accounts bid for the book under their own rules, so nothing here limits them.
export async function bidCapFor(userId: string, options: { settings?: CapSettings; now?: Date } = {}): Promise<BidCap> {
  const now = options.now ?? new Date();
  const [user, profile, settings, closes] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { role: true, bidCapCents: true, bidCapLifted: true } }),
    prisma.buyerProfile.findUnique({ where: { userId }, select: { proofAmount: true, proofExpiresAt: true, proofVerifiedAt: true } }),
    options.settings ? Promise.resolve(options.settings) : getSettings(),
    completedCloses(userId),
  ]);
  const credential = fundsCredential(profile, now);
  const desk = user?.role === "ADMIN";
  return bidCapRule({
    fundsCents: credential && !credential.expired ? Math.round(credential.amount * 100) : null,
    deskCapCents: desk ? null : user?.bidCapCents,
    newBidderCapCents: desk ? null : settings.newBidderCapCents,
    newBidderCloses: settings.newBidderCloses,
    closes,
    lifted: user?.bidCapLifted,
  });
}

// Why this price is over the buyer's cap, or null. For bids, new prices on a bid, buy it now and group seats.
export async function bidCapBlock(userId: string, amount: number, options: { settings?: CapSettings; now?: Date } = {}) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return capBlock(await bidCapFor(userId, options), Math.round(amount * 100));
}
