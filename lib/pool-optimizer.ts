import { allInFor, feeTerms, flatTerms, type FeeTerms } from "@/lib/fee-schedule";
import { bidExpired, buyerPrice } from "@/lib/offers";
import { fundsExposure } from "@/lib/inquiry";
import { standingLoanPrices, type LoanPrices } from "@/lib/loan-prices";
import { prisma } from "@/lib/prisma";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";
import { getSettings } from "@/lib/settings";
import { strikeStanding } from "@/lib/strikes";
import { bidTarget, exposureByKey, fundsCredential, headroomFor } from "@/lib/verification";

// The bid optimiser: after a pool's deadline, the mix of its live bids that brings the seller the most. Whole-pool
// bids, whole-pool bids priced loan by loan that let the seller take part, and one-loan bids all compete, and each
// loan sells once. It recommends; every award it leads to still runs the award checks.

export type OptimizerLoan = { id: string; label: string; available: boolean };

export type OptimizerBid = {
  id: string;
  bidder: string;
  buyerId: string;
  // A one-loan bid's loan, or null for a bid on the whole pool.
  noteId: string | null;
  price: number;
  // The buyer's standing loan prices, which add up to the bid.
  loanPrices: LoanPrices | null;
  allowPartial: boolean;
  // Why the award checks would refuse this bid, or null when it can compete.
  excluded: string | null;
  // The all-in this bid can take inside the buyer's verified funds, or null when no ceiling applies.
  headroom: number | null;
};

export type PlanPick = {
  bidId: string;
  bidder: string;
  // The whole pool, part of it at the buyer's loan prices, or one loan.
  kind: "whole" | "part" | "loan";
  noteIds: string[];
  price: number;
  overFunds: boolean;
};

export type PoolPlan = {
  method: "exact" | "greedy";
  picks: PlanPick[];
  proceeds: number;
  unsold: string[];
  bestWhole: PlanPick | null;
  // What the combination brings over the best single whole-pool bid, or null when there is none to compare.
  gain: number | null;
  excluded: { bidId: string; bidder: string; reason: string }[];
};

// Up to 12 all-or-nothing bids are searched exhaustively: 4,096 combinations at most.
export const EXACT_LIMIT = 12;

const CENT = 0.005;

type Block = { bid: OptimizerBid; noteIds: string[]; price: number };

function round(amount: number) {
  return Math.round(amount * 100) / 100;
}

