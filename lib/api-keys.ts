import { createHash, randomBytes } from "node:crypto";
import { accountLocked } from "@/lib/access";
import { unset } from "@/lib/db-filters";
import { prisma } from "@/lib/prisma";

export function hashKey(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function mintKey() {
  const token = `upb_${randomBytes(24).toString("hex")}`;
  return { token, prefix: token.slice(0, 12), hash: hashKey(token) };
}

// The key list shows when each key was last used. To the minute is plenty, so a busy key writes once a minute.
const USE_PRECISION_MS = 60 * 1000;

export async function markKeyUsed(keyId: string, now = new Date()) {
  await prisma.apiKey.updateMany({
    where: { id: keyId, OR: [...unset("lastUsedAt").OR, { lastUsedAt: { lt: new Date(now.getTime() - USE_PRECISION_MS) } }] },
    data: { lastUsedAt: now },
  });
}

export async function userForApiKey(header: string | null, now = new Date()) {
  const token = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!token.startsWith("upb_")) return null;
  const key = await prisma.apiKey.findUnique({ where: { hash: hashKey(token) }, include: { user: true } });
  if (!key || accountLocked(key.user.accountStatus)) return null;
  await markKeyUsed(key.id, now);
  return key.user;
}
