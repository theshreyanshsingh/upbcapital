import type { ClosingStepKey } from "@prisma/client";
import { audit } from "@/lib/audit";
import { CLOSING_STEPS, canCompleteStep, closingCovers, closingIsWhole, closingLoans, closingTotals, stepLabel } from "@/lib/closing";
import { STEP_OWNER, closingSchedule, depositCents, depositTerms, effectiveDue, settlementWeekdays, stepClock, targetDays } from "@/lib/closing-clock";
import { deskFeeBps, listingFeeBps } from "@/lib/desk-fees";
import { notify, notifyDesk } from "@/lib/email";
import { getEscrowProvider } from "@/lib/escrow";
import { money, prettyDate } from "@/lib/format";
import { postRevenueOnce } from "@/lib/ledger";
import { ensureBuyerHolding } from "@/lib/portfolio";
import { unset } from "@/lib/db-filters";
import { prisma } from "@/lib/prisma";
import { variance } from "@/lib/settlement";
import { getSettings } from "@/lib/settings";
import { countWord, recordStrike, type CancelFault } from "@/lib/strikes";
import { postBrokerFees } from "@/lib/broker-pay";
import { ensureClosingThread } from "@/lib/threads";
import { vestingNames } from "@/lib/vesting";

const DAY = 24 * 60 * 60 * 1000;

// The buyer's diligence window after an award, in days. Missing, 0 or out of range means none.
export function diligenceDays(setting: number | null | undefined) {
  return setting != null && setting >= 1 && setting <= 60 ? Math.round(setting) : 0;
}

// When a new closing's diligence window ends. The desk buying for its own book has done its diligence already.
export function diligenceEnd(setting: number | null | undefined, deskPurchase: boolean, openedAt = new Date()) {
  const days = diligenceDays(setting);
  return !deskPurchase && days > 0 ? new Date(openedAt.getTime() + days * DAY) : null;
}

export function diligenceOpen(closing: { status: string; diligenceEndsAt: Date | null }, now = new Date()) {
  return closing.status === "OPEN" && Boolean(closing.diligenceEndsAt && closing.diligenceEndsAt.getTime() > now.getTime());
}

// One open closing per loan. A whole-listing award needs every loan free, and a one-loan award needs
// that loan free and no whole-listing closing open. Returns why the award can't go ahead, or null.
export async function tradeConflict(listingId: string, noteId: string | null) {
  const [listing, open] = await Promise.all([
    prisma.listing.findUnique({ where: { id: listingId }, select: { status: true, notes: { select: { id: true, tradeStatus: true } } } }),
    prisma.closing.findMany({ where: { listingId, status: "OPEN" }, select: { noteId: true, noteIds: true } }),
  ]);
  if (!listing) return "That listing no longer exists.";
  if (listing.status === "SOLD") return "This listing is already sold.";
  if (noteId) {
    const note = listing.notes.find((item) => item.id === noteId);
    if (!note) return "That loan is not on this listing.";
    if (note.tradeStatus !== "AVAILABLE") return `That loan is already ${note.tradeStatus === "SOLD" ? "sold" : "in contract"}.`;
    if (open.some((closing) => closingCovers(closing, noteId))) return "An open closing already covers that loan. Finish or cancel it first.";
    return null;
  }
  if (open.length) return "This listing already has an open closing. Finish or cancel it first.";
  if (listing.notes.some((note) => note.tradeStatus !== "AVAILABLE")) return "Some loans on this listing are in contract or sold, so the whole listing can't be awarded.";
  return null;
}

// Part of a pool: every loan named must be free, and no open closing may cover any of them. The rest of the pool
// stays on the book. Returns why the award can't go ahead, or null.
export async function partConflict(listingId: string, noteIds: string[]) {
  const [listing, open] = await Promise.all([
    prisma.listing.findUnique({ where: { id: listingId }, select: { status: true, notes: { select: { id: true, tradeStatus: true } } } }),
    prisma.closing.findMany({ where: { listingId, status: "OPEN" }, select: { noteId: true, noteIds: true } }),
  ]);
  if (!listing) return "That listing no longer exists.";
  if (listing.status === "SOLD") return "This listing is already sold.";
  if (!noteIds.length) return "Choose at least one loan.";
  for (const noteId of noteIds) {
    const note = listing.notes.find((item) => item.id === noteId);
    if (!note) return "A loan in that part is not on this listing.";
    if (note.tradeStatus !== "AVAILABLE") return `A loan in that part is already ${note.tradeStatus === "SOLD" ? "sold" : "in contract"}.`;
  }
  if (open.some((closing) => noteIds.some((noteId) => closingCovers(closing, noteId)))) return "An open closing already covers a loan in that part. Finish or cancel it first.";
  return null;
}

