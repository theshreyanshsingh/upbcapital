import assert from "node:assert/strict";
import test from "node:test";
import { changePercent, latestCuts, priceHistory, recentCuts } from "../lib/price-history";
import {
  ladderBlock,
  ladderLine,
  nextAsk,
  openAsk,
  readLadder,
  runPriceLadders,
  setPriceLadder,
  spreadAsk,
  stepsToFloor,
  stopPriceLadder,
  STOP_REASONS,
  WAIT_DAYS,
} from "../lib/price-ladder";
import { prisma } from "../lib/prisma";
import { watchReprice } from "../lib/watchers";

// Mail stays in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "EMAIL_FROM"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;
const live = { status: "APPROVED", bidMode: "NONE", saleEventId: null, roundOneEndsAt: null, flowProgramId: null, buyNowPrice: null };

test("a ladder reads its step, cadence and floor against today's ask", () => {
  assert.deepEqual(readLadder({ step: "3", every: "14", floor: "$90,000" }, 100000), { stepBps: 300, everyDays: 14, floor: 90000 });
  assert.deepEqual(readLadder({ step: "2.5", every: "7", floor: "1" }, 100000), { stepBps: 250, everyDays: 7, floor: 1 });
  assert.match((readLadder({ step: "0.5", every: "14", floor: "90000" }, 100000) as { error: string }).error, /between 1% and 10%/);
  assert.match((readLadder({ step: "11", every: "14", floor: "90000" }, 100000) as { error: string }).error, /between 1% and 10%/);
  assert.match((readLadder({ step: "3", every: "10", floor: "90000" }, 100000) as { error: string }).error, /every 7, 14/);
  assert.match((readLadder({ step: "3", every: "14", floor: "" }, 100000) as { error: string }).error, /lowest ask/);
  assert.match((readLadder({ step: "3", every: "14", floor: "100000" }, 100000) as { error: string }).error, /under today's ask/);
  assert.match((readLadder({ step: "3", every: "14", floor: "10" }, 0) as { error: string }).error, /No loans are left/);
});

test("each step takes a share of the ask, stops at the floor, and spreads over the loans to the cent", () => {
  assert.equal(nextAsk(100000, 300, 90000), 97000);
  assert.equal(nextAsk(91000, 300, 90000), 90000);
  assert.equal(nextAsk(90000, 300, 90000), null);
  assert.equal(stepsToFloor(100000, 300, 90000), 4);
  const spread = spreadAsk([{ id: "a", askingPrice: 33333.33, tradeStatus: "AVAILABLE" }, { id: "b", askingPrice: 66666.67, tradeStatus: "AVAILABLE" }], 97000);
  assert.equal(Math.round(spread.reduce((sum, row) => sum + row.price, 0) * 100), 9700000);
  assert.deepEqual(openAsk([{ id: "a", askingPrice: 10, tradeStatus: "AVAILABLE" }, { id: "b", askingPrice: 5, tradeStatus: "SOLD" }]).ask, 10);
});

test("a ladder runs only on a live listing that holds no fixed price", () => {
  assert.equal(ladderBlock(live), null);
  assert.match(ladderBlock({ ...live, status: "PENDING" }) ?? "", /only while the listing is live/);
  assert.match(ladderBlock({ ...live, bidMode: "SEALED" }) ?? "", /deadline/);
  assert.match(ladderBlock({ ...live, saleEventId: "e1" }) ?? "", /sale event/);
  assert.match(ladderBlock({ ...live, roundOneEndsAt: new Date() }) ?? "", /two-round/);
  assert.match(ladderBlock({ ...live, flowProgramId: "f1" }) ?? "", /forward-flow/);
  assert.match(ladderBlock({ ...live, buyNowPrice: 50000 }) ?? "", /Buy it now/);
  assert.match(ladderLine({ ladderStepBps: 300, ladderEveryDays: 14, ladderFloor: 90000, ladderNextAt: new Date("2026-12-06T12:00:00Z"), ladderStoppedAt: null, ladderStopReason: null }) ?? "", /3% every 14 days, to a floor of \$90,000\. Next step on/);
});

test("the book's cut line reads the latest move, and only when it was a cut", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 10, day));
  const cuts = latestCuts([
    { listingId: "a", before: 100, after: 90, createdAt: at(1) },
    { listingId: "a", before: 90, after: 80, createdAt: at(3) },
    { listingId: "b", before: 100, after: 90, createdAt: at(1) },
    { listingId: "b", before: 90, after: 95, createdAt: at(2) },
  ]);
  assert.deepEqual(cuts.get("a"), { percent: 11.1, at: at(3) });
  assert.equal(cuts.has("b"), false);
  assert.equal(changePercent(100, 97), -3);
  assert.equal(changePercent(0, 5), 0);
});

