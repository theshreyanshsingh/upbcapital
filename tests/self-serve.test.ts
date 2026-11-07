import assert from "node:assert/strict";
import test from "node:test";
import { listingIsPublic } from "../lib/access";
import { askSeller, awardOffer, checkAward, recordSellerCounter, withdrawBid, withdrawListing } from "../lib/awards";
import { diligenceDays, diligenceEnd, diligenceOpen, openClosing, walkAwayFromClosing } from "../lib/closing-service";
import { expireBids } from "../lib/jobs";
import { deskDecisionAllowed, listingWithdrawBlock } from "../lib/listing-status";
import { bidExpired, buyerPrice, counterFrom, openCounter, readGoodUntil, withdrawBlock } from "../lib/offers";
import { prisma } from "../lib/prisma";
import { clearSettingsCache } from "../lib/settings";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

test("a good-until date is the end of a future day, within 90 days, and not before a sealed deadline", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const open = { bidMode: "NONE", bidDeadline: null };
  assert.deepEqual(readGoodUntil("", open, now), { error: null, expiresAt: null });
  assert.equal(readGoodUntil("2026-11-12", open, now).expiresAt?.toISOString(), "2026-11-12T23:59:00.000Z");
  assert.match(readGoodUntil("2026-11-04", open, now).error ?? "", /in the future/);
  assert.match(readGoodUntil("next week", open, now).error ?? "", /as a date/);
  assert.match(readGoodUntil("2027-03-01", open, now).error ?? "", /within 90 days/);
  const sealed = { bidMode: "SEALED", bidDeadline: new Date("2026-11-20T17:00:00Z") };
  assert.match(readGoodUntil("2026-11-19", sealed, now).error ?? "", /on or after it/);
  assert.equal(readGoodUntil("2026-11-20", sealed, now).error, null);
  assert.equal(bidExpired(null, now), false);
  assert.equal(bidExpired(new Date(now.getTime() - 1), now), true);
  assert.equal(bidExpired(new Date(now.getTime() + DAY), now), false);
});

test("a bid can be withdrawn before an award, but not once a sealed or best-and-final round closes", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const bid = { type: "OFFER", status: "OPEN", bidMode: "NONE", bidDeadline: null, group: false, now };
  assert.equal(withdrawBlock(bid), null);
  assert.equal(withdrawBlock({ ...bid, status: "REVIEWED" }), null);
  assert.match(withdrawBlock({ ...bid, status: "ACCEPTED" }) ?? "", /accepted/);
  assert.match(withdrawBlock({ ...bid, status: "DECLINED" }) ?? "", /already closed/);
  assert.match(withdrawBlock({ ...bid, status: "EXPIRED" }) ?? "", /already closed/);
  assert.match(withdrawBlock({ ...bid, type: "INFO_REQUEST" }) ?? "", /Only a bid/);
  assert.match(withdrawBlock({ ...bid, group: true }) ?? "", /group page/);
  // Before the deadline a sealed bid can still come back. After it, the bid binds until the desk decides.
  const before = new Date(now.getTime() + DAY);
  const after = new Date(now.getTime() - DAY);
  assert.equal(withdrawBlock({ ...bid, bidMode: "SEALED", bidDeadline: before }), null);
  assert.match(withdrawBlock({ ...bid, bidMode: "SEALED", bidDeadline: after }) ?? "", /binds/);
  assert.match(withdrawBlock({ ...bid, bidMode: "BEST_AND_FINAL", bidDeadline: after }) ?? "", /binds/);
  // An open-bid listing has no round to close, so a passed date on it changes nothing.
  assert.equal(withdrawBlock({ ...bid, bidDeadline: after }), null);
});

