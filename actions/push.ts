"use server";

import type { Role } from "@prisma/client";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PUSH_DEVICE_LIMIT, pushEndpointAllowed, pushReady, readPushSubscription, sendPush } from "@/lib/push";
import { consumeRateLimit } from "@/lib/rate-limit";

// Every signed-in role can take notices on a device. Each export below is a public endpoint, so each checks.
const PUSH_ROLES: Role[] = ["ADMIN", "BUYER", "INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "BROKER"];
const WINDOW_MS = 10 * 60 * 1000;

export type PushActionResult = { ok: true; message: string } | { ok: false; error: string };

async function pushUser() {
  const user = await getApiUser();
  if (!user || !PUSH_ROLES.includes(user.role)) return null;
  return user;
}

async function syncEnabled(userId: string) {
  const devices = await prisma.pushSubscription.count({ where: { userId } });
  await prisma.user.update({ where: { id: userId }, data: { pushEnabled: devices > 0 } });
  return devices;
}

// Saves this browser's push address for the signed-in account. A browser keeps one address per site, so one that
// another account saved on this device moves to this account: the person holding the device gets the notices.
export async function subscribePush(input: unknown): Promise<PushActionResult> {
  const user = await pushUser();
  if (!user) return { ok: false, error: "Sign in again to turn on push." };
  if (!pushReady()) return { ok: false, error: "Push isn't set up on this desk yet." };
  if (!(await consumeRateLimit(`push:${user.id}`, 20, WINDOW_MS))) return { ok: false, error: "That is a lot of changes in a few minutes. Try again shortly." };
  const subscription = readPushSubscription(input);
  if (!subscription) return { ok: false, error: "This browser gave a push address the desk can't use." };
  const userAgent = ((await headers()).get("user-agent") ?? "").slice(0, 200);
  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    create: { userId: user.id, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, userAgent },
    update: { userId: user.id, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, userAgent },
  });
  // Ten devices at most. The oldest go first.
  const extra = await prisma.pushSubscription.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    skip: PUSH_DEVICE_LIMIT,
    select: { id: true },
  });
  if (extra.length) await prisma.pushSubscription.deleteMany({ where: { id: { in: extra.map((row) => row.id) } } });
  await syncEnabled(user.id);
  await audit(user.id, "PUSH_ON", "User", user.id, userAgent.slice(0, 120));
  revalidatePath("/account/notifications");
  return { ok: true, message: "Push is on for this device." };
}

// Removes this browser's address. Only the signed-in account's own address can be removed this way.
export async function unsubscribePush(endpoint: unknown): Promise<PushActionResult> {
  const user = await pushUser();
  if (!user) return { ok: false, error: "Sign in again to change push." };
  if (!(await consumeRateLimit(`push:${user.id}`, 20, WINDOW_MS))) return { ok: false, error: "That is a lot of changes in a few minutes. Try again shortly." };
  if (typeof endpoint !== "string" || endpoint.length > 1024) return { ok: false, error: "This browser has no push address to remove." };
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: user.id } });
  const left = await syncEnabled(user.id);
  await audit(user.id, "PUSH_OFF", "User", user.id, `${left} device${left === 1 ? "" : "s"} left`);
  revalidatePath("/account/notifications");
  return { ok: true, message: left ? "Push is off for this device." : "Push is off." };
}

// Turns push off everywhere, for a lost phone or a device that is no longer in hand.
export async function stopAllPush(): Promise<PushActionResult> {
  const user = await pushUser();
  if (!user) return { ok: false, error: "Sign in again to change push." };
  if (!(await consumeRateLimit(`push:${user.id}`, 20, WINDOW_MS))) return { ok: false, error: "That is a lot of changes in a few minutes. Try again shortly." };
  const { count } = await prisma.pushSubscription.deleteMany({ where: { userId: user.id } });
  await prisma.user.update({ where: { id: user.id }, data: { pushEnabled: false } });
  await audit(user.id, "PUSH_OFF_ALL", "User", user.id, `${count} device${count === 1 ? "" : "s"}`);
  revalidatePath("/account/notifications");
  return { ok: true, message: "Push is off on every device." };
}

// A test notice to the signed-in account's own devices.
export async function sendTestPush(): Promise<PushActionResult> {
  const user = await pushUser();
  if (!user) return { ok: false, error: "Sign in again to send a test." };
  if (!pushReady()) return { ok: false, error: "Push isn't set up on this desk yet." };
  if (!(await consumeRateLimit(`push-test:${user.id}`, 5, WINDOW_MS))) return { ok: false, error: "That is a lot of tests in a few minutes. Try again shortly." };
  const result = await sendPush(user.id, { title: "Test notice", body: "Push works on this device.", url: "/account/notifications" });
  if (!result.sent) return { ok: false, error: "No device took it. Turn push off and on again on this device." };
  return { ok: true, message: `Sent to ${result.sent} device${result.sent === 1 ? "" : "s"}.` };
}

// Run once per page load. When the address in this browser belongs to another account, that account signed out on
// this device, so its address is dropped and the browser unsubscribes. "mine" and "none" tell the toggle its state.
export async function checkPushDevice(endpoint: unknown): Promise<{ state: "mine" | "other" | "none" }> {
  const user = await pushUser();
  if (!user || typeof endpoint !== "string" || !pushEndpointAllowed(endpoint)) return { state: "none" };
  if (!(await consumeRateLimit(`push-check:${user.id}`, 60, WINDOW_MS))) return { state: "none" };
  const row = await prisma.pushSubscription.findUnique({ where: { endpoint }, select: { id: true, userId: true } });
  if (!row) return { state: "none" };
  if (row.userId === user.id) return { state: "mine" };
  await prisma.pushSubscription.delete({ where: { id: row.id } }).catch(() => null);
  const left = await prisma.pushSubscription.count({ where: { userId: row.userId } });
  if (!left) await prisma.user.update({ where: { id: row.userId }, data: { pushEnabled: false } }).catch(() => null);
  return { state: "other" };
}
