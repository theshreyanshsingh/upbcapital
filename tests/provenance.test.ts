import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { confirmDeskTape } from "../lib/desk-intake";
import { checkOffer } from "../lib/inquiry";
import { API_STATEMENT, ingestTape } from "../lib/ingest";
import { prisma } from "../lib/prisma";
import { audienceOf, canSee, canSeeListing, listingAccess, listingScope, publicListing } from "../lib/private-listings";
import {
  PAUSE_AFTER_DAYS,
  PAUSED_BIDS,
  REMIND_AFTER_DAYS,
  giveStatement,
  ownerPage,
  pausedBidBlock,
  provenanceHold,
  reconfirmAvailable,
  runFreshness,
  statementHoldText,
} from "../lib/provenance";
import {
  PROVENANCE_VERSION,
  STATEMENT_CHANGED_TEXT,
  STATEMENT_MISSING_TEXT,
  availabilityLine,
  availableSince,
  remindedSince,
  statementProblem,
  statementText,
} from "../lib/provenance-rules";
import { MANDATE_MISSING, mandateHold, sellerIdentityHold } from "../lib/seller-identity";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const email = (who: string) => `a-provenance-${who}-${tag}@example.org`;
const made = { users: [] as string[], listings: [] as string[], emails: [] as string[] };

type Role = "BUYER" | "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BROKER" | "ADMIN";

