import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import type { Tally } from "@/lib/jobs";
import { launchPending, launchTime, readMovedLaunch } from "@/lib/launch-rules";
import { rescoreListing } from "@/lib/matching";
import { prisma } from "@/lib/prisma";
import { alertMatchingSearches } from "@/lib/search-alerts";
import { notifyWatchers } from "@/lib/watchers";

// The launch job. At a coming-soon listing's launch time, buyers who saved it hear it is live, and the saved-search
// alerts and buy-box scoring that approval held back run as they would have on approval. The rules themselves are in
// lib/launch-rules.ts, which the book and the offer panel share.

// Approved listings whose launch time has come and whose watchers haven't heard. `listingIds` narrows a run, so a test
// launches only its own.
export function dueLaunches(now = new Date(), listingIds?: string[]) {
  return prisma.listing.findMany({
    where: { status: "APPROVED", launchAt: { lte: now }, ...unset("launchNotifiedAt"), ...(listingIds ? { id: { in: listingIds } } : {}) },
    select: { id: true, title: true, launchAt: true, seller: { select: { email: true } } },
  });
}

// Claimed on the launch time this run read, before anything is sent, so an overlapping run sends nothing twice and a
// listing the desk took off the book or re-dated in the same moment isn't announced.
export async function claimLaunch(listing: { id: string; launchAt: Date | null }, now = new Date()) {
  if (!listing.launchAt) return false;
  const claimed = await prisma.listing.updateMany({
    where: { id: listing.id, status: "APPROVED", launchAt: listing.launchAt, ...unset("launchNotifiedAt") },
    data: { launchNotifiedAt: now },
  });
  return claimed.count === 1;
}

export async function launchListing(listing: { id: string; title: string; launchAt: Date | null; seller: { email: string } }, now = new Date()) {
  if (!(await claimLaunch(listing, now))) return false;
  await notifyWatchers({
    listingId: listing.id,
    event: "LAUNCH",
    subject: `Now live · ${listing.title}`,
    body: `${listing.title}, a listing you saved while it was coming soon, is now live. The confidentiality agreement, the data room and bids are open.`,
  });
  await alertMatchingSearches(listing.id, now);
  await rescoreListing(listing.id, true, now);
  await notify(
    listing.seller.email,
    `Live · ${listing.title}`,
    `Your listing went live to approved buyers at ${launchTime(listing.launchAt ?? now)}. Buyers who saved it while it was coming soon were told.`,
  );
  return true;
}

// One bad listing is logged and counted, and the run goes on to the next. A claimed listing that then fails isn't
// tried again, rather than risk a second notice; it is live either way, since the gates read the launch time.
export async function runLaunches(now = new Date(), options: { listingIds?: string[] } = {}): Promise<Tally> {
  const tally: Tally = { sent: 0, failed: 0, error: "" };
  for (const listing of await dueLaunches(now, options.listingIds)) {
    try {
      if (await launchListing(listing, now)) tally.sent += 1;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
      tally.failed += 1;
      tally.error ||= `listing ${listing.id}: ${reason}`;
      console.error(`[upb-jobs] launch failed for listing ${listing.id}:`, reason);
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------------------------------------------
// The desk changes a launch after approval: a new time, or live now.

const CHANGED = "The listing changed a moment ago. Reload and try again.";

async function comingSoon(listingId: string, now: Date) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, title: true, status: true, launchAt: true, launchNotifiedAt: true, seller: { select: { email: true } } },
  });
  if (!listing) return { error: "Listing not found." } as const;
  if (listing.status !== "APPROVED" || !listing.launchAt || !launchPending(listing, now) || listing.launchNotifiedAt) {
    return { error: "This listing isn't coming soon, so there is no launch to change." } as const;
  }
  return { error: null, listing: { ...listing, launchAt: listing.launchAt } } as const;
}

// Claimed on the launch time read, as the job claims it, so a launch or another change landing in the same moment
// wins and this one asks for a reload. approvedAt moves with it, since early access, roundups and the book's order
// all count from the launch. The review log and the audit log both keep it.
async function relaunch(listing: { id: string; launchAt: Date }, at: Date) {
  const moved = await prisma.listing.updateMany({
    where: { id: listing.id, status: "APPROVED", launchAt: listing.launchAt, ...unset("launchNotifiedAt") },
    data: { launchAt: at, approvedAt: at },
  });
  return moved.count === 1;
}

async function record(actorId: string, listingId: string, action: string, comment: string) {
  await prisma.reviewComment.create({ data: { authorId: actorId, listingId, action: "COMMENT", comment } });
  await audit(actorId, action, "listing", listingId, comment);
}

// A new launch time, within the limits approval has. The seller and the buyers who saved the listing hear the date.
export async function moveLaunch(input: { listingId: string; actorId: string; launchAt: string }, now = new Date()) {
  const found = await comingSoon(input.listingId, now);
  if (found.error !== null) return found;
  const { listing } = found;
  const read = readMovedLaunch(input.launchAt, listing.launchAt, now);
  if (read.error !== null || !read.at) return { error: read.error ?? "Enter the new launch time." } as const;
  const at = read.at;
  if (!(await relaunch(listing, at))) return { error: CHANGED } as const;
  const from = launchTime(listing.launchAt);
  const to = launchTime(at);
  await record(input.actorId, listing.id, "LAUNCH_MOVED", `Launch moved from ${from} to ${to}.`);
  await notify(
    listing.seller.email,
    `Launch moved · ${listing.title}`,
    `The desk moved your listing's launch to ${to}. It stays on the book as coming soon until then, and the data room and bids open at that time.`,
  );
  await notifyWatchers({
    listingId: listing.id,
    event: "LAUNCH",
    subject: `New launch date · ${listing.title}`,
    body: `${listing.title}, a listing you saved while it is coming soon, now goes live on ${to}. The confidentiality agreement, the data room and bids open then.`,
  });
  return { error: null, at } as const;
}

// The wait is cancelled and the listing goes live now. The launch job's work for it runs here, through the same
// claim, so the next run finds it done: watchers hear it is live, saved-search alerts go and the buy boxes rescore.
export async function launchNow(input: { listingId: string; actorId: string }, now = new Date()) {
  const found = await comingSoon(input.listingId, now);
  if (found.error !== null) return found;
  const { listing } = found;
  if (!(await relaunch(listing, now))) return { error: CHANGED } as const;
  await record(input.actorId, listing.id, "LAUNCH_NOW", `Launch moved up from ${launchTime(listing.launchAt)}. Live now.`);
  try {
    return { error: null, launched: await launchListing({ ...listing, launchAt: now }, now) } as const;
  } catch (error) {
    // It is live either way, since the gates read the launch time. The notices it missed are logged, not retried.
    console.error(`[upb-launch] notices for listing ${listing.id} failed:`, error instanceof Error ? error.message : error);
    return { error: null, launched: false } as const;
  }
}
