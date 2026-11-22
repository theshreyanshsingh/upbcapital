import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { badRequest, listingSummary, liveWhere, matchesFilters, paginate, readListingFilters, readPage } from "@/lib/buyer-api";
import { PROGRAM_CHOICES } from "@/lib/filters";
import { prisma } from "@/lib/prisma";
import { listingScope } from "@/lib/private-listings";
import { sellerNameSight, sellerShown } from "@/lib/seller-anonymity";
import { withCallLog } from "@/lib/api-log";
import { readIn, withNotes } from "@/lib/bulk-read";

// Live listings this key's account may see. Private sales show only to their invitees, and a seller's excluded
// buyers see none of theirs, by the same rule as the book (lib/private-listings.ts). The seller reads as a type
// until the account is in the listing's data room, as on the listing page (lib/seller-anonymity.ts).
async function handleGet(request: Request) {
  const caller = await apiCaller(request, "listings:read");
  if (caller.response) return caller.response;
  const url = new URL(request.url);
  const page = readPage(url);
  if ("error" in page) return badRequest(page.error);
  const filters = readListingFilters(url);
  if ("error" in filters) return badRequest(filters.error);
  const programs = programParam(url.searchParams.get("loan_program"));
  if (programs === null) return badRequest(`loan_program takes ${PROGRAMS.join(", ")}, comma-separated.`);
  if (programs.length) filters.loanProgram = programs;
  // cra=1: CRA-eligible paper only, as the book's filter reads it (lib/cra.ts). cra=0 or leaving it out is no filter.
  const cra = url.searchParams.get("cra");
  if (cra != null && cra !== "0" && cra !== "1") return badRequest("cra is 1 for CRA-eligible loans only, or 0.");
  if (cra === "1") filters.cra = true;
  // The loans are read by listing (lib/bulk-read.ts): an include across the live book took tens of seconds per
  // call at a few thousand listings.
  const live = await prisma.listing.findMany({
    where: { AND: [liveWhere(), await listingScope(caller.user), ...(page.since ? [{ updatedAt: { gte: page.since } }] : [])] },
  });
  const [withLoans, sellers] = await Promise.all([
    withNotes(live, { oldestFirst: true, shared: true }),
    readIn("User", "id", live.map((listing) => listing.sellerId), { pick: ["id", "role", "name", "companyName", "companyType"] }),
  ]);
  const sellerOf = new Map(sellers.map(({ id, ...seller }) => [id, seller]));
  const listings = withLoans.flatMap((listing) => {
    const seller = sellerOf.get(listing.sellerId);
    return seller ? [{ ...listing, seller }] : [];
  });
  const shown = paginate(listings.filter((listing) => matchesFilters(listing, filters)), (listing) => listing.updatedAt, page);
  const named = await sellerNameSight(caller.user, shown.rows);
  return NextResponse.json({
    listings: shown.rows.map((listing) => ({ ...listingSummary(listing), seller: sellerShown(listing, named.get(listing.id) ?? false) })),
    nextCursor: shown.nextCursor,
  });
}

const PROGRAMS = PROGRAM_CHOICES.map((program) => program.value);

// loan_program, comma-separated like lien_position: the programs asked for, or null when one isn't a program. A loan
// whose tape states no program matches none, as on the book.
function programParam(raw: string | null): string[] | null {
  const values = [...new Set((raw ?? "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))];
  return values.every((value) => (PROGRAMS as string[]).includes(value)) ? values : null;
}

// Logged with the status this route answers (lib/api-log.ts).
export const GET = withCallLog(handleGet);
