import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import { GET as listOffers } from "../app/api/v1/offers/route";
import { subprocessors } from "../app/security/subprocessors";
import { accountLocked } from "../lib/access";
import { accessLog, accessLogCsv, ACCESS_LOG_COLUMNS } from "../lib/access-log";
import { anonymiseAccount, blockerSentence, completeDeletion, deletedAccountRefusal, deletedEmail, deletionBlockers, refuseDeletion, requestDeletion } from "../lib/account-deletion";
import { API_LIMIT, retryAfterSeconds } from "../lib/api-limit";
import { hashKey, mintKey } from "../lib/api-keys";
import { literal } from "../lib/db-filters";
import { certifyDestruction, destructionCertificate, destructionLabel, reminderMarker } from "../lib/destruction";
import { remindDestruction, retryWebhooks, sendDestructionRequests } from "../lib/jobs";
import { prisma } from "../lib/prisma";
import { putBytes, uploadDir } from "../lib/storage";
import { cleanEvents, deliveryState, emitWebhook, nextRetryAt, redeliver, RETRY_DELAYS_MS, signWebhook, wantsEvent, type WebhookSender } from "../lib/webhooks";

// Files go to local disk and mail to the log, whatever the shared .env says. Rate limits use the database store,
// as a deployed desk does.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";
delete process.env.RATE_LIMIT_STORE;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and listings that nothing seeded touches, and their cleanup.

type Role = "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BUYER" | "ADMIN";

async function makeFixture() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const userIds: string[] = [];
  const emails: string[] = [];
  const listingIds: string[] = [];
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const email = `gov-${prefix}-${tag}@example.org`;
    const user = await prisma.user.create({
      data: { email, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: await bcrypt.hash("correct horse", 4), ...extra },
    });
    userIds.push(user.id);
    emails.push(email);
    return user;
  };
  const listing = async (sellerId: string, status: "APPROVED" | "PENDING" | "SOLD", title: string) => {
    const row = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId,
        status,
        approvedAt: new Date(Date.now() - 7 * DAY),
        title: `${title} ${tag}`,
        notes: {
          create: [{
            streetAddress: "1 First St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
            lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
            askingPrice: 120000, estimatedValue: 260000,
          }] as never,
        },
      },
      include: { notes: true },
    });
    listingIds.push(row.id);
    return row;
  };
  const closing = (listingId: string, inquiryId: string, status: "OPEN" | "COMPLETE") =>
    prisma.closing.create({
      data: {
        listingId, inquiryId, status, salePrice: 100000, buyerPremiumCents: 250000, sellerCommissionCents: 300000, buyerTotalCents: 10250000, netToSellerCents: 9700000,
        ...(status === "COMPLETE" ? { closedAt: new Date() } : {}),
      },
    });
  const clean = async () => {
    const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
    const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
    const ndaIds = (await prisma.ndaAcknowledgment.findMany({ where: { OR: [{ listingId: { in: listingIds } }, { userId: { in: userIds } }] }, select: { id: true } })).map((row) => row.id);
    await prisma.rateWindow.deleteMany({ where: { key: { in: ndaIds.map(reminderMarker) } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...inquiryIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: emails } }, { userId: { in: userIds } }, { subject: { contains: literal(tag) } }] } });
    await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.deletionRequest.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await fs.rm(path.join(uploadDir(), "verification", `gov-${tag}`), { recursive: true, force: true });
  };
  return { tag, person, listing, closing, clean };
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);

// ---------------------------------------------------------------------------------------------------------------
// Account deletion.

