import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PENDING_COOKIE, SESSION_COOKIE, signPending, signSession, verifyPending, verifySession, type SessionToken } from "@/lib/session";
import type { Role } from "@prisma/client";

export async function setSession(payload: SessionToken) {
  const sid = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 24 * 14 * 1000);
  await prisma.serverSession.create({ data: { id: sid, userId: payload.sub, expiresAt } });
  const token = await signSession({ ...payload, sid });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
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
    secure: process.env.NODE_ENV === "production",
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
  if (!session) return null;
  if (session.sid) {
    const row = await prisma.serverSession.findUnique({ where: { id: session.sid } });
    if (!row || row.userId !== session.sub || row.expiresAt.getTime() < Date.now()) return null;
  }
  return prisma.user.findUnique({ where: { id: session.sub } });
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(roles: Role[]) {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/");
  return user;
}
