import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { canManageRoom } from "@/lib/acl";
import { listingActivity } from "@/lib/activity";
import { deskWalled, sealedFromSeller } from "@/lib/auction";
import { bidderNamer } from "@/lib/bidder-alias";
import { closingLoans } from "@/lib/closing";
import { custodyRows } from "@/lib/custody";
import { toCsv } from "@/lib/csv";
import type { Staff } from "@/lib/desk-roles";
import { money, prettyDate } from "@/lib/format";
import { pdfSafe, wrap } from "@/lib/memo-pdf";
import { bidExpired, buyerPrice, type OfferMoney } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { prorationDirection, prorationSummary, readProration } from "@/lib/proration";
import { bidSummary, trackLine } from "@/lib/seller-decisions";
import { deliveringSide, kindLabel, sideWord, trailingStatusLabel } from "@/lib/trailing-docs";
import { vestingNames } from "@/lib/vesting";

// One export of a sale's record, for a bank seller's exam file: every bid with its round, time, good-until date and
// status, the reserve and whether each bid met it, the seller's approvals, counters and declines, the award, the
// declines sent and how the closing ended. Regulators frame a competitive loan sale as an auditable bid record,
// so this is that record in one file. Amounts still behind the desk's sealed wall for this viewer stay blank.

export type SaleFileRow = {
  section: string;
  at: Date | null;
  party: string;
  amount: number | null;
  round: string;
  goodUntil: Date | null;
  status: string;
  reserveMet: string;
  by: string;
  detail: string;
};

const SEALED = "Sealed until the deadline";
const APPROVAL_ACTIONS = ["SELLER_ASKED", "SELLER_ASKED_PART", "SELLER_APPROVED", "SELLER_DECLINED", "SELLER_COUNTERED", "RESERVE", "BUY_NOW_SET", "BUY_NOW_CLEARED"];
const AWARD_ACTIONS = ["AWARD", "AWARD_PARTIAL", "POOL_PLAN", "DESK_BID_ACCEPTED", "MARK_SOLD", "MARK_PENDING"];
// Kick-outs are kept as their own rows too, which the closing outcome reads. The audit entry stands in only when a
// kick-out has no row, such as one recorded before the rows were kept.
const KICKOUT_ACTIONS = ["CLOSING_KICKOUT"];
const DECLINE_SUBJECT = /not selected|declined|withdrawn/i;

const words = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");

