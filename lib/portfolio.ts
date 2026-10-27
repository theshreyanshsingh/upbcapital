import { annualYield } from "@/lib/holdings";
import { prisma } from "@/lib/prisma";

export async function ensureBuyerHolding(closingId: string) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    include: { listing: { include: { notes: true } }, funders: true },
  });
  if (!closing || closing.status !== "COMPLETE" || !closing.inquiryId) return null;
  const notes = closing.noteId ? closing.listing.notes.filter((note) => note.id === closing.noteId) : closing.listing.notes;
  const upb = notes.reduce((sum, note) => sum + Number(note.upb), 0);
  const monthly = notes.reduce((sum, note) => sum + Number(note.monthlyPi), 0);
  if (closing.funders.length) {
    await prisma.groupBuy.updateMany({ where: { closingId }, data: { status: "CLOSED" } });
    for (const funder of closing.funders) {
      const existing = await prisma.buyerHolding.findFirst({ where: { closingId, userId: funder.userId } });
      if (existing) continue;
      const share = Number(funder.percent) / 100;
      await prisma.buyerHolding.create({
        data: {
          userId: funder.userId,
          closingId,
          listingId: closing.listingId,
          title: `${closing.listing.title} · ${Number(funder.percent).toFixed(1)}%`,
          costBasis: Number(funder.amount) + funder.premiumCents / 100,
          upb: upb * share,
          sharePercent: funder.percent,
          underwrittenYield: annualYield(monthly * share, Number(funder.amount)),
          acquiredAt: closing.closedAt ?? new Date(),
        },
      });
    }
    return prisma.buyerHolding.findFirst({ where: { closingId } });
  }
  const existing = await prisma.buyerHolding.findFirst({ where: { closingId } });
  if (existing) return existing;
  const inquiry = await prisma.inquiry.findUnique({ where: { id: closing.inquiryId } });
  if (!inquiry) return null;
  const price = Number(closing.salePrice);
  return prisma.buyerHolding.create({
    data: {
      userId: inquiry.buyerId,
      closingId: closing.id,
      listingId: closing.listingId,
      title: closing.listing.title,
      costBasis: closing.buyerTotalCents / 100,
      upb,
      sharePercent: 100,
      underwrittenYield: annualYield(monthly, price),
      acquiredAt: closing.closedAt ?? new Date(),
    },
  });
}
