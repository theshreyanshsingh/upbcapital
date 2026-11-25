import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { bidderCountFor } from "@/lib/bidder-count";
import { isLive, listingDetail } from "@/lib/buyer-api";
import { priceHistory } from "@/lib/price-history";
import { prisma } from "@/lib/prisma";
import { canSeeListing } from "@/lib/private-listings";
import { sellerNameSight, sellerShown, servicerShown } from "@/lib/seller-anonymity";
import { withCallLog } from "@/lib/api-log";

// One live listing's summary and loan tape, as a signed-in Pro buyer reads it before the confidentiality agreement.
// No data-room file, borrower or street, and no one's bid. The seller reads as a type until the account is in the
// room (lib/seller-anonymity.ts). A listing this account may not see is not found, and nothing says why, as on the
// listing page.
async function handleGet(request: Request, context: { params: Promise<{ id: string }> }) {
  const caller = await apiCaller(request, "listings:read");
  if (caller.response) return caller.response;
  const { id } = await context.params;
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: { notes: { orderBy: { createdAt: "asc" } }, seller: { select: { role: true, name: true, companyName: true, companyType: true } } },
  });
  if (!listing || !isLive(listing) || !(await canSeeListing(caller.user, listing))) {
    return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  }
  // A listing its seller hasn't reconfirmed is paused: off the book and taking no bids, but still found by id, as its
  // page is, so a buyer with an open bid can follow it (lib/provenance.ts).
  const allowed = (await sellerNameSight(caller.user, [listing])).get(listing.id) ?? false;
  // Every move on the ask, oldest first, without who moved it, as a Pro buyer sees it on the listing page.
  const detail = listingDetail(listing, await priceHistory(listing.id));
  // A seller servicing its own loans is named in the servicer field, so until the name shows that reads as the type.
  const loans = detail.loans.map((loan) => ({ ...loan, servicerName: servicerShown(listing, loan.servicerName as string | null, allowed) }));
  // How many other firms hold a live bid, where the seller chose to show it, as on the listing page. Counts only, and
  // null when hidden (lib/bidder-count.ts).
  const otherBidders = await bidderCountFor(listing, caller.user);
  return NextResponse.json({
    ...detail,
    loans,
    seller: sellerShown(listing, allowed),
    paused: Boolean(listing.stalePausedAt),
    confirmedAvailableAt: (listing.availableConfirmedAt ?? listing.approvedAt)?.toISOString() ?? null,
    otherBidders,
  });
}

// Logged with the status this route answers (lib/api-log.ts).
export const GET = withCallLog(handleGet);
