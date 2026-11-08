import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  BOARD_CSV_COLUMNS,
  BOARD_METRICS,
  boardCsv,
  boardMetric,
  boardPack,
  boardPdf,
  boardView,
  exportPack,
  formatMetric,
  lastWholeMonth,
  liveSpan,
  lockBoardMonth,
  median,
  metricChange,
  metricValue,
  monthLabel,
  monthOf,
  monthOver,
  parseMonth,
  readPack,
  reviewSpans,
  shiftMonth,
  type BoardPack,
  type ListingDates,
} from "../lib/board-pack";
import { DESK_DENIED } from "../lib/desk-roles";
import { feesFor } from "../lib/fee-schedule";
import { revenueByMonth } from "../lib/finance-export";
import { prisma } from "../lib/prisma";
import { getSettings } from "../lib/settings";

// The fixtures live in 1996 (the window March to May, cohorts from November 1995), far from anything another
// builder's test writes today, so the figures here are this file's alone. Every row carries this run's suffix and is
// removed by id at the end.
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const MONTH = "1996-05";
const PRIOR = "1996-04";

const created = {
  users: [] as string[],
  listings: [] as string[],
  closings: [] as string[],
  inquiries: [] as string[],
  revenue: [] as string[],
  invoices: [] as string[],
  strikes: [] as string[],
  discrepancies: [] as string[],
  ofac: [] as string[],
};

async function user(name: string, role: "BUYER" | "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BROKER" | "ADMIN", createdAt: Date, extra: Record<string, unknown> = {}) {
  const row = await prisma.user.create({ data: { email: `board-${name}-${suffix}@example.test`, name: `Board ${name}`, role, accountStatus: "APPROVED", passwordHash: "x", createdAt, ...extra } });
  created.users.push(row.id);
  return row;
}

function note(upb: number, askingPrice: number, tradeStatus: "AVAILABLE" | "IN_CONTRACT" | "SOLD" = "AVAILABLE") {
  return { streetAddress: "1 Board St", city: "Testville", state: "ZZ", propertyType: "SFR" as const, estimatedValue: upb * 1.5, lienPosition: "FIRST" as const, upb, interestRate: 6, monthlyPi: 600, paymentStatus: "PERFORMING" as const, askingPrice, tradeStatus };
}

async function listing(title: string, data: Record<string, unknown>, notes: ReturnType<typeof note>[]) {
  const row = await prisma.listing.create({ data: { title: `board ${title} ${suffix}`, ...(data as { kind: "SINGLE"; sellerId: string }), notes: { create: notes } }, include: { notes: true } });
  created.listings.push(row.id);
  return row;
}

async function bid(listingId: string, buyerId: string, at: string, status: "OPEN" | "ACCEPTED" | "DECLINED" = "OPEN") {
  const row = await prisma.inquiry.create({ data: { listingId, buyerId, type: "OFFER", amount: 1000, status, createdAt: day(at) } });
  created.inquiries.push(row.id);
  return row;
}

async function closing(data: Record<string, unknown>) {
  const row = await prisma.closing.create({ data: { buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 0, netToSellerCents: 0, ...(data as { listingId: string; salePrice: number }) } });
  created.closings.push(row.id);
  return row;
}

async function ledger(type: "BUYER_PREMIUM" | "SELLER_COMMISSION" | "SUBSCRIPTION" | "BROKER_FEE", amountCents: number, at: string, extra: Record<string, unknown> = {}) {
  const row = await prisma.revenueEvent.create({ data: { type, amountCents, occurredAt: day(at), description: "board fixture", externalId: `board-${suffix}-${created.revenue.length}`, ...extra } });
  created.revenue.push(row.id);
}

type World = Awaited<ReturnType<typeof buildWorld>>;
let world: World;

