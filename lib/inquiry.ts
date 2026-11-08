import type { Listing, User } from "@prisma/client";
import { canOpenListing, openableListingIds } from "@/lib/access";
import { canSubmitBid, sealedFromSeller } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { awardOffer } from "@/lib/awards";
import { bidCapBlock, bidCapFor, capHint } from "@/lib/bid-caps";
import { bidderAlias } from "@/lib/bidder-alias";
import { chosenEntity } from "@/lib/buyer-entities";
import { buyNowOffer, samePrice } from "@/lib/buy-now";
import { unset } from "@/lib/db-filters";
import { ACKNOWLEDGE_FIRST, acknowledgementMissing, eligibilityFor, eligibilityLog, type Eligibility } from "@/lib/eligibility";
import { notify, notifyDesk } from "@/lib/email";
import { allInFor, feeTerms } from "@/lib/fee-schedule";
import { money } from "@/lib/format";
import { loanPriceProblem, type LoanPrices } from "@/lib/loan-prices";
import { launchBlock } from "@/lib/launch-rules";
import { bidExpired, buyerPrice, readGoodUntil } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { canSeeListing, listingSight } from "@/lib/private-listings";
import { getSettings, isPro } from "@/lib/settings";
import { strikeStanding } from "@/lib/strikes";
import { ensureInquiryThread } from "@/lib/threads";
import {
  bidLimit,
  bidTarget,
  canSubmitOffer,
  credentialLine,
  exposureByKey,
  fundsCredential,
  headroomFor,
  recertBlock,
  type BidStanding,
  type Exposure,
} from "@/lib/verification";

type Buyer = Pick<User, "id" | "name" | "email" | "role" | "accountStatus" | "subscriptionTier" | "subscriptionStatus" | "subscriptionCurrentPeriodEnd">;
// launchAt is optional so a caller's narrower select still type-checks; the selects here all read it.
type OpenListing = Pick<Listing, "id" | "status" | "approvedAt" | "sellerId" | "brokerId"> & { launchAt?: Date | null; visibility?: string | null };
type BidListing = OpenListing & Pick<Listing, "kind" | "bidMode" | "bidDeadline">;

// The listing page refuses early-access listings and those outside the free slice. Every action on a listing holds
// the same line, since listing IDs are in the page bundle. A private listing, or one whose seller excludes this
// buyer, is refused before any of that (lib/private-listings.ts).
export async function buyerCanOpen(user: Buyer, listing: OpenListing) {
  const sight = await listingSight(user, listing);
  if (!sight.visible) return false;
  const settings = await getSettings();
  const live = isPro(user)
    ? []
    : await prisma.listing.findMany({ where: { status: { in: ["APPROVED", "PENDING"] } }, select: { id: true, status: true, approvedAt: true, visibility: true } });
  return canOpenListing({
    invited: sight.invited,
    viewer: user,
    status: listing.status,
    approvedAt: listing.approvedAt,
    earlyAccessHours: settings.earlyAccessHours,
    openableIds: openableListingIds(live, settings.earlyAccessHours, settings.freeBrowseLimit),
    listingId: listing.id,
    sellerId: listing.sellerId,
    brokerId: listing.brokerId,
    launchAt: listing.launchAt,
  }).ok;
}

// Why this buyer can't send an inquiry of any kind on this listing, or null when they can.
export async function inquiryBlock(user: Buyer, listing: OpenListing | null) {
  if (!listing || listing.status !== "APPROVED") return "This listing is not taking new inquiries.";
  const coming = launchBlock(listing, "inquiry");
  if (coming) return coming;
  // Hidden from this buyer reads as closed, never as hidden.
  if (!(await canSeeListing(user, listing))) return "This listing is not taking new inquiries.";
  if (!(await buyerCanOpen(user, listing))) return "This listing isn't open on your membership yet.";
  return null;
}

const ROAD_ACK = "ROAD_ACK";