test("a deletion waits while a bid, a closing or a listing is open, then anonymises the account and keeps its deals", async (t) => {
  const fx = await makeFixture();
  const mail = t.mock.method(console, "info", () => {});
  try {
    const seller = await fx.person("seller", "INDIVIDUAL_SELLER");
    const desk = await fx.person("desk", "ADMIN");
    const buyer = await fx.person("buyer", "BUYER", { phone: "555-0100", companyName: `Fund ${fx.tag}`, totpSecret: "SECRET", totpEnabled: true, recoveryHashes: "a\nb" });
    const other = await fx.person("other", "BUYER");
    const live = await fx.listing(seller.id, "APPROVED", "Live");
    const sold = await fx.listing(seller.id, "SOLD", "Sold");

    // The buyer's proof of funds, a bid, an NDA and the things only they use.
    const proofKey = `verification/gov-${fx.tag}/proof.pdf`;
    await putBytes(proofKey, Buffer.from("%PDF-1.4 proof"), "application/pdf");
    await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED", entityType: "LLC", entityName: `Fund ${fx.tag}`, proofKey, proofName: "proof.pdf", proofMime: "application/pdf", proofAmount: 250000 } });
    const bid = await prisma.inquiry.create({ data: { listingId: live.id, buyerId: buyer.id, type: "OFFER", amount: 90000, status: "OPEN" } });
    const nda = await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId: live.id, signerName: `buyer ${fx.tag}` } });
    await prisma.auditEvent.create({ data: { actorId: buyer.id, action: "LOGIN", entityType: "user", entityId: buyer.id } });
    await prisma.serverSession.create({ data: { id: crypto.randomUUID(), userId: buyer.id, expiresAt: new Date(Date.now() + DAY) } });
    await prisma.pushSubscription.create({ data: { userId: buyer.id, endpoint: `https://push.example.org/${fx.tag}`, p256dh: "k", auth: "a" } });
    await prisma.savedSearch.create({ data: { userId: buyer.id, name: "Florida", filters: {} } });
    await prisma.favorite.create({ data: { userId: buyer.id, listingId: live.id } });
    await prisma.buyBox.create({ data: { userId: buyer.id, name: "Box" } });
    const key = mintKey();
    await prisma.apiKey.create({ data: { userId: buyer.id, name: "Key", prefix: key.prefix, hash: key.hash } });
    await prisma.webhookEndpoint.create({ data: { userId: buyer.id, url: "https://hooks.example.com/upb", secret: "s" } });

    // Another buyer won the sold listing. A closing names them, so their proof of funds is a deal record.
    const otherKey = `verification/gov-${fx.tag}/other.pdf`;
    await putBytes(otherKey, Buffer.from("%PDF-1.4 other"), "application/pdf");
    await prisma.buyerProfile.create({ data: { userId: other.id, status: "APPROVED", entityName: `Other ${fx.tag}`, proofKey: otherKey } });
    const won = await prisma.inquiry.create({ data: { listingId: sold.id, buyerId: other.id, type: "OFFER", amount: 95000, status: "ACCEPTED" } });
    const wonClosing = await fx.closing(sold.id, won.id, "COMPLETE");

    const asked = await requestDeletion(buyer, "  Moving on  ");
    assert.ok("request" in asked && asked.request);
    assert.equal(asked.request.reason, "Moving on");
    assert.match((await requestDeletion(buyer, "")).error ?? "", /already with the desk/);
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "DELETION_REQUESTED", entityId: buyer.id } }));
    assert.ok(await prisma.notification.findFirst({ where: { subject: `Deletion request · ${buyer.name}` } }), "the desk hears");

    // Each open thing is named.
    const refused = await completeDeletion(asked.request.id, desk);
    assert.deepEqual(refused.blockers, ["an open bid"]);
    assert.match(refused.error ?? "", /still has an open bid\. That has to finish/);
    assert.deepEqual(await deletionBlockers(seller.id), ["a live listing"]);
    const openClosing = await fx.closing(live.id, (await prisma.inquiry.create({ data: { listingId: live.id, buyerId: other.id, type: "OFFER", status: "ACCEPTED" } })).id, "OPEN");
    assert.deepEqual(await deletionBlockers(other.id), ["an open closing"]);
    assert.deepEqual(await deletionBlockers(seller.id), ["an open closing", "a live listing"]);
    assert.equal(blockerSentence(["an open bid", "an open closing", "a live listing"]), "This account still has an open bid, an open closing and a live listing. Each has to finish or close before the account can be deleted.");
    assert.equal((await prisma.deletionRequest.findUnique({ where: { id: asked.request.id } }))?.status, "REQUESTED");
    // Nobody completes their own.
    assert.match((await completeDeletion(asked.request.id, buyer)).error ?? "", /Another desk member/);

    await prisma.inquiry.update({ where: { id: bid.id }, data: { status: "DECLINED" } });
    const done = await completeDeletion(asked.request.id, desk, "Checked the sign-in email");
    assert.deepEqual(done, { ok: true, proof: "removed" });
    assert.match((await completeDeletion(asked.request.id, desk)).error ?? "", /already decided/);

    // The confirmation went to the old address before it was cleared.
    const sent = mail.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(sent.some((line) => line.includes(`to=${buyer.email} subject=Your UPB Capital account is deleted`)));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    assert.equal(after.name, "Deleted account");
    assert.equal(after.email, deletedEmail(buyer.id));
    assert.equal(after.email, `deleted+${buyer.id}@deleted.invalid`);
    assert.equal(after.phone, "");
    assert.equal(after.companyName, "");
    assert.equal(after.totpSecret, "");
    assert.equal(after.totpEnabled, false);
    assert.equal(after.recoveryHashes, "");
    assert.equal(after.accountStatus, "SUSPENDED");
    assert.ok(after.deletedAt);
    for (const [label, count] of [
      ["sessions", await prisma.serverSession.count({ where: { userId: buyer.id } })],
      ["push", await prisma.pushSubscription.count({ where: { userId: buyer.id } })],
      ["searches", await prisma.savedSearch.count({ where: { userId: buyer.id } })],
      ["favourites", await prisma.favorite.count({ where: { userId: buyer.id } })],
      ["buy boxes", await prisma.buyBox.count({ where: { userId: buyer.id } })],
      ["keys", await prisma.apiKey.count({ where: { userId: buyer.id } })],
      ["webhooks", await prisma.webhookEndpoint.count({ where: { userId: buyer.id } })],
    ] as const) assert.equal(count, 0, label);
    const profile = await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: buyer.id } });
    assert.equal(profile.status, "APPROVED");
    assert.equal(profile.entityName, "");
    assert.equal(profile.proofKey, "");
    assert.equal(profile.proofAmount, null);
    assert.equal(await exists(path.join(uploadDir(), proofKey)), false, "the proof of funds is gone from storage");

    // Deal records stay.
    assert.ok(await prisma.inquiry.findUnique({ where: { id: bid.id } }));
    assert.ok(await prisma.ndaAcknowledgment.findUnique({ where: { id: nda.id } }));
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "LOGIN", entityId: buyer.id } }));
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "DELETION_COMPLETED", entityId: buyer.id, actorId: desk.id } }));

    // Sign-in finds nothing under the old address, and the account refuses it under the new one.
    assert.equal(await prisma.user.findUnique({ where: { email: buyer.email } }), null);
    assert.equal(await bcrypt.compare("correct horse", after.passwordHash), false);
    assert.equal(accountLocked(after.accountStatus), true);
    assert.match(deletedAccountRefusal(after) ?? "", /deleted/);
    assert.equal(deletedAccountRefusal(seller), null);

    // A closing names the other buyer, so their proof of funds stays where it is.
    await prisma.closing.update({ where: { id: openClosing.id }, data: { status: "CANCELED" } });
    assert.deepEqual(await anonymiseAccount(other.id), { proof: "kept" });
    assert.equal((await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: other.id } })).proofKey, otherKey);
    assert.equal(await exists(path.join(uploadDir(), otherKey)), true);
    assert.ok(await prisma.closing.findUnique({ where: { id: wonClosing.id } }));

    // A refusal needs a reason and tells the holder.
    const sellerAsk = await requestDeletion(seller, "");
    assert.ok("request" in sellerAsk && sellerAsk.request);
    assert.match((await refuseDeletion(sellerAsk.request.id, desk, " ")).error ?? "", /Say why/);
    assert.deepEqual(await refuseDeletion(sellerAsk.request.id, desk, "Your listing is still live."), { ok: true });
    assert.equal((await prisma.deletionRequest.findUnique({ where: { id: sellerAsk.request.id } }))?.status, "REFUSED");
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: seller.email, subject: "Your deletion request" } }));
  } finally {
    mail.mock.restore();
    await fx.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Data destruction after an award.

test("losing bidders are asked once, reminded once, and their certificate shows in the access log", async () => {
  const fx = await makeFixture();
  try {
    const seller = await fx.person("seller", "INDIVIDUAL_SELLER");
    const desk = await fx.person("desk", "ADMIN");
    const winner = await fx.person("winner", "BUYER");
    const loser = await fx.person("loser", "BUYER");
    const declined = await fx.person("declined", "BUYER");
    const stranger = await fx.person("stranger", "BUYER");
    const listing = await fx.listing(seller.id, "PENDING", "Room");
    const live = await fx.listing(seller.id, "APPROVED", "Still live");
    const won = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: winner.id, type: "OFFER", amount: 100000, status: "ACCEPTED" } });
    await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: loser.id, type: "OFFER", amount: 90000, status: "DECLINED" } });
    await fx.closing(listing.id, won.id, "OPEN");
    const [winnerNda, loserNda, declinedNda] = await Promise.all([
      prisma.ndaAcknowledgment.create({ data: { userId: winner.id, listingId: listing.id, signerName: `winner ${fx.tag}` } }),
      prisma.ndaAcknowledgment.create({ data: { userId: loser.id, listingId: listing.id, signerName: `loser ${fx.tag}` } }),
      prisma.ndaAcknowledgment.create({ data: { userId: declined.id, listingId: listing.id, accessStatus: "DECLINED" } }),
    ]);
    // A closing on one loan of a pool that is still live asks nobody yet.
    const liveWon = await prisma.inquiry.create({ data: { listingId: live.id, buyerId: winner.id, type: "OFFER", status: "ACCEPTED" } });
    await fx.closing(live.id, liveWon.id, "OPEN");
    const liveNda = await prisma.ndaAcknowledgment.create({ data: { userId: loser.id, listingId: live.id } });

    const now = new Date();
    const scope = { since: new Date(now.getTime() - 60 * MINUTE), listingIds: [listing.id, live.id] };
    const first = await sendDestructionRequests(now, scope);
    assert.deepEqual(first, { sent: 1, failed: 0, error: "" });
    const again = await sendDestructionRequests(now, scope);
    assert.equal(again.sent, 0, "asked once");
    const rows = await prisma.ndaAcknowledgment.findMany({ where: { id: { in: [winnerNda.id, loserNda.id, declinedNda.id, liveNda.id] } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.ok(byId.get(loserNda.id)?.destroyRequestedAt);
    assert.equal(byId.get(winnerNda.id)?.destroyRequestedAt ?? null, null, "the buyer keeps the files");
    assert.equal(byId.get(declinedNda.id)?.destroyRequestedAt ?? null, null, "a bidder never let in had no files");
    assert.equal(byId.get(liveNda.id)?.destroyRequestedAt ?? null, null);
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: loser.email, subject: `Destroy the data room files · ${listing.title}` } }));
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "DATA_DESTRUCTION_REQUESTED", entityId: listing.id } }));
    // A window that starts after the closing opened finds nothing to ask.
    assert.equal((await sendDestructionRequests(now, { since: new Date(now.getTime() + MINUTE), listingIds: [listing.id] })).sent, 0);

    // One reminder, a week on.
    assert.equal((await remindDestruction(now, { listingIds: [listing.id] })).sent, 0);
    const later = new Date(now.getTime() + 8 * DAY);
    assert.equal((await remindDestruction(later, { listingIds: [listing.id] })).sent, 1);
    assert.equal((await remindDestruction(later, { listingIds: [listing.id] })).sent, 0, "reminded once");
    assert.equal((await remindDestruction(new Date(now.getTime() + 15 * DAY), { listingIds: [listing.id] })).sent, 0);
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: loser.email, subject: `Reminder: destroy the data room files · ${listing.title}` } }));

    // The bidder certifies once.
    assert.match((await certifyDestruction({ ndaId: loserNda.id, userId: stranger.id })).error ?? "", /isn't on your account/);
    assert.match((await certifyDestruction({ ndaId: winnerNda.id, userId: winner.id })).error ?? "", /Nobody has asked/);
    assert.deepEqual(await certifyDestruction({ ndaId: loserNda.id, userId: loser.id, ipAddress: "203.0.113.9" }), { ok: true });
    assert.match((await certifyDestruction({ ndaId: loserNda.id, userId: loser.id })).error ?? "", /already certified/);
    assert.ok((await prisma.ndaAcknowledgment.findUniqueOrThrow({ where: { id: loserNda.id } })).destroyedAt);
    const record = await prisma.auditEvent.findFirst({ where: { action: "DATA_DESTROYED", entityId: listing.id, actorId: loser.id } });
    assert.match(record?.detail ?? "", /203\.0\.113\.9/);
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: loser.email, subject: `Destruction certificate · ${listing.title}` } }));
    const sellerMail = await prisma.notification.findFirst({ where: { toEmail: seller.email, subject: `Destruction certificate · ${listing.title}` } });
    assert.match(sellerMail?.body ?? "", /^Bidder [A-Z]+ certified/);
    assert.ok(!sellerMail?.body.includes(loser.name), "the seller reads the letter, not the name");
    assert.match(sellerMail?.body ?? "", new RegExp(`/api/destruction/${loserNda.id}`));

    // The access log and the engagement summary carry it, for the seller and the desk.
    const log = await accessLog(listing.id, seller);
    assert.ok(log.status === 200);
    const certified = log.rows.find((row) => row.event === "Certified files destroyed");
    assert.ok(certified && /^Bidder [A-Z]+$/.test(certified.bidder));
    assert.equal(certified.files_destroyed, "Certified");
    assert.ok(certified.destroyed_at);
    assert.ok(log.rows.some((row) => row.event === "Asked to destroy files"));
    const line = log.engagement.find((row) => row.userId === loser.id);
    assert.equal(line?.destruction, "Certified");
    assert.ok(line?.destroyedAt);
    assert.equal(log.engagement.find((row) => row.userId === winner.id)?.destruction, "");
    assert.equal(accessLogCsv(log.rows).split("\n")[0], ACCESS_LOG_COLUMNS.join(","));
    assert.ok(ACCESS_LOG_COLUMNS.includes("files_destroyed"));
    const deskLog = await accessLog(listing.id, desk);
    assert.ok(deskLog.status === 200 && deskLog.engagement.find((row) => row.userId === loser.id)?.destruction === "Certified");
    assert.equal(destructionLabel({ destroyRequestedAt: now }), "Asked");
    assert.equal(destructionLabel(undefined), "");

    // The certificate names the bidder for themselves and the desk, and by letter for the seller.
    const forSeller = await destructionCertificate(loserNda.id, seller);
    assert.ok(forSeller.status === 200);
    assert.match(forSeller.bidder, /^Bidder [A-Z]+$/);
    assert.equal(Buffer.from(forSeller.pdf).subarray(0, 4).toString(), "%PDF");
    const forDesk = await destructionCertificate(loserNda.id, desk);
    assert.ok(forDesk.status === 200 && forDesk.bidder.includes(`loser ${fx.tag}`));
    const forBidder = await destructionCertificate(loserNda.id, loser);
    assert.ok(forBidder.status === 200 && forBidder.bidder.includes(`loser ${fx.tag}`));
    assert.equal((await destructionCertificate(loserNda.id, stranger)).status, 403);
    assert.equal((await destructionCertificate(winnerNda.id, winner)).status, 404);
  } finally {
    await fx.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Webhooks: the retry schedule, the job's claim, redelivery and the event filter.

test("the retry schedule waits 1 minute, 10 minutes, 1 hour, 6 hours and 24 hours, then stops", () => {
  const from = new Date("2026-11-07T12:00:00Z");
  assert.deepEqual(RETRY_DELAYS_MS, [MINUTE, 10 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE, 24 * 60 * MINUTE]);
  assert.deepEqual([1, 2, 3, 4, 5].map((tries) => (nextRetryAt(tries, from)!.getTime() - from.getTime()) / MINUTE), [1, 10, 60, 360, 1440]);
  assert.equal(nextRetryAt(6, from), null);
  assert.equal(cleanEvents(["offer.accepted", "evil.event", "offer.created", "offer.created"]), "offer.created,offer.accepted");
  assert.equal(cleanEvents([]), "");
  assert.equal(wantsEvent({ events: "offer.created, offer.accepted" }, "offer.accepted"), true);
  assert.equal(wantsEvent({ events: "offer.created" }, "offer.declined"), false);
  assert.equal(deliveryState({ status: 200, attempts: 1, nextAttemptAt: null, deliveredAt: null }).tone, "good");
  assert.equal(deliveryState({ status: 500, attempts: 2, nextAttemptAt: from, deliveredAt: null }).tone, "waiting");
  assert.equal(deliveryState({ status: 0, attempts: 6, nextAttemptAt: null, deliveredAt: null }).tone, "bad");
});

test("a failed delivery keeps its body, is retried once per due try, stops after five retries, and can be redelivered", async () => {
  const fx = await makeFixture();
  try {
    const seller = await fx.person("api", "INSTITUTIONAL_SELLER");
    const someone = await fx.person("someone", "INSTITUTIONAL_SELLER");
    const all = await prisma.webhookEndpoint.create({ data: { userId: seller.id, url: "https://hooks.example.com/upb", secret: `secret-${fx.tag}` } });
    const awardsOnly = await prisma.webhookEndpoint.create({ data: { userId: seller.id, url: "https://hooks.example.com/awards", secret: "other", events: "offer.accepted" } });
    const broken = await prisma.webhookEndpoint.create({ data: { userId: someone.id, url: "http://hooks.example.com/plain", secret: "x" } });
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const answer = (status: number): WebhookSender => async (url, headers, body) => {
      calls.push({ url, headers, body });
      return { status, detail: status === 200 ? "ok" : "down" };
    };

    const before = Date.now();
    await emitWebhook(seller.id, "offer.created", { inquiryId: `inq-${fx.tag}` }, answer(500));
    // The event filter: the awards-only endpoint hears nothing about a new bid.
    assert.equal(await prisma.webhookDelivery.count({ where: { endpointId: awardsOnly.id } }), 0);
    assert.equal(calls.length, 1);
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: all.id } });
    assert.equal(delivery.status, 500);
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.deliveredAt, null);
    assert.ok(delivery.payload.includes(`inq-${fx.tag}`));
    assert.equal(calls[0].body, delivery.payload);
    assert.equal(calls[0].headers["x-upb-attempt"], "1");
    assert.equal(calls[0].headers["x-upb-delivery"], delivery.id);
    assert.equal(calls[0].headers["x-upb-signature"], signWebhook(all.secret, delivery.payload));
    const wait = delivery.nextAttemptAt!.getTime() - before;
    assert.ok(wait >= MINUTE && wait < MINUTE + 10_000, `first retry in a minute, got ${wait}`);
    await emitWebhook(seller.id, "offer.accepted", { inquiryId: `inq-${fx.tag}` }, answer(200));
    const accepted = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: awardsOnly.id } });
    assert.ok(accepted.deliveredAt);
    assert.equal(accepted.nextAttemptAt, null);
    calls.length = 0;

    // Two overlapping runs, one try.
    const due = new Date(Date.now() + 2 * MINUTE);
    const scope = { endpointIds: [all.id, awardsOnly.id], send: answer(503) };
    const [a, b] = await Promise.all([retryWebhooks(due, scope), retryWebhooks(due, scope)]);
    assert.equal(a.sent + b.sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["x-upb-attempt"], "2");
    assert.equal(calls[0].body, delivery.payload);
    assert.equal(calls[0].headers["x-upb-signature"], signWebhook(all.secret, delivery.payload));
    let row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    assert.equal(row.attempts, 2);
    assert.equal(row.status, 503);
    const tenMinutes = row.nextAttemptAt!.getTime() - Date.now();
    assert.ok(tenMinutes > 9 * MINUTE && tenMinutes <= 10 * MINUTE, `second retry in ten minutes, got ${tenMinutes}`);
    // Not due yet, so a run now leaves it.
    assert.equal((await retryWebhooks(new Date(), scope)).sent, 0);

    // Each further failure waits longer, and the fifth retry is the last.
    for (const [tries, minutes] of [[3, 60], [4, 360], [5, 1440], [6, null]] as const) {
      await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(Date.now() - MINUTE) } });
      assert.equal((await retryWebhooks(new Date(), scope)).sent, 1);
      row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      assert.equal(row.attempts, tries);
      if (minutes == null) assert.equal(row.nextAttemptAt, null);
      else assert.ok(Math.abs(row.nextAttemptAt!.getTime() - Date.now() - minutes * MINUTE) < 10_000, `try ${tries}`);
    }
    assert.equal(calls.length, 5);
    assert.equal(deliveryState(row).tone, "bad");
    assert.equal((await retryWebhooks(new Date(Date.now() + 2 * DAY), scope)).sent, 0, "nothing left to retry");

    // Redelivery is the owner's alone, sends the same body as another try, and can succeed after the retries stop.
    assert.match((await redeliver(delivery.id, someone.id, answer(200))).error ?? "", /isn't on this account/);
    assert.deepEqual(await redeliver(delivery.id, seller.id, answer(200)), { delivered: true });
    row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    assert.equal(row.attempts, 7);
    assert.equal(row.status, 200);
    assert.ok(row.deliveredAt);
    assert.equal(row.nextAttemptAt, null);
    assert.equal(calls.at(-1)?.headers["x-upb-attempt"], "7");
    assert.equal(calls.at(-1)?.body, delivery.payload);
    assert.equal(deliveryState(row).tone, "good");

    // An address that breaks the rules is recorded and not retried.
    await emitWebhook(someone.id, "offer.created", {}, answer(200));
    const refused = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: broken.id } });
    assert.equal(refused.status, 0);
    assert.match(refused.detail, /https/);
    assert.equal(refused.nextAttemptAt, null);
  } finally {
    await fx.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The API rate limit.

test("each API key gets 120 requests a minute, then a 429 with Retry-After", async () => {
  const fx = await makeFixture();
  const key = mintKey();
  const limitKey = `api:${hashKey(key.token).slice(0, 32)}`;
  try {
    const seller = await fx.person("limit", "INSTITUTIONAL_SELLER");
    await prisma.apiKey.create({ data: { userId: seller.id, name: "Limit", prefix: key.prefix, hash: key.hash } });
    assert.equal(API_LIMIT.requests, 120);
    assert.equal(retryAfterSeconds(60_000 * 1000 + 15_000), 45);
    assert.equal(retryAfterSeconds(60_000 * 1000 + 59_999), 1);

    // Start well inside a window, so the count isn't split across two.
    const left = API_LIMIT.windowMs - (Date.now() % API_LIMIT.windowMs);
    if (left < 20_000) await new Promise((resolve) => setTimeout(resolve, left + 250));
    const call = (token = key.token) => listOffers(new Request("http://localhost/api/v1/offers", { headers: { authorization: `Bearer ${token}` } }));
    for (let index = 0; index < API_LIMIT.requests; index += 1) {
      const response = await call();
      assert.equal(response.status, 200, `request ${index + 1}`);
    }
    const limited = await call();
    assert.equal(limited.status, 429);
    const retry = Number(limited.headers.get("retry-after"));
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After ${retry}`);
    const body = (await limited.json()) as { error: string; retryAfter: number };
    assert.match(body.error, /Too many requests\. Each key may make 120 a minute/);
    assert.equal(body.retryAfter, retry);
    // A made-up key is turned away as unknown, and spends nothing.
    assert.equal((await call("upb_not_a_real_key")).status, 401);
  } finally {
    await prisma.rateWindow.deleteMany({ where: { key: { startsWith: limitKey } } });
    await fx.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The security page's list of outside services.

test("the security page lists each kind of outside service as in use or not, without a secret", () => {
  const none = subprocessors({ stripePriceId: "" }, {});
  assert.deepEqual(none.map((row) => row.category), ["Hosting", "Database", "Email", "File storage", "Payments", "Identity", "E-signature", "Sanctions list", "Property data", "AI"]);
  const mail = none.find((row) => row.category === "Email");
  assert.equal(mail?.inUse, false);
  const env = { RESEND_API_KEY: "re_secret_value", EMAIL_FROM: "desk@upb.example", S3_BUCKET: "bucket-name", S3_ACCESS_KEY_ID: "AKIASECRET", S3_SECRET_ACCESS_KEY: "s3secret", OFAC_SDN_URL: "https://example.org/SDN.CSV", AVM_PROVIDER: "attom", ATTOM_API_KEY: "attomsecret", LLM_API_KEY: "sk-secret" };
  const live = subprocessors({ stripePriceId: "" }, env);
  const used = Object.fromEntries(live.map((row) => [row.category, row.inUse]));
  assert.deepEqual(used, { Hosting: true, Database: true, Email: true, "File storage": true, Payments: false, Identity: false, "E-signature": false, "Sanctions list": true, "Property data": true, AI: true });
  const text = JSON.stringify(live);
  for (const secret of ["re_secret_value", "bucket-name", "AKIASECRET", "s3secret", "attomsecret", "sk-secret", "desk@upb.example"]) assert.ok(!text.includes(secret), secret);
});
