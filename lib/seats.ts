import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import type { SeatApproval, User } from "@prisma/client";
import { accountLocked } from "@/lib/access";
import type { GatedAction } from "@/lib/action-gates";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { demoAddress, isReleaseBuild } from "@/lib/deploy";
import { notify, sendAlert, sendSecret } from "@/lib/email";
import { money } from "@/lib/format";
import { signupConsent } from "@/lib/legal";
import { deliverable } from "@/lib/mail-config";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";

// Seats on a firm's account. A bank, credit union or fund puts several people on one sale: an analyst reads the file,
// a trader bids, an officer approves and signs. Each seat is its own User row, with its own email, password, second
// factor and sessions, and principalId naming the firm's account. Signed in, a seat acts as the firm (lib/auth.ts),
// so every check on user.id holds for the firm, and `actor` says which person it is. Credentials stay the person's.

// The account a session acts for, with the seat that is signed in when it is a firm's seat.
export type ActingUser = User & { actor?: { id: string; name: string; email: string; seatRole: string; bidLimitCents: number | null } };

export const SEAT_ROLES = ["VIEW", "TRADE", "APPROVE", "MANAGE"] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];

export const SEAT_ROLE_LABELS: Record<SeatRole, string> = { VIEW: "View", TRADE: "Trade", APPROVE: "Approve", MANAGE: "Manage" };
export const SEAT_ROLE_HINTS: Record<SeatRole, string> = {
  VIEW: "Sees what the firm sees and commits to nothing.",
  TRADE: "Bids, lists and writes. Bids above a limit wait for approval.",
  APPROVE: "Trades, approves held bids, accepts awards and signs.",
  MANAGE: "Everything, and adds or removes seats.",
};

export const SEAT_INVITE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
// Invitations one account may send in an hour, resends included.
const INVITES_PER_HOUR = 10;

// Seats are for firms. An individual note seller is one person, and the desk's own staff get desk roles.
export function takesSeats(role: string) {
  return role === "BUYER" || role === "INSTITUTIONAL_SELLER" || role === "BROKER";
}

// Accounts of their own, for counts of signups and accounts: neither a current seat nor a removed one, which keeps its
// row with principalId cleared. Spread into a where that has no AND of its own.
export function ownAccounts() {
  return { AND: [unset("principalId"), unset("seatAddedAt")] };
}

export function isSeatRole(value: unknown): value is SeatRole {
  return typeof value === "string" && (SEAT_ROLES as readonly string[]).includes(value);
}

// The person signed in: the seat, or the account itself. Passwords, second factors, sessions and login codes key on
// this, never on the firm.
export function personId(user: { id: string; actor?: { id: string } | null }) {
  return user.actor?.id ?? user.id;
}

// The firm's own login manages everything. A seat with a role this code doesn't know can only look.
export function seatRoleOf(user: User | ActingUser): SeatRole {
  const actor = (user as ActingUser).actor;
  if (!actor) return "MANAGE";
  return isSeatRole(actor.seatRole) ? actor.seatRole : "VIEW";
}

export function canApproveBids(user: User | ActingUser) {
  const role = seatRoleOf(user);
  return role === "APPROVE" || role === "MANAGE";
}

export function canManageSeats(user: User | ActingUser) {
  return seatRoleOf(user) === "MANAGE";
}

// Membership, checkout, the billing portal and a trial commit the firm's money, so the owner or a managing seat
// decides them. Null lets it through.
export function billingBlock(user: User | ActingUser) {
  return canManageSeats(user) ? null : "Only a managing seat or the account owner can change the firm's membership and billing.";
}

// What the second-factor rule reads: the person's own authenticator, on the firm's role and standing.
export function secondFactorSubject(account: { user: User; person: User }) {
  return { role: account.user.role, email: account.person.email, totpEnabled: account.person.totpEnabled, accountStatus: account.user.accountStatus };
}

// Who a session's user acts as, and who they are. A seat acts for its firm. A seat whose firm is locked or deleted is
// out, and so is one that was removed: it keeps its row for the record but has no account of its own.
export async function resolveSessionUser(sessionUserId: string): Promise<{ user: ActingUser; person: User } | null> {
  const person = await prisma.user.findUnique({ where: { id: sessionUserId } });
  if (!person || accountLocked(person.accountStatus) || person.deletedAt) return null;
  if (!person.principalId) return person.seatAddedAt ? null : { user: person, person };
  if (person.role === "ADMIN") return null;
  const principal = await prisma.user.findUnique({ where: { id: person.principalId } });
  // A seat can't hold seats, and it always has its firm's role.
  if (!principal || principal.principalId || principal.role === "ADMIN" || principal.role !== person.role) return null;
  if (accountLocked(principal.accountStatus) || principal.deletedAt) return null;
  const actor = { id: person.id, name: person.name, email: person.email, seatRole: person.seatRole ?? "VIEW", bidLimitCents: person.seatBidLimitCents ?? null };
  return { user: { ...principal, actor }, person };
}

