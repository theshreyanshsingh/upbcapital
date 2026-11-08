import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { badRequest, listingSummary, liveWhere, matchesFilters, paginate, readListingFilters, readPage } from "@/lib/buyer-api";
import { prisma } from "@/lib/prisma";
import { listingScope } from "@/lib/private-listings";

// Live listings this key's account may see. Private sales show only to their invitees, and a seller's excluded
// buyers see none of theirs, by the same rule as the book (lib/private-listings.ts).
export async function GET(request: Request) {
  const caller = await apiCaller(request, "listings:read");
  if (caller.response) return caller.response;
  const url = new URL(request.url);
  const page = readPage(url);
  if ("error" in page) return badRequest(page.error);
  const filters = readListingFilters(url);
  if ("error" in filters) return badRequest(filters.error);
  const listings = await prisma.listing.findMany({
    where: { AND: [liveWhere(), await listingScope(caller.user), ...(page.since ? [{ updatedAt: { gte: page.since } }] : [])] },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
  const shown = paginate(listings.filter((listing) => matchesFilters(listing, filters)), (listing) => listing.updatedAt, page);
  return NextResponse.json({ listings: shown.rows.map(listingSummary), nextCursor: shown.nextCursor });
}
