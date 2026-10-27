import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { finalizeClosing, openClosing } from "../lib/closing-service";
import { feeBreakdown } from "../lib/money";
import { prisma as appPrisma } from "../lib/prisma";
import { getSettings } from "../lib/settings";

const prisma = new PrismaClient();

test("accepting a price opens a closing and closing it posts the ledger once", async () => {
  const stamp = Date.now().toString(36);
  const seller = await prisma.user.create({
    data: { email: `seller-${stamp}@example.test`, name: "Flow Seller", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  const buyer = await prisma.user.create({
    data: { email: `buyer-${stamp}@example.test`, name: "Flow Buyer", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "APPROVED",
      title: `Flow ${stamp}`,
      notes: {
        create: {
          streetAddress: "1 Flow",
          city: "Miami",
          state: "FL",
          propertyType: "SFR",
          estimatedValue: 400000,
          lienPosition: "FIRST",
          upb: 250000,
          interestRate: 6,
          monthlyPi: 1500,
          paymentStatus: "PERFORMING",
          askingPrice: 180000,
        },
      },
    },
  });
  const inquiry = await prisma.inquiry.create({
    data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 100000, message: "Flow bid" },
  });
  try {
    const closing = await openClosing({
      listingId: listing.id,
      inquiryId: inquiry.id,
      noteId: null,
      salePrice: 100000,
      title: listing.title,
    });
    const again = await openClosing({
      listingId: listing.id,
      inquiryId: inquiry.id,
      noteId: null,
      salePrice: 100000,
      title: listing.title,
    });
    assert.equal(again.id, closing.id);
    const settings = await getSettings();
    assert.equal(closing.buyerTotalCents, feeBreakdown(100000, settings.buyerPremiumBps, settings.sellerCommissionBps).buyerTotalCents);
    const steps = await prisma.closingStep.findMany({ where: { closingId: closing.id } });
    assert.equal(steps.length, 6);
    for (const step of steps) {
      await prisma.closingStep.update({ where: { id: step.id }, data: { status: "COMPLETE", completedAt: new Date() } });
    }
    await finalizeClosing(closing.id);
    await finalizeClosing(closing.id);
    const sold = await prisma.listing.findUnique({ where: { id: listing.id } });
    assert.equal(sold?.status, "SOLD");
    assert.equal(Number(sold?.salePrice), 100000);
    const premiums = await prisma.revenueEvent.count({ where: { externalId: `closing:${closing.id}:premium` } });
    assert.equal(premiums, 1);
  } finally {
    await prisma.revenueEvent.deleteMany({ where: { listingId: listing.id } });
    await prisma.user.delete({ where: { id: seller.id } });
    await prisma.user.delete({ where: { id: buyer.id } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  }
});
