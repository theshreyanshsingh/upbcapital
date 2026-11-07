import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import type { Tally } from "@/lib/jobs";
import { launchTime } from "@/lib/launch-rules";
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