async function buildWorld() {
  const sellerA = await user("seller-a", "INDIVIDUAL_SELLER", day("1996-01-10"));
  const sellerB = await user("seller-b", "INSTITUTIONAL_SELLER", day("1996-05-03"));
  const sellerC = await user("seller-c", "INDIVIDUAL_SELLER", day("1996-04-05"));
  const buyer1 = await user("buyer-1", "BUYER", day("1995-12-05"));
  const buyer2 = await user("buyer-2", "BUYER", day("1996-02-10"));
  const buyer3 = await user("buyer-3", "BUYER", day("1996-05-02"));
  const buyer4 = await user("buyer-4", "BUYER", day("1996-04-20"));
  // A seat on buyer 1's firm and a broker: neither is a new buyer or seller.
  await user("seat", "BUYER", day("1996-05-04"), { principalId: buyer1.id, seatRole: "TRADE" });
  await user("broker", "BROKER", day("1996-05-06"));
  const owner = await user("owner", "ADMIN", new Date(), { deskRole: "OWNER" });

  // L1: filed in April, approved four days later, three bids, awarded in May above its reserve and closed.
  const l1 = await listing("l1", { kind: "SINGLE", sellerId: sellerA.id, status: "SOLD", submittedAt: day("1996-04-02"), approvedAt: day("1996-04-06"), soldAt: day("1996-05-20"), salePrice: 85000, reservePrice: 80000 }, [note(100000, 90000, "SOLD")]);
  // L4: filed in March; an April award failed on the buyer in May, and a second award in May is still open.
  const l4 = await listing("l4", { kind: "SINGLE", sellerId: sellerA.id, status: "PENDING", submittedAt: day("1996-03-01"), approvedAt: day("1996-03-03") }, [note(60000, 55000, "IN_CONTRACT")]);
  // L2: a two-loan pool filed and approved in May, live at the month end with its fees kept at go-live.
  const l2 = await listing(
    "l2",
    { kind: "POOL", sellerId: sellerB.id, status: "APPROVED", submittedAt: day("1996-05-05"), approvedAt: day("1996-05-15"), reservePrice: 200000, feeBuyerPremiumBps: 250, feeSellerCommissionBps: 300 },
    [note(200000, 150000), note(50000.5, 30000)],
  );
  // L3: in review at the month end.
  const l3 = await listing("l3", { kind: "SINGLE", sellerId: sellerC.id, status: "UNDER_REVIEW", submittedAt: day("1996-05-25") }, [note(40000, 30000)]);
  // L5: sold by hand in February, so seller A had sold before May.
  const l5 = await listing("l5", { kind: "SINGLE", sellerId: sellerA.id, status: "SOLD", submittedAt: day("1996-01-15"), approvedAt: day("1996-01-20"), soldAt: day("1996-02-10"), salePrice: 20000 }, [note(25000, 22000, "SOLD")]);
  // L6: marked sold by hand in May, with no closing, at a price with cents.
  const l6 = await listing("l6", { kind: "SINGLE", sellerId: sellerC.id, status: "SOLD", submittedAt: day("1996-04-01"), approvedAt: day("1996-04-03"), soldAt: day("1996-05-28"), salePrice: 10000.25 }, [note(12000, 11000, "SOLD")]);

  const b4a = await bid(l4.id, buyer2.id, "1996-03-20", "DECLINED");
  await bid(l1.id, buyer2.id, "1996-04-10", "DECLINED");
  await bid(l1.id, buyer1.id, "1996-05-03", "DECLINED");
  const b1c = await bid(l1.id, buyer3.id, "1996-05-04", "ACCEPTED");
  const b4b = await bid(l4.id, buyer1.id, "1996-05-12", "ACCEPTED");
  await bid(l2.id, buyer1.id, "1996-05-18");

  const c1 = await closing({ listingId: l1.id, inquiryId: b1c.id, status: "COMPLETE", salePrice: 85000, buyerPremiumCents: 212500, sellerCommissionCents: 255000, openedAt: day("1996-05-06"), closedAt: day("1996-05-20") });
  const c2 = await closing({
    listingId: l4.id,
    inquiryId: b4a.id,
    status: "CANCELED",
    salePrice: 50000,
    openedAt: day("1996-04-15"),
    canceledAt: day("1996-05-10"),
    cancelFault: "BUYER",
    depositReceivedCents: 500000,
    depositStatus: "FORFEITED",
    depositResolvedAt: day("1996-05-12"),
  });
  await closing({ listingId: l4.id, inquiryId: b4b.id, status: "OPEN", salePrice: 48000, openedAt: day("1996-05-14") });

  await ledger("BUYER_PREMIUM", 212500, "1996-05-20", { listingId: l1.id });
  await ledger("SELLER_COMMISSION", 255000, "1996-05-20", { listingId: l1.id });
  await ledger("BUYER_PREMIUM", 25000, "1996-05-28", { listingId: l6.id });
  await ledger("SELLER_COMMISSION", 30000, "1996-05-28", { listingId: l6.id });
  // The credit note's ledger row, as lib/invoices.ts creditInvoice posts it.
  await ledger("BUYER_PREMIUM", -50000, "1996-05-25", { listingId: l1.id });
  await ledger("BROKER_FEE", 10000, "1996-05-20", { listingId: l1.id });
  // Buyer 1 pays Pro in April and May; buyer 2 pays in April only and churns. A simulated charge never counts.
  await ledger("SUBSCRIPTION", 24900, "1996-04-20", { userId: buyer1.id });
  await ledger("SUBSCRIPTION", 24900, "1996-05-20", { userId: buyer1.id });
  await ledger("SUBSCRIPTION", 24900, "1996-04-02", { userId: buyer2.id });
  await ledger("SUBSCRIPTION", 24900, "1996-05-10", { userId: buyer3.id, mock: true });

  const premium = await prisma.invoice.create({ data: { number: `BP-${suffix}-1`, kind: "PREMIUM", closingId: c1.id, userId: buyer3.id, amountCents: 212500, description: "board fixture", issuedAt: day("1996-05-20") } });
  const credit = await prisma.invoice.create({ data: { number: `BP-${suffix}-2`, kind: "CREDIT_NOTE", closingId: c1.id, userId: buyer3.id, amountCents: -50000, description: "board fixture", creditOfId: premium.id, issuedAt: day("1996-05-25") } });
  created.invoices.push(premium.id, credit.id);

  await prisma.buyerProfile.create({ data: { userId: buyer1.id, status: "APPROVED", reviewedAt: day("1996-05-08") } });
  await prisma.buyerProfile.create({ data: { userId: buyer2.id, status: "APPROVED", reviewedAt: day("1996-04-12") } });

  const strike = await prisma.buyerStrike.create({ data: { userId: buyer2.id, closingId: c2.id, reason: "board fixture", createdAt: day("1996-05-11") } });
  created.strikes.push(strike.id);
  const open = await prisma.fieldDiscrepancy.create({ data: { noteId: l2.notes[0].id, listingId: l2.id, field: "upb", status: "OPEN", createdAt: day("1996-05-16") } });
  const fixed = await prisma.fieldDiscrepancy.create({ data: { noteId: l1.notes[0].id, listingId: l1.id, field: "upb", status: "FIXED", createdAt: day("1996-04-08"), resolvedAt: day("1996-05-05") } });
  created.discrepancies.push(open.id, fixed.id);
  // The same party, name and entry screened twice is one hit. A clear screen is none.
  const name = `Board Party ${suffix}`;
  for (const row of [
    { name, result: "REVIEW", matched: "ENTRY 1", userId: buyer3.id, status: "CONFIRMED", createdAt: day("1996-05-04") },
    { name, result: "REVIEW", matched: "ENTRY 1", userId: buyer3.id, status: "CONFIRMED", createdAt: day("1996-05-05") },
    { name: `${name} Listing`, result: "REVIEW", matched: "ENTRY 2", listingId: l2.id, status: "OPEN", createdAt: day("1996-05-06") },
    { name, result: "CLEAR", userId: buyer4.id, createdAt: day("1996-05-06") },
  ]) {
    const check = await prisma.ofacCheck.create({ data: row });
    created.ofac.push(check.id);
  }
  return { sellerA, sellerB, sellerC, buyer1, buyer2, buyer3, buyer4, owner, l1, l2, l3, l4, l5, l6, c1, c2 };
}

