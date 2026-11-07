import type { ListingStatus } from "@prisma/client";
import { notifySeats, onGroupAccepted, onGroupCounter, onGroupDeclined } from "@/lib/group-events";
import { deadlinePassed } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { openClosing, tradeConflict } from "@/lib/closing-service";
import { notify, notifyDesk } from "@/lib/email";
import { buyNowAgreed, buyNowClearBlock, buyNowConsent, buyNowSetBlock, samePrice } from "@/lib/buy-now";
import { listingWithdrawBlock } from "@/lib/listing-status";
import { bidExpired, buyerPrice, withdrawBlock, type OfferMoney } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";
import { strikeStanding } from "@/lib/strikes";

const LIVE = ["OPEN", "REVIEWED"] as const;

function dollars(amount: number) {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

// Why open bids are closing, in the words each bidder and group hears. The default is another bid winning.
type DeclineWhy = { subject: string; bidder: string; group: string; reason: string };

// Once a bid wins, the others on the same loans can't, so they close now: an award, a desk purchase, a manual sale,
// or the seller withdrawing the listing. Each bidder hears it without the price or the winner. A one-loan sale also
// ends offers on the whole listing, which can no longer trade whole. Pass a null winner id when the winning bid
// isn't an offer.
export async function declineLosingBids(winner: { id: string | null; listingId: string; noteId: string | null }, title: string, why?: DeclineWhy) {
  const open = await prisma.inquiry.findMany({
    where: { listingId: winner.listingId, ...(winner.id ? { id: { not: winner.id } } : {}), type: "OFFER", status: { in: [...LIVE] } },
    include: { buyer: { select: { email: true } } },
  });
  const losers = winner.noteId ? open.filter((offer) => !offer.noteId || offer.noteId === winner.noteId) : open;
  const { emitWebhook } = await import("@/lib/webhooks");
  const sellerId = (await prisma.listing.findUnique({ where: { id: winner.listingId }, select: { sellerId: true } }))?.sellerId;
  let declined = 0;
  for (const loser of losers) {
    // A bid its buyer withdrew a moment ago stays withdrawn, and they aren't told it was declined.
    const closed = await prisma.inquiry.updateMany({ where: { id: loser.id, status: { in: [...LIVE] } }, data: { status: "DECLINED" } });
    if (closed.count !== 1) continue;
    declined += 1;
    await onGroupDeclined(loser.id, why?.group ?? "Another bid was accepted, so the group offer closed.");
    if (sellerId) await emitWebhook(sellerId, "offer.declined", { inquiryId: loser.id, listingId: winner.listingId, reason: why?.reason ?? "another_bid_accepted" });
    await notify(
      loser.buyer.email,
      why ? `${why.subject} · ${title}` : `Bid not selected · ${title}`,
      why
        ? why.bidder
        : winner.noteId && !loser.noteId
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
  return declined;
}

// Takes one loan into contract only if it is still free, in a single write, so two awards at the same moment
// can't both get it. Returns false when someone else got there first.
export async function claimLoan(noteId: string) {
  const claimed = await prisma.note.updateMany({ where: { id: noteId, tradeStatus: "AVAILABLE" }, data: { tradeStatus: "IN_CONTRACT" } });
  return claimed.count === 1;
}

// The seller's word on a price: a buy-it-now bid at exactly their buy-it-now price, a standing reserve at or below
// it, or an approval of exactly this amount. Without one there is no sale, because nothing binds the seller to it.
export function sellerAgreed(input: {
  price: number;
  reserve: number | null | undefined;
  approvedAmount: number | null | undefined;
  buyNow?: { bid: boolean | null | undefined; price: number | null | undefined };
}) {
  if (input.buyNow && buyNowAgreed({ buyNow: input.buyNow.bid, price: input.price, buyNowPrice: input.buyNow.price })) return "buyNow" as const;
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

// The question to the seller as it was read: still live, asked at the same moment and not answered since. Each answer
// is a conditional write on it, so an approval, a decline or a counter that landed first wins.
export function sameQuestion(offer: { id: string; sellerAskedAt: Date | null; sellerAnsweredAt: Date | null }) {
  return {
    id: offer.id,
    status: { in: [...LIVE] },
    sellerAskedAt: offer.sellerAskedAt,
    ...(offer.sellerAnsweredAt ? { sellerAnsweredAt: offer.sellerAnsweredAt } : unset("sellerAnsweredAt")),
  };
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
  if (offer.status === "WITHDRAWN") return { error: "The buyer withdrew that bid." } as const;
  if (offer.status === "EXPIRED" || (offer.status !== "ACCEPTED" && bidExpired(offer.expiresAt))) {
    return { error: "That bid passed its good-until date, so it can't be awarded. The buyer can send a new one." } as const;
  }
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
  // A strike pause stops awards as well as new bids, so a bid placed before the pause can't win during it. The
  // error reaches the desk only: a seller whose approval stops here sees a pending notice.
  const standings = await Promise.all([offer.buyerId, ...seats.map((seat) => seat.userId)].map((userId) => strikeStanding(userId)));
  if (standings[0].paused) return { error: "This buyer's bidding is paused for closings that didn't complete. Clear a strike on their buyer file before awarding." } as const;
  if (standings.some((standing) => standing.paused)) return { error: "A group seat holder's bidding is paused for closings that didn't complete. Clear a strike on their buyer file before awarding." } as const;
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
  const agreed = sellerAgreed({
    price,
    reserve: offer.listing.reservePrice,
    approvedAmount: offer.sellerApprovedAmount,
    buyNow: { bid: offer.buyNow, price: offer.listing.buyNowPrice },
  });
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
  // Two awards can pass the checks above at the same moment: a second click, the seller approving while the desk
  // accepts, or two bids on one listing. Each claim below is a conditional write, so only one award goes through,
  // and a loser puts back what it took.
  // The buyer's good-until date is part of the claim too, so a bid can't be taken in the minute it lapses.
  const won = await prisma.inquiry.updateMany({
    where: { id: offer.id, status: { in: [...LIVE] }, OR: [...unset("expiresAt").OR, { expiresAt: { gt: new Date() } }] },
    data: { status: "ACCEPTED", amount: price },
  });
  if (won.count !== 1) return { error: "That offer was decided a moment ago." } as const;
  const release = () => prisma.inquiry.update({ where: { id: offer.id }, data: { status: offer.status, amount: offer.amount } });
  if (offer.noteId) {
    if (!(await claimLoan(offer.noteId))) {
      await release();
      return { error: "That loan went into contract a moment ago. Check its open closing." } as const;
    }
    // A whole-listing award that claimed the listing first wins, and this loan goes back.
    const listing = await prisma.listing.findUnique({ where: { id: offer.listingId }, select: { status: true } });
    if (listing?.status !== "APPROVED") {
      await prisma.note.updateMany({ where: { id: offer.noteId, tradeStatus: "IN_CONTRACT" }, data: { tradeStatus: "AVAILABLE" } });
      await release();
      return { error: "The whole listing went into contract a moment ago." } as const;
    }
  } else {
    // A buy-it-now sale claims on the price too, so a seller who changes or removes it in the same instant either
    // lands first and stops this sale, or finds the listing already in contract.
    const claimed = await prisma.listing.updateMany({
      where: { id: offer.listingId, status: "APPROVED", ...(check.agreed === "buyNow" ? { buyNowPrice: price } : {}) },
      data: { status: "PENDING" satisfies ListingStatus, acceptedInquiryId: offer.id },
    });
    if (claimed.count !== 1) {
      await release();
      const now = check.agreed === "buyNow" ? await prisma.listing.findUnique({ where: { id: offer.listingId }, select: { status: true } }) : null;
      if (now?.status === "APPROVED") return { error: "The seller changed the buy-it-now price a moment ago." } as const;
      return { error: "This listing went into contract a moment ago." } as const;
    }
    // A one-loan award that claimed a loan first wins, and the listing goes back on the book.
    if ((await prisma.note.count({ where: { listingId: offer.listingId, tradeStatus: { not: "AVAILABLE" } } })) > 0) {
      await prisma.listing.updateMany({
        where: { id: offer.listingId, status: "PENDING", acceptedInquiryId: offer.id },
        data: { status: "APPROVED", acceptedInquiryId: null },
      });
      await release();
      return { error: "A loan on this listing went into contract a moment ago." } as const;
    }
  }
  const closing = await openClosing({ listingId: offer.listingId, inquiryId: offer.id, noteId: offer.noteId, salePrice: price, title: offer.listing.title });
  await onGroupAccepted(offer.id, closing.id, closing.buyerPremiumCents);
  const { emitWebhook } = await import("@/lib/webhooks");
  await emitWebhook(offer.listing.sellerId, "offer.accepted", { inquiryId: offer.id, listingId: offer.listingId, closingId: closing.id, amount: price });
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closing.id}`;
  const buyNow = check.agreed === "buyNow";
  // Counsel: the buy-it-now notices restate that the sale binds both sides as agreed in advance.
  await notify(
    offer.buyer.email,
    `${buyNow ? "Bought at the buy-it-now price" : "Offer accepted"} · ${offer.listing.title}`,
    `${buyNow ? `You confirmed the buy-it-now price of ${dollars(price)} first.` : `Your bid of $${price.toLocaleString("en-US")} was accepted.`} The closing checklist is open: ${link}`,
  );
  await notify(
    offer.listing.seller.email,
    `${buyNow ? "Sold at your buy-it-now price" : "Offer accepted"} · ${offer.listing.title}`,
    buyNow
      ? `${offer.buyer.name} confirmed your buy-it-now price of ${dollars(price)}, so the sale went ahead as you agreed. Closing checklist: ${link}`
      : `${offer.buyer.name}'s offer was accepted. Closing checklist: ${link}`,
  );
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
    `${offer.listing.title} · ${offer.buyer.name} · ${AGREED_AS[check.agreed]}${declined ? ` · ${declined} other bid${declined === 1 ? "" : "s"} declined` : ""}`,
  );
  return { error: null, closingId: closing.id, declined, price } as const;
}

const AGREED_AS = {
  buyNow: "at the seller's buy-it-now price, agreed in advance",
  reserve: "within the seller's reserve",
  approved: "approved by the seller",
} as const;

// Buy-it-now bids still waiting on the desk: confirmed, but the award didn't finish. While one is open the seller's
// price stands, so the buyer who confirmed first can still be awarded at it.
export function openBuyNowBids(listingId: string) {
  return prisma.inquiry.count({ where: { listingId, type: "OFFER", buyNow: true, status: { in: [...LIVE] } } });
}

// The seller or the filing broker sets, changes or (with a null price) removes the buy-it-now price. The write is
// conditional on the status and the price as they were read, and a buy-it-now award claims the listing on the same
// two, so when a buyer confirms in the same instant exactly one of them lands.
export async function setBuyNow(listingId: string, actorId: string, price: number | null, now = new Date()) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: { select: { tradeStatus: true } } } });
  if (!listing || (listing.sellerId !== actorId && listing.brokerId !== actorId)) return { error: "That listing isn't yours." } as const;
  const open = await openBuyNowBids(listingId);
  const block = price === null
    ? buyNowClearBlock({ status: listing.status, buyNowPrice: listing.buyNowPrice, openBuyNowBids: open })
    : buyNowSetBlock({
      status: listing.status,
      bidMode: listing.bidMode,
      price,
      tradedLoans: listing.notes.filter((note) => note.tradeStatus !== "AVAILABLE").length,
      openBuyNowBids: open,
    });
  if (block) return { error: block } as const;
  if (price !== null && samePrice(price, listing.buyNowPrice)) return { error: null, price, unchanged: true } as const;
  const pool = listing.kind === "POOL";
  const consent = price === null ? null : buyNowConsent({ pool, price });
  const wrote = await prisma.listing.updateMany({
    where: { id: listingId, status: listing.status, ...(listing.buyNowPrice == null ? unset("buyNowPrice") : { buyNowPrice: listing.buyNowPrice }) },
    data: price === null ? { buyNowPrice: null, buyNowSetAt: null, buyNowConsent: null } : { buyNowPrice: price, buyNowSetAt: now, buyNowConsent: consent },
  });
  if (wrote.count !== 1) return { error: "This listing changed a moment ago. Reload it and try again." } as const;
  const who = listing.brokerId === actorId ? "filing broker" : "seller";
  const shown = listing.status === "APPROVED" ? "Buyers see it now." : "Buyers see it once the listing is live.";
  if (price === null) {
    await audit(actorId, "BUY_NOW_CLEARED", "listing", listingId, `Was ${dollars(Number(listing.buyNowPrice))}`);
    await notifyDesk(`Buy it now removed · ${listing.title}`, `The ${who} took the buy-it-now price of ${dollars(Number(listing.buyNowPrice))} off ${listing.title}.`);
  } else {
    // The consent text goes into the log with the price, so the record holds whatever happens to the listing later.
    await audit(actorId, "BUY_NOW_SET", "listing", listingId, `${dollars(price)} · ${consent}`);
    await notifyDesk(
      `Buy it now ${listing.buyNowPrice == null ? "set" : "changed"} · ${listing.title}`,
      `The ${who} committed to sell ${pool ? "the whole pool" : "the note"} at ${dollars(price)} to the first verified buyer who confirms it. ${shown} The first confirmation opens the closing without asking the desk or the seller.`,
    );
  }
  return { error: null, price, unchanged: false } as const;
}

