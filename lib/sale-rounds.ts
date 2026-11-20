import { canManageRoom, isPrivateDocument } from "@/lib/acl";
import { deadlinePassed, deskWalled } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { bidderNamer } from "@/lib/bidder-alias";
import { unset } from "@/lib/db-filters";
import { deskCan } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { onGroupDeclined } from "@/lib/group-events";
import { buyerPrice } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { readUtc, when } from "@/lib/sale-events";

// A two-round sale, as bank and agency sales run: indicative bids by one date, a shortlist the seller and the desk
// choose from them, then binding final bids from the shortlist by the listing's bid deadline. Round one is a sealed
// round like any other, but its bids are indicative: they bind nobody and never become an award, a deposit or a
// closing. A file marked final round only opens to a bidder once their firm is shortlisted. A listing without a
// round-one date, or not on sealed bids, runs one round as before. A sale event runs its own two dates
// (lib/sale-events.ts), so a listing in one never runs these rounds as well.

const DAY = 24 * 60 * 60 * 1000;
const LIVE = ["OPEN", "REVIEWED"] as const;

// Days between the round-one date and the final deadline, so there is time to choose a shortlist and to bid.
export const ROUND_GAP_DAYS = 2;
export const INDICATIVE_LABEL = "Indicative, non-binding";
export const FINAL_LABEL = "Final bid";
export const INDICATIVE_REFUSED = "This is an indicative bid from round one. It isn't binding, so it can't be awarded or picked. Awards come from final-round bids.";
export const NOT_SHORTLISTED = "Only the bidders the seller shortlisted from round one bid in the final round.";
export const GROUPS_NOT_IN_ROUNDS = "Groups don't bid in a two-round sale. Each firm bids for itself in round one and, if shortlisted, in the final round.";
export const INDICATIVE_CLOSED = "Round one has closed, so this indicative bid stands as it was. If you're shortlisted, place a final bid from the listing.";
export const DESK_NOT_IN_ROUNDS = "The desk book doesn't bid in a two-round sale: only shortlisted buyers' final bids are awarded.";

// Statuses in which a listing's bid terms can still change, as in setAuction.
const TERMS_OPEN = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"];

export type RoundListing = {
  bidMode: string;
  bidDeadline: Date | null;
  roundOneEndsAt?: Date | null;
  shortlistedAt?: Date | null;
  saleEventId?: string | null;
};

type Actor = { id: string; role: string; deskRole?: string | null };

const ROUND_FIELDS = { id: true, title: true, status: true, sellerId: true, brokerId: true, bidMode: true, bidDeadline: true, roundOneEndsAt: true, shortlistedAt: true, saleEventId: true } as const;

// Whether the listing runs two rounds now. Its sealed terms and both dates must still stand in order, so a seller who
// later moves the deadline before the round-one date, or opens the bidding, is back to one round.
export function twoRounds(listing: RoundListing): listing is RoundListing & { roundOneEndsAt: Date; bidDeadline: Date } {
  return (
    listing.bidMode === "SEALED" &&
    !listing.saleEventId &&
    listing.roundOneEndsAt != null &&
    listing.bidDeadline != null &&
    listing.roundOneEndsAt.getTime() < listing.bidDeadline.getTime()
  );
}

export type RoundStage = "ONE" | "SHORTLIST" | "FINAL" | "ENDED";

// Where a two-round sale stands: round one open, the shortlist being chosen, the final round open, or over.
export function roundStage(listing: RoundListing, now = new Date()): RoundStage | null {
  if (!twoRounds(listing)) return null;
  if (!deadlinePassed(listing.roundOneEndsAt, now)) return "ONE";
  if (deadlinePassed(listing.bidDeadline, now)) return "ENDED";
  return listing.shortlistedAt ? "FINAL" : "SHORTLIST";
}

// The round a bid is in. A bid written without one, such as a group's, is placed by when it came in.
export function roundOf(bid: { round?: number | null; createdAt?: Date | null }, listing: RoundListing) {
  if (bid.round === 1 || bid.round === 2) return bid.round;
  if (!twoRounds(listing) || !bid.createdAt) return null;
  return bid.createdAt.getTime() < listing.roundOneEndsAt.getTime() ? 1 : 2;
}

export function roundLabel(round: number | null | undefined) {
  return round === 1 ? INDICATIVE_LABEL : round === 2 ? FINAL_LABEL : null;
}

