import assert from "node:assert/strict";
import test from "node:test";
import { askedPriceStands, awardOffer, deskBidNotAcceptable, listingNotAwardable, rivalBids } from "../lib/awards";
import { assessBrokerFees, flatFeeKey, type AssessInput } from "../lib/broker-fees";
import { finalizeClosing, openClosing } from "../lib/closing-service";
import { prisma } from "../lib/prisma";
import { OFAC_HOLD_MESSAGE } from "../lib/screening";
import { getSettings } from "../lib/settings";
import { strikeLimitOf } from "../lib/strikes";
import { namesOnTitle } from "../lib/vesting";

// An award sends the purchase agreement for signature, so its PDF stays on disk and signing stays in the app,
// whatever storage or signing keys the local .env carries.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

test("only a live listing's bids can be awarded", () => {
  assert.equal(listingNotAwardable("APPROVED"), null);
  assert.match(listingNotAwardable("CHANGES_REQUESTED") ?? "", /isn't live/);
  assert.match(listingNotAwardable("REJECTED") ?? "", /isn't live/);
  assert.match(listingNotAwardable("UNDER_REVIEW") ?? "", /isn't live/);
  assert.match(listingNotAwardable("PENDING") ?? "", /in contract/);
  assert.match(listingNotAwardable("SOLD") ?? "", /already sold/);
});

test("a desk bid waits for a sealed or best-and-final deadline, and never takes a declined or sent-back file", () => {
  const now = Date.now();
  const base = { status: "APPROVED", bidMode: "NONE", bidDeadline: null };
  assert.equal(deskBidNotAcceptable(base), null);
  assert.equal(deskBidNotAcceptable({ ...base, status: "SUBMITTED" }), null);
  assert.equal(deskBidNotAcceptable({ ...base, status: "UNDER_REVIEW" }), null);
  assert.match(deskBidNotAcceptable({ ...base, bidMode: "SEALED", bidDeadline: new Date(now + DAY) }) ?? "", /after the bid deadline/);
  assert.match(deskBidNotAcceptable({ ...base, bidMode: "BEST_AND_FINAL", bidDeadline: new Date(now + DAY) }) ?? "", /after the bid deadline/);
  assert.match(deskBidNotAcceptable({ ...base, bidMode: "SEALED", bidDeadline: null }) ?? "", /after the bid deadline/);
  assert.equal(deskBidNotAcceptable({ ...base, bidMode: "SEALED", bidDeadline: new Date(now - DAY) }), null);
  assert.match(deskBidNotAcceptable({ ...base, status: "REJECTED" }) ?? "", /declined or sent back/);
  assert.match(deskBidNotAcceptable({ ...base, status: "CHANGES_REQUESTED" }) ?? "", /declined or sent back/);
  assert.match(deskBidNotAcceptable({ ...base, status: "PENDING" }) ?? "", /in contract/);
  assert.match(deskBidNotAcceptable({ ...base, status: "SOLD" }) ?? "", /already sold/);
});

test("the seller's highest other bid compares the same scope at each buyer's latest price", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 12, minute));
  const bid = (id: string, noteId: string | null, amount: number, extra: Partial<Parameters<typeof rivalBids>[0]> = {}) => ({
    id, type: "OFFER", status: "OPEN", noteId, amount, buyerId: `buyer-${id}`, messages: [], ...extra,
  });
  const recommended = bid("a", null, 110000);
  const repriced = bid("b", null, 90000, { messages: [
    { kind: "OFFER", amount: 90000, createdAt: at(1), authorId: "buyer-b" },
    { kind: "COUNTER", amount: 125000, createdAt: at(2), authorId: "buyer-b" },
  ] });
  // A desk counter the buyer never took isn't their price.
  const countered = bid("c", null, 80000, { messages: [{ kind: "COUNTER", amount: 200000, createdAt: at(3), authorId: "desk" }] });
  const oneLoan = bid("d", "loan-1", 1200000);
  const declined = bid("e", null, 300000, { status: "DECLINED" });
  const offers = [recommended, repriced, countered, oneLoan, declined];
  assert.deepEqual(rivalBids(recommended, offers), { count: 2, best: 125000 });
  // A one-loan recommendation weighs only bids on that loan, not the whole pool.
  const sameLoan = bid("f", "loan-1", 50000);
  assert.deepEqual(rivalBids(sameLoan, [...offers, sameLoan]), { count: 1, best: 1200000 });
  assert.deepEqual(rivalBids(bid("g", "loan-2", 40000), offers), { count: 0, best: 0 });
});

