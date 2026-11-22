import { readIn } from "@/lib/bulk-read";
import { effectiveTarget, targetDays } from "@/lib/closing-clock";
import { toCsv } from "@/lib/csv";
import { money, prettyDate } from "@/lib/format";
import { fundsExposure } from "@/lib/inquiry";
import { bidExpired, buyerPrice } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { balanceDueCents, buyerDueCents, buyerFundsCheck, economicsRows, variance, varianceNote } from "@/lib/settlement";
import { getSettings } from "@/lib/settings";
import { bidTarget, credentialLine, exposureByKey, fundsCredential, headroomFor, type FundsCredential } from "@/lib/verification";

// The buyer's cash calendar: what it owes on its open closings and when, and what its live bids would add if they
// win. Every figure comes from the helpers the closing page and the bid form already use: the buyer's all-in and
// balance from lib/settlement.ts, the target close from lib/closing-clock.ts, and the bids' holds and headroom from
// fundsExposure and lib/verification.ts. UPB holds no money; the desk records each wire when it lands.

const DAY = 24 * 60 * 60 * 1000;
// An unpaid item this close to its date reads as due soon.
export const SOON_DAYS = 3;
// Rows per page on the page. The CSV carries them all.
export const CASH_PAGE = 50;

export type CashStatus = "received" | "due" | "due_soon" | "late";
// Which total an unpaid item counts in. The 30-day total includes the 7-day one.
export type CashBucket = "late" | "week" | "month" | "later";
export type CashKind = "DEPOSIT" | "BALANCE" | "SHARE";

export const CASH_KIND_LABELS: Record<CashKind, string> = {
  DEPOSIT: "Deposit",
  BALANCE: "Balance at close",
  SHARE: "Your group share",
};

export const CASH_STATUS_LABELS: Record<CashStatus, string> = {
  received: "Received",
  due: "Due",
  due_soon: `Due within ${SOON_DAYS} days`,
  late: "Late",
};

// Received once the desk has recorded it. Late from the moment its date passes, as the closing page reads a deposit.
export function cashStatus(dueAt: Date | null, received: boolean, now = new Date()): CashStatus {
  if (received) return "received";
  if (!dueAt) return "due";
  const left = dueAt.getTime() - now.getTime();
  if (left < 0) return "late";
  return left <= SOON_DAYS * DAY ? "due_soon" : "due";
}

// An item with no date yet counts as later.
export function cashBucket(dueAt: Date | null, now = new Date()): CashBucket {
  if (!dueAt) return "later";
  const left = dueAt.getTime() - now.getTime();
  if (left < 0) return "late";
  if (left <= 7 * DAY) return "week";
  return left <= 30 * DAY ? "month" : "later";
}

export type CashTotals = { lateCents: number; next7Cents: number; next30Cents: number; laterCents: number };

// What is still owed, by when. A received item counts in none of them.
export function cashTotals(items: { cents: number; dueAt: Date | null; status: CashStatus }[], now = new Date()): CashTotals {
  const totals: CashTotals = { lateCents: 0, next7Cents: 0, next30Cents: 0, laterCents: 0 };
  for (const item of items) {
    if (item.status === "received") continue;
    const bucket = cashBucket(item.dueAt, now);
    if (bucket === "late") totals.lateCents += item.cents;
    else if (bucket === "later") totals.laterCents += item.cents;
    else {
      totals.next30Cents += item.cents;
      if (bucket === "week") totals.next7Cents += item.cents;
    }
  }
  return totals;
}

export type CashItem = {
  closingId: string;
  listingId: string;
  title: string;
  kind: CashKind;
  // What is owed, or what the desk recorded once it is received.
  cents: number;
  dueAt: Date | null;
  status: CashStatus;
  receivedAt: Date | null;
  detail: string;
};

export type CashClosing = {
  id: string;
  listingId: string;
  openedAt: Date;
  targetCloseAt: Date | null;
  salePrice: number;
  buyerPremiumCents: number;
  sellerCommissionCents: number;
  buyerTotalCents: number;
  netToSellerCents: number;
  prorationCents: number | null;
  depositCents: number | null;
  depositDueAt: Date | null;
  depositReceivedCents: number | null;
  depositReceivedAt: Date | null;
  fundsReceivedCents: number | null;
  fundsReceivedAt: Date | null;
};

