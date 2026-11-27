import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  addBuyerChannel,
  addDeskChannel,
  BUYER_MANAGE_DENIED,
  buyerChatMessage,
  changeChannel,
  chatAlertsIdle,
  chatBody,
  chatUrlHint,
  chatUrlProblem,
  deliverChat,
  deskChatMessage,
  MAX_BUYER_CHANNELS,
  PAUSE_AFTER,
  PRICE_ALERT_EVENT,
  sendBuyerChat,
  setChatSender,
  type ChatSender,
} from "../lib/chat-alerts";
import { literal } from "../lib/db-filters";
import { DESK_DENIED } from "../lib/desk-roles";
import { notifyDesk } from "../lib/email";
import { prisma } from "../lib/prisma";
import type { ActingUser } from "../lib/seats";
import { checkTargets } from "../lib/target-alerts";
import { emitBuyerWebhook } from "../lib/webhooks";

// Mail stays in the log, and links are built on a known origin.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "EMAIL_FROM"]) process.env[key] = "";
process.env.NEXT_PUBLIC_APP_URL = "https://upb.example";

const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
// Every channel this file makes is labelled with LABEL, so an earlier run's leftovers can be found and only those.
const LABEL = `chat-test-${tag}`;
const made = { users: [] as string[], emails: [] as string[], listings: [] as string[], channels: [] as string[] };
const SECRET = { borrower: `Borrower Hidden ${tag}`, street: `77 Hidden Ave ${tag}`, rival: `Rival Buyer ${tag}`, amount: 98765 };

const slack = (path: string) => `https://hooks.slack.com/services/T${tag}/B${path}/xyz1`;
const teams = (path: string) => `https://prod-12.westus.logic.azure.com:443/workflows/${tag}${path}/triggers/manual/paths/invoke?api-version=2016-06-01&sig=ab${path}`;

type Sent = { url: string; body: Record<string, unknown>; text: string };

// Stands in for Slack and Teams. It answers with `status` (or throws when it is "throw") and records each post.
function capture(status: number | "throw" = 200, detail = "ok") {
  const sent: Sent[] = [];
  const send: ChatSender = async (url, body) => {
    sent.push({ url, body: JSON.parse(body) as Record<string, unknown>, text: body });
    if (status === "throw") throw new Error("connect ECONNREFUSED");
    return { status, detail };
  };
  return { sent, send };
}