function who(action: GatedAction) {
  return action === "award" || action === "sign" ? "An approving or managing seat, or the account owner," : "A trading, approving or managing seat, or the account owner,";
}

// Whether the seat signed in may do this for its firm. The firm's own login always may.
export async function seatGate(user: User | ActingUser, action: GatedAction): Promise<string | null> {
  if (!(user as ActingUser).actor) return null;
  const role = seatRoleOf(user);
  if (role === "VIEW") return `Your seat is view only. ${who(action)} can do this.`;
  if (role === "TRADE" && action === "award") return `Your seat can't accept awards. ${who(action)} can.`;
  if (role === "TRADE" && action === "sign") return `Your seat can't sign. ${who(action)} can.`;
  return null;
}

// A trading seat's bid above its limit. amount is in dollars, as bids are.
export function overSeatLimit(user: User | ActingUser, amount: number | null) {
  const actor = (user as ActingUser).actor;
  if (!actor || seatRoleOf(user) !== "TRADE" || actor.bidLimitCents == null || amount == null) return false;
  return Math.round(amount * 100) > actor.bidLimitCents;
}

// For the bid paths that can't wait for approval, such as buy it now or a counter: the refusal, or null.
export function seatLimitBlock(user: User | ActingUser, amount: number | null) {
  if (!overSeatLimit(user, amount)) return null;
  return `That is above your bid limit of ${money(((user as ActingUser).actor?.bidLimitCents ?? 0) / 100)}. An approving or managing seat, or the account owner, can place it.`;
}

// ---------------------------------------------------------------------------------------------------------------
// The team: invitations, roles, limits and removal.

export function seatTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function seatLink(token: string, appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  return `${appUrl}/seat/${token}`;
}

export function firmName(account: { name: string; companyName?: string | null }) {
  return account.companyName || account.name;
}

// Why this account can't change its team, or null. Only the firm's own login and its managing seats can.
function managerBlock(account: ActingUser) {
  if (account.role === "ADMIN") return "Desk accounts don't take seats. Desk staff get a desk role instead.";
  if (account.principalId) return "A seat can't have seats of its own.";
  if (!canManageSeats(account)) return "Only a managing seat or the account owner can change the team.";
  return null;
}

// A bid limit typed in dollars. Blank means none.
export function readBidLimit(raw: unknown): { error: string } | { error: null; cents: number | null } {
  const text = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!text) return { error: null, cents: null };
  const dollars = Number(text);
  if (!Number.isFinite(dollars) || dollars <= 0) return { error: "Enter the bid limit in dollars, or leave it blank for none." };
  return { error: null, cents: Math.round(dollars * 100) };
}

// A removed seat's address can be invited back. Any other account's can't.
function removedSeat(user: { principalId: string | null; seatAddedAt: Date | null }) {
  return !user.principalId && Boolean(user.seatAddedAt);
}

async function sendInviteLink(invite: { email: string; seatRole: string }, account: ActingUser, token: string) {
  const role = isSeatRole(invite.seatRole) ? SEAT_ROLE_LABELS[invite.seatRole].toLowerCase() : "view";
  const from = account.actor?.name ?? account.name;
  await sendSecret(
    invite.email,
    `A seat on ${firmName(account)} at UPB Capital`,
    `${from} added you to ${firmName(account)}'s account on UPB Capital, with a ${role} seat. Open this link within ${SEAT_INVITE_DAYS} days to set your name and password:\n\n${seatLink(token)}\n\nYou sign in with your own email and password, and set up two-step sign-in if the desk asks for it. If you weren't expecting this, ignore it and nothing happens.`,
  );
}

export type SeatInviteResult = { error: string } | { error: null; inviteId: string; token: string };

