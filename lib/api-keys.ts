import { createHash, randomBytes } from "node:crypto";
import { accountLocked } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export function hashKey(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function mintKey() {
  const token = `upb_${randomBytes(24).toString("hex")}`;
  return { token, prefix: token.slice(0, 12), hash: hashKey(token) };
}

export async function userForApiKey(header: string | null) {
  const token = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!token.startsWith("upb_")) return null;
  const key = await prisma.apiKey.findUnique({ where: { hash: hashKey(token) }, include: { user: true } });
  if (!key || accountLocked(key.user.accountStatus)) return null;
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key.user;
}
