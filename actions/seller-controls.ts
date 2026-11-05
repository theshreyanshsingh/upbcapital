"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { sellerPage, withdrawListing as withdrawListingNow } from "@/lib/awards";
import { prisma } from "@/lib/prisma";

// Where the person withdrawing reads the result: the filing broker on the deal page, the seller of record on theirs.
function pageFor(listing: { id: string; sellerId: string; brokerId: string | null }, user: { id: string; role: string }) {
  if (listing.brokerId && listing.brokerId === user.id) return `/broker/deals/${listing.id}`;
  return sellerPage(listing, user.role);
}

// The seller of record or the filing broker takes a listing off the book before it is in contract.
export async function withdrawListing(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true } });
  if (!listing || (listing.sellerId !== user.id && listing.brokerId !== user.id)) {
    redirect(user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller");
  }
  const back = pageFor(listing, user);
  const result = await withdrawListingNow(listing.id, user.id);
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(back);
  revalidatePath("/marketplace");
  revalidatePath(`/marketplace/${listing.id}`);
  revalidatePath("/admin/offers");
  revalidatePath("/admin/queue");
  const bids = result.declined ? ` ${result.declined} open bid${result.declined === 1 ? " was" : "s were"} declined and the bidders told.` : "";
  redirect(`${back}?notice=${encodeURIComponent(`The listing is withdrawn.${bids} The desk was told.`)}`);
}
