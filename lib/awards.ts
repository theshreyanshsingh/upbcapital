import type { ListingStatus } from "@prisma/client";
import { notifySeats, onGroupAccepted, onGroupCounter, onGroupDeclined } from "@/lib/group-events";
import { deadlinePassed, sealedFromSeller } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { bidderAlias } from "@/lib/bidder-alias";
import { unset } from "@/lib/db-filters";
import { openClosing, partConflict, tradeConflict } from "@/lib/closing-service";
import { notify, notifyDesk } from "@/lib/email";
import { buyNowAgreed, buyNowClearBlock, buyNowConsent, buyNowSetBlock, samePrice } from "@/lib/buy-now";
import { entityAwardBlock } from "@/lib/buyer-entities";
import { listingWithdrawBlock } from "@/lib/listing-status";
import { loanPriceProblem, standingLoanPrices, sumPrices, type LoanPrices } from "@/lib/loan-prices";
import { bidExpired, buyerPrice, withdrawBlock, type OfferMoney } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";
import { strikeStanding } from "@/lib/strikes";
import { notifyWatchers } from "@/lib/watchers";

const LIVE = ["OPEN", "REVIEWED"] as const;

function dollars(amount: number) {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

// Why open bids are closing, in the words each bidder and group hears. The default is another bid winning.
type DeclineWhy = { subject: string; bidder: string; group: string; reason: string };

// The award that closed the round. An offer award passes its price, so each losing bidder can hear where they
// stood. A buy-it-now win passes buyNow, and nobody hears more, since its price is on the listing.
// A part-pool award passes the loans it took in noteIds. An offer award passes the bids asked to stand as backup in
// keep, which stay live (lib/backup-bids.ts) but still count in the round the others hear about.
type Winner = { id: string | null; listingId: string; noteId: string | null; noteIds?: string[]; price?: number | null; buyNow?: boolean; keep?: string[] };

const ORDINALS = ["th", "st", "nd", "rd"];

function ordinal(rank: number) {
  const tens = rank % 100;
  return `${rank}${tens >= 11 && tens <= 13 ? "th" : ORDINALS[rank % 10] ?? "th"}`;
}

// What a losing bidder hears once a bid is awarded: how many bids the round had, where theirs ranked by price, and
// whether the winning price met the seller's reserve. Never an amount, and never who won. The round is every live
// bid on the same loans as the winner, the winner included.
export function roundFeedback(input: { winnerPrice: number; reserve: number | null | undefined; bids: { id: string; price: number | null }[] }, loserId: string) {
  const mine = input.bids.find((bid) => bid.id === loserId)?.price;
  if (mine == null || input.bids.length < 2) return null;
  const priced = input.bids.filter((bid): bid is { id: string; price: number } => bid.price != null);
  const rank = priced.filter((bid) => bid.price > mine + 0.005).length + 1;
  const tied = priced.some((bid) => bid.id !== loserId && Math.abs(bid.price - mine) < 0.005);
  const reserve = input.reserve != null && input.reserve > 0
    ? input.winnerPrice >= input.reserve ? "The winning bid met the seller's reserve." : "The winning bid was under the seller's reserve, and the seller approved it."
    : "The seller set no reserve and approved the winning bid.";
  return `The round had ${input.bids.length} bids, and yours ranked ${ordinal(rank)} by price${tied ? ", tied with another bid" : ""}. ${reserve}`;
}

// Once a bid wins, the others on the same loans can't, so they close now: an award, a desk purchase, a manual sale,
// or the seller withdrawing the listing. Each bidder hears it without the price or the winner. A one-loan sale also
// ends offers on the whole listing, which can no longer trade whole. Pass a null winner id when the winning bid
// isn't an offer.
export async function declineLosingBids(winner: Winner, title: string, why?: DeclineWhy) {
  const open = await prisma.inquiry.findMany({
    where: { listingId: winner.listingId, ...(winner.id ? { id: { not: winner.id } } : {}), type: "OFFER", status: { in: [...LIVE] } },
    include: { buyer: { select: { email: true } }, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } },
  });
  // A sale of some loans closes the bids on those loans and the bids for the whole pool, which can no longer trade
  // whole. A pool bid that lets the seller take part of it stays open while one of its priced loans is still free.
  const sold = winner.noteIds?.length ? winner.noteIds : winner.noteId ? [winner.noteId] : null;
  const free = sold ? new Set((await prisma.note.findMany({ where: { listingId: winner.listingId, tradeStatus: "AVAILABLE" }, select: { id: true } })).map((note) => note.id)) : null;
  const canStillWin = (offer: (typeof open)[number]) => {
    if (!free || !offer.allowPartial) return false;
    const prices = standingLoanPrices(offer.loanPrices, buyerPrice(offer.amount, pricedMessages(offer.messages), offer.buyerId));
    return Boolean(prices && Object.keys(prices).some((noteId) => free.has(noteId) && !sold?.includes(noteId)));
  };
  const losers = (sold ? open.filter((offer) => (offer.noteId ? sold.includes(offer.noteId) : !canStillWin(offer))) : open).filter((offer) => !winner.keep?.includes(offer.id));
  const { emitWebhook } = await import("@/lib/webhooks");
  const listing = await prisma.listing.findUnique({ where: { id: winner.listingId }, select: { sellerId: true, reservePrice: true } });
  const sellerId = listing?.sellerId;
  // Feedback follows an offer award only. A desk purchase, a manual sale or a withdrawal has no round to rank.
  const winnerPrice = winner.price;
  const round = !why && winner.id && winnerPrice != null && winnerPrice > 0 && !winner.buyNow && !winner.noteIds?.length
    ? {
      winnerPrice,
      reserve: listing?.reservePrice,
      bids: [
        { id: winner.id, price: winnerPrice },
        ...open
          .filter((offer) => offer.noteId === winner.noteId)
          .map((offer) => ({ id: offer.id, price: buyerPrice(offer.amount, pricedMessages(offer.messages), offer.buyerId) })),
      ],
    }
    : null;
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
        : winner.noteIds?.length
          ? loser.noteId
            ? "That loan was sold as part of the pool. Thank you for bidding."
            : "Part of this pool was sold, so it can no longer trade whole. Thank you for bidding."
          : winner.noteId && !loser.noteId
            ? "A loan in this pool was sold on its own, so the pool can no longer trade whole. Thank you for bidding."
            : feedbackText(round ? roundFeedback(round, loser.id) : null),
    );
  }
  // The desk's open bids on the same loans can't be taken either, so they come off the seller's page. A desk bid
  // that just won is already ACCEPTED.
  await prisma.deskBid.updateMany({
    where: { listingId: winner.listingId, status: "OPEN", ...(sold ? { OR: [{ noteId: { in: sold } }, ...unset("noteId").OR] } : {}) },
    data: { status: "WITHDRAWN" },
  });
  return declined;
}

