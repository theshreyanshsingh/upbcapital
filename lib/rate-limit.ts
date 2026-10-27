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
    const row = await prisma.rateWindow.upsert({
      where: { key: slot },
      create: { key: slot, count: 1, expiresAt: new Date(now + windowMs) },
      update: { count: { increment: 1 } },
    });
    if (Math.random() < 0.02) {
      await prisma.rateWindow.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
    }
    return row.count <= limit;
  } catch {
    return rateLimit(key, limit, windowMs, now);
  }
}
