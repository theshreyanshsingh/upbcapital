import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { canOpenListing } from "../lib/access";
import { buyNowOffer } from "../lib/buy-now";
import { literal } from "../lib/db-filters";
import { checkOffer, inquiryBlock, placeBuyNow } from "../lib/inquiry";
import { acceptInvite, inviteUser, invitePending, INVITE_DAYS, resendInvite, tokenHash, withdrawInvite } from "../lib/invites";
import { labelOf } from "../lib/labels";
import { claimLaunch, dueLaunches, runLaunches } from "../lib/launch";
import { approvalFields, comingSoonCard, launchBlock, launchPending, launchTime, MAX_LAUNCH_DAYS, readLaunchAt } from "../lib/launch-rules";
import { CONSENT_REQUIRED } from "../lib/legal";
import { rescoreListing } from "../lib/matching";
import { gapLine, holdingReturn, markDate, MIN_RECEIPTS, NOT_ENOUGH, portfolioReturn, xirr, type ReturnInput } from "../lib/portfolio-returns";
import {
  buildYearStatementPdf,
  ESTIMATED,
  loadStatementHoldings,
  readReceiptSplit,
  splitReceipts,
  STATEMENT_NOTE,
  statementCsv,
  statementSeason,
  statementYears,
  taxYearStatement,
  type StatementHolding,
} from "../lib/portfolio-tax";
import { prisma } from "../lib/prisma";
import { documentGate } from "../lib/room-access";
import { joinBlock } from "../lib/sale-events";
import { alertMatchingSearches } from "../lib/search-alerts";
import { upbBucket } from "../lib/strata";
import { notifyWatchers } from "../lib/watchers";

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
// Notices stay in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and listings nothing seeded touches.