// When this buyer last acknowledged the ROAD Act notice on this listing. The audit log is the record, since it is
// the log the desk reads.
export async function roadAcknowledgedAt(userId: string, listingId: string) {
  const row = await prisma.auditEvent.findFirst({ where: { entityId: listingId, actorId: userId, action: ROAD_ACK }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return row?.createdAt ?? null;
}

// The buyer acknowledges the notice for this listing, once, before any of their bids on it. Their own statement
// of homes controlled goes into the log with it.
export async function acknowledgeRoad(user: Buyer, listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, status: true, approvedAt: true, sellerId: true, brokerId: true, launchAt: true } });
  if (!listing || !(await buyerCanOpen(user, listing))) return { error: "This listing isn't open on your membership yet." } as const;
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { homesControlled: true, reoStrategy: true } });
  await audit(user.id, ROAD_ACK, "listing", listingId, `${profile?.homesControlled ?? "No"} homes stated · ${profile?.reoStrategy ?? "no REO strategy"}`);
  return { error: null } as const;
}

export type OfferCheck =
  | { error: string; verification: boolean }
  | { error: null; expiresAt: Date | null; eligibility: Eligibility; acknowledgedAt: Date | null; headroomAfter: number | null; buyerEntityId: string | null };

// ---------------------------------------------------------------------------------------------------------------
// The bid limit. A buyer's open bids, all-in, may not together run past the funds the desk verified.

const HELD = ["OPEN", "REVIEWED", "ACCEPTED"] as const;

// What a buyer's verified funds stand behind now: each open bid's all-in at the price the buyer last named, and
// each won bid whose closing hasn't finished, at the closing's all-in. A bid past its good-until date can't be
// awarded, so it holds nothing.
// Group seats are out of scope. A group's one bid sits on its lead's account at the whole group's price, though
// each seat funds only its share, so it isn't held against the lead's ceiling; and a seat is a pledge made on the
// group page, not a bid of the buyer's own. Holding seats to the ceiling belongs with the seat flow.
// premiumBps is the settings' premium, for a listing approved before its own fees were kept. Such a listing takes
// the desk's graded schedule when one is set, as its closing would.
export async function fundsExposure(userId: string, premiumBps: number, now = new Date()): Promise<Exposure[]> {
  const bids = await prisma.inquiry.findMany({
    where: { buyerId: userId, type: "OFFER", status: { in: [...HELD] } },
    select: { id: true, listingId: true, noteId: true, status: true, amount: true, expiresAt: true, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } },
  });
  if (!bids.length) return [];
  const ids = bids.map((bid) => bid.id);
  const [groups, closings, listings, settings] = await Promise.all([
    prisma.groupBuy.findMany({ where: { inquiryId: { in: ids } }, select: { inquiryId: true } }),
    prisma.closing.findMany({ where: { inquiryId: { in: ids } }, select: { id: true, inquiryId: true, status: true, buyerTotalCents: true } }),
    prisma.listing.findMany({ where: { id: { in: [...new Set(bids.map((bid) => bid.listingId))] } }, select: { id: true, feeBuyerPremiumBps: true, feeSellerCommissionBps: true, feeSchedule: true, feePayer: true } }),
    getSettings(),
  ]);
  // Each bid at the premium its listing went live with, the one its closing would charge.
  const day = { ...settings, buyerPremiumBps: premiumBps };
  const termsOf = new Map(listings.map((listing) => [listing.id, feeTerms(listing, day)]));
  const grouped = new Set(groups.map((group) => group.inquiryId));
  const closingOf = new Map(closings.map((closing) => [closing.inquiryId, closing]));
  const held: Exposure[] = [];
  for (const bid of bids) {
    if (grouped.has(bid.id)) continue;
    const closing = closingOf.get(bid.id);
    if (closing) {
      if (closing.status === "OPEN") held.push({ key: `closing:${closing.id}`, allIn: closing.buyerTotalCents / 100 });
      continue;
    }
    // An accepted bid with no closing is waiting on the seller or the desk, so it still holds its price.
    if (bid.status !== "ACCEPTED" && bidExpired(bid.expiresAt, now)) continue;
    const price = buyerPrice(bid.amount, bid.messages, userId);
    if (price && price > 0) held.push({ key: bidTarget(bid.listingId, bid.noteId), allIn: allInFor(termsOf.get(bid.listingId) ?? feeTerms(null, day), price) });
  }
  return held;
}