async function person(who: string, role: "BUYER" | "ADMIN" | "INSTITUTIONAL_SELLER", data: Partial<Prisma.UserCreateInput> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `chat-${who}-${tag}@example.org`,
      name: `Chat ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...data,
    },
  });
  made.users.push(user.id);
  made.emails.push(user.email);
  return user;
}

async function channel(data: { ownerId?: string; desk?: boolean; kind?: string; url: string; events: string; pausedAt?: Date }) {
  const row = await prisma.chatChannel.create({
    data: {
      ...(data.ownerId ? { ownerId: data.ownerId } : {}),
      desk: data.desk ?? false,
      kind: data.kind ?? "SLACK",
      url: data.url,
      urlHint: chatUrlHint(data.url),
      label: LABEL,
      events: data.events,
      createdById: data.ownerId ?? "desk",
      ...(data.pausedAt ? { pausedAt: data.pausedAt } : {}),
    },
  });
  made.channels.push(row.id);
  return row;
}

async function listing(sellerId: string, title: string) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      standingBidsNotifiedAt: new Date(),
      title: `${title} ${tag}`,
      summary: "A test listing.",
      notes: {
        create: [{
          streetAddress: SECRET.street, city: "Quietville", state: "XQ", zip: "99877", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000, borrowerName: SECRET.borrower,
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

const leaks = (text: string) => [SECRET.borrower, SECRET.street, SECRET.rival, String(SECRET.amount), "98,765"].filter((secret) => text.includes(secret));

test.before(async () => {
  // Only this file's own leftovers from a run that stopped early.
  await prisma.chatChannel.deleteMany({ where: { label: { startsWith: "chat-test-" }, desk: true } });
});

test.after(async () => {
  setChatSender(null);
  await chatAlertsIdle();
  const channelIds = [...new Set(made.channels)];
  await prisma.chatChannel.deleteMany({ where: { OR: [{ id: { in: channelIds } }, { ownerId: { in: made.users } }, { label: LABEL }] } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: channelIds } }, { actorId: { in: made.users } }] } });
  await prisma.favorite.deleteMany({ where: { listingId: { in: made.listings } } });
  await prisma.priceChange.deleteMany({ where: { listingId: { in: made.listings } } });
  await prisma.note.deleteMany({ where: { listingId: { in: made.listings } } });
  await prisma.listing.deleteMany({ where: { id: { in: made.listings } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.emails } }, { subject: { contains: literal(tag) } }, { body: { contains: literal(tag) } }] } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------

test("only the vendors' own webhook hosts are taken, and the page keeps a hint", () => {
  for (const url of [
    "https://hooks.slack.com/services/T000/B000/XXXXabcd",
    "https://hooks.slack.com/workflows/T000/A000/123/abcd",
    "HTTPS://HOOKS.SLACK.COM/services/T000/B000/XXXX",
  ]) assert.equal(chatUrlProblem("SLACK", url), null, url);
  for (const url of [
    "https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers&sig=abcd",
    "https://default1234abcd.04.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=xyz",
    "https://contoso.webhook.office.com/webhookb2/1111-2222@3333-4444/IncomingWebhook/5555/6666",
  ]) assert.equal(chatUrlProblem("TEAMS", url), null, url);

  const refusedSlack = [
    "https://hooks.slack.com.evil.example/services/T000/B000/XXXX",
    "https://evil.example/services/T000/B000/XXXX",
    "https://evilhooks.slack.com/services/T000/B000/XXXX",
    "https://hooks.slack.com./services/T000/B000/XXXX",
    "http://hooks.slack.com/services/T000/B000/XXXX",
    "https://user:pass@hooks.slack.com/services/T000/B000/XXXX",
    "https://hooks.slack.com@evil.example/services/T000/B000/XXXX",
    "https://hooks.slack.com:8443/services/T000/B000/XXXX",
    "https://hooks.slack.com/api/chat.postMessage",
    "https://hooks.slack.com/services/",
    "https://slack.com/services/T000/B000/XXXX",
    "not a url",
    "",
    `https://hooks.slack.com/services/${"x".repeat(600)}`,
  ];
  for (const url of refusedSlack) assert.ok(chatUrlProblem("SLACK", url), url);
  const refusedTeams = [
    "https://logic.azure.com/workflows/abc",
    "https://evil-logic.azure.com/workflows/abc",
    "https://prod-12.westus.logic.azure.com.evil.example/workflows/abc",
    "https://evilwebhook.office.com/webhookb2/abc",
    "https://webhook.office.com/webhookb2/abc",
    "https://contoso.webhook.office.com.evil.example/webhookb2/abc",
    "https://x.environment.api.powerplatform.com.evil.example/powerautomate/abc",
    "https://contoso.office.com/webhookb2/abc",
    "https://user@contoso.webhook.office.com/webhookb2/abc",
    "http://contoso.webhook.office.com/webhookb2/abc",
    "https://bad_label.webhook.office.com/webhookb2/abc",
  ];
  for (const url of refusedTeams) assert.ok(chatUrlProblem("TEAMS", url), url);
  // Each address goes with its own app, and only Slack or Teams is taken.
  assert.ok(chatUrlProblem("TEAMS", "https://hooks.slack.com/services/T000/B000/XXXX"));
  assert.ok(chatUrlProblem("SLACK", "https://contoso.webhook.office.com/webhookb2/abc"));
  assert.ok(chatUrlProblem("DISCORD", "https://hooks.slack.com/services/T000/B000/XXXX"));
  // No problem repeats the address, since the answer travels in the page's URL.
  assert.ok(!chatUrlProblem("SLACK", "https://evil.example/secret-token")?.includes("secret-token"));

  assert.equal(chatUrlHint("https://hooks.slack.com/services/T000/B000/XXXXabcd"), "hooks.slack.com …abcd");
  assert.equal(chatUrlHint("https://contoso.webhook.office.com/webhookb2/abc/6666"), "contoso.webhook.office.com …6666");
});

