import assert from "node:assert/strict";
import test from "node:test";
import {
  cashBucket,
  cashCsv,
  cashStatus,
  cashTotals,
  closingCash,
  loadCashNeeds,
  pageOf,
  sortCash,
  statusText,
  type CashClosing,
} from "../lib/cash-needs";
import { fundsExposure } from "../lib/inquiry";
import { prisma } from "../lib/prisma";
import { balanceDueCents, buyerDueCents } from "../lib/settlement";
import { getSettings } from "../lib/settings";
import { bidTarget, exposureByKey, headroomFor } from "../lib/verification";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-22T15:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

function closing(over: Partial<CashClosing> = {}): CashClosing {
  return {
    id: "c1",
    listingId: "l1",
    openedAt: at(-5 * DAY),
    targetCloseAt: at(20 * DAY),
    salePrice: 100000,
    buyerPremiumCents: 250000,
    sellerCommissionCents: 300000,
    buyerTotalCents: 10250000,
    netToSellerCents: 9700000,
    prorationCents: null,
    depositCents: 1000000,
    depositDueAt: at(2 * DAY),
    depositReceivedCents: null,
    depositReceivedAt: null,
    fundsReceivedCents: null,
    fundsReceivedAt: null,
    ...over,
  };
}

test("an item is late the moment its date passes, due soon inside three days, and received once recorded", () => {
  assert.equal(cashStatus(at(-1), false, NOW), "late");
  assert.equal(cashStatus(NOW, false, NOW), "due_soon");
  assert.equal(cashStatus(at(3 * DAY), false, NOW), "due_soon");
  assert.equal(cashStatus(at(3 * DAY + 1), false, NOW), "due");
  assert.equal(cashStatus(null, false, NOW), "due");
  // Received wins over a date long past.
  assert.equal(cashStatus(at(-10 * DAY), true, NOW), "received");
});

test("buckets split at 7 and 30 days, and an undated item counts as later", () => {
  assert.equal(cashBucket(at(-1), NOW), "late");
  assert.equal(cashBucket(NOW, NOW), "week");
  assert.equal(cashBucket(at(7 * DAY), NOW), "week");
  assert.equal(cashBucket(at(7 * DAY + 1), NOW), "month");
  assert.equal(cashBucket(at(30 * DAY), NOW), "month");
  assert.equal(cashBucket(at(30 * DAY + 1), NOW), "later");
  assert.equal(cashBucket(null, NOW), "later");
});

test("totals leave out what was received, and the 30-day total includes the 7-day one", () => {
  const items = [
    { cents: 100, dueAt: at(-DAY), status: "late" as const },
    { cents: 200, dueAt: at(DAY), status: "due_soon" as const },
    { cents: 400, dueAt: at(10 * DAY), status: "due" as const },
    { cents: 800, dueAt: at(40 * DAY), status: "due" as const },
    { cents: 1600, dueAt: null, status: "due" as const },
    { cents: 3200, dueAt: at(2 * DAY), status: "received" as const },
  ];
  assert.deepEqual(cashTotals(items, NOW), { lateCents: 100, next7Cents: 200, next30Cents: 600, laterCents: 2400 });
  assert.deepEqual(cashTotals([], NOW), { lateCents: 0, next7Cents: 0, next30Cents: 0, laterCents: 0 });
});

test("a sole buyer owes the deposit by its date and the rest by the target close, never the deposit twice", () => {
  const open = closing({ prorationCents: 12345 });
  const [deposit, balance] = closingCash(open, "Ridge pool", { seat: null, days: 30, now: NOW });
  assert.equal(deposit.kind, "DEPOSIT");
  assert.equal(deposit.cents, 1000000);
  assert.equal(deposit.status, "due_soon");
  assert.equal(balance.kind, "BALANCE");
  assert.equal(balance.dueAt?.getTime(), open.targetCloseAt!.getTime());
  // The two rows add up to the all-in, proration included.
  assert.equal(deposit.cents + balance.cents, buyerDueCents(open));
  assert.equal(cashTotals([deposit, balance], NOW).next30Cents, buyerDueCents(open));

  // Once a short deposit lands, the balance is the closing page's own: the all-in less what was received.
  const landed = closing({ depositReceivedCents: 900000, depositReceivedAt: at(-DAY) });
  const [paid, rest] = closingCash(landed, "Ridge pool", { seat: null, days: 30, now: NOW });
  assert.equal(paid.status, "received");
  assert.equal(paid.cents, 900000);
  assert.match(paid.detail, /short \$1,000\.00/);
  assert.equal(statusText(paid), "Received Nov 21, 2026");
  assert.equal(rest.cents, balanceDueCents(landed));
  assert.equal(cashTotals([paid, rest], NOW).next30Cents, balanceDueCents(landed));

  // Funds recorded: nothing left in any total.
  const funded = closing({ depositReceivedCents: 1000000, depositReceivedAt: at(-3 * DAY), fundsReceivedCents: 9250000, fundsReceivedAt: at(-DAY) });
  const rows = closingCash(funded, "Ridge pool", { seat: null, days: 30, now: NOW });
  assert.ok(rows.every((row) => row.status === "received"));
  assert.deepEqual(cashTotals(rows, NOW), { lateCents: 0, next7Cents: 0, next30Cents: 0, laterCents: 0 });

  // A late deposit, and no target set: the close falls on the desk's schedule from the open date.
  const late = closing({ depositDueAt: at(-DAY), targetCloseAt: null });
  const [overdue, close] = closingCash(late, "Ridge pool", { seat: null, days: 30, now: NOW });
  assert.equal(overdue.status, "late");
  assert.equal(close.dueAt?.getTime(), late.openedAt.getTime() + 30 * DAY);

  // No deposit set: the balance is the whole all-in.
  const [only] = closingCash(closing({ depositCents: null, depositDueAt: null }), "Ridge pool", { seat: null, days: 30, now: NOW });
  assert.equal(only.kind, "BALANCE");
  assert.equal(only.cents, 10250000);
});