// "Indicative bids due Dec 4, 2026, 17:00 UTC · final bids from the shortlist due Dec 12, 2026, 17:00 UTC".
export function roundsLine(listing: RoundListing) {
  if (!twoRounds(listing)) return null;
  return `Indicative bids due ${when(listing.roundOneEndsAt)} · final bids from the shortlist due ${when(listing.bidDeadline)}`;
}

// A seat bids as its firm, so a seat's own id reads as the firm's.
export async function firmIdOf(userId: string) {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { principalId: true } });
  return row?.principalId || userId;
}

// Whether any of the firm's round-one bids on this listing was shortlisted.
export async function firmShortlisted(listingId: string, userId: string) {
  const firmId = await firmIdOf(userId);
  return (await prisma.inquiry.count({ where: { listingId, buyerId: firmId, type: "OFFER", shortlistedAt: { not: null } } })) > 0;
}

// The round a bid written now goes in: 1 before the round-one date, 2 after it. checkOffer has already refused a bid
// that the round doesn't take.
export async function roundForNewBid(listingId: string, now = new Date()) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: ROUND_FIELDS });
  if (!listing || !twoRounds(listing)) return null;
  return deadlinePassed(listing.roundOneEndsAt, now) ? 2 : 1;
}

// For checkOffer: why this buyer can't bid in the round that is open, or null. Round one takes any eligible buyer.
// Between the rounds nobody bids, and in the final round only a shortlisted firm does, through any of its seats.
export async function roundBidBlock(listingId: string, userId: string, now = new Date()) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: ROUND_FIELDS });
  const stage = listing ? roundStage(listing, now) : null;
  if (!listing || !stage || stage === "ONE" || stage === "ENDED") return null;
  if (stage === "SHORTLIST") return `Round one closed ${when(listing.roundOneEndsAt!)}. The seller and the desk are choosing the shortlist for the final round, so no bids go in until it is set.`;
  return (await firmShortlisted(listing.id, userId)) ? null : NOT_SHORTLISTED;
}

// For checkAward and the seller's pick: an indicative bid never wins, and on a two-round sale only a final bid placed
// after the shortlist, by a shortlisted firm, does.
export async function roundAwardBlock(offer: { listingId: string; buyerId: string; round?: number | null; createdAt: Date; listing: RoundListing }) {
  const round = roundOf(offer, offer.listing);
  if (round === 1) return INDICATIVE_REFUSED;
  if (!twoRounds(offer.listing)) return null;
  const { shortlistedAt } = offer.listing;
  if (!shortlistedAt || offer.createdAt.getTime() < shortlistedAt.getTime() || !(await firmShortlisted(offer.listingId, offer.buyerId))) {
    return "This bid isn't a final-round bid from a shortlisted bidder, so it can't be awarded.";
  }
  return null;
}

