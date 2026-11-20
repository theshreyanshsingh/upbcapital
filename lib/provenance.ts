import type { ListingStatus, Prisma } from "@prisma/client";
import { actionGate } from "@/lib/action-gates";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { deskCan } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import type { Tally } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { PROVENANCE_VERSION, availableSince, remindedSince, stalePaused, statementProblem } from "@/lib/provenance-rules";
import { personId, type ActingUser } from "@/lib/seats";

// Listing provenance and freshness. Every path that puts a listing to the desk takes the seller's statement that the
// loans are theirs to sell and free to sell (lib/provenance-rules.ts has the wording), and the desk can't approve a
// new listing without it. A live listing the seller hasn't stood behind for REMIND_AFTER_DAYS gets one reminder;
// PAUSE_AFTER_DAYS after that, still unconfirmed, it pauses: it stays approved, but buyers don't see it and it takes
// no new bids until the seller, their seat, the broker or the desk confirms it again. Bids already in stay open.

const DAY = 24 * 60 * 60 * 1000;

export const REMIND_AFTER_DAYS = 30;
export const PAUSE_AFTER_DAYS = 7;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

const IN_REVIEW: ListingStatus[] = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED"];

// ---------------------------------------------------------------------------------------------------------------
// The ownership statement

// What a statement writes on the listing: who gave it, when, and the wording's version. A firm's seat gives it for
// the firm, and the record names the seat.
export function ownershipFields(user: { id: string; actor?: { id: string } | null }, now = new Date()) {
  return { ownershipAttestedAt: now, ownershipAttestedById: personId(user), ownershipAttestation: PROVENANCE_VERSION };
}

// The listing's own page for its seller of record: a broker's deal page, a buyer's resale page, or the seller's.
export function ownerPage(listing: { id: string; brokerId?: string | null; seller?: { role: string } | null }) {
  if (listing.brokerId) return `/broker/deals/${listing.id}`;
  if (listing.seller?.role === "BUYER") return `/buyer/resales/${listing.id}`;
  return `/seller/listings/${listing.id}`;
}

export function statementHoldText(listing: { brokerId?: string | null }) {
  return `Approval waits on the ${listing.brokerId ? "broker's" : "seller's"} ownership statement: that the loans are theirs to sell and aren't pledged, sold or under contract elsewhere. They give it on the listing's page.`;
}

// Why the desk can't approve this listing yet for want of the statement, or null. The desk's own paper isn't asked.
// A listing approved before the statement was asked isn't held either: it gives the statement at the seller's next
// edit or reconfirmation.
export function provenanceHold(listing: { ownershipAttestedAt?: Date | null; approvedAt?: Date | null; brokerId?: string | null; seller: { role: string } }) {
  if (listing.ownershipAttestedAt || listing.approvedAt || listing.seller.role === "ADMIN") return null;
  return statementHoldText(listing);
}

// Every listing in review held for want of the statement, in one query, for the desk's risk queue (lib/risk-queue.ts).
export async function statementHolds() {
  const rows = await prisma.listing.findMany({
    where: { status: { in: IN_REVIEW }, AND: [unset("ownershipAttestedAt"), unset("approvedAt")] },
    select: { id: true, title: true, submittedAt: true, deskOwnerId: true, brokerId: true, ownershipAttestedAt: true, approvedAt: true, seller: { select: { role: true } } },
  });
  return rows.filter((row) => provenanceHold(row));
}

// Every live listing paused for want of its seller's reconfirmation, for the same queue.
export async function pausedListings() {
  const rows = await prisma.listing.findMany({
    where: { status: "APPROVED", stalePausedAt: { not: null } },
    select: { id: true, title: true, status: true, stalePausedAt: true, deskOwnerId: true },
  });
  return rows.filter(stalePaused);
}

function owns(user: { id: string }, listing: { sellerId: string; brokerId?: string | null }) {
  return listing.sellerId === user.id || (Boolean(listing.brokerId) && listing.brokerId === user.id);
}

