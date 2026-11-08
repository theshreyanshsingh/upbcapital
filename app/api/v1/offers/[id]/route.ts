import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { sealedFromSeller } from "@/lib/auction";
import { bidderNamer } from "@/lib/bidder-alias";
import { buyerOfferResponse } from "@/lib/buyer-api";
import { prisma } from "@/lib/prisma";
import { DESK_DENIED, deskCan } from "@/lib/staff";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const caller = await apiCaller(request, "offers:read");
  if (caller.response) return caller.response;
  const user = caller.user;
  // A buyer's key reads one of the holder's own inquiries. Everything below is the seller's view.
  if (user.role === "BUYER") return buyerOfferResponse(user.id, (await context.params).id);
  // A desk key reads bids only when its desk role may see sealed ones.
  if (user.role === "ADMIN" && !deskCan(user, "sealedBids")) return NextResponse.json({ error: DESK_DENIED }, { status: 403 });
  const { id } = await context.params;
  const offer = await prisma.inquiry.findFirst({
    where: { id, type: "OFFER", listing: { sellerId: user.id } },
    include: { listing: true, buyer: true, messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!offer) return NextResponse.json({ error: "Offer not found." }, { status: 404 });
  const sealed = sealedFromSeller(offer.listing);
  return NextResponse.json({
    id: offer.id,
    status: offer.status,
    amount: offer.amount && !sealed ? Number(offer.amount) : null,
    sealed,
    listingId: offer.listingId,
    listing: offer.listing.title,
    // By letter until an award, as on the seller's pages.
    buyer: (await bidderNamer(offer.listingId, user))(offer.buyer),
    messages: (sealed ? [] : offer.messages).map((message) => ({
      kind: message.kind,
      amount: message.amount ? Number(message.amount) : null,
      body: message.body,
      createdAt: message.createdAt,
    })),
  });
}
