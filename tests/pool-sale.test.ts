import assert from "node:assert/strict";
import test from "node:test";
import { askSeller, awardCombination, awardOffer, awardPartial, checkAward, counterLoanPrices, partAsked, readPartAsk, recordSellerCounter } from "../lib/awards";
import { closingCovers, closingIsWhole, closingLoans } from "../lib/closing";
import { cancelOpenClosing, dealTimeline, finalizeClosing, type TimelineInput } from "../lib/closing-service";
import { literal } from "../lib/db-filters";
import { checkOffer, writeInquiry } from "../lib/inquiry";
import { closingRates, kickOutLoan, kickoutTerms } from "../lib/kickouts";
import { loanPriceProblem, loanPricesFromForm, pricesFor, spreadByAsk, standingLoanPrices, sumPrices } from "../lib/loan-prices";
import { loadPoolPlan, optimizePool, planKey, type OptimizerBid, type OptimizerLoan } from "../lib/pool-optimizer";
import { prisma } from "../lib/prisma";
import { getSettings } from "../lib/settings";
import { statementLines, statementScope } from "../lib/settlement";
import { strikeLimitOf } from "../lib/strikes";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Loan prices

test("loan prices must price every loan and add up to the bid within a dollar", () => {
  const loanIds = ["a", "b", "c"];
  assert.equal(loanPriceProblem({ prices: { a: 100, b: 100, c: 100 }, loanIds, amount: 300 }), null);
  assert.equal(loanPriceProblem({ prices: { a: 100, b: 100, c: 100.9 }, loanIds, amount: 300 }), null);
  assert.equal(loanPriceProblem({ prices: { a: 100, b: 100, c: 99.01 }, loanIds, amount: 300 }), null);
  assert.match(loanPriceProblem({ prices: { a: 100, b: 100, c: 102 }, loanIds, amount: 300 }) ?? "", /add up to \$302, not your bid of \$300/);
  assert.match(loanPriceProblem({ prices: { a: 150, b: 150 }, loanIds, amount: 300 }) ?? "", /Price every loan/);
  assert.match(loanPriceProblem({ prices: { a: 100, b: 100, c: 100, z: 1 }, loanIds, amount: 301 }) ?? "", /isn't in this pool/);
  assert.match(loanPriceProblem({ prices: { a: 299.5, b: 0.25, c: 0.25 }, loanIds, amount: 300 }) ?? "", /at least \$1/);
});

test("the bid form's loan prices read as dollars, blank is none, and part of the pool needs prices", () => {
  const form = (entries: [string, string][]) => {
    const data = new FormData();
    for (const [name, value] of entries) data.append(name, value);
    return data;
  };
  assert.deepEqual(loanPricesFromForm(form([["loanPrice_a", ""], ["loanPrice_b", ""]])), { prices: null, allowPartial: false, error: null });
  assert.deepEqual(loanPricesFromForm(form([["loanPrice_a", "$1,200"], ["loanPrice_b", "800"], ["allowPartial", "yes"]])), { prices: { a: 1200, b: 800 }, allowPartial: true, error: null });
  assert.match(loanPricesFromForm(form([["allowPartial", "yes"]])).error ?? "", /Price each loan/);
  assert.match(loanPricesFromForm(form([["loanPrice_a", "lots"]])).error ?? "", /in dollars/);
  // Prices stop describing the bid once its total moves without them.
  assert.deepEqual(standingLoanPrices({ a: 1200, b: 800 }, 2000), { a: 1200, b: 800 });
  assert.equal(standingLoanPrices({ a: 1200, b: 800 }, 2100), null);
  assert.equal(standingLoanPrices({ a: "x" }, 2000), null);
  // A spread by asking price adds up to the bid exactly.
  const spread = spreadByAsk(100001, [{ id: "a", ask: 50000 }, { id: "b", ask: 30000 }, { id: "c", ask: null }]);
  assert.equal(sumPrices(spread), 100001);
  assert.equal(spread.c, 100001 - spread.a - spread.b);
  // A closing's own loans, priced to its price.
  assert.deepEqual(pricesFor({ a: 60, b: 40, c: 10 }, ["a", "b"], 100), { a: 60, b: 40, c: 10 });
  assert.equal(pricesFor({ a: 60, b: 40 }, ["a", "c"], 100), null);
  assert.equal(pricesFor({ a: 60, b: 40 }, ["a", "b"], 110), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The optimiser, on plain figures

const LOANS: OptimizerLoan[] = [
  { id: "A", label: "Loan 1", available: true },
  { id: "B", label: "Loan 2", available: true },
  { id: "C", label: "Loan 3", available: true },
];

function bid(id: string, over: Partial<OptimizerBid>): OptimizerBid {
  return { id, bidder: `Bidder ${id}`, buyerId: `buyer-${id}`, noteId: null, price: 0, loanPrices: null, allowPartial: false, excluded: null, headroom: null, ...over };
}

test("the optimiser mixes a part of a pool bid with one-loan bids when that beats every whole bid", () => {
  const bids = [
    bid("W", { price: 300 }),
    bid("P", { price: 290, loanPrices: { A: 120, B: 90, C: 80 }, allowPartial: true }),
    bid("LB", { noteId: "B", price: 110 }),
    bid("LC", { noteId: "C", price: 95 }),
  ];
  const plan = optimizePool({ loans: LOANS, bids, premiumBps: 200 });
  assert.equal(plan.method, "exact");
  assert.equal(plan.proceeds, 325);
  assert.equal(plan.bestWhole?.bidId, "W");
  assert.equal(plan.gain, 25);
  assert.deepEqual(plan.unsold, []);
  const byBid = Object.fromEntries(plan.picks.map((pick) => [pick.bidId, pick]));
  assert.deepEqual(byBid.P, { bidId: "P", bidder: "Bidder P", kind: "part", noteIds: ["A"], price: 120, overFunds: false });
  assert.equal(byBid.LB.kind, "loan");
  assert.equal(byBid.LC.price, 95);
  assert.equal(byBid.W, undefined);
});

test("without part permission a priced pool bid is all or nothing, and the best whole bid can win", () => {
  const bids = [
    bid("W", { price: 300 }),
    bid("P", { price: 290, loanPrices: { A: 120, B: 90, C: 80 }, allowPartial: false }),
    bid("LB", { noteId: "B", price: 110 }),
    bid("LC", { noteId: "C", price: 95 }),
  ];
  const plan = optimizePool({ loans: LOANS, bids, premiumBps: 200 });
  assert.deepEqual(plan.picks.map((pick) => [pick.bidId, pick.kind, pick.price]), [["W", "whole", 300]]);
  assert.equal(plan.gain, 0);
  // Loans no whole bid wants stay unsold when only one-loan bids are left.
  const loose = optimizePool({ loans: LOANS, bids: bids.slice(2), premiumBps: 200 });
  assert.equal(loose.proceeds, 205);
  assert.deepEqual(loose.unsold, ["A"]);
  assert.equal(loose.bestWhole, null);
  assert.equal(loose.gain, null);
  // A part-permitted bid that is best on every loan is the bid taken whole, at its own price.
  const whole = optimizePool({ loans: LOANS, bids: [bid("P", { price: 290, loanPrices: { A: 120, B: 90, C: 80 }, allowPartial: true })], premiumBps: 200 });
  assert.deepEqual(whole.picks.map((pick) => [pick.kind, pick.price, pick.noteIds.length]), [["whole", 290, 3]]);
});

test("past twelve whole bids the search is greedy and still finds the best whole-pool outcome", () => {
  const many = Array.from({ length: 13 }, (_, index) => bid(`W${index}`, { price: 200 + index * 7 }));
  const loanBids = [bid("LA", { noteId: "A", price: 100 }), bid("LB", { noteId: "B", price: 90 }), bid("LC", { noteId: "C", price: 50 })];
  const greedy = optimizePool({ loans: LOANS, bids: [...many, ...loanBids], premiumBps: 200 });
  const exact = optimizePool({ loans: LOANS, bids: [...many, ...loanBids], premiumBps: 200, exactLimit: 20 });
  assert.equal(greedy.method, "greedy");
  assert.equal(exact.method, "exact");
  assert.equal(planKey(greedy), planKey(exact));
  // The best whole bid, 284, beats the loans one by one, 240.
  assert.deepEqual(greedy.picks.map((pick) => [pick.bidId, pick.price]), [["W12", 284]]);
  // When the loans one by one win, the greedy pass takes no whole bid at all.
  const rich = [bid("LA", { noteId: "A", price: 150 }), bid("LB", { noteId: "B", price: 120 }), bid("LC", { noteId: "C", price: 100 })];
  const split = optimizePool({ loans: LOANS, bids: [...many, ...rich], premiumBps: 200 });
  assert.equal(split.method, "greedy");
  assert.equal(split.proceeds, 370);
  assert.equal(split.gain, 370 - 284);
  assert.equal(planKey(split), planKey(optimizePool({ loans: LOANS, bids: [...many, ...rich], premiumBps: 200, exactLimit: 20 })));
});

test("excluded bids never win, traded loans are left out, and a bid past the buyer's funds is flagged", () => {
  const bids = [
    bid("X", { price: 999, excluded: "It passed its good-until date." }),
    bid("W", { price: 300, headroom: 250 }),
    bid("LA", { noteId: "A", price: 10, excluded: "The buyer's bidding is paused for closings that didn't complete." }),
  ];
  const plan = optimizePool({ loans: LOANS, bids, premiumBps: 200 });
  assert.deepEqual(plan.picks.map((pick) => pick.bidId), ["W"]);
  assert.equal(plan.picks[0].overFunds, true);
  assert.deepEqual(plan.excluded.map((row) => row.bidId).sort(), ["LA", "X"]);
  // Once a loan has traded, whole bids can't be taken, but a part-permitted one still can.
  const traded = LOANS.map((loan) => (loan.id === "A" ? { ...loan, available: false } : loan));
  const after = optimizePool({
    loans: traded,
    bids: [bid("W", { price: 300 }), bid("P", { price: 290, loanPrices: { A: 120, B: 90, C: 80 }, allowPartial: true }), bid("LA", { noteId: "A", price: 130 })],
    premiumBps: 200,
  });
  assert.deepEqual(after.picks.map((pick) => [pick.bidId, pick.kind, pick.noteIds.join(",")]), [["P", "part", "B,C"]]);
  assert.deepEqual(after.excluded.map((row) => row.bidId).sort(), ["LA", "W"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

const loanRow = (street: string, ask: number) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: ask, estimatedValue: 150000,
});

async function makePool(opts: { reserve?: number | null; buyers?: number } = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN") =>
    prisma.user.create({
      data: {
        email: `ps-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const buyers = [];
  for (let index = 0; index < (opts.buyers ?? 4); index += 1) {
    const buyer = await person(`buyer${index}`, "BUYER");
    await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED", entityType: "LLC", entityName: `Fund ${index} ${tag}`, homesControlled: 4, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY) } });
    buyers.push(buyer);
  }
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      reservePrice: opts.reserve === undefined ? null : opts.reserve,
      title: `Pool sale ${tag}`,
      notes: { create: [loanRow("1 First St", 50000), loanRow("2 Second St", 30000), loanRow("3 Third St", 20000)] as never },
    },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
  return { tag, seller, desk, buyers, listing, users: [seller, desk, ...buyers] };
}

type Pool = Awaited<ReturnType<typeof makePool>>;

async function cleanPool(pool: Pool) {
  const listingId = pool.listing.id;
  const userIds = pool.users.map((user) => user.id);
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId }, select: { id: true } })).map((row) => row.id);
  const closingIds = (await prisma.closing.findMany({ where: { listingId }, select: { id: true } })).map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [listingId, ...inquiryIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId }, { inquiryId: { in: inquiryIds } }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId } });
  await prisma.buyerHolding.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.buyerStrike.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: pool.users.map((user) => user.email) } }, { subject: { contains: literal(pool.listing.title) } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// A bid as the bid form writes it, with its opening message.
async function placeBid(pool: Pool, buyerIndex: number, amount: number, extra: { noteId?: string; loanPrices?: Record<string, number>; allowPartial?: boolean; expiresAt?: Date } = {}) {
  const user = pool.buyers[buyerIndex];
  const inquiry = await writeInquiry({
    user,
    listing: { ...pool.listing, seller: { email: pool.seller.email } },
    type: "OFFER",
    noteId: extra.noteId ?? "",
    amount,
    message: "Test bid.",
    expiresAt: extra.expiresAt ?? null,
    loanPrices: extra.loanPrices ?? null,
    allowPartial: extra.allowPartial,
  });
  return inquiry;
}

const status = async (inquiryId: string) => (await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiryId } })).status;
const trade = async (noteId: string) => (await prisma.note.findUniqueOrThrow({ where: { id: noteId } })).tradeStatus;

test("the server holds a pool bid's loan prices to the bid, and a counter clears them unless the buyer re-prices", async () => {
  const pool = await makePool();
  try {
    const [a, b, c] = pool.listing.notes;
    const listing = pool.listing;
    const base = { user: pool.buyers[0], listing, noteId: "", amount: 100000, goodUntil: "" };
    assert.match((await checkOffer({ ...base, loanPrices: { [a.id]: 50000, [b.id]: 30000, [c.id]: 25000 } })).error ?? "", /add up to \$105,000/);
    assert.match((await checkOffer({ ...base, loanPrices: { [a.id]: 50000, [b.id]: 50000 } })).error ?? "", /Price every loan/);
    assert.match((await checkOffer({ ...base, allowPartial: true })).error ?? "", /Price each loan/);
    assert.match((await checkOffer({ ...base, noteId: a.id, amount: 50000, loanPrices: { [a.id]: 50000 } })).error ?? "", /whole pool/);
    assert.equal((await checkOffer({ ...base, loanPrices: { [a.id]: 50000, [b.id]: 30000, [c.id]: 20000.5 }, allowPartial: true })).error, null);
    const inquiry = await placeBid(pool, 0, 100000, { loanPrices: { [a.id]: 50000, [b.id]: 30000, [c.id]: 20000 }, allowPartial: true });
    const stored = await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    assert.deepEqual(stored.loanPrices, { [a.id]: 50000, [b.id]: 30000, [c.id]: 20000 });
    assert.equal(stored.allowPartial, true);
    // A counter on the total clears them. The buyer's own new price may carry new ones, held to the new total.
    assert.deepEqual(await counterLoanPrices({ inquiry: stored, amount: 110000, prices: null, allowPartial: false }), { error: null, data: { loanPrices: null, allowPartial: null }, cleared: true });
    assert.match((await counterLoanPrices({ inquiry: stored, amount: 110000, prices: { [a.id]: 50000, [b.id]: 30000, [c.id]: 20000 }, allowPartial: true })).error ?? "", /not your bid of \$110,000/);
    const repriced = await counterLoanPrices({ inquiry: stored, amount: 110000, prices: { [a.id]: 55000, [b.id]: 33000, [c.id]: 22000 }, allowPartial: true });
    assert.equal(repriced.error, null);
    assert.equal(repriced.data?.allowPartial, true);
    // The seller's counter clears them too, since it is a price for the whole bid.
    const check = await checkAward(inquiry.id);
    if (check.error !== null) throw new Error(check.error);
    await askSeller(check.offer, 100000);
    assert.equal((await recordSellerCounter(inquiry.id, pool.seller.id, 120000)).error, null);
    const countered = await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    assert.equal(countered.loanPrices, null);
    assert.equal(countered.allowPartial, null);
  } finally {
    await cleanPool(pool);
  }
});

test("the optimiser reads the pool's bids as the award checks do: expired, withdrawn and paused bids are left out", async () => {
  const pool = await makePool();
  try {
    const [a, b, c] = pool.listing.notes;
    const settings = await getSettings();
    const priced = await placeBid(pool, 0, 100000, { loanPrices: { [a.id]: 60000, [b.id]: 25000, [c.id]: 15000 }, allowPartial: true });
    const loanB = await placeBid(pool, 1, 35000, { noteId: b.id });
    const lapsed = await placeBid(pool, 2, 500000, { expiresAt: new Date(Date.now() + DAY) });
    await prisma.inquiry.update({ where: { id: lapsed.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const paused = await placeBid(pool, 3, 400000);
    await prisma.buyerStrike.createMany({ data: Array.from({ length: strikeLimitOf(settings.strikeLimit) }, (_, index) => ({ userId: pool.buyers[3].id, closingId: `none-${index}`, reason: "Earlier miss." })) });
    const withdrawn = await placeBid(pool, 1, 450000);
    await prisma.inquiry.update({ where: { id: withdrawn.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
    const loaded = await loadPoolPlan(pool.listing.id);
    assert.ok(loaded);
    const { plan } = loaded;
    assert.equal(plan.method, "exact");
    assert.deepEqual(plan.excluded.map((row) => row.bidId).sort(), [lapsed.id, paused.id, withdrawn.id].sort());
    assert.match(plan.excluded.find((row) => row.bidId === paused.id)?.reason ?? "", /paused/);
    assert.match(plan.excluded.find((row) => row.bidId === lapsed.id)?.reason ?? "", /good-until/);
    // Loan B goes to its own bid, the rest of the pool to the priced bid at its loan prices.
    const byBid = Object.fromEntries(plan.picks.map((pick) => [pick.bidId, pick]));
    assert.deepEqual(byBid[priced.id].noteIds.sort(), [a.id, c.id].sort());
    assert.equal(byBid[priced.id].price, 75000);
    assert.equal(byBid[loanB.id].price, 35000);
    assert.equal(plan.proceeds, 110000);
    assert.equal(plan.bestWhole?.bidId, priced.id);
    assert.equal(plan.gain, 10000);
  } finally {
    await cleanPool(pool);
  }
});

test("a partial award needs the seller's word on that part, opens a closing for it and keeps the pool live", async () => {
  const pool = await makePool();
  try {
    const [a, b, c] = pool.listing.notes;
    const priced = await placeBid(pool, 0, 100000, { loanPrices: { [a.id]: 50000, [b.id]: 30000, [c.id]: 20000 }, allowPartial: true });
    const whole = await placeBid(pool, 1, 95000);
    const other = await placeBid(pool, 2, 90000, { loanPrices: { [a.id]: 45000, [b.id]: 25000, [c.id]: 20000 }, allowPartial: true });
    const onA = await placeBid(pool, 3, 40000, { noteId: a.id });
    const part = [a.id, b.id];
    // A bid without part permission, the whole pool as a part, or a loan the buyer didn't price can't be split.
    assert.match((await checkAward(whole.id, { noteIds: part })).error ?? "", /no loan prices/);
    assert.match((await checkAward(priced.id, { noteIds: [a.id, b.id, c.id] })).error ?? "", /whole pool/);
    assert.match((await checkAward(priced.id, { noteIds: [a.id, a.id] })).error ?? "", /priced, once/);
    assert.match((await checkAward(priced.id, { noteIds: [a.id, "nope"] })).error ?? "", /not on this listing/);
    assert.equal((await awardPartial(priced.id, part, pool.desk.id)).error, "The seller hasn't approved this price for these loans.");
    const check = await checkAward(priced.id, { noteIds: part });
    if (check.error !== null) throw new Error(check.error);
    assert.equal(check.price, 80000);
    assert.equal(check.agreed, null);
    await askSeller(check.offer, check.price, { noteIds: part, actorId: pool.desk.id });
    assert.deepEqual((await partAsked(await prisma.inquiry.findUniqueOrThrow({ where: { id: priced.id } })))?.sort(), [...part].sort());
    assert.deepEqual(readPartAsk("asked 2026-11-07T10:00:00.000Z · 2 loans · x,y"), { at: "2026-11-07T10:00:00.000Z", noteIds: ["x", "y"] });
    // A seller can't counter a question about part of a pool.
    assert.match((await recordSellerCounter(priced.id, pool.seller.id, 90000)).error ?? "", /part of the pool/);
    // The seller approves the part. That approval covers this part only, not another part or the whole bid.
    await prisma.inquiry.update({ where: { id: priced.id }, data: { sellerApprovedAmount: 80000, sellerAnsweredAt: new Date(), sellerDeclined: false } });
    assert.equal((await checkAward(priced.id, { noteIds: [a.id, c.id] })).agreed, null);
    assert.equal((await checkAward(priced.id)).agreed, null);
    const award = await awardPartial(priced.id, part, pool.desk.id);
    assert.equal(award.error, null);
    const closing = await prisma.closing.findUniqueOrThrow({ where: { id: award.closingId! } });
    assert.deepEqual([...closing.noteIds].sort(), [...part].sort());
    assert.equal(closing.noteId, null);
    assert.equal(Number(closing.salePrice), 80000);
    assert.equal(closing.inquiryId, priced.id);
    assert.equal(await trade(a.id), "IN_CONTRACT");
    assert.equal(await trade(b.id), "IN_CONTRACT");
    assert.equal(await trade(c.id), "AVAILABLE");
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: pool.listing.id } })).status, "APPROVED");
    assert.equal(await status(priced.id), "ACCEPTED");
    // The whole bid and the bid on a sold loan close. A priced bid that can still win loan C stays open.
    assert.equal(await status(whole.id), "DECLINED");
    assert.equal(await status(onA.id), "DECLINED");
    assert.equal(await status(other.id), "OPEN");
    // The rest of the pool can still sell to the other priced bid, within the reserve this time.
    await prisma.listing.update({ where: { id: pool.listing.id }, data: { reservePrice: 15000 } });
    const rest = await awardPartial(other.id, [c.id], pool.desk.id);
    assert.equal(rest.error, null);
    assert.equal(await trade(c.id), "IN_CONTRACT");
    // A whole award is refused now that loans are in contract.
    assert.match((await checkAward(whole.id)).error ?? "", /declined/);
  } finally {
    await cleanPool(pool);
  }
});

test("the desk awards the optimiser's combination in one go, and a component that fails is reported", async () => {
  const pool = await makePool({ reserve: 1000 });
  try {
    const [a, b, c] = pool.listing.notes;
    const priced = await placeBid(pool, 0, 100000, { loanPrices: { [a.id]: 60000, [b.id]: 25000, [c.id]: 15000 }, allowPartial: true });
    const loanB = await placeBid(pool, 1, 35000, { noteId: b.id });
    const loanC = await placeBid(pool, 2, 18000, { noteId: c.id });
    const whole = await placeBid(pool, 3, 105000);
    const loaded = await loadPoolPlan(pool.listing.id);
    assert.ok(loaded);
    assert.equal(loaded.plan.proceeds, 113000);
    assert.equal(loaded.plan.gain, 8000);
    assert.equal(loaded.plan.picks.length, 3);
    // The buyer of loan C withdraws after the plan was made, so that award fails and the rest go through.
    await prisma.inquiry.update({ where: { id: loanC.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
    const outcomes = await awardCombination(loaded.plan.picks, pool.desk.id);
    const by = Object.fromEntries(outcomes.map((row) => [row.bidId, row]));
    assert.equal(by[priced.id].result, "awarded");
    assert.equal(by[loanB.id].result, "awarded");
    assert.equal(by[loanC.id].result, "failed");
    assert.match(by[loanC.id].error ?? "", /withdrew/);
    assert.equal(await status(whole.id), "DECLINED");
    const closings = await prisma.closing.findMany({ where: { listingId: pool.listing.id } });
    assert.equal(closings.length, 2);
    const part = closings.find((row) => row.inquiryId === priced.id)!;
    assert.deepEqual(part.noteIds, [a.id]);
    assert.equal(Number(part.salePrice), 60000);
    assert.equal(closings.find((row) => row.inquiryId === loanB.id)?.noteId, b.id);
    assert.equal(await trade(c.id), "AVAILABLE");
    // A plan that needs the seller asks once, and asking again waits rather than resending.
    const again = await makePool();
    try {
      const [x, y, z] = again.listing.notes;
      const bidA = await placeBid(again, 0, 100000, { loanPrices: { [x.id]: 60000, [y.id]: 25000, [z.id]: 15000 }, allowPartial: true });
      await placeBid(again, 1, 30000, { noteId: y.id });
      const plan = (await loadPoolPlan(again.listing.id))!.plan;
      const first = await awardCombination(plan.picks, again.desk.id);
      assert.ok(first.every((row) => row.result === "asked"));
      const askedAt = (await prisma.inquiry.findUniqueOrThrow({ where: { id: bidA.id } })).sellerAskedAt;
      const second = await awardCombination(plan.picks, again.desk.id);
      assert.ok(second.every((row) => row.result === "asked"));
      assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: bidA.id } })).sellerAskedAt?.getTime(), askedAt?.getTime());
    } finally {
      await cleanPool(again);
    }
  } finally {
    await cleanPool(pool);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Kick-outs

test("a kick-out's price, fees and deposit follow the loan price or its share of the asks", () => {
  const closing = { salePrice: 100000, buyerPremiumCents: 250000, sellerCommissionCents: 300000, depositCents: 1000000, depositReceivedCents: null, fundsReceivedCents: null };
  assert.deepEqual(closingRates(closing), { premiumBps: 250, commissionBps: 300 });
  const loans = [{ id: "a", ask: 50000 }, { id: "b", ask: 30000 }, { id: "c", ask: 20000 }];
  const priced = kickoutTerms({ closing, loans, noteId: "b", loanPrices: { a: 45000, b: 40000, c: 15000 } });
  assert.equal(priced.basis, "loanPrice");
  assert.equal(priced.dropCents, 4000000);
  assert.equal(priced.salePrice, 60000);
  assert.equal(priced.premiumCents, 150000);
  assert.equal(priced.commissionCents, 180000);
  assert.equal(priced.buyerTotalCents, 6150000);
  assert.equal(priced.netToSellerCents, 5820000);
  assert.equal(priced.depositCents, 600000);
  assert.equal(priced.depositDropCents, 400000);
  assert.equal(priced.fundsRecorded, false);
  // Prices that don't add up to the closing, or none at all, fall back on the asking prices.
  const share = kickoutTerms({ closing, loans, noteId: "b", loanPrices: { a: 45000, b: 40000, c: 25000 } });
  assert.equal(share.basis, "askShare");
  assert.equal(share.dropCents, 3000000);
  assert.equal(share.depositCents, 700000);
  const equal = kickoutTerms({ closing, loans: loans.map((loan) => ({ ...loan, ask: 0 })), noteId: "c", loanPrices: null });
  assert.equal(equal.basis, "equalShare");
  assert.equal(equal.dropCents, 3333333);
  // Buyer money already on record past the new total is the excess to return.
  const paid = kickoutTerms({ closing: { ...closing, depositReceivedCents: 1000000, fundsReceivedCents: 9250000 }, loans, noteId: "b", loanPrices: null });
  assert.equal(paid.fundsRecorded, true);
  assert.equal(paid.excessCents, 10250000 - paid.buyerTotalCents);
});

test("a kick-out takes the loan out at its loan price, puts it back on the listing, and refuses the last loan", async () => {
  const pool = await makePool({ reserve: 1000 });
  try {
    const [a, b, c] = pool.listing.notes;
    const priced = await placeBid(pool, 0, 100000, { loanPrices: { [a.id]: 50000, [b.id]: 30000, [c.id]: 20000 }, allowPartial: true });
    const award = await awardPartial(priced.id, [a.id, b.id], pool.desk.id);
    assert.equal(award.error, null);
    const before = await prisma.closing.findUniqueOrThrow({ where: { id: award.closingId! } });
    // The deposit recorded already counts, so the kick-out warns that money over the new total goes back.
    await prisma.closing.update({ where: { id: before.id }, data: { depositReceivedCents: before.depositCents ?? 0, fundsReceivedCents: before.buyerTotalCents - (before.depositCents ?? 0) } });
    assert.match((await kickOutLoan({ closingId: before.id, noteId: b.id, reason: "", actorId: pool.desk.id })).error ?? "", /Say why/);
    assert.match((await kickOutLoan({ closingId: before.id, noteId: c.id, reason: "Title defect.", actorId: pool.desk.id })).error ?? "", /isn't on this closing/);
    const result = await kickOutLoan({ closingId: before.id, noteId: b.id, reason: "Title defect on the assignment.", actorId: pool.desk.id });
    assert.equal(result.error, null);
    assert.equal(result.basis, "loanPrice");
    assert.equal(result.dropCents, 3000000);
    assert.ok(result.excessCents > 0);
    const after = await prisma.closing.findUniqueOrThrow({ where: { id: before.id }, include: { kickouts: true } });
    const rates = closingRates({ ...before, salePrice: Number(before.salePrice) });
    assert.equal(Number(after.salePrice), 50000);
    assert.deepEqual(after.noteIds, [a.id]);
    assert.equal(after.buyerPremiumCents, Math.round((5000000 * rates.premiumBps) / 10000));
    assert.equal(after.sellerCommissionCents, Math.round((5000000 * rates.commissionBps) / 10000));
    assert.equal(after.buyerTotalCents, 5000000 + after.buyerPremiumCents);
    assert.equal(after.netToSellerCents, 5000000 - after.sellerCommissionCents);
    if (before.depositCents != null) assert.equal(after.depositCents, Math.round((before.depositCents * 5000000) / 8000000));
    assert.equal(after.kickouts.length, 1);
    assert.equal(after.kickouts[0].priceCents, 3000000);
    assert.equal(after.kickouts[0].depositCents, (before.depositCents ?? 0) - (after.depositCents ?? 0));
    assert.equal(after.kickouts[0].reason, "Title defect on the assignment.");
    assert.equal(await trade(b.id), "AVAILABLE");
    assert.equal(await trade(a.id), "IN_CONTRACT");
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: before.id, action: "CLOSING_KICKOUT" } }));
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: pool.buyers[0].email, subject: { contains: "Loan taken out" } } }));
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: pool.seller.email, subject: { contains: "Loan taken out" } } }));
    // One loan left: the desk cancels instead.
    assert.match((await kickOutLoan({ closingId: before.id, noteId: a.id, reason: "Another defect.", actorId: pool.desk.id })).error ?? "", /last loan\. Cancel the closing instead/);
  } finally {
    await cleanPool(pool);
  }
});

test("a whole-pool closing with no loan prices drops a loan by its share of the asks and puts the pool back on the book", async () => {
  const pool = await makePool({ reserve: 1000 });
  try {
    const [a, b, c] = pool.listing.notes;
    const whole = await placeBid(pool, 0, 90000);
    const award = await awardOffer(whole.id, pool.desk.id);
    assert.equal(award.error, null);
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: pool.listing.id } })).status, "PENDING");
    const before = await prisma.closing.findUniqueOrThrow({ where: { id: award.closingId! } });
    assert.equal(closingIsWhole(before), true);
    const result = await kickOutLoan({ closingId: before.id, noteId: c.id, reason: "The borrower paid off.", actorId: pool.desk.id });
    assert.equal(result.error, null);
    assert.equal(result.basis, "askShare");
    // Loan C asks 20,000 of 100,000, so it takes a fifth of the price.
    assert.equal(result.dropCents, 1800000);
    const after = await prisma.closing.findUniqueOrThrow({ where: { id: before.id } });
    assert.equal(Number(after.salePrice), 72000);
    assert.deepEqual([...after.noteIds].sort(), [a.id, b.id].sort());
    assert.equal(await trade(c.id), "AVAILABLE");
    assert.equal(await trade(a.id), "IN_CONTRACT");
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: pool.listing.id } });
    assert.equal(listing.status, "APPROVED");
    assert.equal(listing.acceptedInquiryId, null);
    // Finishing it sells only the loans it kept, and the pool isn't marked sold while a loan is left.
    await prisma.closingStep.updateMany({ where: { closingId: before.id }, data: { status: "COMPLETE", completedAt: new Date() } });
    await finalizeClosing(before.id);
    assert.equal(await trade(a.id), "SOLD");
    assert.equal(await trade(b.id), "SOLD");
    assert.equal(await trade(c.id), "AVAILABLE");
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: pool.listing.id } })).status, "APPROVED");
    const holding = await prisma.buyerHolding.findFirstOrThrow({ where: { closingId: before.id } });
    assert.equal(Number(holding.upb), 200000);
  } finally {
    await cleanPool(pool);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Readers of a closing's loans

test("closingLoans honours noteIds in the packet and the statement, and a cancel hands the loans back", async () => {
  const notes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(closingLoans({ noteId: null, noteIds: ["a", "c"] }, notes), [{ id: "a" }, { id: "c" }]);
  assert.deepEqual(closingLoans({ noteId: "b", noteIds: [] }, notes), [{ id: "b" }]);
  assert.equal(closingLoans({ noteId: null, noteIds: [] }, notes).length, 3);
  assert.equal(closingLoans({ noteId: null }, notes).length, 3);
  assert.equal(closingCovers({ noteId: null, noteIds: ["a"] }, "b"), false);
  assert.equal(closingCovers({ noteId: null, noteIds: [] }, "b"), true);

  const pool = await makePool({ reserve: 1000 });
  try {
    const [a, b, c] = pool.listing.notes;
    const priced = await placeBid(pool, 0, 100000, { loanPrices: { [a.id]: 50000, [b.id]: 30000, [c.id]: 20000 }, allowPartial: true });
    const award = await awardPartial(priced.id, [a.id, c.id], pool.desk.id);
    assert.equal(award.error, null);
    await kickOutLoan({ closingId: award.closingId!, noteId: c.id, reason: "Collateral file missing.", actorId: pool.desk.id });
    const closing = await prisma.closing.findUniqueOrThrow({ where: { id: award.closingId! }, include: { listing: { include: { notes: { orderBy: { createdAt: "asc" } } } }, kickouts: true } });
    // The packet reads the same loans, with each one's own price on its papers.
    const packet = closingLoans(closing, closing.listing.notes);
    assert.deepEqual(packet.map((note) => note.id), [a.id]);
    assert.equal(pricesFor((await prisma.inquiry.findUniqueOrThrow({ where: { id: priced.id } })).loanPrices, packet.map((note) => note.id), Number(closing.salePrice))?.[a.id], 50000);
    // The statement names the loans it covers and lists the one taken out.
    const scope = statementScope(closing, closing.listing.notes);
    assert.deepEqual(scope.loans, ["1 First St, Tampa, FL"]);
    assert.equal(scope.kickouts.length, 1);
    assert.equal(scope.kickouts[0].loan, "3 Third St, Tampa, FL");
    assert.equal(scope.kickouts[0].priceCents, 2000000);
    const record = { ...closing, salePrice: Number(closing.salePrice) };
    const seller = statementLines(record, "seller", 0, null, scope.kickouts);
    assert.deepEqual(seller.map((section) => section.heading), ["Seller", "Loans taken out before settlement"]);
    assert.equal(seller[1].lines[0].cents, 2000000);
    assert.doesNotMatch(seller[1].lines[0].detail ?? "", /deposit/);
    assert.equal(statementLines(record, "desk", 0, null, scope.kickouts).at(-1)?.heading, "Loans taken out before settlement");
    assert.deepEqual(statementLines(record, "buyer").map((section) => section.heading), ["Buyer"]);
    // A cancel puts the loans it named back on the book.
    assert.ok(await cancelOpenClosing(closing.id, "Both sides agreed to part.", { fault: "NEITHER", actorId: pool.desk.id }));
    assert.equal(await trade(a.id), "AVAILABLE");
    assert.equal(await status(priced.id), "DECLINED");
  } finally {
    await cleanPool(pool);
  }
});

test("the timeline shows a kick-out to both sides, the deposit to the buyer side, and no figures to a watching broker", () => {
  const at = new Date(Date.UTC(2026, 10, 5, 12));
  const input: TimelineInput = {
    closing: {
      status: "OPEN", openedAt: at, closedAt: null, canceledAt: null, cancelReason: null, cancelFault: null, targetCloseAt: null, salePrice: 50000,
      depositCents: null, depositDueAt: null, fundsReceivedCents: null, fundsReceivedAt: null, depositReceivedCents: null, depositReceivedAt: null, proceedsSentCents: null, proceedsSentAt: null,
    },
    steps: [],
    audits: [],
    posts: [],
    people: { desk: { name: "Dana", role: "ADMIN" } },
    kickouts: [{ id: "k1", at: new Date(at.getTime() + DAY), loan: "2 Second St, Tampa, FL", reason: "Title defect.", priceCents: 3000000, depositCents: 300000, actorId: "desk" }],
    sellerId: "seller",
    buyerIds: ["buyer"],
    days: 30,
    now: at,
  };
  const entry = (side: "desk" | "buyer" | "seller" | "observer") => dealTimeline(input, side).entries.find((row) => row.id === "kickout:k1");
  assert.match(entry("buyer")?.detail ?? "", /2 Second St.*Title defect\. The price came down \$30,000\.00\. The deposit came down \$3,000\.00\./);
  assert.doesNotMatch(entry("seller")?.detail ?? "", /deposit/);
  assert.match(entry("seller")?.detail ?? "", /price came down/);
  assert.equal(entry("observer")?.detail, "A loan came out of the closing before settlement.");
  assert.equal(entry("buyer")?.who, "The desk");
  assert.equal(entry("desk")?.who, "Dana, desk");
});
