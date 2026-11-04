import type { ListingStatus } from "@prisma/client";
import { onGroupAccepted, onGroupDeclined } from "@/lib/group-events";
import { deadlinePassed } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { openClosing, tradeConflict } from "@/lib/closing-service";
import { notify } from "@/lib/email";
import { buyerPrice, type OfferMoney } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";

// Once a bid wins, the others on the same loans can't, so they close now: an award, a desk purchase, or a
// manual sale. Each bidder hears it without the price or the winner. A one-loan sale also ends offers on the
// whole listing, which can no longer trade whole. Pass a null winner id when the winning bid isn't an offer.
export async function declineLosingBids(winner: { id: string | null; listingId: string; noteId: string | null }, title: string) {
  const open = await prisma.inquiry.findMany({
    where: { listingId: winner.listingId, ...(winner.id ? { id: { not: winner.id } } : {}), type: "OFFER", status: { in: ["OPEN", "REVIEWED"] } },
    include: { buyer: { select: { email: true } } },
  });
  const losers = winner.noteId ? open.filter((offer) => !offer.noteId || offer.noteId === winner.noteId) : open;
  const { emitWebhook } = await import("@/lib/webhooks");
  const sellerId = (await prisma.listing.findUnique({ where: { id: winner.listingId }, select: { sellerId: true } }))?.sellerId;
  for (const loser of losers) {
    await prisma.inquiry.update({ where: { id: loser.id }, data: { status: "DECLINED" } });
    await onGroupDeclined(loser.id, "Another bid was accepted, so the group offer closed.");
    if (sellerId) await emitWebhook(sellerId, "offer.declined", { inquiryId: loser.id, listingId: winner.listingId, reason: "another_bid_accepted" });
    await notify(
      loser.buyer.email,
      `Bid not selected · ${title}`,
      winner.noteId && !loser.noteId
        ? "A loan in this pool was sold on its own, so the pool can no longer trade whole. Thank you for bidding."
        : "Another bid was accepted. Thank you for bidding.",
    );
  }
  // The desk's open bids on the same loans can't be taken either, so they come off the seller's page. A desk bid
  // that just won is already ACCEPTED.
  await prisma.deskBid.updateMany({
    where: { listingId: winner.listingId, status: "OPEN", ...(winner.noteId ? { OR: [{ noteId: winner.noteId }, ...unset("noteId").OR] } : {}) },
    data: { status: "WITHDRAWN" },
  });
  return losers.length;
}

// Takes one loan into contract only if it is still free, in a single write, so two awards at the same moment
// can't both get it. Returns false when someone else got there first.
export async function claimLoan(noteId: string) {
  const claimed = await prisma.note.updateMany({ where: { id: noteId, tradeStatus: "AVAILABLE" }, data: { tradeStatus: "IN_CONTRACT" } });
  return claimed.count === 1;
}

// The seller's word on a price: a standing reserve at or below it, or an approval of exactly this amount.
// Without one there is no sale, because nothing binds the seller to it.
export function sellerAgreed(input: { price: number; reserve: number | null | undefined; approvedAmount: number | null | undefined }) {
  if (input.reserve != null && input.reserve > 0 && input.price >= input.reserve) return "reserve" as const;
  if (input.approvedAmount != null && Math.abs(input.approvedAmount - input.price) < 0.005) return "approved" as const;
  return null;
}

// The buyer can change their bid after the desk asks the seller. An answer to the old figure can't sell at the new one.
export function askedPriceStands(asked: number | null | undefined, current: number | null | undefined) {
  return asked != null && current != null && Math.abs(asked - current) < 0.005;
}

type BidMoney = { id: string; type: string; status: string; noteId: string | null; amount: number | null; buyerId: string; messages: OfferMoney[] };

// The other live bids a seller can weigh against this one: those for the same loan, or for the whole listing when
// this one is, each at the buyer's own latest price rather than the opening bid.
export function rivalBids(offer: BidMoney, offers: BidMoney[]) {
  const rest = offers.filter((other) => other.id !== offer.id && other.type === "OFFER" && (other.status === "OPEN" || other.status === "REVIEWED") && other.noteId === offer.noteId);
  const best = rest.reduce((top, other) => Math.max(top, buyerPrice(other.amount, other.messages, other.buyerId) ?? 0), 0);
  return { count: rest.length, best };
}

