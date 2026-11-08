import assert from "node:assert/strict";
import test from "node:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig, { FRAMED_SOURCE, SITE_SOURCE } from "../next.config";
import {
  announcementEmail,
  announcementHistory,
  announcementRecipients,
  announcementStats,
  confirmSubscriber,
  eachLimited,
  failedKey,
  leaveList,
  newAnnouncementId,
  readDraft,
  recipientHash,
  SEND_CONCURRENCY,
  sendAnnouncement,
  subscribe,
  trackTarget,
  trackToken,
  uniqueCounts,
} from "../lib/announcements";
import { readWidgetOrigins, widgetCsp } from "../lib/broker-widget";
import { prisma } from "../lib/prisma";
import { indexCard, liveCards, loadIndex, readIndexFilters } from "../lib/public-index";
import { isPro } from "../lib/settings";
import { onFreeTrial, paidPro, remindTrials, startFreeTrial, trialMode, trialNoticeKey, trialOffer } from "../lib/trial";
import { GET as clickGet } from "../app/api/announcements/[id]/click/route";
import { GET as openGet } from "../app/api/announcements/[id]/open/route";
import { POST as leaveOneClick } from "../app/announcements/leave/one-click/route";
import { GET as widgetGet, POST as widgetPost } from "../app/embed/intake/[code]/route";

const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "https://desk.upb-growth.test";
// Mail stays in the log, and tokens sign with a test secret.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "EMAIL_FROM", "STRIPE_SECRET_KEY"]) process.env[key] = "";
process.env.AUTH_SECRET = "growth-test-secret-not-for-production-0001";
process.env.NEXT_PUBLIC_APP_URL = ORIGIN;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Fixtures, all tagged g-growth- so nothing seeded or another builder's is touched.

type Role = "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN" | "BROKER";

function makeWorld() {
  const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`.replace(/-/g, "");
  const users: { id: string; email: string }[] = [];
  const listingIds: string[] = [];
  const subscriberEmails: string[] = [];
  const announcementIds: string[] = [];
  const email = (prefix: string) => `g-growth-${prefix}-${tag}@example.org`;
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: { email: email(prefix), name: `Growth ${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra },
    });
    users.push(user);
    return user;
  };
  const listing = async (sellerId: string, data: Record<string, unknown> = {}, loan: Record<string, unknown> = {}) => {
    const made = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId,
        status: "APPROVED",
        approvedAt: new Date(),
        title: `Growth note ${listingIds.length} ${tag}`,
        notes: {
          create: [{
            streetAddress: "1 Hidden St", city: `Growthville${tag}`, state: "WY", zip: "82001", propertyType: "SFR", occupancy: "VACANT",
            lienPosition: "THIRD", upb: 600000, interestRate: 7, monthlyPi: 4000, paymentStatus: "SUB_PERFORMING", monthsDelinquent: 2,
            askingPrice: 410000, estimatedValue: 900000, ...loan,
          }] as never,
        },
        ...data,
      },
    });
    listingIds.push(made.id);
    return made;
  };
  return { tag, users, listingIds, subscriberEmails, announcementIds, email, person, listing };
}

type World = ReturnType<typeof makeWorld>;

async function cleanWorld(world: World) {
  const userIds = world.users.map((user) => user.id);
  const emails = [...world.users.map((user) => user.email), ...world.subscriberEmails];
  await prisma.emailEvent.deleteMany({ where: { announcementId: { in: world.announcementIds } } });
  await prisma.announcement.deleteMany({ where: { id: { in: world.announcementIds } } });
  await prisma.subscriber.deleteMany({ where: { email: { in: world.subscriberEmails } } });
  await prisma.sellerLead.deleteMany({ where: { OR: [{ brokerId: { in: userIds } }, { email: { in: emails } }] } });
  await prisma.counter.deleteMany({ where: { OR: [...userIds.map((id) => ({ id: { contains: `:${id}:` } })), { id: { in: world.announcementIds.map(failedKey) } }] } });
  await prisma.rateWindow.deleteMany({ where: { OR: [{ key: { contains: world.tag } }, ...userIds.map((id) => ({ key: { contains: id } }))] } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...world.listingIds, ...userIds, ...world.announcementIds] } }, { actorId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { toEmail: { in: emails } } });
  await prisma.note.deleteMany({ where: { listingId: { in: world.listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: world.listingIds } } });
  await prisma.brokerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// Collects what the log transport printed, so a test sees who was mailed without sending anything.