export async function inviteSeat(input: { account: ActingUser; email: string; name?: string; seatRole: string; bidLimit?: unknown; now?: Date }): Promise<SeatInviteResult> {
  const { account } = input;
  const now = input.now ?? new Date();
  const blocked = managerBlock(account);
  if (blocked) return { error: blocked };
  if (!takesSeats(account.role)) return { error: "Seats are for firms: buyers, institutions and brokers." };
  // An account the desk hasn't vetted sends no invitations, so sign-ups can't use the desk to mail strangers.
  if (account.accountStatus !== "APPROVED") return { error: "Seats open once the desk approves this account." };
  const email = input.email.trim().toLowerCase();
  const name = (input.name ?? "").trim().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: "Enter a valid email." };
  if (!isSeatRole(input.seatRole)) return { error: "Choose view, trade, approve or manage." };
  const limit = readBidLimit(input.bidLimit);
  if (limit.error !== null) return { error: limit.error };
  if (demoAddress(email)) return { error: "That address is for the demo desk. Invite the person's own email." };
  if (process.env.DESK_EMAIL && email === process.env.DESK_EMAIL.trim().toLowerCase()) return { error: "That address belongs to the desk." };
  if (isReleaseBuild(process.env) && !deliverable(email)) return { error: "That address can't receive mail." };
  const existing = await prisma.user.findUnique({ where: { email }, select: { principalId: true, seatAddedAt: true } });
  if (existing && !removedSeat(existing)) return { error: "That address already has an account on UPB Capital, so it can't take a seat. Invite another address." };
  const open = await prisma.seatInvite.findFirst({ where: { principalId: account.id, email, AND: [unset("acceptedAt"), unset("revokedAt")], expiresAt: { gt: now } }, select: { id: true } });
  if (open) return { error: "That address already has an open invitation. Resend it from the list instead." };
  if (!(await consumeRateLimit(`seat-invite:${account.id}`, INVITES_PER_HOUR, 60 * 60 * 1000, now.getTime()))) {
    return { error: "Too many invitations this hour. Wait and try again." };
  }
  const token = randomBytes(32).toString("hex");
  const invite = await prisma.seatInvite.create({
    data: {
      principalId: account.id,
      email,
      name,
      seatRole: input.seatRole,
      // A limit only binds a trading seat. The others approve, so they have none.
      bidLimitCents: input.seatRole === "TRADE" ? limit.cents : null,
      tokenHash: seatTokenHash(token),
      invitedById: personId(account),
      expiresAt: new Date(now.getTime() + SEAT_INVITE_DAYS * DAY),
    },
  });
  await sendInviteLink(invite, account, token);
  await audit(account.id, "SEAT_INVITED", "seatInvite", invite.id, `${email} · ${SEAT_ROLE_LABELS[input.seatRole]}`, account.actor?.id ?? null);
  return { error: null, inviteId: invite.id, token };
}

async function ownInvite(account: ActingUser, inviteId: string) {
  const invite = await prisma.seatInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.principalId !== account.id) return { error: "That invitation isn't on this account." } as const;
  if (invite.acceptedAt) return { error: "That invitation was already accepted." } as const;
  if (invite.revokedAt) return { error: "That invitation was withdrawn." } as const;
  return { error: null, invite } as const;
}

// A fresh link and seven more days. The earlier link stops working.
export async function resendSeatInvite(account: ActingUser, inviteId: string, now = new Date()): Promise<SeatInviteResult> {
  const blocked = managerBlock(account);
  if (blocked) return { error: blocked };
  const found = await ownInvite(account, inviteId);
  if (found.error !== null) return { error: found.error };
  if (!(await consumeRateLimit(`seat-invite:${account.id}`, INVITES_PER_HOUR, 60 * 60 * 1000, now.getTime()))) {
    return { error: "Too many invitations this hour. Wait and try again." };
  }
  const token = randomBytes(32).toString("hex");
  const moved = await prisma.seatInvite.updateMany({
    where: { id: inviteId, AND: [unset("acceptedAt"), unset("revokedAt")] },
    data: { tokenHash: seatTokenHash(token), expiresAt: new Date(now.getTime() + SEAT_INVITE_DAYS * DAY) },
  });
  if (moved.count !== 1) return { error: "That invitation was answered a moment ago." };
  await sendInviteLink(found.invite, account, token);
  await audit(account.id, "SEAT_INVITE_RESENT", "seatInvite", inviteId, found.invite.email, account.actor?.id ?? null);
  return { error: null, inviteId, token };
}

export async function revokeSeatInvite(account: ActingUser, inviteId: string, now = new Date()) {
  const blocked = managerBlock(account);
  if (blocked) return { error: blocked } as const;
  const found = await ownInvite(account, inviteId);
  if (found.error !== null) return { error: found.error } as const;
  const done = await prisma.seatInvite.updateMany({ where: { id: inviteId, AND: [unset("acceptedAt"), unset("revokedAt")] }, data: { revokedAt: now } });
  if (done.count !== 1) return { error: "That invitation was answered a moment ago." } as const;
  await audit(account.id, "SEAT_INVITE_REVOKED", "seatInvite", inviteId, found.invite.email, account.actor?.id ?? null);
  return { error: null } as const;
}

type OpenInvite = { state: "open"; email: string; name: string; seatRole: SeatRole; firm: string } | { state: "closed" };