test("a seller's counter is an open counter for the buyer, never the buyer's price until they take it", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 5, 12, minute));
  const messages = [
    { kind: "OFFER", amount: 90000, createdAt: at(1), authorId: "buyer" },
    { kind: "COUNTER", amount: 100000, createdAt: at(2), authorId: "seller" },
  ];
  assert.equal(buyerPrice(90000, messages, "buyer"), 90000);
  assert.equal(openCounter(messages, "buyer"), 100000);
  assert.equal(counterFrom(messages, "buyer", "seller"), "seller");
  const deskAfter = [...messages, { kind: "COUNTER", amount: 95000, createdAt: at(3), authorId: "desk" }];
  assert.equal(counterFrom(deskAfter, "buyer", "seller"), "desk");
  const accepted = [...messages, { kind: "COUNTER", amount: 100000, createdAt: at(3), authorId: "buyer" }];
  assert.equal(buyerPrice(90000, accepted, "buyer"), 100000);
  assert.equal(openCounter(accepted, "buyer"), null);
  assert.equal(counterFrom(accepted, "buyer", "seller"), null);
});

test("a withdrawn listing is off the book and takes no desk decision", () => {
  assert.equal(listingIsPublic("WITHDRAWN"), false);
  for (const action of ["UNDER_REVIEW", "APPROVE", "REQUEST_CHANGES", "REJECT", "MARK_PENDING", "MARK_SOLD"]) {
    assert.equal(deskDecisionAllowed(action, "WITHDRAWN"), false, action);
  }
  for (const status of ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "CHANGES_REQUESTED", "REJECTED"]) assert.equal(listingWithdrawBlock(status, 0), null, status);
  assert.match(listingWithdrawBlock("PENDING", 1) ?? "", /closing is open/);
  assert.match(listingWithdrawBlock("APPROVED", 1) ?? "", /closing is open/);
  assert.match(listingWithdrawBlock("SOLD", 0) ?? "", /sold/);
  assert.match(listingWithdrawBlock("WITHDRAWN", 0) ?? "", /already withdrawn/);
});

test("the diligence window is set for a buyer's award only, and closes on its date", () => {
  const opened = new Date("2026-11-05T12:00:00Z");
  assert.equal(diligenceDays(null), 0);
  assert.equal(diligenceDays(0), 0);
  assert.equal(diligenceDays(99), 0);
  assert.equal(diligenceDays(7), 7);
  assert.equal(diligenceEnd(7, false, opened)?.toISOString(), "2026-11-12T12:00:00.000Z");
  assert.equal(diligenceEnd(7, true, opened), null);
  assert.equal(diligenceEnd(0, false, opened), null);
  const ends = new Date(opened.getTime() + DAY);
  assert.equal(diligenceOpen({ status: "OPEN", diligenceEndsAt: ends }, opened), true);
  assert.equal(diligenceOpen({ status: "OPEN", diligenceEndsAt: ends }, new Date(ends.getTime() + 1)), false);
  assert.equal(diligenceOpen({ status: "CANCELED", diligenceEndsAt: ends }, opened), false);
  assert.equal(diligenceOpen({ status: "OPEN", diligenceEndsAt: null }, opened), false);
});

const note = (street: string) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 80000, estimatedValue: 150000,
});

type Deal = Awaited<ReturnType<typeof makeDeal>>;

