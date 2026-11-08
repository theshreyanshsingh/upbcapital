import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { badRequest, isLive, paginate, readPage } from "@/lib/buyer-api";
import { prisma } from "@/lib/prisma";
import { canSee, listingAccess } from "@/lib/private-listings";
import { watchLink } from "@/lib/watchers";

// The account's buy-box matches on the live book. A match changes when it is made and when its box's standing price
// moves, so updated_since and the order read the later of the two.
export async function GET(request: Request) {
  const caller = await apiCaller(request, "matches:read");
  if (caller.response) return caller.response;
  const page = readPage(new URL(request.url));
  if ("error" in page) return badRequest(page.error);
  const [matches, access] = await Promise.all([
    prisma.listingMatch.findMany({
      where: { userId: caller.user.id, listing: { status: { in: ["APPROVED", "PENDING"] } } },
      include: { listing: true, buyBox: { select: { id: true, name: true, active: true } } },
    }),
    listingAccess(caller.user),
  ]);
  const now = new Date();
  // A listing hidden from the account since it matched, or not yet launched, isn't a match to act on.
  const open = matches.filter((match) => isLive(match.listing, now) && canSee(access, match.listing));
  const changedAt = (match: (typeof open)[number]) => (match.indicativeAt && match.indicativeAt > match.createdAt ? match.indicativeAt : match.createdAt);
  const shown = paginate(open, changedAt, page);
  return NextResponse.json({
    matches: shown.rows.map((match) => ({
      id: match.id,
      listingId: match.listingId,
      listing: match.listing.title,
      listingStatus: match.listing.status,
      buyBoxId: match.buyBoxId,
      buyBox: match.buyBox.name,
      buyBoxActive: match.buyBox.active,
      score: match.score,
      reasons: match.reasons.split(" · ").filter(Boolean),
      // The box's own standing price, indicative until the buyer confirms it as a bid.
      indicativePrice: match.indicativePrice ?? null,
      matchedAt: match.createdAt.toISOString(),
      updatedAt: changedAt(match).toISOString(),
      webUrl: watchLink(match.listingId),
    })),
    nextCursor: shown.nextCursor,
  });
}