// What the invitation page shows. A used, withdrawn, lapsed or unknown link reads the same, so it says nothing.
export async function openSeatInvite(token: string, now = new Date()): Promise<OpenInvite> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { state: "closed" };
  const invite = await prisma.seatInvite.findUnique({ where: { tokenHash: seatTokenHash(token) } });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() <= now.getTime()) return { state: "closed" };
  const principal = await prisma.user.findUnique({ where: { id: invite.principalId } });
  if (!principal || principal.principalId || accountLocked(principal.accountStatus) || principal.deletedAt) return { state: "closed" };
  return { state: "open", email: invite.email, name: invite.name, seatRole: isSeatRole(invite.seatRole) ? invite.seatRole : "VIEW", firm: firmName(principal) };
}

export type SeatAcceptResult = { error: string; closed?: boolean } | { error: null; user: { id: string; email: string; role: string; name: string } };

// The invitee sets a name and password. The link went to the address, so it proves they own it.
export async function acceptSeatInvite(input: { token: string; name: string; password: string; confirm: string; terms: FormDataEntryValue | null; now?: Date }): Promise<SeatAcceptResult> {
  const now = input.now ?? new Date();
  const closed = { error: "That invitation has expired, was withdrawn or was already used. Ask for a new one.", closed: true };
  const name = input.name.trim().slice(0, 120);
  if (name.length < 2) return { error: "Enter your name." };
  if (input.password.length < 8) return { error: "Use at least 8 characters." };
  if (input.password !== input.confirm) return { error: "Those passwords do not match." };
  if (!/^[0-9a-f]{64}$/.test(input.token)) return closed;
  const invite = await prisma.seatInvite.findUnique({ where: { tokenHash: seatTokenHash(input.token) } });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() <= now.getTime()) return closed;
  const principal = await prisma.user.findUnique({ where: { id: invite.principalId } });
  if (!principal || principal.principalId || principal.role === "ADMIN" || accountLocked(principal.accountStatus) || principal.deletedAt) return closed;
  const existing = await prisma.user.findUnique({ where: { email: invite.email } });
  if (existing && !removedSeat(existing)) return { error: "That address already has an account on UPB Capital. Sign in with it instead, or ask for a seat on another address." };
  const consent = await signupConsent(input.terms, now);
  if (consent.error !== null) return { error: consent.error };
  const claimed = await prisma.seatInvite.updateMany({ where: { id: invite.id, AND: [unset("acceptedAt"), unset("revokedAt")] }, data: { acceptedAt: now } });
  if (claimed.count !== 1) return closed;
  const seatRole = isSeatRole(invite.seatRole) ? invite.seatRole : "VIEW";
  const data = {
    name,
    passwordHash: await bcrypt.hash(input.password, 10),
    role: principal.role,
    // The seat's own standing. What it may see and do follows the firm's (resolveSessionUser).
    accountStatus: "APPROVED" as const,
    companyName: principal.companyName,
    principalId: principal.id,
    seatRole,
    seatBidLimitCents: seatRole === "TRADE" ? invite.bidLimitCents : null,
    seatAddedById: invite.invitedById,
    seatAddedAt: now,
    emailConfirmedAt: now,
    // The firm gets the buyer mail. A seat reads it in the firm's inbox, so it isn't sent twice.
    digest: "OFF" as const,
    ...consent.data,
  };
  let seat: User;
  try {
    seat = existing
      ? await prisma.user.update({ where: { id: existing.id }, data })
      : await prisma.user.create({ data: { email: invite.email, ...data } });
  } catch {
    // A sign-up with the same address landed in the same moment, and the unique index chose it.
    await prisma.seatInvite.updateMany({ where: { id: invite.id, acceptedAt: now }, data: { acceptedAt: null } });
    return { error: "That address already has an account on UPB Capital. Sign in with it instead, or ask for a seat on another address." };
  }
  await prisma.seatInvite.update({ where: { id: invite.id }, data: { acceptedById: seat.id } });
  await audit(principal.id, "SEAT_ADDED", "user", seat.id, `${seat.email} · ${SEAT_ROLE_LABELS[seatRole]}`, seat.id);
  await notify(principal.email, `New seat · ${seat.name}`, `${seat.name} (${seat.email}) accepted a ${SEAT_ROLE_LABELS[seatRole].toLowerCase()} seat on ${firmName(principal)}'s account.`);
  return { error: null, user: { id: seat.id, email: seat.email, role: seat.role, name: seat.name } };
}

