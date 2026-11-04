import { estimateProperty } from "@/lib/enrichment";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { unset } from "@/lib/db-filters";

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

// Page renders fill in a few loans at a time, side by side, so a big pool's first view stays fast. Later views
// pick up the rest. Returns how many it wrote.
export async function enrichListing(listingId: string, limit = 12) {
  const notes = await prisma.note.findMany({ where: { listingId, ...unset("latitude") }, take: limit });
  await Promise.all(notes.map((note) => writeEstimate(note).catch(() => undefined)));
  return notes.length;
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
    where: { ...unset("latitude"), listing: { status: { in: ["APPROVED", "PENDING", "SOLD"] } } },
    take: 24,
  });
  await Promise.all(notes.map((note) => writeEstimate(note).catch(() => undefined)));
}

export async function notifyClosedAuctions() {
  const due = await prisma.listing.findMany({
    where: { bidMode: { not: "NONE" }, bidDeadline: { lte: new Date() }, ...unset("auctionNotifiedAt") },
    select: { id: true },
  });
  for (const row of due) await notifyIfAuctionClosed(row.id);
}

export async function notifyIfAuctionClosed(listingId: string) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { seller: true, inquiries: { where: { type: "OFFER", status: { in: ["OPEN", "REVIEWED"] } }, include: { buyer: true } } },
  });
  if (!listing || listing.bidMode === "NONE" || !listing.bidDeadline || listing.auctionNotifiedAt) return;
  if (listing.bidDeadline.getTime() > Date.now()) return;
  // The cron, the offer book and listing pages all call this. Whoever marks the listing first sends.
  const claimed = await prisma.listing.updateMany({ where: { id: listingId, ...unset("auctionNotifiedAt") }, data: { auctionNotifiedAt: new Date() } });
  if (claimed.count !== 1 || listing.status !== "APPROVED") return;
  const subject = `Bids closed · ${listing.title}`;
  const body = `${listing.inquiries.length} bid${listing.inquiries.length === 1 ? "" : "s"} are in. The desk can award from the offer book.`;
  await notify(listing.seller.email, subject, body);
  await notifyDesk(subject, body);
  // One notice per bidder still in the running, however many bids they placed.
  for (const email of new Set(listing.inquiries.map((inquiry) => inquiry.buyer.email))) {
    await notify(email, subject, `The deadline on ${listing.title} has passed. The desk will award from the book.`);
  }
}