function feedbackText(feedback: string | null) {
  return feedback ? `Another bid was accepted. ${feedback} Thank you for bidding.` : "Another bid was accepted. Thank you for bidding.";
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
// approve days after the desk asked and the deal can change in between. A part-pool award passes the loans it
// takes, and is priced at the buyer's own loan prices for them.
export async function checkAward(inquiryId: string, part?: { noteIds: string[] }) {
  const offer = await loadOffer(inquiryId);
  if (!offer || offer.type !== "OFFER") return { error: "That offer no longer exists." } as const;
  if (part && offer.noteId) return { error: "That bid is for one loan, so there is no part of it to take." } as const;
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
  // The seats fund the group's whole price, so its bid is never split.
  if (part && group) return { error: "A group's bid is funded seat by seat for the whole pool, so it can't be split." } as const;
  const seats = group ? group.positions.filter((seat) => seat.status !== "DROPPED") : [];
  if (seats.some((seat) => seat.user.accountStatus !== "APPROVED")) return { error: "A group seat holder's account is not approved." } as const;
  const parties = [offer.buyerId, offer.listing.sellerId, ...seats.map((seat) => seat.userId)];
  if (await ofacHold({ listingId: offer.listingId, userIds: parties })) return { error: OFAC_HOLD_MESSAGE } as const;
  // The papers name the entity the bid is for, so it must still be one the desk approved.
  const entityBlock = await entityAwardBlock(offer);
  if (entityBlock) return { error: entityBlock } as const;
  // A strike pause stops awards as well as new bids, so a bid placed before the pause can't win during it. The
  // error reaches the desk only: a seller whose approval stops here sees a pending notice.
  const standings = await Promise.all([offer.buyerId, ...seats.map((seat) => seat.userId)].map((userId) => strikeStanding(userId)));
  if (standings[0].paused) return { error: "This buyer's bidding is paused for closings that didn't complete. Clear a strike on their buyer file before awarding." } as const;
  if (standings.some((standing) => standing.paused)) return { error: "A group seat holder's bidding is paused for closings that didn't complete. Clear a strike on their buyer file before awarding." } as const;
  if (offer.listing.bidMode !== "NONE" && !deadlinePassed(offer.listing.bidDeadline)) return { error: "Award this after the bid deadline." } as const;
  const conflict = part ? await partConflict(offer.listingId, part.noteIds) : await tradeConflict(offer.listingId, offer.noteId);
  if (conflict) return { error: conflict } as const;
  const messages = await prisma.offerMessage.findMany({ where: { inquiryId } });
  // Only a price the buyer put forward can be awarded. A desk counter they haven't accepted can't.
  const price = buyerPrice(
    offer.amount ? Number(offer.amount) : null,
    messages.map((message) => ({ kind: message.kind, amount: message.amount ? Number(message.amount) : null, createdAt: message.createdAt, authorId: message.authorId })),
    offer.buyerId,
  );
  if (!price || price <= 0) return { error: "That offer has no amount." } as const;
  if (part) return checkPart(offer, price, part.noteIds);
  // A group bid is the seats' money. Every seat must have agreed to this price, and together they must cover it.
  if (group) {
    if (seats.some((seat) => seat.status === "RECONFIRM")) return { error: "Some group seats haven't reconfirmed the latest price." } as const;
    const covered = seats.reduce((sum, seat) => sum + Number(seat.amount), 0);
    if (Math.abs(covered - price) > 1) {
      return { error: `The group's seats add up to $${Math.round(covered).toLocaleString("en-US")}, not $${Math.round(price).toLocaleString("en-US")}. The seats reconfirm a price before it can be awarded.` } as const;
    }
  }
  let agreed = sellerAgreed({
    price,
    reserve: offer.listing.reservePrice,
    approvedAmount: offer.sellerApprovedAmount,
    buyNow: { bid: offer.buyNow, price: offer.listing.buyNowPrice },
  });
  // An approval that answered a question about part of the pool doesn't sell the whole of it.
  if (agreed === "approved" && askedPriceStands(offer.sellerAskedAmount, offer.sellerApprovedAmount) && (await partAsked(offer))) agreed = null;
  return { error: null, offer, price, agreed } as const;
}

// The part-pool checks once the shared ones pass: the buyer priced every loan and allowed part to be taken, the
// part is some of the pool and not all of it, and the seller agreed to that part at that price.
async function checkPart(offer: Offer, wholePrice: number, noteIds: string[]) {
  const prices = standingLoanPrices(offer.loanPrices, wholePrice);
  if (!prices) return { error: "This bid has no loan prices that add up to it, so part of the pool can't be taken." } as const;
  if (!offer.allowPartial) return { error: "The buyer didn't allow part of the pool to be taken." } as const;
  const unique = [...new Set(noteIds)];
  if (unique.length !== noteIds.length || unique.some((noteId) => prices[noteId] == null)) return { error: "Each loan in the part must be one the buyer priced, once." } as const;
  const pool = await prisma.note.count({ where: { listingId: offer.listingId } });
  if (unique.length >= pool) return { error: "That is the whole pool. Award the bid whole." } as const;
  const price = partPrice(prices, unique);
  const reserve = offer.listing.reservePrice;
  // A reserve is the seller's word on the whole pool. A part at or above it leaves them the rest as well.
  if (reserve != null && reserve > 0 && price >= reserve) return { error: null, offer, price, agreed: "reserve" as const, noteIds: unique } as const;
  const asked = await partAsked(offer);
  const approved =
    asked != null &&
    sameLoans(asked, unique) &&
    askedPriceStands(offer.sellerAskedAmount, price) &&
    askedPriceStands(offer.sellerApprovedAmount, price) &&
    !offer.sellerDeclined &&
    Boolean(offer.sellerAnsweredAt && offer.sellerAskedAt && offer.sellerAnsweredAt >= offer.sellerAskedAt);
  return { error: null, offer, price, agreed: approved ? ("approved" as const) : null, noteIds: unique } as const;
}

// What part of a pool sells for: the buyer's loan prices for those loans, to the cent.
export function partPrice(prices: LoanPrices, noteIds: readonly string[]) {
  return Math.round(sumPrices(prices, noteIds) * 100) / 100;
}

function sameLoans(a: readonly string[], b: readonly string[]) {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((noteId) => left.has(noteId));
}

// A question to the seller about part of a pool names the loans, on the bid's sellerAskedNoteIds, which every new
// question rewrites. The audit log keeps the record too, keyed to the moment of the question, and is how a question
// asked before the field existed is still read.
const PART_ASK = "SELLER_ASKED_PART";

async function recordPartAsk(inquiryId: string, askedAt: Date, noteIds: string[], actorId: string | null) {
  // Written whole, not through audit(), which trims the detail: a large part can't lose loans off the end.
  await prisma.auditEvent.create({
    data: { actorId, action: PART_ASK, entityType: "inquiry", entityId: inquiryId, detail: `asked ${askedAt.toISOString()} · ${noteIds.length} loan${noteIds.length === 1 ? "" : "s"} · ${noteIds.join(",")}` },
  });
}

export function readPartAsk(detail: string) {
  const match = /^asked (\S+) · \d+ loans? · (.+)$/.exec(detail);
  return match ? { at: match[1], noteIds: match[2].split(",").filter(Boolean) } : null;
}

// The loans the seller is being asked about, when the open question is about part of the pool. Null for a question
// about the whole bid, or no question.
export async function partAsked(offer: { id: string; sellerAskedAt: Date | null; sellerAskedNoteIds?: string[] | null }) {
  if (!offer.sellerAskedAt) return null;
  // askSeller is the one writer of sellerAskedAt, and it sets the loans in the same write, empty for the whole bid.
  if (offer.sellerAskedNoteIds?.length) return offer.sellerAskedNoteIds;
  const at = offer.sellerAskedAt.toISOString();
  const rows = await prisma.auditEvent.findMany({ where: { entityId: offer.id, action: PART_ASK }, orderBy: { createdAt: "desc" }, take: 10, select: { detail: true } });
  for (const row of rows) {
    const ask = readPartAsk(row.detail);
    if (ask && ask.at === at) return ask.noteIds;
  }
  return null;
}

// The part's price as the bid stands now, so an answer to the old figure can't sell at a new one.
export function askedPartPrice(offer: { amount: number | null; loanPrices?: unknown; buyerId: string; messages: OfferMoney[] }, noteIds: readonly string[]) {
  const prices = standingLoanPrices(offer.loanPrices, buyerPrice(offer.amount, offer.messages, offer.buyerId));
  return prices && noteIds.every((noteId) => prices[noteId] != null) ? partPrice(prices, noteIds) : null;
}

// Where the seller of record answers. A broker who filed the listing answers from the deal page, and a buyer
// reselling a note they hold answers from their resale page, since seller pages are closed to buyers.
export function sellerPage(listing: { id: string; sellerId: string; brokerId: string | null }, sellerRole: string) {
  if (listing.brokerId && listing.brokerId === listing.sellerId) return `/broker/deals/${listing.id}`;
  if (sellerRole === "BUYER") return `/buyer/resales/${listing.id}`;
  return `/seller/listings/${listing.id}`;
}

// A question about part of a pool passes the loans, and the seller is told the rest stays on the book.
export async function askSeller(offer: Offer, price: number, part?: { noteIds: string[]; actorId: string | null }) {
  const askedAt = new Date();
  await prisma.inquiry.update({
    where: { id: offer.id },
    data: { sellerAskedAt: askedAt, sellerAskedAmount: price, sellerAnsweredAt: null, sellerDeclined: null, sellerAskedNoteIds: part ? part.noteIds : [] },
  });
  if (part) await recordPartAsk(offer.id, askedAt, part.noteIds, part.actorId);
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}${sellerPage(offer.listing, offer.listing.seller.role)}`;
  await notify(
    offer.listing.seller.email,
    `Approve a sale · ${offer.listing.title}`,
    part
      ? `The desk recommends selling ${part.noteIds.length} loan${part.noteIds.length === 1 ? "" : "s"} of the pool for ${dollars(price)} to a verified buyer, at the buyer's own loan prices. The other loans stay on the book. Nothing is sold until you approve. Approve or decline here: ${link}`
      : `The desk recommends accepting $${price.toLocaleString("en-US")} from a verified buyer${offer.noteId ? " for one loan" : ""}. Nothing is sold until you approve. Approve or decline here: ${link}`,
  );
}

