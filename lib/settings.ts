import { prisma } from "@/lib/prisma";

type SettingsRow = Awaited<ReturnType<typeof loadSettings>>;
let cached: { at: number; value: SettingsRow } | null = null;

async function loadSettings() {
  const existing = await prisma.platformSettings.findUnique({ where: { id: "default" } });
  if (existing) return existing;
  return prisma.platformSettings.create({ data: { id: "default" } });
}

export async function getSettings() {
  if (cached && Date.now() - cached.at < 20_000) return cached.value;
  const value = await loadSettings();
  cached = { at: Date.now(), value };
  return value;
}

export function clearSettingsCache() {
  cached = null;
}

export function isPro(user: { subscriptionTier: string; subscriptionStatus: string }) {
  return user.subscriptionTier === "PRO" && user.subscriptionStatus === "ACTIVE";
}

export function isEarlyAccess(approvedAt: Date | null, hours: number, now = new Date()) {
  if (!approvedAt || hours <= 0) return false;
  return now.getTime() - approvedAt.getTime() < hours * 60 * 60 * 1000;
}