function pricedMessages(messages: { kind: string; amount: number | null; createdAt: Date; authorId: string }[]) {
  return messages.map((message) => ({ kind: message.kind, amount: message.amount, createdAt: message.createdAt, authorId: message.authorId }));
}

// The buyer takes a bid back before it is accepted. The claim is conditional, so an award landing at the same
// moment wins or loses cleanly. Returns the group's id when the bid belongs to one, so the caller can point there.
export async function withdrawBid(inquiryId: string, buyerId: string, now = new Date()) {
  const offer = await prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { buyer: true, listing: { include: { seller: true } }, messages: true } });
  if (!offer || offer.buyerId !== buyerId) return { error: "That bid isn't yours.", groupId: null } as const;
  const group = await prisma.groupBuy.findFirst({ where: { inquiryId }, select: { id: true } });
  const block = withdrawBlock({ type: offer.type, status: offer.status, bidMode: offer.listing.bidMode, bidDeadline: offer.listing.bidDeadline, group: Boolean(group), now });
  if (block) return { error: block, groupId: group?.id ?? null } as const;
  const claimed = await prisma.inquiry.updateMany({
    where: { id: offer.id, buyerId, status: { in: [...LIVE] } },
    data: { status: "WITHDRAWN", withdrawnAt: now },
  });
  if (claimed.count !== 1) return { error: "That bid was decided a moment ago.", groupId: null } as const;
  const price = buyerPrice(offer.amount, pricedMessages(offer.messages), offer.buyerId) ?? 0;
  const title = offer.listing.title;
  await prisma.offerMessage.create({ data: { inquiryId: offer.id, authorId: buyerId, kind: "NOTE", body: "The buyer withdrew this bid." } });
  await audit(buyerId, "BID_WITHDRAWN", "inquiry", offer.id, `${title} · ${dollars(price)}`);
  const { emitWebhook } = await import("@/lib/webhooks");
  await emitWebhook(offer.listing.sellerId, "offer.declined", { inquiryId: offer.id, listingId: offer.listingId, reason: "withdrawn" });
  const asked = Boolean(offer.sellerAskedAt);
  await notifyDesk(
    `Bid withdrawn · ${title}`,
    `${offer.buyer.name} withdrew their bid of ${dollars(price)}${offer.noteId ? " for one loan" : ""}.${asked ? " The seller had been asked to approve it and was told." : ""}`,
  );
  if (asked) {
    await notify(
      offer.listing.seller.email,
      `Bid withdrawn · ${title}`,
      `The buyer withdrew the bid of ${dollars(Number(offer.sellerAskedAmount ?? price))} the desk asked you to approve. Nothing is waiting for your answer on it.`,
    );
  }
  return { error: null, groupId: null } as const;
}

