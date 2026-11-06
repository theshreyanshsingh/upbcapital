import assert from "node:assert/strict";
import test from "node:test";
import { notify, sendSecret } from "../lib/email";
import { prisma } from "../lib/prisma";
import {
  PUSH_BODY,
  PUSH_FALLBACK_TITLE,
  PUSH_HOME,
  noticePush,
  pushEndpointAllowed,
  pushLink,
  pushReady,
  pushTitle,
  readPushSubscription,
  sendPush,
  setPushTransport,
  vapidConfig,
  type PushTarget,
} from "../lib/push";

const KEYS = { VAPID_PUBLIC_KEY: "BTestPublicKey", VAPID_PRIVATE_KEY: "test-private-key", VAPID_SUBJECT: "mailto:desk@upbcapital.test" };
const P256 = `B${"A".repeat(86)}`;
const AUTH = "A".repeat(22);

type Call = { target: PushTarget; payload: string };

function recorder(fail: (target: PushTarget) => unknown = () => null) {
  const calls: Call[] = [];
  setPushTransport(async (target, payload) => {
    calls.push({ target, payload });
    const error = fail(target);
    if (error) throw error;
  });
  return calls;
}

// The keys are set only inside the test that needs them, and always put back.
async function withKeys<T>(work: () => Promise<T>) {
  const saved = Object.fromEntries(Object.keys(KEYS).map((key) => [key, process.env[key]]));
  Object.assign(process.env, KEYS);
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setPushTransport(null);
  }
}

