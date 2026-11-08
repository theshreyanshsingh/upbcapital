import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import type { User } from "@prisma/client";
import {
  CONFIRM_HOURS,
  cancelEmailChange,
  confirmEmail,
  confirmTokenHash,
  confirmationDue,
  emailConfirmationRequired,
  emailGate,
  maskEmail,
  peekConfirmation,
  requestEmailChange,
  sendConfirmation,
} from "../lib/email-confirm";
import { acceptInvite, inviteUser } from "../lib/invites";
import { prisma } from "../lib/prisma";

// Mail goes to the log, and the demo defaults hold, whatever the shared .env says.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "EMAIL_FROM", "DESK_EMAIL", "UPB_RELEASE", "VERCEL"]) process.env[key] = "";
process.env.NEXT_PUBLIC_APP_URL = "https://upb.example";

const HOUR = 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const address = (who: string) => `ec-${who}-${tag}@example.org`;
const made = { users: [] as string[], emails: [] as string[] };
const PASSWORD = "correct horse 1847";
let hash = "";

test.before(async () => {
  hash = await bcrypt.hash(PASSWORD, 4);
});

test.after(async () => {
  const users = await prisma.user.findMany({ where: { OR: [{ id: { in: made.users } }, { email: { contains: tag } }] }, select: { id: true, email: true } });
  const ids = [...new Set([...made.users, ...users.map((user) => user.id)])];
  const emails = [...new Set([...made.emails, ...users.map((user) => user.email)])];
  await prisma.emailConfirmation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.serverSession.deleteMany({ where: { userId: { in: ids } } });
  await prisma.passwordReset.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { actorId: { in: ids } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: emails } }, { toEmail: { contains: tag } }, { body: { contains: tag } }, { subject: { contains: tag } }] } });
  await prisma.rateWindow.deleteMany({ where: { OR: ids.map((id) => ({ key: { contains: id } })) } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

async function person(who: string, extra: Partial<Pick<User, "role" | "emailConfirmedAt" | "email" | "accountStatus">> = {}) {
  const user = await prisma.user.create({
    data: { email: extra.email ?? address(who), name: `Confirm ${who} ${tag}`, role: extra.role ?? "BUYER", accountStatus: extra.accountStatus ?? "APPROVED", passwordHash: hash, emailConfirmedAt: extra.emailConfirmedAt ?? null },
  });
  made.users.push(user.id);
  made.emails.push(user.email);
  return user;
}

// The log transport prints each email. This keeps what was sent while `run` runs.
async function mailFrom<T>(run: () => Promise<T>) {
  const sent: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    sent.push(args.map(String).join(" "));
  };
  try {
    return { result: await run(), sent };
  } finally {
    console.info = original;
  }
}

function tokenIn(mail: string[]) {
  const found = mail.join("\n").match(/\/login\/confirm\?token=([0-9a-f]{64})/);
  assert.ok(found, "a confirmation link was sent");
  return found[1];
}

// A link the test knows the token of, written as sendConfirmation writes it.
async function link(userId: string, email: string, expiresAt = new Date(Date.now() + CONFIRM_HOURS * HOUR)) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await prisma.emailConfirmation.create({ data: { userId, email, tokenHash: confirmTokenHash(token), expiresAt } });
  return token;
}

test("the desk's setting decides when it is set; otherwise release builds require confirmation", () => {
  assert.equal(emailConfirmationRequired({ requireEmailConfirmation: true }, {}), true);
  assert.equal(emailConfirmationRequired({ requireEmailConfirmation: false }, { UPB_RELEASE: "1" }), false);
  assert.equal(emailConfirmationRequired({ requireEmailConfirmation: null }, { UPB_RELEASE: "1" }), true);
  assert.equal(emailConfirmationRequired({}, {}), false);
  assert.equal(emailConfirmationRequired({ requireEmailConfirmation: undefined }, { UPB_RELEASE: "0" }), false);
  assert.equal(maskEmail("jordan@firm.com"), "j***@firm.com");
});

