import assert from "node:assert/strict";
import test from "node:test";
import { buyerSideEmails, cancelOpenClosing, completeDepositFromWire, finalizeClosing, openClosing } from "../lib/closing-service";
import { deskFeeBps } from "../lib/desk-fees";
import { getEscrowProvider } from "../lib/escrow";
import { prisma } from "../lib/prisma";
import { balanceDueCents, buyerFundsCheck, economicsRows, moneyGate, proceedsGate, statementLines, statementSide } from "../lib/settlement";
import { getSettings } from "../lib/settings";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

const base = {
  id: "c1", salePrice: 100000, buyerPremiumCents: 250000, sellerCommissionCents: 300000, buyerTotalCents: 10250000, netToSellerCents: 9700000,
  openedAt: at("2026-11-01"), closedAt: null, status: "OPEN",
  fundsReceivedCents: null, fundsReceivedAt: null, fundsReference: null, proceedsSentCents: null, proceedsSentAt: null, proceedsReference: null,
  depositCents: 1000000, depositReceivedCents: null, depositReceivedAt: null, depositReference: null,
} as {
  id: string; salePrice: number; buyerPremiumCents: number; sellerCommissionCents: number; buyerTotalCents: number; netToSellerCents: number;
  openedAt: Date; closedAt: Date | null; status: string;
  fundsReceivedCents: number | null; fundsReceivedAt: Date | null; fundsReference: string | null;
  proceedsSentCents: number | null; proceedsSentAt: Date | null; proceedsReference: string | null;
  depositCents: number | null; depositReceivedCents: number | null; depositReceivedAt: Date | null; depositReference: string | null;
};

test("a desk purchase never charges a buyer premium, and the setting only waives the commission", () => {
  assert.deepEqual(deskFeeBps(true, 300), { premiumBps: 0, commissionBps: 300 });
  assert.deepEqual(deskFeeBps(false, 300), { premiumBps: 0, commissionBps: 0 });
});

test("the default wire text carries no money figures, since both sides read it", async () => {
  const opened = await getEscrowProvider("manual").open({ closingId: "cls_x", listingTitle: "Sample", salePrice: 1000, buyerTotalCents: 102500, netToSellerCents: 97000, wireInstructions: "" });
  assert.match(opened.instructions, /Reference cls_x/);
  assert.doesNotMatch(opened.instructions, /1025|970|all-in|net to seller/i);
});

test("the deposit counts toward what the buyer owes, on the page and in the statement", () => {
  const paid = { ...base, depositReceivedCents: 1000000, depositReceivedAt: at("2026-11-04"), depositReference: "DEP1", fundsReceivedCents: 9250000, fundsReceivedAt: at("2026-11-20"), fundsReference: "FED9" };
  assert.equal(balanceDueCents(paid), 9250000);
  assert.equal(buyerFundsCheck(paid).state, "match");
  const lines = statementLines(paid, "buyer")[0].lines;
  assert.deepEqual(lines.map((line) => line.label), ["Purchase price", "Buyer premium", "Due from buyer", "Deposit received", "Balance due", "Funds received"]);
  assert.equal(lines[3].cents, 1000000);
  assert.equal(lines[4].cents, 9250000);
  assert.match(lines[5].detail ?? "", /2026-11-20 · FED9 · matches/);
  const short = { ...paid, fundsReceivedCents: 8250000 };
  assert.equal(buyerFundsCheck(short).state, "short");
  assert.match(statementLines(short, "buyer")[0].lines[5].detail ?? "", /short \$10,000\.00/);
  // No deposit on the closing keeps the old four lines.
  assert.equal(statementLines({ ...base, depositCents: null }, "buyer")[0].lines.length, 4);
});