// The seller or filing broker gives the statement on a listing in review that has none: a copy, a listing filed
// before it was asked, or one the desk duplicated. A tape the desk filed takes it with the seller's confirmation.
export async function giveStatement(user: ActingUser, input: { listingId: string; statement: unknown; now?: Date }): Promise<Outcome<{ title: string }>> {
  const now = input.now ?? new Date();
  const listing = input.listingId
    ? await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, title: true, status: true, sellerId: true, brokerId: true, filedByDeskId: true, sellerConfirmedAt: true, ownershipAttestedAt: true } })
    : null;
  if (!listing || !owns(user, listing)) return fail("That listing isn't yours.");
  if (!IN_REVIEW.includes(listing.status)) return fail("This listing isn't with the desk for review.");
  if (listing.filedByDeskId && !listing.sellerConfirmedAt) return fail("Confirm the tape the desk filed for you. That confirmation is your ownership statement.");
  const gated = await actionGate(user, "list");
  if (gated) return fail(gated);
  const problem = statementProblem(input.statement);
  if (problem) return fail(problem);
  const moved = await prisma.listing.updateMany({ where: { id: listing.id, status: { in: IN_REVIEW } }, data: ownershipFields(user, now) });
  if (moved.count !== 1) return fail("The listing changed a moment ago. Reload and try again.");
  await audit(user.id, "OWNERSHIP_STATEMENT", "listing", listing.id, `Ownership statement ${PROVENANCE_VERSION}`);
  if (!listing.ownershipAttestedAt) {
    await notifyDesk(`Ownership statement · ${listing.title}`, `The seller of record gave the ownership statement on ${listing.title}. Approval no longer waits on it.`, { capability: "sales" });
  }
  return { ok: true, value: { title: listing.title } };
}

// ---------------------------------------------------------------------------------------------------------------
// Freshness

export const PAUSED_BIDS = "This listing is paused until its seller confirms the loans are still available. It takes no new bids until then.";

// Why a new bid can't go on this listing for a pause, or null. The pause is read when the caller's select left it out.
export async function pausedBidBlock(listing: { id: string; status?: string; stalePausedAt?: Date | null }) {
  const row = listing.status !== undefined && listing.stalePausedAt !== undefined
    ? listing
    : await prisma.listing.findUnique({ where: { id: listing.id }, select: { status: true, stalePausedAt: true } });
  return row && stalePaused(row) ? PAUSED_BIDS : null;
}