// A group seat's part of a closing, as lib/settlement.ts FunderShare reads it.
export type CashSeat = { amount: number; premiumCents: number; status: string; fundedAt: Date | null };

// What one open closing asks of this buyer. A group seat funds its share, the same "Your all-in" its closing page
// shows, by the target close; the group's deposit isn't split by seat anywhere, so it isn't listed per seat. A sole
// buyer owes the deposit by its due date and the balance by the target close. Until the deposit lands the balance
// counts the deposit due on its own row, so the two never count the same dollars twice; once it lands the balance
// is the closing page's own, the all-in less what was received.
export function closingCash(closing: CashClosing, title: string, input: { seat: CashSeat | null; days: number; now?: Date }): CashItem[] {
  const now = input.now ?? new Date();
  const target = effectiveTarget(closing, input.days);
  const base = { closingId: closing.id, listingId: closing.listingId, title };
  if (input.seat) {
    const funded = input.seat.status === "FUNDED";
    const rows = economicsRows(closing, "buyer", input.seat);
    return [
      {
        ...base,
        kind: "SHARE",
        cents: rows[rows.length - 1].cents,
        dueAt: target,
        status: cashStatus(target, funded, now),
        receivedAt: funded ? input.seat.fundedAt : null,
        detail: funded ? "Marked funded by the desk" : "Your share of the price and the premium",
      },
    ];
  }
  const items: CashItem[] = [];
  const hasDeposit = closing.depositCents != null || closing.depositReceivedCents != null;
  const depositIn = closing.depositReceivedCents != null;
  if (hasDeposit) {
    const check = depositIn && closing.depositCents != null ? varianceNote(variance(closing.depositCents, closing.depositReceivedCents)) : "";
    items.push({
      ...base,
      kind: "DEPOSIT",
      cents: depositIn ? closing.depositReceivedCents! : closing.depositCents!,
      dueAt: closing.depositDueAt,
      status: cashStatus(closing.depositDueAt, depositIn, now),
      receivedAt: depositIn ? closing.depositReceivedAt : null,
      detail: depositIn ? (check && check !== "matches" ? `Deposit recorded ${check}` : "Recorded by the desk") : "Set at award",
    });
  }
  const fundsIn = closing.fundsReceivedCents != null;
  const counted = closing.depositReceivedCents ?? (hasDeposit ? closing.depositCents : null);
  const balance = balanceDueCents({ ...closing, depositReceivedCents: counted });
  const allIn = money(buyerDueCents(closing) / 100, 2);
  const note = fundsIn ? varianceNote(buyerFundsCheck(closing)) : "";
  const owedDetail = counted != null ? `All-in ${allIn} less the ${depositIn ? "deposit received" : "deposit"}` : `All-in ${allIn}`;
  const fundsDetail = note && note !== "matches" ? `Funds recorded ${note}, counting the deposit` : "Recorded by the desk";
  items.push({
    ...base,
    kind: "BALANCE",
    cents: fundsIn ? closing.fundsReceivedCents! : balance,
    dueAt: target,
    status: cashStatus(target, fundsIn, now),
    receivedAt: fundsIn ? closing.fundsReceivedAt : null,
    detail: fundsIn ? fundsDetail : owedDetail,
  });
  return items;
}

// Unpaid first, by date; then what was received, newest first.
export function sortCash(items: CashItem[]) {
  const time = (date: Date | null) => date?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => {
    const doneA = a.status === "received";
    const doneB = b.status === "received";
    if (doneA !== doneB) return doneA ? 1 : -1;
    if (doneA) return time(b.receivedAt) - time(a.receivedAt) || a.title.localeCompare(b.title);
    return time(a.dueAt) - time(b.dueAt) || a.title.localeCompare(b.title);
  });
}

