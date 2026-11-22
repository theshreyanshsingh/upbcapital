import type { Tally } from "@/lib/jobs";
import { audit } from "@/lib/audit";
import { notify, notifyDesk } from "@/lib/email";
import { money, prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { deskCan, type Staff } from "@/lib/staff";
import { watchReprice } from "@/lib/watchers";

// A seller's price ladder: the ask steps down by a share of itself every so many days until a buyer bids or it
// reaches the seller's floor. The seller, or the sales side of the desk, sets it, as either can reprice the listing
// (actions/desk.ts bulkReprice). Each step is a reprice like any other: the loans for sale take the new ask in
// proportion, watchers hear, it goes on the price history (lib/price-history.ts) and buy boxes are scored again. A
// step that falls due while a bid is live waits a day at a time, so the price never moves under a bidder. Buyers see
// each new price; no buyer sees the schedule or the floor.

export const LADDER_STEP_MIN_PCT = 1;
export const LADDER_STEP_MAX_PCT = 10;
export const LADDER_EVERY_CHOICES = [7, 14, 21, 30, 45, 60] as const;
export const LADDER_DEFAULTS = { stepPct: 3, everyDays: 14 };
// A step that waits on a live bid is tried again this many days later.
export const WAIT_DAYS = 1;
const DAY = 24 * 60 * 60 * 1000;
const LIVE_BIDS = ["OPEN", "REVIEWED"] as const;

export const STOP_REASONS = {
  FLOOR: "The ask reached the floor.",
  SELLER: "Stopped by the seller.",
  DESK: "Stopped by the desk.",
  SOLD_OUT: "No loans are left for sale.",
} as const;

type LadderNote = { id: string; askingPrice: number | { toString(): string }; tradeStatus: string };

export type LadderListing = {
  id: string;
  title: string;
  status: string;
  bidMode: string;
  saleEventId?: string | null;
  roundOneEndsAt?: Date | null;
  flowProgramId?: string | null;
  buyNowPrice?: number | { toString(): string } | null;
  sellerId: string;
  ladderStepBps?: number | null;
  ladderEveryDays?: number | null;
  ladderFloor?: number | null;
  ladderNextAt?: Date | null;
  ladderStoppedAt?: Date | null;
  ladderStopReason?: string | null;
  notes: LadderNote[];
};

export const LADDER_SELECT = {
  id: true,
  title: true,
  status: true,
  bidMode: true,
  saleEventId: true,
  roundOneEndsAt: true,
  flowProgramId: true,
  buyNowPrice: true,
  sellerId: true,
  stalePausedAt: true,
  launchAt: true,
  ladderStepBps: true,
  ladderEveryDays: true,
  ladderFloor: true,
  ladderNextAt: true,
  ladderSetById: true,
  ladderSetAt: true,
  ladderStoppedAt: true,
  ladderStopReason: true,
  notes: { select: { id: true, askingPrice: true, tradeStatus: true } },
  seller: { select: { email: true } },
} as const;

const cents = (value: number) => Math.round(value * 100) / 100;

// Why this listing can't run a ladder, or null. Each of these holds a price a ladder would move.
export function ladderBlock(listing: Pick<LadderListing, "status" | "bidMode" | "saleEventId" | "roundOneEndsAt" | "flowProgramId" | "buyNowPrice">) {
  if (listing.status !== "APPROVED") return "A price ladder runs only while the listing is live.";
  if (listing.bidMode !== "NONE") return "A sealed or best-and-final sale holds one price to its deadline, so it takes no price ladder.";
  if (listing.saleEventId) return "This listing is in a dated sale event, which sets its terms.";
  if (listing.roundOneEndsAt) return "A two-round sale holds its price through its rounds.";
  if (listing.flowProgramId) return "A forward-flow tranche is priced by its programme.";
  if (listing.buyNowPrice != null) return "Buy it now holds a fixed price. Clear it before you set a ladder.";
  return null;
}

// The loans still for sale and their ask. Loans in contract or sold keep the price they trade at.
export function openAsk(notes: LadderNote[]) {
  const open = notes.filter((note) => note.tradeStatus === "AVAILABLE");
  return { open, ask: cents(open.reduce((sum, note) => sum + Number(note.askingPrice), 0)) };
}

export function ladderRunning(listing: Pick<LadderListing, "ladderNextAt" | "ladderStoppedAt" | "ladderStepBps">) {
  return Boolean(listing.ladderNextAt && listing.ladderStepBps && !listing.ladderStoppedAt);
}

// The form's step (percent), cadence (days) and floor (dollars), checked against the ask the ladder starts from.
export function readLadder(raw: { step: unknown; every: unknown; floor: unknown }, ask: number): { error: string } | { stepBps: number; everyDays: number; floor: number } {
  const step = Number(String(raw.step ?? "").trim());
  if (!Number.isFinite(step) || step < LADDER_STEP_MIN_PCT || step > LADDER_STEP_MAX_PCT) {
    return { error: `Choose a step between ${LADDER_STEP_MIN_PCT}% and ${LADDER_STEP_MAX_PCT}% of the ask.` };
  }
  const every = Number(String(raw.every ?? "").trim());
  if (!(LADDER_EVERY_CHOICES as readonly number[]).includes(every)) return { error: `Choose how often it steps: every ${LADDER_EVERY_CHOICES.join(", ")} days.` };
  const floor = Number(String(raw.floor ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(floor) || floor <= 0) return { error: "Enter the lowest ask you'll take, in dollars." };
  if (!(ask > 0)) return { error: "No loans are left for sale, so there is no ask to step down." };
  if (cents(floor) >= ask) return { error: `The floor has to be under today's ask of ${money(ask)}.` };
  return { stepBps: Math.round(step * 100), everyDays: every, floor: cents(floor) };
}

// The next ask: one step down, never below the floor. Null when the ask is already at the floor.
export function nextAsk(current: number, stepBps: number, floor: number) {
  if (current <= floor + 0.005) return null;
  return Math.max(cents(floor), cents(current * (1 - stepBps / 10000)));
}

// A new total spread over the loans for sale in proportion to their asks, to the cent, with the rounding left on the
// largest loan so the loans add up to the total exactly.
export function spreadAsk(open: LadderNote[], total: number) {
  const current = open.reduce((sum, note) => sum + Number(note.askingPrice), 0);
  if (!open.length || !(current > 0)) return [];
  const factor = total / current;
  const priced = open.map((note) => ({ id: note.id, price: cents(Number(note.askingPrice) * factor) }));
  const gap = cents(total - priced.reduce((sum, row) => sum + row.price, 0));
  if (gap !== 0) {
    const largest = priced.reduce((best, row) => (row.price > best.price ? row : best), priced[0]);
    largest.price = cents(largest.price + gap);
  }
  return priced;
}

// How many steps from this ask to the floor, for the form's preview.
export function stepsToFloor(ask: number, stepBps: number, floor: number) {
  let steps = 0;
  let at: number | null = ask;
  while (at != null && steps < 200) {
    at = nextAsk(at, stepBps, floor);
    if (at != null) steps += 1;
  }
  return steps;
}

export function ladderLine(listing: Pick<LadderListing, "ladderStepBps" | "ladderEveryDays" | "ladderFloor" | "ladderNextAt" | "ladderStoppedAt" | "ladderStopReason">) {
  if (!listing.ladderStepBps || !listing.ladderEveryDays || listing.ladderFloor == null) return null;
  const rule = `The ask steps down ${listing.ladderStepBps / 100}% every ${listing.ladderEveryDays} days, to a floor of ${money(listing.ladderFloor)}`;
  if (listing.ladderStoppedAt) return `${rule}. It stopped on ${prettyDate(listing.ladderStoppedAt)}. ${listing.ladderStopReason ?? ""}`.trim();
  return `${rule}. Next step on ${prettyDate(listing.ladderNextAt)}, unless a bid is live then.`;
}

type Actor = Staff & { id: string; name?: string | null; actor?: { id: string } | null };
type Outcome = { ok: true; message: string } | { ok: false; error: string };

// The seller or the desk's sales side, as for a reprice.
function mayRun(actor: Actor, listing: { sellerId: string }) {
  return listing.sellerId === actor.id || deskCan(actor, "sales");
}

async function loadLadder(listingId: string) {
  return prisma.listing.findUnique({ where: { id: listingId }, select: LADDER_SELECT });
}

export async function setPriceLadder(actor: Actor, listingId: string, raw: { step: unknown; every: unknown; floor: unknown }, now = new Date()): Promise<Outcome> {
  const listing = await loadLadder(listingId);
  if (!listing || !mayRun(actor, listing)) return { ok: false, error: "That listing isn't yours to reprice." };
  const blocked = ladderBlock(listing);
  if (blocked) return { ok: false, error: blocked };
  const { ask } = openAsk(listing.notes);
  const read = readLadder(raw, ask);
  if ("error" in read) return { ok: false, error: read.error };
  const nextAt = new Date(now.getTime() + read.everyDays * DAY);
  await prisma.listing.update({
    where: { id: listing.id },
    data: { ladderStepBps: read.stepBps, ladderEveryDays: read.everyDays, ladderFloor: read.floor, ladderNextAt: nextAt, ladderSetById: actor.id, ladderSetAt: now, ladderStoppedAt: null, ladderStopReason: null },
  });
  const rule = `${read.stepBps / 100}% every ${read.everyDays} days from ${money(ask)} to a floor of ${money(read.floor)}`;
  await audit(actor.actor?.id ?? actor.id, "PRICE_LADDER_SET", "listing", listing.id, rule, actor.actor?.id ? actor.id : null);
  // The other side hears: the seller when the desk sets it, the desk when the seller does.
  if (actor.id === listing.sellerId) {
    await notifyDesk(`Price ladder set · ${listing.title}`, `The seller set a price ladder on ${listing.title}: ${rule}. The first step is on ${prettyDate(nextAt)}.`, { capability: "sales" });
  } else {
    await notify(listing.seller.email, `Price ladder set · ${listing.title}`, `The desk set a price ladder on ${listing.title}: ${rule}. The first step is on ${prettyDate(nextAt)}. You can stop it from the listing page.`);
  }
  return { ok: true, message: `Price ladder set. The first step is on ${prettyDate(nextAt)}.` };
}

export async function stopPriceLadder(actor: Actor, listingId: string, now = new Date()): Promise<Outcome> {
  const listing = await loadLadder(listingId);
  if (!listing || !mayRun(actor, listing)) return { ok: false, error: "That listing isn't yours to reprice." };
  if (!ladderRunning(listing)) return { ok: false, error: "No price ladder is running on this listing." };
  const reason = actor.id === listing.sellerId ? STOP_REASONS.SELLER : STOP_REASONS.DESK;
  await prisma.listing.update({ where: { id: listing.id }, data: { ladderNextAt: null, ladderStoppedAt: now, ladderStopReason: reason } });
  await audit(actor.actor?.id ?? actor.id, "PRICE_LADDER_STOP", "listing", listing.id, reason, actor.actor?.id ? actor.id : null);
  if (actor.id !== listing.sellerId) await notify(listing.seller.email, `Price ladder stopped · ${listing.title}`, `The desk stopped the price ladder on ${listing.title}. The ask stays at ${money(openAsk(listing.notes).ask)}.`);
  return { ok: true, message: "Price ladder stopped. The ask stays where it is." };
}

async function stopWith(listing: { id: string; title: string; seller: { email: string } }, reason: string, now: Date) {
  await prisma.listing.update({ where: { id: listing.id }, data: { ladderNextAt: null, ladderStoppedAt: now, ladderStopReason: reason } });
  await audit(null, "PRICE_LADDER_STOP", "listing", listing.id, reason);
  await notify(listing.seller.email, `Price ladder stopped · ${listing.title}`, `The price ladder on ${listing.title} has stopped. ${reason}`);
}

// Every ladder whose step is due. Each listing is claimed by moving its next step before anything changes, so a second
// run at the same moment finds it taken and moves nothing. `listingIds` narrows a run, so a test steps only its own.
export async function runPriceLadders(now = new Date(), options: { listingIds?: string[] } = {}): Promise<Tally> {
  const due = await prisma.listing.findMany({
    where: { ladderNextAt: { lte: now }, ...(options.listingIds ? { id: { in: options.listingIds } } : {}) },
    select: LADDER_SELECT,
  });
  const { eachItem } = await import("@/lib/jobs");
  return eachItem("price ladder", due, (listing) => `listing ${listing.id}`, async (listing) => {
    if (!listing.ladderNextAt || !listing.ladderStepBps || !listing.ladderEveryDays || listing.ladderFloor == null) return false;
    const claim = await prisma.listing.updateMany({
      where: { id: listing.id, ladderNextAt: listing.ladderNextAt },
      data: { ladderNextAt: new Date(now.getTime() + listing.ladderEveryDays * DAY) },
    });
    if (claim.count !== 1) return false;
    const blocked = ladderBlock(listing);
    if (blocked) {
      await stopWith(listing, blocked, now);
      return true;
    }
    // A live bid, the buyers' or the desk's own, holds the price, and so does a listing off the book: paused for its
    // seller's confirmation, or coming soon. The step is tried again tomorrow.
    const [live, deskLive] = await Promise.all([
      prisma.inquiry.count({ where: { listingId: listing.id, type: "OFFER", status: { in: [...LIVE_BIDS] } } }),
      prisma.deskBid.count({ where: { listingId: listing.id, status: "OPEN" } }),
    ]);
    const offBook = Boolean(listing.stalePausedAt) || Boolean(listing.launchAt && listing.launchAt.getTime() > now.getTime());
    if (live > 0 || deskLive > 0 || offBook) {
      await prisma.listing.update({ where: { id: listing.id }, data: { ladderNextAt: new Date(now.getTime() + WAIT_DAYS * DAY) } });
      return false;
    }
    const { open, ask } = openAsk(listing.notes);
    if (!open.length) {
      await stopWith(listing, STOP_REASONS.SOLD_OUT, now);
      return true;
    }
    const target = nextAsk(ask, listing.ladderStepBps, listing.ladderFloor);
    if (target == null) {
      await stopWith(listing, STOP_REASONS.FLOOR, now);
      return true;
    }
    const priced = spreadAsk(open, target);
    await prisma.$transaction(priced.map((row) => prisma.note.update({ where: { id: row.id }, data: { askingPrice: row.price } })));
    const actorId = listing.ladderSetById ?? listing.sellerId;
    await watchReprice({ listingId: listing.id, before: ask, after: target, loans: open.length, actorId, source: "LADDER" });
    await audit(null, "PRICE_LADDER_STEP", "listing", listing.id, `${money(ask)} to ${money(target)} on ${open.length} loan${open.length === 1 ? "" : "s"}`);
    // A lower ask can bring the listing inside more buyers' boxes, and they hear as for any new match.
    const { rescoreListing } = await import("@/lib/matching");
    await rescoreListing(listing.id, true, now);
    const floored = target <= listing.ladderFloor + 0.005;
    if (floored) await prisma.listing.update({ where: { id: listing.id }, data: { ladderNextAt: null, ladderStoppedAt: now, ladderStopReason: STOP_REASONS.FLOOR } });
    const next = floored
      ? `It reached your floor of ${money(listing.ladderFloor)}, so the ladder has stopped.`
      : `The next step is on ${prettyDate(new Date(now.getTime() + listing.ladderEveryDays * DAY))}, unless a bid is live then.`;
    await notify(listing.seller.email, `Price ladder step · ${listing.title}`, `Your price ladder moved the ask on ${listing.title} from ${money(ask)} to ${money(target)}. ${next}`);
    return true;
  });
}
