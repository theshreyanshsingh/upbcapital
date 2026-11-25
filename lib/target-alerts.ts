import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import { money, prettyDate } from "@/lib/format";
import { launchPending } from "@/lib/launch-rules";
import { listingFigures, loansForSale, type MetricInput } from "@/lib/metrics";
import { typedNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { audienceOf, canSeeListing } from "@/lib/private-listings";
import { isPro } from "@/lib/settings";
import { watchesOn, watchLink } from "@/lib/watchers";

// A buyer's price alert on a saved listing: "tell me when the ask is at or under $X". Every live reprice checks the
// listing's targets (lib/watchers.ts watchReprice), whoever moved the price, and a buyer whose target the ask reaches
// hears once, as a saved-listing notice. The target is then spent until they set a new one. The ask is a Pro figure,
// so only a Pro buyer who may see the listing sets one or hears of it. The notice gives the ask and the target, never
// who moved the price or how.

type Outcome = { ok: true; message: string } | { ok: false; error: string };
type Buyer = Parameters<typeof isPro>[0] & { id: string; role: string; accountStatus: string };
type Target = { targetAsk: number | null; targetSetAt: Date | null; targetHitAt: Date | null };

const LISTING_SELECT = {
  id: true,
  title: true,
  kind: true,
  status: true,
  sellerId: true,
  brokerId: true,
  visibility: true,
  stalePausedAt: true,
  launchAt: true,
  notes: { select: { upb: true, askingPrice: true, estimatedValue: true, monthlyPi: true, interestRate: true, paymentStatus: true, tradeStatus: true } },
} as const;

const cents = (value: number) => Math.round(value * 100) / 100;

// Whole dollars unless the figure carries cents, as a ladder step's ask can.
export function dollars(value: number) {
  return money(value, Number.isInteger(cents(value)) ? 0 : 2);
}

// The ask the listing page shows: a live pool's loans still for sale, or its one note (lib/metrics.ts).
export function currentAsk(listing: { kind: string; status: string; notes: (MetricInput & { tradeStatus: string })[] }) {
  return cents(listingFigures(listing.kind, loansForSale(listing.status, listing.notes)).asking);
}

// Where a buyer's target stands, for the listing page and favorites.
export function targetState(target: Target) {
  if (target.targetAsk == null) return null;
  if (target.targetHitAt) return `Your target of ${dollars(target.targetAsk)} was hit on ${prettyDate(target.targetHitAt)}.`;
  return `We'll tell you at or under ${dollars(target.targetAsk)}. Set on ${prettyDate(target.targetSetAt)}.`;
}

export async function setTarget(user: Buyer, listingId: string, raw: unknown, now = new Date()): Promise<Outcome> {
  if (user.role !== "BUYER" || user.accountStatus !== "APPROVED") return { ok: false, error: "Price alerts are for approved buyers." };
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: LISTING_SELECT });
  // A listing hidden from this buyer reads as not there, as its page does (lib/private-listings.ts).
  if (!listing || !(await canSeeListing(user, listing))) return { ok: false, error: "That listing isn't on the book." };
  if (!isPro(user, now)) return { ok: false, error: "Price alerts come with Pro, as the ask does." };
  if (listing.status !== "APPROVED" || launchPending(listing, now)) return { ok: false, error: "Price alerts are for live listings." };
  const typed = typedNumber(raw);
  const target = Number.isFinite(typed) ? cents(typed) : Number.NaN;
  if (!(target > 0)) return { ok: false, error: "Enter the ask you want to hear about, in dollars, above $0." };
  const ask = currentAsk(listing);
  if (ask <= target) return { ok: false, error: `The ask is already ${dollars(ask)}, at or under that. To buy at it, use the bid form on this listing.` };
  // Setting a target saves the listing, and a new target starts unspent.
  const saved = await prisma.favorite.findUnique({ where: { userId_listingId: { userId: user.id, listingId: listing.id } }, select: { id: true } });
  const fields = { targetAsk: target, targetSetAt: now, targetHitAt: null };
  if (saved) await prisma.favorite.update({ where: { id: saved.id }, data: fields });
  else await prisma.favorite.create({ data: { userId: user.id, listingId: listing.id, ...fields } });
  await audit(user.id, "PRICE_TARGET_SET", "listing", listing.id, dollars(target));
  return { ok: true, message: `Price alert set. We'll tell you once when the ask is at or under ${dollars(target)}.${saved ? "" : " The listing is saved to your favorites."}` };
}

export async function clearTarget(user: { id: string }, listingId: string): Promise<Outcome> {
  const saved = await prisma.favorite.findUnique({ where: { userId_listingId: { userId: user.id, listingId } }, select: { id: true, targetAsk: true } });
  if (!saved || saved.targetAsk == null) return { ok: false, error: "No price alert is set on this listing." };
  await prisma.favorite.update({ where: { id: saved.id }, data: { targetAsk: null, targetSetAt: null, targetHitAt: null } });
  await audit(user.id, "PRICE_TARGET_CLEARED", "listing", listingId, dollars(saved.targetAsk));
  return { ok: true, message: "Price alert cleared. The listing stays saved." };
}

// After a reprice: each unspent target at or above the new ask is claimed, then its buyer told. The claim sets
// targetHitAt only where it is still unset, so two reprices at once tell a buyer once. A buyer the listing is now
// hidden from, or who is off Pro or has saved-listing notices off, is skipped and the target left as it was.
// `told`, when given, collects the buyers alerted, so the reprice notice they'd also get can leave them out.
export async function checkTargets(listingId: string, now = new Date(), told?: Set<string>) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: LISTING_SELECT });
  // A coming-soon listing hides its price, as notifyWatchers holds its reprice notices.
  if (!listing || listing.status !== "APPROVED" || launchPending(listing, now)) return 0;
  const ask = currentAsk(listing);
  if (!(ask > 0)) return 0;
  // One listing's saves, which stay few.
  const reached = await prisma.favorite.findMany({
    where: { listingId, targetAsk: { gte: ask }, ...unset("targetHitAt") },
    select: {
      id: true,
      targetAsk: true,
      user: {
        select: { id: true, email: true, role: true, accountStatus: true, watchAlerts: true, companyName: true, subscriptionTier: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true, trialEndsAt: true },
      },
    },
  });
  if (!reached.length) return 0;
  // The same audience notifyWatchers tells: private, excluded and paused listings reach no one they're hidden from.
  const shown = new Set((await audienceOf(listing, reached.map((row) => row.user))).map((user) => user.id));
  let count = 0;
  for (const row of reached) {
    const user = row.user;
    if (row.targetAsk == null || !shown.has(user.id) || user.role !== "BUYER" || !watchesOn(user) || !isPro(user, now)) continue;
    const claim = await prisma.favorite.updateMany({ where: { id: row.id, targetAsk: row.targetAsk, ...unset("targetHitAt") }, data: { targetHitAt: now } });
    if (claim.count !== 1) continue;
    await notify(
      user.email,
      `Price alert · ${listing.title}`,
      `The ask on ${listing.title} is now ${dollars(ask)}, at or under your target of ${dollars(row.targetAsk)}. This alert is now spent. Set a new target on the listing for another.\n\nOpen the listing: ${watchLink(listingId)}`,
      { category: "watch", userId: user.id },
    );
    count += 1;
    told?.add(user.id);
  }
  return count;
}