async function ownSeat(account: ActingUser, seatId: string) {
  const blocked = managerBlock(account);
  if (blocked) return { error: blocked } as const;
  const seat = await prisma.user.findUnique({ where: { id: seatId } });
  if (!seat || seat.principalId !== account.id) return { error: "That seat isn't on this account." } as const;
  // Someone else changes a managing seat's own seat, so nobody locks themselves out by mistake.
  if (seat.id === account.actor?.id) return { error: "Ask the account owner or another managing seat to change your own seat." } as const;
  return { error: null, seat } as const;
}

export async function updateSeat(input: { account: ActingUser; seatId: string; seatRole: string; bidLimit?: unknown }) {
  const found = await ownSeat(input.account, input.seatId);
  if (found.error !== null) return { error: found.error } as const;
  if (!isSeatRole(input.seatRole)) return { error: "Choose view, trade, approve or manage." } as const;
  const limit = readBidLimit(input.bidLimit);
  if (limit.error !== null) return { error: limit.error } as const;
  const cents = input.seatRole === "TRADE" ? limit.cents : null;
  await prisma.user.update({ where: { id: found.seat.id }, data: { seatRole: input.seatRole, seatBidLimitCents: cents } });
  const line = `${found.seat.email} · ${SEAT_ROLE_LABELS[input.seatRole]}${cents != null ? ` · limit ${money(cents / 100)}` : ""}`;
  await audit(input.account.id, "SEAT_CHANGED", "user", found.seat.id, line, input.account.actor?.id ?? null);
  return { error: null } as const;
}

// The seat stops acting for the firm at once: its sessions end and principalId clears. The row stays, suspended, so
// the audit log still names who did what, and the address can be invited back.
export async function removeSeat(account: ActingUser, seatId: string, now = new Date()) {
  const found = await ownSeat(account, seatId);
  if (found.error !== null) return { error: found.error } as const;
  const { seat } = found;
  await prisma.user.update({ where: { id: seat.id }, data: { principalId: null, accountStatus: "SUSPENDED", pushEnabled: false } });
  await prisma.serverSession.deleteMany({ where: { userId: seat.id } });
  await prisma.pushSubscription.deleteMany({ where: { userId: seat.id } });
  await prisma.seatApproval.updateMany({ where: { principalId: account.id, requestedById: seat.id, status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: now, reason: "The seat was removed." } });
  await audit(account.id, "SEAT_REMOVED", "user", seat.id, seat.email, account.actor?.id ?? null);
  await sendAlert(seat.email, `Your seat on ${firmName(account)} was removed`, `Your seat on ${firmName(account)}'s UPB Capital account was removed, and you were signed out. If this is a mistake, ask the account owner.`);
  return { error: null } as const;
}

// The team page's lists: seats, open invitations, and the firm's own login first.
export async function teamOf(accountId: string, now = new Date()) {
  const [seats, invites] = await Promise.all([
    prisma.user.findMany({
      where: { principalId: accountId },
      select: { id: true, name: true, email: true, seatRole: true, seatBidLimitCents: true, seatAddedAt: true, totpEnabled: true },
      orderBy: { seatAddedAt: "asc" },
    }),
    prisma.seatInvite.findMany({ where: { principalId: accountId, AND: [unset("acceptedAt"), unset("revokedAt")] }, orderBy: { createdAt: "desc" } }),
  ]);
  return { seats, invites: invites.map((invite) => ({ ...invite, lapsed: invite.expiresAt.getTime() <= now.getTime() })) };
}

// Seats by account, for the desk's account pages.
export async function seatsByAccount(accountIds: string[]) {
  if (!accountIds.length) return new Map<string, { id: string; name: string; email: string; seatRole: string | null }[]>();
  const seats = await prisma.user.findMany({
    where: { principalId: { in: accountIds } },
    select: { id: true, name: true, email: true, seatRole: true, principalId: true },
    orderBy: { seatAddedAt: "asc" },
  });
  const byAccount = new Map<string, { id: string; name: string; email: string; seatRole: string | null }[]>();
  for (const seat of seats) byAccount.set(seat.principalId!, [...(byAccount.get(seat.principalId!) ?? []), seat]);
  return byAccount;
}

export function seatRoleLabel(role: string | null | undefined) {
  return isSeatRole(role) ? SEAT_ROLE_LABELS[role] : SEAT_ROLE_LABELS.VIEW;
}

// What the firm's seats did, newest first, from the audit log.
export async function seatActivity(accountId: string, take = 30) {
  const events = await prisma.auditEvent.findMany({
    where: { actorId: accountId, seatId: { isSet: true } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
  const ids = [...new Set(events.map((event) => event.seatId).filter((id): id is string => Boolean(id)))];
  const people = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]));
  return events.map((event) => ({ ...event, seatName: (event.seatId && people.get(event.seatId)) || "A former seat" }));
}