export async function saleFile(listingId: string, viewer: Staff, now = new Date()) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      seller: { select: { name: true, companyName: true } },
      notes: { select: { id: true, city: true, state: true } },
      inquiries: {
        where: { type: "OFFER" },
        include: { buyer: { select: { id: true, email: true } }, messages: { orderBy: { createdAt: "asc" } } },
        orderBy: { createdAt: "asc" },
      },
      deskBids: { orderBy: { createdAt: "asc" } },
      closings: { orderBy: { openedAt: "asc" }, include: { kickouts: { orderBy: { createdAt: "asc" } } } },
    },
  });
  if (!listing) return null;
  const walled = deskWalled(listing, viewer, now);
  const event = listing.saleEventId ? await prisma.saleEvent.findUnique({ where: { id: listing.saleEventId } }) : null;
  const inquiryIds = listing.inquiries.map((inquiry) => inquiry.id);
  const closingIds = listing.closings.map((closing) => closing.id);
  const buyerIds = [...new Set(listing.inquiries.map((inquiry) => inquiry.buyerId))];
  const emails = [...new Set(listing.inquiries.map((inquiry) => inquiry.buyer.email))];
  const [names, audits, notices] = await Promise.all([
    vestingNames(buyerIds),
    prisma.auditEvent.findMany({
      where: { entityId: { in: [listing.id, ...inquiryIds, ...closingIds] }, action: { in: [...APPROVAL_ACTIONS, ...AWARD_ACTIONS, ...KICKOUT_ACTIONS, "INQUIRY_DECLINE"] } },
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    emails.length
      ? prisma.notification.findMany({ where: { toEmail: { in: emails }, createdAt: { gte: listing.createdAt } }, select: { toEmail: true, subject: true, delivery: true, createdAt: true }, orderBy: { createdAt: "asc" } })
      : Promise.resolve([]),
  ]);
  const nameOfBuyer = (buyerId: string) => names.get(buyerId) ?? "A buyer";
  // A bid made for one of the buyer's added entities names that entity, an IRA by its account title.
  const entityIds = [...new Set(listing.inquiries.map((inquiry) => inquiry.buyerEntityId).filter((id): id is string => Boolean(id)))];
  const entities = entityIds.length ? await prisma.buyerEntity.findMany({ where: { id: { in: entityIds } }, select: { id: true, name: true, iraAccountTitle: true } }) : [];
  const entityName = new Map(entities.map((entity) => [entity.id, entity.iraAccountTitle || entity.name]));
  const partyOf = (inquiry: { buyerId: string; buyerEntityId?: string | null }) =>
    (inquiry.buyerEntityId ? entityName.get(inquiry.buyerEntityId) : null) ?? nameOfBuyer(inquiry.buyerId);
  const byEmail = new Map(listing.inquiries.map((inquiry) => [inquiry.buyer.email, inquiry.buyerId]));
  const reserve = listing.reservePrice != null ? Number(listing.reservePrice) : null;
  const amount = (value: number | null | undefined) => (walled || value == null ? null : Number(value));
  const met = (price: number | null) => (walled ? "" : reserve == null ? "No reserve" : price == null ? "" : price >= reserve ? "Yes" : "No");
  // A bid's round: in a sale event, indications before the first date and best and final after it. Otherwise
  // the terms the listing ran under.
  const roundOf = (at: Date) =>
    event
      ? at.getTime() < event.indicationsAt.getTime() ? "Indication" : "Best and final"
      : listing.bidMode === "SEALED" ? "Sealed" : listing.bidMode === "BEST_AND_FINAL" ? "Best and final" : "Open offer";
  const loan = (noteId: string | null) => {
    const note = noteId ? listing.notes.find((item) => item.id === noteId) : null;
    return note ? `Loan in ${note.city}, ${note.state}` : "Whole listing";
  };
  // The loans a closing covers, read through noteIds, so a part-pool closing never reads as the whole listing.
  const scope = (closing: (typeof listing.closings)[number]) => {
    const loans = closingLoans(closing, listing.notes);
    if (loans.length === listing.notes.length) return "Whole listing";
    return loans.length === 1 ? loan(loans[0].id) : `${loans.length} of ${listing.notes.length} loans`;
  };
  const kickActors = [...new Set(listing.closings.flatMap((closing) => closing.kickouts.map((kick) => kick.actorId)))];
  const people = new Map(
    kickActors.length ? (await prisma.user.findMany({ where: { id: { in: kickActors } }, select: { id: true, name: true } })).map((person) => [person.id, person.name] as const) : [],
  );
  const rows: SaleFileRow[] = [];
  const row = (input: Partial<SaleFileRow> & { section: string }) =>
    rows.push({ at: null, party: "", amount: null, round: "", goodUntil: null, status: "", reserveMet: "", by: "", detail: "", ...input });

  row({ section: "Listing", at: listing.approvedAt, party: listing.seller.companyName || listing.seller.name, status: words(listing.status), detail: `${listing.title} · ${listing.kind === "POOL" ? `pool of ${listing.notes.length} loans` : "single note"}` });
  row({ section: "Reserve", amount: walled ? null : reserve, detail: reserve == null ? "The seller set no reserve." : walled ? SEALED : "Bids at or above it needed no further seller approval." });
  row({
    section: "Bid terms",
    at: listing.bidDeadline,
    round: event ? "Sale event" : words(listing.bidMode),
    detail: event
      ? `${event.name}: indications due ${event.indicationsAt.toISOString()}, best and final due ${event.bestFinalAt.toISOString()}`
      : listing.bidDeadline ? `Deadline ${listing.bidDeadline.toISOString()}` : "No deadline",
  });

  for (const inquiry of listing.inquiries) {
    const priced = inquiry.messages.filter((message) => message.amount != null);
    const price = buyerPrice(
      inquiry.amount != null ? Number(inquiry.amount) : null,
      priced.map((message) => ({ kind: message.kind, amount: Number(message.amount), createdAt: message.createdAt, authorId: message.authorId })),
      inquiry.buyerId,
    );
    const party = partyOf(inquiry);
    row({
      section: "Bid",
      at: inquiry.createdAt,
      party,
      amount: amount(inquiry.amount),
      round: roundOf(inquiry.createdAt),
      goodUntil: inquiry.expiresAt,
      status: words(inquiry.status),
      reserveMet: met(price),
      detail: [
        loan(inquiry.noteId),
        inquiry.buyNow ? "at the buy-it-now price" : "",
        !walled && price != null && inquiry.amount != null && Math.abs(price - Number(inquiry.amount)) >= 0.005 ? `buyer's price now ${money(price, 2)}` : "",
        inquiry.withdrawnAt ? `withdrawn ${inquiry.withdrawnAt.toISOString()}` : "",
        `bid ${inquiry.id}`,
      ].filter(Boolean).join(" · "),
    });
    // The opening bid is its own first message, so revisions and counters start after it.
    const opening = priced[0]?.authorId === inquiry.buyerId && priced[0]?.kind === "OFFER" ? 1 : 0;
    for (const message of priced.slice(opening)) {
      const side = message.authorId === inquiry.buyerId ? "Buyer" : message.authorId === listing.sellerId ? "Seller" : "Desk";
      row({
        section: side === "Buyer" ? "Revised bid" : "Counter",
        at: message.createdAt,
        party,
        amount: amount(message.amount),
        round: roundOf(message.createdAt),
        status: words(message.kind),
        reserveMet: side === "Buyer" ? met(Number(message.amount)) : "",
        by: side,
        detail: `bid ${inquiry.id}`,
      });
    }
  }

  for (const bid of listing.deskBids) {
    row({ section: "Desk bid", at: bid.createdAt, party: "UPB Capital desk book", amount: amount(bid.amount), round: roundOf(bid.createdAt), status: words(bid.status), reserveMet: met(Number(bid.amount)), detail: loan(bid.noteId) });
  }

  const inquiryOf = new Map(listing.inquiries.map((inquiry) => [inquiry.id, inquiry]));
  for (const entry of audits) {
    const inquiry = inquiryOf.get(entry.entityId);
    const party = inquiry ? partyOf(inquiry) : "";
    const detail = walled ? SEALED : entry.detail;
    const by = entry.actor?.name ?? "System";
    if (APPROVAL_ACTIONS.includes(entry.action)) {
      row({ section: "Seller approval", at: entry.createdAt, party, status: words(entry.action.replace(/^SELLER_/, "")), by, detail });
    } else if (AWARD_ACTIONS.includes(entry.action)) {
      row({ section: "Award", at: entry.createdAt, party, status: words(entry.action), by, detail });
    } else if (KICKOUT_ACTIONS.includes(entry.action)) {
      const kept = listing.closings.some((closing) => closing.id === entry.entityId && closing.kickouts.some((kick) => Math.abs(kick.createdAt.getTime() - entry.createdAt.getTime()) < 60000));
      if (!kept) row({ section: "Closing outcome", at: entry.createdAt, status: "Kicked out", by, detail: entry.detail });
    } else {
      row({ section: "Decline", at: entry.createdAt, party, status: "Declined by the desk", by, detail });
    }
  }

  // Each notice names the listing after its subject's dot, so only this listing's declines count.
  for (const notice of notices) {
    if (!notice.subject.endsWith(` · ${listing.title}`) || !DECLINE_SUBJECT.test(notice.subject)) continue;
    const buyerId = byEmail.get(notice.toEmail);
    row({ section: "Decline sent", at: notice.createdAt, party: buyerId ? nameOfBuyer(buyerId) : "A buyer", status: notice.delivery, detail: notice.subject });
  }

  for (const closing of listing.closings) {
    const party = closing.deskBidId ? "UPB Capital desk book" : closing.buyerEntity || (closing.inquiryId && inquiryOf.get(closing.inquiryId) ? nameOfBuyer(inquiryOf.get(closing.inquiryId)!.buyerId) : "The buyer");
    row({ section: "Closing opened", at: closing.openedAt, party, amount: Number(closing.salePrice), status: words(closing.status), detail: `${scope(closing)} · closing ${closing.id}` });
    // A loan taken out before settlement, with the price and deposit it took with it.
    for (const kick of closing.kickouts) {
      row({
        section: "Closing outcome",
        at: kick.createdAt,
        party,
        amount: kick.priceCents / 100,
        status: "Kicked out",
        by: people.get(kick.actorId) ?? "A desk member",
        detail: [loan(kick.noteId), `price down ${money(kick.priceCents / 100, 2)}`, kick.depositCents ? `deposit down ${money(kick.depositCents / 100, 2)}` : "", kick.reason].filter(Boolean).join(" · "),
      });
    }
    // The collateral file's custody: the custodian, the bailee letter, the receipt and exceptions. lib/custody.ts.
    for (const line of custodyRows(closing, party)) row({ section: "Custody", ...line });
    if (closing.closedAt) row({ section: "Closing outcome", at: closing.closedAt, party, amount: Number(closing.salePrice), status: "Closed", detail: `Net to seller ${money(closing.netToSellerCents / 100, 2)}` });
    if (closing.canceledAt || closing.status === "CANCELED") {
      row({ section: "Closing outcome", at: closing.canceledAt, party, status: "Canceled", detail: [closing.cancelFault ? `Fault: ${words(closing.cancelFault)}` : "", closing.cancelReason ?? ""].filter(Boolean).join(" · ") });
    }
  }
  if (!listing.closings.length) row({ section: "Closing outcome", status: listing.status === "SOLD" ? "Sold outside the closing room" : "No closing", amount: listing.salePrice != null ? Number(listing.salePrice) : null, at: listing.soldAt });

  return { listing: { id: listing.id, title: listing.title, status: listing.status, seller: listing.seller.companyName || listing.seller.name }, event, reserve, walled, rows, copy: "desk" as const };
}

// The desk's file, or the seller's copy below. Both export through the same CSV and PDF.
export type SaleFile = Omit<NonNullable<Awaited<ReturnType<typeof saleFile>>>, "copy"> & { copy: "desk" | "seller" };

// ---------------------------------------------------------------------------------------------------------------
// The cover bid, as Fannie Mae publishes it for its pool sales: the highest other bid on the same loans, as a share
// of the winning bid, which is the second-highest bid when the winner bid most. The rivals are buyers' bids for the
// same scope placed before the award, less any the bidder had withdrawn or let lapse by then. `bids` counts the
// winner, so an award with no rival has one. The seller's copy and the board pack (lib/board-pack.ts) read it.

export type BidOnRecord = {
  id: string;
  buyerId: string;
  noteId: string | null;
  amount: number | null;
  status: string;
  createdAt: Date;
  expiresAt?: Date | null;
  withdrawnAt?: Date | null;
  messages: OfferMoney[];
};

// The bidder's price as it stood at a moment: their opening bid, or the last price they posted by then.
export function priceAt(bid: BidOnRecord, at: Date) {
  const price = buyerPrice(bid.amount, bid.messages.filter((message) => message.createdAt.getTime() <= at.getTime()), bid.buyerId);
  return price != null && price > 0 ? price : null;
}

export function awardCover(input: { winner: { id: string | null; noteId: string | null; price: number | null }; at: Date; bids: BidOnRecord[] }) {
  const { winner, at } = input;
  if (winner.price == null || !(winner.price > 0)) return null;
  const rivals = input.bids.flatMap((bid) => {
    if (bid.id === winner.id || (bid.noteId ?? null) !== (winner.noteId ?? null) || bid.createdAt.getTime() > at.getTime()) return [];
    const withdrawn = bid.status === "WITHDRAWN" && (!bid.withdrawnAt || bid.withdrawnAt.getTime() <= at.getTime());
    const lapsed = bidExpired(bid.expiresAt, at) || (bid.status === "EXPIRED" && !bid.expiresAt);
    const price = withdrawn || lapsed ? null : priceAt(bid, at);
    return price == null ? [] : [price];
  });
  const cover = rivals.length ? Math.max(...rivals) : null;
  return { winnerPrice: winner.price, bids: rivals.length + 1, cover, ratio: cover == null ? null : cover / winner.price };
}

export type AwardCover = NonNullable<ReturnType<typeof awardCover>>;

// ---------------------------------------------------------------------------------------------------------------
// The seller's copy, for its own board or exam file. It opens once the listing has an award, to the seller (a firm's
// seats act as the firm) and the broker of record. Line by line it holds only what the seller can already see in the
// app: the listing and the seller's own reserve and terms; every bid as the bid summary shows it, by the bidder's
// letter except an awarded buyer, with the bidder's track line; the seller's own approvals and counters and the
// desk's asks; each award, its cover bid, kick-outs, proration and outcome, with the seller's net; the trailing
// documents; and counts of NDAs and data-room files. It leaves out the desk's notes and its words on the log, the
// desk staff's names, other parties' files, KYC and screening, the notices sent to buyers, anything only the desk
// scores, the buyer's deposit, and every amount while the round is still sealed from the seller.

export const SALE_FILE_LOCKED = "The sale file opens to the seller once a bid is awarded.";

const SELLER_APPROVALS = ["SELLER_ASKED", "SELLER_ASKED_PART", "SELLER_APPROVED", "SELLER_DECLINED", "SELLER_COUNTERED", "RESERVE", "BUY_NOW_SET", "BUY_NOW_CLEARED"];

// An award, or a closing from one: the listing has a sale record to give.
export function saleAwarded(listing: { closings: unknown[]; inquiries: { status: string }[]; deskBids: { status: string }[] }) {
  return listing.closings.length > 0 || listing.inquiries.some((bid) => bid.status === "ACCEPTED") || listing.deskBids.some((bid) => bid.status === "ACCEPTED");
}

export async function sellerSaleFile(listingId: string, viewer: { id: string; role: string }, now = new Date()) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      seller: { select: { name: true, companyName: true } },
      notes: { select: { id: true, city: true, state: true }, orderBy: { createdAt: "asc" } },
      inquiries: {
        where: { type: "OFFER" },
        select: { id: true, buyerId: true, noteId: true, amount: true, status: true, createdAt: true, expiresAt: true, withdrawnAt: true, buyer: { select: { id: true, name: true, companyName: true } }, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } },
        orderBy: { createdAt: "asc" },
      },
      deskBids: { orderBy: { createdAt: "asc" } },
      closings: { orderBy: { openedAt: "asc" }, include: { kickouts: { orderBy: { createdAt: "asc" } }, trailingDocs: { orderBy: { dueAt: "asc" } } } },
    },
  });
  if (!listing) return { status: 404 as const };
  // The desk reads its own file. Everyone else reads this copy, if the listing is theirs to sell or broker.
  if (viewer.role === "ADMIN" || !canManageRoom(viewer, listing)) return { status: 403 as const, error: "The sale file is for the seller, the broker of record and the desk." };
  if (!saleAwarded(listing)) return { status: 403 as const, error: SALE_FILE_LOCKED };
  const sealed = sealedFromSeller(listing, now);
  const event = listing.saleEventId ? await prisma.saleEvent.findUnique({ where: { id: listing.saleEventId } }) : null;
  const ids = [listing.id, ...listing.inquiries.map((bid) => bid.id)];
  const [summary, nameOf, audits, activity] = await Promise.all([
    bidSummary(listing.id, viewer, now),
    bidderNamer(listing.id, { role: "SELLER" }),
    prisma.auditEvent.findMany({ where: { entityId: { in: ids }, action: { in: SELLER_APPROVALS } }, select: { action: true, actorId: true, entityId: true, detail: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
    listingActivity(listing.id, listing.sellerId, now),
  ]);
  if (summary.status !== 200) return { status: 403 as const, error: "The sale file is for the seller, the broker of record and the desk." };
  const bidOf = new Map(listing.inquiries.map((bid) => [bid.id, bid]));
  const partyOf = (buyerId: string) => {
    const buyer = listing.inquiries.find((bid) => bid.buyerId === buyerId)?.buyer;
    return buyer ? nameOf(buyer) : "A bidder";
  };
  // The desk's people show as the desk, as on the closing timeline.
  const who = (actorId: string | null) => (actorId === listing.sellerId ? "The seller" : actorId && actorId === listing.brokerId ? "The broker" : "The desk");
  const reserve = listing.reservePrice != null ? Number(listing.reservePrice) : null;
  const roundOf = (at: Date) =>
    event
      ? at.getTime() < event.indicationsAt.getTime() ? "Indication" : "Best and final"
      : listing.bidMode === "SEALED" ? "Sealed" : listing.bidMode === "BEST_AND_FINAL" ? "Best and final" : "Open offer";
  const position = new Map(listing.notes.map((note, index) => [note.id, index + 1]));
  const loan = (noteId: string | null) => {
    const note = noteId ? listing.notes.find((item) => item.id === noteId) : null;
    return note ? `Loan ${position.get(note.id)} in ${note.city}, ${note.state}` : "Whole listing";
  };
  const scope = (closing: (typeof listing.closings)[number]) => {
    const loans = closingLoans(closing, listing.notes);
    if (loans.length === listing.notes.length) return "Whole listing";
    return loans.length === 1 ? loan(loans[0].id) : `${loans.length} of ${listing.notes.length} loans`;
  };
  const rows: SaleFileRow[] = [];
  const row = (input: Partial<SaleFileRow> & { section: string }) =>
    rows.push({ at: null, party: "", amount: null, round: "", goodUntil: null, status: "", reserveMet: "", by: "", detail: "", ...input });

  row({ section: "Listing", at: listing.approvedAt, party: listing.seller.companyName || listing.seller.name, status: words(listing.status), detail: `${listing.title} · ${listing.kind === "POOL" ? `pool of ${listing.notes.length} loans` : "single note"}` });
  row({ section: "Reserve", amount: reserve, detail: reserve == null ? "The seller set no reserve." : "Bids at or above it needed no further seller approval." });
  row({
    section: "Bid terms",
    at: listing.bidDeadline,
    round: event ? "Sale event" : words(listing.bidMode),
    detail: event
      ? `${event.name}: indications due ${event.indicationsAt.toISOString()}, best and final due ${event.bestFinalAt.toISOString()}`
      : listing.bidDeadline ? `Deadline ${listing.bidDeadline.toISOString()}` : "No deadline",
  });
  // Counts only, as the seller's buyer-interest panel shows them. Who signed or took a file stays with the desk.
  const takers = new Set(activity.downloads.map((entry) => entry.actorId)).size;
  row({ section: "Interest", status: "NDAs signed", detail: String(activity.ndas.length) });
  row({ section: "Interest", status: "Data room", detail: `${activity.downloads.length} file${activity.downloads.length === 1 ? "" : "s"} taken by ${takers} buyer${takers === 1 ? "" : "s"}` });

  // Every bid as the seller's bid summary has it, with the bidder's track line.
  summary.rows.forEach((bid, index) => {
    const placed = summary.bids[index];
    const record = placed?.record;
    const price = bid.price && bid.price !== "Sealed until the deadline" ? Number(bid.price) : null;
    row({
      section: "Bid",
      at: placed?.at ?? null,
      party: bid.bidder,
      amount: sealed ? null : price,
      round: placed ? roundOf(placed.at) : "",
      goodUntil: placed ? (bidOf.get(placed.id)?.expiresAt ?? null) : null,
      status: bid.status,
      reserveMet: bid.reserve_met,
      detail: [
        bid.scope,
        bid.pct_of_upb ? `${bid.pct_of_upb}% of UPB` : "",
        bid.loan_prices ? `loan prices ${bid.loan_prices}` : "",
        record ? `track record: ${trackLine(record)}` : "",
        ...(record?.facts ?? []),
      ].filter(Boolean).join(" · "),
    });
  });

  for (const bid of listing.deskBids) {
    row({ section: "Desk bid", at: bid.createdAt, party: "UPB Capital desk book", amount: Number(bid.amount), round: roundOf(bid.createdAt), status: words(bid.status), reserveMet: reserve == null ? "No reserve" : Number(bid.amount) >= reserve ? "Yes" : "No", detail: loan(bid.noteId) });
  }

  // The seller's own answers and counters and the desk's asks, in the words the log keeps for them, which carry the
  // price and never a name.
  for (const entry of audits) {
    const bid = bidOf.get(entry.entityId);
    row({ section: "Seller approval", at: entry.createdAt, party: bid ? partyOf(bid.buyerId) : "", status: words(entry.action.replace(/^SELLER_/, "")), by: who(entry.actorId), detail: sealed ? SEALED : entry.detail });
  }

  const records: BidOnRecord[] = listing.inquiries.map((bid) => ({ ...bid, amount: bid.amount == null ? null : Number(bid.amount) }));
  for (const closing of listing.closings) {
    const winner = closing.inquiryId ? bidOf.get(closing.inquiryId) : null;
    const desk = closing.deskBidId ? listing.deskBids.find((bid) => bid.id === closing.deskBidId) : null;
    const named = winner ? partyOf(winner.buyerId) : "";
    const party = closing.deskBidId ? "UPB Capital desk book" : named || "The buyer";
    // The award price, before any loan came out of it.
    const awarded = Number(closing.salePrice) + closing.kickouts.reduce((sum, kick) => sum + kick.priceCents, 0) / 100;
    // The buyer's entity on title shows where the closing names the buyer to the seller.
    const title = closing.buyerEntity && winner && winner.status === "ACCEPTED" ? `takes title as ${closing.buyerEntity}` : "";
    row({ section: "Award", at: closing.openedAt, party, amount: awarded, status: closing.deskBidId ? "Desk purchase" : "Awarded", by: "The desk", detail: [scope(closing), title].filter(Boolean).join(" · ") });
    const cover = sealed
      ? null
      : awardCover({
          winner: { id: winner?.id ?? null, noteId: winner ? winner.noteId : (desk?.noteId ?? null), price: winner ? priceAt(records.find((bid) => bid.id === winner.id)!, closing.openedAt) : desk ? Number(desk.amount) : null },
          at: closing.openedAt,
          bids: records,
        });
    if (cover) {
      row({
        section: "Cover bid",
        at: closing.openedAt,
        party,
        amount: cover.cover,
        status: cover.ratio == null ? "One bid" : `${(cover.ratio * 100).toFixed(2)}% of the winning bid`,
        detail: cover.ratio == null ? "No other bid on these loans before the award." : `The highest other bid on these loans before the award, of ${cover.bids} bids. The winning bid was ${money(cover.winnerPrice, 2)}.`,
      });
    }
    for (const kick of closing.kickouts) {
      row({ section: "Closing outcome", at: kick.createdAt, party, amount: kick.priceCents / 100, status: "Kicked out", by: "The desk", detail: [loan(kick.noteId), `price down ${money(kick.priceCents / 100, 2)}`, kick.reason].filter(Boolean).join(" · ") });
    }
    if (closing.prorationCents != null) {
      const proration = readProration(closing.prorationDetail);
      row({ section: "Proration", party, amount: closing.prorationCents / 100, status: prorationDirection(closing.prorationCents), detail: proration ? prorationSummary(proration) : "" });
    }
    for (const doc of closing.trailingDocs) {
      const by = sideWord(deliveringSide(doc));
      row({
        section: "Trailing document",
        at: doc.receivedAt ?? doc.sentAt ?? doc.dueAt,
        party: by.charAt(0).toUpperCase() + by.slice(1),
        status: trailingStatusLabel(doc.status),
        detail: [
          kindLabel(doc.kind),
          doc.noteId ? loan(doc.noteId) : "",
          `due ${doc.dueAt.toISOString().slice(0, 10)}`,
          doc.sentAt ? `sent ${doc.sentAt.toISOString().slice(0, 10)}` : "",
          doc.receivedAt ? `received ${doc.receivedAt.toISOString().slice(0, 10)}` : "",
          doc.reference,
          doc.status === "WAIVED" && doc.waivedReason ? `waived: ${doc.waivedReason}` : "",
        ].filter(Boolean).join(" · "),
      });
    }
    // The collateral file's custody: the custodian, the bailee letter, the receipt and exceptions. lib/custody.ts.
    for (const line of custodyRows(closing, party)) row({ section: "Custody", ...line });
    if (closing.closedAt) row({ section: "Closing outcome", at: closing.closedAt, party, amount: Number(closing.salePrice), status: "Closed", detail: `Net to seller ${money(closing.netToSellerCents / 100, 2)}` });
    if (closing.canceledAt || closing.status === "CANCELED") {
      // The seller reads a finding against itself, never one against the buyer (lib/closing-service.ts faultLine).
      row({ section: "Closing outcome", at: closing.canceledAt, party, status: "Canceled", detail: [closing.cancelReason ?? "", closing.cancelFault === "SELLER" ? "Recorded as the seller's failure to deliver." : ""].filter(Boolean).join(" · ") });
    }
  }

  return { status: 200 as const, file: { listing: { id: listing.id, title: listing.title, status: listing.status, seller: listing.seller.companyName || listing.seller.name }, event, reserve, walled: sealed, rows, copy: "seller" as const } satisfies SaleFile };
}

export function saleFileCsv(file: SaleFile) {
  return toCsv(
    file.rows.map((row) => ({
      section: row.section,
      time_utc: row.at ? row.at.toISOString() : "",
      party: row.party,
      amount: row.amount == null ? (file.walled && ["Bid", "Revised bid", "Counter", "Desk bid", "Reserve"].includes(row.section) ? SEALED : "") : row.amount.toFixed(2),
      round: row.round,
      good_until_utc: row.goodUntil ? row.goodUntil.toISOString() : "",
      status: row.status,
      met_reserve: row.reserveMet,
      by: row.by,
      detail: row.detail,
    })),
  );
}

// A one- or two-page summary to put on top of the CSV in the exam file. The seller's copy adds its cover bids,
// proration, trailing documents and interest counts, and each bid's track line.
export async function saleFilePdf(file: SaleFile, generatedAt = new Date()) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const soft = rgb(0.4, 0.4, 0.45);
  let page = pdf.addPage([612, 792]);
  let y = 742;
  const line = (text: string, options: { size?: number; face?: typeof font; color?: typeof ink; gap?: number } = {}) => {
    const size = options.size ?? 10;
    const face = options.face ?? font;
    for (const part of wrap(pdfSafe(text, face), face, size, 516)) {
      if (y < 56) {
        page = pdf.addPage([612, 792]);
        y = 742;
      }
      page.drawText(part, { x: 48, y, size, font: face, color: options.color ?? ink });
      y -= size + 4;
    }
    y -= options.gap ?? 0;
  };
  const bids = file.rows.filter((row) => row.section === "Bid" || row.section === "Desk bid");
  const awards = file.rows.filter((row) => row.section === "Award");
  const declines = file.rows.filter((row) => row.section === "Decline sent");
  const outcomes = file.rows.filter((row) => row.section === "Closing outcome" || row.section === "Closing opened");
  const approvals = file.rows.filter((row) => row.section === "Seller approval");
  const seller = file.copy === "seller";
  const when = (at: Date | null) => (at ? `${prettyDate(at)} ${at.toISOString().slice(11, 16)} UTC` : "no date");

  line(seller ? "UPB CAPITAL  ·  SALE FILE  ·  SELLER COPY" : "UPB CAPITAL  ·  SALE FILE", { size: 9, face: bold, color: soft, gap: 6 });
  line(file.listing.title, { size: 18, face: bold, gap: 4 });
  line(`Seller ${file.listing.seller} · status ${words(file.listing.status)} · generated ${when(generatedAt)}`, { color: soft, gap: 10 });
  const terms = file.rows.find((row) => row.section === "Bid terms");
  line(`Bid terms: ${terms?.round ?? ""}. ${terms?.detail ?? ""}`);
  // The seller set the reserve, so their copy always shows it.
  line(file.reserve == null ? "Reserve: none set." : file.walled && !seller ? `Reserve: ${SEALED.toLowerCase()}.` : `Reserve: ${money(file.reserve, 2)}.`, { gap: 10 });

  line(`Bids (${bids.length})`, { size: 12, face: bold, gap: 2 });
  if (!bids.length) line("No bids were placed.", { color: soft });
  for (const bid of bids) {
    const figure = bid.amount == null ? (file.walled ? "sealed" : "no amount") : money(bid.amount, 2);
    line(`${when(bid.at)} · ${bid.party} · ${figure} · ${bid.round} · ${bid.status}${bid.goodUntil ? ` · good until ${prettyDate(bid.goodUntil)}` : ""}${bid.reserveMet ? ` · met reserve: ${bid.reserveMet.toLowerCase()}` : ""}`);
    if (seller && bid.detail) line(bid.detail, { size: 9, color: soft, gap: 2 });
  }
  y -= 8;
  line(`Seller approvals, counters and declines (${approvals.length})`, { size: 12, face: bold, gap: 2 });
  if (!approvals.length) line("None recorded.", { color: soft });
  for (const approval of approvals) line(`${when(approval.at)} · ${approval.status} · ${approval.party || "the listing"} · by ${approval.by}`);
  y -= 8;
  line("Award", { size: 12, face: bold, gap: 2 });
  if (!awards.length) line("No award recorded.", { color: soft });
  for (const award of awards) {
    if (seller) line(`${when(award.at)} · ${award.status} · ${award.party} · ${award.amount != null ? money(award.amount, 2) : "no amount"} · ${award.detail}`);
    else line(`${when(award.at)} · ${award.status} · ${award.party || "the listing"} · by ${award.by}${file.walled ? "" : ` · ${award.detail}`}`);
  }
  if (seller) {
    const covers = file.rows.filter((row) => row.section === "Cover bid");
    y -= 8;
    line("Cover bid", { size: 12, face: bold, gap: 2 });
    if (!covers.length) line(file.walled ? "Sealed until the deadline." : "No award to measure.", { color: soft });
    for (const cover of covers) line(`${when(cover.at)} · ${cover.status}${cover.amount != null ? ` · ${money(cover.amount, 2)}` : ""} · ${cover.detail}`);
  } else {
    y -= 8;
    line(`Declines sent (${declines.length})`, { size: 12, face: bold, gap: 2 });
    if (!declines.length) line("None sent.", { color: soft });
    for (const decline of declines) line(`${when(decline.at)} · ${decline.party} · ${decline.detail}`);
  }
  y -= 8;
  line("Closing outcome", { size: 12, face: bold, gap: 2 });
  for (const outcome of outcomes) line(`${when(outcome.at)} · ${outcome.section === "Closing opened" ? "Opened" : outcome.status} · ${outcome.party || ""}${outcome.amount != null ? ` · ${money(outcome.amount, 2)}` : ""}${outcome.detail ? ` · ${outcome.detail}` : ""}`);
  const custody = file.rows.filter((row) => row.section === "Custody");
  if (custody.length) {
    y -= 8;
    line("Collateral custody", { size: 12, face: bold, gap: 2 });
    for (const item of custody) line(`${item.at ? `${prettyDate(item.at)} · ` : ""}${item.status} · ${item.party}${item.detail ? ` · ${item.detail}` : ""}`);
  }
  if (seller) {
    for (const proration of file.rows.filter((row) => row.section === "Proration")) line(`Proration · ${proration.party} · ${proration.detail || proration.status}`);
    const docs = file.rows.filter((row) => row.section === "Trailing document");
    y -= 8;
    line(`Trailing documents (${docs.length})`, { size: 12, face: bold, gap: 2 });
    if (!docs.length) line("None yet. They are set when a closing completes.", { color: soft });
    for (const doc of docs) line(`${doc.status} · from the ${doc.party.toLowerCase()} · ${doc.detail}`);
    y -= 8;
    line("Interest", { size: 12, face: bold, gap: 2 });
    for (const count of file.rows.filter((row) => row.section === "Interest")) line(`${count.status}: ${count.detail}`);
    y -= 12;
    line("Bidders show by letter, except a buyer who was awarded. Funds show as the band the desk verified, never the figure. This copy leaves out the desk's notes, other parties' files and screening, and the notices sent to buyers.", { size: 9, color: soft, gap: 4 });
  } else {
    y -= 12;
  }
  line("Every bid, counter and notice with its exact time is in the CSV of this sale file. Times are UTC.", { size: 9, color: soft });
  return pdf.save();
}
