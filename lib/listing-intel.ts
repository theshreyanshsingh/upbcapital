import { estimateProperty } from "@/lib/enrichment";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";

async function writeEstimate(note: { id: string; city: string; state: string; zip: string; streetAddress: string; estimatedValue: unknown }) {
  const estimate = await estimateProperty({
    city: note.city,
    state: note.state,
    zip: note.zip,
    street: note.streetAddress,
    estimatedValue: Number(note.estimatedValue),
  });
  await prisma.note.update({
    where: { id: note.id },
    data: {
      latitude: estimate.latitude,
      longitude: estimate.longitude,
      avmValue: estimate.value,
      avmProvider: estimate.providerId,
      avmAsOf: new Date(),
    },
  });
}

export async function enrichListing(listingId: string) {
  const notes = await prisma.note.findMany({ where: { listingId, latitude: null } });
  for (const note of notes) await writeEstimate(note);
}

export async function rememberView(listingId: string, userId: string) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await prisma.listingView.findFirst({ where: { listingId, userId, createdAt: { gte: since } } });
  if (recent) return;
  await prisma.listingView.create({ data: { listingId, userId } });
  await prisma.listing.update({ where: { id: listingId }, data: { viewCount: { increment: 1 } } });
}

export async function enrichOpenBook() {
  const notes = await prisma.note.findMany({
    where: { latitude: null, listing: { status: { in: ["APPROVED", "PENDING", "SOLD"] } } },
    take: 80,
  });
  for (const note of notes) await writeEstimate(note);
}

export async function notifyClosedAuctions() {
  const due = await prisma.listing.findMany({
    where: { bidMode: { not: "NONE" }, bidDeadline: { lte: new Date() }, auctionNotifiedAt: null },
    select: { id: true },
  });
  for (const row of due) await notifyIfAuctionClosed(row.id);
}

export async function notifyIfAuctionClosed(listingId: string) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { seller: true, inquiries: { where: { type: "OFFER" }, include: { buyer: true } } },
  });
  if (!listing || listing.bidMode === "NONE" || !listing.bidDeadline || listing.auctionNotifiedAt) return;
  if (listing.bidDeadline.getTime() > Date.now()) return;
  await prisma.listing.update({ where: { id: listingId }, data: { auctionNotifiedAt: new Date() } });
  const subject = `Bids closed · ${listing.title}`;
  const body = `${listing.inquiries.length} bid${listing.inquiries.length === 1 ? "" : "s"} are in. The desk can award from the offer book.`;
  await notify(listing.seller.email, subject, body);
  await notifyDesk(subject, body);
  for (const inquiry of listing.inquiries) {
    await notify(inquiry.buyer.email, subject, `The deadline on ${listing.title} has passed. The desk will award from the book.`);
  }
}
