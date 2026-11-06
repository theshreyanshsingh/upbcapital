import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

// Winner discipline: a buyer who wins and then fails to close gets a strike. At the desk's limit their bidding
// pauses until the desk reviews and clears one.

export const DEFAULT_STRIKE_LIMIT = 2;

export function strikeLimitOf(setting: number | null | undefined) {
  return setting != null && setting >= 1 && setting <= 10 ? Math.round(setting) : DEFAULT_STRIKE_LIMIT;
}

export const CANCEL_FAULTS = ["BUYER", "SELLER", "NEITHER"] as const;
export type CancelFault = (typeof CANCEL_FAULTS)[number];

export function isCancelFault(value: unknown): value is CancelFault {
  return typeof value === "string" && (CANCEL_FAULTS as readonly string[]).includes(value);
}

export function faultLabel(fault: string | null | undefined) {
  if (fault === "BUYER") return "The buyer didn't close";
  if (fault === "SELLER") return "The seller didn't deliver";
  if (fault === "NEITHER") return "Neither side";
  return "Not recorded";
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

export function countWord(count: number) {
  return WORDS[count] ?? String(count);
}

export function pauseMessage(active: number) {
  return `Your bidding is paused while the desk reviews ${countWord(active)} closing${active === 1 ? "" : "s"} that didn't complete.`;
}

export function strikePaused(active: number, limit: number) {
  return active >= limit;
}

export async function activeStrikeCount(userId: string) {
  return prisma.buyerStrike.count({ where: { userId, ...unset("clearedAt") } });
}

// How many strikes stand against a buyer, the desk's limit, and the pause message once they reach it.
export async function strikeStanding(userId: string) {
  const [active, settings] = await Promise.all([activeStrikeCount(userId), getSettings()]);
  const limit = strikeLimitOf(settings.strikeLimit);
  return { active, limit, paused: strikePaused(active, limit) ? pauseMessage(active) : null };
}

// One strike per buyer per closing. The cancel that records it is the only write that moved the closing off OPEN,
// so a second call for the same closing finds the first strike and returns it.
export async function recordStrike(input: { userId: string; closingId: string; reason: string; createdById: string | null }) {
  const existing = await prisma.buyerStrike.findFirst({ where: { userId: input.userId, closingId: input.closingId } });
  if (existing) return { strike: existing, created: false };
  const strike = await prisma.buyerStrike.create({
    data: { userId: input.userId, closingId: input.closingId, reason: input.reason.slice(0, 500), createdById: input.createdById },
  });
  await audit(input.createdById, "STRIKE_RECORDED", "user", input.userId, `Closing ${input.closingId}: ${input.reason}`);
  const standing = await strikeStanding(input.userId);
  if (standing.paused) {
    const buyer = await prisma.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } });
    await notifyDesk(
      `Bidding paused · ${buyer?.name ?? "A buyer"}`,
      `${buyer?.name ?? "A buyer"} (${buyer?.email ?? input.userId}) has ${standing.active} closings that didn't complete on their side, which meets the limit of ${standing.limit}. Their new bids are refused until the desk clears a strike on the buyer file.`,
    );
  }
  return { strike, created: true };
}

// The desk clears a strike with a note saying why. Only the write that finds it uncleared counts, so two clears
// can't both land.
export async function clearStrike(input: { strikeId: string; actorId: string; note: string; now?: Date }) {
  const note = input.note.replace(/\s+/g, " ").trim().slice(0, 500);
  if (note.length < 10) return { error: "Say why the strike is cleared, in a sentence." } as const;
  const strike = await prisma.buyerStrike.findUnique({ where: { id: input.strikeId } });
  if (!strike) return { error: "That strike no longer exists." } as const;
  const cleared = await prisma.buyerStrike.updateMany({
    where: { id: strike.id, ...unset("clearedAt") },
    data: { clearedAt: input.now ?? new Date(), clearedById: input.actorId, clearNote: note },
  });
  if (cleared.count !== 1) return { error: "That strike is already cleared." } as const;
  await audit(input.actorId, "STRIKE_CLEARED", "user", strike.userId, `Closing ${strike.closingId}: ${note}`);
  return { error: null, userId: strike.userId } as const;
}

export type StrikeRow = {
  id: string;
  userId: string;
  closingId: string;
  listingTitle: string;
  reason: string;
  createdAt: Date;
  clearedAt: Date | null;
  clearNote: string;
};

// Every strike for these buyers, newest first, with the listing each closing was for.
export async function strikesFor(userIds: string[]) {
  const byUser = new Map<string, StrikeRow[]>();
  if (!userIds.length) return byUser;
  const strikes = await prisma.buyerStrike.findMany({ where: { userId: { in: userIds } }, orderBy: { createdAt: "desc" } });
  const closings = strikes.length
    ? await prisma.closing.findMany({ where: { id: { in: [...new Set(strikes.map((strike) => strike.closingId))] } }, select: { id: true, listing: { select: { title: true } } } })
    : [];
  const titles = new Map(closings.map((closing) => [closing.id, closing.listing.title]));
  for (const strike of strikes) {
    const rows = byUser.get(strike.userId) ?? [];
    rows.push({
      id: strike.id,
      userId: strike.userId,
      closingId: strike.closingId,
      listingTitle: titles.get(strike.closingId) ?? "A closing no longer on the desk",
      reason: strike.reason,
      createdAt: strike.createdAt,
      clearedAt: strike.clearedAt ?? null,
      clearNote: strike.clearNote,
    });
    byUser.set(strike.userId, rows);
  }
  return byUser;
}
