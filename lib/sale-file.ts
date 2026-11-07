import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { deskWalled } from "@/lib/auction";
import { closingLoans } from "@/lib/closing";
import { toCsv } from "@/lib/csv";
import type { Staff } from "@/lib/desk-roles";
import { money, prettyDate } from "@/lib/format";
import { pdfSafe, wrap } from "@/lib/memo-pdf";
import { buyerPrice } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
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
    if (closing.closedAt) row({ section: "Closing outcome", at: closing.closedAt, party, amount: Number(closing.salePrice), status: "Closed", detail: `Net to seller ${money(closing.netToSellerCents / 100, 2)}` });
    if (closing.canceledAt || closing.status === "CANCELED") {
      row({ section: "Closing outcome", at: closing.canceledAt, party, status: "Canceled", detail: [closing.cancelFault ? `Fault: ${words(closing.cancelFault)}` : "", closing.cancelReason ?? ""].filter(Boolean).join(" · ") });
    }
  }
  if (!listing.closings.length) row({ section: "Closing outcome", status: listing.status === "SOLD" ? "Sold outside the closing room" : "No closing", amount: listing.salePrice != null ? Number(listing.salePrice) : null, at: listing.soldAt });

  return { listing: { id: listing.id, title: listing.title, status: listing.status, seller: listing.seller.companyName || listing.seller.name }, event, reserve, walled, rows };
}

export type SaleFile = NonNullable<Awaited<ReturnType<typeof saleFile>>>;

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

// A one- or two-page summary to put on top of the CSV in the exam file.
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
  const when = (at: Date | null) => (at ? `${prettyDate(at)} ${at.toISOString().slice(11, 16)} UTC` : "no date");

  line("UPB CAPITAL  ·  SALE FILE", { size: 9, face: bold, color: soft, gap: 6 });
  line(file.listing.title, { size: 18, face: bold, gap: 4 });
  line(`Seller ${file.listing.seller} · status ${words(file.listing.status)} · generated ${when(generatedAt)}`, { color: soft, gap: 10 });
  const terms = file.rows.find((row) => row.section === "Bid terms");
  line(`Bid terms: ${terms?.round ?? ""}. ${terms?.detail ?? ""}`);
  line(file.reserve == null ? "Reserve: none set." : file.walled ? `Reserve: ${SEALED.toLowerCase()}.` : `Reserve: ${money(file.reserve, 2)}.`, { gap: 10 });

  line(`Bids (${bids.length})`, { size: 12, face: bold, gap: 2 });
  if (!bids.length) line("No bids were placed.", { color: soft });
  for (const bid of bids) {
    const figure = bid.amount == null ? (file.walled ? "sealed" : "no amount") : money(bid.amount, 2);
    line(`${when(bid.at)} · ${bid.party} · ${figure} · ${bid.round} · ${bid.status}${bid.goodUntil ? ` · good until ${prettyDate(bid.goodUntil)}` : ""}${bid.reserveMet ? ` · met reserve: ${bid.reserveMet.toLowerCase()}` : ""}`);
  }
  y -= 8;
  line(`Seller approvals, counters and declines (${approvals.length})`, { size: 12, face: bold, gap: 2 });
  if (!approvals.length) line("None recorded.", { color: soft });
  for (const approval of approvals) line(`${when(approval.at)} · ${approval.status} · ${approval.party || "the listing"} · by ${approval.by}`);
  y -= 8;
  line("Award", { size: 12, face: bold, gap: 2 });
  if (!awards.length) line("No award recorded.", { color: soft });
  for (const award of awards) line(`${when(award.at)} · ${award.status} · ${award.party || "the listing"} · by ${award.by}${file.walled ? "" : ` · ${award.detail}`}`);
  y -= 8;
  line(`Declines sent (${declines.length})`, { size: 12, face: bold, gap: 2 });
  if (!declines.length) line("None sent.", { color: soft });
  for (const decline of declines) line(`${when(decline.at)} · ${decline.party} · ${decline.detail}`);
  y -= 8;
  line("Closing outcome", { size: 12, face: bold, gap: 2 });
  for (const outcome of outcomes) line(`${when(outcome.at)} · ${outcome.section === "Closing opened" ? "Opened" : outcome.status} · ${outcome.party || ""}${outcome.amount != null ? ` · ${money(outcome.amount, 2)}` : ""}${outcome.detail ? ` · ${outcome.detail}` : ""}`);
  y -= 12;
  line("Every bid, counter and notice with its exact time is in the CSV of this sale file. Times are UTC.", { size: 9, color: soft });
  return pdf.save();
}