// The award: the loan or listing goes into contract, the closing opens, and the other bids close. It refuses
// without the seller's agreement, whatever path called it. The desk's and the seller's awards pass backups, so the
// next two bids on the same loans are asked to stand as backup rather than closing (lib/backup-bids.ts).
export async function awardOffer(inquiryId: string, actorId: string, options: { backups?: boolean } = {}) {
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
  // The next best bids on the same loans are asked to stand as backup, and stay live while they answer.
  const keep = options.backups
    ? await import("@/lib/backup-bids").then((backups) =>
        backups.askBackups({ id: offer.id, listingId: offer.listingId, noteId: offer.noteId, buyerId: offer.buyerId, price, buyNow, title: offer.listing.title, closingId: closing.id }),
      )
    : [];
  const declined = await declineLosingBids({ id: offer.id, listingId: offer.listingId, noteId: offer.noteId, price, buyNow, keep }, offer.listing.title);
  // The seller reads every review comment, so the bidder stays out of it. The audit log keeps the name.
  await prisma.reviewComment.create({
    data: { listingId: offer.listingId, authorId: actorId, action: "COMMENT", comment: "An offer was accepted. The closing checklist is open." },
  });
  await audit(
    actorId,
    "AWARD",
    "inquiry",
    offer.id,
    `${offer.listing.title} · ${offer.buyer.name} · ${AGREED_AS[check.agreed]}${declined ? ` · ${declined} other bid${declined === 1 ? "" : "s"} declined` : ""}${keep.length ? ` · ${keep.length} kept live as backup` : ""}`,
  );
  // The purchase agreement goes out now, so every party's hours to sign run from the award. It never fails the award.
  await import("@/lib/signatures").then((signatures) => signatures.sendOnAward(closing.id)).catch((error) => console.error("[upb-signatures] send at award failed:", error));
  return { error: null, closingId: closing.id, declined, price } as const;
}