test("a group seat holder's statement shows their own share", () => {
  const share = { amount: 40000, premiumCents: 100000, status: "FUNDED", fundedAt: at("2026-11-18") };
  const sections = statementLines(base, "buyer", 0, share);
  assert.deepEqual(sections.map((section) => section.heading), ["Your share"]);
  assert.equal(sections[0].lines[2].cents, 4100000);
  assert.equal(sections[0].lines[3].cents, 4100000);
  assert.equal(statementLines(base, "buyer", 0, { ...share, status: "PENDING", fundedAt: null })[0].lines[3].cents, null);
});

test("each side sees only its own figures on the closing page", () => {
  const labels = (side: Parameters<typeof economicsRows>[1]) => economicsRows(base, side).map((row) => row.label);
  assert.deepEqual(labels("buyer"), ["Sale price", "Buyer premium", "Buyer all-in"]);
  assert.deepEqual(labels("seller"), ["Sale price", "Seller commission", "Net to seller"]);
  assert.deepEqual(labels("desk"), ["Sale price", "Buyer premium", "Buyer all-in", "Seller commission", "Net to seller"]);
  assert.deepEqual(labels("observer"), []);
  const mine = economicsRows(base, "buyer", { amount: 40000, premiumCents: 100000, status: "PENDING", fundedAt: null });
  assert.deepEqual(mine.map((row) => row.cents), [4000000, 100000, 4100000]);
  const people = { sellerId: "s", buyerId: "b", funderIds: ["b", "f"] };
  assert.equal(statementSide({ ...people, role: "ADMIN", userId: "d" }), "desk");
  assert.equal(statementSide({ ...people, role: "INDIVIDUAL_SELLER", userId: "s" }), "seller");
  assert.equal(statementSide({ ...people, role: "BUYER", userId: "f" }), "buyer");
  assert.equal(statementSide({ ...people, role: "BROKER", userId: "r" }), "observer");
});

test("money steps wait for the recorded wire, and a group waits for every share", () => {
  assert.equal(moneyGate("CLOSED", base, []), "Buyer funds aren't recorded.");
  assert.match(moneyGate("PAYMENT_RECEIVED", { ...base, fundsReceivedCents: 9250000 }, []) ?? "", /short \$10,000\.00, counting the deposit/);
  assert.equal(moneyGate("CLOSED", { ...base, fundsReceivedCents: 9250000, depositReceivedCents: 1000000 }, []), null);
  assert.equal(moneyGate("CLOSED", { ...base, fundsReceivedCents: 10250000 }, [{ status: "FUNDED" }, { status: "PENDING" }]), "1 of 2 group shares isn't marked funded.");
  assert.equal(moneyGate("CLOSED", { ...base, fundsReceivedCents: 10250000 }, [{ status: "FUNDED" }, { status: "FUNDED" }]), null);
  assert.equal(moneyGate("BUYER_DEPOSIT", base, []), "The buyer's deposit isn't recorded.");
  assert.equal(moneyGate("BUYER_DEPOSIT", { ...base, depositCents: null }, []), null);
  assert.equal(moneyGate("ASSIGNMENT", base, []), null);
  assert.equal(moneyGate("CLOSED", { ...base, deskBidId: "bid" }, []), null);
});

test("the seller's proceeds wait for the buyer's money and the note, and a desk purchase still waits for the note", () => {
  const steps = (...done: string[]) => ["COLLATERAL_TRANSFER", "ASSIGNMENT"].map((key) => ({ key, status: done.includes(key) ? "COMPLETE" : "PENDING" }));
  const paid = { ...base, fundsReceivedCents: 10250000 };
  assert.equal(proceedsGate(base, [], steps("COLLATERAL_TRANSFER", "ASSIGNMENT")), "Buyer funds aren't recorded.");
  assert.match(proceedsGate({ ...base, fundsReceivedCents: 9250000 }, [], steps("COLLATERAL_TRANSFER", "ASSIGNMENT")) ?? "", /short \$10,000\.00/);
  assert.equal(proceedsGate(paid, [{ status: "PENDING" }], steps("COLLATERAL_TRANSFER", "ASSIGNMENT")), "1 of 1 group share isn't marked funded.");
  assert.equal(proceedsGate(paid, [], steps()), "The collateral file transfer and the assignment and allonge aren't marked complete.");
  assert.equal(proceedsGate(paid, [], steps("COLLATERAL_TRANSFER")), "The assignment and allonge isn't marked complete.");
  assert.equal(proceedsGate(paid, [], steps("ASSIGNMENT")), "The collateral file transfer isn't marked complete.");
  assert.equal(proceedsGate(paid, [], steps("COLLATERAL_TRANSFER", "ASSIGNMENT")), null);
  assert.equal(proceedsGate({ ...base, deskBidId: "bid" }, [], steps()), "The collateral file transfer and the assignment and allonge aren't marked complete.");
  assert.equal(proceedsGate({ ...base, deskBidId: "bid" }, [], steps("COLLATERAL_TRANSFER", "ASSIGNMENT")), null);
});

