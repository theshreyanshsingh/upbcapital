import { prisma } from "@/lib/prisma";
import { redisWindowCount } from "@/lib/redis-window";

const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const recent = (buckets.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

export function resetRateLimits() {
  buckets.clear();
}

export function limitStore() {
  const mode = (process.env.RATE_LIMIT_STORE || "database").toLowerCase();
  if (mode === "redis" && process.env.REDIS_URL) return "redis";
  if (mode === "memory") return "memory";
  if (mode === "redis") return "memory";
  return "database";
}

export async function consumeRateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const store = limitStore();
  try {
    if (store === "memory") return rateLimit(key, limit, windowMs, now);
    if (store === "redis") {
      const count = await redisWindowCount(process.env.REDIS_URL || "", key, windowMs, now);
      return count > 0 && count <= limit;
    }
    const slot = `${key}:${Math.floor(now / windowMs)}`;
    const count = await countHit(slot, new Date(now + windowMs));
    if (Math.random() < 0.02) {
      await prisma.rateWindow.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
    }
    return count <= limit;
  } catch {
    return rateLimit(key, limit, windowMs, now);
  }
}

// One atomic increment in MongoDB, creating the window on its first hit. Prisma's upsert runs as a transaction, and
// a burst on one key failed most of them on write conflicts: they fell back to this process's memory, and the stored
// count stayed far under the real one, so a burst of 400 sign-in tries left a count of 4 (stress test, November
// 2026). findAndModify on _id is a single write that MongoDB retries itself when two first hits race.
async function countHit(slot: string, expiresAt: Date) {
  const result = (await prisma.$runCommandRaw({
    findAndModify: "RateWindow",
    query: { _id: slot },
    update: { $inc: { count: 1 }, $setOnInsert: { expiresAt: { $date: expiresAt.toISOString() } } },
    upsert: true,
    new: true,
  })) as { value?: { count?: unknown } | null };
  const raw = result.value?.count;
  const count = typeof raw === "object" && raw !== null ? Number(Object.values(raw)[0]) : Number(raw);
  if (!Number.isFinite(count)) throw new Error("Rate window count missing");
  return count;
}