test("an approval answers the figure the desk asked about, not a bid that moved since", () => {
  assert.equal(askedPriceStands(110000, 110000), true);
  assert.equal(askedPriceStands(110000, 105000), false);
  assert.equal(askedPriceStands(null, 110000), false);
  assert.equal(askedPriceStands(110000, null), false);
});

function fees(overrides: Partial<AssessInput>): AssessInput {
  return {
    premiumCents: 400000,
    commissionCents: 600000,
    sellerId: "seller",
    buyerId: "buyer",
    clientSellerName: "Helen Marsh",
    brokerName: "Nora Vale",
    deal: { brokerId: "nora", role: "SELLER_BROKER", terms: { basis: "FLAT", bps: 0, cents: 50000 } },
    referrer: null,
    brokerSchedule: { basis: "PERCENT", bps: 2000, cents: 0 },
    affiliateSchedule: { basis: "PERCENT", bps: 1000, cents: 0 },
    ...overrides,
  };
}

test("broker fees never pay out more than the desk's fees on the closing", () => {
  // A $10,000 one-loan sale makes a $550 pool. A $500 listing fee plus a $250 referral fee would be $750.
  const result = assessBrokerFees(fees({ premiumCents: 25000, commissionCents: 30000, referrer: { brokerId: "ada", terms: { basis: "FLAT", bps: 0, cents: 25000 } } }));
  assert.deepEqual(result.fees.map((fee) => [fee.brokerId, fee.amountCents, fee.capped ?? false]), [
    ["nora", 50000, false],
    ["ada", 5000, true],
  ]);
  assert.match(result.withheld.join(" "), /referral fee was capped/);
  const nothing = assessBrokerFees(fees({ premiumCents: 0, commissionCents: 0 }));
  assert.equal(nothing.fees.length, 0);
  assert.match(nothing.withheld.join(" "), /capped at the desk's fees on this closing, which leaves nothing/);
});

test("a flat fee is owed once per listing, and a capped part carries to the next closing", () => {
  const key = flatFeeKey("nora", "SELLER_BROKER");
  const paid = assessBrokerFees(fees({ flatPaid: { [key]: 50000 } }));
  assert.equal(paid.fees.length, 0);
  assert.match(paid.withheld.join(" "), /already charged on an earlier closing/);
  assert.equal(assessBrokerFees(fees({ flatPaid: { [key]: 30000 } })).fees[0]?.amountCents, 20000);
  // A percent fee is a share of each closing's own pool, so every closing pays it.
  const percent = assessBrokerFees(fees({ deal: { brokerId: "nora", role: "SELLER_BROKER", terms: null }, flatPaid: { [key]: 50000 } }));
  assert.equal(percent.fees[0]?.amountCents, 200000);
});

const note = (street: string) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 80000, estimatedValue: 150000,
});

async function makePool(tag: string, opts: { status?: string; broker?: boolean } = {}) {
  const seller = await prisma.user.create({
    data: {
      email: `am-seller-${tag}@example.org`, name: `Seller ${tag}`, role: opts.broker ? "BROKER" : "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x",
      ...(opts.broker ? { brokerProfile: { create: { company: `Brokerage ${tag}`, states: "FL", payoutNote: "Check.", brokerFeeBasis: "FLAT", brokerFeeCents: 50000 } } } : {}),
    },
  });
  const buyer = await prisma.user.create({ data: { email: `am-buyer-${tag}@example.org`, name: `Buyer ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  const second = await prisma.user.create({ data: { email: `am-second-${tag}@example.org`, name: `Second ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  const desk = await prisma.user.create({ data: { email: `am-desk-${tag}@upbcapital.test`, name: `Desk ${tag}`, role: "ADMIN", accountStatus: "APPROVED", passwordHash: "x" } });
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: (opts.status ?? "APPROVED") as "APPROVED",
      approvedAt: new Date(),
      reservePrice: 1000,
      title: `Awards medium ${tag}`,
      ...(opts.broker ? { brokerId: seller.id, brokerRole: "SELLER_BROKER" as const, clientSellerName: "Helen Marsh" } : {}),
      notes: { create: [note("1 First St"), note("2 Second St")] as never },
    },
    include: { notes: true },
  });
  return { seller, buyer, second, desk, listing, users: [seller, buyer, second, desk] };
}

