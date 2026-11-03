import { isReleaseBuild } from "@/lib/deploy";
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

// In a release, Pro lapses at the end of its paid or referral month, after a three-day grace for a late renewal
// webhook. A desk comp has no end date and lasts until the desk sets the account back to free. The demo desk
// doesn't expire memberships, so its seeded Pro seats keep working between reseeds.
const PRO_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export function isPro(
  user: { subscriptionTier: string; subscriptionStatus: string; subscriptionCurrentPeriodEnd?: Date | null },
  now = new Date(),
  expire = isReleaseBuild(process.env),
) {
  if (user.subscriptionTier !== "PRO" || user.subscriptionStatus !== "ACTIVE") return false;
  const end = user.subscriptionCurrentPeriodEnd;
  return !expire || !end || end.getTime() + PRO_GRACE_MS > now.getTime();
}

export function isEarlyAccess(approvedAt: Date | null, hours: number, now = new Date()) {
  if (!approvedAt || hours <= 0) return false;
  return now.getTime() - approvedAt.getTime() < hours * 60 * 60 * 1000;
}
