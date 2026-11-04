import type { ClosingStepKey } from "@prisma/client";
import { CLOSING_STEPS, canCompleteStep, closingTotals } from "@/lib/closing";
import { closingSchedule, depositCents, depositTerms, targetDays } from "@/lib/closing-clock";
import { deskFeeBps } from "@/lib/desk-fees";
import { getEscrowProvider } from "@/lib/escrow";
import { postRevenueOnce } from "@/lib/ledger";
import { ensureBuyerHolding } from "@/lib/portfolio";
import { unset } from "@/lib/db-filters";
import { prisma } from "@/lib/prisma";
import { variance } from "@/lib/settlement";
import { getSettings } from "@/lib/settings";
import { postBrokerFees } from "@/lib/broker-pay";
import { ensureClosingThread } from "@/lib/threads";

// One open closing per loan. A whole-listing award needs every loan free, and a one-loan award needs
// that loan free and no whole-listing closing open. Returns why the award can't go ahead, or null.
export async function tradeConflict(listingId: string, noteId: string | null) {
  const [listing, open] = await Promise.all([
    prisma.listing.findUnique({ where: { id: listingId }, select: { status: true, notes: { select: { id: true, tradeStatus: true } } } }),
    prisma.closing.findMany({ where: { listingId, status: "OPEN" }, select: { noteId: true } }),
  ]);
  if (!listing) return "That listing no longer exists.";
  if (listing.status === "SOLD") return "This listing is already sold.";
  if (noteId) {
    const note = listing.notes.find((item) => item.id === noteId);
    if (!note) return "That loan is not on this listing.";
    if (note.tradeStatus !== "AVAILABLE") return `That loan is already ${note.tradeStatus === "SOLD" ? "sold" : "in contract"}.`;
    if (open.some((closing) => closing.noteId === null || closing.noteId === noteId)) return "An open closing already covers that loan. Finish or cancel it first.";
    return null;
  }
  if (open.length) return "This listing already has an open closing. Finish or cancel it first.";
  if (listing.notes.some((note) => note.tradeStatus !== "AVAILABLE")) return "Some loans on this listing are in contract or sold, so the whole listing can't be awarded.";
  return null;
}

export async function openClosing(input: {
  listingId: string;
  inquiryId?: string | null;
  deskBidId?: string | null;
  noteId: string | null;
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
  const settings = await getSettings();
  const bps = input.deskBidId
    ? deskFeeBps(settings.chargeDeskFees, settings.sellerCommissionBps)
    : { premiumBps: settings.buyerPremiumBps, commissionBps: settings.sellerCommissionBps };
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
  const schedule = closingSchedule(new Date(), targetDays(settings.closingTargetDays));
  // A buyer's deposit is set at award. The desk buying for its own book owes none.
  const deposit = depositTerms(settings);
  const depositDue = !input.deskBidId && deposit.bps > 0 ? new Date(Date.now() + deposit.days * 24 * 60 * 60 * 1000) : null;
  if (depositDue) schedule.due.BUYER_DEPOSIT = depositDue;
  const created = await prisma.closing.create({
    data: {
      listingId: input.listingId,
      inquiryId: input.inquiryId || null,
      deskBidId: input.deskBidId || null,
      noteId: input.noteId,
      salePrice: input.salePrice,
      buyerPremiumCents: fees.premiumCents,
      sellerCommissionCents: fees.commissionCents,
      buyerTotalCents: fees.buyerTotalCents,
      netToSellerCents: fees.netToSellerCents,
      provider: preview.provider,
      providerRef: preview.providerRef,
      wireInstructions: preview.instructions,
      targetCloseAt: schedule.targetCloseAt,
      ...(depositDue ? { depositCents: depositCents(input.salePrice, deposit.bps), depositDueAt: depositDue } : {}),
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
    if (closing.noteId) {
      await prisma.note.update({ where: { id: closing.noteId }, data: { tradeStatus: "SOLD" } });
    } else {
      await prisma.note.updateMany({ where: { listingId: closing.listingId }, data: { tradeStatus: "SOLD" } });
    }
    const notes = await prisma.note.findMany({ where: { listingId: closing.listingId } });
    const entireBookSold = notes.every((note) => note.tradeStatus === "SOLD");
    if (!closing.noteId || entireBookSold) {
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
    const notes = closing.noteId ? closing.listing.notes.filter((note) => note.id === closing.noteId) : closing.listing.notes;
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
export async function cancelOpenClosing(closingId: string, reason: string) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, include: { listing: true } });
  if (!closing || closing.status !== "OPEN") return null;
  // Only the write that moves it off OPEN cancels, so a close that landed first stays closed.
  const claimed = await prisma.closing.updateMany({
    where: { id: closingId, status: "OPEN" },
    data: { status: "CANCELED", canceledAt: new Date(), cancelReason: reason },
  });
  if (claimed.count !== 1) return null;
  if (closing.noteId) await prisma.note.update({ where: { id: closing.noteId }, data: { tradeStatus: "AVAILABLE" } });
  if (closing.inquiryId) await prisma.inquiry.update({ where: { id: closing.inquiryId }, data: { status: "DECLINED" } });
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
