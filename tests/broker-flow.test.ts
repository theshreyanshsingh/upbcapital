import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { finalizeClosing, openClosing } from "../lib/closing-service";
import { prisma as appPrisma } from "../lib/prisma";

const prisma = new PrismaClient();

test.after(async () => {
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

async function closeTrade(input: { sellerId: string; buyerId: string; brokerId: string; client: string; brokerName: string }) {
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: input.sellerId,
      brokerId: input.brokerId,
      brokerRole: "SELLER_BROKER",
      clientSellerName: input.client,
      status: "APPROVED",
      title: `Broker flow ${input.client}`,
      notes: {
        create: {
          streetAddress: "1 Broker",
          city: "Miami",
          state: "FL",
          propertyType: "SFR",
          estimatedValue: 400000,
          lienPosition: "FIRST",
          upb: 200000,
          interestRate: 6,
          monthlyPi: 1200,
          paymentStatus: "PERFORMING",
          askingPrice: 100000,
        },
      },
    },
  });
  const inquiry = await prisma.inquiry.create({
    data: { listingId: listing.id, buyerId: input.buyerId, type: "OFFER", amount: 100000, message: "Flow" },
  });
  const closing = await openClosing({
    listingId: listing.id,
    inquiryId: inquiry.id,
    noteId: null,
    salePrice: 100000,
    title: listing.title,
  });
  await prisma.closingStep.updateMany({ where: { closingId: closing.id }, data: { status: "COMPLETE", completedAt: new Date() } });
  await finalizeClosing(closing.id);
  await finalizeClosing(closing.id);
  return { listing, closing };
}

test("closing posts one broker fee and refuses a second pass", async () => {
  const stamp = Date.now().toString(36);
  const broker = await prisma.user.create({
    data: {
      email: `broker-${stamp}@example.test`,
      name: "Flow Broker",
      role: "BROKER",
      accountStatus: "APPROVED",
      passwordHash: "x",
      brokerProfile: { create: { company: "Flow Brokerage", states: "FL", payoutNote: "Check." } },
    },
  });
  const buyer = await prisma.user.create({
    data: { email: `buyer-b-${stamp}@example.test`, name: "Flow Buyer", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  try {
    const { listing, closing } = await closeTrade({
      sellerId: broker.id,
      buyerId: buyer.id,
      brokerId: broker.id,
      client: "Helen Marsh",
      brokerName: broker.name,
    });
    const fees = await prisma.brokerFee.findMany({ where: { closingId: closing.id } });
    assert.equal(fees.length, 1);
    assert.equal(fees[0]?.status, "OWED");
    assert.ok((fees[0]?.amountCents ?? 0) > 0);
    const events = await prisma.revenueEvent.count({ where: { externalId: `closing:${closing.id}:broker:${broker.id}:SELLER_BROKER` } });
    assert.equal(events, 1);
    await prisma.revenueEvent.deleteMany({ where: { listingId: listing.id } });
  } finally {
    await prisma.user.delete({ where: { id: broker.id } });
    await prisma.user.delete({ where: { id: buyer.id } });
  }
});

test("a broker who buys the file is not paid", async () => {
  const stamp = Date.now().toString(36);
  const broker = await prisma.user.create({
    data: { email: `self-${stamp}@example.test`, name: "Self Broker", role: "BROKER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  try {
    const { listing, closing } = await closeTrade({
      sellerId: broker.id,
      buyerId: broker.id,
      brokerId: broker.id,
      client: "Someone Else",
      brokerName: broker.name,
    });
    const fees = await prisma.brokerFee.count({ where: { closingId: closing.id } });
    assert.equal(fees, 0);
    await prisma.revenueEvent.deleteMany({ where: { listingId: listing.id } });
  } finally {
    await prisma.user.delete({ where: { id: broker.id } });
  }
});