// "by Dana Reyes" beside each of the firm's own bids a seat placed, and who approved it when it waited.
export async function seatBylines(accountId: string, inquiryIds: string[]) {
  const lines = new Map<string, string>();
  if (!inquiryIds.length) return lines;
  const [approvals, placed] = await Promise.all([
    prisma.seatApproval.findMany({ where: { principalId: accountId, status: "APPROVED", inquiryId: { in: inquiryIds } }, select: { inquiryId: true, requestedById: true, decidedById: true } }),
    prisma.auditEvent.findMany({ where: { actorId: accountId, action: "SEAT_BID", entityId: { in: inquiryIds } }, select: { entityId: true, seatId: true } }),
  ]);
  const ids = [...approvals.flatMap((row) => [row.requestedById, row.decidedById ?? ""]), ...placed.map((row) => row.seatId ?? "")].filter(Boolean);
  const names = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]));
  for (const row of placed) if (row.seatId && names.has(row.seatId)) lines.set(row.entityId, `by ${names.get(row.seatId)}`);
  for (const row of approvals) {
    if (!row.inquiryId) continue;
    const approver = row.decidedById === accountId ? "the account owner" : names.get(row.decidedById ?? "");
    lines.set(row.inquiryId, `by ${names.get(row.requestedById) ?? "a former seat"}${approver ? `, approved by ${approver}` : ""}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Bids above a trading seat's limit. The bid isn't placed: its form waits here until an approving seat or the owner
// approves it, which places it through the bid form's own code with every check run again, or declines it.

// The form as typed, so the same bid can be placed later. Next's own action fields are left out.
export function formFields(formData: FormData) {
  const fields: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string" && !name.startsWith("$")) fields[name] = value.slice(0, 4000);
  }
  return fields;
}

export function fieldsForm(payload: unknown) {
  const form = new FormData();
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const [name, value] of Object.entries(payload)) if (typeof value === "string") form.append(name, value);
  }
  return form;
}

// Everyone who can approve the firm's held bids: the owner and its approving and managing seats.
async function approversOf(account: { id: string; email: string }) {
  const seats = await prisma.user.findMany({
    where: { principalId: account.id, seatRole: { in: ["APPROVE", "MANAGE"] }, accountStatus: "APPROVED", ...unset("deletedAt") },
    select: { id: true, email: true },
  });
  return [{ id: account.id, email: account.email }, ...seats];
}

export async function holdSeatBid(
  user: ActingUser,
  input: { listing: { id: string; title: string; bidDeadline: Date | null }; noteId: string; amount: number; fields: Record<string, string>; now?: Date },
) {
  const actor = user.actor;
  if (!actor) return { error: "Only a seat's bid waits for approval." } as const;
  const now = input.now ?? new Date();
  const waiting = await prisma.seatApproval.findFirst({
    where: { principalId: user.id, requestedById: actor.id, listingId: input.listing.id, status: "PENDING", ...(input.noteId ? { noteId: input.noteId } : unset("noteId")) },
    select: { id: true },
  });
  if (waiting) return { error: "Your bid here is already waiting for approval. Withdraw it from the team page to send a different one." } as const;
  const approval = await prisma.seatApproval.create({
    data: {
      principalId: user.id,
      requestedById: actor.id,
      kind: "BID",
      listingId: input.listing.id,
      noteId: input.noteId || null,
      amountCents: Math.round(input.amount * 100),
      payload: input.fields,
      // Past the deadline the bid couldn't be placed anyway.
      ...(input.listing.bidDeadline ? { expiresAt: input.listing.bidDeadline } : {}),
      createdAt: now,
    },
  });
  await audit(user.id, "SEAT_BID_HELD", "seatApproval", approval.id, `${input.listing.title} · ${money(input.amount)} · limit ${money((actor.bidLimitCents ?? 0) / 100)}`, actor.id);
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/account/team#approvals`;
  for (const approver of await approversOf(user)) {
    if (approver.id === actor.id) continue;
    await notify(
      approver.email,
      `Bid waiting for approval · ${input.listing.title}`,
      `${actor.name} wants to bid ${money(input.amount)} on ${input.listing.title}, above their limit of ${money((actor.bidLimitCents ?? 0) / 100)}. Approve or decline it on the team page: ${link}`,
    );
  }
  return { error: null, id: approval.id } as const;
}

type Decision = { error: string } | { error: null; approval: SeatApproval };

// A held bid this person may decide now. One past the listing's deadline expires on the spot.
async function decidable(user: ActingUser, approvalId: string, now: Date): Promise<Decision> {
  const approval = await prisma.seatApproval.findUnique({ where: { id: approvalId } });
  if (!approval || approval.principalId !== user.id) return { error: "That bid isn't waiting on this account." };
  if (approval.status !== "PENDING") return { error: "That bid was already decided." };
  if (approval.expiresAt && approval.expiresAt.getTime() <= now.getTime()) {
    await expireApproval(approval, now);
    return { error: "The bid deadline passed before anyone approved it, so it can't be placed." };
  }
  return { error: null, approval };
}

function approverBlock(user: ActingUser, requestedById: string) {
  if (!canApproveBids(user)) return "Only an approving or managing seat, or the account owner, can decide a held bid.";
  if (personId(user) === requestedById) return "You can't decide your own bid. Another approving seat or the account owner can, or you can withdraw it.";
  return null;
}

async function requester(approval: { requestedById: string }) {
  return prisma.user.findUnique({ where: { id: approval.requestedById }, select: { id: true, name: true, email: true } });
}

async function listingTitle(listingId: string | null) {
  if (!listingId) return "the listing";
  return (await prisma.listing.findUnique({ where: { id: listingId }, select: { title: true } }))?.title ?? "the listing";
}

export type ApproveResult = { error: string } | { error: null; inquiryId: string; listingId: string };

// The approver places the bid, through the bid form's own path, with every check run as of now.
export async function approveSeatBid(user: ActingUser, approvalId: string, now = new Date()): Promise<ApproveResult> {
  const found = await decidable(user, approvalId, now);
  if (found.error !== null) return { error: found.error };
  const { approval } = found;
  const blocked = approverBlock(user, approval.requestedById);
  if (blocked) return { error: blocked };
  // Claimed first, so two approvers at once place one bid.
  const decider = personId(user);
  const claimed = await prisma.seatApproval.updateMany({ where: { id: approval.id, status: "PENDING" }, data: { status: "APPROVED", decidedById: decider, decidedAt: now } });
  if (claimed.count !== 1) return { error: "That bid was decided a moment ago." };
  const { placeInquiry } = await import("@/lib/bid-form");
  const placed = await placeInquiry(user, fieldsForm(approval.payload), { approved: true, now });
  if (placed.error !== null || !placed.inquiryId) {
    // The bid didn't go in, so it waits again. The approver reads why.
    await prisma.seatApproval.updateMany({ where: { id: approval.id, status: "APPROVED", decidedById: decider }, data: { status: "PENDING", decidedById: null, decidedAt: null } });
    return { error: placed.error ?? "The bid couldn't be placed." };
  }
  await prisma.seatApproval.update({ where: { id: approval.id }, data: { inquiryId: placed.inquiryId } });
  const [asker, title] = await Promise.all([requester(approval), listingTitle(approval.listingId)]);
  const by = user.actor?.name ?? "the account owner";
  await audit(user.id, "SEAT_BID_APPROVED", "seatApproval", approval.id, `${title} · ${money(approval.amountCents / 100)} · asked by ${asker?.name ?? "a former seat"}`, user.actor?.id ?? null);
  if (asker) await notify(asker.email, `Bid approved · ${title}`, `${by} approved your bid of ${money(approval.amountCents / 100)} on ${title}, and it is placed.`);
  return { error: null, inquiryId: placed.inquiryId, listingId: approval.listingId ?? "" };
}

export async function declineSeatBid(user: ActingUser, approvalId: string, reason: string, now = new Date()) {
  const why = reason.replace(/\s+/g, " ").trim().slice(0, 500);
  if (why.length < 3) return { error: "Say why you're declining, in a few words. The seat reads it." } as const;
  const found = await decidable(user, approvalId, now);
  if (found.error !== null) return { error: found.error } as const;
  const { approval } = found;
  const blocked = approverBlock(user, approval.requestedById);
  if (blocked) return { error: blocked } as const;
  const done = await prisma.seatApproval.updateMany({ where: { id: approval.id, status: "PENDING" }, data: { status: "DECLINED", decidedById: personId(user), decidedAt: now, reason: why } });
  if (done.count !== 1) return { error: "That bid was decided a moment ago." } as const;
  const [asker, title] = await Promise.all([requester(approval), listingTitle(approval.listingId)]);
  await audit(user.id, "SEAT_BID_DECLINED", "seatApproval", approval.id, `${title} · ${money(approval.amountCents / 100)} · ${why}`, user.actor?.id ?? null);
  if (asker) await notify(asker.email, `Bid declined · ${title}`, `${user.actor?.name ?? "The account owner"} declined your bid of ${money(approval.amountCents / 100)} on ${title}. Reason: ${why} Nothing was placed.`);
  return { error: null } as const;
}

// The seat that asked takes its bid back before anyone decides it.
export async function withdrawSeatBid(user: ActingUser, approvalId: string, now = new Date()) {
  const approval = await prisma.seatApproval.findUnique({ where: { id: approvalId } });
  if (!approval || approval.principalId !== user.id || approval.requestedById !== personId(user)) return { error: "That bid isn't yours to withdraw." } as const;
  const done = await prisma.seatApproval.updateMany({ where: { id: approval.id, status: "PENDING" }, data: { status: "WITHDRAWN", decidedById: personId(user), decidedAt: now } });
  if (done.count !== 1) return { error: "That bid was already decided." } as const;
  await audit(user.id, "SEAT_BID_WITHDRAWN", "seatApproval", approval.id, `${await listingTitle(approval.listingId)} · ${money(approval.amountCents / 100)}`, user.actor?.id ?? null);
  return { error: null } as const;
}

async function expireApproval(approval: { id: string; requestedById: string; listingId: string | null; amountCents: number }, now: Date) {
  const done = await prisma.seatApproval.updateMany({ where: { id: approval.id, status: "PENDING" }, data: { status: "EXPIRED", decidedAt: now } });
  if (done.count !== 1) return false;
  const [asker, title] = await Promise.all([requester(approval), listingTitle(approval.listingId)]);
  if (asker) await notify(asker.email, `Bid not placed · ${title}`, `The bid deadline on ${title} passed before anyone approved your bid of ${money(approval.amountCents / 100)}, so it was not placed.`);
  return true;
}

// The job: held bids whose listing's deadline has passed close, and the seat that asked hears.
export async function expireSeatApprovals(now = new Date()) {
  const due = await prisma.seatApproval.findMany({ where: { status: "PENDING", expiresAt: { lte: now } }, select: { id: true, requestedById: true, listingId: true, amountCents: true } });
  let expired = 0;
  for (const approval of due) if (await expireApproval(approval, now)) expired += 1;
  return `seat approvals expired ${expired}`;
}

// The held bids on the team page, with who asked and on what.
export async function pendingSeatBids(accountId: string) {
  const rows = await prisma.seatApproval.findMany({ where: { principalId: accountId, status: "PENDING" }, orderBy: { createdAt: "asc" } });
  const [people, listings] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.requestedById))] } }, select: { id: true, name: true, seatBidLimitCents: true } }),
    prisma.listing.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.listingId).filter((id): id is string => Boolean(id)))] } }, select: { id: true, title: true } }),
  ]);
  const person = new Map(people.map((row) => [row.id, row]));
  const title = new Map(listings.map((row) => [row.id, row.title]));
  return rows.map((row) => ({
    ...row,
    requesterName: person.get(row.requestedById)?.name ?? "A former seat",
    limitCents: person.get(row.requestedById)?.seatBidLimitCents ?? null,
    listingTitle: (row.listingId && title.get(row.listingId)) || "A listing",
  }));
}

