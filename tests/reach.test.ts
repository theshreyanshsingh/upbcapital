import assert from "node:assert/strict";
import test from "node:test";
import { activityWeek, listingActivity } from "../lib/activity";
import { literal } from "../lib/db-filters";
import { mailParts, notify, sendAlert } from "../lib/email";
import { remindBidDeadlines, sendSearchRoundups, sendSellerReports } from "../lib/jobs";
import { prisma } from "../lib/prisma";
import { cadenceOf, readCadence, roundupBody, sendSearchRoundup } from "../lib/search-alerts";
import { reportSection, sendSellerReport } from "../lib/seller-report";
import { applyUnsubscribe, readUnsubscribeToken, unsubscribeLinks, unsubscribeToken } from "../lib/unsubscribe";
import { watchNewFiles, watchReprice } from "../lib/watchers";
import { GET as oneClickGet, POST as oneClickPost } from "../app/unsubscribe/one-click/route";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Desk and buyer notices stay in the log, whatever keys the local .env carries. Tokens sign with a test secret.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "EMAIL_FROM"]) process.env[key] = "";
process.env.AUTH_SECRET = "reach-test-secret-not-for-production-0001";
process.env.NEXT_PUBLIC_APP_URL = "https://desk.upb-reach.test";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and listings nothing seeded touches.

type Role = "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BUYER" | "ADMIN" | "BROKER";

