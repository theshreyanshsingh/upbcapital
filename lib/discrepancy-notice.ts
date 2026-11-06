import { sellerPage } from "@/lib/awards";
import { notify } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";

// The seller, and the filing broker, hear that the desk found a difference to answer. A pool's review can raise
// dozens at once, so the email goes at most once an hour per listing and points at the whole list.
export async function tellSellerOfDifferences(listingId: string, from: "desk" | "servicer" = "desk") {
  if (!(await consumeRateLimit(`discrepancy-notice:${listingId}`, 1, 60 * 60 * 1000))) return;
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, title: true, sellerId: true, brokerId: true, seller: { select: { email: true, role: true } }, broker: { select: { email: true } } },
  });
  if (!listing) return;
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}${sellerPage(listing, listing.seller.role)}`;
  const subject = `A difference to answer · ${listing.title}`;
  const what = from === "servicer" ? "A servicer report filed on this listing" : "A document the desk read";
  const body = `${what} doesn't match the tape. Use the document's value or explain the difference. The listing can't go live while a question is open: ${link}`;
  const emails = new Set([listing.seller.email, listing.broker?.email].filter((email): email is string => Boolean(email)));
  for (const email of emails) await notify(email, subject, body);
}
