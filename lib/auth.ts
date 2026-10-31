import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { accountLocked, adminNeedsSecondFactor } from "@/lib/access";
import { secureCookies } from "@/lib/deploy";
import { prisma } from "@/lib/prisma";
import { requestMeta } from "@/lib/request-meta";
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

export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await verifySession(token);
  if (!session?.sid) return null;
  const row = await prisma.serverSession.findUnique({ where: { id: session.sid } });
  if (!row || row.userId !== session.sub || row.expiresAt.getTime() < Date.now()) return null;
  const user = await prisma.user.findUnique({ where: { id: session.sub } });
  if (!user || accountLocked(user.accountStatus)) return null;
  return user;
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

// secondFactorSetup is only for the security page and its actions, the one place a real admin can go before enrolling.
export async function requireUser(options?: { secondFactorSetup?: boolean }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!options?.secondFactorSetup && adminNeedsSecondFactor(user)) redirect("/account/security?setup=1");
  return user;
}

// For API routes, which answer 401 rather than redirect: an admin with no authenticator gets nothing yet.
export async function getApiUser() {
  const user = await getCurrentUser();
  return user && adminNeedsSecondFactor(user) ? null : user;
}

export async function requireRole(roles: Role[]) {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/");
  return user;
}