async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string; email: string }[] = [];
  const listingIds: string[] = [];
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: { email: `reach-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra },
    });
    users.push(user);
    return user;
  };
  const listing = async (sellerId: string, data: Record<string, unknown> = {}, city = `Reachville${tag}`) => {
    const made = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId,
        status: "APPROVED",
        approvedAt: new Date(Date.now() - 10 * DAY),
        title: `Reach note ${listingIds.length} ${tag}`,
        notes: {
          create: [{
            streetAddress: "1 First St", city, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
            lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "NON_PERFORMING", monthsDelinquent: 9,
            askingPrice: 120000, estimatedValue: 260000,
          }] as never,
        },
        ...data,
      },
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
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.favorite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingView.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.document.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.savedSearch.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: world.users.map((user) => user.email) } }, { subject: { contains: literal(world.tag) } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const inbox = (email: string, subject: string) => prisma.notification.count({ where: { toEmail: email, subject: { contains: literal(subject) } } });

// ---------------------------------------------------------------------------------------------------------------
// Watchers

test("a reprice tells each watcher once, and never the seller, a non-buyer, an unapproved buyer or one who opted out", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const watcher = await world.person("watcher", "BUYER");
    const quiet = await world.person("quiet", "BUYER", { watchAlerts: false });
    const pending = await world.person("pending", "BUYER", { accountStatus: "PENDING" });
    const broker = await world.person("broker", "BROKER");
    const bystander = await world.person("bystander", "BUYER");
    const listing = await world.listing(seller.id);
    for (const user of [seller, watcher, quiet, pending, broker]) await prisma.favorite.create({ data: { userId: user.id, listingId: listing.id } });

    const subject = `New price · ${listing.title}`;
    assert.equal(await watchReprice({ listingId: listing.id, before: 120000, after: 110000, loans: 1, actorId: seller.id }), 1);
    assert.equal(await inbox(watcher.email, subject), 1);
    for (const user of [seller, quiet, pending, broker, bystander]) assert.equal(await inbox(user.email, subject), 0, user.email);
    const notice = await prisma.notification.findFirstOrThrow({ where: { toEmail: watcher.email, subject } });
    assert.match(notice.body, /a listing you saved, has a new price\. The ask moved down from \$120,000 to \$110,000\./);
    assert.match(notice.body, new RegExp(`/marketplace/${listing.id}`));
    // The in-app copy carries no unsubscribe link; the email does.
    assert.doesNotMatch(notice.body, /unsubscribe/);

    // A save at the same price, or on a listing that isn't live, tells nobody.
    assert.equal(await watchReprice({ listingId: listing.id, before: 110000, after: 110000, loans: 1, actorId: seller.id }), 0);
    // Whoever made the change doesn't hear of it.
    assert.equal(await watchReprice({ listingId: listing.id, before: 110000, after: 115000, loans: 1, actorId: watcher.id }), 0);
    await prisma.listing.update({ where: { id: listing.id }, data: { status: "UNDER_REVIEW" } });
    assert.equal(await watchReprice({ listingId: listing.id, before: 110000, after: 100000, loans: 1, actorId: seller.id }), 0);
    assert.equal(await inbox(watcher.email, subject), 1);

    // New files name the kind of file, never the file.
    await prisma.listing.update({ where: { id: listing.id }, data: { status: "APPROVED" } });
    assert.equal(await watchNewFiles({ listingId: listing.id, types: ["OE_REPORT"], actorId: null }), 1);
    const files = await prisma.notification.findFirstOrThrow({ where: { toEmail: watcher.email, subject: `New files · ${listing.title}` } });
    assert.match(files.body, /A new file is in the data room: O&E report\./);

    // Turning the setting off stops them.
    await prisma.user.update({ where: { id: watcher.id }, data: { watchAlerts: false } });
    assert.equal(await watchReprice({ listingId: listing.id, before: 120000, after: 100000, loans: 1, actorId: seller.id }), 0);
    assert.equal(await inbox(watcher.email, subject), 1);
  } finally {
    await cleanWorld(world);
  }
});

test("watchers hear the bid deadline once, and a buyer who bid hears only the bidder notice", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const watcher = await world.person("watcher", "BUYER");
    const bidder = await world.person("bidder", "BUYER");
    const now = new Date();
    const deadline = new Date(now.getTime() + 12 * HOUR);
    const listing = await world.listing(seller.id, { bidMode: "SEALED", bidDeadline: deadline });
    // A listing whose bidders were reminded before watchers were: its watchers still hear, once.
    const earlier = await world.listing(seller.id, { bidMode: "SEALED", bidDeadline: deadline, bidReminderAt: new Date(now.getTime() - HOUR) });
    for (const id of [listing.id, earlier.id]) {
      await prisma.favorite.create({ data: { userId: watcher.id, listingId: id } });
      await prisma.favorite.create({ data: { userId: bidder.id, listingId: id } });
    }
    await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: bidder.id, type: "OFFER", status: "OPEN", amount: 90000 } });

    const scope = { listingIds: [listing.id, earlier.id] };
    // Two overlapping runs, as a double cron delivery would make.
    const runs = await Promise.all([remindBidDeadlines(now, scope), remindBidDeadlines(now, scope)]);
    assert.equal(runs.reduce((sum, run) => sum + run.failed, 0), 0);
    assert.equal(await inbox(watcher.email, `Bid deadline · ${listing.title}`), 1);
    assert.equal(await inbox(watcher.email, `Bid deadline · ${earlier.title}`), 1);
    assert.equal(await inbox(bidder.email, `Bid deadline · ${listing.title}`), 1);
    // The bidder on the first listing is only a watcher on the second.
    assert.equal(await inbox(bidder.email, `Bid deadline · ${earlier.title}`), 1);
    assert.equal(await inbox(seller.email, `Bid deadline · ${listing.title}`), 1);
    assert.equal(await inbox(seller.email, `Bid deadline · ${earlier.title}`), 0);
    const told = await prisma.notification.findFirstOrThrow({ where: { toEmail: watcher.email, subject: `Bid deadline · ${listing.title}` } });
    assert.match(told.body, /a listing you saved, close at/);
    assert.doesNotMatch(told.body, /90,000|bidder/);
    assert.ok((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).watchReminderAt);

    // A later run tells nobody again.
    const again = await remindBidDeadlines(new Date(now.getTime() + HOUR), scope);
    assert.equal(again.sent, 0);
    assert.equal(await inbox(watcher.email, `Bid deadline · ${listing.title}`), 1);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Saved-search roundups

test("a daily roundup goes once a day and lists only listings approved since the last one", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const pro = await world.person("pro", "BUYER", { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" });
    const free = await world.person("free", "BUYER");
    const now = new Date();
    const city = `Reachville${world.tag}`;
    const old = await world.listing(seller.id, { approvedAt: new Date(now.getTime() - 30 * HOUR) });
    const fresh = await world.listing(seller.id, { approvedAt: new Date(now.getTime() - 2 * HOUR) });
    const elsewhere = await world.listing(seller.id, { approvedAt: new Date(now.getTime() - 2 * HOUR) }, `Otherton${world.tag}`);
    const held = await world.listing(seller.id, { status: "UNDER_REVIEW", approvedAt: null });
    const search = await prisma.savedSearch.create({
      data: { userId: pro.id, name: `Reach ${world.tag}`, filters: { q: city }, cadence: "DAILY", lastAlertAt: new Date(now.getTime() - 25 * HOUR), createdAt: new Date(now.getTime() - 10 * DAY) },
      include: { user: true },
    });
    const freeSearch = await prisma.savedSearch.create({ data: { userId: free.id, name: `Free ${world.tag}`, filters: { q: city }, cadence: "DAILY" }, include: { user: true } });
    assert.equal(cadenceOf(search), "DAILY");
    assert.equal(cadenceOf({ cadence: null }), "INSTANT");
    assert.equal(readCadence("weekly"), "WEEKLY");
    assert.equal(readCadence("hourly"), null);

    const subject = `Daily roundup · ${search.name}`;
    const sent = await Promise.all([sendSearchRoundup(search, now), sendSearchRoundup(search, now)]);
    assert.equal(sent.filter(Boolean).length, 1);
    assert.equal(await inbox(pro.email, subject), 1);
    const roundup = await prisma.notification.findFirstOrThrow({ where: { toEmail: pro.email, subject } });
    assert.match(roundup.body, /^1 listing went live since your last roundup and matches your saved search/);
    assert.ok(roundup.body.includes(fresh.title));
    for (const skipped of [old, elsewhere, held]) assert.ok(!roundup.body.includes(skipped.title), skipped.title);
    // The Pro rule holds for roundups too.
    assert.equal(await sendSearchRoundup(freeSearch, now), false);
    assert.equal(await inbox(free.email, "roundup"), 0);

    // Not due again within the day.
    const after = await prisma.savedSearch.findUniqueOrThrow({ where: { id: search.id }, include: { user: true } });
    assert.equal(after.lastAlertAt?.getTime(), now.getTime());
    assert.equal(await sendSearchRoundup(after, new Date(now.getTime() + HOUR)), false);

    // The next day's run starts a little early and lists only what went live since.
    const next = await world.listing(seller.id, { approvedAt: new Date(now.getTime() + 3 * HOUR) });
    const tally = await sendSearchRoundups(new Date(now.getTime() + DAY - 30 * 60 * 1000), { userIds: [pro.id, free.id] });
    assert.deepEqual(tally, { sent: 1, failed: 0, error: "" });
    const second = await prisma.notification.findFirstOrThrow({ where: { toEmail: pro.email, subject, NOT: { id: roundup.id } } });
    assert.ok(second.body.includes(next.title));
    assert.ok(!second.body.includes(fresh.title));
    assert.equal(await inbox(pro.email, subject), 2);

    // A long list stops at twenty lines and points at the book.
    const many = Array.from({ length: 23 }, (_, index) => ({ id: `id${index}`, title: `Listing ${index}` }));
    assert.match(roundupBody("Big", many, "https://x"), /And 3 more on the book: https:\/\/x\/marketplace$/);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The weekly seller report

test("the weekly seller report counts the week against the one before, names nobody, and goes once a week", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await world.person("buyer", "BUYER");
    const other = await world.person("other", "BUYER");
    const quiet = await world.person("quiet", "INSTITUTIONAL_SELLER", { sellerReport: false });
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const listing = await world.listing(seller.id, { approvedAt: ago(12 * DAY) });
    await world.listing(quiet.id);
    // Three buyer opens this week and one the week before. The seller's own open doesn't count.
    for (const at of [ago(HOUR), ago(2 * DAY), ago(3 * DAY), ago(9 * DAY)]) await prisma.listingView.create({ data: { listingId: listing.id, userId: buyer.id, createdAt: at } });
    await prisma.listingView.create({ data: { listingId: listing.id, userId: seller.id, createdAt: ago(HOUR) } });
    await prisma.favorite.create({ data: { userId: buyer.id, listingId: listing.id, createdAt: ago(DAY) } });
    await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId: listing.id, acknowledgedAt: ago(DAY), signerName: buyer.name } });
    for (const at of [ago(DAY), ago(2 * DAY)]) await prisma.auditEvent.create({ data: { actorId: buyer.id, action: "DOCUMENT_DOWNLOAD", entityType: "document", entityId: listing.id, createdAt: at } });
    await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: other.id, type: "INFO_REQUEST", message: "Pay history?", createdAt: ago(DAY) } });
    await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: other.id, type: "OFFER", status: "OPEN", amount: 99999, createdAt: ago(10 * DAY) } });

    const week = activityWeek(await listingActivity(listing.id, seller.id, now), now);
    assert.deepEqual(week.views, { total: 4, week: 3, prior: 1 });
    assert.deepEqual(week.saves, { total: 1, week: 1, prior: 0 });
    assert.deepEqual(week.ndas, { total: 1, week: 1, prior: 0 });
    assert.deepEqual(week.downloads, { total: 2, week: 2, prior: 0 });
    assert.deepEqual(week.questions, { total: 1, week: 1, prior: 0 });
    assert.deepEqual(week.bids, { total: 1, week: 0, prior: 1 });
    const section = reportSection(listing, week, "https://x/seller/listings/1", now);
    assert.match(section, /· live 12 days\n/);
    assert.match(section, /Opens: 3 this week, up 2 on the week before\. 4 in all\./);
    assert.match(section, /Bids: 0 this week, down 1 on the week before\. 1 in all\./);
    assert.match(section, /Saves: 1 this week, up 1 on the week before\. 1 in all\./);

    // One report, though two runs overlap. The seller who turned it off gets none.
    const tally = await sendSellerReports(now, { userIds: [seller.id, quiet.id] });
    assert.deepEqual(tally, { sent: 1, failed: 0, error: "" });
    const raced = await sendSellerReport({ ...seller, sellerReport: null, lastSellerReportAt: null }, now);
    assert.equal(raced, false);
    assert.equal(await inbox(seller.email, "Weekly report"), 1);
    assert.equal(await inbox(quiet.email, "Weekly report"), 0);
    const report = await prisma.notification.findFirstOrThrow({ where: { toEmail: seller.email, subject: { contains: "Weekly report" } } });
    assert.ok(report.body.includes(listing.title));
    for (const secret of ["99,999", "99999", buyer.name, other.name, buyer.email]) assert.ok(!report.body.includes(secret), secret);

    // Not again within the week; the next week's run sends the next one.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: seller.id } });
    assert.equal(after.lastSellerReportAt?.getTime(), now.getTime());
    assert.equal(await sendSellerReport(after, new Date(now.getTime() + 3 * DAY)), false);
    assert.equal(await sendSellerReport(after, new Date(now.getTime() + 7 * DAY - HOUR)), true);
    assert.equal(await inbox(seller.email, "Weekly report"), 2);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// One-click unsubscribe

test("an unsubscribe token signs and verifies, and a changed one is refused", () => {
  const token = unsubscribeToken({ category: "watch", userId: "user123" })!;
  assert.deepEqual(readUnsubscribeToken(token), { userId: "user123", category: "watch", searchId: null });
  const one = unsubscribeToken({ category: "search", userId: "user123", searchId: "search9" })!;
  assert.deepEqual(readUnsubscribeToken(one), { userId: "user123", category: "search", searchId: "search9" });
  assert.deepEqual(readUnsubscribeToken(unsubscribeToken({ category: "search", userId: "user123" })), { userId: "user123", category: "search", searchId: null });

  const [userId, , scope, mac] = token.split(".");
  // Another category, another user, or a changed signature is refused.
  assert.equal(readUnsubscribeToken(`${userId}.deals.${scope}.${mac}`), null);
  assert.equal(readUnsubscribeToken(`user124.watch.${scope}.${mac}`), null);
  assert.equal(readUnsubscribeToken(`${userId}.watch.${scope}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`), null);
  assert.equal(readUnsubscribeToken(`${userId}.everything.${scope}.${mac}`), null);
  for (const junk of ["", "abc", "a.b.c", "a.b.c.d.e", null, undefined]) assert.equal(readUnsubscribeToken(junk), null);
  // A token made with another secret doesn't verify here.
  const secret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "another-secret-entirely-0002";
  const foreign = unsubscribeToken({ category: "watch", userId: "user123" })!;
  process.env.AUTH_SECRET = secret;
  assert.equal(readUnsubscribeToken(foreign), null);
  // Without a secret there is no link, and mail still goes.
  process.env.AUTH_SECRET = "";
  assert.equal(unsubscribeToken({ category: "watch", userId: "user123" }), null);
  assert.equal(readUnsubscribeToken(token), null);
  assert.deepEqual(mailParts("Body.", { category: "watch", userId: "user123" }), { text: "Body.", headers: {} });
  process.env.AUTH_SECRET = secret;

  const links = unsubscribeLinks({ category: "digest", userId: "user123" })!;
  assert.match(links.page, /^https:\/\/desk\.upb-reach\.test\/unsubscribe\?token=user123\.digest\.all\./);
  assert.match(links.oneClick, /^https:\/\/desk\.upb-reach\.test\/unsubscribe\/one-click\?token=/);
});

test("each unsubscribe category turns off its own setting and nothing else", async () => {
  const world = await makeWorld();
  try {
    const user = await world.person("prefs", "BUYER", { watchAlerts: true, dealAlerts: true, marketDispatch: true, sellerReport: true, digest: "WEEKLY" });
    const [first, second] = await Promise.all([1, 2].map((n) => prisma.savedSearch.create({ data: { userId: user.id, name: `S${n} ${world.tag}`, filters: {} } })));
    const read = () => prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const searches = async () => Object.fromEntries((await prisma.savedSearch.findMany({ where: { userId: user.id } })).map((row) => [row.id, row.alertEnabled]));

    await applyUnsubscribe(readUnsubscribeToken(unsubscribeToken({ category: "search", userId: user.id, searchId: first.id }))!);
    assert.deepEqual(await searches(), { [first.id]: false, [second.id]: true });
    await applyUnsubscribe(readUnsubscribeToken(unsubscribeToken({ category: "search", userId: user.id }))!);
    assert.deepEqual(await searches(), { [first.id]: false, [second.id]: false });

    const steps: [Parameters<typeof unsubscribeToken>[0]["category"], (row: Awaited<ReturnType<typeof read>>) => unknown, unknown][] = [
      ["watch", (row) => row.watchAlerts, false],
      ["deals", (row) => row.dealAlerts, false],
      ["dispatch", (row) => row.marketDispatch, false],
      ["report", (row) => row.sellerReport, false],
      ["digest", (row) => row.digest, "OFF"],
    ];
    for (const [index, [category, field, off]] of steps.entries()) {
      await applyUnsubscribe(readUnsubscribeToken(unsubscribeToken({ category, userId: user.id }))!);
      const row = await read();
      assert.equal(field(row), off, category);
      // The ones not yet named are still on.
      for (const [, later] of steps.slice(index + 1)) assert.notEqual(later(row), false, `${category} left the rest`);
    }
    assert.equal(await prisma.auditEvent.count({ where: { entityId: user.id, action: "UNSUBSCRIBE" } }), 7);

    // The one-click route takes the mail client's POST, and opening it in a browser only shows the page.
    await prisma.user.update({ where: { id: user.id }, data: { watchAlerts: true } });
    const url = unsubscribeLinks({ category: "watch", userId: user.id })!.oneClick;
    const opened = await oneClickGet(new Request(url));
    assert.equal(opened.status, 303);
    assert.match(opened.headers.get("location") ?? "", /\/unsubscribe\?token=/);
    assert.equal((await read()).watchAlerts, true);
    const clicked = await oneClickPost(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
    assert.equal(clicked.status, 200);
    assert.equal((await read()).watchAlerts, false);
    const refused = await oneClickPost(new Request(url.replace(/.$/, (last) => (last === "A" ? "B" : "A")), { method: "POST", body: "List-Unsubscribe=One-Click" }));
    assert.equal(refused.status, 400);
  } finally {
    await cleanWorld(world);
  }
});

test("only categorized mail carries the unsubscribe link and the List-Unsubscribe headers", async () => {
  const world = await makeWorld();
  const realFetch = globalThis.fetch;
  const sent: { text: string; headers?: Record<string, string>; subject: string }[] = [];
  try {
    // A deliverable address, sent through a stubbed Resend so nothing leaves the machine.
    const user = await prisma.user.create({
      data: { email: `reach-mail-${world.tag}@upb-reach-mail.com`, name: `Mail ${world.tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" },
    });
    world.users.push(user);
    process.env.RESEND_API_KEY = "re_test_stub";
    process.env.EMAIL_FROM = "UPB Capital <desk@upb-reach-mail.com>";
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await notify(user.email, `Watched ${world.tag}`, "A new price.", { category: "watch", userId: user.id });
    await notify(user.email, `Plain ${world.tag}`, "Your closing moved.");
    await sendAlert(user.email, `Security ${world.tag}`, "Your password changed.");
    // A category naming someone else is dropped, so nobody's link reaches another inbox.
    await notify(user.email, `Misnamed ${world.tag}`, "A digest.", { category: "digest", userId: "someone-else" });
    assert.equal(sent.length, 4);
    const [watched, plain, security, misnamed] = sent;
    assert.match(watched.headers?.["List-Unsubscribe"] ?? "", /^<https:\/\/desk\.upb-reach\.test\/unsubscribe\/one-click\?token=[^>]+>$/);
    assert.equal(watched.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(watched.text, /^A new price\.\n\nTo stop notices about listings you saved, open https:\/\/desk\.upb-reach\.test\/unsubscribe\?token=/);
    const token = decodeURIComponent(/token=([^>\s]+)/.exec(watched.headers!["List-Unsubscribe"])![1]);
    assert.deepEqual(readUnsubscribeToken(token), { userId: user.id, category: "watch", searchId: null });
    for (const mail of [plain, security, misnamed]) {
      assert.equal(mail.headers, undefined, mail.subject);
      assert.doesNotMatch(mail.text, /unsubscribe/, mail.subject);
    }
    // The in-app copy is the body as written.
    const copy = await prisma.notification.findFirstOrThrow({ where: { toEmail: user.email, subject: `Watched ${world.tag}` } });
    assert.equal(copy.body, "A new price.");
  } finally {
    globalThis.fetch = realFetch;
    process.env.RESEND_API_KEY = "";
    process.env.EMAIL_FROM = "";
    await cleanWorld(world);
  }
});