test("a seller's ladder steps the ask down, waits on a live bid, records each step and stops at the floor", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (who: string, role: string) => prisma.user.create({ data: { email: `ladder-${who}-${tag}@example.org`, name: `${who} ${tag}`, role: role as never, accountStatus: "APPROVED", passwordHash: "x" } });
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const stranger = await person("stranger", "INDIVIDUAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const buyer = await person("buyer", "BUYER");
  const loan = (street: string, ask: number) => ({
    streetAddress: street, city: `Ladderville${tag}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
    lienPosition: "FIRST", upb: 150000, interestRate: 7, monthlyPi: 900, paymentStatus: "PERFORMING", monthsDelinquent: 0, askingPrice: ask, estimatedValue: 250000,
  });
  try {
    const listing = await prisma.listing.create({
      data: { kind: "POOL", sellerId: seller.id, status: "APPROVED", approvedAt: new Date(), title: `Ladder pool ${tag}`, notes: { create: [loan("1 Rung St", 60000), loan("2 Rung St", 40000)] as never } } as never,
    });
    const now = new Date();
    const ids = { listingIds: [listing.id] };

    // Only the seller or the desk's sales side sets it, and the floor must sit under the ask.
    assert.equal((await setPriceLadder(stranger, listing.id, { step: "5", every: "14", floor: "90000" }, now)).ok, false);
    assert.match(((await setPriceLadder(seller, listing.id, { step: "5", every: "14", floor: "120000" }, now)) as { error: string }).error, /under today's ask/);
    const set = await setPriceLadder(seller, listing.id, { step: "5", every: "14", floor: "90000" }, now);
    assert.equal(set.ok, true);
    let row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(row.ladderStepBps, 500);
    assert.equal(row.ladderNextAt?.getTime(), now.getTime() + 14 * DAY);

    // Nothing is due before the date.
    assert.equal((await runPriceLadders(new Date(now.getTime() + 13 * DAY), ids)).sent, 0);

    // The first step: 5% off $100,000, spread over both loans, on the history, the next step 14 days on. Two runs at
    // once move it once.
    const first = new Date(now.getTime() + 15 * DAY);
    const runs = await Promise.all([runPriceLadders(first, ids), runPriceLadders(first, ids)]);
    assert.equal(runs.reduce((sum, run) => sum + run.sent, 0), 1);
    let notes = await prisma.note.findMany({ where: { listingId: listing.id } });
    assert.equal(Math.round(notes.reduce((sum, note) => sum + Number(note.askingPrice), 0) * 100), 9500000);
    assert.deepEqual(notes.map((note) => Number(note.askingPrice)).sort((a, b) => a - b), [38000, 57000]);
    let history = await priceHistory(listing.id);
    assert.deepEqual(history.map((change) => [change.before, change.after, change.loans, change.source]), [[100000, 95000, 2, "LADDER"]]);
    row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(row.ladderNextAt?.getTime(), first.getTime() + 14 * DAY);

    // A live bid holds the price; the step is tried again the next day.
    const bid = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "OPEN", amount: 80000 } });
    const second = new Date(first.getTime() + 15 * DAY);
    assert.equal((await runPriceLadders(second, ids)).sent, 0);
    notes = await prisma.note.findMany({ where: { listingId: listing.id } });
    assert.equal(Math.round(notes.reduce((sum, note) => sum + Number(note.askingPrice), 0)), 95000);
    row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(row.ladderNextAt?.getTime(), second.getTime() + WAIT_DAYS * DAY);

    // Once the bid is gone it steps: 5% off $95,000 is $90,250. The next step lands on the floor and stops the ladder.
    await prisma.inquiry.update({ where: { id: bid.id }, data: { status: "WITHDRAWN" } });
    const third = new Date(second.getTime() + 2 * DAY);
    assert.equal((await runPriceLadders(third, ids)).sent, 1);
    const fourth = new Date(third.getTime() + 15 * DAY);
    assert.equal((await runPriceLadders(fourth, ids)).sent, 1);
    history = await priceHistory(listing.id);
    assert.deepEqual(history.map((change) => change.after), [95000, 90250, 90000]);
    row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(row.ladderNextAt, null);
    assert.equal(row.ladderStopReason, STOP_REASONS.FLOOR);
    assert.equal((await runPriceLadders(new Date(fourth.getTime() + 60 * DAY), ids)).sent, 0);

    // The latest cut shows on the book while it is recent.
    const cuts = await recentCuts(new Date(Date.now() + DAY));
    assert.ok(cuts.get(listing.id)?.percent);

    // A desk edit and a seller's own reprice are marked by who made them.
    await watchReprice({ listingId: listing.id, before: 90000, after: 88000, loans: 2, actorId: desk.id });
    await watchReprice({ listingId: listing.id, before: 88000, after: 89000, loans: 2, actorId: seller.id });
    history = await priceHistory(listing.id);
    assert.deepEqual(history.slice(-2).map((change) => change.source), ["DESK", "SELLER"]);

    // A new ladder can be set and stopped by the seller.
    assert.equal((await setPriceLadder(seller, listing.id, { step: "2", every: "30", floor: "80000" }, now)).ok, true);
    assert.equal((await stopPriceLadder(stranger, listing.id, now)).ok, false);
    assert.equal((await stopPriceLadder(seller, listing.id, now)).ok, true);
    row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(row.ladderStopReason, STOP_REASONS.SELLER);
    assert.equal((await stopPriceLadder(seller, listing.id, now)).ok, false);

    // A sealed sale takes no ladder.
    await prisma.listing.update({ where: { id: listing.id }, data: { bidMode: "SEALED", bidDeadline: new Date(Date.now() + 7 * DAY) } });
    assert.match(((await setPriceLadder(seller, listing.id, { step: "2", every: "30", floor: "80000" }, now)) as { error: string }).error, /deadline/);
  } finally {
    const users = [seller.id, stranger.id, desk.id, buyer.id];
    const listings = (await prisma.listing.findMany({ where: { sellerId: seller.id }, select: { id: true } })).map((row) => row.id);
    await prisma.priceChange.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.listingMatch.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.inquiry.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: listings } } });
    await prisma.note.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.listing.deleteMany({ where: { id: { in: listings } } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { subject: { contains: tag } }] } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
});
