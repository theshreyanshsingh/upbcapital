import assert from "node:assert/strict";
import test from "node:test";
import { POST as kycWebhook } from "../app/api/kyc/webhook/route";
import { adminNeedsSecondFactor, needsSecondFactor } from "../lib/access";
import { stepNeedsReminder } from "../lib/closing-clock";
import { assertReleaseEnv, demoSeat } from "../lib/deploy";
import { digestSince } from "../lib/digest";
import { notify, sendAlert, sendSecret } from "../lib/email";
import { eachItem, runJobList, sendDigest } from "../lib/jobs";
import { prisma } from "../lib/prisma";
import { taskNeedsReminder } from "../lib/schedule";
import { canSubmitOffer, vendorBlocked } from "../lib/verification";

// Nothing in this file may reach a real inbox, whatever the local .env holds.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const tagFor = () => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

test("daily reminders allow for a cron that starts a little earlier than yesterday", () => {
  const now = new Date("2026-11-04T13:00:00Z");
  const yesterday = new Date("2026-11-03T13:00:40Z");
  assert.equal(taskNeedsReminder({ dueOn: now, doneAt: null, remindedAt: yesterday }, now), true);
  assert.equal(taskNeedsReminder({ dueOn: now, doneAt: null, remindedAt: new Date(now.getTime() - 3 * HOUR) }, now), false);
  const due = new Date("2026-11-01T00:00:00Z");
  assert.equal(stepNeedsReminder({ status: "PENDING", remindedAt: yesterday }, due, now), true);
  assert.equal(stepNeedsReminder({ status: "PENDING", remindedAt: new Date(now.getTime() - 3 * HOUR) }, due, now), false);
});

test("a digest window starts at the last digest, so a skipped day loses nothing", () => {
  const now = new Date("2026-11-04T13:00:00Z");
  const yesterday = new Date("2026-11-03T13:00:40Z");
  assert.equal(digestSince("DAILY", yesterday, now)?.getTime(), yesterday.getTime());
  assert.equal(digestSince("DAILY", new Date(now.getTime() - 3 * HOUR), now), null);
  const old = new Date("2026-10-20T13:00:00Z");
  assert.equal(digestSince("WEEKLY", old, now)?.getTime(), old.getTime());
  assert.equal(digestSince("WEEKLY", null, now)?.toISOString(), "2026-10-28T13:00:00.000Z");
  assert.equal(digestSince("OFF", old, now), null);
});

test("only the seeded demo seats skip the second factor", () => {
  const buyer = { role: "BUYER", email: "ops@acmefund.test", totpEnabled: false, accountStatus: "APPROVED" };
  assert.equal(needsSecondFactor(buyer, true), true);
  assert.equal(needsSecondFactor({ ...buyer, email: "ops@example.com" }, true), true);
  assert.equal(needsSecondFactor({ ...buyer, email: "jordan.hale@upbcapital.test" }, true), false);
  assert.equal(adminNeedsSecondFactor({ role: "ADMIN", email: "ops@desk.example", totpEnabled: false }), true);
  assert.equal(adminNeedsSecondFactor({ role: "ADMIN", email: "iris@upbcapital.test", totpEnabled: false }), false);
  assert.equal(demoSeat("Desk@Harborline.test "), true);
  assert.equal(demoSeat("iris@upbcapital.test", { UPB_RELEASE: "1" }), false);
});

test("a release build refuses an admin or desk address that can't take mail", () => {
  const env = {
    UPB_RELEASE: "1",
    DATABASE_URL: "mongodb+srv://user:pass@cluster0.example.mongodb.net/upb_capital",
    AUTH_SECRET: "a-real-production-secret-value",
    NEXT_PUBLIC_APP_URL: "https://desk.upbcapital.com",
    ADMIN_EMAIL: "owner@upbcapital.com",
    ADMIN_PASSWORD: "correct horse battery",
    CRON_SECRET: "another-long-cron-secret",
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test",
    OFAC_SDN_URL: "https://example.org/SDN.CSV",
  };
  assert.doesNotThrow(() => assertReleaseEnv(env));
  assert.throws(() => assertReleaseEnv({ ...env, ADMIN_EMAIL: "ops@desk.example" }), /ADMIN_EMAIL must be an address that takes mail/);
  assert.throws(() => assertReleaseEnv({ ...env, DESK_EMAIL: "desk@example.com" }), /DESK_EMAIL must be an address that takes mail/);
  assert.throws(() => assertReleaseEnv({ ...env, ADMIN_EMAIL: "iris@upbcapital.test" }), /demo/);
});

