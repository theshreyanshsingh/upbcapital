import assert from "node:assert/strict";
import test from "node:test";
import { eventSetsTerms, eventTerms } from "../lib/auction";
import { checkAward, withdrawBid } from "../lib/awards";
import { literal } from "../lib/db-filters";
import { checkOffer, writeInquiry } from "../lib/inquiry";
import { readGoodUntil, withdrawBlock } from "../lib/offers";
import { prisma } from "../lib/prisma";
import {
  advanceSaleEvent,
  advanceSaleEvents,
  cancelEvent,
  createEvent,
  datesProblem,
  editEvent,
  enterEvent,
  inputValue,
  joinBlock,
  leaveBlock,
  leaveEvent,
  nextStatus,
  readEventDates,
  splitIndications,
  usualGap,
} from "../lib/sale-events";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Desk and seller notices stay in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

const at = (iso: string) => new Date(`${iso}Z`);

test("best and final falls 7 to 30 days after indications, with 16 to 21 usual and 16 by default", () => {
  const now = at("2026-11-06T12:00:00");
  assert.match(readEventDates("2026-11-05T17:00", "2026-11-25T17:00", now).error ?? "", /in the future/);
  assert.match(readEventDates("", "2026-11-25T17:00", now).error ?? "", /indications date/);
  assert.match(readEventDates("next week", "", now).error ?? "", /indications date/);
  assert.match(readEventDates("2026-11-20T17:00", "soon", now).error ?? "", /or leave it blank/);
  // Under 7 days, or over 30, is refused, and the message names the usual gap.
  assert.match(readEventDates("2026-11-20T17:00", "2026-11-27T16:59", now).error ?? "", /7 to 30 days after indications\. 16 to 21 days is usual/);
  assert.match(readEventDates("2026-11-20T17:00", "2026-12-20T17:01", now).error ?? "", /7 to 30 days/);
  assert.match(readEventDates("2026-11-20T17:00", "2026-11-19T17:00", now).error ?? "", /7 to 30 days/);
  const edges = [readEventDates("2026-11-20T17:00", "2026-11-27T17:00", now), readEventDates("2026-11-20T17:00", "2026-12-20T17:00", now)];
  for (const edge of edges) assert.equal(edge.error, null);
  assert.equal(edges[0].error === null && edges[0].usual, false);

  const blank = readEventDates("2026-11-20T17:00", "", now);
  assert.equal(blank.error, null);
  assert.equal(blank.error === null && blank.bestFinalAt.toISOString(), "2026-12-06T17:00:00.000Z");
  assert.equal(blank.error === null && blank.usual, true);
  // The form reads as UTC, like the bid deadline field.
  assert.equal(blank.error === null && blank.indicationsAt.toISOString(), "2026-11-20T17:00:00.000Z");
  assert.equal(usualGap(at("2026-11-20T17:00:00"), at("2026-12-11T17:00:00")), true);
  assert.equal(usualGap(at("2026-11-20T17:00:00"), at("2026-12-12T17:00:00")), false);
  assert.equal(datesProblem({ indicationsAt: at("2026-11-20T17:00:00"), bestFinalAt: at("2026-12-01T17:00:00") }, now), null);
  assert.equal(inputValue(at("2026-11-20T17:00:00")), "2026-11-20T17:00");
});