export async function openClosing(input: {
  listingId: string;
  inquiryId?: string | null;
  deskBidId?: string | null;
  noteId: string | null;
  // The loans of a part-pool award. Empty or missing means noteId alone, or the whole listing.
  noteIds?: string[];
  salePrice: number;
  title: string;
}) {
  if (input.inquiryId) {
    const existing = await prisma.closing.findUnique({ where: { inquiryId: input.inquiryId } });
    if (existing) return existing;
  }
  if (input.deskBidId) {
    const existing = await prisma.closing.findUnique({ where: { deskBidId: input.deskBidId } });
    if (existing) return existing;
  }
  const [settings, listingFees] = await Promise.all([
    getSettings(),
    prisma.listing.findUnique({ where: { id: input.listingId }, select: { feeBuyerPremiumBps: true, feeSellerCommissionBps: true, deskOwnerId: true } }),
  ]);
  // The fees fixed when the desk approved the listing. The desk buying for its own book pays no premium, and the
  // seller's commission is still the one the listing went live with.
  const listed = listingFeeBps(listingFees, settings);
  const bps = input.deskBidId ? deskFeeBps(settings.chargeDeskFees, listed.commissionBps) : listed;
  const fees = closingTotals(input.salePrice, bps.premiumBps, bps.commissionBps);
  const provider = getEscrowProvider();
  const preview = await provider.open({
    closingId: input.inquiryId || input.deskBidId || "desk",
    listingTitle: input.title,
    salePrice: input.salePrice,
    buyerTotalCents: fees.buyerTotalCents,
    netToSellerCents: fees.netToSellerCents,
    wireInstructions: settings.wireInstructions,
  });
  // Payment and the close fall on the desk's next settlement day, so wires go out in batches.
  const schedule = closingSchedule(new Date(), targetDays(settings.closingTargetDays), settlementWeekdays(settings.settlementDays));
  // A buyer's deposit is set at award. The desk buying for its own book owes none.
  const deposit = depositTerms(settings);
  const depositDue = !input.deskBidId && deposit.bps > 0 ? new Date(Date.now() + deposit.days * 24 * 60 * 60 * 1000) : null;
  if (depositDue) schedule.due.BUYER_DEPOSIT = depositDue;
  const diligenceEndsAt = diligenceEnd(settings.diligenceDays, Boolean(input.deskBidId));
  const bid = input.inquiryId ? await prisma.inquiry.findUnique({ where: { id: input.inquiryId }, select: { buyerId: true } }) : null;
  const buyerEntity = bid ? ((await vestingNames([bid.buyerId])).get(bid.buyerId) ?? null) : null;
  const created = await prisma.closing.create({
    data: {
      listingId: input.listingId,
      inquiryId: input.inquiryId || null,
      deskBidId: input.deskBidId || null,
      noteId: input.noteId,
      ...(input.noteIds?.length ? { noteIds: input.noteIds } : {}),
      salePrice: input.salePrice,
      buyerPremiumCents: fees.premiumCents,
      sellerCommissionCents: fees.commissionCents,
      buyerTotalCents: fees.buyerTotalCents,
      netToSellerCents: fees.netToSellerCents,
      provider: preview.provider,
      providerRef: preview.providerRef,
      wireInstructions: preview.instructions,
      ...(buyerEntity ? { buyerEntity } : {}),
      // The deal owner carries over, so the seller keeps one named contact from listing to close.
      ...(listingFees?.deskOwnerId ? { deskOwnerId: listingFees.deskOwnerId } : {}),
      targetCloseAt: schedule.targetCloseAt,
      ...(depositDue ? { depositCents: depositCents(input.salePrice, deposit.bps), depositDueAt: depositDue } : {}),
      ...(diligenceEndsAt ? { diligenceEndsAt } : {}),
      steps: {
        create: CLOSING_STEPS.map((step) => ({ key: step.key, dueAt: schedule.due[step.key] })),
      },
    },
  });
  const opened = input.inquiryId && preview.instructions.includes(input.inquiryId)
    ? await prisma.closing.update({
        where: { id: created.id },
        data: { wireInstructions: preview.instructions.replaceAll(input.inquiryId, created.id) },
      })
    : created;
  await ensureClosingThread(opened.id);
  return opened;
}

