import { NextResponse } from "next/server";
import { userForApiKey } from "@/lib/api-keys";
import { sealedFromSeller } from "@/lib/auction";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const user = await userForApiKey(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unknown API key." }, { status: 401 });
  const offers = await prisma.inquiry.findMany({
    where: { type: "OFFER", listing: { sellerId: user.id } },
    include: { listing: true, buyer: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({
    offers: offers.map((offer) => ({
      id: offer.id,
      status: offer.status,
      amount: offer.amount && !sealedFromSeller(offer.listing) ? Number(offer.amount) : null,
      sealed: sealedFromSeller(offer.listing),
      listingId: offer.listingId,
      listing: offer.listing.title,
      buyer: offer.buyer.name,
      createdAt: offer.createdAt,
    })),
  });
}
