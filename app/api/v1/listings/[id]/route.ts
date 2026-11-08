import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { isLive, listingDetail } from "@/lib/buyer-api";
import { prisma } from "@/lib/prisma";
import { canSeeListing } from "@/lib/private-listings";

// One live listing's summary and loan tape, as a signed-in Pro buyer reads it before the confidentiality agreement.
// No data-room file, borrower or street, and no one's bid. A listing this account may not see is not found, and
// nothing says why, as on the listing page.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const caller = await apiCaller(request, "listings:read");
  if (caller.response) return caller.response;
  const { id } = await context.params;
  const listing = await prisma.listing.findUnique({ where: { id }, include: { notes: { orderBy: { createdAt: "asc" } } } });
  if (!listing || !isLive(listing) || !(await canSeeListing(caller.user, listing))) {
    return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  }
  return NextResponse.json(listingDetail(listing));
}