async function person(who: string, role: Role) {
  const user = await prisma.user.create({
    data: {
      email: email(who),
      name: `Provenance ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      emailConfirmedAt: new Date(),
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
    },
  });
  made.users.push(user.id);
  made.emails.push(user.email);
  return user;
}

async function listing(sellerId: string, input: { title: string; status?: "SUBMITTED" | "APPROVED"; approvedAt?: Date | null; brokerId?: string; data?: Record<string, unknown> }) {
  const status = input.status ?? "APPROVED";
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status,
      approvedAt: input.approvedAt === undefined ? (status === "APPROVED" ? new Date(Date.now() - 2 * DAY) : null) : input.approvedAt,
      // Already claimed, so scoring this fixture never sends the desk a standing-bid notice.
      standingBidsNotifiedAt: new Date(),
      title: `${input.title} ${tag}`,
      ...(input.brokerId ? { brokerId: input.brokerId, brokerRole: "SELLER_BROKER" as const, clientSellerName: `Holder ${tag}` } : {}),
      ...(input.data ?? {}),
      notes: {
        create: [{
          streetAddress: "9 Proof Ln", city: "Provenance", state: "QP", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 180000, interestRate: 7, monthlyPi: 1300, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 110000, estimatedValue: 240000,
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

const read = (id: string) => prisma.listing.findUniqueOrThrow({ where: { id }, include: { seller: true } });
// Matched in full here: Prisma's `contains` on MongoDB is a regex, and "Still for sale?" isn't one.
const mail = async (to: string, subject: string) =>
  (await prisma.notification.findMany({ where: { toEmail: to, subject: { contains: tag } }, select: { subject: true, body: true } })).filter((row) => row.subject === subject);

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  return {
    seller: await person("seller", "INSTITUTIONAL_SELLER"),
    broker: await person("broker", "BROKER"),
    buyer: await person("buyer", "BUYER"),
    desk: await person("desk", "ADMIN"),
  };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  const listingIds = [...made.listings, ...(await prisma.listing.findMany({ where: { sellerId: { in: made.users } }, select: { id: true } })).map((row) => row.id)];
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.deskThread.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.reviewComment.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.document.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.ofacCheck.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { userId: { in: made.users } }] } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...made.users] } }, { actorId: { in: made.users } }] } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.emails } }, { subject: { contains: tag } }] } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The statement at submission

test("a filing without the ownership statement, or with an older wording, is refused on every path", async () => {
  assert.equal(statementProblem(null), STATEMENT_MISSING_TEXT);
  assert.equal(statementProblem(""), STATEMENT_MISSING_TEXT);
  assert.equal(statementProblem("on"), STATEMENT_CHANGED_TEXT, "a box from a page that showed other words is asked again");
  assert.equal(statementProblem(PROVENANCE_VERSION), null);
  assert.match(statementText("SELLER") ?? "", /own these loans.*not pledged, sold, under contract or listed anywhere else.*withdraw this listing/);
  assert.match(statementText("BROKER") ?? "", /signed mandate.*holder's written statement/);
  assert.equal(statementText("SELLER", "1999-01"), null);

  // The API has no checkbox: a tape without the version is refused before anything is written.
  const before = await prisma.listing.count({ where: { sellerId: world.seller.id } });
  assert.deepEqual(await ingestTape({ sellerId: world.seller.id, title: `API pool ${tag}`, csv: "City,State\nTampa,FL" }), { error: API_STATEMENT });
  assert.deepEqual(await ingestTape({ sellerId: world.seller.id, title: `API pool ${tag}`, csv: "City,State\nTampa,FL", ownership: "1999-01" }), { error: API_STATEMENT });
  assert.equal(await prisma.listing.count({ where: { sellerId: world.seller.id } }), before);

  // Each form path checks the box before it writes the listing (the actions need a session, so this reads them).
  const source = async (file: string, fn: string) => {
    const text = await fs.readFile(path.join(process.cwd(), file), "utf8");
    const start = text.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, `${file} ${fn}`);
    const end = text.indexOf("\nexport async function ", start + 10);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const paths: [string, string, string][] = [
    ["actions/listings.ts", "createNoteListing", "prisma.listing.create("],
    ["actions/listings.ts", "updateOwnNote", "prisma.listing.update("],
    ["actions/listings.ts", "updateOwnListingMeta", "prisma.listing.update("],
    ["actions/listings.ts", "createPoolListing", "prisma.listing.create("],
    ["actions/broker.ts", "submitBrokerDeal", 'storeFile(formData.get("authorization")'],
    ["actions/assets.ts", "relistBuyerNote", "relistFrom("],
  ];
  for (const [file, fn, write] of paths) {
    const body = await source(file, fn);
    const check = body.indexOf('statementProblem(formData.get("ownership"))');
    assert.ok(check > 0, `${fn} checks the statement`);
    assert.ok(check < body.indexOf(write), `${fn} checks before it writes`);
  }
});

test("the statement is stored with who gave it, when, and the wording's version", async () => {
  const { seller, broker, desk } = world;
  const csv = ["City,State,Property type,Lien position,UPB,Interest rate,Payment status,Estimated value,Asking price", "Tampa,FL,SFR,First,150000,6.5,Performing,220000,90000"].join("\n");
  const pushed = await ingestTape({ sellerId: seller.id, title: `API pool ${tag}`, csv, ownership: PROVENANCE_VERSION });
  const pushedId = "listingId" in pushed ? pushed.listingId : null;
  assert.ok(pushedId, JSON.stringify(pushed));
  made.listings.push(pushedId);
  const api = await read(pushedId);
  assert.equal(api.ownershipAttestation, PROVENANCE_VERSION);
  assert.equal(api.ownershipAttestedById, seller.id);
  assert.ok(api.ownershipAttestedAt);

  // A copy filed without one: the seller gives it on the listing's page, and nobody else can.
  const copy = await listing(seller.id, { title: "Copy", status: "SUBMITTED" });
  assert.deepEqual(await giveStatement(broker, { listingId: copy.id, statement: PROVENANCE_VERSION }), { ok: false, error: "That listing isn't yours." });
  assert.deepEqual(await giveStatement(seller, { listingId: copy.id, statement: null }), { ok: false, error: STATEMENT_MISSING_TEXT });
  const at = new Date(Date.now() - 60_000);
  assert.deepEqual(await giveStatement(seller, { listingId: copy.id, statement: PROVENANCE_VERSION, now: at }), { ok: true, value: { title: copy.title } });
  const given = await read(copy.id);
  assert.equal(given.ownershipAttestation, PROVENANCE_VERSION);
  assert.equal(given.ownershipAttestedById, seller.id);
  assert.equal(given.ownershipAttestedAt?.getTime(), at.getTime());
  assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: copy.id, action: "OWNERSHIP_STATEMENT" } }));
  assert.equal((await mail(desk.email, `Ownership statement · ${copy.title}`)).length, 1);

  // A desk-filed tape: the seller's confirmation is the statement, and an older wording is refused.
  const filed = await listing(seller.id, { title: "Desk filed", status: "SUBMITTED", data: { filedByDeskId: desk.id } });
  assert.deepEqual(await confirmDeskTape(seller, filed.id, new Date(), "1999-01"), { ok: false, error: STATEMENT_CHANGED_TEXT });
  assert.equal((await read(filed.id)).sellerConfirmedAt, null);
  assert.equal((await confirmDeskTape(seller, filed.id, new Date(), PROVENANCE_VERSION)).ok, true);
  const confirmed = await read(filed.id);
  assert.ok(confirmed.sellerConfirmedAt);
  assert.equal(confirmed.ownershipAttestation, PROVENANCE_VERSION);
  assert.equal(confirmed.ownershipAttestedById, seller.id);
});

// ---------------------------------------------------------------------------------------------------------------
// The approval gate and the mandate

test("a new listing can't be approved without the statement; one approved before it was asked isn't held", async () => {
  const { seller, broker } = world;
  const fresh = await read((await listing(seller.id, { title: "No statement", status: "SUBMITTED" })).id);
  assert.equal(provenanceHold(fresh), statementHoldText(fresh));
  assert.match(provenanceHold(fresh) ?? "", /Approval waits on the seller's ownership statement/);
  assert.match(provenanceHold({ ...fresh, brokerId: broker.id }) ?? "", /broker's ownership statement/);
  assert.equal(provenanceHold({ ...fresh, ownershipAttestedAt: new Date() }), null);
  // Filed and approved before the statement was asked, then sent back: it gives it at the next edit, not here.
  assert.equal(provenanceHold({ ...fresh, approvedAt: new Date(Date.now() - 90 * DAY) }), null);
  // The desk's own paper isn't asked.
  assert.equal(provenanceHold({ ...fresh, seller: { role: "ADMIN" } }), null);

  // The gate sits with the other holds in the desk's approval, before the listing moves to approved.
  const source = await fs.readFile(path.join(process.cwd(), "actions/admin.ts"), "utf8");
  const approve = source.slice(source.indexOf('if (action === "APPROVE")'), source.indexOf('if (action === "REJECT")'));
  const at = (needle: string) => approve.indexOf(needle);
  assert.ok(at("deskIntakeHold(") > 0 && at("deskIntakeHold(") < at("provenanceHold(listing)"));
  assert.ok(at("provenanceHold(listing)") < at("diligenceHold(") && at("provenanceHold(listing)") < at('status: "APPROVED"'));
});

test("a broker's listing waits on the holder's mandate with the seller identity gate off", async () => {
  const { broker } = world;
  const filed = await listing(broker.id, { title: "Broker no mandate", status: "SUBMITTED", brokerId: broker.id });
  const row = await read(filed.id);
  const off = { requireSellerIdentity: false };
  assert.equal(await mandateHold(row), MANDATE_MISSING);
  assert.equal(await sellerIdentityHold(row, off, {}), MANDATE_MISSING);
  assert.equal(await sellerIdentityHold(row, {}, {}), MANDATE_MISSING, "the demo default doesn't lift it either");
  // The identity gate itself stays off: with the mandate on file and no seller file, nothing else holds it.
  await prisma.document.create({ data: { listingId: filed.id, type: "MANDATE", originalName: "mandate.pdf", storedName: `provenance-mandate-${tag}.pdf`, mime: "application/pdf", size: 10 } });
  assert.equal(await mandateHold(row), null);
  assert.equal(await sellerIdentityHold(row, off, {}), null);
  // A listing the seller filed for themselves has no mandate to ask for.
  assert.equal(await mandateHold({ id: filed.id, brokerId: null }), null);

  // The filing itself needs the mandate upload, and reads no setting to decide it.
  const text = await fs.readFile(path.join(process.cwd(), "actions/broker.ts"), "utf8");
  const filing = text.slice(text.indexOf("export async function submitBrokerDeal("), text.indexOf("async function createBrokerListing("));
  assert.match(filing, /storeFile\(formData\.get\("authorization"\), "seller authorization"\)/);
  assert.doesNotMatch(filing, /sellerIdentityRequired|requireSellerIdentity/);
});

// ---------------------------------------------------------------------------------------------------------------
// Freshness

test("the job reminds once after 30 days and pauses 7 days after the reminder, telling the seller and the desk", async () => {
  const { seller, desk } = world;
  const now = new Date();
  const stale = await listing(seller.id, { title: "Stale", approvedAt: new Date(now.getTime() - (REMIND_AFTER_DAYS + 1) * DAY), data: { ownershipAttestedAt: new Date(now.getTime() - 40 * DAY) } });
  const recent = await listing(seller.id, { title: "Recent", approvedAt: new Date(now.getTime() - 10 * DAY) });
  const scope = { listingIds: [stale.id, recent.id] };
  assert.equal(availabilityLine(await read(stale.id))?.text.startsWith("Confirmed available"), true);

  assert.equal((await runFreshness(now, scope)).sent, 1);
  let row = await read(stale.id);
  assert.equal(row.availabilityRemindedAt?.getTime(), now.getTime());
  assert.equal(row.stalePausedAt, null);
  assert.equal((await read(recent.id)).availabilityRemindedAt, null);
  const reminders = await mail(seller.email, `Still for sale? · ${stale.title}`);
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].body, new RegExp(`${ownerPage(row)}#availability`));

  // One reminder per stretch: later runs before the pause send nothing.
  assert.equal((await runFreshness(new Date(now.getTime() + DAY), scope)).sent, 0);
  assert.equal((await runFreshness(new Date(now.getTime() + (PAUSE_AFTER_DAYS - 1) * DAY), scope)).sent, 0);
  assert.equal((await mail(seller.email, `Still for sale? · ${stale.title}`)).length, 1);
  assert.equal((await read(stale.id)).stalePausedAt, null);

  const pauseAt = new Date(now.getTime() + PAUSE_AFTER_DAYS * DAY);
  assert.equal((await runFreshness(pauseAt, scope)).sent, 1);
  row = await read(stale.id);
  assert.equal(row.status, "APPROVED", "a pause keeps the listing approved");
  assert.equal(row.stalePausedAt?.getTime(), pauseAt.getTime());
  assert.equal((await mail(seller.email, `Paused · ${stale.title}`)).length, 1);
  assert.equal((await mail(desk.email, `Paused, not reconfirmed · ${stale.title}`)).length, 1);
  assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: stale.id, action: "STALE_PAUSED" } }));
  assert.equal(availabilityLine(row)?.paused, true);
  // An overlapping run finds it taken.
  assert.equal((await runFreshness(pauseAt, scope)).sent, 0);
});