// The seller, their seat or the broker confirms the loans are still for sale, or the desk does for them with a note
// saying how it heard. It stamps the date buyers see and clears the reminder and any pause. A listing with no
// statement on file takes the seller's statement too; the desk can't give it for them.
export async function reconfirmAvailable(
  user: ActingUser,
  input: { listingId: string; statement?: unknown; note?: string; now?: Date },
): Promise<Outcome<{ title: string; unpaused: boolean }>> {
  const now = input.now ?? new Date();
  const listing = input.listingId
    ? await prisma.listing.findUnique({
        where: { id: input.listingId },
        select: { id: true, title: true, status: true, sellerId: true, brokerId: true, ownershipAttestedAt: true, stalePausedAt: true, seller: { select: { role: true, name: true, companyName: true } } },
      })
    : null;
  if (!listing) return fail("That listing isn't yours.");
  const owner = owns(user, listing);
  const desk = !owner && user.role === "ADMIN";
  if (!owner && !desk) return fail("That listing isn't yours.");
  if (desk && !deskCan(user, "sales")) return fail("Your desk role doesn't run sales.");
  const note = (input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (desk && note.length < 3) return fail("Say how the seller confirmed it, such as their email or call and its date.");
  if (!desk) {
    const gated = await actionGate(user, "list");
    if (gated) return fail(gated);
  }
  if (listing.status !== "APPROVED") return fail("Only a live listing is confirmed available.");
  const takesStatement = !desk && !listing.ownershipAttestedAt && listing.seller.role !== "ADMIN";
  if (takesStatement) {
    const problem = statementProblem(input.statement);
    if (problem) return fail(problem);
  }
  const moved = await prisma.listing.updateMany({
    where: { id: listing.id, status: "APPROVED" },
    data: { availableConfirmedAt: now, availabilityRemindedAt: null, stalePausedAt: null, ...(takesStatement ? ownershipFields(user, now) : {}) },
  });
  if (moved.count !== 1) return fail("The listing changed a moment ago. Reload and try again.");
  const unpaused = stalePaused(listing);
  const who = desk ? `The desk confirmed for the seller: ${note}` : "The seller of record confirmed the loans are still available";
  await audit(user.id, "AVAILABLE_CONFIRMED", "listing", listing.id, `${who}${unpaused ? " · back on the book" : ""}`);
  if (takesStatement) await audit(user.id, "OWNERSHIP_STATEMENT", "listing", listing.id, `Ownership statement ${PROVENANCE_VERSION}, with the reconfirmation`);
  if (unpaused) {
    // Back on the book: its buy-box matches come back, quietly. Buyers who saved it see it again.
    const { rescoreListing } = await import("@/lib/matching");
    await rescoreListing(listing.id, false, now);
    const seller = listing.seller.companyName || listing.seller.name;
    await notifyDesk(`Back on the book · ${listing.title}`, `${desk ? `The desk (${note})` : seller} confirmed ${listing.title} is still available, so the pause is lifted and it takes bids again.`, { capability: "sales" });
  }
  return { ok: true, value: { title: listing.title, unpaused } };
}

// ---------------------------------------------------------------------------------------------------------------
// The daily job. Each step claims a listing with a conditional write on the dates it read, so an overlapping run
// finds it taken and sends nothing, and a confirmation landing in between wins.

const DUE_SELECT = {
  id: true,
  title: true,
  status: true,
  sellerId: true,
  brokerId: true,
  approvedAt: true,
  availableConfirmedAt: true,
  availabilityRemindedAt: true,
  stalePausedAt: true,
  seller: { select: { role: true, email: true, name: true, companyName: true } },
  broker: { select: { email: true } },
} satisfies Prisma.ListingSelect;

type Due = Prisma.ListingGetPayload<{ select: typeof DUE_SELECT }>;

function still<K extends "approvedAt" | "availableConfirmedAt" | "availabilityRemindedAt">(field: K, seen: Date | null) {
  return seen ? ({ [field]: seen } as Record<K, Date>) : unset(field);
}

// Live listings with nothing in hand: no accepted bid and no open closing. The desk's own paper is left out.
async function liveUnclaimed(where: Prisma.ListingWhereInput, listingIds?: string[]) {
  const rows = await prisma.listing.findMany({
    where: { status: "APPROVED", AND: [unset("stalePausedAt"), where], ...(listingIds ? { id: { in: listingIds } } : {}) },
    select: DUE_SELECT,
  });
  const candidates = rows.filter((row) => row.seller.role !== "ADMIN");
  if (!candidates.length) return [];
  const ids = candidates.map((row) => row.id);
  const [accepted, closings] = await Promise.all([
    prisma.inquiry.findMany({ where: { listingId: { in: ids }, status: "ACCEPTED" }, select: { listingId: true } }),
    prisma.closing.findMany({ where: { listingId: { in: ids }, status: "OPEN" }, select: { listingId: true } }),
  ]);
  const busy = new Set([...accepted, ...closings].map((row) => row.listingId));
  return candidates.filter((row) => !busy.has(row.id));
}

// The claim's guard: still approved and unpaused, on the dates this run read.
function unchanged(listing: Due) {
  return {
    id: listing.id,
    status: "APPROVED" as const,
    AND: [
      unset("stalePausedAt"),
      still("approvedAt", listing.approvedAt),
      still("availableConfirmedAt", listing.availableConfirmedAt),
      still("availabilityRemindedAt", listing.availabilityRemindedAt),
    ],
  };
}

function recipients(listing: Due) {
  return [...new Set([listing.seller.email, listing.broker?.email].filter((email): email is string => Boolean(email)))];
}

function link(listing: Due) {
  return `${process.env.NEXT_PUBLIC_APP_URL || ""}${ownerPage(listing)}#availability`;
}

// One reminder per stretch: a live listing whose seller hasn't confirmed it in REMIND_AFTER_DAYS, and that hasn't
// been asked since. `listingIds` narrows a run, so a test reminds only its own.
export async function remindStaleListings(now = new Date(), options: { listingIds?: string[] } = {}): Promise<Tally> {
  const cutoff = new Date(now.getTime() - REMIND_AFTER_DAYS * DAY);
  const rows = await liveUnclaimed(
    { approvedAt: { lte: cutoff }, OR: [...unset("availableConfirmedAt").OR, { availableConfirmedAt: { lte: cutoff } }] },
    options.listingIds,
  );
  const due = rows.filter((row) => !remindedSince(row));
  const { eachItem } = await import("@/lib/jobs");
  return eachItem("availability reminder", due, (listing) => `listing ${listing.id}`, async (listing) => {
    const claim = await prisma.listing.updateMany({ where: unchanged(listing), data: { availabilityRemindedAt: now } });
    if (claim.count !== 1) return false;
    const since = availableSince(listing);
    const pauseOn = new Date(now.getTime() + PAUSE_AFTER_DAYS * DAY);
    const body = [
      `The desk last heard that the loans in ${listing.title} are for sale on ${prettyDate(since)}. Confirm in one click that they are still yours to sell, and not sold, pledged or under contract anywhere else: ${link(listing)}`,
      `If the desk doesn't hear by ${prettyDate(pauseOn)}, the listing pauses. Buyers stop seeing it and it takes no new bids until you confirm. Bids already in stay open. If the loans are no longer for sale, withdraw the listing on the same page.`,
    ].join("\n\n");
    for (const email of recipients(listing)) await notify(email, `Still for sale? · ${listing.title}`, body);
    return true;
  });
}

// PAUSE_AFTER_DAYS after its reminder, a listing still unconfirmed pauses. A pause only ever follows a reminder of
// the current stretch, so no listing pauses without the seller having been asked first.
export async function pauseStaleListings(now = new Date(), options: { listingIds?: string[] } = {}): Promise<Tally> {
  const cutoff = new Date(now.getTime() - PAUSE_AFTER_DAYS * DAY);
  const rows = await liveUnclaimed({ availabilityRemindedAt: { lte: cutoff } }, options.listingIds);
  const due = rows.filter((row) => {
    const reminded = remindedSince(row);
    return Boolean(reminded && reminded.getTime() <= cutoff.getTime());
  });
  const { eachItem } = await import("@/lib/jobs");
  return eachItem("stale pause", due, (listing) => `listing ${listing.id}`, async (listing) => {
    const claim = await prisma.listing.updateMany({ where: unchanged(listing), data: { stalePausedAt: now } });
    if (claim.count !== 1) return false;
    await audit(null, "STALE_PAUSED", "listing", listing.id, `No confirmation within ${PAUSE_AFTER_DAYS} days of the reminder of ${prettyDate(listing.availabilityRemindedAt)}`);
    // Off the book: its open buy-box matches go, as for any listing a buyer can't see (lib/private-listings.ts).
    const { rescoreListing } = await import("@/lib/matching");
    await rescoreListing(listing.id, false, now);
    const body = `You didn't confirm that ${listing.title} is still available, so it is paused. Buyers don't see it and it takes no new bids. Bids already in stay open. Confirm in one click to put it back on the book: ${link(listing)}`;
    for (const email of recipients(listing)) await notify(email, `Paused · ${listing.title}`, body);
    const app = process.env.NEXT_PUBLIC_APP_URL || "";
    await notifyDesk(
      `Paused, not reconfirmed · ${listing.title}`,
      `${listing.seller.companyName || listing.seller.name} didn't confirm ${listing.title} within ${PAUSE_AFTER_DAYS} days of the reminder, so it is off the book and takes no new bids. Bids already in stay open. ${app}/admin/listings/${listing.id}`,
      { capability: "sales" },
    );
    return true;
  });
}

// Both steps, in that order, as the jobs run them. A listing reminded today is never paused in the same run.
export async function runFreshness(now = new Date(), options: { listingIds?: string[] } = {}): Promise<Tally> {
  const paused = await pauseStaleListings(now, options);
  const reminded = await remindStaleListings(now, options);
  return { sent: paused.sent + reminded.sent, failed: paused.failed + reminded.failed, error: paused.error || reminded.error };
}
