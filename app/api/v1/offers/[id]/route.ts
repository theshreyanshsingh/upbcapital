import { NextResponse } from "next/server";
import { userForApiKey } from "@/lib/api-keys";
import { sealedFromSeller } from "@/lib/auction";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await userForApiKey(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unknown API key." }, { status: 401 });
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
    buyer: offer.buyer.name,
    messages: (sealed ? [] : offer.messages).map((message) => ({
      kind: message.kind,
      amount: message.amount ? Number(message.amount) : null,
      body: message.body,
      createdAt: message.createdAt,
    })),
  });
}