async function makeUser(prefix: string, extra: Record<string, unknown> = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const user = await prisma.user.create({
    data: { email: `push-${prefix}-${tag}@example.org`, name: `Push ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x", pushEnabled: true, ...extra },
  });
  return { tag, user };
}

const endpoint = (tag: string, name: string) => `https://fcm.googleapis.com/fcm/send/test-${tag}-${name}`;

async function addDevice(userId: string, url: string) {
  return prisma.pushSubscription.create({ data: { userId, endpoint: url, p256dh: P256, auth: AUTH } });
}

async function cleanUser(userId: string, email: string) {
  await prisma.pushSubscription.deleteMany({ where: { userId } });
  await prisma.notification.deleteMany({ where: { OR: [{ userId }, { toEmail: email }] } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

test.after(async () => {
  setPushTransport(null);
  await prisma.$disconnect();
});

test("push does nothing until all three VAPID settings are present", async () => {
  assert.equal(vapidConfig({}), null);
  assert.equal(vapidConfig({ ...KEYS, VAPID_SUBJECT: "" }), null);
  assert.equal(vapidConfig({ ...KEYS, VAPID_PRIVATE_KEY: " " }), null);
  assert.equal(vapidConfig({ ...KEYS, VAPID_SUBJECT: "desk@upbcapital.test" }), null, "the subject is a mailto: or https: contact");
  assert.equal(pushReady({}), false);
  assert.deepEqual(vapidConfig(KEYS), { publicKey: KEYS.VAPID_PUBLIC_KEY, privateKey: KEYS.VAPID_PRIVATE_KEY, subject: KEYS.VAPID_SUBJECT });

  const { tag, user } = await makeUser("nokeys");
  const calls = recorder();
  try {
    await addDevice(user.id, endpoint(tag, "a"));
    const result = await sendPush(user.id, { title: "Test notice", body: PUSH_BODY, url: PUSH_HOME }, {});
    assert.deepEqual(result, { sent: 0, pruned: 0, failed: 0, skipped: true });
    // notify() runs with no keys in the environment, so the device hears nothing and nothing breaks.
    const saved = Object.fromEntries(Object.keys(KEYS).map((key) => [key, process.env[key]]));
    for (const key of Object.keys(KEYS)) delete process.env[key];
    try {
      await notify(user.email, "Offer accepted · Test", "Your bid was accepted.");
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    }
    assert.equal(calls.length, 0);
    assert.equal(await prisma.pushSubscription.count({ where: { userId: user.id } }), 1, "nothing is pruned either");
  } finally {
    setPushTransport(null);
    await cleanUser(user.id, user.email);
  }
});

test("a push payload carries the event name, a generic line and an in-app path, never a name, street, amount or code", () => {
  const app = "https://desk.upbcapital.test";
  const payload = noticePush(
    "Offer accepted · First-lien performing · Austin",
    "Your bid of $85,000 for Jane Q Borrower at 12 Elm Street was accepted. Your code is 493021. The closing checklist is open: https://desk.upbcapital.test/closings/cabc123def?token=secret.",
    3,
    app,
  );
  assert.deepEqual(payload, { title: "Offer accepted", body: PUSH_BODY, url: "/closings/cabc123def", badge: 3 });
  assert.doesNotMatch(JSON.stringify(payload), /85,000|\$|Jane|Borrower|Elm|493021|Austin|First-lien|token|secret/);

  // Titles keep only a plain event name.
  assert.equal(pushTitle("Approve a sale · Smith family pool"), "Approve a sale");
  assert.equal(pushTitle("Note on First-lien performing · Austin"), "Note");
  assert.equal(pushTitle("The desk bid on 14 Oak Road pool"), "The desk bid");
  assert.equal(pushTitle("New paper matches “Jane's Texas firsts”"), "New paper matches");
  assert.equal(pushTitle("Account approved"), "Account approved");
  assert.equal(pushTitle("Payment of $1,200 posted"), PUSH_FALLBACK_TITLE);
  assert.equal(pushTitle("Your code 482913"), PUSH_FALLBACK_TITLE);
  assert.equal(pushTitle("221B Baker Street payoff"), PUSH_FALLBACK_TITLE);
  assert.equal(pushTitle("Reply from jane@example.org"), PUSH_FALLBACK_TITLE);
  assert.equal(pushTitle(""), PUSH_FALLBACK_TITLE);

  // Links: same site only, as a path, with the hash kept and the query dropped.
  assert.equal(pushLink("Approve or decline here: /seller/listings/c123#offers.", ""), "/seller/listings/c123#offers");
  assert.equal(pushLink("See https://evil.example/closings/c1 now", app), PUSH_HOME);
  assert.equal(pushLink("See https://desk.upbcapital.test/api/kyc/c1", app), PUSH_HOME);
  assert.equal(pushLink("1/2 steps done and/or pending", app), PUSH_HOME);
  assert.equal(pushLink("No link here.", app), PUSH_HOME);
  assert.equal(pushLink("Fund your share: https://desk.upbcapital.test/groups/g1?code=99", app), "/groups/g1");
});

test("only a browser's own push service is a valid push address", () => {
  for (const url of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://web.push.apple.com/QH4",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ]) assert.equal(pushEndpointAllowed(url), true, url);
  for (const url of [
    "https://169.254.169.254/latest/meta-data",
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://localhost/x",
    "not a url",
  ]) assert.equal(pushEndpointAllowed(url), false, url);
  assert.deepEqual(readPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: P256, auth: AUTH } }), {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: P256, auth: AUTH },
  });
  assert.equal(readPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "short", auth: AUTH } }), null);
  assert.equal(readPushSubscription({ endpoint: "https://internal.example/x", keys: { p256dh: P256, auth: AUTH } }), null);
  assert.equal(readPushSubscription("nope"), null);
});

test("a device the push service calls gone (410 or 404) is pruned, and the rest are kept", async () => {
  const { tag, user } = await makeUser("prune");
  try {
    await withKeys(async () => {
      const gone = await addDevice(user.id, endpoint(tag, "gone"));
      const live = await addDevice(user.id, endpoint(tag, "live"));
      const flaky = await addDevice(user.id, endpoint(tag, "flaky"));
      const calls = recorder((target) => {
        if (target.endpoint === gone.endpoint) return Object.assign(new Error("Gone"), { statusCode: 410 });
        if (target.endpoint === flaky.endpoint) return Object.assign(new Error("Server error"), { statusCode: 500 });
        return null;
      });
      const result = await sendPush(user.id, { title: "Test notice", body: PUSH_BODY, url: PUSH_HOME });
      assert.equal(calls.length, 3);
      assert.deepEqual(result, { sent: 1, pruned: 1, failed: 1, skipped: false });
      assert.equal(await prisma.pushSubscription.findUnique({ where: { id: gone.id } }), null);
      assert.ok((await prisma.pushSubscription.findUnique({ where: { id: live.id } }))?.lastUsedAt, "a delivered device is stamped");
      assert.ok(await prisma.pushSubscription.findUnique({ where: { id: flaky.id } }), "a server error is not a reason to forget a device");

      // When the last devices go, push turns off for the account, so notices stop looking for devices.
      recorder(() => Object.assign(new Error("Not found"), { statusCode: 404 }));
      const last = await sendPush(user.id, { title: "Test notice", body: PUSH_BODY, url: PUSH_HOME });
      assert.equal(last.pruned, 2);
      assert.equal(await prisma.pushSubscription.count({ where: { userId: user.id } }), 0);
      assert.equal((await prisma.user.findUnique({ where: { id: user.id } }))?.pushEnabled, false);
    });
  } finally {
    await cleanUser(user.id, user.email);
  }
});

test("notify() pushes to an opted-in account, and sendSecret never pushes", async () => {
  const { tag, user } = await makeUser("fanout");
  const { tag: offTag, user: off } = await makeUser("off", { pushEnabled: false });
  try {
    await withKeys(async () => {
      await addDevice(user.id, endpoint(tag, "phone"));
      await addDevice(off.id, endpoint(offTag, "phone"));
      const calls = recorder();

      await sendSecret(user.email, "Your sign-in code", "Your code is 482913. It expires in ten minutes.");
      assert.equal(calls.length, 0, "a code never reaches a lock screen");

      await notify(user.email, "Offer accepted · Push test pool", "Your bid of $90,000 for Jane Borrower was accepted. The closing checklist is open: /closings/cpushtest1");
      assert.equal(calls.length, 1);
      const payload = JSON.parse(calls[0].payload);
      assert.equal(payload.title, "Offer accepted");
      assert.equal(payload.body, PUSH_BODY);
      assert.equal(payload.url, "/closings/cpushtest1");
      assert.ok(typeof payload.badge === "number" && payload.badge >= 1, "the badge counts the in-app copy just kept");
      assert.doesNotMatch(calls[0].payload, /90,000|\$|Jane|Borrower|Push test pool/);

      // Push is its own setting: it still goes when email and the in-app list are both off.
      await prisma.user.update({ where: { id: user.id }, data: { notifyEmail: false, notifyInApp: false } });
      await notify(user.email, "Bid expired · Push test pool", "Your bid reached its good-until date.");
      assert.equal(calls.length, 2);
      assert.equal(JSON.parse(calls[1].payload).url, PUSH_HOME);

      // An account that never turned push on gets none, even with a device on file.
      await notify(off.email, "Offer accepted · Push test pool", "Accepted.");
      assert.equal(calls.length, 2);
    });
  } finally {
    await cleanUser(user.id, user.email);
    await cleanUser(off.id, off.email);
  }
});
