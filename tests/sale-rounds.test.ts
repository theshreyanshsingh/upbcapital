import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { checkAward, sellerPickBid } from "../lib/awards";
import { feedEvents } from "../lib/calendar-feed";
import { checkOffer, writeInquiry } from "../lib/inquiry";
import { prisma } from "../lib/prisma";
import { documentGate } from "../lib/room-access";
import {
  INDICATIVE_LABEL,
  INDICATIVE_REFUSED,
  NOT_SHORTLISTED,
  firmShortlisted,
  roundBidBlock,
  roundOneBook,
  roundStage,
  roundStateFor,
  roundsLine,
  roundsProblem,
  setFinalRoundOnly,
  setSaleRounds,
  setShortlist,
  twoRounds,
} from "../lib/sale-rounds";
import { bidSummary, sellerCounterBlock } from "../lib/seller-decisions";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
// A state nothing seeded uses, so no buy box or standing bid reaches these listings.
const STATE = "QV";
const made = { users: [] as { id: string; email: string }[], listings: [] as string[] };

type Role = "BUYER" | "ADMIN" | "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER";

async function person(who: string, role: Role, data: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `rounds-${who}-${tag}@example.org`,
      name: `Rounds ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const, companyName: `${who} Capital ${tag}` } : {}),
      ...data,
    } as never,
  });
  made.users.push(user);
  return user;
}

async function buyer(who: string) {
  const user = await person(who, "BUYER");
  await prisma.buyerProfile.create({
    data: { userId: user.id, status: "APPROVED", entityType: "LLC", entityName: `${who} Notes LLC ${tag}`, jurisdiction: "Delaware", homesControlled: 0, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY) },
  });
  return user;
}

const loan = (street: string): Prisma.NoteCreateWithoutListingInput => ({
  streetAddress: `${street} ${tag}`,
  city: "Round Rock",
  state: STATE,
  zip: "99782",
  propertyType: "SFR",
  occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST",
  upb: 150000,
  interestRate: 6.5,
  monthlyPi: 1000,
  paymentStatus: "PERFORMING",
  monthsDelinquent: 0,
  askingPrice: 50000,
  estimatedValue: 220000,
  borrowerName: "Quincy Marlowe",
});

async function listing(sellerId: string, data: Record<string, unknown> = {}) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      standingBidsNotifiedAt: new Date(),
      title: `Two rounds ${tag} ${made.listings.length + 1}`,
      summary: "A test listing.",
      bidMode: "SEALED",
      bidDeadline: new Date(Date.now() + 10 * DAY),
      notes: { create: [loan("1 Round St")] },
      ...data,
    } as never,
  });
  made.listings.push(row.id);
  return row;
}

const readListing = (id: string) => prisma.listing.findUniqueOrThrow({ where: { id }, include: { seller: true } });

// A bid through the checks the bid form runs, written as the form writes it.
async function bid(user: Awaited<ReturnType<typeof buyer>>, listingId: string, amount: number) {
  const row = await readListing(listingId);
  const check = await checkOffer({ user, listing: row, noteId: "", amount, goodUntil: "", now: new Date() });
  if (check.error !== null) return { error: check.error, inquiry: null };
  const inquiry = await writeInquiry({ user, listing: row, type: "OFFER", noteId: "", amount, message: "", expiresAt: check.expiresAt });
  return { error: null, inquiry };
}

async function placed(user: Awaited<ReturnType<typeof buyer>>, listingId: string, amount: number) {
  const result = await bid(user, listingId, amount);
  if (result.error !== null) throw new Error(result.error);
  return result.inquiry!;
}

const utc = (date: Date) => date.toISOString().slice(0, 16);

// Moves a sale's dates as time would: round one closed an hour ago, or the whole sale over.
const closeRoundOne = (listingId: string) => prisma.listing.update({ where: { id: listingId }, data: { roundOneEndsAt: new Date(Date.now() - HOUR) } });
const closeSale = (listingId: string) => prisma.listing.update({ where: { id: listingId }, data: { bidDeadline: new Date(Date.now() - 60 * 1000) } });

const mailTo = (email: string) => prisma.notification.findMany({ where: { toEmail: email }, orderBy: { createdAt: "asc" } });

let people: {
  seller: Awaited<ReturnType<typeof person>>;
  individual: Awaited<ReturnType<typeof person>>;
  desk: Awaited<ReturnType<typeof person>>;
  trader: Awaited<ReturnType<typeof person>>;
  alpha: Awaited<ReturnType<typeof buyer>>;
  bravo: Awaited<ReturnType<typeof buyer>>;
  charlie: Awaited<ReturnType<typeof buyer>>;
  delta: Awaited<ReturnType<typeof buyer>>;
  seat: Awaited<ReturnType<typeof person>>;
};

// A live sealed listing with two rounds set by its institutional seller: round one ends in three days, the final
// round in ten.
async function twoRoundSale(data: Record<string, unknown> = {}) {
  const row = await listing(people.seller.id, data);
  const set = await setSaleRounds(people.seller, { listingId: row.id, on: true, roundOneEndsAt: utc(new Date(Date.now() + 3 * DAY)) });
  assert.equal(set.error, null);
  return readListing(row.id);
}

test.before(async () => {
  const seller = await person("seller", "INSTITUTIONAL_SELLER", { companyName: `First Rounds Bank ${tag}` });
  const individual = await person("individual", "INDIVIDUAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const trader = await person("trader", "ADMIN", { deskRole: "TRADER" });
  const [alpha, bravo, charlie, delta] = await Promise.all([buyer("alpha"), buyer("bravo"), buyer("charlie"), buyer("delta")]);
  // A trading seat on alpha's firm: its own login, acting as the firm.
  const seat = await person("alpha-seat", "BUYER", { principalId: alpha.id, seatRole: "TRADE", seatAddedAt: new Date() });
  people = { seller, individual, desk, trader, alpha, bravo, charlie, delta, seat };
});

test.after(async () => {
  const userIds = made.users.map((user) => user.id);
  const ids = made.listings;
  const inquiries = (await prisma.inquiry.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((row) => row.id);
  const closings = (await prisma.closing.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((row) => row.id);
  await prisma.closing.deleteMany({ where: { id: { in: closings } } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiries } } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: ids } }, { inquiryId: { in: inquiries } }] } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiries } } });
  await prisma.document.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...inquiries, ...closings, ...userIds] } }, { actorId: { in: userIds } }] } });
  // The desk's notices go to every desk account, so they are found by the tag in their subject.
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.users.map((user) => user.email) } }, { subject: { contains: tag } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------

test("setup takes a round-one date before the final deadline, with two days between, and locks once a bid is in", async () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const deadline = new Date("2026-12-12T17:00:00Z");
  assert.match(roundsProblem({ roundOneEndsAt: new Date("2026-12-04T17:00:00Z"), bidMode: "NONE", bidDeadline: null, now }) ?? "", /sealed bids/);
  assert.match(roundsProblem({ roundOneEndsAt: null, bidMode: "SEALED", bidDeadline: deadline, now }) ?? "", /indicative bids are due/);
  assert.match(roundsProblem({ roundOneEndsAt: new Date("2026-11-19T17:00:00Z"), bidMode: "SEALED", bidDeadline: deadline, now }) ?? "", /in the future/);
  assert.match(roundsProblem({ roundOneEndsAt: new Date("2026-12-11T18:00:00Z"), bidMode: "SEALED", bidDeadline: deadline, now }) ?? "", /at least 2 days/);
  assert.match(roundsProblem({ roundOneEndsAt: new Date("2026-12-04T17:00:00Z"), bidMode: "SEALED", bidDeadline: new Date("2026-11-19T00:00:00Z"), now }) ?? "", /passed/);
  assert.equal(roundsProblem({ roundOneEndsAt: new Date("2026-12-10T17:00:00Z"), bidMode: "SEALED", bidDeadline: deadline, now }), null);
  const terms = { bidMode: "SEALED", bidDeadline: deadline, roundOneEndsAt: new Date("2026-12-04T17:00:00Z") };
  assert.ok(twoRounds(terms));
  assert.equal(roundsLine(terms), "Indicative bids due Dec 4, 2026, 17:00 UTC · final bids from the shortlist due Dec 12, 2026, 17:00 UTC");
  // Open offers, a sale event or a deadline moved before round one put the listing back on one round.
  assert.equal(twoRounds({ ...terms, bidMode: "NONE" }), false);
  assert.equal(twoRounds({ ...terms, saleEventId: "event" }), false);
  assert.equal(roundStage({ ...terms, bidDeadline: new Date("2026-12-01T00:00:00Z") }, now), null);
  assert.equal(roundStage(terms, now), "ONE");
  assert.equal(roundStage(terms, new Date("2026-12-05T00:00:00Z")), "SHORTLIST");
  assert.equal(roundStage({ ...terms, shortlistedAt: new Date("2026-12-05T00:00:00Z") }, new Date("2026-12-06T00:00:00Z")), "FINAL");
  assert.equal(roundStage(terms, new Date("2026-12-13T00:00:00Z")), "ENDED");

  const own = await listing(people.individual.id);
  const institutional = await listing(people.seller.id);
  const at = utc(new Date(Date.now() + 3 * DAY));
  assert.match((await setSaleRounds(people.individual, { listingId: own.id, on: true, roundOneEndsAt: at })).error ?? "", /institutional sellers and brokers/);
  assert.match((await setSaleRounds(people.trader, { listingId: own.id, on: true, roundOneEndsAt: at })).error ?? "", /sales side of the desk/);
  assert.match((await setSaleRounds(people.seller, { listingId: own.id, on: true, roundOneEndsAt: at })).error ?? "", /isn't yours/);
  // The desk sets them up for an individual seller.
  assert.equal((await setSaleRounds(people.desk, { listingId: own.id, on: true, roundOneEndsAt: at })).error, null);
  assert.match((await setSaleRounds(people.seller, { listingId: institutional.id, on: true, roundOneEndsAt: utc(new Date(Date.now() + 9 * DAY + 12 * HOUR)) })).error ?? "", /at least 2 days/);
  const set = await setSaleRounds(people.seller, { listingId: institutional.id, on: true, roundOneEndsAt: at });
  assert.equal(set.error, null);
  const saved = await readListing(institutional.id);
  assert.equal(saved.roundOneEndsAt?.toISOString().slice(0, 16), at);
  assert.equal(await prisma.auditEvent.count({ where: { entityId: institutional.id, action: "SALE_ROUNDS" } }), 1);
  // The seller's calendar carries round one's date beside the final deadline.
  const feed = await feedEvents({ id: people.seller.id, role: people.seller.role, email: people.seller.email });
  assert.ok(feed.some((event) => event.summary === `Indicative bids due: ${saved.title}`));
  assert.ok(feed.some((event) => event.summary === `Final bids due: ${saved.title}`));

  await placed(people.alpha, institutional.id, 45000);
  assert.match((await setSaleRounds(people.seller, { listingId: institutional.id, on: false })).error ?? "", /Bids are in/);
  assert.match((await setSaleRounds(people.desk, { listingId: institutional.id, on: true, roundOneEndsAt: utc(new Date(Date.now() + 4 * DAY)) })).error ?? "", /Bids are in/);
});

test("a round-one bid is stored as round 1, stays sealed from the seller until round one ends, and is refused for award", async () => {
  const sale = await twoRoundSale({ reservePrice: 30000 });
  const first = await placed(people.alpha, sale.id, 45000);
  assert.equal(first.round, 1);
  assert.equal((await roundStateFor(sale, people.alpha))?.form, "INDICATIVE");

  // Sealed from the seller while round one runs: letters, no amounts.
  const before = await roundOneBook(sale.id, people.seller);
  assert.equal(before?.sealed, true);
  assert.deepEqual(before?.rows.map((row) => row.price), [null]);
  const summary = await bidSummary(sale.id, people.seller);
  assert.ok(summary.status === 200);
  assert.equal(summary.rows[0].price, "Sealed until the deadline");
  assert.match(summary.rows[0].status, new RegExp(INDICATIVE_LABEL));
  // The sales desk reads it behind its wall as it reads any sealed bid; a trader doesn't.
  assert.deepEqual((await roundOneBook(sale.id, people.desk))?.rows.map((row) => row.price), [45000]);
  assert.equal((await roundOneBook(sale.id, people.trader))?.sealed, true);
  assert.equal(await roundOneBook(sale.id, people.bravo), null);

  // No award, no pick and no counter from an indicative bid, before or after any deadline.
  assert.equal((await checkAward(first.id)).error, INDICATIVE_REFUSED);
  await closeRoundOne(sale.id);
  const after = await roundOneBook(sale.id, people.seller);
  assert.equal(after?.sealed, false);
  assert.deepEqual(after?.rows.map((row) => [row.bidder.length > 0, row.price]), [[true, 45000]]);
  await closeSale(sale.id);
  assert.equal((await checkAward(first.id)).error, INDICATIVE_REFUSED);
  assert.equal((await sellerPickBid({ inquiryId: first.id, sellerId: people.seller.id, price: 45000 })).error, INDICATIVE_REFUSED);
  const shut = await readListing(sale.id);
  assert.match(sellerCounterBlock({ type: "OFFER", status: "OPEN", listing: shut, expiresAt: null, current: 45000, amount: 50000, picked: false, round: 1 }) ?? "", /indicative bid/);
  assert.equal(await prisma.closing.count({ where: { listingId: sale.id } }), 0);
});

test("the shortlist is chosen after round one, the notices name no amount or bidder, and the others close", async () => {
  const sale = await twoRoundSale();
  const a = await placed(people.alpha, sale.id, 45000);
  const b = await placed(people.bravo, sale.id, 47000);
  const c = await placed(people.charlie, sale.id, 43000);
  assert.match((await setShortlist(people.seller, { listingId: sale.id, inquiryIds: [a.id] })).error ?? "", /Round one runs until/);

  await closeRoundOne(sale.id);
  // Between the rounds nobody bids, not even a round-one bidder.
  assert.match((await bid(people.delta, sale.id, 50000)).error ?? "", /choosing the shortlist/);
  assert.match((await bid(people.alpha, sale.id, 50000)).error ?? "", /choosing the shortlist/);
  assert.equal((await roundStateFor(await readListing(sale.id), people.delta))?.title, "Shortlist being chosen");
  // A price posted on an indicative bid after round one closed doesn't move it on the shortlist.
  await prisma.offerMessage.create({ data: { inquiryId: c.id, authorId: people.charlie.id, kind: "COUNTER", amount: 99000, body: "Counter." } });
  const book = await roundOneBook(sale.id, people.seller);
  assert.deepEqual(book?.rows.map((row) => row.price), [47000, 45000, 43000]);

  assert.match((await setShortlist(people.bravo, { listingId: sale.id, inquiryIds: [a.id] })).error ?? "", /isn't yours/);
  assert.match((await setShortlist(people.trader, { listingId: sale.id, inquiryIds: [a.id] })).error ?? "", /isn't yours/);
  assert.match((await setShortlist(people.seller, { listingId: sale.id, inquiryIds: [] })).error ?? "", /at least one/);
  const done = await setShortlist(people.seller, { listingId: sale.id, inquiryIds: [a.id, b.id] });
  assert.equal(done.error, null);
  assert.deepEqual([done.shortlisted, done.of, done.closed], [2, 3, 1]);
  assert.match((await setShortlist(people.desk, { listingId: sale.id, inquiryIds: [c.id] })).error ?? "", /already set/);

  const after = await readListing(sale.id);
  assert.ok(after.shortlistedAt);
  const rows = await prisma.inquiry.findMany({ where: { id: { in: [a.id, b.id, c.id] } } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.ok(byId.get(a.id)?.shortlistedAt && byId.get(b.id)?.shortlistedAt);
  assert.equal(byId.get(c.id)?.shortlistedAt ?? null, null);
  assert.equal(byId.get(c.id)?.status, "DECLINED");
  assert.equal(await prisma.auditEvent.count({ where: { entityId: sale.id, action: "SHORTLIST" } }), 1);

  const others = [people.alpha, people.bravo, people.charlie].flatMap((user) => [user.name, user.email, user.companyName ?? ""]);
  const [yes] = (await mailTo(people.alpha.email)).filter((row) => row.subject === `Final round · ${sale.title}`);
  assert.ok(yes, "the shortlisted bidder hears it");
  assert.match(yes.body, /You're in the final round/);
  assert.match(yes.body, /Final bids are due .*; the final-round files are open to you\./);
  const [no] = (await mailTo(people.charlie.email)).filter((row) => row.subject === `Shortlist decided · ${sale.title}`);
  assert.ok(no, "the bidder left out hears it");
  for (const body of [yes.body, no.body]) {
    assert.doesNotMatch(body, /\$|45,?000|47,?000|43,?000/);
    for (const name of others) assert.ok(!body.includes(name), "no bidder is named");
  }
  assert.equal((await mailTo(people.charlie.email)).filter((row) => row.subject === `Final round · ${sale.title}`).length, 0);
});

test("in the final round only a shortlisted firm bids, through any of its seats, and an award comes only from it", async () => {
  const sale = await twoRoundSale({ reservePrice: 30000 });
  const a = await placed(people.alpha, sale.id, 45000);
  const c = await placed(people.charlie, sale.id, 43000);
  await closeRoundOne(sale.id);
  assert.equal((await setShortlist(people.desk, { listingId: sale.id, inquiryIds: [a.id] })).error, null);
  const live = await readListing(sale.id);

  assert.equal((await bid(people.charlie, sale.id, 50000)).error, NOT_SHORTLISTED);
  assert.equal((await bid(people.delta, sale.id, 50000)).error, NOT_SHORTLISTED);
  assert.equal((await roundStateFor(live, people.charlie))?.title, "Not shortlisted");
  // The firm's seat counts as the firm: its own login reads as shortlisted, and a seat bids as the firm's account.
  assert.equal(await firmShortlisted(sale.id, people.seat.id), true);
  assert.equal(await roundBidBlock(sale.id, people.seat.id), null);
  assert.equal(await firmShortlisted(sale.id, people.charlie.id), false);
  const state = await roundStateFor(live, people.alpha);
  assert.match(state?.title ?? "", /^You're shortlisted: final bids due /);
  assert.equal(state?.form, "FINAL");

  // Lower than the indicative bid is fine: it wasn't binding.
  const final = await placed(people.alpha, sale.id, 40000);
  assert.equal(final.round, 2);
  const replaced = await prisma.inquiry.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(replaced.status, "WITHDRAWN");
  // A bid that reached the listing without the round checks, from a firm off the shortlist, can't win either.
  const stray = await prisma.inquiry.create({ data: { listingId: sale.id, buyerId: people.charlie.id, type: "OFFER", status: "OPEN", amount: 60000 } });
  await prisma.offerMessage.create({ data: { inquiryId: stray.id, authorId: people.charlie.id, kind: "OFFER", amount: 60000, body: "Opening bid." } });

  assert.equal((await checkAward(final.id)).error, "Award this after the bid deadline.");
  await closeSale(sale.id);
  const award = await checkAward(final.id);
  assert.equal(award.error, null);
  assert.equal(award.error === null ? award.agreed : null, "reserve");
  assert.equal((await checkAward(c.id)).error !== null, true);
  assert.match((await checkAward(stray.id)).error ?? "", /shortlisted bidder/);
  assert.equal((await checkAward(a.id)).error !== null, true);
});

test("a final-round file shows but stays shut until the firm is shortlisted, and does nothing on a one-round listing", async () => {
  const sale = await twoRoundSale();
  const one = await listing(people.seller.id, { bidMode: "NONE", bidDeadline: null });
  const file = (listingId: string, name: string, extra: Record<string, unknown> = {}) =>
    prisma.document.create({ data: { listingId, type: "OTHER", originalName: `${name} ${tag}.pdf`, storedName: `rounds-${name}-${tag}`, mime: "application/pdf", size: 10, ...extra } });
  const images = await file(sale.id, "collateral-images");
  const tape = await file(sale.id, "tape");
  const plain = await file(one.id, "one-round", { finalRoundOnly: true });
  for (const user of [people.alpha, people.charlie]) {
    await prisma.ndaAcknowledgment.createMany({ data: [{ userId: user.id, listingId: sale.id }, { userId: user.id, listingId: one.id }] });
  }
  const gate = async (user: Parameters<typeof documentGate>[0], documentId: string) => (await documentGate(user, documentId)).allowed;

  assert.match((await setFinalRoundOnly(people.bravo, { documentId: images.id, on: true })).error ?? "", /isn't on a listing you run/);
  assert.match((await setFinalRoundOnly(people.seller, { documentId: plain.id, on: true })).error ?? "", /two-round sale/);
  assert.equal((await setFinalRoundOnly(people.seller, { documentId: images.id, on: true })).error, null);
  assert.equal(await prisma.auditEvent.count({ where: { entityId: sale.id, action: "FINAL_ROUND_FILE" } }), 1);

  const a = await placed(people.alpha, sale.id, 45000);
  await placed(people.charlie, sale.id, 43000);
  assert.equal(await gate(people.alpha, images.id), false, "shut before the shortlist");
  assert.equal(await gate(people.alpha, tape.id), true, "the rest of the room is open");
  assert.equal(await gate(people.seller, images.id), true, "the seller always opens it");
  assert.equal(await gate(people.desk, images.id), true, "and so does the desk");

  await closeRoundOne(sale.id);
  assert.equal((await setShortlist(people.seller, { listingId: sale.id, inquiryIds: [a.id] })).error, null);
  assert.equal(await gate(people.alpha, images.id), true, "open once shortlisted");
  assert.equal(await gate(people.charlie, images.id), false, "still shut to a firm off the shortlist");

  // On a one-round listing the flag does nothing.
  assert.equal(await gate(people.charlie, plain.id), true);
});

test("with no shortlist by the final deadline, the sale ends with no award", async () => {
  const sale = await twoRoundSale({ reservePrice: 30000 });
  const a = await placed(people.alpha, sale.id, 45000);
  const b = await placed(people.bravo, sale.id, 47000);
  await prisma.listing.update({ where: { id: sale.id }, data: { roundOneEndsAt: new Date(Date.now() - 3 * DAY), bidDeadline: new Date(Date.now() - HOUR) } });
  const ended = await readListing(sale.id);
  assert.equal(roundStage(ended), "ENDED");
  assert.equal((await roundStateFor(ended, people.alpha))?.title, "Ended with no award");
  assert.match((await setShortlist(people.seller, { listingId: sale.id, inquiryIds: [a.id] })).error ?? "", /ended with no award/);
  assert.equal((await bid(people.delta, sale.id, 50000)).error, "The bid deadline has passed.");
  for (const offer of [a, b]) assert.equal((await checkAward(offer.id)).error, INDICATIVE_REFUSED);
  assert.equal(await prisma.closing.count({ where: { listingId: sale.id } }), 0);
});
