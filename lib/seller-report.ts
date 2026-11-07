import { activityWeek, listingActivity, type ActivityWeek } from "@/lib/activity";
import { appOrigin } from "@/lib/billing";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { periodPassed } from "@/lib/schedule";

// Once a week, each seller or broker with a live listing hears how it did: opens, saves, NDAs, downloads, questions
// and bids, against the week before. Counts only, as the seller page shows them. No buyer's name and no bid amount.

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// A large book still makes a readable email. The rest are on the seller's own pages.
const MAX_LISTINGS = 25;

export const REPORT_ROLES = ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "BROKER"] as const;

type Owner = { id: string; email: string; role: string; accountStatus: string; sellerReport: boolean | null; lastSellerReportAt: Date | null };

// Missing counts as on. A suspended or declined account hears nothing.
export function reportOn(user: Pick<Owner, "sellerReport" | "accountStatus">) {
  return user.sellerReport !== false && user.accountStatus !== "SUSPENDED" && user.accountStatus !== "REJECTED";
}

export function reportDue(last: Date | null, now = new Date()) {
  return !last || periodPassed(last, WEEK, now);
}

function change(week: number, prior: number) {
  if (week === prior) return "same as the week before";
  return week > prior ? `up ${week - prior} on the week before` : `down ${prior - week} on the week before`;
}

const ROWS: [keyof ActivityWeek, string][] = [
  ["views", "Opens"],
  ["saves", "Saves"],
  ["ndas", "NDAs signed"],
  ["downloads", "Data-room downloads"],
  ["questions", "Questions"],
  ["bids", "Bids"],
];

export function daysLive(approvedAt: Date | null, now = new Date()) {
  return approvedAt ? Math.max(0, Math.floor((now.getTime() - approvedAt.getTime()) / DAY)) : null;
}

export function reportSection(listing: { title: string; approvedAt: Date | null }, week: ActivityWeek, link: string, now = new Date()) {
  const days = daysLive(listing.approvedAt, now);
  const live = days === null ? "live" : `live ${days} day${days === 1 ? "" : "s"}`;
  const lines = ROWS.map(([key, label]) => `${label}: ${week[key].week} this week, ${change(week[key].week, week[key].prior)}. ${week[key].total} in all.`);
  return [`${listing.title} · ${live}`, ...lines, link].join("\n");
}

// Sellers and brokers on at least one live listing. `userIds` narrows a run, so a test reports only its own.
export async function reportOwners(userIds?: string[]): Promise<Owner[]> {
  const scope = userIds ? { OR: [{ sellerId: { in: userIds } }, { brokerId: { in: userIds } }] } : {};
  const listings = await prisma.listing.findMany({ where: { status: "APPROVED", ...scope }, select: { sellerId: true, brokerId: true } });
  const ids = new Set(listings.flatMap((listing) => [listing.sellerId, listing.brokerId]).filter((id): id is string => Boolean(id)));
  if (!ids.size) return [];
  return prisma.user.findMany({
    where: { id: { in: [...ids].filter((id) => !userIds || userIds.includes(id)) }, role: { in: [...REPORT_ROLES] } },
    select: { id: true, email: true, role: true, accountStatus: true, sellerReport: true, lastSellerReportAt: true },
  });
}

// One report a week. The figures are read before the claim, so a read that fails leaves the week for the next run;
// the claim is a conditional write, so an overlapping run sends nothing twice.
export async function sendSellerReport(user: Owner, now = new Date()) {
  if (!reportOn(user) || !reportDue(user.lastSellerReportAt, now)) return false;
  const listings = await prisma.listing.findMany({
    where: { status: "APPROVED", OR: [{ sellerId: user.id }, { brokerId: user.id }] },
    select: { id: true, title: true, approvedAt: true, sellerId: true },
    orderBy: { approvedAt: "asc" },
  });
  if (!listings.length) return false;
  const origin = appOrigin();
  // A broker's deals open under the broker desk; the seller pages are for sellers.
  const page = user.role === "BROKER" ? "broker/deals" : "seller/listings";
  const sections: string[] = [];
  for (const listing of listings.slice(0, MAX_LISTINGS)) {
    const week = activityWeek(await listingActivity(listing.id, listing.sellerId, now), now);
    sections.push(reportSection(listing, week, `${origin}/${page}/${listing.id}`, now));
  }
  const claim = await prisma.user.updateMany({
    where: { id: user.id, ...(user.lastSellerReportAt ? { lastSellerReportAt: user.lastSellerReportAt } : unset("lastSellerReportAt")) },
    data: { lastSellerReportAt: now },
  });
  if (claim.count !== 1) return false;
  const more = listings.length > MAX_LISTINGS ? `\n\n${listings.length - MAX_LISTINGS} more live listings are on your desk: ${origin}/${user.role === "BROKER" ? "broker" : "seller"}` : "";
  const count = `${listings.length} live listing${listings.length === 1 ? "" : "s"}`;
  const body = `How your ${count} did in the week to ${prettyDate(now)}.\n\n${sections.join("\n\n")}${more}\n\nThese are counts. Who looked stays with the desk, and any bid waiting on your answer is on the listing page.`;
  await notify(user.email, `Weekly report · ${count}`, body, { category: "report", userId: user.id });
  return true;
}