const AGREED_AS = {
  buyNow: "at the seller's buy-it-now price, agreed in advance",
  reserve: "within the seller's reserve",
  approved: "approved by the seller",
} as const;

// Part of a pool to a buyer who priced each loan and allowed it: those loans go into contract one by one, as a
// one-loan award takes its loan, a closing opens for them at the buyer's loan prices, and the listing stays live for
// the rest. Bids that can still win another loan stay open. It refuses without the seller's agreement to that part.
export async function awardPartial(inquiryId: string, noteIds: string[], actorId: string) {
  const check = await checkAward(inquiryId, { noteIds });
  if (check.error !== null) return check;
  if (!("noteIds" in check)) return { error: "That offer can't be split." } as const;
  const { offer, price } = check;
  const loans = check.noteIds;
  if (!check.agreed) return { error: "The seller hasn't approved this price for these loans." } as const;
  const won = await prisma.inquiry.updateMany({
    where: { id: offer.id, status: { in: [...LIVE] }, OR: [...unset("expiresAt").OR, { expiresAt: { gt: new Date() } }] },
    data: { status: "ACCEPTED", amount: price },
  });
  if (won.count !== 1) return { error: "That offer was decided a moment ago." } as const;
  // Each loan is claimed the way a one-loan award claims its loan. A loser puts back what it took.
  const claimed: string[] = [];
  const release = async () => {
    if (claimed.length) await prisma.note.updateMany({ where: { id: { in: claimed }, tradeStatus: "IN_CONTRACT" }, data: { tradeStatus: "AVAILABLE" } });
    await prisma.inquiry.update({ where: { id: offer.id }, data: { status: offer.status, amount: offer.amount } });
  };
  for (const noteId of loans) {
    if (!(await claimLoan(noteId))) {
      await release();
      return { error: "A loan in that part went into contract a moment ago. Check its open closing." } as const;
    }
    claimed.push(noteId);
  }
  // A whole-listing award that claimed the listing first wins, and these loans go back.
  const listing = await prisma.listing.findUnique({ where: { id: offer.listingId }, select: { status: true, _count: { select: { notes: true } } } });
  if (listing?.status !== "APPROVED") {
    await release();
    return { error: "The whole listing went into contract a moment ago." } as const;
  }
  const closing = await openClosing({ listingId: offer.listingId, inquiryId: offer.id, noteId: null, noteIds: loans, salePrice: price, title: offer.listing.title });
  const { emitWebhook } = await import("@/lib/webhooks");
  await emitWebhook(offer.listing.sellerId, "offer.accepted", { inquiryId: offer.id, listingId: offer.listingId, closingId: closing.id, amount: price, noteIds: loans });
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closing.id}`;
  const part = `${loans.length} of the ${listing._count.notes} loans`;
  await notify(
    offer.buyer.email,
    `Part of your pool bid accepted · ${offer.listing.title}`,
    `Your bid was accepted for ${part}, at your loan prices: ${dollars(price)} in all. The closing checklist is open: ${link}`,
  );
  await notify(
    offer.listing.seller.email,
    `Part of the pool sold · ${offer.listing.title}`,
    `${offer.buyer.name}'s bid was accepted for ${part} at ${dollars(price)}. The other loans stay on the book. Closing checklist: ${link}`,
  );
  const declined = await declineLosingBids({ id: offer.id, listingId: offer.listingId, noteId: null, noteIds: loans, price }, offer.listing.title);
  await prisma.reviewComment.create({
    data: { listingId: offer.listingId, authorId: actorId, action: "COMMENT", comment: `Part of the pool was sold: ${part}. The closing checklist is open, and the other loans stay on the book.` },
  });
  await audit(
    actorId,
    "AWARD_PARTIAL",
    "inquiry",
    offer.id,
    `${offer.listing.title} · ${offer.buyer.name} · ${part} at ${dollars(price)} · ${AGREED_AS[check.agreed]}${declined ? ` · ${declined} other bid${declined === 1 ? "" : "s"} declined` : ""}`,
  );
  await import("@/lib/signatures").then((signatures) => signatures.sendOnAward(closing.id)).catch((error) => console.error("[upb-signatures] send at award failed:", error));
  return { error: null, closingId: closing.id, declined, price, noteIds: loans } as const;
}

