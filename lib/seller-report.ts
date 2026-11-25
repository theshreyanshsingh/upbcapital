import { activityWeek, listingActivity, type ActivityWeek } from "@/lib/activity";
import { appOrigin } from "@/lib/billing";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import { listingHealth, stepLine, type ListingHealth } from "@/lib/listing-health";
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

// `next` is the listing's first next step from its listing health (lib/listing-health.ts), when it has one.
export function reportSection(listing: { title: string; approvedAt: Date | null }, week: ActivityWeek, link: string, now = new Date(), next: string | null = null) {
  const days = daysLive(listing.approvedAt, now);
  const live = days === null ? "live" : `live ${days} day${days === 1 ? "" : "s"}`;
  const lines = ROWS.map(([key, label]) => `${label}: ${week[key].week} this week, ${change(week[key].week, week[key].prior)}. ${week[key].total} in all.`);
  return [`${listing.title} · ${live}`, ...lines, ...(next ? [`Next step: ${next}`] : []), link].join("\n");
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

const REPORT_LISTING = { id: true, title: true, approvedAt: true, sellerId: true, brokerId: true } as const;
type ReportListing = { id: string; title: string; approvedAt: Date | null; sellerId: string; brokerId: string | null };
export type PreparedReports = { listings: Map<string, ReportListing[]>; health: Map<string, ListingHealth> };

// What a run's reports read, read once for every owner due: their live listings in one read, and the health of the
// listings each report shows in one pass. Health compares each listing with similar ones and the comps, and read per
// owner that comparison was most of the job's time at a few thousand listings (stress test, November 2026).
export async function prepareReports(owners: Owner[], now = new Date()): Promise<PreparedReports> {
  const ids = new Set(owners.map((owner) => owner.id));
  const listings = new Map<string, ReportListing[]>();
  if (!ids.size) return { listings, health: new Map() };
  const rows = await prisma.listing.findMany({
    where: { status: "APPROVED", OR: [{ sellerId: { in: [...ids] } }, { brokerId: { in: [...ids] } }] },
    select: REPORT_LISTING,
    orderBy: { approvedAt: "asc" },
  });
  for (const row of rows) {
    for (const owner of new Set([row.sellerId, row.brokerId])) {
      if (owner && ids.has(owner)) listings.set(owner, [...(listings.get(owner) ?? []), row]);
    }
  }
  const shown = [...new Set([...listings.values()].flatMap((list) => list.slice(0, MAX_LISTINGS).map((listing) => listing.id)))];
  // A failed health read leaves the next steps out rather than holding the week's reports.
  const health = await listingHealth(shown, now).catch(() => new Map<string, ListingHealth>());
  return { listings, health };
}

// One report a week. The figures are read before the claim, so a read that fails leaves the week for the next run;
// the claim is a conditional write, so an overlapping run sends nothing twice.
export async function sendSellerReport(user: Owner, now = new Date(), prepared?: PreparedReports) {
  if (!reportOn(user) || !reportDue(user.lastSellerReportAt, now)) return false;
  const listings = prepared
    ? (prepared.listings.get(user.id) ?? [])
    : await prisma.listing.findMany({
        where: { status: "APPROVED", OR: [{ sellerId: user.id }, { brokerId: user.id }] },
        select: REPORT_LISTING,
        orderBy: { approvedAt: "asc" },
      });
  if (!listings.length) return false;
  const origin = appOrigin();
  // A broker's deals open under the broker desk; the seller pages are for sellers.
  const page = user.role === "BROKER" ? "broker/deals" : "seller/listings";
  const sections: string[] = [];
  // A failed health read leaves the next steps out rather than holding the week's report.
  const health = prepared
    ? prepared.health
    : await listingHealth(listings.slice(0, MAX_LISTINGS).map((listing) => listing.id), now).catch(() => new Map<string, ListingHealth>());
  for (const listing of listings.slice(0, MAX_LISTINGS)) {
    const week = activityWeek(await listingActivity(listing.id, listing.sellerId, now), now);
    sections.push(reportSection(listing, week, `${origin}/${page}/${listing.id}`, now, stepLine(health.get(listing.id)?.steps[0])));
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