// One line per account for the desk's pages: a firm's seats with their roles, or the firm a seat acts for.
export async function deskSeatLines(users: { id: string; principalId?: string | null; seatAddedAt?: Date | null; seatRole?: string | null }[]) {
  const lines = new Map<string, string>();
  const seats = await seatsByAccount(users.map((user) => user.id));
  const firmIds = [...new Set(users.map((user) => user.principalId).filter((id): id is string => Boolean(id)))];
  const firms = new Map((firmIds.length ? await prisma.user.findMany({ where: { id: { in: firmIds } }, select: { id: true, name: true, companyName: true } }) : []).map((row) => [row.id, firmName(row)]));
  for (const user of users) {
    const own = seats.get(user.id);
    if (own?.length) lines.set(user.id, `Seats: ${own.map((seat) => `${seat.name} (${seatRoleLabel(seat.seatRole).toLowerCase()})`).join(", ")}`);
    else if (user.principalId) lines.set(user.id, `Seat on ${firms.get(user.principalId) ?? "a removed account"} · ${seatRoleLabel(user.seatRole).toLowerCase()}`);
    else if (user.seatAddedAt) lines.set(user.id, "Former seat. It no longer acts for any account.");
  }
  return lines;
}

// The desk's account list in order, each firm's seats straight after the firm, and the count of accounts of their
// own. A seat whose firm isn't in the list keeps its place.
export function seatsUnderFirms<T extends { id: string; principalId?: string | null; seatAddedAt?: Date | null }>(users: T[]) {
  const listed = new Set(users.map((user) => user.id));
  const under = new Map<string, T[]>();
  for (const user of users) if (user.principalId && listed.has(user.principalId)) under.set(user.principalId, [...(under.get(user.principalId) ?? []), user]);
  const rows = users.flatMap((user) => (user.principalId && listed.has(user.principalId) ? [] : [user, ...(under.get(user.id) ?? [])]));
  return { rows, accounts: users.filter((user) => !user.principalId && !user.seatAddedAt).length };
}