export type CombinationPick = { bidId: string; kind: "whole" | "part" | "loan"; noteIds: string[] };

export type ComponentOutcome = {
  bidId: string;
  kind: CombinationPick["kind"];
  noteIds: string[];
  result: "awarded" | "asked" | "failed";
  closingId?: string;
  error?: string;
};

// The optimiser's combination, award by award in order. Each one runs every check a single award does. One the
// seller hasn't agreed to goes to the seller first, and one that fails says why, without stopping the rest.
export async function awardCombination(picks: CombinationPick[], actorId: string) {
  const outcomes: ComponentOutcome[] = [];
  for (const pick of picks) {
    const base = { bidId: pick.bidId, kind: pick.kind, noteIds: pick.noteIds };
    const part = pick.kind === "part" ? { noteIds: pick.noteIds } : undefined;
    const check = await checkAward(pick.bidId, part);
    if (check.error !== null) {
      outcomes.push({ ...base, result: "failed", error: check.error });
      continue;
    }
    if (!check.agreed) {
      // The same question already waiting on the seller isn't sent again.
      const asked = await partAsked(check.offer);
      const waiting = awaitingSeller(check.offer) && askedPriceStands(check.offer.sellerAskedAmount, check.price) && (part ? asked != null && sameLoans(asked, pick.noteIds) : asked == null);
      if (!waiting) {
        await askSeller(check.offer, check.price, part ? { noteIds: pick.noteIds, actorId } : undefined);
        await audit(actorId, "SELLER_ASKED", "inquiry", pick.bidId, `${check.offer.listing.title} · ${dollars(check.price)}${part ? ` for ${pick.noteIds.length} loan${pick.noteIds.length === 1 ? "" : "s"}` : ""}`);
      }
      outcomes.push({ ...base, result: "asked" });
      continue;
    }
    const result = part ? await awardPartial(pick.bidId, pick.noteIds, actorId) : await awardOffer(pick.bidId, actorId);
    outcomes.push(result.error === null ? { ...base, result: "awarded", closingId: result.closingId } : { ...base, result: "failed", error: result.error });
  }
  return outcomes;
}

