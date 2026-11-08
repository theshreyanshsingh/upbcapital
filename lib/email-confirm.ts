import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import type { User } from "@prisma/client";
import { accountLocked } from "@/lib/access";
import type { GatedAction } from "@/lib/action-gates";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { demoAddress, demoSeat, isReleaseBuild } from "@/lib/deploy";
import { sendAlert, sendSecret } from "@/lib/email";
import { deliverable } from "@/lib/mail-config";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import type { ActingUser } from "@/lib/seats";
import { getSettings } from "@/lib/settings";

// Proof that the holder of an account owns its email address: a one-time link to the address, at signup and on a
// change of address. Until it is used, the account can browse but not bid, list, award, sign or message, when the
// desk asks for it. Only the hash of each link is kept.

const HOUR = 60 * 60 * 1000;
export const CONFIRM_HOURS = 48;
const SENDS_PER_HOUR = 5;

// Whether accounts must confirm their address before they commit. The desk's setting wins; without one, release
// builds require it and the demo doesn't.
export function emailConfirmationRequired(settings: { requireEmailConfirmation?: boolean | null }, env: Record<string, string | undefined> = process.env) {
  if (typeof settings.requireEmailConfirmation === "boolean") return settings.requireEmailConfirmation;
  return env.UPB_RELEASE === "1";
}

export function confirmTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function confirmLink(token: string, appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  return `${appUrl}/login/confirm?token=${token}`;
}

// The address a fresh link goes to: the one the holder is moving to, else the one on the account.
export function confirmTarget(user: { email: string; pendingEmail?: string | null }) {
  return user.pendingEmail || user.email;
}

// "j***@example.com", for a notice to one address about another.
export function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  return domain ? `${name.slice(0, 1)}***@${domain}` : "***";
}

type Gated = User | ActingUser;

// Who never waits on a link: the desk, a firm's seat (its invitation proved its own address, so the seat is judged
// rather than the firm), and the demo desk's seeded seats, whose addresses take no mail.
function exempt(user: Gated) {
  if (user.role === "ADMIN") return true;
  if ("actor" in user && user.actor) return true;
  return demoSeat(user.email);
}

// Null lets the action through. Otherwise the sentence to show instead. Every action waits on the same proof.
// `settings` is for tests; the desk's own are read otherwise.
export async function emailGate(user: Gated, action: GatedAction, settings?: { requireEmailConfirmation?: boolean | null }): Promise<string | null> {
  void action;
  if (exempt(user) || user.emailConfirmedAt) return null;
  if (!emailConfirmationRequired(settings ?? (await getSettings()))) return null;
  return `Confirm your email address first. We sent a link to ${confirmTarget(user)}.`;
}

// The address the signed-in shell asks the holder to confirm, or null when nothing is waiting on it.
export async function confirmationDue(user: Gated) {
  return (await emailGate(user, "bid")) ? confirmTarget(user) : null;
}

export type SendResult = { error: string | null };

// A new link to one of the account's own addresses: the one on file, or the one it is moving to. A newer link to
// the same address replaces the older one.
export async function sendConfirmation(userId: string, email: string, now = new Date()): Promise<SendResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, pendingEmail: true, emailConfirmedAt: true, accountStatus: true, deletedAt: true } });
  if (!user || accountLocked(user.accountStatus) || user.deletedAt) return { error: "That account can't take a link." };
  const address = email.trim().toLowerCase();
  const current = address === user.email;
  if (!current && address !== user.pendingEmail) return { error: "That address isn't on this account." };
  if (current && user.emailConfirmedAt) return { error: "That address is already confirmed." };
  if (!(await consumeRateLimit(`email-confirm:${user.id}`, SENDS_PER_HOUR, HOUR, now.getTime()))) {
    return { error: "Several links went out in the last hour. Wait a while, then ask again." };
  }
  const token = randomBytes(32).toString("hex");
  await prisma.emailConfirmation.deleteMany({ where: { userId: user.id, email: address, ...unset("usedAt") } });
  await prisma.emailConfirmation.create({
    data: { userId: user.id, email: address, tokenHash: confirmTokenHash(token), expiresAt: new Date(now.getTime() + CONFIRM_HOURS * HOUR) },
  });
  const link = confirmLink(token);
  await sendSecret(
    address,
    current ? "Confirm your UPB Capital email" : "Confirm your new UPB Capital email",
    current
      ? `Open this link within ${CONFIRM_HOURS} hours and press the button to confirm that this address is yours:\n\n${link}\n\nUntil then you can look around, but not bid, list or sign. If you did not sign up for UPB Capital, ignore this email.`
      : `Open this link within ${CONFIRM_HOURS} hours and press the button to move your UPB Capital account to this address:\n\n${link}\n\nThe account keeps its old address until you do. If you did not ask for this, ignore this email.`,
  );
  return { error: null };
}

export type ConfirmState = "confirmed" | "changed" | "used" | "expired" | "invalid" | "replaced" | "taken";
export type ConfirmOutcome = { state: ConfirmState; userId?: string };

// What a link would do, read without using it, for the page that asks the holder to press the button. Opening the
// link changes nothing, so a mail scanner that follows it confirms nothing.
export async function peekConfirmation(token: string, now = new Date()): Promise<{ state: "ready"; email: string; change: boolean } | { state: ConfirmState }> {
  const row = token ? await prisma.emailConfirmation.findUnique({ where: { tokenHash: confirmTokenHash(token) } }) : null;
  if (!row) return { state: "invalid" };
  if (row.usedAt) return { state: "used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { state: "expired" };
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true, pendingEmail: true, accountStatus: true, deletedAt: true } });
  if (!user || accountLocked(user.accountStatus) || user.deletedAt) return { state: "invalid" };
  if (row.email !== user.email && row.email !== user.pendingEmail) return { state: "replaced" };
  return { state: "ready", email: row.email, change: row.email !== user.email };
}

