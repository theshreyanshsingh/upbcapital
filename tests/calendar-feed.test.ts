import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarFeed,
  calendarFeedUrl,
  calendarTokenHash,
  endCalendarFeed,
  feedEvents,
  fold,
  icsCalendar,
  icsText,
  issueCalendarFeed,
  userForCalendarToken,
} from "../lib/calendar-feed";
import { buildCalendar } from "../lib/process-letter";
import { prisma } from "../lib/prisma";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const address = (who: string) => `cf-${who}-${tag}@example.org`;
const made = { users: [] as string[], listings: [] as string[], events: [] as string[] };
const APP = "https://upb.example";
const now = new Date();
const later = (days: number) => new Date(now.getTime() + days * DAY);

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER") {
  const user = await prisma.user.create({ data: { email: address(who), name: `Feed ${who} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  made.users.push(user.id);
  return user;
}

async function listing(sellerId: string, input: { title: string; visibility?: string; bidDeadline?: Date; saleEventId?: string }) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(now.getTime() - 2 * HOUR),
      standingBidsNotifiedAt: new Date(),
      title: input.title,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.bidDeadline ? { bidMode: "SEALED" as never, bidDeadline: input.bidDeadline } : {}),
      ...(input.saleEventId ? { saleEventId: input.saleEventId } : {}),
      notes: {
        create: [{
          streetAddress: `77 Secret Rd ${tag}`, city: "Quietville", state: "QZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000, borrowerName: `Borrower Person ${tag}`,
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer", "BUYER");
  const invitee = await person("invitee", "BUYER");
  const rival = await person("rival", "BUYER");
  const event = await prisma.saleEvent.create({
    data: { name: `Winter sale, pools; singles ${tag}`, indicationsAt: later(10), bestFinalAt: later(26), ndaDueAt: later(5), status: "PLANNED" },
  });
  made.events.push(event.id);
  const open = await listing(seller.id, { title: `Ridge pool, TX; 3 notes \\ seasoned ${tag}`, bidDeadline: later(7), saleEventId: event.id });
  const hidden = await listing(seller.id, { title: `Private tape ${tag}`, visibility: "PRIVATE", bidDeadline: later(8) });
  const bidOn = await listing(seller.id, { title: `Bid-on note ${tag}`, bidDeadline: later(9) });
  const closingListing = await listing(seller.id, { title: `Closing note ${tag}` });
  // The buyer saved the open and the private listing, and bid on a third. Only the invitee was asked into the private one.
  await prisma.favorite.createMany({ data: [{ userId: buyer.id, listingId: open.id }, { userId: buyer.id, listingId: hidden.id }, { userId: invitee.id, listingId: hidden.id }] });
  await prisma.listingInvite.create({ data: { listingId: hidden.id, email: invitee.email, userId: invitee.id, token: `inv-${tag}`, invitedById: seller.id } });
  await prisma.inquiry.create({ data: { listingId: bidOn.id, buyerId: buyer.id, type: "OFFER", amount: 123456.78, status: "OPEN" } });
  // A rival's bid on the open listing, which the desk put to the seller.
  await prisma.inquiry.create({
    data: { listingId: open.id, buyerId: rival.id, type: "OFFER", amount: 55555, status: "OPEN", sellerAskedAt: new Date(now.getTime() - HOUR), sellerAskedAmount: 55555, sellerRespondBy: later(1) },
  });
  const won = await prisma.inquiry.create({ data: { listingId: closingListing.id, buyerId: buyer.id, type: "OFFER", amount: 98765, status: "ACCEPTED" } });
  const closing = await prisma.closing.create({
    data: {
      listingId: closingListing.id,
      inquiryId: won.id,
      salePrice: 98765,
      buyerPremiumCents: 98765,
      sellerCommissionCents: 1000,
      buyerTotalCents: 9975265,
      netToSellerCents: 9875500,
      targetCloseAt: later(30),
      depositDueAt: later(3),
      depositCents: 987650,
      diligenceEndsAt: later(12),
    },
  });
  const signers = [
    { role: "BUYER", userId: buyer.id, name: buyer.name, email: buyer.email },
    { role: "SELLER", userId: seller.id, name: seller.name, email: seller.email, signedAt: now.toISOString() },
  ];
  const request = await prisma.signatureRequest.create({ data: { closingId: closing.id, kind: "PSA", status: "PARTIAL", signers, dueAt: later(2) } });
  return { seller, buyer, invitee, rival, event, open, hidden, bidOn, closingListing, closing, request };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  const listingIds = made.listings;
  const closings = await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
  await prisma.signatureRequest.deleteMany({ where: { closingId: { in: closings.map((row) => row.id) } } });
  await prisma.closing.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.favorite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingInvite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.saleEvent.deleteMany({ where: { id: { in: made.events } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: made.users } }, { actorId: { in: made.users } }] } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

function unfolded(ics: string) {
  return ics.replace(/\r\n /g, "");
}

test("text is escaped as RFC 5545 asks, and long lines fold within 75 octets", () => {
  assert.equal(icsText("a\\b;c,d\ne\r\nf\rg"), "a\\\\b\\;c\\,d\\ne\\nfg");
  const long = `SUMMARY:${"é".repeat(60)}`;
  for (const line of fold(long).split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, line);
  assert.equal(fold(long).replace(/\r\n /g, ""), long);
  const ics = icsCalendar({ name: "Name, with; marks", events: [{ uid: "x@upbcapital", start: now, summary: "One, two", description: "Line\nbreak", url: `${APP}/x` }], now });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(ics.includes("X-WR-CALNAME:Name\\, with\\; marks"));
  assert.ok(ics.includes("SUMMARY:One\\, two"));
  assert.ok(ics.includes("DESCRIPTION:Line\\nbreak"));
  // The sale event file shares the same text rules.
  const event = { id: "evt", name: "A, b", status: "PLANNED" as const, indicationsAt: later(1), bestFinalAt: later(9), ndaDueAt: null, qaCutoffAt: null, awardTargetAt: null, closingTargetAt: null, createdAt: now, updatedAt: now };
  assert.ok(buildCalendar(event).includes("X-WR-CALNAME:A\\, b"));
});

test("a buyer's feed carries saved and bid-on deadlines, their sale event, and their closing, with no amounts", async () => {
  const { buyer, open, hidden, bidOn, closing, request, event } = world;
  const events = await feedEvents(buyer, { now, appUrl: APP });
  const uids = events.map((item) => item.uid);
  assert.ok(uids.includes(`listing-${open.id}-bids@upbcapital`));
  assert.ok(uids.includes(`listing-${bidOn.id}-bids@upbcapital`));
  for (const key of ["ndaDueAt", "indicationsAt", "bestFinalAt"]) assert.ok(uids.includes(`${event.id}-${key}@upbcapital`), key);
  for (const key of ["target", "deposit", "diligence"]) assert.ok(uids.includes(`closing-${closing.id}-${key}@upbcapital`), key);
  assert.ok(uids.includes(`signature-${request.id}@upbcapital`));
  // Saved, but private and never invited: nothing of it.
  assert.equal(uids.some((uid) => uid.includes(hidden.id)), false);
  // In date order, each with a link back to its page.
  assert.deepEqual(events.map((item) => item.start.getTime()), [...events].map((item) => item.start.getTime()).sort((a, b) => a - b));
  assert.equal(events.find((item) => item.uid.startsWith(`listing-${open.id}`))?.url, `${APP}/marketplace/${open.id}`);
  assert.equal(events.find((item) => item.uid.startsWith(`closing-${closing.id}-target`))?.url, `${APP}/closings/${closing.id}`);

  const ics = unfolded(await calendarFeed(buyer, { now, appUrl: APP }));
  for (const figure of ["123456", "123,456", "98765", "98,765", "55555", "55,555", "9975265", "987650"]) assert.equal(ics.includes(figure), false, figure);
  assert.equal(ics.includes(`Borrower Person ${tag}`), false);
  assert.equal(ics.includes("Secret Rd"), false);
  assert.equal(ics.includes(`Private tape ${tag}`), false);
  // The title's comma, semicolon and backslash arrive escaped.
  assert.ok(ics.includes(`SUMMARY:Bids due: Ridge pool\\, TX\\; 3 notes \\\\ seasoned ${tag}`));
  assert.ok(ics.includes(`SUMMARY:Indications due: Winter sale\\, pools\\; singles ${tag}`));
  for (const line of (await calendarFeed(buyer, { now, appUrl: APP })).split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, line);
});

test("an invited buyer sees the private listing's deadline", async () => {
  const uids = (await feedEvents(world.invitee, { now, appUrl: APP })).map((item) => item.uid);
  assert.ok(uids.includes(`listing-${world.hidden.id}-bids@upbcapital`));
});

test("a seller's feed carries their listings' deadlines and the answers they owe, never the bid or the bidder", async () => {
  const { seller, open, hidden, closing, request } = world;
  const events = await feedEvents(seller, { now, appUrl: APP });
  const uids = events.map((item) => item.uid);
  assert.ok(uids.includes(`listing-${open.id}-bids@upbcapital`));
  assert.ok(uids.includes(`listing-${hidden.id}-bids@upbcapital`), "a seller sees their own private listing");
  const answer = events.find((item) => item.uid.endsWith("-answer@upbcapital"));
  assert.ok(answer);
  assert.equal(answer.url, `${APP}/seller/listings/${open.id}`);
  assert.ok(uids.includes(`closing-${closing.id}-target@upbcapital`), "the seller is a party to the closing");
  // The seller already signed, so the papers aren't on their calendar.
  assert.equal(uids.includes(`signature-${request.id}@upbcapital`), false);
  const ics = unfolded(await calendarFeed(seller, { now, appUrl: APP }));
  for (const figure of ["55555", "55,555", "123456", "98765"]) assert.equal(ics.includes(figure), false, figure);
  assert.equal(ics.includes(world.rival.name), false);
  assert.equal(ics.includes(`Borrower Person ${tag}`), false);
});

test("a bidder sees the deadline it bid against without its own figure, and an idle account gets an empty calendar", async () => {
  const ics = unfolded(await calendarFeed(world.rival, { now, appUrl: APP }));
  assert.ok(ics.includes(`UID:listing-${world.open.id}-bids@upbcapital`));
  assert.equal(ics.includes("55555") || ics.includes("55,555"), false);
  const idle = await person("idle", "BUYER");
  const empty = await calendarFeed(idle, { now, appUrl: APP });
  assert.ok(empty.startsWith("BEGIN:VCALENDAR\r\n") && empty.endsWith("END:VCALENDAR\r\n"));
  assert.ok(empty.includes("X-WR-CALNAME:UPB Capital deadlines"));
  assert.equal(empty.includes("BEGIN:VEVENT"), false);
});

test("the link is shown once and kept as a hash; a new link kills the old one, and turning off kills both", async () => {
  const { buyer } = world;
  assert.equal(await userForCalendarToken("f".repeat(64)), null);
  assert.equal(await userForCalendarToken("not a token"), null);
  assert.equal(await userForCalendarToken(""), null);

  const first = await issueCalendarFeed(buyer.id);
  assert.match(first, /^[0-9a-f]{64}$/);
  const stored = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id }, select: { calendarTokenHash: true } });
  assert.equal(stored.calendarTokenHash, calendarTokenHash(first));
  assert.notEqual(stored.calendarTokenHash, first);
  assert.equal((await userForCalendarToken(first))?.id, buyer.id);
  assert.equal((await userForCalendarToken(`${first}.ics`))?.id, buyer.id);
  assert.equal(calendarFeedUrl(first, `${APP}/`), `${APP}/api/calendar/${first}.ics`);

  const second = await issueCalendarFeed(buyer.id);
  assert.notEqual(second, first);
  assert.equal(await userForCalendarToken(first), null);
  assert.equal((await userForCalendarToken(second))?.id, buyer.id);

  await endCalendarFeed(buyer.id);
  assert.equal(await userForCalendarToken(second), null);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id }, select: { calendarTokenHash: true } })).calendarTokenHash, null);
  assert.equal(await prisma.auditEvent.count({ where: { entityId: buyer.id, action: { in: ["CALENDAR_FEED_ON", "CALENDAR_FEED_ROTATED", "CALENDAR_FEED_OFF"] } } }), 3);

  // A suspended account's link stops answering.
  const third = await issueCalendarFeed(buyer.id);
  await prisma.user.update({ where: { id: buyer.id }, data: { accountStatus: "SUSPENDED" } });
  assert.equal(await userForCalendarToken(third), null);
  await prisma.user.update({ where: { id: buyer.id }, data: { accountStatus: "APPROVED", calendarTokenHash: null } });
});

test("a firm's seat has its own link, which reads the firm's dates and dies when the seat is removed", async () => {
  const { buyer, open } = world;
  const seat = await prisma.user.create({
    data: { email: address("seat"), name: `Feed seat ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x", principalId: buyer.id, seatRole: "VIEW", seatAddedAt: now },
  });
  made.users.push(seat.id);
  const token = await issueCalendarFeed(seat.id);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id }, select: { calendarTokenHash: true } })).calendarTokenHash, null);
  const reader = await userForCalendarToken(token);
  assert.equal(reader?.id, buyer.id);
  assert.equal(reader?.actor?.id, seat.id);
  assert.ok(reader && (await feedEvents(reader, { now, appUrl: APP })).some((item) => item.uid === `listing-${open.id}-bids@upbcapital`));
  await prisma.user.update({ where: { id: seat.id }, data: { principalId: null } });
  assert.equal(await userForCalendarToken(token), null);
});