// One page of rows, counted from 1. A page past the end shows the last one.
export function pageOf<T>(rows: T[], page: number, size = CASH_PAGE) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(pages, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  return { rows: rows.slice((current - 1) * size, current * size), page: current, pages };
}

// ---------------------------------------------------------------------------------------------------------------
// The loader.

// A bid that holds funds against the ceiling, one row per loan: bids on the same loan hold one amount, the highest,
// as the bid form counts them.
export type CashBid = {
  key: string;
  listingId: string;
  title: string;
  loan: string;
  allInCents: number;
  bids: { id: string; status: string; price: number | null; expiresAt: Date | null }[];
};

export type CashNeeds = {
  items: CashItem[];
  totals: CashTotals;
  bids: CashBid[];
  credential: (FundsCredential & { line: string }) | null;
  // Left across every open closing and bid, as the bid form shows it. Null without verified funds.
  headroomCents: number | null;
  heldByClosingsCents: number;
  heldByBidsCents: number;
};

const LIVE = ["OPEN", "REVIEWED", "ACCEPTED"] as const;

const CLOSING_PICK = [
  "id",
  "listingId",
  "inquiryId",
  "deskBidId",
  "status",
  "openedAt",
  "targetCloseAt",
  "salePrice",
  "buyerPremiumCents",
  "sellerCommissionCents",
  "buyerTotalCents",
  "netToSellerCents",
  "prorationCents",
  "depositCents",
  "depositDueAt",
  "depositReceivedCents",
  "depositReceivedAt",
  "fundsReceivedCents",
  "fundsReceivedAt",
] as const;

const cents = (dollars: number) => Math.round(dollars * 100);