export async function ensureAcceptedDeskClosings() {
  const bids = await prisma.deskBid.findMany({
    where: { status: "ACCEPTED", closing: null },
    include: { listing: true },
  });
  for (const bid of bids) {
    await openClosing({
      listingId: bid.listingId,
      deskBidId: bid.id,
      noteId: bid.noteId,
      salePrice: Number(bid.amount),
      title: bid.listing.title,
    });
  }
}

export async function finalizeClosing(closingId: string) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    include: { listing: { include: { notes: true } }, steps: true },
  });
  if (!closing || closing.status === "CANCELED") return closing;
  if (closing.status === "OPEN") {
    if (!canCompleteStep(closing.steps, "CLOSED")) return closing;
    // A cancel or a second close can land between the read and this write. Only the write that moves it off OPEN
    // goes on to sell the loans and post the money.
    const claimed = await prisma.closing.updateMany({
      where: { id: closing.id, status: "OPEN" },
      data: { status: "COMPLETE", closedAt: new Date() },
    });
    if (claimed.count !== 1) return prisma.closing.findUnique({ where: { id: closingId } });
    const whole = closingIsWhole(closing);
    if (whole) {
      await prisma.note.updateMany({ where: { listingId: closing.listingId }, data: { tradeStatus: "SOLD" } });
    } else {
      await prisma.note.updateMany({ where: { id: { in: closingLoans(closing, closing.listing.notes).map((note) => note.id) } }, data: { tradeStatus: "SOLD" } });
    }
    const notes = await prisma.note.findMany({ where: { listingId: closing.listingId } });
    const entireBookSold = notes.every((note) => note.tradeStatus === "SOLD");
    if (whole || entireBookSold) {
      const closings = await prisma.closing.findMany({ where: { listingId: closing.listingId, status: "COMPLETE" } });
      const salePrice = closings.reduce((sum, item) => sum + Number(item.salePrice), 0);
      const premium = closings.reduce((sum, item) => sum + item.buyerPremiumCents, 0);
      const commission = closings.reduce((sum, item) => sum + item.sellerCommissionCents, 0);
      const buyerTotal = closings.reduce((sum, item) => sum + item.buyerTotalCents, 0);
      const net = closings.reduce((sum, item) => sum + item.netToSellerCents, 0);
      await prisma.listing.update({
        where: { id: closing.listingId },
        data: {
          status: "SOLD",
          soldAt: new Date(),
          salePrice,
          buyerPremiumCents: premium,
          sellerCommissionCents: commission,
          buyerTotalCents: buyerTotal,
          netToSellerCents: net,
        },
      });
    }
  }
  await ensureBuyerHolding(closing.id);
  if (closing.deskBidId) {
    const notes = closingLoans(closing, closing.listing.notes);
    const upb = notes.reduce((sum, note) => sum + Number(note.upb), 0);
    const existing = await prisma.deskHolding.findFirst({
      // A whole-listing holding may have no noteId field at all, which `noteId: null` alone would miss.
      where: { OR: [{ closingId: closing.id }, { listingId: closing.listingId, ...(closing.noteId ? { noteId: closing.noteId } : unset("noteId")) }] },
    });
    if (!existing) {
      await prisma.deskHolding.create({
        data: {
          listingId: closing.listingId,
          noteId: closing.noteId,
          title: closing.listing.title,
          costBasis: Number(closing.salePrice),
          upb,
          closingId: closing.id,
          acquiredAt: new Date(),
        },
      });
    } else if (!existing.closingId) {
      await prisma.deskHolding.update({ where: { id: existing.id }, data: { closingId: closing.id } });
    }
  }
  // A zero fee is not revenue, so it gets no ledger row.
  const revenue = [
    {
      type: "BUYER_PREMIUM" as const,
      amountCents: closing.buyerPremiumCents,
      listingId: closing.listingId,
      description: `Buyer premium on ${closing.listing.title}`,
      externalId: `closing:${closing.id}:premium`,
    },
    {
      type: "SELLER_COMMISSION" as const,
      amountCents: closing.sellerCommissionCents,
      listingId: closing.listingId,
      description: `Seller commission on ${closing.listing.title}`,
      externalId: `closing:${closing.id}:commission`,
    },
  ].filter((event) => event.amountCents > 0);
  if (revenue.length) await postRevenueOnce(revenue);
  await postBrokerFees(closing.id);
  return prisma.closing.findUnique({ where: { id: closingId } });
}

