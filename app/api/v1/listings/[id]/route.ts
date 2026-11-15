import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { isLive, listingDetail } from "@/lib/buyer-api";
import { prisma } from "@/lib/prisma";
import { canSeeListing } from "@/lib/private-listings";
import { sellerNameSight, sellerShown, servicerShown } from "@/lib/seller-anonymity";

// One live listing's summary and loan tape, as a signed-in Pro buyer reads it before the confidentiality agreement.
// No data-room file, borrower or street, and no one's bid. The seller reads as a type until the account is in the
// room (lib/seller-anonymity.ts). A listing this account may not see is not found, and nothing says why, as on the
// listing page.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
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
  const detail = listingDetail(listing);
  // A seller servicing its own loans is named in the servicer field, so until the name shows that reads as the type.
  const loans = detail.loans.map((loan) => ({ ...loan, servicerName: servicerShown(listing, loan.servicerName as string | null, allowed) }));
  return NextResponse.json({
    ...detail,
    loans,
    seller: sellerShown(listing, allowed),
    paused: Boolean(listing.stalePausedAt),
    confirmedAvailableAt: (listing.availableConfirmedAt ?? listing.approvedAt)?.toISOString() ?? null,
  });
}