async function cleanPool(pool: Awaited<ReturnType<typeof makePool>>) {
  const listingId = pool.listing.id;
  const inquiries = await prisma.inquiry.findMany({ where: { listingId }, select: { id: true } });
  const closings = await prisma.closing.findMany({ where: { listingId }, select: { id: true } });
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [listingId, ...inquiries.map((row) => row.id)] } } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId }, { closingId: { in: closings.map((row) => row.id) } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId } });
  await prisma.invoice.deleteMany({ where: { closingId: { in: closings.map((row) => row.id) } } });
  await prisma.ofacCheck.deleteMany({ where: { userId: { in: pool.users.map((user) => user.id) } } });
  await prisma.groupBuy.deleteMany({ where: { listingId } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: pool.users.map((user) => user.email) } }, { subject: { contains: pool.listing.title } }] } });
  await prisma.user.deleteMany({ where: { id: { in: pool.users.map((user) => user.id) } } });
}

test("a listing sent back, declined, or in contract can't be awarded, even within the reserve", async () => {
  const pool = await makePool(crypto.randomUUID().slice(0, 8));
  try {
    const listingId = pool.listing.id;
    const offer = await prisma.inquiry.create({ data: { listingId, buyerId: pool.buyer.id, type: "OFFER", status: "OPEN", amount: 90000 } });
    for (const status of ["CHANGES_REQUESTED", "REJECTED", "UNDER_REVIEW"] as const) {
      await prisma.listing.update({ where: { id: listingId }, data: { status } });
      assert.equal((await awardOffer(offer.id, pool.desk.id)).error, "This listing isn't live, so its bids can't be awarded.");
    }
    await prisma.listing.update({ where: { id: listingId }, data: { status: "PENDING" } });
    assert.match((await awardOffer(offer.id, pool.desk.id)).error ?? "", /in contract/);
    assert.equal(await prisma.closing.count({ where: { listingId } }), 0);

    // A pool with one loan in contract stays live, so another loan can still be awarded on its own.
    await prisma.listing.update({ where: { id: listingId }, data: { status: "APPROVED" } });
    const [first, second] = pool.listing.notes;
    const firstBid = await prisma.inquiry.create({ data: { listingId, buyerId: pool.buyer.id, type: "OFFER", status: "OPEN", amount: 40000, noteId: first.id } });
    const secondBid = await prisma.inquiry.create({ data: { listingId, buyerId: pool.second.id, type: "OFFER", status: "OPEN", amount: 45000, noteId: second.id } });
    // The desk's open bids on the sold loan, and on the whole pool, are withdrawn with the losing offers.
    const deskOnFirst = await prisma.deskBid.create({ data: { listingId, noteId: first.id, amount: 39000 } });
    const deskOnPool = await prisma.deskBid.create({ data: { listingId, amount: 70000 } });
    const deskOnSecond = await prisma.deskBid.create({ data: { listingId, noteId: second.id, amount: 41000 } });
    assert.equal((await awardOffer(firstBid.id, pool.desk.id)).error, null);
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).status, "APPROVED");
    const deskStatus = async (id: string) => (await prisma.deskBid.findUniqueOrThrow({ where: { id } })).status;
    assert.equal(await deskStatus(deskOnFirst.id), "WITHDRAWN");
    assert.equal(await deskStatus(deskOnPool.id), "WITHDRAWN");
    assert.equal(await deskStatus(deskOnSecond.id), "OPEN");
    assert.equal((await awardOffer(secondBid.id, pool.desk.id)).error, null);
  } finally {
    await cleanPool(pool);
  }
});