test("a vendor step never reopens a decided file, and only the desk opens offers", () => {
  assert.ok(vendorBlocked("REJECTED"));
  assert.ok(vendorBlocked("APPROVED"));
  assert.equal(vendorBlocked("SUBMITTED"), null);
  assert.equal(vendorBlocked("CHANGES_REQUESTED"), null);
  assert.equal(vendorBlocked(undefined), null);
  assert.equal(canSubmitOffer({ role: "BUYER", accountStatus: "APPROVED", verificationStatus: "SUBMITTED" }).ok, false);
});

test("one failing job is recorded and the others still finish", async () => {
  const tag = tagFor();
  const result = await runJobList([
    ["Works", async () => ({ sent: 2, failed: 0, error: "" })],
    ["Breaks", async () => {
      throw new Error(`boom ${tag}`);
    }],
    ["Partial", () => eachItem("partial", [1, 2, 3], (n) => `item ${n}`, async (n) => {
      if (n === 2) throw new Error("bad item");
      return true;
    })],
    ["Retention", async () => "retention removed 0 visits"],
  ]);
  try {
    assert.deepEqual(result.failed, ["Breaks", "Partial"]);
    assert.match(result.summary, /Works 2\./);
    assert.match(result.summary, new RegExp(`Breaks failed: boom ${tag}\\.`));
    assert.match(result.summary, /Partial 2, 1 failed \(item 2: bad item\)\./);
    assert.match(result.summary, /Retention removed 0 visits\./);
    const row = await prisma.jobRun.findFirst({ where: { summary: { contains: `boom ${tag}` } } });
    assert.ok(row?.finishedAt);
    assert.ok(row.startedAt.getTime() <= row.finishedAt.getTime());
  } finally {
    await prisma.jobRun.deleteMany({ where: { summary: { contains: `boom ${tag}` } } });
  }
});