// A bid waits on the seller when the desk asked and the seller hasn't answered since.
export function awaitingSeller(offer: { sellerAskedAt: Date | null; sellerAnsweredAt: Date | null }) {
  return Boolean(offer.sellerAskedAt && (!offer.sellerAnsweredAt || offer.sellerAnsweredAt < offer.sellerAskedAt));
}

// Why a buyer's bid on a listing in this status can't be awarded, or null when it can.
export function listingNotAwardable(status: string) {
  if (status === "APPROVED") return null;
  if (status === "SOLD") return "This listing is already sold.";
  if (status === "PENDING") return "This listing is in contract, so its bids can't be awarded.";
  return "This listing isn't live, so its bids can't be awarded.";
}

// The desk may buy a file before it goes live, but not one it declined, sent back, or that is already in contract.
export function deskBidNotAcceptable(listing: { status: string; bidMode: string; bidDeadline: Date | null }) {
  if (listing.status === "SOLD") return "This listing is already sold.";
  if (listing.status === "PENDING") return "This listing is in contract, so the bid can't be taken.";
  if (listing.status === "REJECTED" || listing.status === "CHANGES_REQUESTED") return "This listing was declined or sent back for changes, so the bid can't be taken.";
  // Taking a bid closes every other one, so a sealed or best-and-final round runs to its deadline first.
  if (listing.bidMode !== "NONE" && !deadlinePassed(listing.bidDeadline)) return "This bid can be accepted after the bid deadline.";
  return null;
}

function loadOffer(inquiryId: string) {
  return prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { buyer: true, listing: { include: { seller: true } } } });
}

type Offer = NonNullable<Awaited<ReturnType<typeof loadOffer>>>;

// Every check an award needs, before any write. It runs again at the moment of award, because a seller may
// approve days after the desk asked and the deal can change in between.
export async function checkAward(inquiryId: string) {
  const offer = await loadOffer(inquiryId);
  if (!offer || offer.type !== "OFFER") return { error: "That offer no longer exists." } as const;
  if (offer.status === "DECLINED") return { error: "That offer was declined or its closing was canceled. The buyer can send a new one." } as const;
  const awarded = await prisma.closing.findUnique({ where: { inquiryId } });
  if (awarded) return { error: "That offer already has a closing.", closingId: awarded.id } as const;
  // Only a live listing sells. A rejected or sent-back one would skip the desk's review, and an in-contract one
  // is already spoken for. A pool's one-loan sales leave it live, so they pass here too.
  const listingProblem = listingNotAwardable(offer.listing.status);
  if (listingProblem) return { error: listingProblem } as const;
  if (offer.buyer.accountStatus !== "APPROVED") return { error: "That buyer account is not approved." } as const;
  // A group's seats all become funders and closing parties, so each seat holder is checked like the lead.
  const group = await prisma.groupBuy.findFirst({ where: { inquiryId }, include: { positions: { include: { user: { select: { accountStatus: true } } } } } });
  const seats = group ? group.positions.filter((seat) => seat.status !== "DROPPED") : [];
  if (seats.some((seat) => seat.user.accountStatus !== "APPROVED")) return { error: "A group seat holder's account is not approved." } as const;
  const parties = [offer.buyerId, offer.listing.sellerId, ...seats.map((seat) => seat.userId)];
  if (await ofacHold({ listingId: offer.listingId, userIds: parties })) return { error: OFAC_HOLD_MESSAGE } as const;
  if (offer.listing.bidMode !== "NONE" && !deadlinePassed(offer.listing.bidDeadline)) return { error: "Award this after the bid deadline." } as const;
  const conflict = await tradeConflict(offer.listingId, offer.noteId);
  if (conflict) return { error: conflict } as const;
  const messages = await prisma.offerMessage.findMany({ where: { inquiryId } });
  // Only a price the buyer put forward can be awarded. A desk counter they haven't accepted can't.
  const price = buyerPrice(
    offer.amount ? Number(offer.amount) : null,
    messages.map((message) => ({ kind: message.kind, amount: message.amount ? Number(message.amount) : null, createdAt: message.createdAt, authorId: message.authorId })),
    offer.buyerId,
  );
  if (!price || price <= 0) return { error: "That offer has no amount." } as const;
  // A group bid is the seats' money. Every seat must have agreed to this price, and together they must cover it.
  if (group) {
    if (seats.some((seat) => seat.status === "RECONFIRM")) return { error: "Some group seats haven't reconfirmed the latest price." } as const;
    const covered = seats.reduce((sum, seat) => sum + Number(seat.amount), 0);
    if (Math.abs(covered - price) > 1) {
      return { error: `The group's seats add up to $${Math.round(covered).toLocaleString("en-US")}, not $${Math.round(price).toLocaleString("en-US")}. The seats reconfirm a price before it can be awarded.` } as const;
    }
  }
  const agreed = sellerAgreed({ price, reserve: offer.listing.reservePrice, approvedAmount: offer.sellerApprovedAmount });
  return { error: null, offer, price, agreed } as const;
}