async function makeDeal(tag: string) {
  const seller = await prisma.user.create({ data: { email: `cm-seller-${tag}@example.org`, name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const buyer = await prisma.user.create({ data: { email: `cm-buyer-${tag}@example.org`, name: `Buyer ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  const second = await prisma.user.create({ data: { email: `cm-second-${tag}@example.org`, name: `Second ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "PENDING",
      approvedAt: new Date(),
      title: `Closings medium ${tag}`,
      notes: {
        create: [{
          streetAddress: "4 Ledger Way", city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST", upb: 120000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 100000, estimatedValue: 180000,
        }] as never,
      },
    },
  });
  const users = [seller, buyer, second];
  return { seller, buyer, second, listing, users };
}

async function cleanDeal(deal: Awaited<ReturnType<typeof makeDeal>>) {
  const closings = await prisma.closing.findMany({ where: { listingId: deal.listing.id }, select: { id: true } });
  await prisma.deskThread.deleteMany({ where: { closingId: { in: closings.map((row) => row.id) } } });
  await prisma.revenueEvent.deleteMany({ where: { listingId: deal.listing.id } });
  await prisma.buyerHolding.deleteMany({ where: { closingId: { in: closings.map((row) => row.id) } } });
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [deal.listing.id, ...closings.map((row) => row.id)] } } });
  await prisma.listing.deleteMany({ where: { id: deal.listing.id } });
  await prisma.notification.deleteMany({ where: { toEmail: { in: deal.users.map((user) => user.email) } } });
  await prisma.user.deleteMany({ where: { id: { in: deal.users.map((user) => user.id) } } });
}

async function openBuyerClosing(deal: Awaited<ReturnType<typeof makeDeal>>) {
  const inquiry = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 100000 } });
  const closing = await openClosing({ listingId: deal.listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 100000, title: deal.listing.title });
  await prisma.closingStep.updateMany({ where: { closingId: closing.id }, data: { status: "COMPLETE", completedAt: new Date() } });
  return { inquiry, closing };
}

test("a cancel that lands first is never turned into a completed sale", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const { closing } = await openBuyerClosing(deal);
    assert.ok(await cancelOpenClosing(closing.id, "Buyer walked"));
    const after = await finalizeClosing(closing.id);
    assert.equal(after?.status, "CANCELED");
    assert.equal(await prisma.revenueEvent.count({ where: { listingId: deal.listing.id } }), 0);
    assert.equal((await prisma.note.findFirstOrThrow({ where: { listingId: deal.listing.id } })).tradeStatus, "AVAILABLE");
    assert.notEqual((await prisma.listing.findUniqueOrThrow({ where: { id: deal.listing.id } })).status, "SOLD");
  } finally {
    await cleanDeal(deal);
  }
});

test("a close that lands first can't be canceled after it", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const { closing, inquiry } = await openBuyerClosing(deal);
    assert.equal((await finalizeClosing(closing.id))?.status, "COMPLETE");
    assert.equal(await cancelOpenClosing(closing.id, "Too late"), null);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).status, "COMPLETE");
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } })).status, "ACCEPTED");
  } finally {
    await cleanDeal(deal);
  }
});

