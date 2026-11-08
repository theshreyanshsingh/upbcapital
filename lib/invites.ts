import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { accountLocked } from "@/lib/access";
import { audit } from "@/lib/audit";
import { demoAddress, isReleaseBuild } from "@/lib/deploy";
import { notifyDesk, sendSecret } from "@/lib/email";
import { roleLabel } from "@/lib/labels";
import { signupConsent } from "@/lib/legal";
import { deliverable } from "@/lib/mail-config";
import { prisma } from "@/lib/prisma";
import { referralCodeFor } from "@/lib/referral";

// The desk invites a buyer, seller or broker it already knows, as DebtX pre-registers buyers. The account is made with
// a password nobody can use and a set-your-password link, which rides the password reset rows with a longer life. The
// person then onboards as anyone who signed up does: terms, two-step sign-in, and for a buyer the verification file.

const DAY = 24 * 60 * 60 * 1000;
export const INVITE_DAYS = 7;

// The hash an invited account carries until its holder sets a password. bcrypt treats a hash that isn't 60 characters
// as a miss, so nothing signs in with it, and the prefix says the invitation is still open.
const INVITE_MARK = "invited:";

export const INVITE_ROLES = ["BUYER", "INSTITUTIONAL_SELLER", "INDIVIDUAL_SELLER", "BROKER"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export function isInviteRole(value: unknown): value is InviteRole {
  return typeof value === "string" && (INVITE_ROLES as readonly string[]).includes(value);
}

// Invited, and the person hasn't set a password yet.
export function invitePending(user: { passwordHash: string; invitedAt?: Date | null }) {
  return Boolean(user.invitedAt) && user.passwordHash.startsWith(INVITE_MARK);
}

// The same hash the password reset flow stores, so one table holds both kinds of link.
export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteLink(token: string, appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  return `${appUrl}/login/welcome?token=${token}`;
}

async function uniqueReferralCode(name: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = referralCodeFor(name);
    if (!(await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } }))) return code;
  }
  return referralCodeFor(`${name}${Date.now()}`);
}

// A fresh link replaces any earlier one, so only the newest email works.
async function issueLink(user: { id: string; email: string; name: string }, inviter: string, now: Date) {
  const token = randomBytes(32).toString("hex");
  await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
  await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY) } });
  await sendSecret(
    user.email,
    "You're invited to UPB Capital",
    `${inviter} at the UPB Capital desk set up an account for you. Open this link within ${INVITE_DAYS} days to choose your password:\n\n${inviteLink(token)}\n\nAfter that you accept the terms and set up two-step sign-in, as every account does. If you weren't expecting this, ignore it and nothing happens.`,
  );
  return token;
}

export type InviteInput = {
  actor: { id: string; name: string };
  name: string;
  email: string;
  companyName: string;
  role: string;
  // The account starts approved, or waits for the desk's review like a sign-up.
  status: string;
  now?: Date;
};

export type InviteResult = { error: string } | { error: null; userId: string; token: string };

export async function inviteUser(input: InviteInput): Promise<InviteResult> {
  const now = input.now ?? new Date();
  const name = input.name.trim().slice(0, 120);
  const email = input.email.trim().toLowerCase();
  const companyName = input.companyName.trim().slice(0, 160);
  if (name.length < 2) return { error: "Enter the person's name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: "Enter a valid email." };
  if (!isInviteRole(input.role)) return { error: "Choose a buyer, seller or broker account." };
  if (input.status !== "APPROVED" && input.status !== "PENDING") return { error: "Choose whether the account starts approved or waits for review." };
  if (input.role === "INSTITUTIONAL_SELLER" && !companyName) return { error: "Institutional accounts need a company name." };
  // The same addresses sign-up refuses.
  if (demoAddress(email)) return { error: "That address is for the demo desk. Invite the person's own email." };
  if (process.env.DESK_EMAIL && email === process.env.DESK_EMAIL.trim().toLowerCase()) return { error: "That address belongs to the desk." };
  if (isReleaseBuild(process.env) && !deliverable(email)) return { error: "That address can't receive mail." };
  const taken = "An account with that email is already on the desk. Find it in the list below instead.";
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) return { error: taken };
  let user;
  try {
    user = await prisma.user.create({
      data: {
        email,
        name,
        companyName,
        role: input.role,
        accountStatus: input.status,
        passwordHash: `${INVITE_MARK}${randomBytes(16).toString("hex")}`,
        referralCode: await uniqueReferralCode(name),
        invitedById: input.actor.id,
        invitedAt: now,
      },
    });
  } catch {
    // The unique email index decides a race with a sign-up landing at the same moment.
    return { error: taken };
  }
  if (input.role === "BROKER") await prisma.brokerProfile.create({ data: { userId: user.id, company: companyName } });
  const token = await issueLink(user, input.actor.name, now);
  await audit(input.actor.id, "INVITE_SENT", "user", user.id, `${roleLabel(input.role)} · ${email} · starts ${input.status.toLowerCase()}`);
  return { error: null, userId: user.id, token };
}