// The buyer's credential and standing, for the verification page and the bid forms.
export async function bidStanding(userId: string, now = new Date()): Promise<BidStanding> {
  const [profile, settings, strikes] = await Promise.all([
    prisma.buyerProfile.findUnique({ where: { userId }, select: { proofAmount: true, proofExpiresAt: true, proofVerifiedAt: true } }),
    getSettings(),
    strikeStanding(userId),
  ]);
  const credential = fundsCredential(profile, now);
  // A bid cap below the funds, for the line beside each bid box (lib/bid-caps.ts).
  const cap = capHint(await bidCapFor(userId, { settings, now }));
  if (!credential) return { credential: null, paused: strikes.paused, cap };
  const byKey = exposureByKey(await fundsExposure(userId, settings.buyerPremiumBps, now));
  return {
    credential: { line: credentialLine(credential, now), amount: credential.amount, expired: credential.expired, byKey, headroom: headroomFor(credential.amount, byKey) },
    paused: strikes.paused,
    cap,
  };
}

// Why this bid would run past the buyer's verified funds, or null. An expired proof is flagged as a verification
// problem, so the caller sends the buyer to renew it.
export async function fundsLimitBlock(input: { userId: string; listingId: string; noteId: string | null; amount: number; now?: Date }) {
  const now = input.now ?? new Date();
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: input.userId }, select: { proofAmount: true, proofExpiresAt: true, proofVerifiedAt: true } });
  const credential = fundsCredential(profile, now);
  if (!credential) return { error: null, headroomAfter: null } as const;
  const [settings, listing] = await Promise.all([
    getSettings(),
    prisma.listing.findUnique({ where: { id: input.listingId }, select: { feeBuyerPremiumBps: true, feeSellerCommissionBps: true, feeSchedule: true, feePayer: true } }),
  ]);
  const byKey = exposureByKey(await fundsExposure(input.userId, settings.buyerPremiumBps, now));
  const limit = bidLimit({ credential, byKey, key: bidTarget(input.listingId, input.noteId), allIn: allInFor(feeTerms(listing, settings), input.amount), now });
  if (!limit.ok) return { error: limit.message, verification: limit.reason === "expired" } as const;
  return { error: null, headroomAfter: limit.headroomAfter } as const;
}