test("a close and a cancel at the same moment leave one consistent outcome", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const { closing } = await openBuyerClosing(deal);
    const [finished, canceled] = await Promise.all([finalizeClosing(closing.id), cancelOpenClosing(closing.id, "Race")]);
    const after = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
    const revenue = await prisma.revenueEvent.count({ where: { listingId: deal.listing.id } });
    if (after.status === "COMPLETE") {
      assert.equal(canceled, null);
      assert.equal(finished?.status, "COMPLETE");
      assert.ok(revenue > 0);
    } else {
      assert.equal(after.status, "CANCELED");
      assert.ok(canceled);
      assert.notEqual(finished?.status, "COMPLETE");
      assert.equal(revenue, 0);
    }
  } finally {
    await cleanDeal(deal);
  }
});

test("a desk purchase posts no buyer premium", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const settings = await getSettings();
    const bid = await prisma.deskBid.create({ data: { listingId: deal.listing.id, amount: 100000, status: "ACCEPTED" } });
    const closing = await openClosing({ listingId: deal.listing.id, deskBidId: bid.id, noteId: null, salePrice: 100000, title: deal.listing.title });
    assert.equal(closing.buyerPremiumCents, 0);
    assert.equal(closing.buyerTotalCents, 10000000);
    assert.equal(closing.sellerCommissionCents, settings.chargeDeskFees ? Math.round((10000000 * settings.sellerCommissionBps) / 10000) : 0);
    await prisma.closingStep.updateMany({ where: { closingId: closing.id }, data: { status: "COMPLETE", completedAt: new Date() } });
    await finalizeClosing(closing.id);
    assert.equal(await prisma.revenueEvent.count({ where: { listingId: deal.listing.id, type: "BUYER_PREMIUM" } }), 0);
  } finally {
    await prisma.deskHolding.deleteMany({ where: { listingId: deal.listing.id } });
    await cleanDeal(deal);
  }
});

test("the deposit step completes from a recorded deposit that covers it, not from seat holders", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const inquiry = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 100000 } });
    const closing = await openClosing({ listingId: deal.listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 100000, title: deal.listing.title });
    await prisma.closing.update({ where: { id: closing.id }, data: { depositCents: 1000000 } });
    await prisma.closingFunder.createMany({
      data: [
        { closingId: closing.id, userId: deal.buyer.id, amount: 60000, premiumCents: 150000, percent: 60, status: "FUNDED", fundedAt: new Date() },
        { closingId: closing.id, userId: deal.second.id, amount: 40000, premiumCents: 100000, percent: 40, status: "FUNDED", fundedAt: new Date() },
      ],
    });
    const depositStep = () => prisma.closingStep.findFirstOrThrow({ where: { closingId: closing.id, key: "BUYER_DEPOSIT" } });
    assert.equal(await completeDepositFromWire(closing.id), false);
    assert.equal((await depositStep()).status, "PENDING");
    await prisma.closing.update({ where: { id: closing.id }, data: { depositReceivedCents: 500000, depositReceivedAt: at("2026-11-04") } });
    assert.equal(await completeDepositFromWire(closing.id), false);
    await prisma.closing.update({ where: { id: closing.id }, data: { depositReceivedCents: 1000000 } });
    assert.equal(await completeDepositFromWire(closing.id), true);
    const step = await depositStep();
    assert.equal(step.status, "COMPLETE");
    assert.match(step.note, /Deposit of \$10,000\.00 received 2026-11-04/);
    assert.equal(await completeDepositFromWire(closing.id), false);

    // Wire changes and recorded settlements reach the lead buyer and every seat holder, once each.
    const emails = await buyerSideEmails(closing.id);
    assert.deepEqual([...emails].sort(), [deal.buyer.email, deal.second.email].sort());
  } finally {
    await cleanDeal(deal);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
