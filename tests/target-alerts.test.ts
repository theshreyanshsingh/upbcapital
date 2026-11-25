import assert from "node:assert/strict";
import test from "node:test";
import { literal } from "../lib/db-filters";
import { prisma } from "../lib/prisma";
import { checkTargets, clearTarget, currentAsk, dollars, setTarget, targetState } from "../lib/target-alerts";
import { watchReprice } from "../lib/watchers";

// Mail stays in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "EMAIL_FROM"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and listings nothing seeded touches.

type Role = "INDIVIDUAL_SELLER" | "BUYER";

async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string; email: string }[] = [];
  const listingIds: string[] = [];
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const pro = role === "BUYER" ? { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" } : {};
    const user = await prisma.user.create({
      data: { email: `target-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...pro, ...extra } as never,
    });
    users.push(user);
    return user;
  };
  const listing = async (sellerId: string, data: Record<string, unknown> = {}) => {
    const made = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId,
        status: "APPROVED",
        approvedAt: new Date(Date.now() - 10 * DAY),
        title: `Target note ${listingIds.length} ${tag}`,
        notes: {
          create: [{
            streetAddress: "1 Mark St", city: `Targetville${tag}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
            lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
            askingPrice: 120000, estimatedValue: 260000,
          }] as never,
        },
        ...data,
      } as never,
    });
    listingIds.push(made.id);
    return made;
  };
  return { tag, users, listingIds, person, listing };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const userIds = world.users.map((user) => user.id);
  const listingIds = world.listingIds;
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: listingIds } }, { actorId: { in: userIds } }] } });
  await prisma.priceChange.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingInvite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.favorite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: world.users.map((user) => user.email) } }, { subject: { contains: literal(world.tag) } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const inbox = (email: string, title: string) => prisma.notification.count({ where: { toEmail: email, subject: `Price alert · ${title}` } });
const saved = (userId: string, listingId: string) => prisma.favorite.findUniqueOrThrow({ where: { userId_listingId: { userId, listingId } } });

// A reprice as the desk, a seller or a ladder step makes it: the loan's ask moves, then watchReprice runs.
async function reprice(listingId: string, before: number, after: number, actorId: string) {
  await prisma.note.updateMany({ where: { listingId }, data: { askingPrice: after } });
  return watchReprice({ listingId, before, after, loans: 1, actorId });
}

test("the ask is the one the listing page shows, and a target reads its state", () => {
  const loan = (askingPrice: number, tradeStatus: string) => ({ upb: 100000, askingPrice, estimatedValue: 150000, monthlyPi: 700, interestRate: 7, paymentStatus: "PERFORMING", tradeStatus });
  // A live pool prices the loans still for sale; one note is its own ask.
  assert.equal(currentAsk({ kind: "POOL", status: "APPROVED", notes: [loan(60000, "AVAILABLE"), loan(40000, "SOLD"), loan(25000.5, "AVAILABLE")] }), 85000.5);
  assert.equal(currentAsk({ kind: "SINGLE", status: "APPROVED", notes: [loan(120000, "AVAILABLE")] }), 120000);
  assert.equal(dollars(90250), "$90,250");
  assert.equal(dollars(92150.25), "$92,150.25");
  const set = new Date("2026-11-20T12:00:00Z");
  assert.equal(targetState({ targetAsk: null, targetSetAt: null, targetHitAt: null }), null);
  assert.equal(targetState({ targetAsk: 100000, targetSetAt: set, targetHitAt: null }), "We'll tell you at or under $100,000. Set on Nov 20, 2026.");
  assert.equal(targetState({ targetAsk: 100000, targetSetAt: set, targetHitAt: new Date("2026-11-25T12:00:00Z") }), "Your target of $100,000 was hit on Nov 25, 2026.");
});

test("a target needs Pro, a live listing the buyer sees, and a figure under the ask; setting one saves the listing", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await world.person("buyer", "BUYER");
    const free = await world.person("free", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" });
    const listing = await world.listing(seller.id);
    const hidden = await world.listing(seller.id, { visibility: "PRIVATE" });
    const review = await world.listing(seller.id, { status: "UNDER_REVIEW" });
    const error = async (outcome: ReturnType<typeof setTarget>) => ((await outcome) as { error: string }).error;

    assert.match(await error(setTarget(free, listing.id, "100000")), /come with Pro/);
    assert.match(await error(setTarget(buyer, hidden.id, "100000")), /isn't on the book/);
    assert.match(await error(setTarget(buyer, "000000000000000000000000", "100000")), /isn't on the book/);
    assert.match(await error(setTarget(buyer, review.id, "100000")), /live listings/);
    assert.match(await error(setTarget(seller, listing.id, "100000")), /approved buyers/);
    // At or above the ask there is nothing to wait for: the bid form is the way.
    for (const raw of ["120000", "$150,000"]) assert.match(await error(setTarget(buyer, listing.id, raw)), /already \$120,000, at or under that\. To buy at it, use the bid form/);
    for (const raw of ["0", "", "abc", "-5", "$0.001", null]) assert.match(await error(setTarget(buyer, listing.id, raw)), /above \$0/, String(raw));
    assert.equal(await prisma.favorite.count({ where: { listingId: { in: world.listingIds } } }), 0);

    // An unsaved listing is saved with its target.
    const now = new Date();
    const first = await setTarget(buyer, listing.id, "$100,000", now);
    assert.equal(first.ok, true);
    assert.match((first as { message: string }).message, /at or under \$100,000\. The listing is saved to your favorites\./);
    let row = await saved(buyer.id, listing.id);
    assert.equal(row.targetAsk, 100000);
    assert.equal(row.targetSetAt?.getTime(), now.getTime());
    assert.equal(row.targetHitAt ?? null, null);
    assert.equal(await prisma.auditEvent.count({ where: { actorId: buyer.id, action: "PRICE_TARGET_SET", entityId: listing.id } }), 1);

    // A saved listing takes a new target in place, typed as people type figures.
    const again = await setTarget(buyer, listing.id, "95k");
    assert.doesNotMatch((again as { message: string }).message, /saved to your favorites/);
    row = await saved(buyer.id, listing.id);
    assert.equal(row.targetAsk, 95000);
    assert.equal(await prisma.favorite.count({ where: { userId: buyer.id, listingId: listing.id } }), 1);
  } finally {
    await cleanWorld(world);
  }
});

test("a reprice that reaches a target tells its buyer once, and the target stays spent until reset", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await world.person("buyer", "BUYER");
    const lower = await world.person("lower", "BUYER");
    const quiet = await world.person("quiet", "BUYER", { watchAlerts: false });
    const lapsed = await world.person("lapsed", "BUYER");
    const listing = await world.listing(seller.id);
    assert.equal((await setTarget(buyer, listing.id, "100,000")).ok, true);
    assert.equal((await setTarget(lower, listing.id, "90,000")).ok, true);
    assert.equal((await setTarget(quiet, listing.id, "100,000")).ok, true);
    assert.equal((await setTarget(lapsed, listing.id, "100,000")).ok, true);
    // Pro lapsed after the target was set: the ask is no longer theirs to hear.
    await prisma.user.update({ where: { id: lapsed.id }, data: { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" } as never });

    // Above every target: nobody hears.
    await reprice(listing.id, 120000, 110000, seller.id);
    for (const user of [buyer, lower, quiet, lapsed]) assert.equal(await inbox(user.email, listing.title), 0);

    // At the target: its buyer hears once, with the ask and the target and nothing about who moved it.
    await reprice(listing.id, 110000, 100000, seller.id);
    assert.equal(await inbox(buyer.email, listing.title), 1);
    for (const user of [lower, quiet, lapsed]) assert.equal(await inbox(user.email, listing.title), 0, user.email);
    const notice = await prisma.notification.findFirstOrThrow({ where: { toEmail: buyer.email, subject: `Price alert · ${listing.title}` } });
    assert.match(notice.body, new RegExp(`The ask on ${literal(listing.title)} is now \\$100,000, at or under your target of \\$100,000\\.`));
    assert.match(notice.body, new RegExp(`/marketplace/${listing.id}`));
    assert.doesNotMatch(notice.body, /ladder|seller|desk/i);
    assert.ok((await saved(buyer.id, listing.id)).targetHitAt);
    // The alert is that buyer's notice of the new price, so the general "New price" notice for the same reprice leaves
    // them out, while a watcher whose target it didn't reach still gets it.
    const priceNotices = (email: string) => prisma.notification.findMany({ where: { toEmail: email, subject: `New price · ${listing.title}` }, select: { body: true } });
    assert.equal((await priceNotices(buyer.email)).filter((row) => /to \$100,000\./.test(row.body)).length, 0);
    assert.equal((await priceNotices(lower.email)).filter((row) => /to \$100,000\./.test(row.body)).length, 1);
    // The skipped buyers keep their targets as they were.
    for (const user of [quiet, lapsed]) assert.equal((await saved(user.id, listing.id)).targetHitAt ?? null, null);

    // Spent: a lower ask tells nobody again.
    await reprice(listing.id, 100000, 95000, seller.id);
    assert.equal(await inbox(buyer.email, listing.title), 1);
    assert.equal(await inbox(lower.email, listing.title), 0);

    // A new target starts unspent. Two checks at once, as two reprices would make, tell each buyer once.
    assert.equal((await setTarget(buyer, listing.id, "90,000")).ok, true);
    assert.equal((await saved(buyer.id, listing.id)).targetHitAt ?? null, null);
    await prisma.note.updateMany({ where: { listingId: listing.id }, data: { askingPrice: 89000 } });
    const now = new Date();
    const runs = await Promise.all([checkTargets(listing.id, now), checkTargets(listing.id, now)]);
    assert.equal(runs[0] + runs[1], 2);
    assert.equal(await inbox(buyer.email, listing.title), 2);
    assert.equal(await inbox(lower.email, listing.title), 1);
    assert.equal(await checkTargets(listing.id, now), 0);
  } finally {
    await cleanWorld(world);
  }
});

test("a buyer the listing is now hidden from hears nothing, and a target can be cleared", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await world.person("buyer", "BUYER");
    const listing = await world.listing(seller.id);
    assert.equal((await setTarget(buyer, listing.id, "100000")).ok, true);

    // Gone private, without an invitation for this buyer: the reprice reaches the target but tells nobody, and the
    // target waits.
    await prisma.listing.update({ where: { id: listing.id }, data: { visibility: "PRIVATE" } });
    await reprice(listing.id, 120000, 95000, seller.id);
    assert.equal(await inbox(buyer.email, listing.title), 0);
    assert.equal((await saved(buyer.id, listing.id)).targetHitAt ?? null, null);

    // Asked in by name, the buyer sees it again and the next check tells them.
    await prisma.listingInvite.create({ data: { listingId: listing.id, email: buyer.email, userId: buyer.id, token: `target-${world.tag}`, invitedById: seller.id } });
    assert.equal(await checkTargets(listing.id), 1);
    assert.equal(await inbox(buyer.email, listing.title), 1);

    // Clearing drops the target and keeps the save.
    const cleared = await clearTarget(buyer, listing.id);
    assert.equal(cleared.ok, true);
    const row = await saved(buyer.id, listing.id);
    assert.equal(row.targetAsk, null);
    assert.equal(row.targetHitAt, null);
    assert.equal(await prisma.auditEvent.count({ where: { actorId: buyer.id, action: "PRICE_TARGET_CLEARED", entityId: listing.id } }), 1);
    assert.match(((await clearTarget(buyer, listing.id)) as { error: string }).error, /No price alert/);
    assert.match(((await clearTarget(seller, listing.id)) as { error: string }).error, /No price alert/);
  } finally {
    await cleanWorld(world);
  }
});