test("no listing pauses without a reminder of its own stretch, and one with a bid accepted is left alone", async () => {
  const { seller, buyer } = world;
  const now = new Date();
  // Approved long ago and never asked, as every old listing is on the day this ships: it is asked, not paused.
  const old = await listing(seller.id, { title: "Old", approvedAt: new Date(now.getTime() - 200 * DAY) });
  // Asked once, then the seller confirmed: the old reminder no longer counts.
  const answered = await listing(seller.id, {
    title: "Answered",
    approvedAt: new Date(now.getTime() - 100 * DAY),
    data: { availabilityRemindedAt: new Date(now.getTime() - 20 * DAY), availableConfirmedAt: new Date(now.getTime() - 15 * DAY) },
  });
  // A bid accepted on it: the deal is in hand, so nobody is asked.
  const taken = await listing(seller.id, { title: "Taken", approvedAt: new Date(now.getTime() - 60 * DAY) });
  await prisma.inquiry.create({ data: { listingId: taken.id, buyerId: buyer.id, type: "OFFER", amount: 100000, status: "ACCEPTED" } });
  // The desk's own paper isn't asked.
  const deskPaper = await listing(world.desk.id, { title: "Desk paper", approvedAt: new Date(now.getTime() - 60 * DAY) });
  const scope = { listingIds: [old.id, answered.id, taken.id, deskPaper.id] };

  const answeredRow = await read(answered.id);
  assert.equal(remindedSince(answeredRow), null);
  assert.equal(availableSince(answeredRow)?.getTime(), answeredRow.availableConfirmedAt?.getTime());

  assert.equal((await runFreshness(now, scope)).sent, 1);
  for (const id of [old.id, answered.id, taken.id, deskPaper.id]) assert.equal((await read(id)).stalePausedAt, null, id);
  assert.ok((await read(old.id)).availabilityRemindedAt);
  assert.equal((await read(answered.id)).availabilityRemindedAt?.getTime(), answeredRow.availabilityRemindedAt?.getTime());
  assert.equal((await read(taken.id)).availabilityRemindedAt, null);
  assert.equal((await read(deskPaper.id)).availabilityRemindedAt, null);
  // Six days after its first reminder, the old listing is still on the book.
  assert.equal((await runFreshness(new Date(now.getTime() + 6 * DAY), scope)).sent, 0);
  assert.equal((await read(old.id)).stalePausedAt, null);
});

