import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { sealedFromSeller } from "@/lib/auction";
import { bidderNamer } from "@/lib/bidder-alias";
import { buyerOffersResponse } from "@/lib/buyer-api";
import { prisma } from "@/lib/prisma";
import { DESK_DENIED, deskCan } from "@/lib/staff";

export async function GET(request: Request) {
  const caller = await apiCaller(request, "offers:read");
  if (caller.response) return caller.response;
  const user = caller.user;
  // A buyer's key reads the holder's own inquiries and where each stands. Everything below is the seller's view.
  if (user.role === "BUYER") return buyerOffersResponse(request, user.id);
  // A desk key reads bids only when its desk role may see sealed ones.
  if (user.role === "ADMIN" && !deskCan(user, "sealedBids")) return NextResponse.json({ error: DESK_DENIED }, { status: 403 });
  const offers = await prisma.inquiry.findMany({
    where: { type: "OFFER", listing: { sellerId: user.id } },
    include: { listing: true, buyer: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  // A seller's key reads bidders by letter until an award, as the seller's pages do.
  const listingIds = [...new Set(offers.map((offer) => offer.listingId))];
  const namers = new Map(await Promise.all(listingIds.map(async (listingId) => [listingId, await bidderNamer(listingId, user)] as const)));
  return NextResponse.json({
    offers: offers.map((offer) => ({
      id: offer.id,
      status: offer.status,
      amount: offer.amount && !sealedFromSeller(offer.listing) ? Number(offer.amount) : null,
      sealed: sealedFromSeller(offer.listing),
      listingId: offer.listingId,
      listing: offer.listing.title,
      buyer: namers.get(offer.listingId)?.(offer.buyer) ?? "A bidder",
      createdAt: offer.createdAt,
    })),
  });
}
