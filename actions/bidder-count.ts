"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { sellerPage } from "@/lib/awards";
import { setBidderCount } from "@/lib/bidder-count";
import { prisma } from "@/lib/prisma";
import { seatGate } from "@/lib/seats";
import { guardDesk } from "@/lib/staff";

// The seller's switch to show bidders how many others are bidding, from their listing's terms, or the desk's from its
// listing page. The seller of record sets it, as a firm's seat that lists; the desk's sales side sets it for them.
export async function saveBidderCount(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const on = String(formData.get("showBidderCount") || "") === "on";
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true } });
  const desk = user.role === "ADMIN";
  if (!listing || (!desk && listing.sellerId !== user.id)) redirect(user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller");
  const back = desk ? `/admin/listings/${listing.id}` : sellerPage(listing, user.role);
  if (desk) guardDesk(user, "sales", back);
  const gated = desk ? null : await seatGate(user, "list");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}#bidder-count`);
  const result = await setBidderCount({ listingId: listing.id, actor: user, on });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#bidder-count`);
  revalidatePath(back);
  revalidatePath(`/marketplace/${listing.id}`);
  revalidatePath(`/admin/listings/${listing.id}`);
  const notice = result.unchanged
    ? "The bidder count is unchanged."
    : result.on
      ? "Bidders now see how many others are bidding on this listing. Never an amount."
      : "Bidders no longer see how many others are bidding.";
  redirect(`${back}?notice=${encodeURIComponent(notice)}#bidder-count`);
}