// A counter moves the bid's total, so the loan prices under it no longer add up and they clear. A buyer naming their
// own price may price each loan again with it. Returns what to write once the counter lands.
export async function counterLoanPrices(input: {
  inquiry: { listingId: string; noteId: string | null; loanPrices: unknown };
  amount: number;
  prices: LoanPrices | null;
  allowPartial: boolean;
}) {
  if (input.prices) {
    const listing = await prisma.listing.findUnique({ where: { id: input.inquiry.listingId }, select: { kind: true, notes: { select: { id: true } } } });
    if (input.inquiry.noteId || listing?.kind !== "POOL") return { error: "Loan prices go with a bid on a whole pool." } as const;
    const problem = loanPriceProblem({ prices: input.prices, loanIds: listing.notes.map((note) => note.id), amount: input.amount });
    if (problem) return { error: problem } as const;
    return { error: null, data: { loanPrices: input.prices, allowPartial: input.allowPartial }, cleared: false } as const;
  }
  if (input.inquiry.loanPrices == null) return { error: null, data: null, cleared: false } as const;
  // A Json field takes null on MongoDB; { unset: true } would be stored as an object.
  return { error: null, data: { loanPrices: null, allowPartial: null }, cleared: true } as const;
}

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
    // Watchers hear that a price is there, not what it is: on the free desk the price is veiled like the ask.
    if (listing.status === "APPROVED") {
      await notifyWatchers({
        listingId,
        event: "BUY_NOW",
        subject: `Buy it now available · ${listing.title}`,
        body: `${listing.title}, a listing you saved, has a buy-it-now price. The first verified buyer who confirms it buys ${pool ? "the whole pool" : "the note"}.`,
        except: [actorId],
      });
    }
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
    { capability: "sealedBids" },
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
  // A counter is a price for the whole bid, which a question about part of the pool isn't.
  if (await partAsked(offer)) return { error: "The desk asked about part of the pool, which can't be countered. Approve or decline it, and the desk can ask again." } as const;
  if (offer.listing.status !== "APPROVED") return { error: "This listing isn't live right now, so you can't counter." } as const;
  if (bidExpired(offer.expiresAt, now)) return { error: "That bid passed its good-until date, so there is nothing to counter." } as const;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return { error: "Enter your counter in dollars." } as const;
  const current = buyerPrice(offer.amount, pricedMessages(offer.messages), offer.buyerId);
  if (current != null && amount <= current + 0.005) return { error: "A counter is above the buyer's bid. To sell at their price, approve it." } as const;
  // The counter is for the whole pool, so loan prices under the old total clear. The buyer can price again on answering.
  const answered = await prisma.inquiry.updateMany({
    where: sameQuestion(offer),
    data: {
      sellerCounterAmount: amount,
      sellerCounteredAt: now,
      sellerApprovedAmount: amount,
      sellerAnsweredAt: now,
      sellerDeclined: false,
      ...(offer.loanPrices != null ? { loanPrices: null, allowPartial: null } : {}),
    },
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
    `The seller countered your bid at ${dollars(amount)}. The seller has already agreed to that price, so if you accept it the desk can award it without asking again.${offer.loanPrices != null ? " Your loan prices were cleared with the counter, so price each loan again when you answer if the seller may take part of the pool." : ""} You can also leave your bid as it is: ${link}`,
  );
  await notifyDesk(
    `Seller countered · ${title}`,
    `The seller answered ${dollars(asked)} with a counter at ${dollars(amount)}. It's posted to the buyer. If they accept, it can be awarded without asking the seller again.`,
    { capability: "sealedBids" },
  );
  return { error: null, amount } as const;
}