async function capture<T>(run: () => Promise<T>) {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const value = await run();
    return { value, lines };
  } finally {
    console.info = original;
  }
}

const mailedTo = (lines: string[]) => lines.map((line) => /^\[upb-mail\] to=(\S+)/.exec(line)?.[1]).filter((value): value is string => Boolean(value));
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

// ---------------------------------------------------------------------------------------------------------------
// The subscriber list

test("a subscriber joins only after confirming, leaves with one click, and must confirm again to come back", async () => {
  const world = makeWorld();
  try {
    const address = world.email("sub");
    world.subscriberEmails.push(address);
    const joined = await capture(() => subscribe({ email: address.toUpperCase(), name: "Sub" }));
    assert.equal(joined.value.error, null);
    assert.deepEqual(mailedTo(joined.lines), [address]);
    const row = await prisma.subscriber.findUniqueOrThrow({ where: { email: address } });
    assert.equal(row.confirmedAt, null);
    assert.ok(joined.lines.join("\n").includes(`${ORIGIN}/announcements/confirm?token=${row.token}`));
    assert.deepEqual(await announcementRecipients({ emails: [address] }), [], "unconfirmed is not on the list");

    assert.equal(await confirmSubscriber("not-a-real-token-at-all-000000"), false);
    assert.equal(await confirmSubscriber(row.token), true);
    assert.deepEqual((await announcementRecipients({ emails: [address] })).map((recipient) => recipient.email), [address]);
    // A confirmed address signing up again gets no second email.
    assert.deepEqual(mailedTo((await capture(() => subscribe({ email: address }))).lines), []);
    assert.equal((await subscribe({ email: "not an email" })).error, "Enter a valid email address.");

    const response = await leaveOneClick(new Request(`${ORIGIN}/announcements/leave/one-click?token=${row.token}`, { method: "POST", headers: { "x-forwarded-for": `ip-${world.tag}` } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await announcementRecipients({ emails: [address] }), [], "unsubscribed is off the list");
    assert.equal(await leaveList(row.token), true, "leaving twice is fine");

    const back = await capture(() => subscribe({ email: address }));
    assert.deepEqual(mailedTo(back.lines), [address]);
    assert.deepEqual(await announcementRecipients({ emails: [address] }), [], "coming back waits for a fresh confirmation");
    assert.equal(await confirmSubscriber(row.token), true);
    assert.equal((await announcementRecipients({ emails: [address] })).length, 1);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Announcements: who and what

test("an announcement names only live public listings and reaches only the people still on the list", async () => {
  const world = makeWorld();
  try {
    const desk = await world.person("desk", "ADMIN");
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const member = await world.person("member", "BUYER", { announcements: true });
    const off = await world.person("off", "BUYER", { announcements: false });
    const quiet = await world.person("quiet", "BUYER", { announcements: true, notifyEmail: false });
    const open = await world.listing(seller.id);
    const hidden = await world.listing(seller.id, { visibility: "PRIVATE" });
    const soon = await world.listing(seller.id, { launchAt: new Date(Date.now() + 5 * DAY) });

    const confirmed = world.email("confirmed");
    const gone = world.email("gone");
    const pending = world.email("pending");
    world.subscriberEmails.push(confirmed, gone, pending, off.email);
    await prisma.subscriber.create({ data: { email: confirmed, token: `tok-confirmed-${world.tag}-00000000`, confirmedAt: new Date() } });
    await prisma.subscriber.create({ data: { email: gone, token: `tok-gone-${world.tag}-0000000000000`, confirmedAt: new Date(), unsubscribedAt: new Date() } });
    await prisma.subscriber.create({ data: { email: pending, token: `tok-pending-${world.tag}-0000000000` } });
    // A member who turned the list off is not mailed through an old subscriber row either.
    await prisma.subscriber.create({ data: { email: off.email, token: `tok-off-${world.tag}-00000000000000`, confirmedAt: new Date() } });

    const scope = { emails: [member.email, off.email, quiet.email, confirmed, gone, pending] };
    const recipients = await announcementRecipients(scope);
    assert.deepEqual(recipients.map((recipient) => `${recipient.kind}:${recipient.email}`).sort(), [`member:${member.email}`, `subscriber:${confirmed}`].sort());

    const cards = await liveCards([open.id, hidden.id, soon.id]);
    assert.deepEqual(cards.map((card) => card.id), [open.id]);

    const draft = readDraft({ subject: "Three new notes", body: "New on the desk this week.", listingIds: [open.id, hidden.id] }).draft!;
    const privateId = newAnnouncementId();
    const refused = await sendAnnouncement({ id: privateId, draft, sentById: desk.id, scope });
    assert.equal(refused.error, "A listing you picked is no longer live and public. Pick again.");
    assert.equal(await prisma.announcement.count({ where: { id: privateId } }), 0);
    const pendingDraft = readDraft({ subject: "Coming soon", body: "Soon.", listingIds: [soon.id] }).draft!;
    assert.ok((await sendAnnouncement({ id: newAnnouncementId(), draft: pendingDraft, sentById: desk.id, scope })).error);

    const id = newAnnouncementId();
    world.announcementIds.push(id);
    const good = readDraft({ subject: "New this week", body: "One new note.", listingIds: [open.id], linkEvents: true }).draft!;
    const sent = await capture(() => sendAnnouncement({ id, draft: good, sentById: desk.id, scope }));
    assert.equal(sent.value.error, null);
    assert.deepEqual(mailedTo(sent.lines).sort(), [member.email, confirmed].sort());
    const text = sent.lines.join("\n");
    assert.ok(!text.includes("1 Hidden St") && !text.includes("410,000") && !text.includes("410000"), "no street or price in the announcement");
    assert.ok(text.includes(`/api/announcements/${id}/click?to=${encodeURIComponent(`/open/${open.id}`)}`));
    assert.ok(!text.includes(hidden.id) && !text.includes(soon.id));
    assert.equal((await prisma.announcement.findUniqueOrThrow({ where: { id } })).recipients, 2);
    // A second press of Send with the same id sends nothing.
    const again = await capture(() => sendAnnouncement({ id, draft: good, sentById: desk.id, scope }));
    assert.equal(again.value.error === null && again.value.already, true);
    assert.deepEqual(mailedTo(again.lines), []);

    // Each email carries its own way out, as a link and as the one-click headers, and the open pixel.
    const forMember = announcementEmail({ id, subject: good.subject, body: good.body, cards, linkEvents: false, recipient: recipients.find((r) => r.kind === "member")!, origin: ORIGIN });
    assert.match(forMember.headers["List-Unsubscribe"], /\/unsubscribe\/one-click\?token=/);
    assert.match(forMember.html ?? "", new RegExp(`/api/announcements/${id}/open\\?t=`));
    const forSubscriber = announcementEmail({ id, subject: good.subject, body: good.body, cards, linkEvents: false, recipient: recipients.find((r) => r.kind === "subscriber")!, origin: ORIGIN });
    assert.match(forSubscriber.headers["List-Unsubscribe"], /\/announcements\/leave\/one-click\?token=tok-confirmed-/);
    assert.equal(forSubscriber.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(forSubscriber.text, /To stop deal announcements, open .*\/announcements\/leave\?token=/);
  } finally {
    await cleanWorld(world);
  }
});

test("a send runs a few at a time, and one failed reader neither stops the rest nor counts as sent", async () => {
  const world = makeWorld();
  try {
    const desk = await world.person("desk", "ADMIN");
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const listing = await world.listing(seller.id);
    const readers = [];
    for (let index = 0; index < 20; index += 1) readers.push(await world.person(`reader${index}`, "BUYER", { announcements: true }));
    const refuses = readers[3].email;
    const throws = readers[11].email;
    let inFlight = 0;
    let peak = 0;
    const reached: string[] = [];
    const send = async (toEmail: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (toEmail === throws) throw new Error("Resend 500: provider down");
      if (toEmail === refuses) return false;
      reached.push(toEmail);
      return true;
    };
    const id = newAnnouncementId();
    world.announcementIds.push(id);
    const draft = readDraft({ subject: "Batch send", body: "Twenty readers.", listingIds: [listing.id] }).draft!;
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    let result;
    try {
      result = await sendAnnouncement({ id, draft, sentById: desk.id, scope: { emails: readers.map((reader) => reader.email) }, send });
    } finally {
      console.error = original;
    }
    assert.equal(result.error, null);
    assert.equal(result.error === null && result.sent, 18);
    assert.equal(result.error === null && result.failed, 2);
    assert.equal(reached.length, 18);
    assert.ok(!reached.includes(refuses) && !reached.includes(throws));
    assert.ok(peak > 1 && peak <= SEND_CONCURRENCY, `peak ${peak}`);
    assert.ok(errors.some((line) => line.includes("provider down")) && !errors.some((line) => line.includes("@")), "the log names no address");
    assert.equal((await prisma.announcement.findUniqueOrThrow({ where: { id } })).recipients, 18);
    assert.equal((await prisma.counter.findUniqueOrThrow({ where: { id: failedKey(id) } })).value, 2);
    const row = (await announcementHistory(200)).find((item) => item.id === id)!;
    assert.equal(row.recipients, 18);
    assert.equal(row.failed, 2);

    // The pool itself: every item once, never more than the limit at a time.
    const seen: number[] = [];
    let live = 0;
    let most = 0;
    await eachLimited([...Array(30).keys()], 4, async (item) => {
      live += 1;
      most = Math.max(most, live);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(item);
      live -= 1;
    });
    assert.deepEqual([...seen].sort((a, b) => a - b), [...Array(30).keys()]);
    assert.equal(most, 4);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Tracking

test("opens and clicks count each reader once per kind, keyed by a hash, and a forged token counts nothing", async () => {
  const world = makeWorld();
  try {
    const desk = await world.person("desk", "ADMIN");
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const listing = await world.listing(seller.id);
    const id = newAnnouncementId();
    const other = newAnnouncementId();
    world.announcementIds.push(id, other);
    await prisma.announcement.create({ data: { id, subject: "Track", body: "Body", listingIds: [listing.id], sentById: desk.id, recipients: 2 } });
    await prisma.announcement.create({ data: { id: other, subject: "Other", body: "Body", listingIds: [listing.id], sentById: desk.id, recipients: 1 } });
    const first = recipientHash(world.email("reader1"));
    const second = recipientHash(world.email("reader2"));
    assert.ok(!first.includes("@") && first.length === 43);

    const open = (announcementId: string, token: string | null) =>
      openGet(new Request(`${ORIGIN}/api/announcements/${announcementId}/open?t=${token ?? ""}`), ctx({ id: announcementId }));
    const click = (announcementId: string, token: string | null, to: string) =>
      clickGet(new Request(`${ORIGIN}/api/announcements/${announcementId}/click?to=${encodeURIComponent(to)}&t=${token ?? ""}`), ctx({ id: announcementId }));

    const pixel = await open(id, trackToken(id, first, "OPEN"));
    assert.equal(pixel.headers.get("content-type"), "image/gif");
    await open(id, trackToken(id, first, "OPEN"));
    await open(id, trackToken(id, second, "OPEN"));
    const target = `/open/${listing.id}`;
    const followed = await click(id, trackToken(id, first, "CLICK", target), target);
    assert.equal(followed.status, 302);
    assert.equal(followed.headers.get("location"), `${ORIGIN}${target}`);
    await click(id, trackToken(id, first, "CLICK", target), target);
    await click(id, trackToken(id, first, "CLICK", "/open"), "/open");

    // Forged: a made-up reader with a bad signature, a token from another announcement, a link token on another target.
    await open(id, `${recipientHash("nobody@example.org")}.forged-signature`);
    await open(id, trackToken(other, first, "OPEN"));
    await click(id, trackToken(id, second, "CLICK", "/events"), target);
    await open(other, null);

    const stats = await announcementStats([id, other]);
    assert.deepEqual(stats.get(id), { opens: 2, clicks: 1 });
    assert.deepEqual(stats.get(other), { opens: 0, clicks: 0 });
    const rows = await prisma.emailEvent.findMany({ where: { announcementId: id } });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => !row.recipient.includes("@") && !row.recipient.includes("example")), "no address is stored");
    assert.deepEqual(uniqueCounts([{ recipient: "a", kind: "OPEN" }, { recipient: "a", kind: "OPEN" }, { recipient: "a", kind: "CLICK" }, { recipient: "b", kind: "OPEN" }]), { opens: 2, clicks: 1 });
  } finally {
    await cleanWorld(world);
  }
});

test("the click route never sends a reader to another site", async () => {
  const world = makeWorld();
  try {
    const desk = await world.person("desk", "ADMIN");
    const id = newAnnouncementId();
    world.announcementIds.push(id);
    await prisma.announcement.create({ data: { id, subject: "Redirect", body: "Body", listingIds: [], sentById: desk.id, recipients: 1 } });
    const reader = recipientHash(world.email("reader"));
    for (const outside of ["https://evil.example.com/open/x", "//evil.example.com", "/\\evil.example.com", "/open/../admin", "/open/x?next=https://evil.example.com", "javascript:alert(1)", "/admin/settings", ""]) {
      assert.equal(trackTarget(outside), null, outside);
      const token = trackToken(id, reader, "CLICK", outside);
      const response = await clickGet(new Request(`${ORIGIN}/api/announcements/${id}/click?to=${encodeURIComponent(outside)}&t=${token}`), ctx({ id }));
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `${ORIGIN}/open`, outside);
    }
    assert.equal(await prisma.emailEvent.count({ where: { announcementId: id } }), 0);
    assert.equal(trackTarget("/events"), "/events");
    assert.equal(trackTarget("/open"), "/open");
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The Pro trial

test("a trial runs once per account, gives Pro until its end, reminds twice and never charges", async () => {
  const world = makeWorld();
  try {
    assert.equal(trialMode({}), "free");
    assert.equal(trialMode({ STRIPE_SECRET_KEY: "sk_test_x" }), "card");
    const buyer = await world.person("trial", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "INCOMPLETE" });
    const lapsed = await world.person("lapsed", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" });
    const charged = await world.person("charged", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "INCOMPLETE" });
    const seller = await world.person("noseat", "INDIVIDUAL_SELLER");
    await prisma.revenueEvent.create({ data: { type: "SUBSCRIPTION", amountCents: 100, userId: charged.id, mock: true, description: `g-growth ${world.tag}`, externalId: `g-growth-${world.tag}` } });

    assert.equal((await startFreeTrial(buyer.id, new Date(), 0)).error, "The desk isn't offering a trial.");
    assert.equal((await startFreeTrial(lapsed.id, new Date(), 14)).error, "Trials are for accounts that have never had Pro.");
    assert.equal((await startFreeTrial(charged.id, new Date(), 14)).error, "Trials are for accounts that have never had Pro.");
    assert.equal((await startFreeTrial(seller.id, new Date(), 14)).error, "Trials are for approved buyer accounts.");

    const start = new Date();
    const started = await startFreeTrial(buyer.id, start, 14);
    assert.equal(started.error, null);
    assert.equal((await startFreeTrial(buyer.id, start, 14)).error, "This account has had its trial.");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    assert.equal(row.trialEndsAt?.getTime(), start.getTime() + 14 * DAY);
    assert.equal(row.subscriptionTier, "FREE", "the trial never changes the plan");
    assert.equal((await trialOffer(row, 14)).problem, "This account has had its trial.");

    const during = new Date(start.getTime() + 13 * DAY);
    const after = new Date(start.getTime() + 15 * DAY);
    assert.equal(isPro(row, during, true), true);
    assert.equal(isPro(row, during, false), true);
    assert.equal(onFreeTrial(row, during), true);
    assert.equal(paidPro(row, during), false);
    assert.equal(isPro(row, after, true), false);
    assert.equal(isPro(row, after, false), false, "a trial ends on the demo desk too");

    const scope = { userIds: [buyer.id] };
    assert.equal((await remindTrials(new Date(start.getTime() + 5 * DAY), scope)).sent, 0, "too early");
    assert.equal((await remindTrials(new Date(start.getTime() + 12 * DAY), scope)).sent, 1);
    assert.equal((await remindTrials(new Date(start.getTime() + 12.5 * DAY), scope)).sent, 0, "the early notice goes once");
    assert.equal((await remindTrials(after, scope)).sent, 1);
    assert.equal((await remindTrials(new Date(after.getTime() + DAY), scope)).sent, 0, "the end notice goes once");
    const notices = await prisma.notification.findMany({ where: { toEmail: buyer.email }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(notices.map((notice) => notice.subject.startsWith("Your Pro trial ends") || notice.subject === "Your Pro trial has ended"), [true, true]);
    assert.match(notices[1].body, /nothing was charged/);
    assert.equal(await prisma.revenueEvent.count({ where: { userId: buyer.id } }), 0, "nothing was charged");
    assert.ok(await prisma.counter.findUnique({ where: { id: trialNoticeKey(buyer.id, row.trialEndsAt!, true) } }));
  } finally {
    await prisma.revenueEvent.deleteMany({ where: { externalId: `g-growth-${world.tag}` } });
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The public index

test("the public index lists live public listings only, with only what the public page shows", async () => {
  const world = makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const live = await world.listing(seller.id);
    const hidden = await world.listing(seller.id, { visibility: "PRIVATE" });
    const soon = await world.listing(seller.id, { launchAt: new Date(Date.now() + 3 * DAY) });
    const review = await world.listing(seller.id, { status: "UNDER_REVIEW" });
    const launched = await world.listing(seller.id, { launchAt: new Date(Date.now() - DAY) });

    const filters = readIndexFilters({ state: "wy", lien: "THIRD", performance: "SUB_PERFORMING", band: "500k-up" });
    assert.deepEqual(filters, { state: "WY", lien: "THIRD", performance: "SUB_PERFORMING", band: "500k-up", page: 1 });
    const index = await loadIndex(filters);
    const ids = index.cards.map((card) => card.id);
    assert.ok(ids.includes(live.id) && ids.includes(launched.id));
    for (const id of [hidden.id, soon.id, review.id]) assert.ok(!ids.includes(id), id);
    const card = index.cards.find((row) => row.id === live.id)!;
    assert.deepEqual(Object.keys(card).sort(), ["band", "city", "collateral", "id", "kind", "lien", "loans", "performance", "state", "states"]);
    assert.equal(card.band, "$500k and up");
    assert.ok(!JSON.stringify(index).includes("Hidden St") && !JSON.stringify(index).includes("410000"));

    // A band the loan isn't in, or a junk filter, never shows it, and junk reads as no filter.
    assert.ok(!(await loadIndex({ ...filters, band: "under-100k" })).cards.some((row) => row.id === live.id));
    assert.deepEqual(readIndexFilters({ state: "ZZ", lien: "FIFTH", band: "{$gt:1}", page: "-3" }), { state: "", lien: "", performance: "", band: "", page: 1 });
    assert.equal(indexCard({ id: "x", kind: "SINGLE", notes: [] }), null);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The broker widget

test("only the widget path may be framed, only by the broker's https sites, and 'none' everywhere else", async () => {
  const world = makeWorld();
  try {
    assert.deepEqual(readWidgetOrigins("https://www.Broker-Site.example.com/\nhttps://broker.example.org, https://www.broker-site.example.com"), {
      origins: ["https://www.broker-site.example.com", "https://broker.example.org"],
      error: null,
    });
    for (const bad of ["http://broker.example.com", "https://broker.example.com/page", "https://broker.example.com?x=1", "*", "https://*.example.com", "https://a.example.com;script-src", "broker.example.com", "https://user:pw@broker.example.com", "https://localhost"]) {
      assert.ok(readWidgetOrigins(bad).error, bad);
    }
    assert.equal(widgetCsp(["https://a.example.org", "https://b.example.org"]).split("; ").pop(), "frame-ancestors https://a.example.org https://b.example.org");
    assert.equal(widgetCsp([]).split("; ").pop(), "frame-ancestors 'none'");
    assert.equal(widgetCsp(["https://a.example.org 'unsafe-inline'"]).split("; ").pop(), "frame-ancestors 'none'");

    // The site-wide rule covers every path but the one widget page, which gets the rest of the headers without framing.
    const rules = (await nextConfig.headers?.()) ?? [];
    const headersFor = (path: string) => {
      const out: Record<string, string> = {};
      for (const rule of rules) if (getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(path)) for (const header of rule.headers) out[header.key] = header.value;
      return out;
    };
    assert.deepEqual(rules.map((rule) => rule.source), [SITE_SOURCE, FRAMED_SOURCE]);
    for (const path of ["/", "/open", "/open/abc", "/admin/settings", "/announcements", "/embed/intake", "/embed/intake/ABC123/extra", "/embed/intake/ABC123/", "/api/announcements/x/open"]) {
      const headers = headersFor(path);
      assert.equal(headers["Content-Security-Policy"], "frame-ancestors 'none'", path);
      assert.equal(headers["X-Frame-Options"], "DENY", path);
    }
    const framed = headersFor("/embed/intake/ABC123");
    assert.equal(framed["Content-Security-Policy"], undefined);
    assert.equal(framed["X-Frame-Options"], undefined);
    assert.equal(framed["X-Content-Type-Options"], "nosniff");

    // The route itself: the broker's sites when the form is on, 'none' when it is off or the code is unknown.
    const code = `GG${world.tag.toUpperCase()}`.replace(/[^A-Z0-9]/g, "").slice(0, 24);
    const broker = await world.person("broker", "BROKER", { referralCode: code });
    await prisma.brokerProfile.create({ data: { userId: broker.id, company: "Growth Brokerage", widgetEnabled: true, widgetOrigins: ["https://www.broker-site.example.com"] } });
    const on = await widgetGet(new Request(`${ORIGIN}/embed/intake/${code}`), ctx({ code: code.toLowerCase() }));
    assert.equal(on.status, 200);
    assert.match(on.headers.get("content-security-policy") ?? "", /frame-ancestors https:\/\/www\.broker-site\.example\.com$/);
    assert.match(on.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(await on.text(), /Growth Brokerage works with UPB Capital/);
    await prisma.brokerProfile.update({ where: { userId: broker.id }, data: { widgetEnabled: false } });
    const off = await widgetGet(new Request(`${ORIGIN}/embed/intake/${code}`), ctx({ code }));
    assert.equal(off.status, 404);
    assert.match(off.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'$/);
    const unknown = await widgetGet(new Request(`${ORIGIN}/embed/intake/NOSUCHCODE1`), ctx({ code: "NOSUCHCODE1" }));
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'$/);
  } finally {
    await cleanWorld(world);
  }
});

test("a lead from the widget is filed to its broker with the source WIDGET and the indicative range", async () => {
  const world = makeWorld();
  try {
    const code = `GL${world.tag.toUpperCase()}`.replace(/[^A-Z0-9]/g, "").slice(0, 24);
    const broker = await world.person("broker", "BROKER", { referralCode: code });
    await prisma.brokerProfile.create({ data: { userId: broker.id, company: "Lead Brokerage", widgetEnabled: true, widgetOrigins: ["https://leads.example.org"] } });
    const seller = world.email("seller");
    const form = (extra: Record<string, string> = {}) =>
      new URLSearchParams({ name: "Sam Seller", email: seller, phone: "", city: "Tampa", state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: "$150,000", estimatedValue: "240000", interestRate: "7", monthlyPi: "1100", note: "", ...extra });
    const post = (body: URLSearchParams, ip = `ip-${world.tag}`) =>
      widgetPost(new Request(`${ORIGIN}/embed/intake/${code}`, { method: "POST", body, headers: { "x-forwarded-for": ip } }), ctx({ code }));

    const caught = await post(form({ website: "spam.example.com" }));
    assert.equal(caught.status, 400);
    const invalid = await post(form({ upb: "0" }), `ip2-${world.tag}`);
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /UPB and value need to be greater than zero/);
    assert.equal(await prisma.sellerLead.count({ where: { brokerId: broker.id } }), 0);

    const filed = await post(form(), `ip3-${world.tag}`);
    assert.equal(filed.status, 200);
    assert.match(filed.headers.get("content-security-policy") ?? "", /frame-ancestors https:\/\/leads\.example\.org$/);
    const page = await filed.text();
    assert.match(page, /Your indicative range/);
    const lead = await prisma.sellerLead.findFirstOrThrow({ where: { brokerId: broker.id } });
    assert.equal(lead.source, "WIDGET");
    assert.equal(lead.email, seller);
    assert.equal(Number(lead.upb), 150000);
    assert.ok(Number(lead.indicativeLow) > 0 && Number(lead.indicativeHigh) >= Number(lead.indicativeLow));
    assert.ok(page.includes(Number(lead.indicativeLow).toLocaleString("en-US")));
    assert.equal(await prisma.notification.count({ where: { toEmail: broker.email, subject: "A new lead from your intake form" } }), 1);

    // The ninth quote from one network in an hour is refused.
    for (let index = 0; index < 7; index += 1) await post(form({ email: world.email(`more${index}`) }), `ip4-${world.tag}`);
    assert.equal((await post(form({ email: world.email("more8") }), `ip4-${world.tag}`)).status, 200);
    assert.equal((await post(form({ email: world.email("more9") }), `ip4-${world.tag}`)).status, 429);
  } finally {
    await cleanWorld(world);
  }
});