test("two overlapping digest runs send one digest, and the next window picks up where it left off", async () => {
  const tag = tagFor();
  const now = new Date();
  const seller = await prisma.user.create({ data: { email: `jobs-seller-${tag}@example.org`, name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const buyer = await prisma.user.create({
    data: { email: `jobs-buyer-${tag}@example.org`, name: `Buyer ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x", digest: "DAILY", lastDigestAt: new Date(now.getTime() - 25 * HOUR) },
  });
  const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "APPROVED", approvedAt: now, title: `Digest ${tag}` } });
  const boxes = await Promise.all([1, 2].map((n) => prisma.buyBox.create({ data: { userId: buyer.id, name: `Box ${n} ${tag}`, states: "FL" } })));
  const digests = () => prisma.notification.count({ where: { toEmail: buyer.email, subject: "Buy box digest" } });
  try {
    await prisma.listingMatch.create({ data: { listingId: listing.id, buyBoxId: boxes[0].id, userId: buyer.id, score: 80, createdAt: new Date(now.getTime() - 10 * HOUR) } });
    // Both runs read the buyer before either writes, as a double cron delivery or the desk's button would.
    const sent = await Promise.all([sendDigest(buyer, now), sendDigest(buyer, now)]);
    assert.deepEqual(sent.filter(Boolean).length, 1);
    assert.equal(await digests(), 1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    assert.equal(after.lastDigestAt?.getTime(), now.getTime());
    assert.equal(await sendDigest(after, new Date(now.getTime() + HOUR)), false);
    // The next run starts a little early and still goes, with the match made just after the last one.
    await prisma.listingMatch.create({ data: { listingId: listing.id, buyBoxId: boxes[1].id, userId: buyer.id, score: 70, createdAt: new Date(now.getTime() + 30 * 60 * 1000) } });
    assert.equal(await sendDigest(after, new Date(now.getTime() + DAY - 30 * 60 * 1000)), true);
    assert.equal(await digests(), 2);
  } finally {
    await prisma.listingMatch.deleteMany({ where: { userId: buyer.id } });
    await prisma.buyBox.deleteMany({ where: { userId: buyer.id } });
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.notification.deleteMany({ where: { toEmail: { in: [buyer.email, seller.email] } } });
    await prisma.user.deleteMany({ where: { id: { in: [buyer.id, seller.id] } } });
  }
});

test("security mail ignores the email notice setting, and a sign-in code keeps no copy", async () => {
  const tag = tagFor();
  const user = await prisma.user.create({
    data: { email: `jobs-alert-${tag}@example.org`, name: `Alert ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x", notifyEmail: false, notifyInApp: true },
  });
  try {
    await notify(user.email, `Plain ${tag}`, "A routine notice.");
    await sendAlert(user.email, `Alert ${tag}`, "Your password changed.");
    await sendSecret(user.email, `Code ${tag}`, "Your code is 123456.");
    const rows = await prisma.notification.findMany({ where: { toEmail: user.email } });
    assert.equal(rows.find((row) => row.subject === `Plain ${tag}`)?.delivery, "skipped");
    assert.equal(rows.find((row) => row.subject === `Alert ${tag}`)?.delivery, "log");
    assert.equal(rows.some((row) => row.subject === `Code ${tag}`), false);
  } finally {
    await prisma.notification.deleteMany({ where: { toEmail: user.email } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test("the KYC webhook acts only on its own submitted file, and never moves the desk's status", async () => {
  const tag = tagFor();
  const secret = `kyc-secret-${tag}`;
  process.env.KYC_WEBHOOK_SECRET = secret;
  const make = (name: string) => prisma.user.create({ data: { email: `jobs-kyc-${name}-${tag}@example.org`, name: `Kyc ${name} ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  const [declined, waiting, blank] = await Promise.all([make("declined"), make("waiting"), make("blank")]);
  const ids = [declined.id, waiting.id, blank.id];
  await prisma.buyerProfile.create({ data: { userId: declined.id, status: "REJECTED", vendor: "persona", vendorRef: `ref-a-${tag}` } });
  await prisma.buyerProfile.create({ data: { userId: waiting.id, status: "SUBMITTED", vendor: "persona", vendorRef: `ref-b-${tag}` } });
  await prisma.buyerProfile.create({ data: { userId: blank.id, status: "SUBMITTED" } });
  const post = (payload: unknown, key = secret) =>
    kycWebhook(new Request("http://localhost/api/kyc/webhook", { method: "POST", headers: { "x-kyc-secret": key, "content-type": "application/json" }, body: JSON.stringify(payload) }));
  const status = async (userId: string) => (await prisma.buyerProfile.findUniqueOrThrow({ where: { userId } })).status;
  try {
    assert.equal((await post({ reference: `ref-b-${tag}`, status: "approved" }, "wrong")).status, 401);
    assert.equal((await post({ reference: `ref-b-${tag}`, status: "approved" }, `${secret}x`)).status, 401);

    const onDeclined = await post({ reference: `ref-a-${tag}`, userId: declined.id, status: "approved" });
    assert.equal((await onDeclined.json()).matched, false);
    assert.equal(await status(declined.id), "REJECTED");

    const empty = await post({ reference: "", userId: "", status: "approved" });
    assert.equal((await empty.json()).matched, false);
    assert.equal(await status(blank.id), "SUBMITTED");

    const crossed = await post({ reference: `ref-b-${tag}`, userId: declined.id, status: "approved" });
    assert.equal((await crossed.json()).matched, false);

    const passed = await post({ reference: `ref-b-${tag}`, userId: waiting.id, status: "approved" });
    assert.equal((await passed.json()).matched, true);
    assert.equal(await status(waiting.id), "SUBMITTED");
    await post({ reference: `ref-b-${tag}`, userId: waiting.id, status: "approved" });
    assert.equal(await prisma.auditEvent.count({ where: { action: "KYC_WEBHOOK", entityId: waiting.id } }), 1);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { subject: { contains: tag } } });
    await prisma.buyerProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});
