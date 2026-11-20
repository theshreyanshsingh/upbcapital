import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_METRICS, boardCsv, boardPack, metricValue } from "../lib/board-pack";
import { COVENANT_SELECT, listingCovenants, recordCovenantAck } from "../lib/covenants";
import { clearDuplicates, duplicateHold, flagDuplicates } from "../lib/duplicates";
import { prisma } from "../lib/prisma";
import { filterRisk, isMine, ownerLabel, riskAge, riskCounts, riskQueue, riskView, sortRisk, type RawRiskItem, type RiskItem } from "../lib/risk-queue";
import { formatService, loadServiceEvents, NOT_ENOUGH_DATA, percentile, serviceFigure, serviceFigures } from "../lib/service-metrics";

// Mail goes to the log and screens to the short local list, whatever the shared .env says.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY", "UPB_RELEASE"]) {
  process.env[key] = "";
}

// The queue reads the whole shared test database, so every assertion is about this file's own rows, found by id. The
// service-metric fixtures live in 1993, far from anything another test writes, so their figures are this file's alone.
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);
const at = (iso: string) => new Date(`${iso}Z`);
// Percentiles are interpolated, so a figure is compared to six places.
const round = (value: number | null) => (value == null ? null : Number(value.toFixed(6)));
const rounded = (figure: { count: number; median: number | null; p90: number | null }) => ({ count: figure.count, median: round(figure.median), p90: round(figure.p90) });

const created = {
  users: [] as string[],
  listings: [] as string[],
  closings: [] as string[],
  inquiries: [] as string[],
  ofac: [] as string[],
  payouts: [] as string[],
  wires: [] as string[],
  fees: [] as string[],
  claims: [] as string[],
  deletions: [] as string[],
  questions: [] as string[],
  audits: [] as string[],
};