async function pendingInvite(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.invitedAt) return { user: null, error: "That account wasn't invited." } as const;
  if (!invitePending(user)) return { user: null, error: "That invitation was already accepted." } as const;
  return { user, error: null } as const;
}

export async function resendInvite(userId: string, actor: { id: string; name: string }, now = new Date()): Promise<InviteResult> {
  const found = await pendingInvite(userId);
  if (!found.user) return { error: found.error };
  const token = await issueLink(found.user, actor.name, now);
  await prisma.user.update({ where: { id: userId }, data: { invitedAt: now } });
  await audit(actor.id, "INVITE_RESENT", "user", userId, found.user.email);
  return { error: null, userId, token };
}

// The account goes, since nobody ever used it. The audit log keeps the invitation and its withdrawal. Removed only while
// still unaccepted, so a password set in the same moment wins.
export async function withdrawInvite(userId: string, actor: { id: string }) {
  const found = await pendingInvite(userId);
  if (!found.user) return { error: found.error } as const;
  await prisma.passwordReset.deleteMany({ where: { userId } });
  await prisma.brokerProfile.deleteMany({ where: { userId } });
  const removed = await prisma.user.deleteMany({ where: { id: userId, passwordHash: found.user.passwordHash } });
  if (removed.count !== 1) return { error: "That invitation was accepted a moment ago." } as const;
  await audit(actor.id, "INVITE_WITHDRAWN", "user", userId, found.user.email);
  return { error: null } as const;
}

export type AcceptResult = { error: string; expired?: boolean } | { error: null; user: { id: string; email: string; role: string; name: string; accountStatus: string } };

// The person sets a password and agrees to the terms, which opens the account. The link is used up.
export async function acceptInvite(input: { token: string; password: string; confirm: string; terms: FormDataEntryValue | null; now?: Date }): Promise<AcceptResult> {
  const now = input.now ?? new Date();
  if (input.password.length < 8) return { error: "Use at least 8 characters." };
  if (input.password !== input.confirm) return { error: "Those passwords do not match." };
  const row = input.token ? await prisma.passwordReset.findUnique({ where: { tokenHash: tokenHash(input.token) } }) : null;
  const user = row && row.expiresAt.getTime() > now.getTime() ? await prisma.user.findUnique({ where: { id: row.userId } }) : null;
  const expired = { error: "That link has expired or was already used. Ask the desk to send a new one.", expired: true };
  if (!user || accountLocked(user.accountStatus)) return expired;
  if (!invitePending(user)) return expired;
  const consent = await signupConsent(input.terms, now);
  if (consent.error !== null) return { error: consent.error };
  const opened = await prisma.user.updateMany({
    where: { id: user.id, passwordHash: user.passwordHash },
    // The link went to the address, so opening it proves the person owns it (lib/email-confirm.ts).
    data: { passwordHash: await bcrypt.hash(input.password, 10), ...consent.data, emailConfirmedAt: user.emailConfirmedAt ?? now },
  });
  if (opened.count !== 1) return expired;
  await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
  await audit(user.id, "INVITE_ACCEPTED", "user", user.id, `Terms version ${consent.data.termsVersion}`);
  await notifyDesk(
    `Invitation accepted · ${user.name}`,
    user.accountStatus === "APPROVED"
      ? `${user.name} (${user.email}) set a password and opened their ${roleLabel(user.role).toLowerCase()} account.`
      : `${user.name} (${user.email}) set a password. The account waits for the desk's review, so approve it from Accounts.`,
  );
  return { error: null, user: { id: user.id, email: user.email, role: user.role, name: user.name, accountStatus: user.accountStatus } };
}

// The open invitations, for the accounts page.
export function openInvites() {
  return prisma.user.findMany({
    where: { invitedAt: { not: null }, passwordHash: { startsWith: INVITE_MARK } },
    select: { id: true, name: true, email: true, companyName: true, role: true, accountStatus: true, invitedAt: true, invitedById: true },
    orderBy: { invitedAt: "desc" },
  });
}

// Whether a link this old has lapsed, for the list.
export function inviteLapsed(invitedAt: Date | null, now = new Date()) {
  return Boolean(invitedAt && now.getTime() - invitedAt.getTime() > INVITE_DAYS * DAY);
}
