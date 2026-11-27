import { prisma } from "@/lib/prisma";

// Visits are written a couple of seconds late, together. A row written on every visit held one of the database
// driver's ten connections for a round trip to Atlas each time, and with 25 visitors at once the pages' own reads
// queued behind them (lib/in-flight.ts). A restart can lose the last couple of seconds of visits.
export const HIT_BATCH_MS = 2000;
let queued: { path: string; createdAt: Date }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export async function recordHit(path: string) {
  queued.push({ path, createdAt: new Date() });
  if (!timer) {
    timer = setTimeout(() => void flushHits(), HIT_BATCH_MS);
    timer.unref?.();
  }
}

// Writes what is waiting now. Tests call it rather than waiting for the batch.
export async function flushHits() {
  if (timer) clearTimeout(timer);
  timer = null;
  const batch = queued;
  queued = [];
  if (batch.length) await prisma.pageHit.createMany({ data: batch }).catch(() => null);
}