// Every check a bid passes before it is written, for the bid form, buy it now and a confirmed standing bid alike.
// A verification failure is flagged, so the caller can send the buyer to their file instead of the listing.
// A whole-pool bid may price each loan, and with prices may let the seller take part of the pool at them.
export async function checkOffer(input: {
  user: Buyer;
  listing: BidListing | null;
  noteId: string;
  amount: number;
  goodUntil: string;
  loanPrices?: LoanPrices | null;
  allowPartial?: boolean;
  // The buying entity the bid is for, from the buyer's approved ones. Blank or missing means the main file.
  buyerEntityId?: string | null;
  now?: Date;
}): Promise<OfferCheck> {
  const { user, listing, noteId } = input;
  const now = input.now ?? new Date();
  const blocked = await inquiryBlock(user, listing);
  if (blocked || !listing) return { error: blocked ?? "This listing is not taking new inquiries.", verification: false };
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id } });
  const gate = canSubmitOffer({ role: user.role, accountStatus: user.accountStatus, verificationStatus: profile?.status ?? null });
  if (!gate.ok) return { error: "The desk has to approve your buyer file before you can offer.", verification: true };
  // A file past its yearly re-certification bids again once the buyer re-certifies and the desk approves it.
  const lapsed = recertBlock(profile, now);
  if (lapsed) return { error: lapsed, verification: true };
  const entity = await chosenEntity(user.id, input.buyerEntityId);
  if (entity.error !== null) return { error: entity.error, verification: false };
  // Strikes pause bids only. Information and data room requests still go through.
  const strikes = await strikeStanding(user.id);
  if (strikes.paused) return { error: strikes.paused, verification: true };
  // An expired proof stops a bid before anything else is asked of it.
  const credential = fundsCredential(profile, now);
  if (credential?.expired) {
    const expired = bidLimit({ credential, byKey: {}, key: "", allIn: 0, now });
    if (!expired.ok) return { error: expired.message, verification: true };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) return { error: "Enter an offer amount.", verification: false };
  const loans = await prisma.note.findMany({
    where: { listingId: listing.id, ...(noteId ? { id: noteId } : {}) },
    select: { id: true, tradeStatus: true, state: true, propertyType: true, paymentStatus: true },
  });
  if (noteId) {
    if (!loans[0] || loans[0].tradeStatus !== "AVAILABLE") return { error: "That loan is not open for a bid.", verification: false };
  } else if (listing.kind === "POOL" && loans.some((loan) => loan.tradeStatus !== "AVAILABLE")) {
    // A whole-pool bid on a pool with traded loans could never be awarded.
    return { error: "Some loans in this pool have traded, so it can't be bid whole. Bid the loans still for sale.", verification: false };
  }
  if (input.loanPrices || input.allowPartial) {
    if (noteId || listing.kind !== "POOL") return { error: "Loan prices go with a bid on a whole pool.", verification: false };
    if (!input.loanPrices) return { error: "Price each loan to let the seller take part of the pool.", verification: false };
    const priced = loanPriceProblem({ prices: input.loanPrices, loanIds: loans.map((loan) => loan.id), amount: input.amount });
    if (priced) return { error: priced, verification: false };
  }
  const goodUntil = readGoodUntil(input.goodUntil, listing, now);
  if (goodUntil.error) return { error: goodUntil.error, verification: false };
  const existing = await prisma.inquiry.findFirst({
    // A whole-listing offer may have no noteId field at all, which `noteId: null` alone would miss.
    // Best and final is one bid per buyer, so one they withdrew still counts; otherwise withdrawing would be a way
    // to change the price.
    where: {
      listingId: listing.id,
      buyerId: user.id,
      type: "OFFER",
      ...(noteId ? { noteId } : unset("noteId")),
      status: { in: listing.bidMode === "BEST_AND_FINAL" ? ["OPEN", "REVIEWED", "ACCEPTED", "WITHDRAWN", "EXPIRED"] : ["OPEN", "REVIEWED", "ACCEPTED"] },
    },
  });
  const gateBid = canSubmitBid({ bidMode: listing.bidMode, deadline: listing.bidDeadline, alreadyBid: Boolean(existing), now });
  if (!gateBid.ok) {
    return { error: gateBid.reason === "deadline" ? "The bid deadline has passed." : "Best and final allows one bid on this listing.", verification: false };
  }
  // The eligibility screen never refuses a buyer. A buyer who says they control 350 or more homes acknowledges the
  // notice once on the listing, and that is all it asks.
  const eligibility = eligibilityFor(loans, profile);
  const acknowledgedAt = eligibility.acknowledge ? await roadAcknowledgedAt(user.id, listing.id) : null;
  if (acknowledgementMissing(eligibility, acknowledgedAt, profile?.eligibilityAt)) return { error: ACKNOWLEDGE_FIRST, verification: false };
  // Last, since it needs the price: the bid's all-in with the buyer's other open bids must fit the verified funds.
  const limit = await fundsLimitBlock({ userId: user.id, listingId: listing.id, noteId: noteId || null, amount: input.amount, now });
  if (limit.error !== null) return { error: limit.error, verification: limit.verification };
  // The bid cap on one bid's price: the desk's own cap for this buyer, and the new-bidder cap (lib/bid-caps.ts).
  const capped = await bidCapBlock(user.id, input.amount, { now });
  if (capped) return { error: capped, verification: false };
  return { error: null, expiresAt: goodUntil.expiresAt, eligibility, acknowledgedAt, headroomAfter: limit.headroomAfter, buyerEntityId: entity.entityId };
}

// What the buyer was shown on this bid goes into the log beside it. Nothing is written when no notice applied.
export async function logEligibility(userId: string, inquiryId: string, check: { eligibility: Eligibility; acknowledgedAt: Date | null }) {
  const line = eligibilityLog(check.eligibility, check.acknowledgedAt);
  if (line) await audit(userId, "ELIGIBILITY", "inquiry", inquiryId, line);
}