// Nothing posts to the ledger until a closing completes, so a cancel has no money entries to reverse.
// A listing an admin never approved goes back to review rather than live.
// A buyer's walk-away in diligence passes `withinDiligence`, so the cancel only lands while the window is still open,
// and marks the bid withdrawn rather than declined.
// The desk names whose failure ended it. A buyer's failure records a strike against the winning bidder. A walk-away
// in diligence is the buyer's right under the terms, so it is nobody's fault and never a strike. The desk buying
// for its own book has no buyer to strike.
export async function cancelOpenClosing(closingId: string, reason: string, options: { withinDiligence?: Date; fault?: CancelFault; actorId?: string | null } = {}) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, include: { listing: true } });
  if (!closing || closing.status !== "OPEN") return null;
  const fault = options.withinDiligence ? "NEITHER" : options.fault === "BUYER" && closing.deskBidId ? undefined : options.fault;
  // Only the write that moves it off OPEN cancels, so a close that landed first stays closed.
  const claimed = await prisma.closing.updateMany({
    where: { id: closingId, status: "OPEN", ...(options.withinDiligence ? { diligenceEndsAt: { gt: options.withinDiligence } } : {}) },
    data: { status: "CANCELED", canceledAt: new Date(), cancelReason: reason, ...(fault ? { cancelFault: fault } : {}) },
  });
  if (claimed.count !== 1) return null;
  // A whole-listing closing never took its loans one by one, so only a closing that names its loans hands them back.
  if (closing.noteIds.length) await prisma.note.updateMany({ where: { id: { in: closing.noteIds }, tradeStatus: "IN_CONTRACT" }, data: { tradeStatus: "AVAILABLE" } });
  else if (closing.noteId) await prisma.note.update({ where: { id: closing.noteId }, data: { tradeStatus: "AVAILABLE" } });
  if (closing.inquiryId) {
    const bid = await prisma.inquiry.update({
      where: { id: closing.inquiryId },
      data: options.withinDiligence ? { status: "WITHDRAWN", withdrawnAt: options.withinDiligence } : { status: "DECLINED" },
      select: { buyerId: true },
    });
    if (fault === "BUYER") await recordStrike({ userId: bid.buyerId, closingId, reason, createdById: options.actorId ?? null });
  }
  if (closing.deskBidId) await prisma.deskBid.update({ where: { id: closing.deskBidId }, data: { status: "WITHDRAWN" } });
  const others = await prisma.closing.count({ where: { listingId: closing.listingId, status: "OPEN", id: { not: closingId } } });
  await prisma.listing.update({
    where: { id: closing.listingId },
    data: {
      ...(closing.listing.status === "PENDING" && others === 0 ? { status: closing.listing.approvedAt ? ("APPROVED" as const) : ("UNDER_REVIEW" as const) } : {}),
      ...(closing.listing.acceptedInquiryId === closing.inquiryId ? { acceptedInquiryId: null } : {}),
    },
  });
  return closing;
}

// The buyer walks away inside the diligence window, with a reason both sides read. It cancels through the same path
// as a desk cancel. A group's closing is the seats' money, so one seat can't end it for the rest; the desk does.
export async function walkAwayFromClosing(closingId: string, buyerId: string, reason: string, now = new Date()) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, include: { listing: { include: { seller: true } }, funders: { select: { userId: true } } } });
  if (!closing) return { error: "That closing no longer exists." } as const;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true } }) : null;
  const seat = closing.funders.some((funder) => funder.userId === buyerId);
  if (!inquiry || (inquiry.buyerId !== buyerId && !seat)) return { error: "Only the buyer on this closing can walk away." } as const;
  if (closing.funders.length > 1) return { error: "A group closing is ended by the desk, so every seat is heard. Write the desk on the closing thread." } as const;
  if (closing.status !== "OPEN") return { error: "This closing is already finished." } as const;
  if (!diligenceOpen(closing, now)) return { error: "The diligence window has closed, so the purchase terms govern from here. Write the desk on the closing thread." } as const;
  const why = reason.replace(/\s+/g, " ").trim().slice(0, 500);
  if (why.length < 10) return { error: "Say what you found, in a sentence. The seller reads it." } as const;
  if (!(await cancelOpenClosing(closingId, `The buyer walked away in diligence: ${why}`, { withinDiligence: now }))) {
    return { error: "The diligence window closed or the closing finished a moment ago." } as const;
  }
  await audit(buyerId, "DILIGENCE_WALK_AWAY", "closing", closingId, why);
  // Counsel: confirm that "returned per the purchase terms" matches the deposit and refund language in the purchase
  // agreement before launch, and whether a walk-away in diligence needs a written notice beyond this.
  const message = `The buyer walked away during the diligence window. Reason: ${why} The note goes back on the book. Money already wired is returned per the purchase terms. Write the desk with any questions.`;
  const { emitWebhook } = await import("@/lib/webhooks");
  await emitWebhook(closing.listing.sellerId, "offer.declined", { inquiryId: inquiry.id, listingId: closing.listingId, reason: "diligence_walk_away" });
  const subject = `Buyer walked away · ${closing.listing.title}`;
  await notify(closing.listing.seller.email, subject, message);
  for (const email of await buyerSideEmails(closingId)) await notify(email, subject, message);
  await notifyDesk(subject, `${inquiry.buyer.name} walked away in diligence. Reason: ${why} Check for wired money to return.`);
  const thread = await prisma.deskThread.findUnique({ where: { closingId } });
  if (thread) await prisma.threadPost.create({ data: { threadId: thread.id, authorId: buyerId, body: message } });
  return { error: null } as const;
}