async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN") =>
    prisma.user.create({
      data: {
        email: `rg-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const buyer = await person("buyer", "BUYER");
  const watcher = await person("watcher", "BUYER");
  await prisma.buyerProfile.create({
    data: {
      userId: buyer.id,
      status: "APPROVED",
      entityType: "LLC",
      entityName: `Fund ${tag}`,
      homesControlled: 4,
      reoStrategy: "SELL",
      eligibilityAt: new Date(Date.now() - DAY),
      proofAmount: 500000,
      proofVerifiedAt: new Date(Date.now() - DAY),
      proofExpiresAt: new Date(Date.now() + 30 * DAY),
    },
  });
  const city = `Launchtown${tag}`;
  const listing = (title: string, launchAt: Date | null) =>
    prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId: seller.id,
        status: "APPROVED",
        title: `${title} ${tag}`,
        ...approvalFields(launchAt, new Date(Date.now() - DAY)),
        buyNowPrice: 150000,
        notes: {
          create: [{
            streetAddress: "1 Hidden Lane", city, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
            lienPosition: "FIRST", upb: 200000, interestRate: 6, monthlyPi: 1200, paymentStatus: "PERFORMING", monthsDelinquent: 0,
            askingPrice: 120000, estimatedValue: 260000, borrowerName: "Pat Borrower",
          }] as never,
        },
      },
      include: { notes: true, seller: true },
    });
  return { tag, city, seller, desk, buyer, watcher, users: [seller, desk, buyer, watcher], listing, listingIds: [] as string[], extraUserIds: [] as string[] };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const listingIds = (await prisma.listing.findMany({ where: { title: { contains: literal(world.tag) } }, select: { id: true } })).map((row) => row.id);
  const invited = (await prisma.user.findMany({ where: { email: { contains: literal(world.tag) } }, select: { id: true } })).map((row) => row.id);
  const userIds = [...new Set([...world.users.map((user) => user.id), ...world.extraUserIds, ...invited])];
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.passwordReset.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { contains: literal(world.tag) } }, { subject: { contains: literal(world.tag) } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const mail = (email: string, subject: string) => prisma.notification.count({ where: { toEmail: email, subject: { contains: literal(subject) } } });

// ---------------------------------------------------------------------------------------------------------------
// Coming soon.

test("the launch field reads as UTC, refuses the past and the far future, and approval dates the listing from it", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  assert.deepEqual(readLaunchAt("", now), { at: null, error: null });
  assert.equal(readLaunchAt("2026-11-12T14:00", now).at?.toISOString(), "2026-11-12T14:00:00.000Z");
  assert.match(readLaunchAt("2026-11-07T11:59", now).error ?? "", /in the future/);
  assert.match(readLaunchAt("soon", now).error ?? "", /launch date and time/);
  assert.match(readLaunchAt(new Date(now.getTime() + (MAX_LAUNCH_DAYS + 1) * DAY).toISOString().slice(0, 16), now).error ?? "", /within 90 days/);
  const at = new Date("2026-11-12T14:00:00Z");
  // approvedAt is the launch, so the early-access window and roundups count from it.
  assert.deepEqual(approvalFields(at, now), { approvedAt: at, launchAt: at, launchNotifiedAt: null });
  assert.deepEqual(approvalFields(null, now), { approvedAt: now, launchAt: null });
  assert.equal(launchTime(at), "Nov 12, 2026, 14:00 UTC");
  assert.equal(launchPending({ launchAt: at }, now), true);
  assert.equal(launchPending({ launchAt: at }, at), false);
  assert.equal(launchPending({ launchAt: null }, now), false);
  assert.equal(launchPending(null, now), false);
});

test("the coming-soon card shows the screen's facts and a UPB band, never the ask or the address", () => {
  const card = comingSoonCard({
    id: "L1",
    title: "Teaser",
    kind: "SINGLE",
    launchAt: new Date("2026-11-12T14:00:00Z"),
    notes: [{ state: "ZZ", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 200000, askingPrice: 120000, streetAddress: "1 Hidden Lane", city: "Launchtown", borrowerName: "Pat Borrower", zip: "00000" } as never],
  });
  assert.deepEqual(Object.keys(card).sort(), ["id", "kind", "launchAt", "launchLabel", "lien", "loanCount", "performance", "states", "title", "upbBand"]);
  assert.equal(card.states, "ZZ");
  assert.equal(card.lien, labelOf("lien", "FIRST"));
  assert.equal(card.performance, "Performing");
  assert.equal(card.upbBand, upbBucket(200000));
  assert.equal(card.launchLabel, "Nov 12, 2026, 14:00 UTC");
  const text = JSON.stringify(card);
  for (const hidden of ["Hidden Lane", "Launchtown", "Pat Borrower", "120000", "120,000", "00000"]) assert.ok(!text.includes(hidden), `the card carries ${hidden}`);
  // A pool names its states and shows a mixed lien rather than any one loan.
  const pool = comingSoonCard({
    id: "L2",
    title: "Pool",
    kind: "POOL",
    launchAt: new Date("2026-11-12T14:00:00Z"),
    notes: ["TX", "FL", "OH", "GA"].map((state, index) => ({ state, lienPosition: index ? "FIRST" : "SECOND", paymentStatus: "PERFORMING", upb: 150000 })),
  });
  assert.equal(pool.states, "FL, GA, OH +1");
  assert.equal(pool.lien, "Mixed");
  assert.equal(pool.upbBand, upbBucket(600000));
});

test("every launch gate is closed before the launch time and open after it", async () => {
  const world = await makeWorld();
  try {
    const { buyer, seller, desk } = world;
    const launchAt = new Date(Date.now() + 2 * DAY);
    const listing = await world.listing("Coming", launchAt);
    const access = (viewer: typeof buyer, row: { launchAt: Date | null }, now?: Date) =>
      canOpenListing({ viewer, status: "APPROVED", approvedAt: launchAt, earlyAccessHours: 0, openableIds: new Set([listing.id]), listingId: listing.id, sellerId: seller.id, launchAt: row.launchAt, now });

    // The listing page, photos, compare and search: buyers get the teaser, the seller and the desk the whole file.
    assert.deepEqual(access(buyer, listing), { ok: false, reason: "coming" });
    assert.equal(access(seller, listing).ok, true);
    assert.equal(access(desk, listing).ok, true);
    assert.equal(access(buyer, listing, new Date(launchAt.getTime() + MINUTE)).ok, true);

    // Bids and requests, buy it now, the NDA, the data room, a sale event and standing-bid invites each say why.
    const blocked = await inquiryBlock(buyer, listing);
    assert.match(blocked ?? "", /^This listing is coming soon\. Bids and requests open when it goes live on .* UTC\.$/);
    const bid = await checkOffer({ user: buyer, listing, noteId: "", amount: 100000, goodUntil: "" });
    assert.match(bid.error ?? "", /coming soon/);
    const offer = buyNowOffer(listing, true);
    assert.equal(offer.price, null);
    assert.match(offer.reason ?? "", /Buy it now opens when it goes live/);
    const take = await placeBuyNow({ user: buyer, listingId: listing.id, price: 150000 });
    assert.match(take.error ?? "", /coming soon/);
    assert.equal(await prisma.inquiry.count({ where: { listingId: listing.id } }), 0);
    assert.match(launchBlock(listing, "nda") ?? "", /The confidentiality agreement opens when it goes live/);
    assert.match(launchBlock(listing, "invite") ?? "", /Standing-bid invites open/);
    const event = { id: "E1", status: "PLANNED", indicationsAt: new Date(Date.now() + 10 * DAY) };
    assert.match(joinBlock({ event, listing, currentEventStatus: null, liveBids: 0, consent: "Email of Nov 1" }) ?? "", /It can join a sale event when it goes live/);

    // A signed NDA from an earlier approval still opens nothing before the launch.
    const file = await prisma.document.create({ data: { listingId: listing.id, type: "BPO", originalName: "bpo.pdf", storedName: `rg/${world.tag}/bpo.pdf`, mime: "application/pdf", size: 10 } });
    await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId: listing.id, signerName: buyer.name } });
    assert.equal((await documentGate(buyer, file.id)).allowed, false);
    assert.equal((await documentGate(seller, file.id)).allowed, true);

    // Alerts, buy-box mail and watcher notices hold until the launch.
    await prisma.favorite.create({ data: { userId: world.watcher.id, listingId: listing.id } });
    await prisma.savedSearch.create({ data: { userId: buyer.id, name: `Launch ${world.tag}`, filters: { q: world.city }, cadence: "INSTANT" } });
    await prisma.buyBox.create({ data: { userId: buyer.id, name: `ZZ box ${world.tag}`, states: "ZZ" } });
    await alertMatchingSearches(listing.id);
    await rescoreListing(listing.id, true);
    assert.equal(await notifyWatchers({ listingId: listing.id, event: "REPRICE", subject: `New price · ${listing.title}`, body: "Moved." }), 0);
    assert.equal(await mail(buyer.email, `Launch ${world.tag}`), 0);
    assert.equal(await mail(buyer.email, `Buy box match · ${listing.title}`), 0);
    assert.equal(await mail(world.watcher.email, listing.title), 0);
    // The match is written quietly, so the desk's sheet still sees it.
    assert.equal(await prisma.listingMatch.count({ where: { listingId: listing.id, userId: buyer.id } }), 1);

    // At the launch time every gate opens.
    const past = new Date(Date.now() - MINUTE);
    await prisma.listing.update({ where: { id: listing.id }, data: { launchAt: past, approvedAt: past } });
    const live = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id }, include: { seller: true } });
    assert.equal(await inquiryBlock(buyer, live), null);
    assert.doesNotMatch((await checkOffer({ user: buyer, listing: live, noteId: "", amount: 100000, goodUntil: "" })).error ?? "", /coming soon/);
    assert.equal(buyNowOffer(live, true).price, 150000);
    assert.equal(launchBlock(live, "nda"), null);
    assert.equal(joinBlock({ event, listing: live, currentEventStatus: null, liveBids: 0, consent: "Email of Nov 1" }), null);
    assert.equal((await documentGate(buyer, file.id)).allowed, true);
    assert.equal(access(buyer, live).ok, true);
  } finally {
    await cleanWorld(world);
  }
});

test("the launch job claims each listing once and runs the alerts approval held back", async () => {
  const world = await makeWorld();
  try {
    const { buyer, watcher, seller } = world;
    const listing = await world.listing("Launching", new Date(Date.now() + DAY));
    const later = await world.listing("Later", new Date(Date.now() + 3 * DAY));
    await prisma.favorite.create({ data: { userId: watcher.id, listingId: listing.id } });
    await prisma.savedSearch.create({ data: { userId: buyer.id, name: `Launch ${world.tag}`, filters: { q: world.city }, cadence: "INSTANT" } });
    await prisma.buyBox.create({ data: { userId: buyer.id, name: `ZZ box ${world.tag}`, states: "ZZ" } });
    const ids = [listing.id, later.id];

    // Nothing is due before its time.
    assert.deepEqual(await runLaunches(new Date(), { listingIds: ids }), { sent: 0, failed: 0, error: "" });
    const past = new Date(Date.now() - MINUTE);
    await prisma.listing.update({ where: { id: listing.id }, data: { launchAt: past, approvedAt: past } });
    assert.deepEqual((await dueLaunches(new Date(), ids)).map((row) => row.id), [listing.id]);

    const tally = await runLaunches(new Date(), { listingIds: ids });
    assert.deepEqual(tally, { sent: 1, failed: 0, error: "" });
    assert.equal(await mail(watcher.email, `Now live · ${listing.title}`), 1);
    assert.equal(await mail(buyer.email, `Launch ${world.tag}`), 1);
    assert.equal(await mail(buyer.email, `Buy box match · ${listing.title}`), 1);
    assert.equal(await mail(seller.email, `Live · ${listing.title}`), 1);
    // The seller isn't a watcher of their own listing, and the later listing told nobody.
    assert.equal(await mail(seller.email, `Now live · ${listing.title}`), 0);
    assert.equal(await mail(watcher.email, later.title), 0);
    const launched = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.ok(launched.launchNotifiedAt);

    // A second run, or two overlapping ones, send nothing more.
    assert.deepEqual(await runLaunches(new Date(), { listingIds: ids }), { sent: 0, failed: 0, error: "" });
    assert.equal(await mail(watcher.email, `Now live · ${listing.title}`), 1);
    await prisma.listing.update({ where: { id: later.id }, data: { launchAt: past, approvedAt: past } });
    const claims = await Promise.all([claimLaunch({ id: later.id, launchAt: past }), claimLaunch({ id: later.id, launchAt: past })]);
    assert.deepEqual(claims.sort(), [false, true]);
    // A claim made on a launch time the desk has since moved finds nothing.
    assert.equal(await claimLaunch({ id: listing.id, launchAt: new Date(past.getTime() - DAY) }), false);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Desk invites.

test("an invite makes the account with a link, refuses a known email, and can be sent again, accepted or withdrawn", async () => {
  const world = await makeWorld();
  try {
    const actor = { id: world.desk.id, name: world.desk.name };
    const now = new Date();
    const email = `rg-invitee-${world.tag}@example.org`;
    const sent = await inviteUser({ actor, name: `Invitee ${world.tag}`, email: email.toUpperCase(), companyName: "Ridge Capital", role: "BUYER", status: "APPROVED", now });
    assert.equal(sent.error, null);
    if (sent.error !== null) return;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sent.userId } });
    assert.equal(user.email, email);
    assert.equal(user.role, "BUYER");
    assert.equal(user.accountStatus, "APPROVED");
    assert.equal(user.invitedById, world.desk.id);
    assert.equal(user.invitedAt?.getTime(), now.getTime());
    assert.equal(invitePending(user), true);
    // Nothing signs in with the placeholder.
    assert.equal(await bcrypt.compare("", user.passwordHash), false);
    assert.equal(await bcrypt.compare(user.passwordHash, user.passwordHash), false);
    const link = await prisma.passwordReset.findUniqueOrThrow({ where: { tokenHash: tokenHash(sent.token) } });
    assert.equal(link.userId, user.id);
    assert.equal(link.expiresAt.getTime(), now.getTime() + INVITE_DAYS * DAY);
    assert.equal(await prisma.auditEvent.count({ where: { action: "INVITE_SENT", entityId: user.id, actorId: world.desk.id } }), 1);

    // An address already on the desk, invited or not, is refused.
    assert.match((await inviteUser({ actor, name: "Again", email, companyName: "", role: "BUYER", status: "PENDING" })).error ?? "", /already on the desk/);
    assert.match((await inviteUser({ actor, name: "Seller", email: world.seller.email, companyName: "", role: "BROKER", status: "PENDING" })).error ?? "", /already on the desk/);
    assert.match((await inviteUser({ actor, name: "Desk", email: `rg-x-${world.tag}@example.org`, companyName: "", role: "ADMIN", status: "APPROVED" })).error ?? "", /buyer, seller or broker/);
    assert.match((await inviteUser({ actor, name: "Inst", email: `rg-y-${world.tag}@example.org`, companyName: "", role: "INSTITUTIONAL_SELLER", status: "APPROVED" })).error ?? "", /company name/);

    // Sending again replaces the link.
    const again = await resendInvite(user.id, actor);
    assert.equal(again.error, null);
    if (again.error !== null) return;
    assert.notEqual(again.token, sent.token);
    assert.equal(await prisma.passwordReset.count({ where: { userId: user.id } }), 1);
    const stale = await acceptInvite({ token: sent.token, password: "longenough", confirm: "longenough", terms: "yes" });
    assert.ok(stale.error !== null && "expired" in stale && stale.expired);

    // The set-password form checks the password and the terms before opening the account.
    assert.match((await acceptInvite({ token: again.token, password: "short", confirm: "short", terms: "yes" })).error ?? "", /8 characters/);
    assert.match((await acceptInvite({ token: again.token, password: "longenough", confirm: "different1", terms: "yes" })).error ?? "", /do not match/);
    assert.equal((await acceptInvite({ token: again.token, password: "longenough", confirm: "longenough", terms: null })).error, CONSENT_REQUIRED);
    const opened = await acceptInvite({ token: again.token, password: "longenough", confirm: "longenough", terms: "yes" });
    assert.equal(opened.error, null);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(invitePending(after), false);
    assert.equal(await bcrypt.compare("longenough", after.passwordHash), true);
    assert.ok(after.termsVersion && after.termsAcceptedAt);
    assert.equal(await prisma.passwordReset.count({ where: { userId: user.id } }), 0);
    assert.ok((await acceptInvite({ token: again.token, password: "longenough", confirm: "longenough", terms: "yes" })).error);
    assert.match((await resendInvite(user.id, actor)).error ?? "", /already accepted/);
    assert.match((await withdrawInvite(user.id, actor)).error ?? "", /already accepted/);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: user.id, action: { in: ["INVITE_RESENT", "INVITE_ACCEPTED"] } } }), 2);

    // A pending broker invitation withdrawn takes the unused account and its link with it.
    const broker = await inviteUser({ actor, name: `Broker ${world.tag}`, email: `rg-broker-${world.tag}@example.org`, companyName: "Ridge Brokers", role: "BROKER", status: "PENDING" });
    assert.equal(broker.error, null);
    if (broker.error !== null) return;
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: broker.userId } })).accountStatus, "PENDING");
    assert.equal(await prisma.brokerProfile.count({ where: { userId: broker.userId } }), 1);
    assert.equal((await withdrawInvite(broker.userId, actor)).error, null);
    assert.equal(await prisma.user.count({ where: { id: broker.userId } }), 0);
    assert.equal(await prisma.passwordReset.count({ where: { userId: broker.userId } }), 0);
    assert.equal(await prisma.brokerProfile.count({ where: { userId: broker.userId } }), 0);
    assert.equal(await prisma.auditEvent.count({ where: { action: "INVITE_WITHDRAWN", entityId: broker.userId } }), 1);
    const dead = await acceptInvite({ token: broker.token, password: "longenough", confirm: "longenough", terms: "yes" });
    assert.ok(dead.error);
    world.extraUserIds.push(user.id, broker.userId);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The split, the year-end statement and returns.

test("a receipt without a split is estimated from the note rate and the running balance", () => {
  const loan = { upb: 100000, annualRate: 6, acquiredAt: utc("2025-01-01") };
  const [first, second] = splitReceipts([{ amount: 599.55, paidOn: utc("2025-03-01") }, { amount: 599.55, paidOn: utc("2025-02-01") }], loan);
  assert.equal(first.paidOn.toISOString().slice(0, 10), "2025-02-01");
  assert.deepEqual(first.split, { principal: 99.55, interest: 500, fees: 0, escrow: 0 });
  assert.equal(first.estimated, true);
  assert.deepEqual(second.split, { principal: 100.05, interest: 499.5, fees: 0, escrow: 0 });
  // A logged split stands as logged and moves the balance the next estimate starts from.
  const mixed = splitReceipts([
    { amount: 700, paidOn: utc("2025-02-01"), principal: 300, interest: 350, fees: 50, escrow: null },
    { amount: 600, paidOn: utc("2025-03-01") },
  ], loan);
  assert.deepEqual(mixed[0].split, { principal: 300, interest: 350, fees: 50, escrow: 0 });
  assert.equal(mixed[0].estimated, false);
  assert.deepEqual(mixed[1].split, { principal: 101.5, interest: 498.5, fees: 0, escrow: 0 });
  // Three months between payments accrue three months' interest.
  assert.equal(splitReceipts([{ amount: 2000, paidOn: utc("2025-04-01") }], loan)[0].split?.interest, 1500);
  // A payoff past the balance leaves the excess as fees, and a note with no rate on file stays unsplit.
  assert.deepEqual(splitReceipts([{ amount: 1100, paidOn: utc("2025-02-01") }], { ...loan, upb: 1000 })[0].split, { principal: 1000, interest: 5, fees: 95, escrow: 0 });
  const unknown = splitReceipts([{ amount: 500, paidOn: utc("2025-02-01") }], { ...loan, annualRate: null });
  assert.equal(unknown[0].split, null);
  assert.equal(unknown[0].estimated, false);
});

test("the log form's split must add up to the payment, and a blank amount takes its total", () => {
  const blank = { amount: "", principal: "", interest: "", fees: "", escrow: "" };
  assert.deepEqual(readReceiptSplit({ ...blank, amount: "$1,200" }), { error: null, amount: 1200, split: null });
  assert.deepEqual(readReceiptSplit({ ...blank, principal: "200", interest: "950", escrow: "50" }), { error: null, amount: 1200, split: { principal: 200, interest: 950, fees: 0, escrow: 50 } });
  assert.deepEqual(readReceiptSplit({ ...blank, amount: "1200", principal: "200", interest: "1000" }), { error: null, amount: 1200, split: { principal: 200, interest: 1000, fees: 0, escrow: 0 } });
  assert.match(readReceiptSplit({ ...blank, amount: "1200", principal: "200", interest: "900" }).error ?? "", /adds up to \$1,100\.00, but the payment is \$1,200\.00/);
  assert.match(readReceiptSplit({ ...blank, amount: "1200", fees: "-5" }).error ?? "", /in dollars/);
  assert.match(readReceiptSplit(blank).error ?? "", /required/);
});

function holding(over: Partial<StatementHolding> & Pick<StatementHolding, "id">): StatementHolding {
  return {
    title: over.id,
    costBasis: 50000,
    upb: 100000,
    acquiredAt: utc("2024-06-01"),
    status: "CURRENT",
    sharePercent: 100,
    underwrittenYield: 12,
    annualRate: 6,
    receipts: [],
    proceeds: [],
    ...over,
  };
}

test("the year-end statement totals each holding's receipts and resale for the tax year, and says it isn't a tax form", async () => {
  const loan = { upb: 100000, annualRate: 6, acquiredAt: utc("2024-12-01") };
  const book = [
    // Estimated: one receipt in 2024, two in 2025.
    holding({
      id: "estimated",
      acquiredAt: loan.acquiredAt,
      receipts: splitReceipts([{ amount: 599.55, paidOn: utc("2025-01-01") }, { amount: 599.55, paidOn: utc("2025-02-01") }, { amount: 599.55, paidOn: utc("2024-12-31") }], loan),
    }),
    // Logged by the holder.
    holding({ id: "logged", costBasis: 30000, receipts: splitReceipts([{ amount: 1000, paidOn: utc("2025-05-01"), principal: 400, interest: 500, fees: 25, escrow: 75 }], loan) }),
    // Added by hand with no rate on file, so its 2025 money is unsplit.
    holding({ id: "by hand", costBasis: 20000, annualRate: null, receipts: splitReceipts([{ amount: 800, paidOn: utc("2025-07-01") }], { ...loan, annualRate: null }) }),
    // Resold in 2025, and one sold before the year, and one bought after it.
    holding({ id: "resold", costBasis: 40000, proceeds: [{ amount: 45500, on: utc("2025-09-15"), listingId: "R1" }] }),
    holding({ id: "gone", proceeds: [{ amount: 1, on: utc("2024-11-01"), listingId: "R0" }] }),
    holding({ id: "new", acquiredAt: utc("2026-02-01") }),
  ];
  const statement = taxYearStatement(book, 2025);
  assert.deepEqual(statement.rows.map((row) => row.id), ["estimated", "logged", "by hand", "resold"]);
  const row = (id: string) => statement.rows.find((item) => item.id === id)!;
  // The December receipt was a full month of interest on 100,000; January's starts from the lower balance.
  assert.equal(row("estimated").received, 1199.1);
  assert.equal(row("estimated").interest, 998.5);
  assert.equal(row("estimated").basis, ESTIMATED);
  assert.deepEqual([row("logged").interest, row("logged").principal, row("logged").fees, row("logged").escrow, row("logged").basis], [500, 400, 25, 75, "As logged"]);
  assert.deepEqual([row("by hand").unsplit, row("by hand").interest, row("by hand").basis], [800, 0, "Not split"]);
  assert.deepEqual([row("resold").saleProceeds, row("resold").soldOn?.toISOString().slice(0, 10), row("resold").basis], [45500, "2025-09-15", "No receipts"]);
  assert.deepEqual(statement.totals, {
    costBasis: 50000 + 30000 + 20000 + 40000,
    interest: 1498.5,
    principal: 600.6,
    fees: 25,
    escrow: 75,
    unsplit: 800,
    received: 2999.1,
    saleProceeds: 45500,
  });
  const csv = statementCsv(statement);
  assert.match(csv.split("\n")[0], /^Holding,Acquired,Cost basis,Interest,Principal,Fees,Escrow,Not split,Total received,Sale proceeds,Sale date,Split$/);
  assert.match(csv, /Total 2025,,140000,1498\.5,600\.6,25,75,800,2999\.1,45500/);
  assert.ok(csv.split("\n").at(-1)?.startsWith(`${STATEMENT_NOTE},`));
  assert.equal(STATEMENT_NOTE, "This statement is not a tax form. Your servicer issues Form 1098 and 1099 forms. Check with your tax adviser.");
  const pdf = Buffer.from(await buildYearStatementPdf(statement, "Fund LLC"));
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  // A book long enough to spill onto a second page still builds.
  const long = taxYearStatement(Array.from({ length: 30 }, (_, index) => holding({ id: `h${index}` })), 2025);
  assert.ok((await buildYearStatementPdf(long, "Fund LLC")).length > pdf.length);
  // January to April offers last year; the rest of the year, this year. The picker runs back to the first purchase.
  assert.deepEqual(statementSeason(utc("2026-02-10")), { season: true, year: 2025 });
  assert.deepEqual(statementSeason(utc("2026-11-07")), { season: false, year: 2026 });
  assert.deepEqual(statementYears([{ acquiredAt: utc("2024-03-01") }], utc("2026-11-07")), [2026, 2025, 2024]);
});

test("a buyer's book loads with the note rate and a closed resale's proceeds", async () => {
  const world = await makeWorld();
  try {
    const source = await world.listing("Source", null);
    const bought = await prisma.buyerHolding.create({
      data: { userId: world.buyer.id, listingId: source.id, title: `Held ${world.tag}`, costBasis: 90000, upb: 100000, underwrittenYield: 11, acquiredAt: utc("2025-01-01") },
    });
    await prisma.cashReceipt.createMany({ data: [{ buyerHoldingId: bought.id, amount: 599.55, paidOn: utc("2025-02-01") }, { buyerHoldingId: bought.id, amount: 600, paidOn: utc("2025-03-01"), principal: 100, interest: 500 }] });
    const relist = await world.listing("Resale", null);
    await prisma.listing.update({ where: { id: relist.id }, data: { status: "SOLD", soldAt: utc("2025-10-01"), netToSellerCents: 9_650_000 } });
    await prisma.auditEvent.create({ data: { actorId: world.buyer.id, action: "RELIST", entityType: "holding", entityId: bought.id, detail: relist.id } });
    const [loaded] = await loadStatementHoldings(world.buyer.id);
    assert.equal(loaded.annualRate, 6);
    assert.equal(loaded.receipts[0].estimated, true);
    assert.equal(loaded.receipts[0].split?.interest, 500);
    assert.equal(loaded.receipts[1].estimated, false);
    assert.deepEqual(loaded.proceeds, [{ amount: 96500, on: utc("2025-10-01"), listingId: relist.id }]);
    const statement = taxYearStatement([loaded], 2025);
    assert.equal(statement.totals.saleProceeds, 96500);
    assert.equal(statement.rows[0].basis, `Part ${ESTIMATED.toLowerCase()}`);
  } finally {
    await prisma.buyerHolding.deleteMany({ where: { userId: world.buyer.id } });
    await cleanWorld(world);
  }
});

test("XIRR matches the published worked example and a plain year at 10%", () => {
  // The worked example in the spreadsheet documentation for XIRR: 0.373362535.
  const rate = xirr([
    { at: utc("2008-01-01"), amount: -10000 },
    { at: utc("2008-03-01"), amount: 2750 },
    { at: utc("2008-10-30"), amount: 4250 },
    { at: utc("2009-02-15"), amount: 3250 },
    { at: utc("2009-04-01"), amount: 2750 },
  ]);
  assert.ok(rate != null && Math.abs(rate - 0.373362535) < 1e-6, String(rate));
  assert.ok(Math.abs((xirr([{ at: utc("2025-01-01"), amount: -100 }, { at: utc("2026-01-01"), amount: 110 }]) ?? 0) - 0.1) < 1e-9);
  // A loss solves too, and flows that only go one way have no rate.
  assert.ok(Math.abs((xirr([{ at: utc("2025-01-01"), amount: -100 }, { at: utc("2026-01-01"), amount: 50 }]) ?? 0) + 0.5) < 1e-9);
  assert.equal(xirr([{ at: utc("2025-01-01"), amount: 100 }, { at: utc("2025-06-01"), amount: 10 }]), null);
  assert.equal(xirr([]), null);
});

test("returns show money in, money back and the gap to underwriting, and say not enough history before 3 receipts", () => {
  const now = utc("2025-07-01");
  const loan = { upb: 100000, annualRate: 6, acquiredAt: utc("2025-01-01") };
  const base: ReturnInput = { costBasis: 60000, acquiredAt: loan.acquiredAt, upb: 100000, status: "CURRENT", underwrittenYield: 12, receipts: [], proceeds: [] };
  const paid = (months: number) => splitReceipts(Array.from({ length: months }, (_, index) => ({ amount: 599.55, paidOn: new Date(Date.UTC(2025, index + 1, 1)) })), loan);

  const young = holdingReturn({ ...base, receipts: paid(MIN_RECEIPTS - 1) }, now);
  assert.equal(young.enoughHistory, false);
  assert.equal(young.irrPct, null);
  assert.equal(young.gapPts, null);
  assert.equal(NOT_ENOUGH, "Not enough history");
  assert.equal(young.moneyIn, 60000);
  assert.equal(young.moneyBack, 1199.1);
  assert.equal(young.netGain, -58800.9);

  // Five monthly payments of 599.55 on a 60,000 cost, with the balance still owed held at cost. A month after the last
  // payment nothing is late yet, so the balance is marked at that payment.
  const seasoned = holdingReturn({ ...base, receipts: paid(5) }, now);
  assert.equal(seasoned.enoughHistory, true);
  assert.equal(markDate({ acquiredAt: base.acquiredAt, receipts: paid(5) }, now).toISOString().slice(0, 10), "2025-06-01");
  assert.ok(seasoned.heldAtCost > 59500 && seasoned.heldAtCost < 60000, String(seasoned.heldAtCost));
  assert.ok(seasoned.irrPct != null && seasoned.irrPct > 11 && seasoned.irrPct < 12, String(seasoned.irrPct));
  // The same note silent for four months is marked three months later, and falls behind.
  const stalled = holdingReturn({ ...base, receipts: paid(5) }, utc("2025-10-01"));
  assert.ok(stalled.irrPct != null && stalled.irrPct < seasoned.irrPct! - 3, String(stalled.irrPct));
  assert.ok(seasoned.gapPts != null && Math.abs(seasoned.gapPts - (seasoned.irrPct! - 12)) < 1e-9);
  assert.match(gapLine(seasoned) ?? "", /^\d+\.\d points? (behind|ahead of) the 12\.0% underwritten$/);
  assert.equal(gapLine({ gapPts: -2.04, underwrittenYield: 11 }), "2.0 points behind the 11.0% underwritten");
  assert.equal(gapLine({ gapPts: 1, underwrittenYield: 11 }), "1.0 point ahead of the 11.0% underwritten");

  // A resale settles the record, however few receipts came before it.
  const sold = holdingReturn({ ...base, receipts: paid(1), proceeds: [{ amount: 66000, on: utc("2026-01-01"), listingId: "R" }] }, now);
  assert.equal(sold.enoughHistory, true);
  assert.equal(sold.heldAtCost, 0);
  assert.equal(sold.netGain, 6599.55);
  assert.ok(sold.irrPct != null && sold.irrPct > 10);

  // The book as one: flows pooled, the underwritten yield weighted by cost.
  const total = portfolioReturn([{ ...base, receipts: paid(2) }, { ...base, costBasis: 40000, underwrittenYield: 9, receipts: paid(1) }], now);
  assert.equal(total.moneyIn, 100000);
  assert.equal(total.receiptCount, 3);
  assert.equal(total.enoughHistory, true);
  assert.ok(Math.abs((total.underwrittenYield ?? 0) - 10.8) < 1e-9);
  assert.equal(portfolioReturn([{ ...base, receipts: paid(2) }], now).irrPct, null);
});
