import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { needsSecondFactor } from "@/lib/access";
import { secureCookies } from "@/lib/deploy";
import { prisma } from "@/lib/prisma";
import { requestMeta } from "@/lib/request-meta";
import { getSettings } from "@/lib/settings";
import { resolveSessionUser, secondFactorSubject, type ActingUser } from "@/lib/seats";
import { PENDING_COOKIE, SESSION_COOKIE, signPending, signSession, verifyPending, verifySession, type SessionToken } from "@/lib/session";
import type { Role } from "@prisma/client";

export async function setSession(payload: SessionToken) {
  const sid = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 24 * 14 * 1000);
  const meta = await requestMeta();
  await prisma.serverSession.create({ data: { id: sid, userId: payload.sub, expiresAt, ipAddress: meta.ipAddress, userAgent: meta.userAgent } });
  const token = await signSession({ ...payload, sid });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
}

export async function clearSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const session = await verifySession(token);
    if (session?.sid) await prisma.serverSession.deleteMany({ where: { id: session.sid } });
  }
  jar.delete(SESSION_COOKIE);
}

export async function setPending(sub: string) {
  const token = await signPending(sub);
  const jar = await cookies();
  jar.set(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 60 * 10,
  });
}

export async function clearPending() {
  const jar = await cookies();
  jar.delete(PENDING_COOKIE);
}

export async function pendingUserId() {
  const jar = await cookies();
  const token = jar.get(PENDING_COOKIE)?.value;
  if (!token) return null;
  return verifyPending(token);
}

// The session's account and the person signed in. They are one row, unless a firm's seat is acting for the firm
// (lib/seats.ts resolveSessionUser). A locked or deleted account stays out even if its lock were lifted.
async function currentAccount() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await verifySession(token);
  if (!session?.sid) return null;
  const row = await prisma.serverSession.findUnique({ where: { id: session.sid } });
  if (!row || row.userId !== session.sub || row.expiresAt.getTime() < Date.now()) return null;
  return resolveSessionUser(session.sub);
}

// The account the session acts for. A seat gets its firm's account, with `actor` naming the person.
export async function getCurrentUser(): Promise<ActingUser | null> {
  return (await currentAccount())?.user ?? null;
}

export async function currentSessionId() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;
  return session?.sid ?? null;
}

// Ends every session for a user, except the one named. The signed cookie stays valid but finds no row.
export async function endSessions(userId: string, exceptSid?: string | null) {
  await prisma.serverSession.deleteMany({ where: exceptSid ? { userId, id: { not: exceptSid } } : { userId } });
}

// The desk's setting, on unless it was turned off. Settings are cached in the process, so this is cheap.
export async function twoStepRequired() {
  return (await getSettings()).requireTwoStep !== false;
}

// secondFactorSetup is only for the security page and its actions, the one place an account that must enroll
// can go before it has. The second factor asked for is the person's own: a seat enrolls its own authenticator.
export async function requireUser(options?: { secondFactorSetup?: boolean }) {
  return (await requirePerson(options)).user;
}

// The account and the person signed in, for the person's own password, second factor and devices. A seat's are its
// own, never the firm's.
export async function requirePerson(options?: { secondFactorSetup?: boolean }) {
  const account = await currentAccount();
  if (!account) redirect("/login");
  if (!options?.secondFactorSetup && needsSecondFactor(secondFactorSubject(account), await twoStepRequired())) redirect("/account/security?setup=1");
  return account;
}

// For API routes, which answer 401 rather than redirect: an account that must enroll gets nothing until it has.
export async function getApiUser() {
  const account = await currentAccount();
  return account && needsSecondFactor(secondFactorSubject(account), await twoStepRequired()) ? null : (account?.user ?? null);
}

export async function requireRole(roles: Role[]) {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/");
  return user;
}