test.before(async () => {
  // A run that stopped before its cleanup leaves its 1996 locks behind, and nothing else writes 1996.
  await prisma.boardSnapshot.deleteMany({ where: { month: { in: ["1996-03", PRIOR, MONTH] } } });
  world = await buildWorld();
});

test.after(async () => {
  try {
    const months = ["1996-03", PRIOR, MONTH];
    await prisma.boardSnapshot.deleteMany({ where: { month: { in: months } } });
    await prisma.auditEvent.deleteMany({ where: { entityType: "board", entityId: { in: months }, actorId: { in: created.users } } });
    await prisma.ofacCheck.deleteMany({ where: { id: { in: created.ofac } } });
    await prisma.fieldDiscrepancy.deleteMany({ where: { id: { in: created.discrepancies } } });
    await prisma.buyerStrike.deleteMany({ where: { id: { in: created.strikes } } });
    await prisma.invoice.deleteMany({ where: { id: { in: created.invoices } } });
    await prisma.revenueEvent.deleteMany({ where: { id: { in: created.revenue } } });
    await prisma.closing.deleteMany({ where: { id: { in: created.closings } } });
    await prisma.inquiry.deleteMany({ where: { id: { in: created.inquiries } } });
    await prisma.note.deleteMany({ where: { listingId: { in: created.listings } } });
    await prisma.reviewComment.deleteMany({ where: { listingId: { in: created.listings } } });
    await prisma.listing.deleteMany({ where: { id: { in: created.listings } } });
    await prisma.buyerProfile.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } finally {
    await prisma.$disconnect();
  }
});