type InquiryInput = {
  user: Buyer;
  listing: Pick<Listing, "id" | "title" | "sellerId" | "bidMode" | "bidDeadline"> & { seller: { email: string } };
  type: string;
  noteId: string;
  amount: number | null;
  message: string;
  expiresAt: Date | null;
  // Placed at the seller's buy-it-now price. The award follows at once, and it sends the notices.
  buyNow?: boolean;
  // A whole-pool bid's price for each loan, already checked against the bid, and whether part may be taken.
  loanPrices?: LoanPrices | null;
  allowPartial?: boolean;
  // The approved buying entity checkOffer passed. Missing means the main file.
  buyerEntityId?: string | null;
};

// The row and the opening bid message. Callers that claim something first write this, link it, then announce it.
export async function writeInquiry(input: InquiryInput) {
  const offer = input.type === "OFFER";
  const inquiry = await prisma.inquiry.create({
    data: {
      listingId: input.listing.id,
      buyerId: input.user.id,
      noteId: offer && input.noteId ? input.noteId : null,
      type: offer ? "OFFER" : input.type === "DATA_ROOM" ? "DATA_ROOM" : "INFO_REQUEST",
      amount: input.amount,
      message: input.message,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(offer && input.buyNow ? { buyNow: true } : {}),
      ...(offer && !input.noteId && input.loanPrices ? { loanPrices: input.loanPrices, allowPartial: Boolean(input.allowPartial) } : {}),
      ...(offer && input.buyerEntityId ? { buyerEntityId: input.buyerEntityId } : {}),
    },
  });
  if (offer && input.amount != null) {
    await prisma.offerMessage.create({
      data: { inquiryId: inquiry.id, authorId: input.user.id, kind: "OFFER", amount: input.amount, body: input.message || "Opening bid." },
    });
  }
  return inquiry;
}

// The thread, the seller's and the desk's notices, and the seller's webhook. A sealed bid reaches the seller
// without its amount. A buy-it-now bid's notices wait for the award, which decides what they say.
export async function announceInquiry(inquiry: { id: string; status: string }, input: InquiryInput) {
  const { user, listing, type, amount, message, expiresAt } = input;
  await ensureInquiryThread(inquiry.id);
  const label = type === "OFFER" ? `Offer of $${Math.round(amount || 0).toLocaleString("en-US")}` : type === "DATA_ROOM" ? "Data room request" : "Information request";
  const until = expiresAt ? ` Good until ${expiresAt.toISOString().slice(0, 10)}.` : "";
  const sealed = type === "OFFER" && sealedFromSeller(listing);
  if (!input.buyNow) {
    // The seller hears the bidder's letter, not who they are, until an award. The desk's notice names them.
    const alias = await bidderAlias(listing.id, user.id);
    if (sealed) {
      await notify(listing.seller.email, `Sealed bid · ${listing.title}`, `${alias} placed a sealed bid. The amount opens at the deadline.`);
    } else {
      await notify(listing.seller.email, `${label} · ${listing.title}`, `${alias} wrote: ${message || "No message."}`);
    }
    await notifyDesk(`${label} · ${listing.title}`, `From ${user.name} (${user.email}).${until} ${message || ""}`, { capability: "sealedBids" });
  }
  if (type === "OFFER") {
    const { emitWebhook } = await import("@/lib/webhooks");
    await emitWebhook(listing.sellerId, "offer.created", {
      inquiryId: inquiry.id,
      listingId: listing.id,
      amount: sealed ? null : amount,
      sealed,
      status: inquiry.status,
      ...(input.buyNow ? { buyNow: true } : {}),
    });
  }
}

const LIVE = ["OPEN", "REVIEWED"] as const;

export type BuyNowResult =
  | { error: string; verification: boolean }
  | { error: null; inquiryId: string; closingId: string | null };