// Timestamp-tagged people and a listing, so parallel runs never share rows and cleanup finds everything.
async function makeDeal(opts: { status?: string; bidMode?: "NONE" | "SEALED" | "BEST_AND_FINAL"; bidDeadline?: Date; reserve?: number | null; broker?: boolean } = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const user = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN" | "BROKER") =>
    prisma.user.create({ data: { email: `ss-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const seller = await user("seller", "INDIVIDUAL_SELLER");
  const buyer = await user("buyer", "BUYER");
  const second = await user("second", "BUYER");
  const desk = await user("desk", "ADMIN");
  const broker = await user("broker", "BROKER");
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: (opts.status ?? "APPROVED") as "APPROVED",
      approvedAt: new Date(),
      title: `Self serve ${tag}`,
      bidMode: opts.bidMode ?? "NONE",
      ...(opts.bidDeadline ? { bidDeadline: opts.bidDeadline } : {}),
      ...(opts.reserve != null ? { reservePrice: opts.reserve } : {}),
      ...(opts.broker ? { brokerId: broker.id, brokerRole: "SELLER_BROKER" as const, clientSellerName: "Helen Marsh" } : {}),
      notes: { create: [note("1 First St"), note("2 Second St")] as never },
    },
    include: { notes: true },
  });
  return { tag, seller, buyer, second, desk, broker, listing, users: [seller, buyer, second, desk, broker] };
}

async function cleanDeal(deal: Deal) {
  const listingId = deal.listing.id;
  const inquiries = await prisma.inquiry.findMany({ where: { listingId }, select: { id: true } });
  const closings = await prisma.closing.findMany({ where: { listingId }, select: { id: true } });
  const ids = [listingId, ...inquiries.map((row) => row.id), ...closings.map((row) => row.id)];
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId }, { inquiryId: { in: inquiries.map((row) => row.id) } }, { closingId: { in: closings.map((row) => row.id) } }] } });
  await prisma.ofacCheck.deleteMany({ where: { userId: { in: deal.users.map((user) => user.id) } } });
  await prisma.groupBuy.deleteMany({ where: { listingId } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: deal.users.map((user) => user.email) } }, { subject: { contains: deal.listing.title } }] } });
  await prisma.user.deleteMany({ where: { id: { in: deal.users.map((user) => user.id) } } });
}

const bid = (deal: Deal, buyerId: string, amount: number, extra: Record<string, unknown> = {}) =>
  prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId, type: "OFFER", status: "OPEN", amount, ...extra } });

const statusOf = async (id: string) => (await prisma.inquiry.findUniqueOrThrow({ where: { id } })).status;
// Desk notices reach every approved admin, so the deal's desk also hears other files' deals. Each subject names its
// listing, so this counts only the deal's own.
const mail = (deal: Deal, toEmail: string, subject: string) =>
  prisma.notification.count({ where: { toEmail, subject: `${subject} · ${deal.listing.title}` } });

test("a bid past its good-until date can't be awarded, and the job marks it expired and tells the buyer once", async () => {
  const deal = await makeDeal({ reserve: 1000 });
  try {
    const lapsed = await bid(deal, deal.buyer.id, 90000, { expiresAt: new Date(Date.now() - 60_000) });
    const standing = await bid(deal, deal.second.id, 85000, { expiresAt: new Date(Date.now() + DAY) });
    const open = await bid(deal, deal.second.id, 84000, { noteId: deal.listing.notes[0].id });
    // Before the job runs the bid is still open, but the award refuses it on the date alone.
    assert.match((await checkAward(lapsed.id)).error ?? "", /good-until date/);
    assert.match((await awardOffer(lapsed.id, deal.desk.id)).error ?? "", /good-until date/);
    assert.equal(await prisma.closing.count({ where: { listingId: deal.listing.id } }), 0);

    const own = { inquiryIds: [lapsed.id, standing.id, open.id] };
    const runs = await Promise.all([expireBids(new Date(), own), expireBids(new Date(), own)]);
    assert.ok(runs.every((tally) => tally.failed === 0));
    assert.equal(await statusOf(lapsed.id), "EXPIRED");
    assert.equal(await statusOf(standing.id), "OPEN");
    assert.equal(await statusOf(open.id), "OPEN");
    assert.equal(await mail(deal, deal.buyer.email, "Bid expired"), 1);
    assert.match((await checkAward(lapsed.id)).error ?? "", /good-until date/);
  } finally {
    await cleanDeal(deal);
  }
});

test("a buyer withdraws an open bid, the desk and an asked seller hear, and a sealed bid binds after the deadline", async () => {
  const deal = await makeDeal();
  try {
    const offer = await bid(deal, deal.buyer.id, 90000);
    const asked = await checkAward(offer.id);
    assert.equal(asked.error, null);
    if (asked.error === null) await askSeller(asked.offer, asked.price);
    assert.equal((await withdrawBid(offer.id, deal.second.id)).error, "That bid isn't yours.");
    assert.equal((await withdrawBid(offer.id, deal.buyer.id)).error, null);
    const row = await prisma.inquiry.findUniqueOrThrow({ where: { id: offer.id } });
    assert.equal(row.status, "WITHDRAWN");
    assert.ok(row.withdrawnAt);
    assert.equal(await mail(deal, deal.desk.email, "Bid withdrawn"), 1);
    assert.equal(await mail(deal, deal.seller.email, "Bid withdrawn"), 1);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: offer.id, action: "BID_WITHDRAWN" } }), 1);
    assert.match((await withdrawBid(offer.id, deal.buyer.id)).error ?? "", /already closed/);
    assert.equal((await checkAward(offer.id)).error, "The buyer withdrew that bid.");

    // A bid the seller was never asked about doesn't reach the seller.
    const quiet = await bid(deal, deal.second.id, 70000);
    assert.equal((await withdrawBid(quiet.id, deal.second.id)).error, null);
    assert.equal(await mail(deal, deal.seller.email, "Bid withdrawn"), 1);

    // A group's bid comes back through the group, with a pointer to it.
    const lead = await bid(deal, deal.second.id, 80000);
    const group = await prisma.groupBuy.create({ data: { listingId: deal.listing.id, openedById: deal.second.id, minPosition: 10000, deadline: new Date(Date.now() + DAY), targetAmount: 80000, inquiryId: lead.id, status: "OFFERED" } });
    const refused = await withdrawBid(lead.id, deal.second.id);
    assert.match(refused.error ?? "", /group page/);
    assert.equal(refused.groupId, group.id);
    assert.equal(await statusOf(lead.id), "OPEN");

    // Sealed: free to withdraw before the deadline, bound after it.
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { bidMode: "SEALED", bidDeadline: new Date(Date.now() + DAY) } });
    const early = await bid(deal, deal.buyer.id, 60000);
    assert.equal((await withdrawBid(early.id, deal.buyer.id)).error, null);
    const late = await bid(deal, deal.buyer.id, 61000);
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { bidDeadline: new Date(Date.now() - 60_000) } });
    assert.match((await withdrawBid(late.id, deal.buyer.id)).error ?? "", /binds/);
    assert.equal(await statusOf(late.id), "OPEN");
  } finally {
    await cleanDeal(deal);
  }
});

test("a withdrawal and an award landing together leave one outcome", async () => {
  const deal = await makeDeal({ reserve: 1000 });
  try {
    const offer = await bid(deal, deal.buyer.id, 90000);
    const [award, withdrawal] = await Promise.all([awardOffer(offer.id, deal.desk.id), withdrawBid(offer.id, deal.buyer.id)]);
    assert.equal([award.error, withdrawal.error].filter((error) => error === null).length, 1);
    const status = await statusOf(offer.id);
    const closings = await prisma.closing.count({ where: { listingId: deal.listing.id } });
    assert.equal(status === "ACCEPTED", closings === 1);
    assert.equal(status === "WITHDRAWN", closings === 0);
  } finally {
    await cleanDeal(deal);
  }
});

test("a seller's counter is their approval at that price, and the buyer accepting it can be awarded without asking again", async () => {
  const deal = await makeDeal();
  try {
    const offer = await bid(deal, deal.buyer.id, 90000);
    await prisma.offerMessage.create({ data: { inquiryId: offer.id, authorId: deal.buyer.id, kind: "OFFER", amount: 90000, body: "Opening bid.", createdAt: new Date(Date.now() - 60_000) } });
    const first = await checkAward(offer.id);
    assert.equal(first.error, null);
    assert.equal(first.error === null && first.agreed, null);
    if (first.error === null) await askSeller(first.offer, first.price);

    assert.equal((await recordSellerCounter(offer.id, deal.buyer.id, 100000)).error, "That bid isn't on your listing.");
    assert.match((await recordSellerCounter(offer.id, deal.seller.id, 90000)).error ?? "", /above the buyer's bid/);
    assert.equal((await recordSellerCounter(offer.id, deal.seller.id, 100000)).error, null);
    // A second answer to the same question finds it already answered.
    assert.match((await recordSellerCounter(offer.id, deal.seller.id, 110000)).error ?? "", /waiting for your answer/);

    const row = await prisma.inquiry.findUniqueOrThrow({ where: { id: offer.id }, include: { messages: true } });
    assert.equal(row.sellerCounterAmount, 100000);
    assert.equal(row.sellerApprovedAmount, 100000);
    assert.ok(row.sellerCounteredAt && row.sellerAnsweredAt);
    const priced = row.messages.map((message) => ({ kind: message.kind, amount: message.amount, createdAt: message.createdAt, authorId: message.authorId }));
    assert.equal(openCounter(priced, deal.buyer.id), 100000);
    assert.equal(counterFrom(priced, deal.buyer.id, deal.seller.id), "seller");
    assert.equal(await mail(deal, deal.buyer.email, "Seller counter"), 1);
    assert.equal(await mail(deal, deal.desk.email, "Seller countered"), 1);

    // Until the buyer takes it, their own price stands and the seller hasn't agreed to that.
    assert.equal((await awardOffer(offer.id, deal.desk.id)).error, "The seller hasn't approved this price.");

    // The buyer accepts through the accept-counter flow, which posts their own message at the counter.
    await prisma.offerMessage.create({ data: { inquiryId: offer.id, authorId: deal.buyer.id, kind: "COUNTER", amount: 100000, body: "Accepted the seller's counter at $100,000." } });
    const ready = await checkAward(offer.id);
    assert.equal(ready.error === null && ready.agreed, "approved");
    const award = await awardOffer(offer.id, deal.desk.id);
    assert.equal(award.error, null);
    assert.equal(award.error === null && award.price, 100000);
    const closing = await prisma.closing.findFirstOrThrow({ where: { inquiryId: offer.id } });
    assert.equal(closing.salePrice, 100000);
  } finally {
    await cleanDeal(deal);
  }
});

test("withdrawing a listing declines its bids, ends desk bids, dissolves groups, and refuses with an open closing", async () => {
  const deal = await makeDeal({ broker: true });
  try {
    const listingId = deal.listing.id;
    const one = await bid(deal, deal.buyer.id, 90000);
    const two = await bid(deal, deal.second.id, 40000, { noteId: deal.listing.notes[0].id });
    const deskBid = await prisma.deskBid.create({ data: { listingId, amount: 70000 } });
    const gathering = await prisma.groupBuy.create({ data: { listingId, openedById: deal.buyer.id, minPosition: 10000, deadline: new Date(Date.now() + DAY), targetAmount: 80000, status: "GATHERING" } });
    await prisma.groupPosition.create({ data: { groupId: gathering.id, userId: deal.second.id, seat: 1, amount: 20000, percent: 25, status: "PLEDGED" } });

    assert.equal((await withdrawListing(listingId, deal.desk.id)).error, "That listing isn't yours.");
    // The filing broker may withdraw it, and the seller of record hears.
    const result = await withdrawListing(listingId, deal.broker.id);
    assert.equal(result.error, null);
    assert.equal(result.error === null && result.declined, 2);
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    assert.equal(listing.status, "WITHDRAWN");
    assert.ok(listing.withdrawnAt);
    assert.equal(await statusOf(one.id), "DECLINED");
    assert.equal(await statusOf(two.id), "DECLINED");
    assert.equal((await prisma.deskBid.findUniqueOrThrow({ where: { id: deskBid.id } })).status, "WITHDRAWN");
    assert.equal((await prisma.groupBuy.findUniqueOrThrow({ where: { id: gathering.id } })).status, "DISSOLVED");
    assert.equal(await mail(deal, deal.buyer.email, "Listing withdrawn"), 1);
    assert.equal(await mail(deal, deal.second.email, "Listing withdrawn"), 1);
    assert.equal(await mail(deal, deal.second.email, "Group closed"), 1);
    assert.equal(await mail(deal, deal.seller.email, "Listing withdrawn"), 1);
    assert.equal(await mail(deal, deal.desk.email, "Listing withdrawn"), 1);
    assert.equal(await prisma.reviewComment.count({ where: { listingId, action: "WITHDRAW" } }), 1);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: listingId, action: "LISTING_WITHDRAWN" } }), 1);
    assert.match((await withdrawListing(listingId, deal.seller.id)).error ?? "", /already withdrawn/);
    assert.match((await checkAward(one.id)).error ?? "", /declined/);
  } finally {
    await cleanDeal(deal);
  }

  // A pool with one loan in an open closing stays live and can't be withdrawn until that closing ends.
  const busy = await makeDeal();
  try {
    const won = await bid(busy, busy.buyer.id, 40000, { status: "ACCEPTED", noteId: busy.listing.notes[0].id });
    await prisma.note.update({ where: { id: busy.listing.notes[0].id }, data: { tradeStatus: "IN_CONTRACT" } });
    await openClosing({ listingId: busy.listing.id, inquiryId: won.id, noteId: busy.listing.notes[0].id, salePrice: 40000, title: busy.listing.title });
    assert.match((await withdrawListing(busy.listing.id, busy.seller.id)).error ?? "", /closing is open/);
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: busy.listing.id } })).status, "APPROVED");
  } finally {
    await cleanDeal(busy);
  }
});

test("a buyer walks away inside the diligence window, and the closing cancels with both sides told", async () => {
  const deal = await makeDeal({ status: "PENDING" });
  const before = await prisma.platformSettings.findUnique({ where: { id: "default" }, select: { diligenceDays: true } });
  try {
    await prisma.platformSettings.upsert({ where: { id: "default" }, update: { diligenceDays: 5 }, create: { id: "default", diligenceDays: 5 } });
    clearSettingsCache();
    const offer = await bid(deal, deal.buyer.id, 90000, { status: "ACCEPTED" });
    const closing = await openClosing({ listingId: deal.listing.id, inquiryId: offer.id, noteId: null, salePrice: 90000, title: deal.listing.title });
    const days = closing.diligenceEndsAt ? Math.round((closing.diligenceEndsAt.getTime() - closing.openedAt.getTime()) / DAY) : null;
    assert.equal(days, 5);
    // The desk buying for its own book has no window.
    const deskBid = await prisma.deskBid.create({ data: { listingId: deal.listing.id, amount: 70000, status: "ACCEPTED" } });
    const deskClosing = await openClosing({ listingId: deal.listing.id, deskBidId: deskBid.id, noteId: null, salePrice: 70000, title: deal.listing.title });
    assert.equal(deskClosing.diligenceEndsAt ?? null, null);
    await prisma.closing.update({ where: { id: deskClosing.id }, data: { status: "CANCELED" } });

    assert.equal((await walkAwayFromClosing(closing.id, deal.second.id, "Title search shows a second lien.")).error, "Only the buyer on this closing can walk away.");
    assert.match((await walkAwayFromClosing(closing.id, deal.buyer.id, "No.")).error ?? "", /what you found/);
    assert.equal((await walkAwayFromClosing(closing.id, deal.buyer.id, "Title search shows a second lien.")).error, null);
    const after = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
    assert.equal(after.status, "CANCELED");
    assert.match(after.cancelReason ?? "", /second lien/);
    assert.equal(await statusOf(offer.id), "WITHDRAWN");
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: deal.listing.id } })).status, "APPROVED");
    assert.equal(await mail(deal, deal.seller.email, "Buyer walked away"), 1);
    assert.equal(await mail(deal, deal.buyer.email, "Buyer walked away"), 1);
    assert.equal(await mail(deal, deal.desk.email, "Buyer walked away"), 1);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: closing.id, action: "DILIGENCE_WALK_AWAY" } }), 1);
    assert.match((await walkAwayFromClosing(closing.id, deal.buyer.id, "Title search shows a second lien.")).error ?? "", /already finished/);

    // Once the window has closed the purchase terms govern, and the closing stays open.
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { status: "PENDING" } });
    const again = await bid(deal, deal.buyer.id, 91000, { status: "ACCEPTED" });
    const late = await openClosing({ listingId: deal.listing.id, inquiryId: again.id, noteId: null, salePrice: 91000, title: deal.listing.title });
    await prisma.closing.update({ where: { id: late.id }, data: { diligenceEndsAt: new Date(Date.now() - 60_000) } });
    assert.match((await walkAwayFromClosing(late.id, deal.buyer.id, "Changed my mind about the pool.")).error ?? "", /window has closed/);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: late.id } })).status, "OPEN");
  } finally {
    await prisma.platformSettings.update({ where: { id: "default" }, data: { diligenceDays: before?.diligenceDays ?? null } });
    clearSettingsCache();
    await cleanDeal(deal);
  }
});