test("the rounds move on their dates: indications open with the first listing, and a missed round is skipped", () => {
  const dates = { indicationsAt: at("2026-11-20T17:00:00"), bestFinalAt: at("2026-12-06T17:00:00") };
  const before = at("2026-11-10T00:00:00");
  const between = at("2026-11-25T00:00:00");
  const after = at("2026-12-07T00:00:00");
  assert.equal(nextStatus({ ...dates, status: "PLANNED" }, 0, before), null);
  assert.equal(nextStatus({ ...dates, status: "PLANNED" }, 2, before), "INDICATIONS");
  assert.equal(nextStatus({ ...dates, status: "PLANNED" }, 0, between), "CANCELED");
  assert.equal(nextStatus({ ...dates, status: "INDICATIONS" }, 0, before), null);
  assert.equal(nextStatus({ ...dates, status: "INDICATIONS" }, 0, dates.indicationsAt), "BEST_AND_FINAL");
  assert.equal(nextStatus({ ...dates, status: "INDICATIONS" }, 0, after), "CLOSED");
  assert.equal(nextStatus({ ...dates, status: "BEST_AND_FINAL" }, 0, between), null);
  assert.equal(nextStatus({ ...dates, status: "BEST_AND_FINAL" }, 0, dates.bestFinalAt), "CLOSED");
  for (const status of ["CLOSED", "CANCELED"]) assert.equal(nextStatus({ ...dates, status }, 3, after), null);

  // Both rounds share the best-and-final date as the deadline, so every deadline check waits for it.
  assert.deepEqual(eventTerms("INDICATIONS", dates.bestFinalAt), { bidMode: "SEALED", bidDeadline: dates.bestFinalAt });
  assert.deepEqual(eventTerms("BEST_AND_FINAL", dates.bestFinalAt), { bidMode: "BEST_AND_FINAL", bidDeadline: dates.bestFinalAt });
  for (const status of ["PLANNED", "INDICATIONS", "BEST_AND_FINAL"]) assert.equal(eventSetsTerms(status), true);
  for (const status of ["CLOSED", "CANCELED", null, undefined, ""]) assert.equal(eventSetsTerms(status), false);
});

test("at the round change indications are released, later bids and group bids stay", () => {
  const since = at("2026-11-01T00:00:00");
  const indicationsAt = at("2026-11-20T17:00:00");
  const bid = (id: string, status: string, placed: string, group = false) => ({ id, buyerId: `b-${id}`, status, createdAt: at(placed), group });
  const split = splitIndications(
    [
      bid("early", "OPEN", "2026-11-10T00:00:00"),
      bid("countered", "REVIEWED", "2026-11-12T00:00:00"),
      bid("pulled", "WITHDRAWN", "2026-11-11T00:00:00"),
      bid("old-pulled", "WITHDRAWN", "2026-10-01T00:00:00"),
      bid("late", "OPEN", "2026-11-20T18:00:00"),
      bid("late-pulled", "WITHDRAWN", "2026-11-21T00:00:00"),
      bid("group", "OPEN", "2026-11-10T00:00:00", true),
    ],
    { since, indicationsAt },
  );
  assert.deepEqual(split.release.map((item) => item.id), ["early", "countered", "pulled"]);
  assert.deepEqual(split.keep.map((item) => item.id), ["late", "group"]);
});