// The buyer takes the seller's buy-it-now price. The bid passes every check the bid form runs, then the award runs
// at once, and the first buyer whose award claims the listing wins. A buyer who lost the race, or whose price the
// seller changed in that instant, has their bid closed and owes nothing. Anything else that stops the award, such
// as a screening hold, leaves the bid open at the seller's price for the desk to clear.
export async function placeBuyNow(input: { user: Buyer; listingId: string; price: number; buyerEntityId?: string | null; now?: Date }): Promise<BuyNowResult> {
  const { user } = input;
  const now = input.now ?? new Date();
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, include: { seller: true } });
  if (!listing) return { error: "This listing is not taking new inquiries.", verification: false };
  const traded = listing.kind === "POOL" ? await prisma.note.count({ where: { listingId: listing.id, tradeStatus: { not: "AVAILABLE" } } }) : 0;
  const offer = buyNowOffer(listing, traded === 0, now);
  if (offer.price === null) return { error: offer.reason, verification: false };
  // The buyer binds to the figure they saw. A change since the page loaded asks them to look again.
  if (!samePrice(input.price, offer.price)) return { error: "The buy-it-now price changed. Check the new figure and confirm again.", verification: false };
  // The price is veiled on the free desk like the ask, so taking it is a Pro privilege like seeing it.
  if (!isPro(user)) return { error: "Buy it now is a Pro privilege.", verification: false };
  const check = await checkOffer({ user, listing, noteId: "", amount: offer.price, goodUntil: "", buyerEntityId: input.buyerEntityId, now });
  if (check.error !== null) return check;
  const mine = await prisma.inquiry.findFirst({ where: { listingId: listing.id, buyerId: user.id, type: "OFFER", buyNow: true, status: { in: [...LIVE, "ACCEPTED"] } }, select: { id: true } });
  if (mine) return { error: "You already confirmed buy it now on this listing.", verification: false };
  const bid = { user, listing, type: "OFFER", noteId: "", amount: offer.price, message: "Confirmed at the seller's buy-it-now price.", expiresAt: null, buyNow: true, buyerEntityId: check.buyerEntityId };
  const inquiry = await writeInquiry(bid);
  await announceInquiry(inquiry, bid);
  await logEligibility(user.id, inquiry.id, check);
  const title = listing.title;
  const award = await awardOffer(inquiry.id, user.id);
  if (award.error === null) {
    await notifyDesk(
      `Buy it now · ${title}`,
      `${user.name} (${user.email}) confirmed the buy-it-now price of ${money(offer.price)}. The seller agreed it in advance, so the closing is open and the other bids are declined.`,
    );
    return { error: null, inquiryId: inquiry.id, closingId: award.closingId };
  }
  const after = await prisma.listing.findUnique({ where: { id: listing.id }, select: { status: true, buyNowPrice: true } });
  const taken = after?.status !== "APPROVED" || (listing.kind === "POOL" && (await prisma.note.count({ where: { listingId: listing.id, tradeStatus: { not: "AVAILABLE" } } })) > 0);
  const pulled = !samePrice(after?.buyNowPrice, offer.price);
  if (taken || pulled) {
    // This bid can't be awarded at this price now, so it closes rather than waiting on anyone.
    await prisma.inquiry.updateMany({ where: { id: inquiry.id, status: { in: [...LIVE] } }, data: { status: "DECLINED" } });
    await audit(user.id, "BUY_NOW_LOST", "inquiry", inquiry.id, `${title} · ${money(offer.price)} · ${taken ? "another sale came first" : "the seller changed the price first"}`);
    return {
      // Counsel: a buyer who wasn't first owes nothing.
      error: taken ? "Another buyer confirmed first, so this listing is in contract. Your bid is closed and nothing is owed." : "The seller changed the buy-it-now price a moment ago. Your bid is closed and nothing is owed.",
      verification: false,
    };
  }
  await notifyDesk(
    `Buy it now needs the desk · ${title}`,
    `${user.name} (${user.email}) confirmed the buy-it-now price of ${money(offer.price)}, but the award didn't finish: ${award.error} The seller agreed this price in advance, so award it from the offer book once that is cleared.`,
  );
  return { error: null, inquiryId: inquiry.id, closingId: null };
}