const near = (actual: number | null, expected: number, digits = 6) => {
  assert.ok(actual != null, `expected ${expected}, got null`);
  assert.equal(Number(actual!.toFixed(digits)), Number(expected.toFixed(digits)));
};

// ---------------------------------------------------------------------------------------------------------------
// The rules, without the database.

test("months parse, shift across a year and say when they are over", () => {
  assert.equal(parseMonth("1996-05"), "1996-05");
  assert.equal(parseMonth("1996-13"), null);
  assert.equal(parseMonth("96-05"), null);
  assert.equal(parseMonth(" 2026-01 "), "2026-01");
  assert.equal(shiftMonth("1996-01", -1), "1995-12");
  assert.equal(shiftMonth("1995-12", 2), "1996-02");
  assert.equal(monthLabel("1996-05"), "May 1996");
  assert.equal(lastWholeMonth(day("2026-11-09")), "2026-10");
  assert.equal(lastWholeMonth(day("2026-01-01")), "2025-12");
  assert.equal(monthOver("2026-10", day("2026-11-01")), true);
  assert.equal(monthOver("2026-11", day("2026-11-30")), false);
  assert.equal(monthOf(day("1996-05-31")), "1996-05");
});

test("a median takes the middle value, or the mean of the middle two", () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([10, 2, 4]), 4);
  assert.equal(median([2, 2, 4, 10]), 3);
});

test("a listing's live and review spans come from its dates and its review entries", () => {
  const base: ListingDates = { status: "APPROVED", submittedAt: day("1996-05-01"), approvedAt: day("1996-05-03"), soldAt: null, withdrawnAt: null, contractAt: null, entries: [] };
  assert.deepEqual(liveSpan(base), { from: day("1996-05-03"), until: null });
  assert.deepEqual(reviewSpans(base), [{ from: day("1996-05-01"), until: day("1996-05-03") }]);
  // A launch date after approval starts the clock at launch; a contract ends it.
  assert.deepEqual(liveSpan({ ...base, launchAt: day("1996-05-10"), contractAt: day("1996-05-20") }), { from: day("1996-05-10"), until: day("1996-05-20") });
  // Declined after going live: live until the decline. Declined in review: never live.
  assert.deepEqual(liveSpan({ ...base, status: "REJECTED", entries: [{ action: "REJECT", at: day("1996-05-12") }] }), { from: day("1996-05-03"), until: day("1996-05-12") });
  assert.equal(liveSpan({ ...base, status: "REJECTED", approvedAt: null, entries: [{ action: "REJECT", at: day("1996-05-02") }] }), null);
  // Sent back after going live and resubmitted: live between, then in review again from the resubmit.
  const back = { ...base, status: "UNDER_REVIEW", entries: [{ action: "REQUEST_CHANGES", at: day("1996-05-08") }, { action: "RESUBMIT", at: day("1996-05-11") }] };
  assert.deepEqual(liveSpan(back), { from: day("1996-05-03"), until: day("1996-05-08") });
  assert.deepEqual(reviewSpans(back), [{ from: day("1996-05-01"), until: day("1996-05-03") }, { from: day("1996-05-11"), until: null }]);
  // Back with the seller isn't in review.
  assert.deepEqual(reviewSpans({ ...base, status: "CHANGES_REQUESTED", approvedAt: null, entries: [{ action: "REQUEST_CHANGES", at: day("1996-05-04") }] }), [{ from: day("1996-05-01"), until: day("1996-05-04") }]);
});