// Uses a link once. On the address the account already has, it marks it confirmed. On the address it is moving to,
// the address moves, if no other account took it meanwhile; other devices are signed out and the old address hears.
export async function confirmEmail(token: string, options: { now?: Date; keepSessionId?: string | null } = {}): Promise<ConfirmOutcome> {
  const now = options.now ?? new Date();
  const row = token ? await prisma.emailConfirmation.findUnique({ where: { tokenHash: confirmTokenHash(token) } }) : null;
  if (!row) return { state: "invalid" };
  if (row.usedAt) return { state: "used", userId: row.userId };
  if (row.expiresAt.getTime() <= now.getTime()) return { state: "expired", userId: row.userId };
  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user || accountLocked(user.accountStatus) || user.deletedAt) return { state: "invalid" };
  // Claimed before anything changes, so two clicks racing on one link can't both act.
  const claimed = await prisma.emailConfirmation.updateMany({ where: { id: row.id, ...unset("usedAt") }, data: { usedAt: now } });
  if (claimed.count !== 1) return { state: "used", userId: user.id };

  if (row.email === user.email) {
    if (!user.emailConfirmedAt) {
      await prisma.user.update({ where: { id: user.id }, data: { emailConfirmedAt: now } });
      await audit(user.id, "EMAIL_CONFIRMED", "user", user.id, row.email);
    }
    return { state: "confirmed", userId: user.id };
  }
  // A link to an address the holder has since moved away from, or stopped moving to.
  if (row.email !== user.pendingEmail) return { state: "replaced", userId: user.id };

  const taken = await prisma.user.findFirst({ where: { email: row.email, id: { not: user.id } }, select: { id: true } });
  let moved = 0;
  if (!taken) {
    try {
      moved = (await prisma.user.updateMany({ where: { id: user.id, email: user.email, pendingEmail: row.email }, data: { email: row.email, pendingEmail: null, emailConfirmedAt: now } })).count;
    } catch {
      // The unique email index decides a race with a sign-up landing on the same address.
      moved = 0;
    }
  }
  if (moved !== 1) {
    await prisma.user.updateMany({ where: { id: user.id, pendingEmail: row.email }, data: { pendingEmail: null } });
    await audit(user.id, "EMAIL_CHANGE_REFUSED", "user", user.id, `${row.email} belongs to another account`);
    return { state: "taken", userId: user.id };
  }
  await prisma.emailConfirmation.deleteMany({ where: { userId: user.id, ...unset("usedAt") } });
  // What endSessions in lib/auth.ts does. That file reads the request's cookies, so nothing under lib imports it.
  const keep = options.keepSessionId;
  await prisma.serverSession.deleteMany({ where: keep ? { userId: user.id, id: { not: keep } } : { userId: user.id } });
  await audit(user.id, "EMAIL_CHANGED", "user", user.id, `${user.email} to ${row.email}`);
  // The old address no longer belongs to an account, so this is email only, with no in-app copy.
  await sendSecret(
    user.email,
    "Your UPB Capital email changed",
    `The email on your UPB Capital account is now ${maskEmail(row.email)}. Other devices were signed out. If this was not you, write the desk now.`,
  );
  return { state: "changed", userId: user.id };
}

export type ChangeResult = { error: string | null };

// The holder asks to move the account to a new address, with their password. The address changes only when the
// link sent there is used. The current address hears at once.
export async function requestEmailChange(user: Pick<User, "id" | "email" | "passwordHash">, input: { email: string; password: string }, now = new Date()): Promise<ChangeResult> {
  const email = input.email.trim().toLowerCase();
  if (demoSeat(user.email)) return { error: "Demo accounts keep their address." };
  if (!(await consumeRateLimit(`email-change:${user.id}`, 5, HOUR, now.getTime()))) return { error: "Too many tries. Wait an hour, then try again." };
  if (!(await bcrypt.compare(input.password, user.passwordHash))) return { error: "That is not your current password." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: "Enter a valid email." };
  if (email === user.email) return { error: "That is already the address on this account." };
  // The same addresses sign-up refuses.
  if (demoAddress(email)) return { error: "That address is for the demo desk. Use your own email." };
  if (process.env.DESK_EMAIL && email === process.env.DESK_EMAIL.trim().toLowerCase()) return { error: "That address belongs to the desk." };
  if (isReleaseBuild(process.env) && !deliverable(email)) return { error: "That address can't receive mail." };
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) return { error: "An account with that email is already on the desk." };
  await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: email } });
  const sent = await sendConfirmation(user.id, email, now);
  if (sent.error) return sent;
  await audit(user.id, "EMAIL_CHANGE_REQUESTED", "user", user.id, email);
  await sendAlert(
    user.email,
    "A new email was asked for on your UPB Capital account",
    `Someone signed in to your account asked to move it to ${maskEmail(email)}. Nothing changes until that address is confirmed. If this was not you, change your password on the security page and write the desk now.`,
  );
  return { error: null };
}

export async function cancelEmailChange(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { pendingEmail: true } });
  if (!user?.pendingEmail) return;
  await prisma.emailConfirmation.deleteMany({ where: { userId, email: user.pendingEmail, ...unset("usedAt") } });
  await prisma.user.update({ where: { id: userId }, data: { pendingEmail: null } });
  await audit(userId, "EMAIL_CHANGE_CANCELED", "user", userId, user.pendingEmail);
}