// The lead buyer and every group seat holder each wire money, so each of them hears about anything that touches it.
export async function buyerSideEmails(closingId: string) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, select: { inquiryId: true, funders: { select: { user: { select: { email: true } } } } } });
  if (!closing) return [];
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyer: { select: { email: true } } } }) : null;
  return [...new Set([inquiry?.buyer.email, ...closing.funders.map((funder) => funder.user.email)].filter((email): email is string => Boolean(email)))];
}

// The deposit step completes from the deposit the desk recorded, once it covers what was due. A seat holder's own
// word that they funded never completes it.
export async function completeDepositFromWire(closingId: string) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId } });
  if (!closing || closing.status !== "OPEN" || closing.depositCents == null || closing.depositReceivedCents == null) return false;
  const check = variance(closing.depositCents, closing.depositReceivedCents);
  if (check.state !== "match" && check.state !== "over") return false;
  const received = `$${(closing.depositReceivedCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const done = await prisma.closingStep.updateMany({
    where: { closingId, key: "BUYER_DEPOSIT", status: "PENDING" },
    data: { status: "COMPLETE", completedAt: new Date(), note: `Deposit of ${received} received${closing.depositReceivedAt ? ` ${closing.depositReceivedAt.toISOString().slice(0, 10)}` : ""}.` },
  });
  return done.count === 1;
}

export function isClosingStepKey(value: string): value is ClosingStepKey {
  return CLOSING_STEPS.some((step) => step.key === value);
}

// ---------------------------------------------------------------------------------------------------------------
// The deal timeline: one log of the closing for every party, built from the closing's own records and the audit
// events written against it. Each side sees what the closing page already shows it and no more: the buyer's wires
// go to the buyer and the desk, the seller's proceeds to the seller and the desk, and a broker watching the deal
// sees the steps and dates but no file names, figures or messages.

export type TimelineSide = "desk" | "buyer" | "seller" | "observer";
export type TimelineOwner = "buyer" | "seller" | "desk" | "both";
export type TimelineEntry = { id: string; at: Date; title: string; detail: string; owner: TimelineOwner; who: string };
export type TimelineStep = { key: string; label: string; owner: TimelineOwner; due: Date | null; next: boolean; late: boolean };

type TimelinePerson = { name: string; companyName?: string | null; role: string };

export type TimelineInput = {
  closing: {
    status: string;
    openedAt: Date;
    closedAt: Date | null;
    canceledAt: Date | null;
    cancelReason: string | null;
    cancelFault: string | null;
    targetCloseAt: Date | null;
    salePrice: number;
    depositCents: number | null;
    depositDueAt: Date | null;
    fundsReceivedCents: number | null;
    fundsReceivedAt: Date | null;
    depositReceivedCents: number | null;
    depositReceivedAt: Date | null;
    proceedsSentCents: number | null;
    proceedsSentAt: Date | null;
  };
  steps: { key: string; status: string; completedAt: Date | null; dueAt: Date | null; note: string; files: { id: string; originalName: string; createdAt: Date; uploadedById: string | null }[] }[];
  audits: { id: string; action: string; actorId: string | null; detail: string; createdAt: Date }[];
  posts: { id: string; authorId: string; body: string; createdAt: Date }[];
  people: Record<string, TimelinePerson>;
  // Loans the desk took out before settlement, each with the price and deposit it took with it.
  kickouts?: { id: string; at: Date; loan: string; reason: string; priceCents: number; depositCents: number; actorId: string }[];
  sellerId: string;
  // The lead buyer and every group seat.
  buyerIds: string[];
  days: number;
  now?: Date;
};

export const TIMELINE_ACTIONS = ["CLOSING", "CLOSING_CANCELED", "CLOSING_DATES", "CLOSING_OVERRIDE", "WIRE_EDIT", "FUNDS_RECEIVED", "DEPOSIT_RECEIVED", "PROCEEDS_SENT", "SHARE_FUNDED", "DILIGENCE_WALK_AWAY"];

export function ownerWord(owner: TimelineOwner) {
  return owner === "both" ? "Buyer and seller" : owner === "desk" ? "Desk" : owner === "buyer" ? "Buyer" : "Seller";
}

function isoDay(iso: string) {
  return prettyDate(new Date(`${iso}T12:00:00Z`));
}

// "Buyer funds received: none to $1,025.00 on 2026-11-06 · REF" reads as "$1,025.00 on Nov 6, 2026 · reference REF".
function wireDetail(detail: string, desk: boolean) {
  const match = /: (none|\$[\d,.]+) to (\$[\d,.]+) on (\d{4}-\d{2}-\d{2})(?: · (.*))?$/.exec(detail);
  if (!match) return detail;
  const [, before, after, day, reference] = match;
  return `${after} on ${isoDay(day)}${reference ? ` · reference ${reference}` : ""}${desk && before !== "none" ? ` · was ${before}` : ""}`;
}

function wireFallback(cents: number, at: Date) {
  return `${money(cents / 100, 2)} on ${prettyDate(at)}`;
}

// Step keys and ISO dates in a desk log line, as people read them.
function readable(detail: string) {
  return detail
    .replace(/\b[A-Z][A-Z_]{3,}\b/g, (key) => (isClosingStepKey(key) ? stepLabel(key) : key))
    .replace(/\d{4}-\d{2}-\d{2}/g, (iso) => isoDay(iso));
}

function faultLine(fault: string | null, side: TimelineSide) {
  if (side === "desk") {
    if (fault === "BUYER") return "Recorded as the buyer's failure to close, with a strike on their file.";
    if (fault === "SELLER") return "Recorded as the seller's failure to deliver.";
    if (fault === "NEITHER") return "Recorded as neither side's failure.";
    return "";
  }
  // Each side hears only a finding against itself. The other side's record isn't theirs to read.
  if (side === "buyer" && fault === "BUYER") return "The desk recorded this as the buyer's failure to close. It counts as a strike on the buyer file.";
  if (side === "seller" && fault === "SELLER") return "The desk recorded this as the seller's failure to deliver.";
  return "";
}

function clip(text: string, length: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}

export function dealTimeline(input: TimelineInput, side: TimelineSide): { entries: TimelineEntry[]; upcoming: TimelineStep[] } {
  const { closing } = input;
  const now = input.now ?? new Date();
  const party = side !== "observer";
  const desk = side === "desk";
  const buyerSide = desk || side === "buyer";
  const sellerSide = desk || side === "seller";
  const ownerOf = (userId: string | null): TimelineOwner => (userId === input.sellerId ? "seller" : userId && input.buyerIds.includes(userId) ? "buyer" : "desk");
  // The desk's own people show by name to the desk and as the desk to everyone else.
  const whoOf = (userId: string | null) => {
    if (!userId) return "The desk";
    const person = input.people[userId];
    if (!person) return "A former account";
    if (person.role === "ADMIN") return desk ? `${person.name}, desk` : "The desk";
    return person.companyName || person.name;
  };
  const entries: TimelineEntry[] = [];
  const latest = (action: string, match?: (detail: string) => boolean) =>
    [...input.audits].reverse().find((event) => event.action === action && (!match || match(event.detail)));

  const opened = [`The checklist opened with ${countWord(input.steps.length)} steps.`];
  if (party) opened.unshift(`Awarded at ${money(closing.salePrice)}.`);
  if (buyerSide && closing.depositCents != null && closing.depositDueAt) opened.push(`A deposit of ${money(closing.depositCents / 100)} is due ${prettyDate(closing.depositDueAt)}.`);
  entries.push({ id: "opened", at: closing.openedAt, title: "Closing opened", detail: opened.join(" "), owner: "desk", who: "The desk" });

  for (const step of input.steps) {
    const at = step.status === "COMPLETE" ? (step.completedAt ?? (step.key === "CLOSED" ? closing.closedAt : null)) : null;
    if (at) {
      const marked = latest("CLOSING", (detail) => detail === step.key);
      entries.push({
        id: `step:${step.key}`,
        at,
        title: step.key === "CLOSED" ? "Deal closed" : `${stepLabel(step.key)} complete`,
        detail: step.note,
        owner: STEP_OWNER[step.key] ?? "desk",
        // The deposit step also completes on its own from the recorded wire, which is the desk's entry.
        who: marked ? whoOf(marked.actorId) : "The desk",
      });
    }
    for (const file of step.files) {
      entries.push({
        id: `file:${file.id}`,
        at: file.createdAt,
        title: `File added to ${stepLabel(step.key).toLowerCase()}`,
        detail: party ? file.originalName : "",
        owner: ownerOf(file.uploadedById),
        who: whoOf(file.uploadedById),
      });
    }
  }

  const seen = new Set<string>();
  for (const event of input.audits) {
    seen.add(event.action);
    const base = { id: `audit:${event.id}`, at: event.createdAt, who: whoOf(event.actorId) };
    if (event.action === "FUNDS_RECEIVED" && buyerSide) entries.push({ ...base, title: "Buyer funds recorded", detail: wireDetail(event.detail, desk), owner: "buyer" });
    if (event.action === "DEPOSIT_RECEIVED" && buyerSide) entries.push({ ...base, title: "Buyer deposit recorded", detail: wireDetail(event.detail, desk), owner: "buyer" });
    if (event.action === "PROCEEDS_SENT" && sellerSide) entries.push({ ...base, title: "Seller proceeds sent", detail: wireDetail(event.detail, desk), owner: "desk" });
    if (event.action === "SHARE_FUNDED" && buyerSide) entries.push({ ...base, title: "Group share funded", detail: event.detail, owner: "buyer" });
    if (event.action === "CLOSING_DATES") entries.push({ ...base, title: "Dates changed", detail: readable(event.detail), owner: "desk" });
    if (event.action === "WIRE_EDIT" && party) {
      entries.push({ ...base, title: "Wire instructions changed", detail: desk ? event.detail : "Confirm them by phone on a number you already trust before sending money.", owner: "desk" });
    }
    if (event.action === "CLOSING_OVERRIDE" && desk) entries.push({ ...base, title: "Step marked without the wire on record", detail: readable(event.detail), owner: "desk" });
    if (event.action === "DILIGENCE_WALK_AWAY") entries.push({ ...base, title: "The buyer walked away in diligence", detail: event.detail, owner: "buyer" });
  }
  for (const kickout of input.kickouts ?? []) {
    // A broker watching the deal sees that the closing changed, not the figures.
    const detail = party
      ? [`${kickout.loan} came out of the closing. Reason: ${kickout.reason}`, `The price came down ${money(kickout.priceCents / 100, 2)}.`, buyerSide && kickout.depositCents ? `The deposit came down ${money(kickout.depositCents / 100, 2)}.` : ""].filter(Boolean).join(" ")
      : "A loan came out of the closing before settlement.";
    entries.push({ id: `kickout:${kickout.id}`, at: kickout.at, title: "Loan taken out", detail, owner: "desk", who: whoOf(kickout.actorId) });
  }
  // Wires recorded before the desk logged them still belong on the record.
  if (buyerSide && closing.depositReceivedAt && closing.depositReceivedCents != null && !seen.has("DEPOSIT_RECEIVED")) {
    entries.push({ id: "wire:deposit", at: closing.depositReceivedAt, title: "Buyer deposit recorded", detail: wireFallback(closing.depositReceivedCents, closing.depositReceivedAt), owner: "buyer", who: "The desk" });
  }
  if (buyerSide && closing.fundsReceivedAt && closing.fundsReceivedCents != null && !seen.has("FUNDS_RECEIVED")) {
    entries.push({ id: "wire:funds", at: closing.fundsReceivedAt, title: "Buyer funds recorded", detail: wireFallback(closing.fundsReceivedCents, closing.fundsReceivedAt), owner: "buyer", who: "The desk" });
  }
  if (sellerSide && closing.proceedsSentAt && closing.proceedsSentCents != null && !seen.has("PROCEEDS_SENT")) {
    entries.push({ id: "wire:proceeds", at: closing.proceedsSentAt, title: "Seller proceeds sent", detail: wireFallback(closing.proceedsSentCents, closing.proceedsSentAt), owner: "desk", who: "The desk" });
  }
  // A walk-away is the cancel, so it isn't logged twice.
  if (closing.status === "CANCELED" && closing.canceledAt && !seen.has("DILIGENCE_WALK_AWAY")) {
    const canceled = latest("CLOSING_CANCELED");
    const detail = [closing.cancelReason ?? "", faultLine(closing.cancelFault, side)].filter(Boolean).join(" ");
    entries.push({ id: "canceled", at: closing.canceledAt, title: "Closing canceled", detail, owner: "desk", who: canceled ? whoOf(canceled.actorId) : "The desk" });
  }
  if (party) {
    for (const post of input.posts) {
      entries.push({ id: `post:${post.id}`, at: post.createdAt, title: "Message", detail: clip(post.body, 280), owner: ownerOf(post.authorId), who: whoOf(post.authorId) });
    }
  }
  entries.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));

  const upcoming: TimelineStep[] = [];
  if (closing.status === "OPEN") {
    const open = input.steps
      .filter((step) => step.status !== "COMPLETE")
      .map((step) => ({ step, due: effectiveDue(step, closing, input.days) }))
      .sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
    open.forEach(({ step, due }, index) => {
      upcoming.push({ key: step.key, label: stepLabel(step.key), owner: STEP_OWNER[step.key] ?? "desk", due, next: index === 0, late: stepClock(step.status, due, now) === "overdue" });
    });
  }
  return { entries, upcoming };
}

// The timeline for one viewer's side, from the database.
export async function loadDealTimeline(closingId: string, side: TimelineSide, now = new Date()) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    include: {
      steps: { include: { files: true } },
      funders: { select: { userId: true } },
      listing: { select: { sellerId: true, notes: { select: { id: true, streetAddress: true, city: true, state: true } } } },
      kickouts: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!closing) return null;
  const [inquiry, audits, thread, settings] = await Promise.all([
    closing.inquiryId ? prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : Promise.resolve(null),
    prisma.auditEvent.findMany({ where: { entityType: "closing", entityId: closingId, action: { in: TIMELINE_ACTIONS } }, orderBy: { createdAt: "asc" }, take: 500 }),
    side === "observer"
      ? Promise.resolve(null)
      : prisma.deskThread.findUnique({ where: { closingId }, select: { posts: { select: { id: true, authorId: true, body: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 300 } } }),
    getSettings(),
  ]);
  const posts = thread?.posts ?? [];
  const buyerIds = [inquiry?.buyerId, ...closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id));
  const ids = new Set<string>([closing.listing.sellerId, ...buyerIds]);
  for (const event of audits) if (event.actorId) ids.add(event.actorId);
  for (const post of posts) ids.add(post.authorId);
  for (const step of closing.steps) for (const file of step.files) if (file.uploadedById) ids.add(file.uploadedById);
  for (const kickout of closing.kickouts) ids.add(kickout.actorId);
  const loanNames = new Map(closing.listing.notes.map((note) => [note.id, `${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}`]));
  const users = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, companyName: true, role: true } });
  return dealTimeline(
    {
      closing: { ...closing, salePrice: Number(closing.salePrice), cancelFault: closing.cancelFault ?? null },
      steps: closing.steps,
      audits,
      posts,
      people: Object.fromEntries(users.map((user) => [user.id, user])),
      kickouts: closing.kickouts.map((kickout) => ({
        id: kickout.id,
        at: kickout.createdAt,
        loan: loanNames.get(kickout.noteId) ?? "A loan",
        reason: kickout.reason,
        priceCents: kickout.priceCents,
        depositCents: kickout.depositCents,
        actorId: kickout.actorId,
      })),
      sellerId: closing.listing.sellerId,
      buyerIds,
      days: targetDays(settings.closingTargetDays),
      now,
    },
    side,
  );
}

// "Nov 6, 2026, 2:15 PM UTC". Closing dates are UTC across the desk, so the log is too.
export function timelineStamp(date: Date) {
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date)} UTC`;
}

// The timeline as plain strings, for the page's client component and the CSV.
export function timelineView(timeline: { entries: TimelineEntry[]; upcoming: TimelineStep[] }) {
  return {
    entries: timeline.entries.map((entry) => ({
      id: entry.id,
      when: timelineStamp(entry.at),
      whenIso: entry.at.toISOString(),
      title: entry.title,
      detail: entry.detail,
      owner: ownerWord(entry.owner),
      who: entry.who,
    })),
    upcoming: timeline.upcoming.map((step) => ({
      key: step.key,
      label: step.label,
      owner: ownerWord(step.owner),
      due: step.due ? prettyDate(step.due) : null,
      next: step.next,
      late: step.late,
    })),
  };
}