// The best plan for these loans and bids.
//
// A bid all-or-nothing on its loans is a block. Today every block is a whole-pool bid, so blocks always overlap and
// at most one is taken, but the search works for blocks of any size. Every other offer is a price for one loan: a
// one-loan bid, or a loan price on a pool bid that lets the seller take part. One pool bid taken for several loans is
// still one award of one part, so loan by loan the best offer for each loan is the best for the whole.
//
// With EXACT_LIMIT blocks or fewer, every set of non-overlapping blocks is tried, with the remaining loans going to
// their best single-loan offer. Past that the search is greedy: each loan is first valued at its best single-loan
// offer, the blocks are taken in order of what they add over those values, and a block that overlaps one already
// taken is skipped. When the blocks are whole-pool bids, which overlap every other block, the greedy pass is exact as
// well; it can fall short only for blocks that cover part of a pool, where two small blocks may beat one large one.
// fees, when given, is the listing's terms, so a graded premium is checked against funds; else premiumBps is flat.
export function optimizePool(input: { loans: OptimizerLoan[]; bids: OptimizerBid[]; premiumBps: number; fees?: FeeTerms; exactLimit?: number }): PoolPlan {
  const terms = input.fees ?? flatTerms(input.premiumBps);
  const limit = input.exactLimit ?? EXACT_LIMIT;
  const free = input.loans.filter((loan) => loan.available).map((loan) => loan.id);
  const freeSet = new Set(free);
  const wholePool = free.length === input.loans.length;
  const excluded: PoolPlan["excluded"] = [];
  const blocks: Block[] = [];
  // For each free loan, its best single-loan offer.
  const best = new Map<string, { bid: OptimizerBid; price: number; kind: "part" | "loan" }>();
  const offer = (noteId: string, bid: OptimizerBid, price: number, kind: "part" | "loan") => {
    const top = best.get(noteId);
    if (!top || price > top.price + CENT) best.set(noteId, { bid, price, kind });
  };
  let bestWhole: PlanPick | null = null;
  const pick = (bid: OptimizerBid, kind: PlanPick["kind"], noteIds: string[], price: number): PlanPick => ({
    bidId: bid.id,
    bidder: bid.bidder,
    kind,
    noteIds,
    price: round(price),
    overFunds: bid.headroom != null && allInFor(terms, price) > bid.headroom + CENT,
  });
  for (const bid of input.bids) {
    if (bid.excluded) {
      excluded.push({ bidId: bid.id, bidder: bid.bidder, reason: bid.excluded });
      continue;
    }
    if (bid.noteId) {
      if (freeSet.has(bid.noteId)) offer(bid.noteId, bid, bid.price, "loan");
      else excluded.push({ bidId: bid.id, bidder: bid.bidder, reason: "Its loan is in contract or sold." });
      continue;
    }
    const partial = bid.allowPartial && bid.loanPrices != null;
    if (partial) {
      for (const noteId of free) if (bid.loanPrices![noteId] != null) offer(noteId, bid, bid.loanPrices![noteId], "part");
    } else if (wholePool) {
      blocks.push({ bid, noteIds: free, price: bid.price });
    } else {
      excluded.push({ bidId: bid.id, bidder: bid.bidder, reason: "Some loans have traded, so it can't be taken whole." });
      continue;
    }
    if (wholePool && (!bestWhole || bid.price > bestWhole.price + CENT)) bestWhole = pick(bid, "whole", free, bid.price);
  }

  const value = (noteId: string) => best.get(noteId)?.price ?? 0;
  const blockGain = (block: Block) => block.price - block.noteIds.reduce((sum, noteId) => sum + value(noteId), 0);
  // How many awards a set of blocks makes: one each, plus one per bid that takes the loans left over.
  const awards = (set: Block[]) => {
    const covered = new Set(set.flatMap((block) => block.noteIds));
    const rest = new Set(free.filter((noteId) => !covered.has(noteId) && best.has(noteId)).map((noteId) => best.get(noteId)!.bid.id));
    return set.length + rest.size;
  };
  // More proceeds wins. A tie within a cent keeps the plan with fewer awards, which is fewer closings to run.
  const better = (gain: number, set: Block[], top: number, current: Block[]) =>
    gain > top + CENT || (Math.abs(gain - top) <= CENT && awards(set) < awards(current));
  let chosen: Block[] = [];
  const method: PoolPlan["method"] = blocks.length <= limit ? "exact" : "greedy";
  if (method === "exact") {
    let top = 0;
    for (let mask = 1; mask < 1 << blocks.length; mask += 1) {
      const set = blocks.filter((_, index) => mask & (1 << index));
      const taken = new Set<string>();
      const fits = set.every((block) => block.noteIds.every((noteId) => !taken.has(noteId) && Boolean(taken.add(noteId))));
      if (!fits) continue;
      const gain = set.reduce((sum, block) => sum + blockGain(block), 0);
      if (better(gain, set, top, chosen)) {
        top = gain;
        chosen = set;
      }
    }
  } else {
    let top = 0;
    const taken = new Set<string>();
    const ordered = [...blocks].sort((a, b) => blockGain(b) - blockGain(a) || b.price - a.price);
    for (const block of ordered) {
      if (block.noteIds.some((noteId) => taken.has(noteId))) continue;
      const gain = top + blockGain(block);
      if (!better(gain, [...chosen, block], top, chosen)) continue;
      top = gain;
      chosen = [...chosen, block];
      block.noteIds.forEach((noteId) => taken.add(noteId));
    }
  }

  const picks: PlanPick[] = chosen.map((block) => pick(block.bid, "whole", block.noteIds, block.price));
  const covered = new Set(chosen.flatMap((block) => block.noteIds));
  // The rest go loan by loan, one part per pool bid.
  const parts = new Map<string, { bid: OptimizerBid; noteIds: string[]; price: number }>();
  for (const noteId of free) {
    if (covered.has(noteId)) continue;
    const top = best.get(noteId);
    if (!top) continue;
    if (top.kind === "loan") {
      picks.push(pick(top.bid, "loan", [noteId], top.price));
      continue;
    }
    const part = parts.get(top.bid.id) ?? { bid: top.bid, noteIds: [], price: 0 };
    part.noteIds.push(noteId);
    part.price += top.price;
    parts.set(top.bid.id, part);
  }
  for (const part of parts.values()) {
    // A part that is every loan in the pool is the bid taken whole, at its own price.
    const all = wholePool && part.noteIds.length === input.loans.length;
    picks.push(pick(part.bid, all ? "whole" : "part", part.noteIds, all ? part.bid.price : part.price));
  }
  const sold = new Set(picks.flatMap((item) => item.noteIds));
  const proceeds = round(picks.reduce((sum, item) => sum + item.price, 0));
  return {
    method,
    picks,
    proceeds,
    unsold: free.filter((noteId) => !sold.has(noteId)),
    bestWhole,
    gain: bestWhole ? round(proceeds - bestWhole.price) : null,
    excluded,
  };
}