// A final bid replaces the firm's indicative bid on the same loans, so the seller weighs one bid from each firm and
// the indicative one never reads as a loser.
export async function supersedeIndicative(bid: { id: string; listingId: string; buyerId: string; noteId: string | null }, now = new Date()) {
  const earlier = await prisma.inquiry.findMany({
    where: { listingId: bid.listingId, buyerId: bid.buyerId, type: "OFFER", round: 1, id: { not: bid.id }, status: { in: [...LIVE] }, ...(bid.noteId ? { noteId: bid.noteId } : unset("noteId")) },
    select: { id: true },
  });
  for (const row of earlier) {
    const closed = await prisma.inquiry.updateMany({ where: { id: row.id, status: { in: [...LIVE] } }, data: { status: "WITHDRAWN", withdrawnAt: now } });
    if (closed.count !== 1) continue;
    await prisma.offerMessage.create({ data: { inquiryId: row.id, authorId: bid.buyerId, kind: "NOTE", body: "Replaced by the final-round bid.", createdAt: now } });
    await audit(bid.buyerId, "INDICATIVE_REPLACED", "inquiry", row.id, `Replaced by final bid ${bid.id}`);
  }
  return earlier.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Setting it up. The seller of record, when an institution or a broker, or the sales desk, before any bid is in.

export function canSetRounds(actor: Actor, listing: { sellerId: string; brokerId?: string | null }) {
  if (actor.role === "ADMIN") return deskCan(actor, "sales");
  const own = actor.id === listing.sellerId || (Boolean(listing.brokerId) && actor.id === listing.brokerId);
  return own && (actor.role === "INSTITUTIONAL_SELLER" || actor.role === "BROKER");
}

// The seller of record, the filing broker and the sales desk choose the shortlist and mark the final-round files.
export function canRunRounds(actor: Actor, listing: { sellerId: string; brokerId?: string | null }) {
  return actor.role === "ADMIN" ? deskCan(actor, "sales") : canManageRoom(actor, listing);
}

// Why these dates can't run two rounds, or null. Both in the future, round one first, with the gap between.
export function roundsProblem(input: { roundOneEndsAt: Date | null; bidMode: string; bidDeadline: Date | null; now?: Date }) {
  const now = input.now ?? new Date();
  if (input.bidMode !== "SEALED" || !input.bidDeadline) return "Two rounds run on sealed bids. Set the bid style to sealed, with the final round's deadline, first.";
  if (!input.roundOneEndsAt) return "Enter when indicative bids are due, in UTC.";
  if (input.roundOneEndsAt.getTime() <= now.getTime()) return "Indicative bids have to be due in the future.";
  if (input.bidDeadline.getTime() <= now.getTime()) return "The bid deadline has passed. Set a new final deadline first.";
  if (input.bidDeadline.getTime() - input.roundOneEndsAt.getTime() < ROUND_GAP_DAYS * DAY) {
    return `Indicative bids have to be due at least ${ROUND_GAP_DAYS} days before the final deadline, so there is time to choose the shortlist and bid again.`;
  }
  return null;
}

export async function setSaleRounds(actor: Actor, input: { listingId: string; on: boolean; roundOneEndsAt?: unknown; now?: Date }) {
  const now = input.now ?? new Date();
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { ...ROUND_FIELDS, seller: { select: { role: true } } } });
  if (!listing) return { error: "That listing isn't yours to change." } as const;
  if (!canSetRounds(actor, listing)) {
    const own = actor.id === listing.sellerId || actor.id === listing.brokerId;
    if (actor.role === "ADMIN") return { error: "Two-round sales are set by the sales side of the desk." } as const;
    return { error: own ? "Two rounds are for institutional sellers and brokers. The desk can set them up for you." : "That listing isn't yours to change." } as const;
  }
  if (!TERMS_OPEN.includes(listing.status)) return { error: "Bid terms are fixed once a listing is in contract, sold, or declined." } as const;
  if (listing.saleEventId) return { error: "This listing is in a sale event, which runs its own two rounds." } as const;
  // Any bid at all locks the rounds, withdrawn ones too: a bidder bid on the terms as they stood.
  if ((await prisma.inquiry.count({ where: { listingId: listing.id, type: "OFFER" } })) > 0) {
    return { error: "Bids are in, so the rounds stay as they are until this sale ends." } as const;
  }
  if (!input.on) {
    if (!listing.roundOneEndsAt) return { error: null, on: false, unchanged: true } as const;
    await prisma.listing.update({ where: { id: listing.id }, data: { roundOneEndsAt: null, shortlistedAt: null } });
    await audit(actor.id, "SALE_ROUNDS", "listing", listing.id, "One round");
    return { error: null, on: false, unchanged: false } as const;
  }
  const roundOneEndsAt = readUtc(String(input.roundOneEndsAt ?? ""));
  const problem = roundsProblem({ roundOneEndsAt, bidMode: listing.bidMode, bidDeadline: listing.bidDeadline, now });
  if (problem || !roundOneEndsAt || !listing.bidDeadline) return { error: problem ?? "Enter when indicative bids are due, in UTC." } as const;
  if (listing.roundOneEndsAt?.getTime() === roundOneEndsAt.getTime()) return { error: null, on: true, unchanged: true, roundOneEndsAt, bidDeadline: listing.bidDeadline } as const;
  // Written on the terms as read, so a deadline or style change landing first asks for a reload.
  const saved = await prisma.listing.updateMany({
    where: { id: listing.id, bidMode: "SEALED", bidDeadline: listing.bidDeadline },
    data: { roundOneEndsAt, shortlistedAt: null },
  });
  if (saved.count !== 1) return { error: "The bid terms changed a moment ago. Reload the page and try again." } as const;
  await audit(actor.id, "SALE_ROUNDS", "listing", listing.id, `Two rounds · indicative bids due ${roundOneEndsAt.toISOString()} · final bids due ${listing.bidDeadline.toISOString()}`);
  return { error: null, on: true, unchanged: false, roundOneEndsAt, bidDeadline: listing.bidDeadline } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Round one's bids, as the seller and the desk read them to choose the shortlist.