test("figures format in their units, and changes read as percent, points or days", () => {
  const gmv = boardMetric("volume.closed.gmvCents")!;
  const take = boardMetric("revenue.takeRate")!;
  const days = boardMetric("speed.submitToApproveDays")!;
  const bids = boardMetric("liquidity.bidsPerLiveListing")!;
  assert.equal(formatMetric(gmv, 9_500_025), "$95,000");
  assert.equal(formatMetric(take, 0.0497367), "4.97%");
  assert.equal(formatMetric(days, 3), "3.0 days");
  assert.equal(formatMetric(bids, null), "—");
  assert.deepEqual(metricChange(gmv, 200_000, 100_000), { text: "+100%", direction: "up", tone: "good", delta: 100_000, relative: 1 });
  // From nothing there is no percent, so the change is the amount.
  assert.equal(metricChange(gmv, 9_500_025, 0)?.text, "+$95,000");
  assert.equal(metricChange(take, 0.05, 0.04)?.text, "+1.0 pts");
  const slower = metricChange(days, 10, 3)!;
  assert.equal(slower.text, "+7.0 days");
  assert.equal(slower.tone, "bad");
  assert.equal(metricChange(days, 3, 3)?.text, "No change");
  assert.equal(metricChange(take, 0.05, null), null);
  // Every key resolves in an empty pack's shape, so a locked pack missing one reads as null rather than throwing.
  for (const metric of BOARD_METRICS) assert.equal(metricValue({}, metric.key), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The month, from the fixtures.

let pack: BoardPack;

test("volume counts listings, loans and UPB filed, approved, awarded and closed, in cents", async () => {
  pack = await boardPack(MONTH);
  const { volume } = pack.current;
  // L2's second loan is $50,000.50, which is 5,000,050 cents, not 5,000,000.
  assert.deepEqual(volume.listed, { listings: 2, loans: 3, upbCents: 29_000_050 });
  assert.deepEqual(volume.approved, { listings: 1, loans: 2, upbCents: 25_000_050 });
  // Two awards: L1 in May, and L4's second; L4's first was in April.
  assert.deepEqual(volume.awarded, { awards: 2, loans: 2, upbCents: 16_000_000, priceCents: 13_300_000 });
  // L1's closing and L6's sale by hand, at $10,000.25. L5's February sale is outside.
  assert.deepEqual(volume.closed, { sales: 2, loans: 2, upbCents: 11_200_000, gmvCents: 9_500_025 });
  assert.deepEqual(pack.prior.volume.listed, { listings: 2, loans: 2, upbCents: 11_200_000 });
  assert.equal(pack.prior.volume.awarded.awards, 1);
  assert.equal(pack.prior.volume.closed.gmvCents, 0);
});

test("revenue splits by type, nets credits, and matches the finance export's month", async () => {
  const { revenue } = pack.current;
  assert.equal(revenue.buyerPremiumCents, 237_500);
  assert.equal(revenue.sellerCommissionCents, 285_000);
  assert.equal(revenue.subscriptionCents, 24_900, "the simulated charge stays out");
  assert.equal(revenue.creditsCents, -50_000);
  assert.equal(revenue.netRevenueCents, 237_500 + 285_000 - 50_000 + 24_900);
  assert.equal(revenue.brokerFeesCents, 10_000);
  assert.equal(revenue.deskRevenueCents, 487_400);
  near(revenue.takeRate, 472_500 / 9_500_025);
  // One paying subscriber left at the month end, of two at its start.
  assert.equal(revenue.proSubscribers, 1);
  assert.equal(revenue.proMrrCents, 24_900);
  assert.equal(revenue.proLost, 1);
  near(revenue.proChurn, 0.5);
  assert.equal(pack.prior.revenue.proSubscribers, 2);
  assert.equal(pack.prior.revenue.proMrrCents, 49_800);
  assert.equal(pack.prior.revenue.proChurn, null, "nobody was paying at April's start");
  assert.equal(pack.prior.revenue.takeRate, null, "no GMV, no take rate");
  const finance = (await revenueByMonth()).find((row) => row.month === MONTH);
  assert.ok(finance);
  assert.equal(finance.deskRevenue, revenue.deskRevenueCents / 100);
  assert.equal(finance.buyerPremiums, (revenue.buyerPremiumCents + revenue.creditsCents) / 100);
  assert.equal(finance.creditNotes, -revenue.creditsCents / 100);
  assert.equal(finance.subscriptions, revenue.subscriptionCents / 100);
});

test("speed takes medians in days, and fall-through counts closings that ended in the month", () => {
  const { speed } = pack.current;
  assert.equal(speed.submitToApproveDays, 10);
  assert.equal(speed.liveToFirstBidDays, 3);
  assert.equal(speed.awardToCloseDays, 14);
  assert.deepEqual(speed.failed, { total: 1, buyer: 1, seller: 0, neither: 0, unrecorded: 0 });
  near(speed.fallThrough, 0.5);
  assert.equal(pack.prior.speed.submitToApproveDays, 3);
  assert.equal(pack.prior.speed.liveToFirstBidDays, 4);
  assert.equal(pack.prior.speed.fallThrough, null);
});

test("liquidity reads bids per live listing, three-bid listings, reserves and price over ask", () => {
  const { liquidity } = pack.current;
  // L1 until its award, L4 until its second, L6 until sold, and L2 from approval.
  assert.equal(liquidity.liveListings, 4);
  assert.equal(liquidity.bids, 4);
  near(liquidity.bidsPerLiveListing, 1);
  near(liquidity.threePlusShare, 0.25);
  // L1 cleared its reserve; L4's award had none.
  assert.equal(liquidity.withReserve, 1);
  assert.equal(liquidity.clearedReserve, 1);
  near(liquidity.clearedReserveShare, 1);
  near(liquidity.priceToAskMedian, (85_000 / 90_000 + 48_000 / 55_000) / 2);
  assert.equal(pack.prior.liquidity.liveListings, 3);
  near(pack.prior.liquidity.bidsPerLiveListing, 1 / 3);
  near(pack.prior.liquidity.threePlusShare, 0);
});

test("supply and demand counts new accounts, approved files, repeat sellers, active buyers and cohorts", () => {
  const { people } = pack.current;
  assert.equal(people.newSellers, 1);
  assert.equal(people.newBuyers, 1, "a seat and a broker are not new buyers");
  assert.equal(people.approvedFiles, 1);
  assert.equal(people.approvedFilesTotal, 2);
  assert.equal(people.sellersSold, 2);
  assert.equal(people.repeatSellers, 1, "seller A sold in February; seller C's first sale is this month");
  assert.equal(people.activeBuyers, 2);
  assert.deepEqual(pack.prior.people, { newSellers: 1, newBuyers: 1, approvedFiles: 1, approvedFilesTotal: 1, sellersSold: 0, repeatSellers: 0, activeBuyers: 1 });
  assert.deepEqual(
    pack.cohorts.map((row) => [row.month, row.signedUp, row.everBid, row.bidThisMonth, row.retention]),
    [
      ["1995-11", 0, 0, 0, null],
      ["1995-12", 1, 1, 1, 1],
      ["1996-01", 0, 0, 0, null],
      ["1996-02", 1, 1, 0, 0],
      ["1996-03", 0, 0, 0, null],
      ["1996-04", 1, 0, 0, 0],
    ],
  );
});

test("the pipeline is read at the month end, with fees at the listing's own terms or today's", async () => {
  const settings = await getSettings();
  const review = feesFor({}, settings, 30000);
  assert.deepEqual(pack.current.pipeline.review, { listings: 1, loans: 1, upbCents: 4_000_000, askCents: 3_000_000, feesCents: review.premiumCents + review.commissionCents });
  // L2 kept 2.5% and 3% at go-live: $4,500 and $5,400 on its $180,000 ask.
  assert.deepEqual(pack.current.pipeline.live, { listings: 1, loans: 2, upbCents: 25_000_050, askCents: 18_000_000, feesCents: 990_000 });
  assert.equal(pack.prior.pipeline.review.listings, 0);
  assert.equal(pack.prior.pipeline.live.listings, 3);
  assert.equal(pack.prior.pipeline.live.upbCents, 17_200_000);
});

test("risk counts open discrepancies, strikes, forfeits and OFAC hits by party", () => {
  assert.deepEqual(pack.current.risk, { openDiscrepancies: 1, discrepanciesRaised: 1, strikes: 1, depositsForfeited: 1, depositsForfeitedCents: 500_000, ofacHits: 2, ofacConfirmed: 1 });
  assert.equal(pack.prior.risk.openDiscrepancies, 1, "the April discrepancy was open at April's end");
  assert.equal(pack.prior.risk.ofacHits, 0);
});

test("month over month compares with April, and the trailing three months pool March to May", () => {
  const change = (key: string) => metricChange(boardMetric(key)!, metricValue(pack.current, key), metricValue(pack.prior, key));
  assert.equal(change("volume.listed.listings")?.text, "No change");
  assert.equal(change("volume.closed.gmvCents")?.text, "+$95,000");
  assert.deepEqual(change("revenue.subscriptionCents"), { text: "-50%", direction: "down", tone: "bad", delta: -24_900, relative: -0.5 });
  assert.equal(change("speed.submitToApproveDays")?.text, "+7.0 days");
  assert.equal(change("liquidity.bidsPerLiveListing")?.text, "+200%");
  assert.equal(change("liquidity.threePlusShare")?.text, "+25.0 pts");
  assert.equal(change("revenue.proChurn"), null);
  assert.equal(pack.priorLocked, false);
  const { trailing } = pack;
  assert.deepEqual(trailing.volume.listed, { listings: 5, loans: 6, upbCents: 46_200_050 });
  assert.equal(trailing.volume.awarded.awards, 3);
  assert.equal(trailing.volume.closed.gmvCents, 9_500_025);
  assert.equal(trailing.revenue.subscriptionCents, 74_700);
  // Medians pool the three months: submitted to approved 2, 2, 4 and 10 days.
  assert.equal(trailing.speed.submitToApproveDays, 3);
  assert.equal(trailing.speed.liveToFirstBidDays, 4);
  assert.equal(trailing.risk.discrepanciesRaised, 2);
});

test("the CSV is one row per figure and cohort line, in dollars, percent and days", () => {
  const csv = boardCsv(pack, "Live count");
  const lines = csv.split("\n");
  assert.equal(lines[0], BOARD_CSV_COLUMNS.join(","));
  assert.equal(lines.length, 1 + BOARD_METRICS.length + pack.cohorts.length * 4);
  // A label with a comma is quoted, so every row splits into the same nine fields.
  const fields = (line: string) => {
    const out: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted && char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        out.push(cell);
        cell = "";
      } else cell += char;
    }
    return [...out, cell];
  };
  const row = (label: string) => fields(lines.find((line) => fields(line)[1] === label)!);
  for (const line of lines.slice(1)) assert.equal(fields(line).length, BOARD_CSV_COLUMNS.length, line);
  assert.ok(lines.some((line) => line.includes('"GMV, closed sale price"')));
  assert.deepEqual(row("GMV, closed sale price"), ["Volume", "GMV, closed sale price", "USD", "95000.25", "0", "95000.25", "", "95000.25", "Live count"]);
  assert.deepEqual(row("Take rate"), ["Revenue", "Take rate", "percent", "4.97", "", "", "", "4.97", "Live count"]);
  assert.deepEqual(row("Pro subscriptions"), ["Revenue", "Pro subscriptions", "USD", "249", "498", "-249", "-50", "747", "Live count"]);
  assert.deepEqual(row("Median days, submitted to approved"), ["Speed and fall-through", "Median days, submitted to approved", "days", "10", "3", "7", "", "3", "Live count"]);
  // Month-end figures have no three-month total.
  assert.equal(row("Pro MRR")[7], "");
  assert.deepEqual(row("1995-12 signups, retention"), ["Buyer cohorts", "1995-12 signups, retention", "percent", "100", "", "", "", "", "Live count"]);
});

test("the PDF builds with every section and the definitions", async () => {
  const pdf = await PDFDocument.load(await boardPdf(pack, "Live count"));
  assert.ok(pdf.getPageCount() >= 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Locking.

test("only an owner locks, and only a month that is over", async () => {
  const sales = { id: `board-sales-${suffix}`, role: "ADMIN", deskRole: "SALES" };
  assert.equal((await lockBoardMonth(sales, { month: MONTH })).error, DESK_DENIED);
  assert.equal((await lockBoardMonth(world.owner, { month: "1996-13" })).error, "Choose a month to lock.");
  const running = await lockBoardMonth(world.owner, { month: monthOf(new Date()) });
  assert.match(running.error ?? "", /once it is over/);
  assert.equal(await prisma.boardSnapshot.count({ where: { month: MONTH } }), 0);
});

test("a locked prior month is what the next month compares with", async () => {
  const locked = await lockBoardMonth(world.owner, { month: PRIOR });
  assert.equal(locked.error, null);
  const snapshot = await prisma.boardSnapshot.findUniqueOrThrow({ where: { month: PRIOR } });
  assert.equal(snapshot.lockedById, world.owner.id);
  assert.equal(snapshot.note, "");
  assert.equal(readPack(snapshot.data)?.current.people.newSellers, 1);
  const event = await prisma.auditEvent.findFirst({ where: { entityType: "board", entityId: PRIOR, action: "BOARD_LOCK" } });
  assert.match(event?.detail ?? "", /April 1996 locked/);
  // A seller who signed up in April turns up late. April's live count moves; May still compares with April as locked.
  await user("seller-late-april", "INDIVIDUAL_SELLER", day("1996-04-25"));
  const may = await boardPack(MONTH);
  assert.equal(may.priorLocked, true);
  assert.equal(may.prior.people.newSellers, 1);
  const april = await boardView(PRIOR);
  assert.equal(april.pack.current.people.newSellers, 1);
  assert.equal(april.live.current.people.newSellers, 2);
  assert.deepEqual(april.differences.map((row) => row.key), ["people.newSellers"]);
});

test("a locked month shows its locked figures, marks a recount that differs, and re-locks only with a note", async () => {
  const first = await lockBoardMonth(world.owner, { month: MONTH, note: "First board pack." });
  assert.equal(first.error, null);
  assert.equal(first.relocked, false);
  // Re-locking needs a sentence.
  assert.match((await lockBoardMonth(world.owner, { month: MONTH })).error ?? "", /Say why/);
  assert.match((await lockBoardMonth(world.owner, { month: MONTH, note: "redo" })).error ?? "", /Say why/);

  await user("seller-late-may", "INDIVIDUAL_SELLER", day("1996-05-30"));
  const view = await boardView(MONTH);
  assert.equal(view.lock?.lockedBy, world.owner.name);
  assert.equal(view.lock?.note, "First board pack.");
  assert.equal(view.pack.current.people.newSellers, 1, "the page shows the figure as locked");
  assert.deepEqual(view.differences, [{ key: "people.newSellers", label: "New sellers", locked: 1, live: 2 }]);
  // The export carries the locked figures too.
  const exported = await exportPack(MONTH);
  assert.match(exported.basis, /^Locked \d{4}-\d{2}-\d{2} by Board owner$/);
  assert.equal(exported.pack.current.people.newSellers, 1);
  assert.match(boardCsv(exported.pack, exported.basis).split("\n")[1], /Locked \d{4}-\d{2}-\d{2} by Board owner$/);

  const again = await lockBoardMonth(world.owner, { month: MONTH, note: "  A late seller   signup was backfilled. " });
  assert.equal(again.error, null);
  assert.equal(again.relocked, true);
  assert.deepEqual(again.differences.map((row) => row.key), ["people.newSellers"]);
  const snapshot = await prisma.boardSnapshot.findUniqueOrThrow({ where: { month: MONTH } });
  assert.equal(snapshot.note, "A late seller signup was backfilled.");
  assert.equal(readPack(snapshot.data)?.current.people.newSellers, 2);
  assert.equal(await prisma.boardSnapshot.count({ where: { month: MONTH } }), 1, "one snapshot per month");
  const event = await prisma.auditEvent.findFirst({ where: { entityType: "board", entityId: MONTH, action: "BOARD_RELOCK" } });
  assert.match(event?.detail ?? "", /Note: A late seller signup was backfilled\. 1 figure changed: New sellers 1 to 2\./);
  assert.equal((await boardView(MONTH)).differences.length, 0);
});
