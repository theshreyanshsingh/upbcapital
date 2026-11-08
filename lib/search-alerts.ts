import type { Listing, Note, SavedSearch, User } from "@prisma/client";
import { appOrigin } from "@/lib/billing";
import { unset } from "@/lib/db-filters";
import { digestSince } from "@/lib/digest";
import { notify } from "@/lib/email";
import { filtersFromSaved, listingMatches } from "@/lib/filters";
import { launchPending } from "@/lib/launch-rules";
import { prisma } from "@/lib/prisma";
import { audienceOf, listingScope } from "@/lib/private-listings";
import { isPro } from "@/lib/settings";

// A saved search alerts as each listing goes live, or gathers what went live into one daily or weekly roundup.
// A search saved before cadences existed has none, and alerts at once as it always did.
export const SEARCH_CADENCES = ["INSTANT", "DAILY", "WEEKLY"] as const;
export type SearchCadence = (typeof SEARCH_CADENCES)[number];

export const CADENCE_LABEL: Record<SearchCadence, string> = {
  INSTANT: "As each listing goes live",
  DAILY: "Daily roundup",
  WEEKLY: "Weekly roundup",
};

export function cadenceOf(search: { cadence?: string | null }): SearchCadence {
  return search.cadence === "DAILY" || search.cadence === "WEEKLY" ? search.cadence : "INSTANT";
}

export function readCadence(raw: unknown): SearchCadence | null {
  const value = String(raw ?? "").toUpperCase();
  return (SEARCH_CADENCES as readonly string[]).includes(value) ? (value as SearchCadence) : null;
}

// Alerts are a Pro privilege, for an approved account.
function alertsOn(user: User) {
  return isPro(user) && user.accountStatus === "APPROVED";
}

// Every fact the book's filters read, so a saved view on a file flag or a ratio alerts the way it filters.
function matchInput(listing: Listing & { notes: Note[] }) {
  const notes = listing.notes.map((note) => ({
    city: note.city,
    state: note.state,
    paymentStatus: note.paymentStatus,
    lienPosition: note.lienPosition,
    propertyType: note.propertyType,
    upb: Number(note.upb),
    askingPrice: Number(note.askingPrice),
    tradeStatus: note.tradeStatus,
    occupancy: note.occupancy,
    foreclosureStatus: note.foreclosureStatus,
    monthsDelinquent: note.monthsDelinquent,
    interestRate: Number(note.interestRate),
    monthlyPi: Number(note.monthlyPi),
    estimatedValue: Number(note.estimatedValue),
    modified: note.modified,
    bankruptcyChapter: note.bankruptcyChapter,
    bankruptcyFiledAt: note.bankruptcyFiledAt,
    hoaLien: note.hoaLien,
    taxDelinquent: note.taxDelinquent,
  }));
  return { kind: listing.kind, notes, status: listing.status, bidMode: listing.bidMode, bidDeadline: listing.bidDeadline };
}

function searchMail(search: SavedSearch & { user: User }) {
  return { category: "search" as const, userId: search.user.id, searchId: search.id };
}

export async function alertMatchingSearches(listingId: string, now = new Date()) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
  if (!listing || listing.status !== "APPROVED") return;
  // A coming-soon listing alerts at its launch, from the launch job, not at approval.
  if (launchPending(listing, now)) return;
  // Daily and weekly searches wait for their roundup.
  const searches = await prisma.savedSearch.findMany({
    where: { alertEnabled: true, OR: [{ cadence: "INSTANT" }, ...unset("cadence").OR] },
    include: { user: true },
  });
  const input = matchInput(listing);
  // A private listing alerts its invitees only, and never a buyer its seller excludes (lib/private-listings.ts).
  const shown = new Set((await audienceOf(listing, [...new Map(searches.map((search) => [search.user.id, search.user])).values()])).map((user) => user.id));
  for (const search of searches) {
    if (!alertsOn(search.user) || !shown.has(search.user.id)) continue;
    if (!listingMatches(input, filtersFromSaved(search.filters))) continue;
    await notify(
      search.user.email,
      `New paper matches “${search.name}”`,
      `${listing.title} just went live and matches your saved search. Open the book to underwrite it.`,
      searchMail(search),
    );
  }
}

const ROUNDUP_LINES = 20;

export function roundupBody(name: string, listings: { id: string; title: string }[], origin = appOrigin()) {
  if (!listings.length) return "";
  const lines = listings.slice(0, ROUNDUP_LINES).map((listing) => `${listing.title} · ${origin}/marketplace/${listing.id}`);
  const more = listings.length > ROUNDUP_LINES ? `\n\nAnd ${listings.length - ROUNDUP_LINES} more on the book: ${origin}/marketplace` : "";
  const count = `${listings.length} listing${listings.length === 1 ? "" : "s"}`;
  return `${count} went live since your last roundup and ${listings.length === 1 ? "matches" : "match"} your saved search “${name}”.\n\n${lines.join("\n")}${more}`;
}

// Daily and weekly searches whose alerts are on. `userIds` narrows a run, so a test sends only its own.
export function roundupSearches(userIds?: string[]) {
  return prisma.savedSearch.findMany({
    where: { alertEnabled: true, cadence: { in: ["DAILY", "WEEKLY"] }, ...(userIds ? { userId: { in: userIds } } : {}) },
    include: { user: true },
  });
}

// One roundup per period. The window starts at the last roundup, so a late or skipped run drops nothing, and a
// search is claimed with a conditional write before anything is sent, so an overlapping run sends nothing twice.
export async function sendSearchRoundup(search: SavedSearch & { user: User }, now = new Date()) {
  const cadence = cadenceOf(search);
  if (cadence === "INSTANT" || !search.alertEnabled || !alertsOn(search.user)) return false;
  const window = digestSince(cadence, search.lastAlertAt, now);
  if (!window) return false;
  // Nothing from before the search was saved counts as new to it.
  const since = window < search.createdAt ? search.createdAt : window;
  const claim = await prisma.savedSearch.updateMany({
    where: { id: search.id, alertEnabled: true, ...(search.lastAlertAt ? { lastAlertAt: search.lastAlertAt } : unset("lastAlertAt")) },
    data: { lastAlertAt: now },
  });
  if (claim.count !== 1) return false;
  // Up to this run's start; anything approved after opens the next window.
  const listings = await prisma.listing.findMany({
    // Only what this buyer would see on the book: no private listing they weren't invited to, nothing from a seller
    // who excludes them.
    where: { status: "APPROVED", approvedAt: { gte: since, lt: now }, AND: [await listingScope(search.user)] },
    include: { notes: true },
    orderBy: { approvedAt: "desc" },
  });
  const filters = filtersFromSaved(search.filters);
  // approvedAt is the launch time, so a coming-soon listing waits for the roundup after it goes live. The check holds
  // if a launch was ever written without it.
  const matches = listings.filter((listing) => !launchPending(listing, now) && listingMatches(matchInput(listing), filters));
  if (!matches.length) return false;
  await notify(search.user.email, `${CADENCE_LABEL[cadence]} · ${search.name}`, roundupBody(search.name, matches), searchMail(search));
  return true;
}