// The price an indicative bid stood at when round one closed. A buyer can still post a price on it later, but the
// shortlist is chosen on the bids as they were in, and an indicative bid never sells.
function priceAtClose(bid: { amount: number | null; buyerId: string; messages: { kind: string; amount: number | null; createdAt: Date; authorId: string }[] }, closedAt: Date) {
  return buyerPrice(bid.amount, bid.messages.filter((message) => message.createdAt.getTime() < closedAt.getTime()), bid.buyerId);
}

export type RoundOneRow = { id: string; buyerId: string; bidder: string; scope: string; price: number | null; status: string; live: boolean; shortlisted: boolean; buyerEntityId: string | null };

// The seller sees amounts once round one ends; until then each bid shows by its bidder's letter only, as sealed bids
// do. The desk reads them behind its own wall, as it reads any sealed bid. Null for anyone else.
export async function roundOneBook(listingId: string, viewer: Actor, now = new Date()) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: {
      ...ROUND_FIELDS,
      inquiries: {
        where: { type: "OFFER" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, buyerId: true, noteId: true, amount: true, status: true, round: true, createdAt: true, shortlistedAt: true, buyerEntityId: true,
          buyer: { select: { id: true, name: true, companyName: true } },
          messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } },
        },
      },
    },
  });
  if (!listing || !twoRounds(listing)) return null;
  const desk = viewer.role === "ADMIN";
  if (!desk && !canManageRoom(viewer, listing)) return null;
  const stage = roundStage(listing, now)!;
  const sealed = desk ? deskWalled(listing, viewer, now) : !deadlinePassed(listing.roundOneEndsAt, now);
  const nameOf = await bidderNamer(listing.id, viewer);
  const loans = await prisma.note.findMany({ where: { listingId: listing.id }, select: { id: true, city: true, state: true } });
  const placeOf = new Map(loans.map((loan) => [loan.id, `${loan.city}, ${loan.state}`]));
  const roundOne = listing.inquiries.filter((bid) => roundOf(bid, listing) === 1);
  const rows: RoundOneRow[] = roundOne.map((bid) => ({
    id: bid.id,
    buyerId: bid.buyerId,
    bidder: nameOf(bid.buyer),
    scope: bid.noteId ? `Loan in ${placeOf.get(bid.noteId) ?? "the pool"}` : "Whole listing",
    price: sealed ? null : priceAtClose(bid, listing.roundOneEndsAt),
    status: bid.status,
    live: (LIVE as readonly string[]).includes(bid.status),
    shortlisted: Boolean(bid.shortlistedAt),
    buyerEntityId: bid.buyerEntityId,
  }));
  if (!sealed) rows.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  const finalBids = listing.inquiries.filter((bid) => roundOf(bid, listing) === 2 && (LIVE as readonly string[]).includes(bid.status)).length;
  return { listing, stage, sealed, rows, finalBids };
}

export type RoundOneBook = NonNullable<Awaited<ReturnType<typeof roundOneBook>>>;

// ---------------------------------------------------------------------------------------------------------------
// The shortlist.

function listingLink(listingId: string) {
  return `${process.env.NEXT_PUBLIC_APP_URL || ""}/marketplace/${listingId}`;
}

// The notices, apart from the sending, so their words can be checked. Neither names an amount or another bidder.
// Counsel: that an indicative bid binds nobody, and that a bidder left off the shortlist owes nothing, is UPB's reading
// of how these sales run; counsel to confirm the wording beside the purchase agreement.
export function shortlistNotice(input: { title: string; bidDeadline: Date; listingId: string }) {
  return {
    subject: `Final round · ${input.title}`,
    body: `You're in the final round on ${input.title}. Final bids are due ${when(input.bidDeadline)}; the final-round files are open to you. Your indicative bid wasn't binding, so your final bid can be higher or lower. The final bid binds under the usual rules: the deposit, any covenants, and your verified funds. ${listingLink(input.listingId)}`,
  };
}

export function notShortlistedNotice(input: { title: string }) {
  return {
    subject: `Shortlist decided · ${input.title}`,
    body: `Thank you for your indicative bid on ${input.title}. The final round is open to a shortlist of bidders, and your firm isn't on it this time, so your indicative bid is closed. Indicative bids aren't binding, so nothing is owed.`,
  };
}

