import { prisma } from "@/lib/prisma";

export function referralCodeFor(name: string) {
  const stem = name.replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase() || "DESK";
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${stem}${suffix}`;
}

export async function ensureReferralCode(userId: string, name: string) {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
  if (existing?.referralCode) return existing.referralCode;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = referralCodeFor(name);
    try {
      const updated = await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return updated.referralCode ?? code;
    } catch {
      continue;
    }
  }
  return null;
}