// Where the seller of record answers. A broker who filed the listing answers from the deal page, and a buyer
// reselling a note they hold answers from their resale page, since seller pages are closed to buyers.
export function sellerPage(listing: { id: string; sellerId: string; brokerId: string | null }, sellerRole: string) {
  if (listing.brokerId && listing.brokerId === listing.sellerId) return `/broker/deals/${listing.id}`;
  if (sellerRole === "BUYER") return `/buyer/resales/${listing.id}`;
  return `/seller/listings/${listing.id}`;
}

export async function askSeller(offer: Offer, price: number) {
  await prisma.inquiry.update({
    where: { id: offer.id },
    data: { sellerAskedAt: new Date(), sellerAskedAmount: price, sellerAnsweredAt: null, sellerDeclined: null },
  });
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}${sellerPage(offer.listing, offer.listing.seller.role)}`;
  await notify(
    offer.listing.seller.email,
    `Approve a sale · ${offer.listing.title}`,
    `The desk recommends accepting $${price.toLocaleString("en-US")} from a verified buyer${offer.noteId ? " for one loan" : ""}. Nothing is sold until you approve. Approve or decline here: ${link}`,
  );
}

// The award: the loan or listing goes into contract, the closing opens, and the other bids close. It refuses
// without the seller's agreement, whatever path called it.
export async function awardOffer(inquiryId: string, actorId: string) {
  const check = await checkAward(inquiryId);
  if (check.error !== null) return check;
  const { offer, price } = check;
  if (!check.agreed) return { error: "The seller hasn't approved this price." } as const;
  if (offer.noteId && !(await claimLoan(offer.noteId))) return { error: "That loan went into contract a moment ago. Check its open closing." } as const;
  await prisma.inquiry.update({ where: { id: offer.id }, data: { status: "ACCEPTED", amount: price } });
  if (!offer.noteId && offer.listing.status !== "SOLD") {
    await prisma.listing.update({
      where: { id: offer.listingId },
      data: { status: "PENDING" satisfies ListingStatus, acceptedInquiryId: offer.id },
    });
  }
  const closing = await openClosing({ listingId: offer.listingId, inquiryId: offer.id, noteId: offer.noteId, salePrice: price, title: offer.listing.title });
  await onGroupAccepted(offer.id, closing.id, closing.buyerPremiumCents);
  const { emitWebhook } = await import("@/lib/webhooks");
  await emitWebhook(offer.listing.sellerId, "offer.accepted", { inquiryId: offer.id, listingId: offer.listingId, closingId: closing.id, amount: price });
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closing.id}`;
  await notify(offer.buyer.email, `Offer accepted · ${offer.listing.title}`, `Your bid of $${price.toLocaleString("en-US")} was accepted. The closing checklist is open: ${link}`);
  await notify(offer.listing.seller.email, `Offer accepted · ${offer.listing.title}`, `${offer.buyer.name}'s offer was accepted. Closing checklist: ${link}`);
  const declined = await declineLosingBids(offer, offer.listing.title);
  // The seller reads every review comment, so the bidder stays out of it. The audit log keeps the name.
  await prisma.reviewComment.create({
    data: { listingId: offer.listingId, authorId: actorId, action: "COMMENT", comment: "An offer was accepted. The closing checklist is open." },
  });
  await audit(
    actorId,
    "AWARD",
    "inquiry",
    offer.id,
    `${offer.listing.title} · ${offer.buyer.name} · ${check.agreed === "reserve" ? "within the seller's reserve" : "approved by the seller"}${declined ? ` · ${declined} other bid${declined === 1 ? "" : "s"} declined` : ""}`,
  );
  return { error: null, closingId: closing.id, declined, price } as const;
}
