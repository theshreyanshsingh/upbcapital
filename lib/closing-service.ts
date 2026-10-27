import type { ClosingStepKey } from "@prisma/client";
import { CLOSING_STEPS, canCompleteStep, closingTotals } from "@/lib/closing";
import { deskFeeBps } from "@/lib/desk-fees";
import { getEscrowProvider } from "@/lib/escrow";
import { postRevenueOnce } from "@/lib/ledger";
import { ensureBuyerHolding } from "@/lib/portfolio";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { postBrokerFees } from "@/lib/broker-pay";
import { ensureClosingThread } from "@/lib/threads";

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
    ? deskFeeBps(settings.chargeDeskFees, settings.buyerPremiumBps, settings.sellerCommissionBps)
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
      steps: {
        create: CLOSING_STEPS.map((step) => ({ key: step.key })),
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
  if (!closing) return closing;
  if (!canCompleteStep(closing.steps, "CLOSED") && closing.status !== "COMPLETE") return closing;
  const externalPremium = `closing:${closing.id}:premium`;
  const externalCommission = `closing:${closing.id}:commission`;
  if (closing.status !== "COMPLETE") {
    await prisma.closing.update({
      where: { id: closing.id },
      data: { status: "COMPLETE", closedAt: new Date() },
    });
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
      where: { OR: [{ closingId: closing.id }, { listingId: closing.listingId, noteId: closing.noteId }] },
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
  if (closing.buyerPremiumCents > 0 || closing.sellerCommissionCents > 0) {
  await postRevenueOnce([
    {
      type: "BUYER_PREMIUM",
      amountCents: closing.buyerPremiumCents,
      listingId: closing.listingId,
      description: `Buyer premium on ${closing.listing.title}`,
      externalId: externalPremium,
    },
    {
      type: "SELLER_COMMISSION",
      amountCents: closing.sellerCommissionCents,
      listingId: closing.listingId,
      description: `Seller commission on ${closing.listing.title}`,
      externalId: externalCommission,
    },
  ]);
  }
  await postBrokerFees(closing.id);
  return prisma.closing.findUnique({ where: { id: closingId } });
}

export function isClosingStepKey(value: string): value is ClosingStepKey {
  return CLOSING_STEPS.some((step) => step.key === value);
}