test("the gate stops an unconfirmed account only when confirmation is required, and never the desk or a seat", async () => {
  const buyer = await person("gated");
  const on = { requireEmailConfirmation: true };
  const off = { requireEmailConfirmation: false };
  assert.equal(await emailGate(buyer, "bid", off), null);
  assert.equal(await emailGate(buyer, "bid", on), `Confirm your email address first. We sent a link to ${buyer.email}.`);
  assert.equal(await emailGate(buyer, "sign", on), `Confirm your email address first. We sent a link to ${buyer.email}.`);
  assert.equal(await emailGate({ ...buyer, emailConfirmedAt: new Date() }, "list", on), null);
  // A change of address waiting on its link names the address the link went to.
  assert.match((await emailGate({ ...buyer, pendingEmail: address("moving") }, "bid", on)) ?? "", new RegExp(`ec-moving-${tag}`));
  assert.equal(await emailGate({ ...buyer, role: "ADMIN" }, "award", on), null);
  const seat = { id: "seat", name: "Seat", email: address("seat"), seatRole: "TRADE", bidLimitCents: null };
  assert.equal(await emailGate({ ...buyer, actor: seat }, "bid", on), null);
  // The demo desk's seeded seats take no mail, so they pass outside a release.
  assert.equal(await emailGate({ ...buyer, email: "jordan.hale@upbcapital.test" }, "bid", on), null);
  // With no setting, the release flag decides.
  process.env.UPB_RELEASE = "1";
  try {
    assert.ok(await emailGate(buyer, "message", { requireEmailConfirmation: null }));
  } finally {
    process.env.UPB_RELEASE = "";
  }
  assert.equal(await emailGate(buyer, "message", { requireEmailConfirmation: null }), null);
  assert.equal(await confirmationDue({ ...buyer, role: "ADMIN" }), null);
});

test("a link is stored only as a hash, lasts 48 hours, works once, and replaces the one before it", async () => {
  const user = await person("signup");
  const first = await mailFrom(() => sendConfirmation(user.id, user.email));
  assert.equal(first.result.error, null);
  const firstToken = tokenIn(first.sent);
  assert.ok(first.sent.join("\n").includes(`to=${user.email}`));
  assert.ok(first.sent.join("\n").includes("https://upb.example/login/confirm?token="));
  const rows = await prisma.emailConfirmation.findMany({ where: { userId: user.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, confirmTokenHash(firstToken));
  assert.notEqual(rows[0].tokenHash, firstToken);
  const life = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
  assert.ok(Math.abs(life - CONFIRM_HOURS * HOUR) < 60 * 1000);

  const second = await mailFrom(() => sendConfirmation(user.id, user.email));
  const secondToken = tokenIn(second.sent);
  // Opening the link only reads it: the page asks for a press before anything is used.
  assert.deepEqual(await peekConfirmation(secondToken), { state: "ready", email: user.email, change: false });
  assert.deepEqual(await peekConfirmation(secondToken), { state: "ready", email: user.email, change: false });
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailConfirmedAt, null);
  assert.equal((await peekConfirmation(firstToken)).state, "invalid");
  assert.equal(await prisma.emailConfirmation.count({ where: { userId: user.id } }), 1);
  assert.equal((await confirmEmail(firstToken)).state, "invalid");

  assert.equal((await confirmEmail(secondToken)).state, "confirmed");
  assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailConfirmedAt);
  assert.equal((await confirmEmail(secondToken)).state, "used");
  assert.equal((await peekConfirmation(secondToken)).state, "used");
  assert.equal((await confirmEmail("")).state, "invalid");
  assert.equal((await confirmEmail("f".repeat(64))).state, "invalid");
  // Nothing more to send once the address is confirmed, and never to an address the account doesn't hold.
  assert.match((await sendConfirmation(user.id, user.email)).error ?? "", /already confirmed/);
  assert.match((await sendConfirmation(user.id, address("stranger"))).error ?? "", /isn't on this account/);
});

test("an expired link changes nothing, and two clicks racing on one link confirm once", async () => {
  const user = await person("late");
  const stale = await link(user.id, user.email, new Date(Date.now() - 1000));
  assert.equal((await peekConfirmation(stale)).state, "expired");
  assert.equal((await confirmEmail(stale)).state, "expired");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailConfirmedAt, null);
  // The expiry is read against the clock passed in.
  const fresh = await link(user.id, user.email, new Date(Date.now() + HOUR));
  assert.equal((await confirmEmail(fresh, { now: new Date(Date.now() + 2 * HOUR) })).state, "expired");
  const racing = await link(user.id, user.email);
  const states = (await Promise.all([confirmEmail(racing), confirmEmail(racing)])).map((outcome) => outcome.state).sort();
  assert.deepEqual(states, ["confirmed", "used"]);
});

test("links are rate-limited per account", async () => {
  const user = await person("limited");
  const now = new Date();
  const results = await mailFrom(async () => {
    const out: (string | null)[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) out.push((await sendConfirmation(user.id, user.email, now)).error);
    return out;
  });
  assert.deepEqual(results.result.slice(0, 5), [null, null, null, null, null]);
  assert.match(results.result[5] ?? "", /Wait a while/);
});