test("reconfirming clears the reminder and the pause, is audited, and takes a missing statement", async () => {
  const { seller, broker, desk, buyer } = world;
  const now = new Date();
  // Filed before the statement was asked, reminded, and paused.
  const paused = await listing(seller.id, {
    title: "Paused legacy",
    approvedAt: new Date(now.getTime() - 50 * DAY),
    data: { availabilityRemindedAt: new Date(now.getTime() - 9 * DAY), stalePausedAt: new Date(now.getTime() - 2 * DAY) },
  });
  assert.deepEqual(await reconfirmAvailable(buyer, { listingId: paused.id }), { ok: false, error: "That listing isn't yours." });
  assert.deepEqual(await reconfirmAvailable(seller, { listingId: paused.id }), { ok: false, error: STATEMENT_MISSING_TEXT });
  assert.ok((await read(paused.id)).stalePausedAt, "a refused confirmation changes nothing");
  assert.deepEqual(await reconfirmAvailable(seller, { listingId: paused.id, statement: PROVENANCE_VERSION, now }), { ok: true, value: { title: paused.title, unpaused: true } });
  const row = await read(paused.id);
  assert.equal(row.availableConfirmedAt?.getTime(), now.getTime());
  assert.equal(row.availabilityRemindedAt, null);
  assert.equal(row.stalePausedAt, null);
  assert.equal(row.ownershipAttestation, PROVENANCE_VERSION);
  assert.equal(row.ownershipAttestedById, seller.id);
  assert.match((await prisma.auditEvent.findFirst({ where: { entityId: paused.id, action: "AVAILABLE_CONFIRMED" } }))?.detail ?? "", /back on the book/);
  assert.equal((await mail(desk.email, `Back on the book · ${paused.title}`)).length, 1);
  assert.equal(availabilityLine(row)?.text, availabilityLine({ status: "APPROVED", availableConfirmedAt: now })?.text);

  // The broker confirms their own; the desk confirms for a seller only with a note saying how it heard.
  const brokered = await listing(broker.id, { title: "Brokered", brokerId: broker.id, data: { ownershipAttestedAt: new Date(), stalePausedAt: new Date() } });
  assert.equal((await reconfirmAvailable(broker, { listingId: brokered.id })).ok, true);
  assert.equal((await read(brokered.id)).stalePausedAt, null);
  const quiet = await listing(seller.id, { title: "Quiet", data: { stalePausedAt: new Date() } });
  assert.deepEqual(await reconfirmAvailable(desk, { listingId: quiet.id }), { ok: false, error: "Say how the seller confirmed it, such as their email or call and its date." });
  assert.equal((await reconfirmAvailable(desk, { listingId: quiet.id, note: "Seller emailed Nov 14" })).ok, true);
  const deskRow = await read(quiet.id);
  assert.equal(deskRow.stalePausedAt, null);
  assert.equal(deskRow.ownershipAttestedAt, null, "the desk can't give the seller's statement");
  assert.match((await prisma.auditEvent.findFirst({ where: { entityId: quiet.id, action: "AVAILABLE_CONFIRMED" } }))?.detail ?? "", /The desk confirmed for the seller: Seller emailed Nov 14/);

  // Only a live listing is confirmed available.
  const review = await listing(seller.id, { title: "In review", status: "SUBMITTED" });
  assert.deepEqual(await reconfirmAvailable(seller, { listingId: review.id }), { ok: false, error: "Only a live listing is confirmed available." });
});

