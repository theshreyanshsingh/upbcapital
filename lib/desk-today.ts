import { closingClock, closingStats, targetDays } from "@/lib/closing-clock";
import { prisma } from "@/lib/prisma";
import { openReviewWhere, reviewKey } from "@/lib/screening";

const DAY = 24 * 60 * 60 * 1000;

// What is waiting on the desk right now, and how the last half-year of closings went.
export async function deskToday(closingDays: number | null | undefined, now = new Date()) {
  const days = targetDays(closingDays);
  const since = new Date(now.getTime() - 180 * DAY);
  const [review, offers, deadlines, files, accounts, open, finished, reviews, live] = await Promise.all([
    prisma.listing.findMany({ where: { status: { in: ["SUBMITTED", "UNDER_REVIEW"] } }, select: { submittedAt: true }, orderBy: { submittedAt: "asc" } }),
    prisma.inquiry.count({ where: { type: "OFFER", status: { in: ["OPEN", "REVIEWED"] } } }),
    prisma.listing.findMany({
      where: { status: "APPROVED", bidMode: { not: "NONE" }, bidDeadline: { lte: now } },
      select: { id: true, inquiries: { where: { type: "OFFER", status: { in: ["OPEN", "REVIEWED"] } }, select: { id: true } } },
    }),
    prisma.buyerProfile.count({ where: { status: "SUBMITTED" } }),
    prisma.user.count({ where: { accountStatus: "PENDING" } }),
    prisma.closing.findMany({ where: { status: "OPEN" }, include: { steps: true } }),
    prisma.closing.findMany({ where: { status: { in: ["COMPLETE", "CANCELED"] }, openedAt: { gte: since } }, select: { status: true, openedAt: true, closedAt: true } }),
    prisma.ofacCheck.findMany({ where: openReviewWhere, select: { id: true, name: true, matched: true, userId: true, listingId: true } }),
    prisma.listing.findMany({ where: { status: "APPROVED" }, select: { _count: { select: { inquiries: { where: { type: "OFFER" } } } } } }),
  ]);
  const clocks = open.map((closing) => closingClock(closing, closing.steps, days, now));
  // Counted the way the compliance page lists them: one per party, name and list entry.
  const openReviews = new Set(reviews.map(reviewKey));
  const bids = live.reduce((sum, listing) => sum + listing._count.inquiries, 0);
  return {
    review: review.length,
    oldestReviewDays: review[0] ? Math.floor((now.getTime() - review[0].submittedAt.getTime()) / DAY) : null,
    offers,
    toAward: deadlines.filter((listing) => listing.inquiries.length > 0).length,
    files,
    accounts,
    openClosings: open.length,
    lateClosings: clocks.filter((clock) => clock.overdue > 0 || clock.late).length,
    ofac: openReviews.size,
    stats: closingStats(finished),
    bidsPerListing: live.length ? bids / live.length : null,
    liveListings: live.length,
  };
}