// After round one ends and before the final deadline, the seller or the sales desk picks round-one bids to go
// forward, once. A firm is in when any of its bids is picked. Every other round-one bid closes, and each bidder hears
// whether they are in, with no amount and no other bidder named.
export async function setShortlist(actor: Actor, input: { listingId: string; inquiryIds: string[]; now?: Date }) {
  const now = input.now ?? new Date();
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { ...ROUND_FIELDS, seller: { select: { email: true } } } });
  if (!listing || !canRunRounds(actor, listing)) return { error: "That listing isn't yours to decide." } as const;
  const stage = roundStage(listing, now);
  if (!stage) return { error: "This listing runs one round, so there is no shortlist." } as const;
  if (listing.shortlistedAt) return { error: "The shortlist is already set." } as const;
  if (stage === "ONE") return { error: `Round one runs until ${when(listing.roundOneEndsAt!)}. Choose the shortlist once it closes.` } as const;
  if (stage === "ENDED") return { error: "The final deadline has passed without a shortlist, so this sale ended with no award." } as const;
  if (listing.status !== "APPROVED") return { error: "This listing isn't live, so there is no final round to choose." } as const;
  const ids = [...new Set(input.inquiryIds.filter(Boolean))];
  if (!ids.length) return { error: "Choose at least one bidder for the final round." } as const;
  const bids = await prisma.inquiry.findMany({
    where: { listingId: listing.id, type: "OFFER", status: { in: [...LIVE] } },
    select: { id: true, buyerId: true, round: true, createdAt: true, buyer: { select: { email: true } } },
  });
  const roundOne = bids.filter((bid) => roundOf(bid, listing) === 1);
  const chosen = roundOne.filter((bid) => ids.includes(bid.id));
  if (chosen.length !== ids.length) return { error: "Choose bidders from round one on this listing." } as const;
  // Claimed on the listing as read, so the seller and the desk choosing at once set it once.
  const claimed = await prisma.listing.updateMany({
    where: { id: listing.id, roundOneEndsAt: listing.roundOneEndsAt, bidDeadline: listing.bidDeadline, AND: [unset("shortlistedAt")] },
    data: { shortlistedAt: now },
  });
  if (claimed.count !== 1) return { error: "The shortlist was set a moment ago. Reload the page." } as const;
  await prisma.inquiry.updateMany({ where: { id: { in: chosen.map((bid) => bid.id) } }, data: { shortlistedAt: now } });
  const firms = new Set(chosen.map((bid) => bid.buyerId));
  const out = roundOne.filter((bid) => !firms.has(bid.buyerId));
  const { emitWebhook } = await import("@/lib/webhooks");
  const outEmails = new Set<string>();
  let closed = 0;
  for (const bid of out) {
    const done = await prisma.inquiry.updateMany({ where: { id: bid.id, status: { in: [...LIVE] } }, data: { status: "DECLINED" } });
    if (done.count !== 1) continue;
    closed += 1;
    outEmails.add(bid.buyer.email);
    await onGroupDeclined(bid.id, "The group wasn't shortlisted for the final round, so its indicative bid closed.");
    await emitWebhook(listing.sellerId, "offer.declined", { inquiryId: bid.id, listingId: listing.id, reason: "not_shortlisted" });
  }
  const bidDeadline = listing.bidDeadline!;
  const inEmails = new Set(chosen.map((bid) => bid.buyer.email));
  const yes = shortlistNotice({ title: listing.title, bidDeadline, listingId: listing.id });
  const no = notShortlistedNotice({ title: listing.title });
  for (const email of inEmails) await notify(email, yes.subject, yes.body);
  for (const email of outEmails) if (!inEmails.has(email)) await notify(email, no.subject, no.body);
  const firmCount = new Set(roundOne.map((bid) => bid.buyerId)).size;
  await audit(actor.id, "SHORTLIST", "listing", listing.id, `${firms.size} of ${firmCount} bidder${firmCount === 1 ? "" : "s"} shortlisted · ${closed} indicative bid${closed === 1 ? "" : "s"} closed · final bids due ${bidDeadline.toISOString()}`);
  // The other side hears it in counts. The desk's notice goes to the sales side.
  const line = `It has ${firms.size} of the ${firmCount} bidder${firmCount === 1 ? "" : "s"} from round one. Final bids are due ${when(bidDeadline)}.`;
  if (actor.role === "ADMIN") await notify(listing.seller.email, `Shortlist set · ${listing.title}`, `The desk set the shortlist on ${listing.title}. ${line}`);
  else await notifyDesk(`Shortlist set · ${listing.title}`, `The seller set the shortlist. ${line}`, { capability: "sales" });
  return { error: null, shortlisted: firms.size, of: firmCount, closed } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Final-round files.