test("a paused listing takes no new bid and is off the book, its matches and its alerts, but not its seller's", async () => {
  const { seller, buyer, desk } = world;
  const live = await listing(seller.id, { title: "Live", approvedAt: new Date(Date.now() - 40 * DAY), data: { ownershipAttestedAt: new Date() } });
  const pausedRow = await listing(seller.id, { title: "Paused", approvedAt: new Date(Date.now() - 40 * DAY), data: { ownershipAttestedAt: new Date(), stalePausedAt: new Date() } });
  const ids = [live.id, pausedRow.id];

  // A new bid is refused with the reason. One already in stays as it was.
  const open = await prisma.inquiry.create({ data: { listingId: pausedRow.id, buyerId: buyer.id, type: "OFFER", amount: 95000, status: "OPEN" } });
  const bid = await checkOffer({ user: buyer, listing: await read(pausedRow.id), noteId: "", amount: 100000, goodUntil: "" });
  assert.equal(bid.error, PAUSED_BIDS);
  assert.equal(await pausedBidBlock({ id: pausedRow.id }), PAUSED_BIDS, "the pause is read when the caller left it out");
  assert.equal(await pausedBidBlock({ id: live.id }), null);
  assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: open.id } })).status, "OPEN");

  // The marketplace's own query: off for buyers, on for its seller and the desk.
  const book = async (user: { id: string; role: string }) =>
    (await prisma.listing.findMany({ where: { id: { in: ids }, status: { in: ["APPROVED", "PENDING", "SOLD"] }, AND: [await listingScope(user)] }, select: { id: true } })).map((row) => row.id).sort();
  assert.deepEqual(await book(buyer), [live.id]);
  assert.deepEqual(await book({ id: "", role: "BUYER" }), [live.id], "nor on the public book");
  assert.deepEqual(await book(seller), [...ids].sort());
  assert.deepEqual(await book(desk), [...ids].sort());
  assert.deepEqual((await prisma.listing.findMany({ where: { id: { in: ids }, AND: [publicListing()] }, select: { id: true } })).map((row) => row.id), [live.id]);

  // Matches, alerts and watchers ask the same rules.
  const access = await listingAccess(buyer);
  assert.equal(canSee(access, await read(live.id)), true);
  assert.equal(canSee(access, await read(pausedRow.id)), false);
  assert.equal(canSee(await listingAccess(seller), await read(pausedRow.id)), true);
  assert.deepEqual((await audienceOf({ id: pausedRow.id, sellerId: seller.id }, [buyer, desk])).map((user) => user.id), [desk.id]);
  assert.deepEqual((await audienceOf(await read(live.id), [buyer])).map((user) => user.id), [buyer.id]);
  // Its own link still opens for a buyer, with the pause on it, so a bidder can follow a bid already in.
  assert.equal(await canSeeListing(buyer, await read(pausedRow.id)), true);

  // Reconfirmed, it is back.
  assert.equal((await reconfirmAvailable(seller, { listingId: pausedRow.id })).ok, true);
  assert.deepEqual(await book(buyer), [...ids].sort());
  assert.equal(await pausedBidBlock({ id: pausedRow.id }), null);
});