// A plan as the award form posts it, so the action can tell whether the bids moved since the page loaded.
export function planKey(plan: Pick<PoolPlan, "picks">) {
  return plan.picks
    .map((item) => `${item.bidId}:${item.kind}:${[...item.noteIds].sort().join(",")}:${item.price.toFixed(2)}`)
    .sort()
    .join("|");
}

const LIVE = ["OPEN", "REVIEWED"] as const;

// A pool's live bids, each read the way the award checks read it, and the plan they make. The desk sees names.
export async function loadPoolPlan(listingId: string, now = new Date()) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      notes: { select: { id: true, city: true, state: true, streetAddress: true, tradeStatus: true }, orderBy: { createdAt: "asc" } },
      inquiries: {
        where: { type: "OFFER", status: { in: [...LIVE, "EXPIRED", "WITHDRAWN"] } },
        include: { buyer: { include: { buyerProfile: true } }, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!listing) return null;
  const settings = await getSettings();
  const fees = feeTerms(listing, settings);
  const premiumBps = fees.premiumBps;
  const groups = new Map(
    (
      await prisma.groupBuy.findMany({
        where: { inquiryId: { in: listing.inquiries.map((inquiry) => inquiry.id) } },
        select: { inquiryId: true, positions: { where: { status: { not: "DROPPED" } }, select: { userId: true } } },
      })
    ).map((group) => [group.inquiryId, group.positions.map((seat) => seat.userId)]),
  );
  // One read per buyer, however many bids they hold.
  const standing = new Map<string, Promise<{ paused: string | null; held: boolean; byKey: Record<string, number> }>>();
  const standingOf = (userId: string) => {
    let read = standing.get(userId);
    if (!read) {
      read = (async () => {
        const [strikes, hold, exposure] = await Promise.all([strikeStanding(userId), ofacHold({ userIds: [userId] }), fundsExposure(userId, settings.buyerPremiumBps, now)]);
        return { paused: strikes.paused, held: Boolean(hold), byKey: exposureByKey(exposure) };
      })();
      standing.set(userId, read);
    }
    return read;
  };
  const bids: OptimizerBid[] = [];
  for (const inquiry of listing.inquiries) {
    const price = buyerPrice(inquiry.amount, inquiry.messages, inquiry.buyerId) ?? 0;
    const profile = inquiry.buyer.buyerProfile;
    const bidder = profile?.entityName || inquiry.buyer.companyName || inquiry.buyer.name;
    const seats = groups.get(inquiry.id) ?? [];
    const buyer = await standingOf(inquiry.buyerId);
    const seatsPaused = (await Promise.all(seats.filter((userId) => userId !== inquiry.buyerId).map(standingOf))).some((seat) => seat.paused);
    // The same refusals as the award checks, in the order they run there.
    const excluded =
      inquiry.status === "WITHDRAWN"
        ? "The buyer withdrew it."
        : inquiry.status === "EXPIRED" || bidExpired(inquiry.expiresAt, now)
          ? "It passed its good-until date."
          : inquiry.buyer.accountStatus !== "APPROVED"
            ? "The buyer account is not approved."
            : buyer.held
              ? OFAC_HOLD_MESSAGE
              : buyer.paused
                ? "The buyer's bidding is paused for closings that didn't complete."
                : seatsPaused
                  ? "A group seat holder's bidding is paused."
                  : !(price > 0)
                    ? "It has no amount."
                    : null;
    const credential = fundsCredential(profile, now);
    const headroom = credential ? (credential.expired ? 0 : headroomFor(credential.amount, buyer.byKey, bidTarget(listing.id, inquiry.noteId))) : null;
    bids.push({
      id: inquiry.id,
      bidder,
      buyerId: inquiry.buyerId,
      noteId: inquiry.noteId,
      price,
      // A group's seats fund its whole price, so a group bid is never split.
      loanPrices: inquiry.noteId || seats.length ? null : standingLoanPrices(inquiry.loanPrices, price),
      allowPartial: Boolean(inquiry.allowPartial) && !seats.length,
      excluded,
      headroom,
    });
  }
  const loans: OptimizerLoan[] = listing.notes.map((note, index) => ({
    id: note.id,
    label: `Loan ${index + 1} · ${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}`,
    available: note.tradeStatus === "AVAILABLE",
  }));
  return { listing, loans, bids, premiumBps, plan: optimizePool({ loans, bids, premiumBps, fees }) };
}