// The seller answers the desk's question with their own figure. It counts as their approval of exactly that price
// and goes to the buyer as a counter, so a buyer who accepts it can be awarded without asking the seller again.
export async function recordSellerCounter(inquiryId: string, sellerId: string, amount: number, now = new Date()) {
  const offer = await prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { buyer: true, listing: true, messages: true } });
  if (!offer || offer.listing.sellerId !== sellerId) return { error: "That bid isn't on your listing." } as const;
  if (!awaitingSeller(offer) || offer.sellerAskedAmount == null || (offer.status !== "OPEN" && offer.status !== "REVIEWED")) {
    return { error: "Nothing on this listing is waiting for your answer." } as const;
  }
  if (offer.listing.status !== "APPROVED") return { error: "This listing isn't live right now, so you can't counter." } as const;
  if (bidExpired(offer.expiresAt, now)) return { error: "That bid passed its good-until date, so there is nothing to counter." } as const;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return { error: "Enter your counter in dollars." } as const;
  const current = buyerPrice(offer.amount, pricedMessages(offer.messages), offer.buyerId);
  if (current != null && amount <= current + 0.005) return { error: "A counter is above the buyer's bid. To sell at their price, approve it." } as const;
  const answered = await prisma.inquiry.updateMany({
    where: sameQuestion(offer),
    data: { sellerCounterAmount: amount, sellerCounteredAt: now, sellerApprovedAmount: amount, sellerAnsweredAt: now, sellerDeclined: false },
  });
  if (answered.count !== 1) return { error: "This bid was answered a moment ago." } as const;
  const title = offer.listing.title;
  const asked = Number(offer.sellerAskedAmount);
  await prisma.offerMessage.create({ data: { inquiryId: offer.id, authorId: sellerId, kind: "COUNTER", amount, createdAt: now, body: `The seller countered at ${dollars(amount)}.` } });
  // A group's seats each reconfirm the new price before it is the group's bid.
  await onGroupCounter(offer.id, amount, "seller");
  await audit(sellerId, "SELLER_COUNTERED", "inquiry", offer.id, `${title} · asked ${dollars(asked)} · countered ${dollars(amount)}`);
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/buyer/offers`;
  await notify(
    offer.buyer.email,
    `Seller counter · ${title}`,
    `The seller countered your bid at ${dollars(amount)}. The seller has already agreed to that price, so if you accept it the desk can award it without asking again. You can also leave your bid as it is: ${link}`,
  );
  await notifyDesk(
    `Seller countered · ${title}`,
    `The seller answered ${dollars(asked)} with a counter at ${dollars(amount)}. It's posted to the buyer. If they accept, it can be awarded without asking the seller again.`,
  );
  return { error: null, amount } as const;
}