test("a group seat owes its own share by the target close, and is received once the desk marks it funded", () => {
  const seat = { amount: 40000, premiumCents: 100000, status: "PENDING", fundedAt: null };
  const [share] = closingCash(closing(), "Group pool", { seat, days: 30, now: NOW });
  assert.equal(share.kind, "SHARE");
  assert.equal(share.cents, 4000000 + 100000);
  assert.equal(share.status, "due");
  const [done] = closingCash(closing(), "Group pool", { seat: { ...seat, status: "FUNDED", fundedAt: at(-DAY) }, days: 30, now: NOW });
  assert.equal(done.status, "received");
  assert.equal(done.receivedAt?.getTime(), at(-DAY).getTime());
});

test("rows sort unpaid by date first, pages clamp, and the CSV defuses formula text", () => {
  const rows = [
    ...closingCash(closing({ id: "a", depositDueAt: at(5 * DAY) }), "Later pool", { seat: null, days: 30, now: NOW }),
    ...closingCash(closing({ id: "b", targetCloseAt: at(25 * DAY), depositReceivedCents: 1000000, depositReceivedAt: at(-DAY) }), "=cmd pool", { seat: null, days: 30, now: NOW }),
  ];
  const sorted = sortCash(rows);
  assert.deepEqual(sorted.map((row) => `${row.closingId}:${row.kind}`), ["a:DEPOSIT", "a:BALANCE", "b:BALANCE", "b:DEPOSIT"]);
  assert.deepEqual(pageOf([1, 2, 3, 4, 5], 2, 2), { rows: [3, 4], page: 2, pages: 3 });
  assert.deepEqual(pageOf([1, 2, 3], 9, 2), { rows: [3], page: 2, pages: 2 });
  assert.deepEqual(pageOf([], Number.NaN, 2), { rows: [], page: 1, pages: 1 });
  const csv = cashCsv(sorted, "https://upb.example/");
  const lines = csv.split("\n");
  assert.equal(lines[0], "listing,item,amount,due,status,received,detail,closing");
  assert.equal(lines.length, 5);
  assert.ok(lines.some((line) => line.startsWith("'=cmd pool,Deposit,10000.00,")));
  assert.ok(lines[1].endsWith("https://upb.example/closings/a"));
  assert.equal(cashCsv([]).split("\n").length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// The loader against the database.

const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], listings: [] as string[] };

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER") {
  const user = await prisma.user.create({ data: { email: `cash-${who}-${tag}@example.org`, name: `Cash ${who} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  made.users.push(user.id);
  return user;
}

async function listing(sellerId: string, title: string) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - DAY),
      title: `${title} ${tag}`,
      feeBuyerPremiumBps: 250,
      feeSellerCommissionBps: 300,
      notes: {
        create: [{
          streetAddress: `12 Cash St ${tag}`, city: "Ledgerton", state: "TX", zip: "75001", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST", upb: 150000, interestRate: 6.5, monthlyPi: 1100, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 210000, borrowerName: `Borrower ${tag}`,
        }] as never,
      },
    },
    include: { notes: true },
  });
  made.listings.push(row.id);
  return row;
}

test.after(async () => {
  const closings = await prisma.closing.findMany({ where: { listingId: { in: made.listings } }, select: { id: true } });
  await prisma.closingFunder.deleteMany({ where: { closingId: { in: closings.map((row) => row.id) } } });
  await prisma.closing.deleteMany({ where: { listingId: { in: made.listings } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: made.listings } } });
  await prisma.note.deleteMany({ where: { listingId: { in: made.listings } } });
  await prisma.listing.deleteMany({ where: { id: { in: made.listings } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: made.users } }, { actorId: { in: made.users } }] } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test("the loader lists the buyer's own deposit, balance and seat share, and its bids' holds and headroom match the bid form", async () => {
  const now = new Date();
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer", "BUYER");
  const lead = await person("lead", "BUYER");
  const rival = await person("rival", "BUYER");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, proofAmount: 500000, proofVerifiedAt: new Date(now.getTime() - DAY), proofExpiresAt: new Date(now.getTime() + 60 * DAY) } as never });

  // Won: an awarded bid with its open closing and a deposit due in two days.
  const wonListing = await listing(seller.id, "Won note");
  const won = await prisma.inquiry.create({ data: { listingId: wonListing.id, buyerId: buyer.id, type: "OFFER", amount: 100000, status: "ACCEPTED" } });
  const open = await prisma.closing.create({
    data: {
      listingId: wonListing.id,
      inquiryId: won.id,
      salePrice: 100000,
      buyerPremiumCents: 250000,
      sellerCommissionCents: 300000,
      buyerTotalCents: 10250000,
      netToSellerCents: 9700000,
      targetCloseAt: new Date(now.getTime() + 20 * DAY),
      depositCents: 1000000,
      depositDueAt: new Date(now.getTime() + 2 * DAY),
    },
  });
  // Live: a second bid on another loan, and an expired one that holds nothing.
  const bidListing = await listing(seller.id, "Bid note");
  const live = await prisma.inquiry.create({ data: { listingId: bidListing.id, buyerId: buyer.id, type: "OFFER", noteId: bidListing.notes[0].id, amount: 80000, status: "OPEN" } });
  const staleListing = await listing(seller.id, "Stale note");
  await prisma.inquiry.create({ data: { listingId: staleListing.id, buyerId: buyer.id, type: "OFFER", amount: 50000, status: "OPEN", expiresAt: new Date(now.getTime() - DAY) } });
  // A group the buyer holds a seat in, led by someone else.
  const groupListing = await listing(seller.id, "Group note");
  const groupBid = await prisma.inquiry.create({ data: { listingId: groupListing.id, buyerId: lead.id, type: "OFFER", amount: 90000, status: "ACCEPTED" } });
  const group = await prisma.closing.create({
    data: {
      listingId: groupListing.id,
      inquiryId: groupBid.id,
      salePrice: 90000,
      buyerPremiumCents: 225000,
      sellerCommissionCents: 270000,
      buyerTotalCents: 9225000,
      netToSellerCents: 8730000,
      targetCloseAt: new Date(now.getTime() + 45 * DAY),
    },
  });
  await prisma.closingFunder.create({ data: { closingId: group.id, userId: buyer.id, amount: 30000, premiumCents: 75000, percent: 33.3 } });
  // Someone else's closing on the same listing as the buyer's bid: never the buyer's row.
  const theirs = await prisma.inquiry.create({ data: { listingId: bidListing.id, buyerId: rival.id, type: "OFFER", amount: 85000, status: "ACCEPTED" } });
  await prisma.closing.create({
    data: { listingId: bidListing.id, inquiryId: theirs.id, salePrice: 85000, buyerPremiumCents: 212500, sellerCommissionCents: 255000, buyerTotalCents: 8712500, netToSellerCents: 8245000, targetCloseAt: new Date(now.getTime() + 10 * DAY) },
  });

  const cash = await loadCashNeeds(buyer.id, now);
  assert.deepEqual(
    cash.items.map((item) => `${item.closingId}:${item.kind}:${item.status}`),
    [`${open.id}:DEPOSIT:due_soon`, `${open.id}:BALANCE:due`, `${group.id}:SHARE:due`],
  );
  const [deposit, balance, share] = cash.items;
  assert.equal(deposit.cents, 1000000);
  assert.equal(deposit.title, wonListing.title);
  assert.equal(balance.cents, buyerDueCents(open) - 1000000);
  assert.equal(share.cents, 3000000 + 75000);
  assert.deepEqual(cash.totals, { lateCents: 0, next7Cents: 1000000, next30Cents: buyerDueCents(open), laterCents: 3075000 });

  // The holds and headroom are fundsExposure's, as the bid form reads them.
  const settings = await getSettings();
  const byKey = exposureByKey(await fundsExposure(buyer.id, settings.buyerPremiumBps, now));
  const key = bidTarget(bidListing.id, bidListing.notes[0].id);
  assert.deepEqual(cash.bids.map((row) => row.key), [key]);
  assert.equal(cash.bids[0].allInCents, Math.round(byKey[key] * 100));
  assert.deepEqual(cash.bids[0].bids.map((bid) => [bid.id, bid.price]), [[live.id, 80000]]);
  assert.equal(cash.bids[0].loan, "Ledgerton, TX");
  assert.equal(cash.heldByClosingsCents, Math.round(byKey[`closing:${open.id}`] * 100));
  assert.equal(cash.headroomCents, Math.round(headroomFor(500000, byKey) * 100));
  assert.equal(cash.headroomCents, 50000000 - 10250000 - cash.bids[0].allInCents);
  assert.equal(cash.credential?.amount, 500000);
  assert.match(cash.credential?.line ?? "", /^Verified funds \$500,000 to /);

  // A buyer with nothing gets nothing, and no ceiling.
  const empty = await loadCashNeeds((await person("empty", "BUYER")).id, now);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.bids, []);
  assert.equal(empty.credential, null);
  assert.equal(empty.headroomCents, null);
});