test.after(async () => {
  try {
    const entities = [...created.listings, ...created.closings, ...created.inquiries, ...created.claims];
    await prisma.auditEvent.deleteMany({ where: { OR: [{ id: { in: created.audits } }, { entityId: { in: entities } }, { actorId: { in: created.users } }] } });
    await prisma.notification.deleteMany({ where: { subject: { contains: suffix } } });
    await prisma.repurchaseClaim.deleteMany({ where: { id: { in: created.claims } } });
    await prisma.brokerFee.deleteMany({ where: { id: { in: created.fees } } });
    await prisma.wireChange.deleteMany({ where: { id: { in: created.wires } } });
    await prisma.closingStep.deleteMany({ where: { closingId: { in: created.closings } } });
    await prisma.closing.deleteMany({ where: { id: { in: created.closings } } });
    await prisma.listingQuestion.deleteMany({ where: { id: { in: created.questions } } });
    await prisma.inquiry.deleteMany({ where: { id: { in: created.inquiries } } });
    await prisma.reviewComment.deleteMany({ where: { listingId: { in: created.listings } } });
    const notes = await prisma.note.findMany({ where: { listingId: { in: created.listings } }, select: { id: true } });
    await prisma.collateralItem.deleteMany({ where: { noteId: { in: notes.map((note) => note.id) } } });
    await prisma.note.deleteMany({ where: { listingId: { in: created.listings } } });
    await prisma.listing.deleteMany({ where: { id: { in: created.listings } } });
    await prisma.payoutAccount.deleteMany({ where: { id: { in: created.payouts } } });
    await prisma.ofacCheck.deleteMany({ where: { OR: [{ id: { in: created.ofac } }, { userId: { in: created.users } }] } });
    await prisma.deletionRequest.deleteMany({ where: { id: { in: created.deletions } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } finally {
    await prisma.$disconnect();
  }
});

async function user(name: string, role: "BUYER" | "INDIVIDUAL_SELLER" | "BROKER" | "ADMIN", extra: Record<string, unknown> = {}) {
  const row = await prisma.user.create({ data: { email: `risk-${name}-${suffix}@example.test`, name: `Risk ${name} ${suffix}`, role, accountStatus: "APPROVED", passwordHash: "x", ...(extra as object) } });
  created.users.push(row.id);
  return row;
}

let street = 0;
function note(extra: Record<string, unknown> = {}) {
  street += 1;
  return {
    streetAddress: `${street} Riskqueue ${suffix} Rd`,
    city: "Riskton",
    state: "FL",
    zip: "33101",
    propertyType: "SFR" as const,
    estimatedValue: 150000,
    lienPosition: "FIRST" as const,
    upb: 100000,
    interestRate: 6,
    monthlyPi: 600,
    paymentStatus: "NON_PERFORMING" as const,
    askingPrice: 70000,
    ...(extra as object),
  };
}

async function listing(title: string, sellerId: string, data: Record<string, unknown>, notes = [note()]) {
  const row = await prisma.listing.create({
    data: { title: `risk ${title} ${suffix}`, kind: "SINGLE", sellerId, ...(data as object), notes: { create: notes } },
    include: { notes: true },
  });
  created.listings.push(row.id);
  return row;
}

async function closing(listingId: string, data: Record<string, unknown>) {
  const row = await prisma.closing.create({ data: { listingId, salePrice: 70000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 0, netToSellerCents: 0, ...(data as object) } });
  created.closings.push(row.id);
  return row;
}

async function event(action: string, entityType: string, entityId: string, createdAt: Date, actorId: string | null = null) {
  const row = await prisma.auditEvent.create({ data: { action, entityType, entityId, createdAt, actorId, detail: "risk test" } });
  created.audits.push(row.id);
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// The queue's rules, on items built by hand.

const raw = (id: string, kind: RiskItem["kind"], openedAt: Date | null, extra: Partial<RawRiskItem> = {}): RawRiskItem => ({
  id,
  kind,
  title: id,
  detail: "",
  href: "/admin",
  openedAt,
  resolver: "sales",
  next: "",
  amountCents: null,
  ...extra,
});

test("the queue sorts sanctions and money first, then the oldest, with undated items last in their tier", () => {
  const sorted = sortRisk([
    raw("paused-old", "PAUSED", ago(100 * DAY)),
    raw("duplicate-new", "DUPLICATE", ago(1 * DAY)),
    raw("custody-undated", "CUSTODY", null),
    raw("wire", "WIRE_CHANGE", ago(2 * HOUR)),
    raw("duplicate-old", "DUPLICATE", ago(10 * DAY)),
    raw("sanctions-new", "SANCTIONS", ago(HOUR)),
    raw("hold", "PAYOUT_HOLD", ago(3 * DAY)),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["hold", "sanctions-new", "wire", "duplicate-old", "duplicate-new", "custody-undated", "paused-old"]);
});

test("mine is what a desk member owns by name, or what no one owns that their role resolves", () => {
  const owners = new Map([["owner-1", "Olive Owner"]]);
  const items = riskView(
    [
      raw("owned", "DUPLICATE", ago(DAY), { ownerId: "owner-1" }),
      raw("unowned-sanctions", "SANCTIONS", ago(DAY), { resolver: "compliance" }),
      raw("owned-sanctions", "SANCTIONS", ago(DAY), { resolver: "compliance", ownerId: "owner-1" }),
      // An owner who has left the desk names no one, so the role that resolves it owns it.
      raw("departed", "OWNERSHIP", ago(DAY), { ownerId: "gone-1" }),
    ],
    { role: "ADMIN", deskRole: "SALES" },
    owners,
    now,
  );
  const owner = { id: "owner-1", role: "ADMIN", deskRole: "SALES" };
  const compliance = { id: "compliance-1", role: "ADMIN", deskRole: "COMPLIANCE" };
  assert.deepEqual(filterRisk(items, owner, { mine: true }).map((item) => item.id).sort(), ["departed", "owned", "owned-sanctions"]);
  assert.deepEqual(filterRisk(items, compliance, { mine: true }).map((item) => item.id), ["unowned-sanctions"]);
  assert.deepEqual(filterRisk(items, compliance, { kind: "SANCTIONS" }).map((item) => item.id).sort(), ["owned-sanctions", "unowned-sanctions"]);
  assert.equal(ownerLabel(items.find((item) => item.id === "departed")!), "Sales");
  assert.equal(ownerLabel(items.find((item) => item.id === "owned")!), "Olive Owner");
  assert.equal(isMine(items.find((item) => item.id === "owned")!, { id: "someone-else", role: "ADMIN", deskRole: null }), false, "an owner's item isn't another owner's, whatever their role");
  assert.equal(riskCounts(items).SANCTIONS, 2);
});

test("a figure behind the sealed-bid wall is withheld from a walled role, and nothing else changes", () => {
  const sealedListing = { bidMode: "SEALED", bidDeadline: new Date(now.getTime() + 5 * DAY), status: "APPROVED" };
  const bid = raw("bid", "COVENANTS", ago(DAY), { amountCents: 5_000_000, amountLabel: "Bid", listing: sealedListing });
  const open = raw("deposit", "DEPOSIT", ago(DAY), { amountCents: 500_000, listing: { bidMode: "NONE", bidDeadline: null, status: "PENDING" } });
  const [traderBid, traderDeposit] = [riskView([bid], { role: "ADMIN", deskRole: "TRADER" }, new Map(), now)[0], riskView([open], { role: "ADMIN", deskRole: "TRADER" }, new Map(), now)[0]];
  assert.equal(traderBid.amountCents, null);
  assert.equal(traderBid.sealed, true);
  assert.equal(traderDeposit.amountCents, 500_000);
  const sales = riskView([bid], { role: "ADMIN", deskRole: "SALES" }, new Map(), now)[0];
  assert.equal(sales.amountCents, 5_000_000);
  assert.equal(sales.sealed, false);
  // After the deadline the wall lifts for a role that doesn't buy for the book.
  const closed = raw("bid", "COVENANTS", ago(DAY), { amountCents: 5_000_000, listing: { ...sealedListing, bidDeadline: ago(HOUR) } });
  assert.equal(riskView([closed], { role: "ADMIN", deskRole: "ANALYST" }, new Map(), now)[0].amountCents, 5_000_000);
  assert.equal(riskView([closed], { role: "ADMIN", deskRole: "TRADER" }, new Map(), now)[0].amountCents, null, "the book's buyer stays behind it while the listing is on the market");
});

test("an item's age reads in hours under two days, then days", () => {
  assert.equal(riskAge(ago(30 * 60 * 1000), now), "Under an hour");
  assert.equal(riskAge(ago(5 * HOUR), now), "5 hours");
  assert.equal(riskAge(ago(1 * HOUR), now), "1 hour");
  assert.equal(riskAge(ago(3 * DAY + HOUR), now), "3 days");
  assert.equal(riskAge(null, now), "Date not on record");
});

// ---------------------------------------------------------------------------------------------------------------
// The queue from the database: one fixture per kind, then each resolved.

type World = Awaited<ReturnType<typeof buildWorld>>;
let world: World;

async function buildWorld() {
  const owner = await user("owner", "ADMIN", { deskRole: "SALES" });
  const compliance = await user("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
  const seller = await user("seller", "INDIVIDUAL_SELLER", { companyName: `Risk Seller ${suffix} LLC` });
  const buyer = await user("buyer", "BUYER");
  const broker = await user("broker", "BROKER");
  const attested = { ownershipAttestedAt: ago(20 * DAY), ownershipAttestedById: seller.id, ownershipAttestation: "2026-11" };

  // Sanctions: two screens of the same party, name and entry are one review, dated from the first.
  const firstScreen = await prisma.ofacCheck.create({ data: { name: `Risk Party ${suffix}`, result: "REVIEW", status: "OPEN", matched: "SAMPLE ENTRY", userId: buyer.id, context: "Buyer signup", createdAt: ago(2 * DAY) } });
  const laterScreen = await prisma.ofacCheck.create({ data: { name: `Risk Party ${suffix}`, result: "REVIEW", status: "OPEN", matched: "SAMPLE ENTRY", userId: buyer.id, context: "Award", createdAt: ago(DAY) } });
  created.ofac.push(firstScreen.id, laterScreen.id);

  // Deals: one in contract with a closing open, one canceled with a deposit owed back, one closed with custodian
  // exceptions and a claim. Each closing is the deal owner's.
  const deal = await listing("deal", seller.id, { status: "PENDING", approvedAt: ago(40 * DAY), ...attested });
  const open = await closing(deal.id, { status: "OPEN", deskOwnerId: owner.id, openedAt: ago(10 * DAY) });
  const canceled = await closing(deal.id, { status: "CANCELED", canceledAt: ago(4 * DAY), cancelFault: "SELLER", depositReceivedCents: 500_000, openedAt: ago(30 * DAY) });
  const done = await closing(deal.id, {
    status: "COMPLETE",
    deskOwnerId: owner.id,
    openedAt: ago(60 * DAY),
    closedAt: ago(30 * DAY),
    custodianName: "Risk Custody Bank",
    custodianReceiptAt: ago(20 * DAY),
    custodianExceptions: "Allonge missing\nAssignment not recorded",
  });
  await event("CUSTODY_EXCEPTIONS", "closing", done.id, ago(6 * DAY));

  const wire = await prisma.wireChange.create({ data: { closingId: open.id, proposedById: owner.id, instructions: `Risk Bank ${suffix}`, createdAt: ago(5 * HOUR) } });
  created.wires.push(wire.id);
  const fee = await prisma.brokerFee.create({ data: { closingId: done.id, brokerId: broker.id, role: "SELLER_BROKER", amountCents: 150_000, basis: "PERCENT", approvedAt: ago(DAY), approvedById: owner.id } });
  created.fees.push(fee.id);
  const claim = await prisma.repurchaseClaim.create({
    data: { closingId: done.id, filedById: buyer.id, sellerId: seller.id, rep: "TITLE", description: "Title shows a prior lien.", remedy: "REPURCHASE", amountCents: 1_234_500, status: "UNDER_REVIEW", respondBy: ago(2 * DAY) },
  });
  created.claims.push(claim.id);

  // Payout accounts: the seller's held one and one in another name, and the broker's in their own name.
  const payout = (userId: string, accountName: string, extra: Record<string, unknown> = {}) =>
    prisma.payoutAccount.create({ data: { userId, bankName: "Risk Bank", accountName, routingNumber: "021000021", accountLast4: "4321", ...extra } }).then((row) => {
      created.payouts.push(row.id);
      return row;
    });
  const held = await payout(seller.id, seller.companyName, { screenResult: "REVIEW", screenedAt: ago(3 * DAY) });
  const mismatch = await payout(seller.id, "Unrelated Holder Ltd", { callbackAt: ago(HOUR), callbackById: owner.id });
  const brokerAccount = await payout(broker.id, broker.name);

  // Listings in review: a duplicate pair, one with no ownership statement, one with no assignment chain.
  const loan = { loanNumber: `RQ-${suffix}`, servicerName: "Risk Servicing LLC" };
  const dupA = await listing("dup a", seller.id, { status: "SUBMITTED", submittedAt: ago(9 * DAY), deskOwnerId: owner.id, ...attested }, [note({ ...loan, streetAddress: `77 Dup ${suffix} St` })]);
  const dupB = await listing("dup b", seller.id, { status: "SUBMITTED", submittedAt: ago(8 * DAY), ...attested }, [note({ ...loan, streetAddress: `77 Dup ${suffix} St` })]);
  const matches = await flagDuplicates(dupB.id, seller.id);
  assert.ok(matches.some((match) => match.listing.id === dupA.id), "the fixture pair matches");
  const ownership = await listing("ownership", seller.id, { status: "SUBMITTED", submittedAt: ago(10 * DAY), deskOwnerId: owner.id });
  const assignments = await listing("assignments", seller.id, { status: "SUBMITTED", submittedAt: ago(2 * DAY), ...attested });

  // Live listings: one paused, and a sealed one whose bid hasn't acknowledged the covenants.
  const paused = await listing("paused", seller.id, { status: "APPROVED", approvedAt: ago(50 * DAY), stalePausedAt: ago(3 * DAY), ...attested });
  const sealed = await listing(
    "sealed",
    seller.id,
    { status: "APPROVED", approvedAt: ago(5 * DAY), bidMode: "SEALED", bidDeadline: new Date(now.getTime() + 5 * DAY), deskOwnerId: owner.id, ...attested },
    [note({ inheritedCovenants: "Servicing follows the FHA loss-mitigation waterfall until 2028." })],
  );
  const bid = await prisma.inquiry.create({ data: { listingId: sealed.id, buyerId: buyer.id, type: "OFFER", amount: 50_000, status: "OPEN", createdAt: ago(DAY) } });
  created.inquiries.push(bid.id);

  const deletion = await prisma.deletionRequest.create({ data: { userId: buyer.id, reason: "Risk test", requestedAt: ago(7 * DAY) } });
  created.deletions.push(deletion.id);

  return { owner, compliance, seller, buyer, broker, firstScreen, laterScreen, open, canceled, done, wire, fee, claim, held, mismatch, brokerAccount, dupA, dupB, ownership, assignments, paused, sealed, bid, deletion };
}

const viewerOf = (row: { id: string; role: string; deskRole: string | null }) => ({ id: row.id, role: row.role, deskRole: row.deskRole });

test("every kind shows from its fixture, with what it is about, its age, its owner and a next step", async () => {
  world = await buildWorld();
  const items = await riskQueue(viewerOf(world.owner), { now });
  const find = (id: string) => {
    const item = items.find((row) => row.id === id);
    assert.ok(item, `${id} is in the queue`);
    return item!;
  };
  const expected: [string, RiskItem["kind"]][] = [
    [`SANCTIONS:${world.laterScreen.id}`, "SANCTIONS"],
    [`PAYOUT_HOLD:${world.held.id}`, "PAYOUT_HOLD"],
    [`WIRE_CHANGE:${world.wire.id}`, "WIRE_CHANGE"],
    [`DEPOSIT:${world.canceled.id}`, "DEPOSIT"],
    [`BROKER_FEE:${world.fee.id}`, "BROKER_FEE"],
    [`PAYOUT_NAME:${world.mismatch.id}`, "PAYOUT_NAME"],
    [`PAYOUT_CHECK:${world.brokerAccount.id}`, "PAYOUT_CHECK"],
    [`DUPLICATE:${world.dupA.id}`, "DUPLICATE"],
    [`DUPLICATE:${world.dupB.id}`, "DUPLICATE"],
    [`ASSIGNMENTS:${world.assignments.id}`, "ASSIGNMENTS"],
    [`OWNERSHIP:${world.ownership.id}`, "OWNERSHIP"],
    [`COVENANTS:${world.bid.id}`, "COVENANTS"],
    [`CUSTODY:${world.done.id}`, "CUSTODY"],
    [`CLAIM:${world.claim.id}`, "CLAIM"],
    [`PAUSED:${world.paused.id}`, "PAUSED"],
    [`DELETION:${world.deletion.id}`, "DELETION"],
  ];
  for (const [id, kind] of expected) {
    const item = find(id);
    assert.equal(item.kind, kind);
    assert.ok(item.next.length > 10, `${id} has a next step`);
    assert.ok(item.href.startsWith("/"), `${id} links to the page that resolves it`);
  }
  assert.equal(items.filter((item) => item.id.startsWith("SANCTIONS:") && item.title.includes(suffix)).length, 1, "two screens of one review are one item");

  const sanctions = find(`SANCTIONS:${world.laterScreen.id}`);
  assert.equal(sanctions.openedAt?.getTime(), world.firstScreen.createdAt.getTime(), "a review dates from its first screen");
  assert.equal(sanctions.href, "/admin/compliance");
  assert.equal(ownerLabel(sanctions), "Compliance");
  assert.equal(riskAge(sanctions.openedAt, now), "2 days");

  assert.equal(find(`DUPLICATE:${world.dupA.id}`).owner?.name, world.owner.name, "the deal owner owns it");
  assert.equal(find(`DUPLICATE:${world.dupA.id}`).href, `/admin/listings/${world.dupA.id}#duplicates`);
  assert.equal(find(`WIRE_CHANGE:${world.wire.id}`).href, `/closings/${world.open.id}#wires`);
  assert.equal(find(`PAYOUT_HOLD:${world.held.id}`).href, `/closings/${world.open.id}#payout`, "a seller's account is worked on their open closing");
  assert.equal(find(`PAYOUT_CHECK:${world.brokerAccount.id}`).href, "/admin/payouts");
  assert.match(find(`PAYOUT_NAME:${world.mismatch.id}`).next, /another desk member|other than the one who called/);
  assert.equal(find(`DEPOSIT:${world.canceled.id}`).amountCents, 500_000);
  assert.equal(find(`CUSTODY:${world.done.id}`).openedAt?.getTime(), ago(6 * DAY).getTime(), "custody dates from when the exceptions were recorded");
  assert.match(find(`DELETION:${world.deletion.id}`).detail, /an open bid/);
  assert.equal(find(`BROKER_FEE:${world.fee.id}`).resolver, "closings", "an approved fee waits for the member who records it paid");

  // Sanctions and money ahead of deal holds, deal holds ahead of housekeeping, and the older first within a tier.
  const index = (id: string) => items.findIndex((item) => item.id === id);
  assert.ok(index(`SANCTIONS:${world.laterScreen.id}`) < index(`WIRE_CHANGE:${world.wire.id}`));
  assert.ok(index(`WIRE_CHANGE:${world.wire.id}`) < index(`DUPLICATE:${world.dupB.id}`));
  assert.ok(index(`DUPLICATE:${world.dupB.id}`) < index(`PAUSED:${world.paused.id}`));
  assert.ok(index(`OWNERSHIP:${world.ownership.id}`) < index(`ASSIGNMENTS:${world.assignments.id}`), "filed ten days ago before filed two days ago");
});

test("the mine filter follows the deal owner, then the role", async () => {
  const ownerItems = filterRisk(await riskQueue(viewerOf(world.owner), { now }), viewerOf(world.owner), { mine: true }).map((item) => item.id);
  assert.ok(ownerItems.includes(`DUPLICATE:${world.dupA.id}`));
  assert.ok(ownerItems.includes(`CLAIM:${world.claim.id}`), "the claim's closing is theirs");
  assert.ok(!ownerItems.includes(`SANCTIONS:${world.laterScreen.id}`), "sales doesn't resolve sanctions");
  const complianceItems = filterRisk(await riskQueue(viewerOf(world.compliance), { now }), viewerOf(world.compliance), { mine: true }).map((item) => item.id);
  assert.ok(complianceItems.includes(`SANCTIONS:${world.laterScreen.id}`));
  assert.ok(complianceItems.includes(`DELETION:${world.deletion.id}`));
  assert.ok(!complianceItems.includes(`DUPLICATE:${world.dupA.id}`), "a named owner's item isn't compliance's");
  assert.ok(!complianceItems.includes(`CLAIM:${world.claim.id}`));
});

test("a desk role walled off from bids sees the sealed bid's item without its amount", async () => {
  const trader = { id: `risk-trader-${suffix}`, role: "ADMIN", deskRole: "TRADER" };
  const walled = (await riskQueue(trader, { now })).find((item) => item.id === `COVENANTS:${world.bid.id}`)!;
  assert.equal(walled.amountCents, null);
  assert.equal(walled.sealed, true);
  assert.ok(!/\$|50,000|5000000/.test(`${walled.title} ${walled.detail} ${walled.next}`), "no figure in the words either");
  const sales = (await riskQueue(viewerOf(world.owner), { now })).find((item) => item.id === `COVENANTS:${world.bid.id}`)!;
  assert.equal(sales.amountCents, 5_000_000);
  assert.equal(sales.sealed, false);
});

test("each item leaves the queue once resolved: a cleared OFAC check, a cleared duplicate and the rest", async () => {
  const ids = async () => new Set((await riskQueue(viewerOf(world.owner), { now })).map((item) => item.id));

  // The desk clears the review: both screens of it.
  await prisma.ofacCheck.updateMany({ where: { id: { in: [world.firstScreen.id, world.laterScreen.id] } }, data: { status: "CLEARED", reviewedAt: now, reviewedById: world.compliance.id, reviewNote: "Different date of birth" } });
  let open = await ids();
  assert.ok(!open.has(`SANCTIONS:${world.laterScreen.id}`));

  // Clearing one side of the duplicate pair leaves the other held, as its own approval would find it.
  const sales = { id: world.owner.id, role: "ADMIN", deskRole: "SALES" };
  assert.equal((await clearDuplicates(sales, { listingId: world.dupB.id, note: "Compared both tapes: one relist" })).ok, true);
  open = await ids();
  assert.ok(!open.has(`DUPLICATE:${world.dupB.id}`));
  assert.ok(open.has(`DUPLICATE:${world.dupA.id}`));
  assert.ok(await duplicateHold(world.dupA.id), "the queue agrees with the approval gate");
  assert.equal((await clearDuplicates(sales, { listingId: world.dupA.id, note: "Compared both tapes: one relist" })).ok, true);
  assert.equal(await duplicateHold(world.dupA.id), null);
  open = await ids();
  assert.ok(!open.has(`DUPLICATE:${world.dupA.id}`));

  // The rest, as the action that resolves each writes it.
  await prisma.payoutAccount.updateMany({ where: { id: { in: [world.held.id, world.mismatch.id, world.brokerAccount.id] } }, data: { status: "VERIFIED", verifiedAt: now, screenResult: "CLEAR" } });
  await prisma.wireChange.update({ where: { id: world.wire.id }, data: { status: "APPROVED", decidedAt: now } });
  await prisma.closing.update({ where: { id: world.canceled.id }, data: { depositStatus: "REFUNDED", depositResolvedAt: now } });
  await prisma.brokerFee.update({ where: { id: world.fee.id }, data: { status: "PAID", paidAt: now } });
  await prisma.closing.update({ where: { id: world.done.id }, data: { exceptionsClearedAt: now } });
  await prisma.repurchaseClaim.update({ where: { id: world.claim.id }, data: { status: "WITHDRAWN", resolvedAt: now } });
  await prisma.listing.update({ where: { id: world.ownership.id }, data: { ownershipAttestedAt: now } });
  await prisma.listing.update({ where: { id: world.paused.id }, data: { stalePausedAt: null, availableConfirmedAt: now } });
  await prisma.deletionRequest.update({ where: { id: world.deletion.id }, data: { status: "REFUSED", decidedAt: now } });
  for (const row of [world.assignments, world.ownership, world.dupA, world.dupB]) {
    await prisma.collateralItem.create({ data: { noteId: row.notes[0].id, kind: "ASSIGNMENT", status: "NOT_REQUIRED", sequence: 1 } });
  }
  const notes = await prisma.note.findMany({ where: { listingId: world.sealed.id }, select: COVENANT_SELECT });
  const hash = listingCovenants({ notes }).hash!;
  await prisma.inquiry.update({ where: { id: world.bid.id }, data: { covenantsAcknowledgedAt: now } });
  await recordCovenantAck(world.buyer.id, "inquiry", world.bid.id, { at: now, hash, loans: 1 });

  open = await ids();
  const mine = [...open].filter((id) => [...created.listings, ...created.closings, ...created.inquiries, ...created.payouts, ...created.wires, ...created.fees, ...created.claims, ...created.deletions, ...created.ofac].some((own) => id.endsWith(`:${own}`)));
  assert.deepEqual(mine, [], "nothing of this file's is still open");
});

// ---------------------------------------------------------------------------------------------------------------
// Service metrics.

test("a median and 90th percentile come from five events or more, and fewer reads as not enough data", () => {
  assert.equal(percentile([10, 2, 8, 4, 6], 0.5), 6);
  assert.equal(round(percentile([10, 2, 8, 4, 6], 0.9)), 9.2);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5, "an even count takes the mean of the middle two");
  assert.deepEqual(rounded(serviceFigure([10, 2, 8, 4, 6])), { count: 5, median: 6, p90: 9.2 });
  assert.deepEqual(serviceFigure([1, 2, 3, 4]), { count: 4, median: null, p90: null });
  assert.equal(formatService(null, "hours"), NOT_ENOUGH_DATA);
  assert.equal(NOT_ENOUGH_DATA, "Not enough data (n < 5)");
  assert.equal(formatService(6, "hours"), "6.0 hours");
  assert.equal(formatService(31, "days"), "31.0 days");

  // An event counts in the period it ended in; the period's end is outside it.
  const start = at("2000-01-01T00:00:00");
  const end = at("2000-02-01T00:00:00");
  const list = (values: [string, number][]) => values.map(([iso, value]) => ({ at: at(iso), value }));
  const empty = { listingReview: [], questions: [], closing: [], payoutAccounts: [], duplicateHolds: [], sanctionsReviews: [], closingSteps: {} };
  const figures = serviceFigures(
    {
      ...empty,
      listingReview: list([["2000-01-02T00:00:00", 2], ["2000-01-03T00:00:00", 4], ["2000-01-04T00:00:00", 6], ["2000-01-05T00:00:00", 8], ["2000-01-06T00:00:00", 10], ["2000-02-01T00:00:00", 500], ["1999-12-31T23:00:00", 500]]),
      closingSteps: { CLOSED: list([["2000-01-10T00:00:00", 30], ["2000-01-11T00:00:00", 31], ["2000-01-12T00:00:00", 32], ["2000-01-13T00:00:00", 33], ["2000-01-14T00:00:00", 29]]) },
    },
    { start, end },
  );
  assert.deepEqual(rounded(figures.listingReview), { count: 5, median: 6, p90: 9.2 });
  assert.equal(figures.closingSteps.CLOSED.median, 31);
  assert.deepEqual(figures.questions, { count: 0, median: null, p90: null });
});

const MARCH = { start: at("1993-03-01T00:00:00"), end: at("1993-04-01T00:00:00") };

async function buildMetricWorld() {
  const desk = world?.owner ?? (await user("metrics-desk", "ADMIN", { deskRole: "SALES" }));
  const seller = world?.seller ?? (await user("metrics-seller", "INDIVIDUAL_SELLER"));
  const asker = world?.buyer ?? (await user("metrics-buyer", "BUYER"));
  const reviewed: string[] = [];
  // Listing review: five listings filed on 1 March and first decided 2, 4, 6, 8 and 10 hours later. The flag and the
  // clearance on each are the duplicate holds: 3, 6, 9, 12 and 15 hours.
  for (const [index, hours] of [2, 4, 6, 8, 10].entries()) {
    const row = await listing(`metric ${index}`, seller.id, { status: "APPROVED", submittedAt: at("1993-03-01T00:00:00"), approvedAt: new Date(at("1993-03-01T00:00:00").getTime() + hours * HOUR) });
    reviewed.push(row.id);
    await prisma.reviewComment.create({ data: { listingId: row.id, authorId: desk.id, action: index === 4 ? "REQUEST_CHANGES" : "APPROVE", comment: "Decided", createdAt: new Date(at("1993-03-01T00:00:00").getTime() + hours * HOUR) } });
    await prisma.reviewComment.create({ data: { listingId: row.id, authorId: desk.id, action: "COMMENT", comment: "Possible duplicate, flagged automatically.", createdAt: at("1993-03-02T00:00:00") } });
    await event("DUPLICATE_CLEARED", "listing", row.id, new Date(at("1993-03-02T00:00:00").getTime() + (index + 1) * 3 * HOUR), desk.id);
  }
  // An older flag on the first listing doesn't count: a clearance pairs with the latest flag before it.
  await prisma.reviewComment.create({ data: { listingId: reviewed[0], authorId: desk.id, action: "COMMENT", comment: "Possible duplicate, flagged automatically.", createdAt: at("1993-02-15T00:00:00") } });
  // Filed in February and first decided then: its approval in March is not a first decision.
  const earlier = await listing("metric earlier", seller.id, { status: "APPROVED", submittedAt: at("1993-02-01T00:00:00") });
  await prisma.reviewComment.create({ data: { listingId: earlier.id, authorId: desk.id, action: "REQUEST_CHANGES", comment: "Fix the pay history", createdAt: at("1993-02-10T00:00:00") } });
  await prisma.reviewComment.create({ data: { listingId: earlier.id, authorId: desk.id, action: "APPROVE", comment: "Approved", createdAt: at("1993-03-05T00:00:00") } });

  // Bidder questions: four answered, too few for a figure.
  for (const hours of [1, 2, 3, 4]) {
    const row = await prisma.listingQuestion.create({ data: { listingId: reviewed[0], askerId: asker.id, question: "Is the borrower paying?", status: "ANSWERED", answer: "Yes", answeredById: desk.id, createdAt: at("1993-03-10T00:00:00"), answeredAt: new Date(at("1993-03-10T00:00:00").getTime() + hours * HOUR) } });
    created.questions.push(row.id);
  }

  // Closings: awarded 1 February, completed 2 to 6 March, 29 to 33 days, each with its closed step.
  for (const dayOfMonth of [2, 3, 4, 5, 6]) {
    const closedAt = at(`1993-03-0${dayOfMonth}T00:00:00`);
    const row = await closing(reviewed[1], { status: "COMPLETE", openedAt: at("1993-02-01T00:00:00"), closedAt });
    await prisma.closingStep.create({ data: { closingId: row.id, key: "CLOSED", status: "COMPLETE", completedAt: closedAt } });
  }

  // Payout accounts: verified 1 to 5 hours after they were added.
  for (const hours of [1, 2, 3, 4, 5]) {
    const row = await prisma.payoutAccount.create({
      data: { userId: seller.id, bankName: "Metric Bank", accountName: "Metric Holder", routingNumber: "021000021", accountLast4: "1111", status: "VERIFIED", createdAt: at("1993-03-01T00:00:00"), verifiedAt: new Date(at("1993-03-01T00:00:00").getTime() + hours * HOUR), retiredAt: at("1993-03-20T00:00:00") },
    });
    created.payouts.push(row.id);
  }

  // Sanctions reviews: five cleared, the first covering two screens and dated from the earlier (3 hours), the others 2
  // to 5 hours. A screen that took over an earlier clearance isn't a review the desk cleared.
  const T = at("1993-03-03T00:00:00");
  const screen = async (name: string, createdAt: Date, reviewedAt: Date) => {
    const row = await prisma.ofacCheck.create({ data: { name, result: "REVIEW", status: "CLEARED", matched: "SAMPLE ENTRY", userId: asker.id, createdAt, reviewedAt, reviewNote: "Different person" } });
    created.ofac.push(row.id);
  };
  await screen(`Metric Party 0 ${suffix}`, T, new Date(T.getTime() + HOUR));
  await screen(`Metric Party 0 ${suffix}`, new Date(T.getTime() - 2 * HOUR), new Date(T.getTime() + HOUR));
  for (const index of [1, 2, 3, 4]) await screen(`Metric Party ${index} ${suffix}`, T, new Date(T.getTime() + (index + 1) * HOUR));
  await screen(`Metric Party carried ${suffix}`, at("1993-03-20T00:00:00"), new Date(T.getTime() + HOUR));
}

test("each metric's median and 90th percentile come from the records, by the period each event ended", async () => {
  world ??= await buildWorld();
  await buildMetricWorld();
  const events = await loadServiceEvents(MARCH);
  const figures = serviceFigures(events, MARCH);
  assert.deepEqual(rounded(figures.listingReview), { count: 5, median: 6, p90: 9.2 }, "approvals and a send-back alike are first decisions");
  assert.deepEqual(figures.questions, { count: 4, median: null, p90: null });
  assert.equal(figures.closing.count, 5);
  assert.equal(figures.closing.median, 31);
  assert.equal(figures.closingSteps.CLOSED.median, 31);
  assert.equal(figures.closingSteps.PURCHASE_AGREEMENT.count, 0);
  assert.equal(figures.payoutAccounts.median, 3);
  assert.equal(figures.duplicateHolds.median, 9);
  assert.equal(figures.duplicateHolds.count, 5);
  assert.deepEqual(rounded(figures.sanctionsReviews), { count: 5, median: 3, p90: 4.6 });
});

test("the board pack carries the service figures, with blanks under five events", async () => {
  const pack = await boardPack("1993-03");
  assert.equal(metricValue(pack.current, "service.listingReview.median"), 6);
  assert.equal(round(metricValue(pack.current, "service.listingReview.p90")), 9.2);
  assert.equal(metricValue(pack.current, "service.listingReview.count"), 5);
  assert.equal(metricValue(pack.current, "service.questions.median"), null);
  assert.equal(metricValue(pack.current, "service.questions.count"), 4);
  assert.equal(metricValue(pack.current, "service.closing.median"), 31);
  assert.equal(metricValue(pack.current, "service.sanctionsReviews.median"), 3);
  // February: the one listing first decided then is too few.
  assert.equal(metricValue(pack.prior, "service.listingReview.count"), 1);
  assert.equal(metricValue(pack.prior, "service.listingReview.median"), null);
  // The three months pool them: six first decisions.
  assert.equal(metricValue(pack.trailing, "service.listingReview.count"), 6);
  for (const key of ["service.listingReview.median", "service.listingReview.p90", "service.questions.count", "service.sanctionsReviews.median"]) {
    assert.ok(BOARD_METRICS.some((metric) => metric.key === key && metric.section === "Service"), key);
  }
  const csv = boardCsv(pack, "Live count").split("\n");
  assert.ok(csv.some((line) => line.startsWith("Service,\"Listing review, median hours\",number,6,")), "the CSV has the row");
  assert.ok(csv.some((line) => line.startsWith("Service,\"Bidder questions, median hours\",number,,")), "a blank under five events");
});