const OPEN_GROUPS = ["GATHERING", "OFFERED", "COUNTERED"] as const;

// The seller or the filing broker takes a listing off the book before it is in contract. The status write is
// conditional on the status as it was read, open bids are declined with a notice, open desk bids end, and groups
// are dissolved. A relist is a copy the desk reviews again.
export async function withdrawListing(listingId: string, actorId: string, now = new Date()) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { seller: true } });
  if (!listing || (listing.sellerId !== actorId && listing.brokerId !== actorId)) return { error: "That listing isn't yours." } as const;
  const block = listingWithdrawBlock(listing.status, await prisma.closing.count({ where: { listingId, status: "OPEN" } }));
  if (block) return { error: block } as const;
  const claimed = await prisma.listing.updateMany({ where: { id: listingId, status: listing.status }, data: { status: "WITHDRAWN", withdrawnAt: now } });
  if (claimed.count !== 1) return { error: "This listing changed a moment ago. Reload it and try again." } as const;
  // A one-loan award can claim its loan in the instant before this write. That sale stands, and the listing goes back.
  const busy = (await prisma.closing.count({ where: { listingId, status: "OPEN" } })) + (await prisma.note.count({ where: { listingId, tradeStatus: "IN_CONTRACT" } }));
  if (busy > 0) {
    await prisma.listing.updateMany({ where: { id: listingId, status: "WITHDRAWN" }, data: { status: listing.status, withdrawnAt: listing.withdrawnAt } });
    return { error: "A bid on this listing was accepted a moment ago, so it can't be withdrawn." } as const;
  }
  const declined = await declineLosingBids({ id: null, listingId, noteId: null }, listing.title, {
    subject: "Listing withdrawn",
    bidder: "The seller withdrew this listing, so your bid is closed. Nothing is owed. Thank you for bidding.",
    group: "The seller withdrew this listing, so the group offer closed and your seat is released.",
    reason: "listing_withdrawn",
  });
  // A group still gathering seats has no bid to decline, so it is dissolved here.
  const groups = await prisma.groupBuy.findMany({ where: { listingId, status: { in: [...OPEN_GROUPS] } }, select: { id: true } });
  for (const group of groups) {
    const closed = await prisma.groupBuy.updateMany({ where: { id: group.id, status: { in: [...OPEN_GROUPS] } }, data: { status: "DISSOLVED" } });
    if (closed.count === 1) await notifySeats(group.id, `Group closed · ${listing.title}`, "The seller withdrew this listing, so the group closed and your seat is released.");
  }
  const who = listing.brokerId === actorId ? "filing broker" : "seller";
  const bids = declined ? ` ${declined} open bid${declined === 1 ? " was" : "s were"} declined.` : "";
  await prisma.reviewComment.create({ data: { listingId, authorId: actorId, action: "WITHDRAW", comment: `Withdrawn by the ${who}.${bids}` } });
  await audit(actorId, "LISTING_WITHDRAWN", "listing", listingId, `${listing.title} · was ${listing.status.replaceAll("_", " ").toLowerCase()}${bids}`);
  await notifyDesk(`Listing withdrawn · ${listing.title}`, `The ${who} withdrew ${listing.title}.${bids || " It had no open bids."}`);
  if (listing.sellerId !== actorId) {
    await notify(listing.seller.email, `Listing withdrawn · ${listing.title}`, `Your broker withdrew ${listing.title} from the book.${bids}`);
  }
  return { error: null, declined } as const;
}
