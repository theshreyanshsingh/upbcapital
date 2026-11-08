import { audit } from "@/lib/audit";
import { closingLoans } from "@/lib/closing";
import { daysBetween } from "@/lib/closing-clock";
import { labelOf } from "@/lib/labels";
import { common } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { isPrivateListing } from "@/lib/private-listings";
import { upbBucket } from "@/lib/strata";

// The venue's public track record, from closings that finished one way or the other. Counts below MIN_SALES read
// as noise rather than a record, so the page says there are too few instead of showing a 100% close rate on one
// sale. A sale's own figures show only where its seller agreed, and never its address, parties or exact balance.

export const MIN_SALES = 3;

export type ResultLoan = { state: string; lienPosition: string; paymentStatus: string; upb: number; id: string };

export type ResultClosing = {
  id: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  salePrice: number;
  noteId: string | null;
  // The loans of a part-pool sale, which closingLoans reads ahead of noteId.
  noteIds?: string[];
  // A private sale never shows its own figures here, whatever its seller agreed (lib/private-listings.ts).
  listing: { kind: string; publishResult: boolean | null; visibility?: string | null; notes: ResultLoan[] };
};

export type Tally = { label: string; count: number };

export type TrackRecord = {
  closed: number;
  canceled: number;
  // Null until there are enough finished closings to say anything.
  closeRate: number | null;
  medianDays: number | null;
  byLien: Tally[];
  byPerformance: Tally[];
  enough: boolean;
};

// No ids: the public page carries nothing that leads back to the closing or the listing.
export type PublishedResult = {
  kind: string;
  loanCount: number;
  place: string;
  lien: string;
  performance: string;
  upbBand: string;
  ofUpb: number | null;
  month: string;
  closedAt: Date;
};

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function tally(values: string[]): Tally[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// The loans a closing sold: one loan out of a pool, or the whole listing.
function soldLoans(closing: ResultClosing) {
  return closingLoans(closing, closing.listing.notes);
}

function lienOf(loans: ResultLoan[]) {
  const lien = common(loans.map((loan) => loan.lienPosition));
  return lien ? `${labelOf("lien", lien)} lien` : "Mixed liens";
}

function performanceOf(loans: ResultLoan[]) {
  const status = common(loans.map((loan) => loan.paymentStatus));
  return status ? labelOf("payment", status) : "Mixed performance";
}

export function trackRecord(closings: ResultClosing[]): TrackRecord {
  const complete = closings.filter((closing) => closing.status === "COMPLETE" && closing.closedAt);
  const canceled = closings.filter((closing) => closing.status === "CANCELED").length;
  const finished = complete.length + canceled;
  const enough = complete.length >= MIN_SALES;
  return {
    closed: complete.length,
    canceled,
    closeRate: enough ? complete.length / finished : null,
    medianDays: enough ? median(complete.map((closing) => daysBetween(closing.openedAt, closing.closedAt!))) : null,
    byLien: enough ? tally(complete.map((closing) => lienOf(soldLoans(closing)))) : [],
    byPerformance: enough ? tally(complete.map((closing) => performanceOf(soldLoans(closing)))) : [],
    enough,
  };
}

function placeOf(loans: ResultLoan[]) {
  const states = [...new Set(loans.map((loan) => loan.state))].sort();
  return states.length > 3 ? `${states.length} states` : states.join(", ");
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

// One closed sale as the public page shows it, or null when its seller didn't agree to publish it.
export function publishedResult(closing: ResultClosing): PublishedResult | null {
  if (closing.listing.publishResult !== true || isPrivateListing(closing.listing) || closing.status !== "COMPLETE" || !closing.closedAt) return null;
  const loans = soldLoans(closing);
  if (!loans.length) return null;
  const upb = loans.reduce((sum, loan) => sum + loan.upb, 0);
  return {
    kind: loans.length > 1 ? "POOL" : "SINGLE",
    loanCount: loans.length,
    place: placeOf(loans),
    lien: lienOf(loans),
    performance: performanceOf(loans),
    upbBand: upbBucket(upb),
    // Whole percent, so a band and a rounded share can't be worked back to the exact price.
    ofUpb: upb > 0 ? Math.round((closing.salePrice / upb) * 100) : null,
    month: MONTH.format(closing.closedAt),
    closedAt: closing.closedAt,
  };
}

export function publishedResults(closings: ResultClosing[]) {
  return closings
    .map(publishedResult)
    .filter((row): row is PublishedResult => row !== null)
    .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());
}

export async function loadResults() {
  const rows = await prisma.closing.findMany({
    where: { status: { in: ["COMPLETE", "CANCELED"] } },
    select: {
      id: true,
      status: true,
      openedAt: true,
      closedAt: true,
      salePrice: true,
      noteId: true,
      noteIds: true,
      listing: {
        select: {
          kind: true,
          publishResult: true,
          visibility: true,
          notes: { select: { id: true, state: true, lienPosition: true, paymentStatus: true, upb: true } },
        },
      },
    },
  });
  const closings: ResultClosing[] = rows.map((row) => ({ ...row, salePrice: Number(row.salePrice), listing: { ...row.listing, notes: row.listing.notes.map((note) => ({ ...note, upb: Number(note.upb) })) } }));
  return { record: trackRecord(closings), results: publishedResults(closings) };
}

// The seller or the filing broker says whether this sale's result goes on the public page, and the desk can record
// that answer for them. Turning it off takes a published result down at once.
export async function setPublishResult(actor: { id: string; role: string }, listingId: string, publish: boolean) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true, publishResult: true } });
  if (!listing || (actor.role !== "ADMIN" && listing.sellerId !== actor.id && listing.brokerId !== actor.id)) return { error: "That listing isn't yours." } as const;
  if ((listing.publishResult === true) === publish) return { error: null, changed: false } as const;
  await prisma.listing.update({ where: { id: listing.id }, data: { publishResult: publish } });
  await audit(actor.id, publish ? "RESULT_PUBLISHED" : "RESULT_HIDDEN", "listing", listing.id);
  return { error: null, changed: true } as const;
}