// Whether a final-round-only file stays shut to this viewer. The flag does nothing on a one-round listing.
export async function finalRoundShut(document: { finalRoundOnly?: boolean | null }, listing: RoundListing & { id: string }, userId: string) {
  if (!document.finalRoundOnly || !twoRounds(listing)) return false;
  return !(await firmShortlisted(listing.id, userId));
}

export async function setFinalRoundOnly(actor: Actor, input: { documentId: string; on: boolean }) {
  const document = await prisma.document.findUnique({
    where: { id: input.documentId },
    select: { id: true, type: true, noteId: true, storedName: true, originalName: true, finalRoundOnly: true, listingId: true, listing: { select: { ...ROUND_FIELDS, authorizationKey: true } } },
  });
  if (!document || !canRunRounds(actor, document.listing)) return { error: "That file isn't on a listing you run." } as const;
  const { listing } = document;
  // Only the room's own files: a signed NDA, a mandate and a loan's own file open by their own rules, and photos show
  // with the listing.
  if (document.type === "PHOTO" || isPrivateDocument(document, listing)) return { error: "That file isn't one bidders open in the data room." } as const;
  if (input.on && !twoRounds(listing)) return { error: "Final-round files are for a two-round sale. Set the two rounds first." } as const;
  if (Boolean(document.finalRoundOnly) === input.on) return { error: null, on: input.on, unchanged: true, listingId: listing.id } as const;
  await prisma.document.update({ where: { id: document.id }, data: { finalRoundOnly: input.on } });
  await audit(actor.id, "FINAL_ROUND_FILE", "listing", listing.id, `${document.originalName} · ${input.on ? "final round only" : "open to every bidder in the room"}`);
  return { error: null, on: input.on, unchanged: false, listingId: listing.id } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// The round as a viewer reads it beside the bid form.

export type RoundState = { stage: RoundStage; title: string; line: string; canBid: boolean; form: "INDICATIVE" | "FINAL" | null; shortlisted: boolean };

export function roundState(input: { stage: RoundStage; roundOneEndsAt: Date; bidDeadline: Date; shortlistedAt: Date | null; shortlisted: boolean; buyer: boolean }): RoundState {
  const base = { stage: input.stage, shortlisted: input.shortlisted, canBid: false, form: null };
  if (input.stage === "ONE") {
    return {
      ...base,
      title: `Round one open: indicative bids due ${when(input.roundOneEndsAt)}`,
      line: `Indicative bids aren't binding. The seller and the desk then choose a shortlist, and only shortlisted bidders place final bids, due ${when(input.bidDeadline)}.`,
      canBid: true,
      form: "INDICATIVE",
    };
  }
  if (input.stage === "SHORTLIST") {
    return { ...base, title: "Shortlist being chosen", line: `Round one closed ${when(input.roundOneEndsAt)}. The seller and the desk are choosing who bids in the final round. Final bids are due ${when(input.bidDeadline)}.` };
  }
  if (input.stage === "ENDED") {
    return input.shortlistedAt
      ? { ...base, title: "Final bids closed", line: `Final bids closed ${when(input.bidDeadline)}. Awards come from the final bids only.` }
      : { ...base, title: "Ended with no award", line: "No shortlist was set before the final deadline, so this sale ended with no award. Indicative bids aren't binding, so nothing is owed." };
  }
  if (input.shortlisted) {
    return {
      ...base,
      title: `You're shortlisted: final bids due ${when(input.bidDeadline)}`,
      line: "The final-round files are open to you in the data room. Your final bid can be higher or lower than your indicative bid, and it binds under the usual rules.",
      canBid: true,
      form: "FINAL",
    };
  }
  if (!input.buyer) return { ...base, title: "Final round open", line: `Shortlisted bidders place final bids by ${when(input.bidDeadline)}.` };
  return { ...base, title: "Not shortlisted", line: NOT_SHORTLISTED };
}

// The listing page's round state for this viewer, or null on a one-round listing.
export async function roundStateFor(listing: RoundListing & { id: string }, viewer: { id: string; role: string }, now = new Date()) {
  const stage = roundStage(listing, now);
  if (!stage || !twoRounds(listing)) return null;
  const buyer = viewer.role === "BUYER";
  const shortlisted = buyer && listing.shortlistedAt ? await firmShortlisted(listing.id, viewer.id) : false;
  return roundState({ stage, roundOneEndsAt: listing.roundOneEndsAt, bidDeadline: listing.bidDeadline, shortlistedAt: listing.shortlistedAt ?? null, shortlisted, buyer });
}