test("who may join and leave an event", () => {
  const now = at("2026-11-06T12:00:00");
  const event = { id: "e1", status: "INDICATIONS", indicationsAt: at("2026-11-20T17:00:00") };
  const base = { event, listing: { status: "APPROVED", saleEventId: null }, currentEventStatus: null, liveBids: 0, consent: "Email of Nov 5", now };
  assert.equal(joinBlock(base), null);
  assert.equal(joinBlock({ ...base, event: { ...event, status: "PLANNED" } }), null);
  assert.match(joinBlock({ ...base, event: { ...event, status: "BEST_AND_FINAL" } }) ?? "", /no longer taking listings/);
  assert.match(joinBlock({ ...base, now: at("2026-11-20T17:00:00") }) ?? "", /already due/);
  for (const status of ["SUBMITTED", "PENDING", "SOLD", "WITHDRAWN"]) assert.match(joinBlock({ ...base, listing: { status } }) ?? "", /Only a live listing/);
  assert.match(joinBlock({ ...base, listing: { status: "APPROVED", saleEventId: "e1" }, currentEventStatus: "INDICATIONS" }) ?? "", /already in this event/);
  assert.match(joinBlock({ ...base, listing: { status: "APPROVED", saleEventId: "e0" }, currentEventStatus: "BEST_AND_FINAL" }) ?? "", /another open event/);
  // A listing from a closed event may join a new one.
  assert.equal(joinBlock({ ...base, listing: { status: "APPROVED", saleEventId: "e0" }, currentEventStatus: "CLOSED" }), null);
  assert.match(joinBlock({ ...base, liveBids: 1 }) ?? "", /Bids are in under this listing's own terms/);
  assert.match(joinBlock({ ...base, consent: "  " }) ?? "", /Record how the seller agreed/);

  assert.equal(leaveBlock({ eventStatus: "INDICATIONS", liveBids: 0 }), null);
  assert.match(leaveBlock({ eventStatus: "BEST_AND_FINAL", liveBids: 2 }) ?? "", /stays in the event/);
  assert.match(leaveBlock({ eventStatus: "CLOSED", liveBids: 0 }) ?? "", /over/);
});

// Timestamp-tagged people and listings nothing seeded touches: one live listing per seller, plus buyers.
async function makeWorld(opts: { listings?: number; buyers?: number } = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN") =>
    prisma.user.create({
      data: {
        email: `se-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const desk = await person("desk", "ADMIN");
  const sellers = [];
  const listings = [];
  for (let index = 0; index < (opts.listings ?? 4); index += 1) {
    const seller = await person(`seller${index}`, "INDIVIDUAL_SELLER");
    sellers.push(seller);
    listings.push(
      await prisma.listing.create({
        data: {
          kind: "SINGLE",
          sellerId: seller.id,
          status: "APPROVED",
          approvedAt: new Date(Date.now() - 7 * DAY),
          title: `Event note ${index} ${tag}`,
          notes: {
            create: [{
              streetAddress: `${index} First St`, city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
              lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "NON_PERFORMING", monthsDelinquent: 9,
              askingPrice: 120000, estimatedValue: 260000,
            }] as never,
          },
        },
      }),
    );
  }
  const buyers = [];
  for (let index = 0; index < (opts.buyers ?? 3); index += 1) {
    const buyer = await person(`buyer${index}`, "BUYER");
    await prisma.buyerProfile.create({
      data: { userId: buyer.id, status: "APPROVED", entityType: "LLC", entityName: `Fund ${index} ${tag}`, homesControlled: 4, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY) },
    });
    buyers.push(buyer);
  }
  return { tag, desk, sellers, buyers, listings, users: [desk, ...sellers, ...buyers], eventIds: [] as string[] };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const listingIds = world.listings.map((listing) => listing.id);
  const userIds = world.users.map((user) => user.id);
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  const entities = [...listingIds, ...inquiryIds, ...userIds, ...world.eventIds];
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: entities } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { inquiryId: { in: inquiryIds } }] } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.saleEvent.deleteMany({ where: { id: { in: world.eventIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: world.users.map((user) => user.email) } }, { subject: { contains: literal(world.tag) } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function newEvent(world: World, name: string, indicationsAt: Date, bestFinalAt: Date) {
  const made = await createEvent({ name: `${name} ${world.tag}`, summary: "Small NPL sale.", indicationsAt: inputValue(indicationsAt), bestFinalAt: inputValue(bestFinalAt), actorId: world.desk.id });
  if (made.error !== null) assert.fail(made.error);
  world.eventIds.push(made.event.id);
  return made.event;
}

const listingNow = (id: string) => prisma.listing.findUniqueOrThrow({ where: { id }, include: { seller: true } });
const eventNow = (id: string) => prisma.saleEvent.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) => (await prisma.inquiry.findUniqueOrThrow({ where: { id } })).status;
const inbox = (email: string, subject: string) => prisma.notification.count({ where: { toEmail: email, subject: { contains: literal(subject) } } });

// A bid through the same checks the bid form runs.
async function bid(buyer: World["buyers"][number], listingId: string, amount: number, now = new Date(), goodUntil = "") {
  const listing = await listingNow(listingId);
  const check = await checkOffer({ user: buyer, listing, noteId: "", amount, goodUntil, now });
  if (check.error !== null) return { error: check.error, id: "" };
  const inquiry = await writeInquiry({ user: buyer, listing, type: "OFFER", noteId: "", amount, message: "", expiresAt: check.expiresAt });
  return { error: null, id: inquiry.id };
}

test("a sale event runs both rounds on the listings' own terms, once, and awards wait for best and final", async () => {
  const world = await makeWorld();
  try {
    const [l1, l2, l3, l4] = world.listings;
    const [b0, b1, b2] = world.buyers;
    const indicationsAt = new Date(Math.ceil((Date.now() + 3 * DAY) / 60000) * 60000);
    const bestFinalAt = new Date(indicationsAt.getTime() + 16 * DAY);
    const event = await newEvent(world, "December sale", indicationsAt, bestFinalAt);
    assert.equal(event.status, "PLANNED");
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: event.id, action: "SALE_EVENT_CREATED" } }));
    // Nothing to move yet: no listings, and indications aren't due.
    assert.equal((await advanceSaleEvents(new Date(), { eventIds: [event.id] })).sent, 0);

    // Adding a listing needs the seller's recorded agreement, and sets its terms through the auction fields.
    assert.match((await enterEvent({ eventId: event.id, listingId: l1.id, consent: "", actorId: world.desk.id })).error ?? "", /Record how the seller agreed/);
    assert.equal((await enterEvent({ eventId: event.id, listingId: l1.id, consent: "Seller email of Nov 6", actorId: world.desk.id })).error, null);
    let listing = await listingNow(l1.id);
    assert.equal(listing.saleEventId, event.id);
    assert.equal(listing.bidMode, "SEALED");
    assert.equal(listing.bidDeadline?.getTime(), bestFinalAt.getTime());
    assert.equal((await eventNow(event.id)).status, "INDICATIONS");
    const joined = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: l1.id, action: "SALE_EVENT_JOIN" } });
    assert.match(joined.detail, new RegExp(`${event.id} · .* · Seller agreement: Seller email of Nov 6`));
    assert.equal(await inbox(world.sellers[0].email, `Sale event · ${l1.title}`), 1);
    assert.match((await enterEvent({ eventId: event.id, listingId: l1.id, consent: "Again", actorId: world.desk.id })).error ?? "", /already in this event/);
    assert.equal((await enterEvent({ eventId: event.id, listingId: l2.id, consent: "Call with seller 1, Nov 6", actorId: world.desk.id })).error, null);

    // A listing with a live bid under its own terms is refused; one with terms but no bids has them replaced.
    await prisma.inquiry.create({ data: { listingId: l3.id, buyerId: b0.id, type: "OFFER", status: "OPEN", amount: 90000 } });
    assert.match((await enterEvent({ eventId: event.id, listingId: l3.id, consent: "Email", actorId: world.desk.id })).error ?? "", /Bids are in under this listing's own terms/);
    assert.equal((await listingNow(l3.id)).saleEventId ?? null, null);
    const ownDeadline = new Date(Date.now() + 2 * DAY);
    await prisma.listing.update({ where: { id: l4.id }, data: { bidMode: "BEST_AND_FINAL", bidDeadline: ownDeadline } });
    assert.equal((await enterEvent({ eventId: event.id, listingId: l4.id, consent: "Email of Nov 6", actorId: world.desk.id })).error, null);
    listing = await listingNow(l4.id);
    assert.equal(listing.bidMode, "SEALED");
    assert.equal(listing.bidDeadline?.getTime(), bestFinalAt.getTime());

    // Indications: sealed bids, withdrawable, with a good-until on or after the best-and-final date.
    const early = await bid(b0, l1.id, 100000);
    assert.equal(early.error, null);
    const pulled = await bid(b1, l1.id, 95000);
    assert.equal(pulled.error, null);
    assert.equal((await withdrawBid(pulled.id, b1.id)).error, null);
    assert.match((await bid(b2, l1.id, 99000, new Date(), indicationsAt.toISOString().slice(0, 10))).error ?? "", /decided after the deadline/);
    assert.equal(readGoodUntil(bestFinalAt.toISOString().slice(0, 10), await listingNow(l1.id)).error, null);
    assert.equal((await bid(b2, l2.id, 80000)).error, null);
    // Awards wait for best and final, even on an indication.
    assert.equal((await checkAward(early.id)).error, "Award this after the bid deadline.");
    // A bid that came in after the indications date but before the round switched is already best and final.
    const late = await prisma.inquiry.create({ data: { listingId: l1.id, buyerId: b2.id, type: "OFFER", status: "OPEN", amount: 110000, createdAt: new Date(indicationsAt.getTime() + 30 * 60 * 1000) } });

    // The round change switches the terms and releases the indications.
    const switchAt = new Date(indicationsAt.getTime() + HOUR);
    const first = await advanceSaleEvents(switchAt, { eventIds: [event.id] });
    assert.deepEqual(first, { sent: 1, failed: 0, error: "" });
    assert.equal((await eventNow(event.id)).status, "BEST_AND_FINAL");
    for (const id of [l1.id, l2.id, l4.id]) {
      const switched = await listingNow(id);
      assert.equal(switched.bidMode, "BEST_AND_FINAL");
      assert.equal(switched.bidDeadline?.getTime(), bestFinalAt.getTime());
    }
    assert.equal(await statusOf(early.id), "DECLINED");
    assert.equal(await statusOf(pulled.id), "DECLINED");
    assert.equal(await statusOf(late.id), "OPEN");
    assert.equal(await inbox(b0.email, `Best and final open · ${l1.title}`), 1);
    assert.equal(await inbox(b2.email, `Best and final open · ${l1.title}`), 1);
    assert.equal(await inbox(world.sellers[0].email, `Indications closed · ${l1.title}`), 1);
    const note = await prisma.offerMessage.findFirstOrThrow({ where: { inquiryId: early.id, kind: "NOTE" } });
    assert.match(note.body, /released and is not a bid/);

    // Running it again changes nothing and tells nobody twice.
    assert.deepEqual(await advanceSaleEvents(switchAt, { eventIds: [event.id] }), { sent: 0, failed: 0, error: "" });
    assert.equal((await advanceSaleEvent(await eventNow(event.id), switchAt)).moves, 0);
    assert.equal(await inbox(b0.email, `Best and final open · ${l1.title}`), 1);
    assert.equal(await inbox(world.sellers[0].email, `Indications closed · ${l1.title}`), 1);
    assert.equal(await statusOf(late.id), "OPEN");

    // Best and final: one bid each, open to every buyer who can bid, including one who withdrew an indication.
    const final = await bid(b0, l1.id, 125000, switchAt);
    assert.equal(final.error, null);
    assert.equal((await bid(b0, l1.id, 130000, switchAt)).error, "Best and final allows one bid on this listing.");
    assert.equal((await bid(b1, l1.id, 118000, switchAt)).error, null);
    assert.equal((await bid(b2, l1.id, 140000, switchAt)).error, "Best and final allows one bid on this listing.");
    // The round's own withdrawal rule holds, and a withdrawn best-and-final bid is still the one bid.
    const b1Final = await prisma.inquiry.findFirstOrThrow({ where: { listingId: l1.id, buyerId: b1.id, status: "OPEN" } });
    assert.equal((await withdrawBid(b1Final.id, b1.id, switchAt)).error, null);
    assert.equal((await bid(b1, l1.id, 119000, switchAt)).error, "Best and final allows one bid on this listing.");
    const finalListing = await listingNow(l1.id);
    assert.equal(withdrawBlock({ type: "OFFER", status: "OPEN", bidMode: finalListing.bidMode, bidDeadline: finalListing.bidDeadline, group: false, now: switchAt }), null);
    assert.match(
      withdrawBlock({ type: "OFFER", status: "OPEN", bidMode: finalListing.bidMode, bidDeadline: finalListing.bidDeadline, group: false, now: new Date(bestFinalAt.getTime() + HOUR) }) ?? "",
      /deadline has passed, so this bid binds/,
    );
    // Awards still wait for the best-and-final date, and a released indication is never awardable.
    assert.equal((await checkAward(final.id)).error, "Award this after the bid deadline.");
    assert.match((await checkAward(early.id)).error ?? "", /declined/);

    // Listings with bids stay to the end; one without can leave, and goes back to open offers.
    assert.match((await leaveEvent({ eventId: event.id, listingId: l1.id, actorId: world.desk.id })).error ?? "", /stays in the event/);
    assert.match((await cancelEvent({ eventId: event.id, actorId: world.desk.id })).error ?? "", /runs to its dates/);
    assert.equal((await leaveEvent({ eventId: event.id, listingId: l4.id, actorId: world.desk.id })).error, null);
    listing = await listingNow(l4.id);
    assert.equal(listing.saleEventId ?? null, null);
    assert.equal(listing.bidMode, "NONE");
    assert.equal(listing.bidDeadline ?? null, null);
    assert.match((await editEvent({ eventId: event.id, name: event.name, summary: "", indicationsAt: inputValue(indicationsAt), bestFinalAt: inputValue(new Date(bestFinalAt.getTime() + DAY)), actorId: world.desk.id })).error ?? "", /dates stay as printed/);

    // Best and final closes on its date, once. The terms stay, so the existing award checks open then.
    const closeAt = new Date(bestFinalAt.getTime() + HOUR);
    assert.equal((await advanceSaleEvents(closeAt, { eventIds: [event.id] })).sent, 1);
    assert.equal((await eventNow(event.id)).status, "CLOSED");
    assert.equal((await advanceSaleEvents(closeAt, { eventIds: [event.id] })).sent, 0);
    const closed = await listingNow(l1.id);
    assert.equal(closed.bidMode, "BEST_AND_FINAL");
    assert.equal(closed.bidDeadline?.getTime(), bestFinalAt.getTime());
    // The clock here is real, so the date is moved back to stand for time passing.
    await prisma.listing.update({ where: { id: l1.id }, data: { bidDeadline: new Date(Date.now() - HOUR) } });
    assert.equal((await checkAward(final.id)).error, null);
  } finally {
    await cleanWorld(world);
  }
});

test("dates move only before bids, an empty event is canceled on its date, and a canceled event frees its listings", async () => {
  const world = await makeWorld({ listings: 1, buyers: 0 });
  try {
    const [l1] = world.listings;
    const indicationsAt = new Date(Math.ceil((Date.now() + 5 * DAY) / 60000) * 60000);
    const event = await newEvent(world, "January sale", indicationsAt, new Date(indicationsAt.getTime() + 18 * DAY));
    assert.equal((await enterEvent({ eventId: event.id, listingId: l1.id, consent: "Email of Nov 6", actorId: world.desk.id })).error, null);
    const later = new Date(indicationsAt.getTime() + 2 * DAY);
    const laterFinal = new Date(later.getTime() + 21 * DAY);
    const moved = await editEvent({ eventId: event.id, name: event.name, summary: "Moved.", indicationsAt: inputValue(later), bestFinalAt: inputValue(laterFinal), actorId: world.desk.id });
    assert.equal(moved.error, null);
    assert.equal((await listingNow(l1.id)).bidDeadline?.getTime(), laterFinal.getTime());
    assert.equal(await inbox(world.sellers[0].email, `Sale event dates moved · ${l1.title}`), 1);
    assert.match((await editEvent({ eventId: event.id, name: event.name, summary: "", indicationsAt: inputValue(later), bestFinalAt: inputValue(new Date(later.getTime() + 3 * DAY)), actorId: world.desk.id })).error ?? "", /7 to 30 days/);

    assert.equal((await cancelEvent({ eventId: event.id, actorId: world.desk.id })).error, null);
    assert.equal((await eventNow(event.id)).status, "CANCELED");
    const freed = await listingNow(l1.id);
    assert.equal(freed.saleEventId ?? null, null);
    assert.equal(freed.bidMode, "NONE");
    assert.equal(await inbox(world.sellers[0].email, `Sale event canceled · ${l1.title}`), 1);
    assert.match((await cancelEvent({ eventId: event.id, actorId: world.desk.id })).error ?? "", /already over/);

    const empty = await newEvent(world, "Empty sale", indicationsAt, new Date(indicationsAt.getTime() + 16 * DAY));
    assert.equal((await advanceSaleEvents(new Date(indicationsAt.getTime() - HOUR), { eventIds: [empty.id] })).sent, 0);
    assert.equal((await advanceSaleEvents(new Date(indicationsAt.getTime() + HOUR), { eventIds: [empty.id] })).sent, 1);
    assert.equal((await eventNow(empty.id)).status, "CANCELED");
    assert.match((await enterEvent({ eventId: empty.id, listingId: l1.id, consent: "Email", actorId: world.desk.id })).error ?? "", /no longer taking listings/);
  } finally {
    await cleanWorld(world);
  }
});