test("messages say what the buyer's email says, from named fields only", () => {
  const extra = { borrowerName: SECRET.borrower, streetAddress: SECRET.street, amount: SECRET.amount, buyer: SECRET.rival, bids: [{ amount: SECRET.amount }] };
  const repriced = buyerChatMessage("listing.repriced", { listingId: "lst1", title: "Ohio pool", previousAsk: 120000, ask: 109500, loansRepriced: 1, ...extra });
  const slackText = (chatBody("SLACK", repriced) as { text: string }).text;
  assert.equal(slackText.split("\n")[0], "*New price · Ohio pool*");
  assert.match(slackText, /moved down from \$120,000 to \$109,500/);
  assert.match(slackText, /<https:\/\/upb\.example\/marketplace\/lst1\|Open the listing>$/);

  const card = chatBody("TEAMS", repriced) as { type: string; attachments: { contentType: string; content: { type: string; version: string; body: { type: string; text: string }[]; actions: { type: string; url: string; title: string }[] } }[] };
  assert.equal(card.type, "message");
  assert.equal(card.attachments.length, 1);
  assert.equal(card.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  const content = card.attachments[0].content;
  assert.equal(content.type, "AdaptiveCard");
  assert.equal(content.version, "1.4");
  assert.deepEqual(content.body.map((block) => block.type), ["TextBlock", "TextBlock"]);
  assert.equal(content.body[0].text, "New price · Ohio pool");
  assert.deepEqual(content.actions, [{ type: "Action.OpenUrl", title: "Open the listing", url: "https://upb.example/marketplace/lst1" }]);

  const messages = [
    repriced,
    buyerChatMessage("listing.matched", { listingId: "lst1", title: "Ohio pool", score: 84.4, buyBoxId: "box1", ...extra }),
    buyerChatMessage("listing.deadline", { listingId: "lst1", title: "Ohio pool", bidDeadline: "2026-12-01T15:00:00.000Z", ...extra }),
    buyerChatMessage("offer.status", { inquiryId: "inq1", listingId: "lst1", title: "Ohio pool", type: "OFFER", status: "DECLINED", change: "declined", reason: "another_bid_accepted", ...extra }),
    buyerChatMessage(PRICE_ALERT_EVENT, { listingId: "lst1", title: "Ohio pool", ask: 110000, targetAsk: 112500, ...extra }),
  ];
  assert.match(messages[1].lines[0], /scores 84 against one of your buy boxes/);
  assert.match(messages[2].lines[0], /close at 2026-12-01 15:00 UTC/);
  assert.equal(messages[3].lines[0], "Your bid on Ohio pool is declined.");
  assert.equal(messages[3].link?.url, "https://upb.example/buyer/offers#inquiry-inq1");
  assert.equal(messages[4].lines[0], "The ask on Ohio pool is now $110,000, at or under your target of $112,500.");
  for (const message of messages) {
    for (const kind of ["SLACK", "TEAMS"] as const) assert.deepEqual(leaks(JSON.stringify(chatBody(kind, message))), [], `${message.title} on ${kind}`);
  }
  // An id that isn't one never reaches a link.
  assert.equal(buyerChatMessage("listing.matched", { listingId: "../admin?x=1", title: "T" }).link, null);

  // The desk's channel reads a notice as a push does: its event name and the page it points to.
  const desk = deskChatMessage(`Sealed bid · Ohio pool · ${SECRET.street}`, `From ${SECRET.rival} (rival@example.org). Bid $98,765 for ${SECRET.borrower}. https://upb.example/admin/offers`);
  assert.equal(desk.title, "Sealed bid");
  assert.equal(desk.link?.url, "https://upb.example/admin/offers");
  for (const kind of ["SLACK", "TEAMS"] as const) {
    const text = JSON.stringify(chatBody(kind, desk));
    assert.deepEqual(leaks(text), []);
    assert.ok(!text.includes("rival@example.org") && !text.includes("Ohio pool"));
  }
  // Slack's mrkdwn control characters are escaped.
  assert.match((chatBody("SLACK", { title: "A <b> & c", lines: [], link: null }) as { text: string }).text, /A &lt;b&gt; &amp; c/);

  // With no app address there is no link to give.
  const saved = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = "";
  const bare = buyerChatMessage("listing.matched", { listingId: "lst1", title: "T", score: 70 });
  process.env.NEXT_PUBLIC_APP_URL = saved;
  assert.equal(bare.link, null);
  assert.deepEqual((chatBody("TEAMS", bare) as { attachments: { content: { actions: unknown[] } }[] }).attachments[0].content.actions, []);
});

test("a send is recorded on the channel, and ten failures in a row pause it with one notice", async () => {
  const owner = await person("deliver", "BUYER");
  const row = await channel({ ownerId: owner.id, url: slack("deliver"), events: "listing.matched" });
  const message = buyerChatMessage("listing.matched", { listingId: "lst1", title: `Delivered ${tag}`, score: 80 });

  const ok = capture(200);
  assert.deepEqual(await deliverChat(row, message, ok.send), { ok: true, error: "" });
  assert.equal(ok.sent.length, 1);
  assert.equal(ok.sent[0].url, slack("deliver"));
  let stored = await prisma.chatChannel.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(stored.lastSentAt);
  assert.equal(stored.failures, 0);
  assert.equal(stored.lastError, null);

  const refused = capture(404, "no_service");
  assert.equal((await deliverChat(row, message, refused.send))?.ok, false);
  stored = await prisma.chatChannel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(stored.failures, 1);
  assert.equal(stored.lastError, "Answered 404: no_service");

  const down = capture("throw");
  for (let tries = 2; tries < PAUSE_AFTER; tries += 1) await deliverChat(row, message, down.send);
  assert.equal((await prisma.chatChannel.findUniqueOrThrow({ where: { id: row.id } })).pausedAt, null, "nine failures don't pause it");
  await deliverChat(row, message, down.send);
  stored = await prisma.chatChannel.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(stored.pausedAt, "paused after ten failures");
  assert.equal(stored.failures, PAUSE_AFTER);
  assert.equal(stored.lastError, "connect ECONNREFUSED");
  // A test the owner sends to the paused channel that fails again doesn't tell them twice.
  await deliverChat(stored, message, down.send, { evenPaused: true });
  assert.equal(down.sent.length, PAUSE_AFTER);
  const paused = await prisma.notification.findMany({ where: { toEmail: owner.email, subject: "Chat alerts paused · Slack" } });
  assert.equal(paused.length, 1, "the owner hears once");
  assert.match(paused[0].body, /hooks\.slack\.com …xyz1/);
  assert.ok(!paused[0].body.includes(slack("deliver")), "the notice never carries the address");

  // A paused channel is skipped.
  const skipped = capture(200);
  assert.equal(await deliverChat(stored, message, skipped.send), null);
  assert.equal(skipped.sent.length, 0);

  // A success clears the count. An address that breaks the rules isn't tried at all.
  await deliverChat(stored, message, ok.send, { evenPaused: true });
  assert.equal((await prisma.chatChannel.findUniqueOrThrow({ where: { id: row.id } })).failures, 0);
  const forged = await channel({ ownerId: owner.id, url: "https://hooks.slack.com.evil.example/services/x", events: "listing.matched" });
  const never = capture(200);
  assert.equal((await deliverChat(forged, message, never.send))?.ok, false);
  assert.equal(never.sent.length, 0);
});

test("a buyer event reaches only the subscribed, live channels of Pro accounts", async () => {
  const capturing = capture(200);
  setChatSender(capturing.send);
  const pro = await person("hook-pro", "BUYER");
  const lapsed = await person("hook-lapsed", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" });
  const gone = await person("hook-gone", "BUYER", { deletedAt: new Date() });
  const pausedOwner = await person("hook-paused", "BUYER");
  const bystander = await person("hook-bystander", "BUYER");
  await channel({ ownerId: pro.id, url: slack("pro"), events: "listing.matched,offer.status" });
  await channel({ ownerId: pro.id, kind: "TEAMS", url: teams("pro"), events: "listing.repriced" });
  await channel({ ownerId: lapsed.id, url: slack("lapsed"), events: "listing.matched" });
  await channel({ ownerId: gone.id, url: slack("gone"), events: "listing.matched" });
  await channel({ ownerId: pausedOwner.id, url: slack("paused"), events: "listing.matched", pausedAt: new Date() });
  await channel({ ownerId: bystander.id, url: slack("bystander"), events: "listing.matched" });

  // The hook rides on the webhook path, which has no endpoints here, and doesn't wait on the chat sends.
  const payload = { listingId: "lst1", title: `Hooked ${tag}`, score: 82, borrowerName: SECRET.borrower };
  assert.equal(await emitBuyerWebhook([pro.id, lapsed.id, gone.id, pausedOwner.id], "listing.matched", payload), 0);
  await chatAlertsIdle();
  assert.deepEqual(capturing.sent.map((item) => item.url), [slack("pro")]);
  assert.match(capturing.sent[0].text, new RegExp(`Buy box match · Hooked ${tag}`));
  assert.deepEqual(leaks(capturing.sent[0].text), []);

  // offer.status carries no title, so the listing's is read. The bid amount never rides along.
  const seller = await person("hook-seller", "INSTITUTIONAL_SELLER");
  const note = await listing(seller.id, "Status");
  capturing.sent.length = 0;
  assert.equal(await sendBuyerChat([pro.id], "offer.status", { inquiryId: "inq1", listingId: note.id, type: "OFFER", status: "ACCEPTED", change: "accepted", amount: SECRET.amount, closingId: "cls1" }), 1);
  assert.equal(capturing.sent.length, 1);
  assert.match(capturing.sent[0].text, new RegExp(`Your bid on Status ${tag} is accepted`));
  assert.match(capturing.sent[0].text, /upb\.example\/closings\/cls1/);
  assert.deepEqual(leaks(capturing.sent[0].text), []);

  // The Teams channel takes reprices as an Adaptive Card.
  capturing.sent.length = 0;
  assert.equal(await sendBuyerChat([pro.id, lapsed.id], "listing.repriced", { listingId: note.id, title: note.title, previousAsk: 120000, ask: 115000 }), 1);
  assert.equal(capturing.sent[0].url, teams("pro"));
  assert.equal((capturing.sent[0].body as { type: string }).type, "message");
});

test("a price alert that is hit goes to the buyer's channels that take it", async () => {
  const capturing = capture(200);
  setChatSender(capturing.send);
  const seller = await person("target-seller", "INSTITUTIONAL_SELLER");
  const buyer = await person("target-buyer", "BUYER");
  const other = await person("target-other", "BUYER");
  const note = await listing(seller.id, "Targeted");
  await channel({ ownerId: buyer.id, url: slack("target"), events: PRICE_ALERT_EVENT });
  await channel({ ownerId: buyer.id, url: slack("target-quiet"), events: "listing.repriced" });
  await channel({ ownerId: other.id, url: slack("target-other"), events: PRICE_ALERT_EVENT });
  await prisma.favorite.create({ data: { userId: buyer.id, listingId: note.id, targetAsk: 125000, targetSetAt: new Date() } });
  // The other buyer's target is under the ask, so it isn't hit.
  await prisma.favorite.create({ data: { userId: other.id, listingId: note.id, targetAsk: 100000, targetSetAt: new Date() } });

  assert.equal(await checkTargets(note.id), 1);
  await chatAlertsIdle();
  assert.deepEqual(capturing.sent.map((item) => item.url), [slack("target")]);
  const text = capturing.sent[0].text;
  assert.match(text, new RegExp(`Price alert · Targeted ${tag}`));
  assert.match(text, /now \$120,000, at or under your target of \$125,000/);
  assert.match(text, new RegExp(`upb\\.example/marketplace/${note.id}`));
  assert.deepEqual(leaks(text), []);
});

test("the desk channel hears notifyDesk by event name, narrowed by power", async () => {
  const capturing = capture(200);
  setChatSender(capturing.send);
  const desk = await channel({ desk: true, url: slack("desk"), events: "closings" });

  await notifyDesk(`Files added · Desk title ${tag}`, `${SECRET.rival} added two files for ${SECRET.borrower}.`);
  await notifyDesk(`Signed · PSA · Desk title ${tag}`, `The buyer signed. https://upb.example/closings/cls9`, { capability: "closings" });
  await notifyDesk(`Sealed bid · Desk title ${tag}`, `From ${SECRET.rival}. Bid $98,765.`, { capability: "sealedBids" });
  await chatAlertsIdle();
  const mine = capturing.sent.filter((item) => item.url === desk.url).map((item) => item.text).sort();
  assert.equal(mine.length, 2, "the sealed-bid notice isn't one this channel takes");
  assert.match(mine[0], /^\{"text":"\*Files added\*/);
  assert.match(mine[0], /upb\.example\/notifications/);
  assert.match(mine[1], /^\{"text":"\*Signed\*/);
  assert.match(mine[1], /upb\.example\/closings\/cls9/);
  for (const text of mine) {
    assert.deepEqual(leaks(text), []);
    assert.ok(!text.includes("Desk title"), "no listing title");
  }
  await prisma.chatChannel.deleteMany({ where: { id: desk.id } });
});

test("only an owner or managing seat changes a firm's channels, on Pro, and only a desk owner the desk's", async () => {
  const owner = await person("perm-owner", "BUYER");
  const free = await person("perm-free", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "ACTIVE" });
  const seller = await person("perm-seller", "INSTITUTIONAL_SELLER");
  const deskOwner = await person("perm-desk", "ADMIN", { deskRole: "OWNER" });
  const deskSales = await person("perm-sales", "ADMIN", { deskRole: "SALES" });
  const seat = (role: string): ActingUser => ({ ...owner, actor: { id: `seat-${role}-${tag}`, name: "Seat", email: `seat-${tag}@example.org`, seatRole: role, bidLimitCents: null } });
  const input = (url: string, events: string[] = ["listing.matched"]) => ({ kind: "SLACK", url, label: LABEL, events });

  assert.deepEqual(await addBuyerChannel(seat("VIEW"), input(slack("view"))), { ok: false, error: BUYER_MANAGE_DENIED });
  assert.deepEqual(await addBuyerChannel(seat("TRADE"), input(slack("trade"))), { ok: false, error: BUYER_MANAGE_DENIED });
  assert.match(((await addBuyerChannel(free, input(slack("free")))) as { error: string }).error, /Chat alerts come with Pro/);
  assert.equal((await addBuyerChannel(seller, input(slack("seller")))).ok, false);
  assert.equal((await addBuyerChannel(owner, input("https://hooks.slack.com.evil.example/services/x"))).ok, false);
  assert.deepEqual(await addBuyerChannel(owner, input(slack("none"), ["offer.created"])), { ok: false, error: "Pick at least one alert for the channel." });

  const added = await addBuyerChannel(seat("MANAGE"), input(slack("manage"), ["listing.matched", PRICE_ALERT_EVENT, "listing.bogus"]));
  assert.equal(added.ok, true);
  const id = (added as { id: string }).id;
  made.channels.push(id);
  const row = await prisma.chatChannel.findUniqueOrThrow({ where: { id } });
  assert.equal(row.ownerId, owner.id);
  assert.equal(row.desk, false);
  assert.equal(row.createdById, `seat-MANAGE-${tag}`);
  assert.equal(row.events, `listing.matched,${PRICE_ALERT_EVENT}`);
  assert.equal(row.urlHint, "hooks.slack.com …xyz1");
  const logged = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: id, action: "CHAT_CHANNEL_ADDED" } });
  assert.ok(!logged.detail.includes(slack("manage")), "the audit log keeps the hint, not the address");

  // A firm keeps a few.
  for (let index = 1; index < MAX_BUYER_CHANNELS; index += 1) {
    const more = await addBuyerChannel(owner, input(slack(`more${index}`)));
    assert.equal(more.ok, true);
    made.channels.push((more as { id: string }).id);
  }
  assert.match(((await addBuyerChannel(owner, input(slack("over")))) as { error: string }).error, /up to 5 chat channels/);

  // Changes: a viewing seat can't, another firm can't reach it, the owner can.
  const ok = capture(200);
  assert.deepEqual(await changeChannel(seat("VIEW"), id, "pause"), { ok: false, error: BUYER_MANAGE_DENIED });
  assert.equal((await changeChannel(free, id, "remove")).ok, false);
  assert.equal((await changeChannel(owner, id, "explode")).ok, false);
  assert.equal((await changeChannel(owner, id, "pause")).ok, true);
  assert.ok((await prisma.chatChannel.findUniqueOrThrow({ where: { id } })).pausedAt);
  // A test goes even while paused, and says so.
  const tested = await changeChannel(owner, id, "test", ok.send);
  assert.equal(tested.ok, true);
  assert.match((tested as { message: string }).message, /still paused/);
  assert.equal(ok.sent.length, 1);
  assert.match(ok.sent[0].text, /Test from UPB Capital/);
  // Off Pro, a firm's channel takes no test.
  const freeChannel = await channel({ ownerId: free.id, url: slack("free-test"), events: "listing.matched" });
  assert.match(((await changeChannel(free, freeChannel.id, "test", ok.send)) as { error: string }).error, /Chat alerts come with Pro/);
  assert.equal(ok.sent.length, 1);
  await prisma.chatChannel.update({ where: { id }, data: { failures: 4 } });
  assert.equal((await changeChannel(owner, id, "resume")).ok, true);
  const resumed = await prisma.chatChannel.findUniqueOrThrow({ where: { id } });
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.failures, 0);
  const refused = await changeChannel(owner, id, "test", capture(403, "invalid_token").send);
  assert.deepEqual(refused, { ok: false, error: "Slack refused the test. Answered 403: invalid_token" });

  // The desk's channel: owners only, and one of it. A buyer never reaches it.
  const deskInput = { kind: "TEAMS", url: teams("desk"), label: LABEL, events: ["closings", "compliance", "notAPower"] };
  assert.deepEqual(await addDeskChannel(deskSales, deskInput), { ok: false, error: DESK_DENIED });
  const deskAdded = await addDeskChannel(deskOwner, deskInput);
  assert.equal(deskAdded.ok, true);
  const deskId = (deskAdded as { id: string }).id;
  made.channels.push(deskId);
  const deskRow = await prisma.chatChannel.findUniqueOrThrow({ where: { id: deskId } });
  assert.equal(deskRow.desk, true);
  assert.equal(deskRow.ownerId, null);
  assert.equal(deskRow.events, "closings,compliance");
  assert.match(((await addDeskChannel(deskOwner, { ...deskInput, url: teams("desk2") })) as { error: string }).error, /already has a chat channel/);
  assert.deepEqual(await changeChannel(deskSales, deskId, "pause"), { ok: false, error: DESK_DENIED });
  assert.deepEqual(await changeChannel(owner, deskId, "remove"), { ok: false, error: "That chat channel isn't on this account." });
  assert.deepEqual(await changeChannel(deskOwner, id, "remove"), { ok: false, error: "That chat channel isn't on this account." });
  assert.equal((await changeChannel(deskOwner, deskId, "remove")).ok, true);
  assert.equal(await prisma.chatChannel.count({ where: { id: deskId } }), 0);
  assert.equal((await changeChannel(owner, id, "remove")).ok, true);
  assert.equal(await prisma.chatChannel.count({ where: { id } }), 0);
});