test("a group award checks every live seat holder's account and OFAC status, not just the lead", async () => {
  const pool = await makePool(crypto.randomUUID().slice(0, 8));
  try {
    const listingId = pool.listing.id;
    const offer = await prisma.inquiry.create({ data: { listingId, buyerId: pool.buyer.id, type: "OFFER", status: "OPEN", amount: 80000 } });
    const group = await prisma.groupBuy.create({ data: { listingId, openedById: pool.buyer.id, minPosition: 10000, deadline: new Date(Date.now() + DAY), targetAmount: 80000, inquiryId: offer.id, status: "OFFERED" } });
    await prisma.groupPosition.create({ data: { groupId: group.id, userId: pool.buyer.id, seat: 1, amount: 40000, percent: 50, status: "PLEDGED" } });
    const seat = await prisma.groupPosition.create({ data: { groupId: group.id, userId: pool.second.id, seat: 2, amount: 40000, percent: 50, status: "PLEDGED" } });

    await prisma.user.update({ where: { id: pool.second.id }, data: { accountStatus: "SUSPENDED" } });
    assert.equal((await awardOffer(offer.id, pool.desk.id)).error, "A group seat holder's account is not approved.");

    await prisma.user.update({ where: { id: pool.second.id }, data: { accountStatus: "APPROVED" } });
    const check = await prisma.ofacCheck.create({ data: { name: pool.second.name, result: "REVIEW", status: "OPEN", userId: pool.second.id, context: "test" } });
    assert.equal((await awardOffer(offer.id, pool.desk.id)).error, OFAC_HOLD_MESSAGE);
    await prisma.ofacCheck.delete({ where: { id: check.id } });

    // A seat that dropped out isn't a funder, so its holder doesn't hold up the award.
    await prisma.user.update({ where: { id: pool.second.id }, data: { accountStatus: "SUSPENDED" } });
    await prisma.groupPosition.update({ where: { id: seat.id }, data: { status: "DROPPED" } });
    await prisma.groupPosition.updateMany({ where: { groupId: group.id, seat: 1 }, data: { amount: 80000, percent: 100 } });
    assert.equal((await awardOffer(offer.id, pool.desk.id)).error, null);
  } finally {
    await cleanPool(pool);
  }
});