// The seller asks the desk to award a bid of their choosing, which need not be the one the desk recommended. It
// records their agreement to that bid's price as it stands, the way an approval does, so the award's checks pass on
// it and the desk awards as usual. A bid sealed from the seller can't be picked, and one the desk asked them about is
// answered where it waits. The same loans sell once, so a pick replaces an earlier pick on bids that can't both win,
// and a recommendation waiting on one of those is declined.
export async function sellerPickBid(input: { inquiryId: string; sellerId: string; price: number; now?: Date }) {
  const now = input.now ?? new Date();
  const offer = await prisma.inquiry.findUnique({ where: { id: input.inquiryId }, include: { listing: true, messages: true, buyer: { select: { name: true } } } });
  if (!offer || offer.listing.sellerId !== input.sellerId) return { error: "That bid isn't on your listing." } as const;
  if (offer.type !== "OFFER" || (offer.status !== "OPEN" && offer.status !== "REVIEWED")) return { error: "That bid is no longer open." } as const;
  if (offer.listing.status !== "APPROVED") return { error: "This listing isn't live right now, so you can't pick a bid." } as const;
  if (sealedFromSeller(offer.listing, now)) return { error: "Bids are sealed until the deadline, so you can pick one once it passes." } as const;
  if (bidExpired(offer.expiresAt, now)) return { error: "That bid passed its good-until date, so it can't be awarded." } as const;
  if (awaitingSeller(offer)) return { error: "The desk asked you about this bid. Approve, decline or counter it where it waits." } as const;
  const price = buyerPrice(offer.amount, pricedMessages(offer.messages), offer.buyerId);
  if (!price || price <= 0) return { error: "That bid has no amount." } as const;
  // The seller binds to the figure they saw. A change since the page loaded asks them to look again.
  if (!askedPriceStands(input.price, price)) return { error: "The buyer changed this bid since the page loaded. Check the new figure and pick again." } as const;
  // Claimed on the bid as read, so a desk question or an award landing in the same instant wins or loses cleanly.
  const picked = await prisma.inquiry.updateMany({
    where: { id: offer.id, status: { in: [...LIVE] }, ...(offer.sellerAskedAt ? { sellerAskedAt: offer.sellerAskedAt } : unset("sellerAskedAt")) },
    data: { sellerRequestedAt: now, sellerApprovedAmount: price, sellerDeclined: false },
  });
  if (picked.count !== 1) return { error: "This bid changed a moment ago. Reload the page and try again." } as const;
  // Bids that can't both win: the same loan or the whole listing for a loan bid, every other bid for a whole one.
  const rivals = {
    listingId: offer.listingId,
    id: { not: offer.id },
    type: "OFFER" as const,
    status: { in: [...LIVE] },
    ...(offer.noteId ? { OR: [{ noteId: offer.noteId }, ...unset("noteId").OR] } : {}),
  };
  const replaced = await prisma.inquiry.updateMany({ where: { ...rivals, sellerRequestedAt: { not: null } }, data: { sellerRequestedAt: null, sellerApprovedAmount: null } });
  const asked = await prisma.inquiry.findMany({ where: { ...rivals, sellerAskedAt: { not: null } }, select: { id: true, sellerAskedAt: true, sellerAnsweredAt: true, sellerAskedAmount: true } });
  let declined = 0;
  for (const row of asked.filter(awaitingSeller)) {
    const answered = await prisma.inquiry.updateMany({ where: sameQuestion(row), data: { sellerAnsweredAt: now, sellerDeclined: true } });
    if (answered.count !== 1) continue;
    declined += 1;
    await audit(input.sellerId, "SELLER_DECLINED", "inquiry", row.id, `${offer.listing.title} · ${dollars(Number(row.sellerAskedAmount ?? 0))} · picked another bid`);
  }
  const scope = offer.noteId ? "one loan" : "the whole listing";
  await audit(
    input.sellerId,
    "SELLER_PICKED",
    "inquiry",
    offer.id,
    `${offer.listing.title} · ${dollars(price)} for ${scope} · the seller agrees to sell at this price${replaced.count ? ` · replaces an earlier pick` : ""}${declined ? ` · declined ${declined} recommended bid${declined === 1 ? "" : "s"}` : ""}`,
  );
  const alias = await bidderAlias(offer.listingId, offer.buyerId);
  const wait = offer.listing.bidMode !== "NONE" && !deadlinePassed(offer.listing.bidDeadline, now) ? " It can be awarded after the bid deadline." : "";
  await notifyDesk(
    `Seller picked a bid · ${offer.listing.title}`,
    `The seller asked the desk to award ${offer.buyer.name}'s bid (${alias} to the seller) of ${dollars(price)} for ${scope}, and agreed to sell at that price. Award it from the offer book.${wait}${declined ? " The seller declined the bid the desk recommended." : ""}`,
    { capability: "sealedBids" },
  );
  return { error: null, price, alias, declined } as const;
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
  // Bidders hear through their own bid, so the watcher notice below skips them.
  const bidders = await prisma.inquiry.findMany({ where: { listingId, type: "OFFER", status: { in: [...LIVE] } }, select: { buyerId: true } });
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
  await notifyWatchers({
    listingId,
    event: "WITHDRAWN",
    subject: `Listing withdrawn · ${listing.title}`,
    body: `${listing.title}, a listing you saved, was withdrawn. It is off the book and takes no bids.`,
    except: [actorId, ...bidders.map((bid) => bid.buyerId)],
  });
  return { error: null, declined } as const;
}