// The account's own rows only: its bids by buyerId and its group seats by userId, then their closings by id. A firm's
// seat reads for its firm, since requireUser returns the firm's account (lib/seats.ts).
export async function loadCashNeeds(userId: string, now = new Date()): Promise<CashNeeds> {
  const [bids, seats, profile, settings] = await Promise.all([
    prisma.inquiry.findMany({
      where: { buyerId: userId, type: "OFFER", status: { in: [...LIVE] } },
      select: { id: true, listingId: true, noteId: true, status: true, amount: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.closingFunder.findMany({ where: { userId }, select: { closingId: true, amount: true, premiumCents: true, status: true, fundedAt: true } }),
    prisma.buyerProfile.findUnique({ where: { userId }, select: { proofAmount: true, proofExpiresAt: true, proofVerifiedAt: true } }),
    getSettings(),
  ]);
  const won = bids.filter((bid) => bid.status === "ACCEPTED").map((bid) => bid.id);
  const [wonClosings, seatClosings, exposures] = await Promise.all([
    readIn("Closing", "inquiryId", won, { pick: CLOSING_PICK }),
    readIn("Closing", "id", seats.map((seat) => seat.closingId), { pick: CLOSING_PICK, where: { status: "OPEN" } }),
    fundsExposure(userId, settings.buyerPremiumBps, now),
  ]);
  const seatOf = new Map(seats.map((seat) => [seat.closingId, seat]));
  // A group's bid sits on its lead's account, but each seat funds only its share, so a lead who holds no seat owes
  // nothing on it here.
  const soleOpen = wonClosings.filter((closing) => closing.status === "OPEN" && !closing.deskBidId && !seatOf.has(closing.id));
  const grouped = new Set(
    (await Promise.all(soleOpen.map((closing) => prisma.closingFunder.findFirst({ where: { closingId: closing.id }, select: { closingId: true } }))))
      .filter((row): row is { closingId: string } => Boolean(row))
      .map((row) => row.closingId),
  );
  const open = [...soleOpen.filter((closing) => !grouped.has(closing.id)), ...seatClosings.filter((closing) => !closing.deskBidId)];

  // The live bids that hold funds: those with no closing yet. A won bid's closing holds instead.
  const withClosing = new Set(wonClosings.map((closing) => closing.inquiryId));
  const pending = bids.filter((bid) => !withClosing.has(bid.id) && (bid.status === "ACCEPTED" || !bidExpired(bid.expiresAt, now)));
  const [listings, notes, messages] = await Promise.all([
    readIn("Listing", "id", [...open.map((closing) => closing.listingId), ...pending.map((bid) => bid.listingId)], { pick: ["id", "title"] as const }),
    readIn("Note", "id", pending.map((bid) => bid.noteId).filter((id): id is string => Boolean(id)), { pick: ["id", "city", "state"] as const }),
    readIn("OfferMessage", "inquiryId", pending.map((bid) => bid.id), { pick: ["inquiryId", "kind", "amount", "createdAt", "authorId"] as const }),
  ]);
  const titleOf = new Map(listings.map((listing) => [listing.id, listing.title]));
  const noteOf = new Map(notes.map((note) => [note.id, note]));

  const days = targetDays(settings.closingTargetDays);
  const items = sortCash(
    open.flatMap((closing) => {
      const seat = seatOf.get(closing.id);
      return closingCash({ ...closing, salePrice: Number(closing.salePrice) }, titleOf.get(closing.listingId) ?? "A listing", {
        seat: seat ? { amount: Number(seat.amount), premiumCents: seat.premiumCents, status: seat.status, fundedAt: seat.fundedAt } : null,
        days,
        now,
      });
    }),
  );

  // The holds and headroom, exactly as the bid form reads them (lib/inquiry.ts bidStanding).
  const byKey = exposureByKey(exposures);
  const found = fundsCredential(profile, now);
  const credential = found ? { ...found, line: credentialLine(found, now) } : null;
  let heldByClosings = 0;
  let heldByBids = 0;
  for (const [key, allIn] of Object.entries(byKey)) {
    if (key.startsWith("closing:")) heldByClosings += allIn;
    else heldByBids += allIn;
  }
  const byBidKey = new Map<string, typeof pending>();
  for (const bid of pending) {
    const key = bidTarget(bid.listingId, bid.noteId);
    byBidKey.set(key, [...(byBidKey.get(key) ?? []), bid]);
  }
  const rows: CashBid[] = [];
  for (const [key, group] of byBidKey) {
    const allIn = byKey[key];
    if (allIn == null) continue;
    const first = group[0];
    const note = first.noteId ? noteOf.get(first.noteId) : null;
    rows.push({
      key,
      listingId: first.listingId,
      title: titleOf.get(first.listingId) ?? "A listing",
      loan: first.noteId ? (note ? `${note.city}, ${note.state}` : "One loan") : "Whole listing",
      allInCents: cents(allIn),
      bids: group.map((bid) => ({
        id: bid.id,
        status: bid.status,
        price: buyerPrice(bid.amount, messages.filter((message) => message.inquiryId === bid.id), userId),
        expiresAt: bid.expiresAt,
      })),
    });
  }
  rows.sort((a, b) => b.allInCents - a.allInCents || a.title.localeCompare(b.title));

  return {
    items,
    totals: cashTotals(items, now),
    bids: rows,
    credential,
    headroomCents: credential ? cents(headroomFor(credential.amount, byKey)) : null,
    heldByClosingsCents: cents(heldByClosings),
    heldByBidsCents: cents(heldByBids),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The CSV of what is owed.

export function cashCsv(items: CashItem[], appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  const base = appUrl.replace(/\/$/, "");
  const rows = items.map((item) => ({
    listing: item.title,
    item: CASH_KIND_LABELS[item.kind],
    amount: (item.cents / 100).toFixed(2),
    due: item.dueAt ? item.dueAt.toISOString().slice(0, 10) : "",
    status: CASH_STATUS_LABELS[item.status],
    received: item.receivedAt ? item.receivedAt.toISOString().slice(0, 10) : "",
    detail: item.detail,
    closing: `${base}/closings/${item.closingId}`,
  }));
  return toCsv(rows.length ? rows : [{ listing: "", item: "", amount: "", due: "", status: "", received: "", detail: "", closing: "" }]);
}

// "Received Nov 20, 2026", or the status alone.
export function statusText(item: Pick<CashItem, "status" | "receivedAt">) {
  return item.status === "received" && item.receivedAt ? `Received ${prettyDate(item.receivedAt)}` : CASH_STATUS_LABELS[item.status];
}