test("a strike pause stops an award to the lead or any live seat, and clearing the strikes lets it through", async () => {
  const pool = await makePool(crypto.randomUUID().slice(0, 8));
  const userIds = pool.users.map((user) => user.id);
  try {
    const listingId = pool.listing.id;
    const limit = strikeLimitOf((await getSettings()).strikeLimit);
    const pause = (userId: string) =>
      prisma.buyerStrike.createMany({ data: Array.from({ length: limit }, (_, index) => ({ userId, closingId: `none-${index}`, reason: "Earlier miss." })) });
    const clear = (userId: string) => prisma.buyerStrike.updateMany({ where: { userId }, data: { clearedAt: new Date(), clearNote: "Cleared for the test." } });
    // The bid went in before the pause, so only the award can stop it.
    const offer = await prisma.inquiry.create({ data: { listingId, buyerId: pool.buyer.id, type: "OFFER", status: "OPEN", amount: 80000 } });
    const group = await prisma.groupBuy.create({ data: { listingId, openedById: pool.buyer.id, minPosition: 10000, deadline: new Date(Date.now() + DAY), targetAmount: 80000, inquiryId: offer.id, status: "OFFERED" } });
    await prisma.groupPosition.create({ data: { groupId: group.id, userId: pool.buyer.id, seat: 1, amount: 40000, percent: 50, status: "PLEDGED" } });
    await prisma.groupPosition.create({ data: { groupId: group.id, userId: pool.second.id, seat: 2, amount: 40000, percent: 50, status: "PLEDGED" } });

    await pause(pool.buyer.id);
    assert.match((await awardOffer(offer.id, pool.desk.id)).error ?? "", /^This buyer's bidding is paused/);
    await clear(pool.buyer.id);
    await pause(pool.second.id);
    assert.match((await awardOffer(offer.id, pool.desk.id)).error ?? "", /^A group seat holder's bidding is paused/);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: offer.id } })).status, "OPEN");
    await clear(pool.second.id);
    assert.equal((await awardOffer(offer.id, pool.desk.id)).error, null);
  } finally {
    await prisma.buyerStrike.deleteMany({ where: { userId: { in: userIds } } });
    await cleanPool(pool);
  }
});

test("the closing papers name each buyer's vetted entity, fixed at award", async () => {
  const pool = await makePool(crypto.randomUUID().slice(0, 8));
  try {
    const listingId = pool.listing.id;
    await prisma.buyerProfile.create({ data: { userId: pool.buyer.id, status: "APPROVED", entityType: "LLC", entityName: `Harbor Notes ${pool.listing.id} LLC` } });
    await prisma.buyerProfile.create({ data: { userId: pool.second.id, status: "APPROVED", entityType: "TRUST", entityName: `Second Family Trust ${pool.listing.id}` } });
    const offer = await prisma.inquiry.create({ data: { listingId, buyerId: pool.buyer.id, type: "OFFER", status: "OPEN", amount: 80000 } });
    const group = await prisma.groupBuy.create({ data: { listingId, openedById: pool.buyer.id, minPosition: 10000, deadline: new Date(Date.now() + DAY), targetAmount: 80000, inquiryId: offer.id, status: "OFFERED" } });
    await prisma.groupPosition.create({ data: { groupId: group.id, userId: pool.buyer.id, seat: 1, amount: 40000, percent: 50, status: "PLEDGED" } });
    await prisma.groupPosition.create({ data: { groupId: group.id, userId: pool.second.id, seat: 2, amount: 40000, percent: 50, status: "PLEDGED" } });
    const award = await awardOffer(offer.id, pool.desk.id);
    assert.equal(award.error, null);
    const closing = await prisma.closing.findUniqueOrThrow({ where: { id: award.closingId! }, include: { funders: true } });
    assert.equal(closing.buyerEntity, `Harbor Notes ${pool.listing.id} LLC`);
    assert.deepEqual(closing.funders.map((funder) => funder.entityName).sort(), [`Harbor Notes ${pool.listing.id} LLC`, `Second Family Trust ${pool.listing.id}`]);

    // A buyer who refiles mid-closing doesn't change who takes title.
    await prisma.buyerProfile.update({ where: { userId: pool.buyer.id }, data: { entityName: "Someone Else LLC" } });
    const fixed = await namesOnTitle(closing, pool.buyer.id, closing.funders);
    assert.equal(fixed.buyer, `Harbor Notes ${pool.listing.id} LLC`);
    assert.equal(fixed.buyer === pool.buyer.name, false);
    // A closing opened before names were kept reads the buyer file as it stands, then the account name.
    const older = await namesOnTitle({ buyerEntity: null }, pool.buyer.id, [{ userId: pool.second.id, entityName: null }]);
    assert.equal(older.buyer, "Someone Else LLC");
    assert.equal(older.funder({ userId: pool.second.id, entityName: null }), `Second Family Trust ${pool.listing.id}`);
    const noFile = await namesOnTitle({ buyerEntity: null }, pool.desk.id, []);
    assert.equal(noFile.buyer, pool.desk.name);
  } finally {
    await cleanPool(pool);
  }
});

async function closeLoan(pool: Awaited<ReturnType<typeof makePool>>, noteId: string, salePrice: number) {
  const inquiry = await prisma.inquiry.create({ data: { listingId: pool.listing.id, buyerId: pool.buyer.id, type: "OFFER", status: "ACCEPTED", amount: salePrice, noteId } });
  await prisma.note.update({ where: { id: noteId }, data: { tradeStatus: "IN_CONTRACT" } });
  const closing = await openClosing({ listingId: pool.listing.id, inquiryId: inquiry.id, noteId, salePrice, title: pool.listing.title });
  await prisma.closingStep.updateMany({ where: { closingId: closing.id }, data: { status: "COMPLETE", completedAt: new Date() } });
  return closing;
}

async function flatRows(listingId: string) {
  const closings = await prisma.closing.findMany({ where: { listingId }, select: { id: true, buyerPremiumCents: true, sellerCommissionCents: true } });
  const rows = await prisma.brokerFee.findMany({ where: { closingId: { in: closings.map((row) => row.id) } } });
  const ledger = await prisma.revenueEvent.findMany({ where: { listingId, type: "BROKER_FEE" } });
  return { closings, rows, ledger };
}

test("a pool sold loan by loan pays the broker's flat fee once, capped by each closing's fees", async () => {
  const pool = await makePool(crypto.randomUUID().slice(0, 8), { broker: true });
  try {
    const [first, second] = pool.listing.notes;
    // A small first sale can't cover the whole flat fee, so the rest comes from the next closing.
    const small = await closeLoan(pool, first.id, 5000);
    await finalizeClosing(small.id);
    const big = await closeLoan(pool, second.id, 100000);
    await finalizeClosing(big.id);
    await finalizeClosing(big.id);
    const { closings, rows, ledger } = await flatRows(pool.listing.id);
    const poolOf = (id: string) => {
      const row = closings.find((item) => item.id === id)!;
      return row.buyerPremiumCents + row.sellerCommissionCents;
    };
    const onSmall = Math.min(50000, poolOf(small.id));
    const onBig = Math.min(50000 - onSmall, poolOf(big.id));
    assert.equal(rows.find((row) => row.closingId === small.id)?.amountCents ?? 0, onSmall);
    assert.equal(rows.find((row) => row.closingId === big.id)?.amountCents ?? 0, onBig);
    assert.ok(rows.reduce((sum, row) => sum + row.amountCents, 0) <= 50000);
    assert.equal(ledger.reduce((sum, row) => sum + row.amountCents, 0), onSmall + onBig);
  } finally {
    await cleanPool(pool);
  }
});

test("two of a pool's closings finishing at once still charge the flat fee once", async () => {
  const pool = await makePool(crypto.randomUUID().slice(0, 8), { broker: true });
  try {
    const [first, second] = pool.listing.notes;
    const one = await closeLoan(pool, first.id, 100000);
    const two = await closeLoan(pool, second.id, 100000);
    await Promise.all([finalizeClosing(one.id), finalizeClosing(two.id)]);
    const { closings, rows, ledger } = await flatRows(pool.listing.id);
    const total = rows.reduce((sum, row) => sum + row.amountCents, 0);
    // At the default schedule each $100,000 sale's fees cover the whole $500, so one closing carries it.
    if (closings.every((row) => row.buyerPremiumCents + row.sellerCommissionCents >= 50000)) {
      assert.equal(rows.length, 1);
      assert.equal(total, 50000);
    }
    assert.ok(total <= 50000);
    assert.equal(ledger.reduce((sum, row) => sum + row.amountCents, 0), total);
  } finally {
    await cleanPool(pool);
  }
});

test("awards that land at the same moment open one closing, and the loser leaves everything as it was", async () => {
  const pool = await makePool(crypto.randomUUID().slice(0, 8));
  try {
    const listingId = pool.listing.id;
    // Two whole-pool bids, both within the reserve, awarded at once.
    const first = await prisma.inquiry.create({ data: { listingId, buyerId: pool.buyer.id, type: "OFFER", status: "OPEN", amount: 90000 } });
    const second = await prisma.inquiry.create({ data: { listingId, buyerId: pool.second.id, type: "OFFER", status: "OPEN", amount: 95000 } });
    const results = await Promise.all([awardOffer(first.id, pool.desk.id), awardOffer(second.id, pool.desk.id)]);
    assert.equal(results.filter((result) => result.error === null).length, 1);
    assert.equal(await prisma.closing.count({ where: { listingId } }), 1);

    // The same offer awarded twice at once still opens one closing.
    const again = await makePool(crypto.randomUUID().slice(0, 8));
    try {
      const offer = await prisma.inquiry.create({ data: { listingId: again.listing.id, buyerId: again.buyer.id, type: "OFFER", status: "OPEN", amount: 90000 } });
      const twice = await Promise.all([awardOffer(offer.id, again.desk.id), awardOffer(offer.id, again.desk.id)]);
      assert.equal(twice.filter((result) => result.error === null).length, 1);
      assert.equal(await prisma.closing.count({ where: { listingId: again.listing.id } }), 1);
    } finally {
      await cleanPool(again);
    }

    // A whole-pool award and a one-loan award racing: at most one wins, and a loser puts its claim back.
    const race = await makePool(crypto.randomUUID().slice(0, 8));
    try {
      const raceId = race.listing.id;
      const whole = await prisma.inquiry.create({ data: { listingId: raceId, buyerId: race.buyer.id, type: "OFFER", status: "OPEN", amount: 90000 } });
      const loan = await prisma.inquiry.create({ data: { listingId: raceId, buyerId: race.second.id, type: "OFFER", status: "OPEN", amount: 45000, noteId: race.listing.notes[0].id } });
      const outcome = await Promise.all([awardOffer(whole.id, race.desk.id), awardOffer(loan.id, race.desk.id)]);
      assert.ok(outcome.filter((result) => result.error === null).length <= 1);
      const listing = await prisma.listing.findUniqueOrThrow({ where: { id: raceId }, include: { notes: true } });
      const closings = await prisma.closing.findMany({ where: { listingId: raceId } });
      assert.equal(closings.length, outcome.filter((result) => result.error === null).length);
      if (closings.length === 0) {
        assert.equal(listing.status, "APPROVED");
        assert.ok(listing.notes.every((note) => note.tradeStatus === "AVAILABLE"));
      }
      for (const inquiry of [whole, loan]) {
        const row = await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
        const awarded = closings.some((closing) => closing.inquiryId === inquiry.id);
        assert.equal(row.status === "ACCEPTED", awarded);
      }
    } finally {
      await cleanPool(race);
    }
  } finally {
    await cleanPool(pool);
  }
});