test("a change of address waits on the new address's link, then moves the account and signs other devices out", async () => {
  const user = await person("mover", { emailConfirmedAt: new Date(Date.now() - 24 * HOUR) });
  const target = address("moved");
  assert.match((await requestEmailChange(user, { email: target, password: "wrong password" })).error ?? "", /current password/);
  assert.match((await requestEmailChange(user, { email: user.email, password: PASSWORD })).error ?? "", /already the address/);
  assert.match((await requestEmailChange(user, { email: "someone@upbcapital.test", password: PASSWORD })).error ?? "", /demo desk/);
  assert.match((await requestEmailChange(user, { email: "not-an-address", password: PASSWORD })).error ?? "", /valid email/);

  const asked = await mailFrom(() => requestEmailChange(user, { email: target.toUpperCase(), password: PASSWORD }));
  assert.equal(asked.result.error, null);
  const mail = asked.sent.join("\n");
  assert.ok(mail.includes(`to=${target}`), "the link goes to the new address");
  assert.ok(mail.includes(`to=${user.email}`), "the old address hears of the request");
  assert.ok(mail.includes(maskEmail(target)));
  const token = tokenIn(asked.sent.filter((line) => line.includes(`to=${target}`)));
  assert.deepEqual(await peekConfirmation(token), { state: "ready", email: target, change: true });
  const waiting = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(waiting.email, user.email);
  assert.equal(waiting.pendingEmail, target);

  // Two devices signed in. The one that opens the link stays signed in.
  const later = new Date(Date.now() + 14 * 24 * HOUR);
  const here = await prisma.serverSession.create({ data: { id: crypto.randomUUID(), userId: user.id, expiresAt: later } });
  const there = await prisma.serverSession.create({ data: { id: crypto.randomUUID(), userId: user.id, expiresAt: later } });
  const done = await mailFrom(() => confirmEmail(token, { keepSessionId: here.id }));
  assert.equal(done.result.state, "changed");
  assert.ok(done.sent.join("\n").includes(`to=${user.email}`), "the old address is told the change happened");
  const moved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(moved.email, target);
  assert.equal(moved.pendingEmail, null);
  assert.ok(moved.emailConfirmedAt && waiting.emailConfirmedAt && moved.emailConfirmedAt.getTime() > waiting.emailConfirmedAt.getTime());
  assert.equal(await prisma.serverSession.count({ where: { id: here.id } }), 1);
  assert.equal(await prisma.serverSession.count({ where: { id: there.id } }), 0);
  assert.equal(await prisma.auditEvent.count({ where: { entityId: user.id, action: "EMAIL_CHANGED" } }), 1);
  made.emails.push(target);
});

test("an address another account takes meanwhile is refused, and the account keeps its own", async () => {
  const user = await person("blocked", { emailConfirmedAt: new Date() });
  const target = address("contested");
  const asked = await mailFrom(() => requestEmailChange(user, { email: target, password: PASSWORD }));
  assert.equal(asked.result.error, null);
  const token = tokenIn(asked.sent.filter((line) => line.includes(`to=${target}`)));
  // Someone signs up with the address before the link is opened.
  await person("contested-owner", { email: target });
  assert.match((await requestEmailChange(user, { email: target, password: PASSWORD })).error ?? "", /already on the desk/);
  assert.equal((await confirmEmail(token)).state, "taken");
  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(after.email, user.email);
  assert.equal(after.pendingEmail, null);
});

test("a link to an address the holder moved on from no longer works, and a canceled change clears its link", async () => {
  const user = await person("twice", { emailConfirmedAt: new Date() });
  const first = await mailFrom(() => requestEmailChange(user, { email: address("first-choice"), password: PASSWORD }));
  const firstToken = tokenIn(first.sent.filter((line) => line.includes(`to=${address("first-choice")}`)));
  const second = await mailFrom(() => requestEmailChange(user, { email: address("second-choice"), password: PASSWORD }));
  const secondToken = tokenIn(second.sent.filter((line) => line.includes(`to=${address("second-choice")}`)));
  assert.equal((await peekConfirmation(firstToken)).state, "replaced");
  assert.equal((await confirmEmail(firstToken)).state, "replaced");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail, address("second-choice"));
  await cancelEmailChange(user.id);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail, null);
  assert.equal((await confirmEmail(secondToken)).state, "invalid");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email, user.email);
});

test("an account the desk invited is confirmed when the invitation is accepted", async () => {
  // Never approved, so other tests' desk mail passes this fixture by.
  const desk = await person("desk", { role: "ADMIN", accountStatus: "PENDING" });
  const sent = await mailFrom(() => inviteUser({ actor: desk, name: `Invited ${tag}`, email: address("invited"), companyName: "", role: "BUYER", status: "APPROVED" }));
  assert.equal(sent.result.error, null);
  if (sent.result.error !== null) return;
  const { userId, token } = sent.result;
  made.users.push(userId);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailConfirmedAt, null);
  const opened = await mailFrom(() => acceptInvite({ token, password: "longenough", confirm: "longenough", terms: "yes" }));
  assert.equal(opened.result.error, null);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.ok(user.emailConfirmedAt);
  assert.equal(await emailGate(user, "bid", { requireEmailConfirmation: true }), null);
});
