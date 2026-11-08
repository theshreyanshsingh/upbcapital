"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { requireUser } from "@/lib/auth";
import { sellerPage } from "@/lib/awards";
import { FEE_PAYER_LABELS } from "@/lib/fee-schedule";
import { prisma } from "@/lib/prisma";
import { seatGate } from "@/lib/seats";
import { counterAnyBid, setFeePayer, setResponseWindow } from "@/lib/seller-decisions";

// Each export answers to the seller of record alone. Anyone else goes back to their own home page.
function home(role: string) {
  return role === "BROKER" ? "/broker" : role === "BUYER" ? "/buyer/portfolio" : "/seller";
}

async function ownListing(listingId: string) {
  const user = await requireUser();
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true } });
  if (!listing || listing.sellerId !== user.id) redirect(home(user.role));
  const back = sellerPage(listing, user.role);
  // The listing's terms are the seller's to set, so a firm's seat needs a role that lists (lib/seats.ts).
  const gated = await seatGate(user, "list");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}#seller-terms`);
  return { user, listing, back };
}

// The seller counters any live bid they can see, not only the one the desk asked about.
export async function counterBid(formData: FormData) {
  const user = await requireUser();
  const inquiryId = String(formData.get("inquiryId") || "");
  const offer = await prisma.inquiry.findUnique({ where: { id: inquiryId }, select: { listing: { select: { id: true, sellerId: true, brokerId: true } } } });
  if (!offer || offer.listing.sellerId !== user.id) redirect(home(user.role));
  const back = sellerPage(offer.listing, user.role);
  // The seller's counter is their approval at that price, so it is an award decision for a firm's seat.
  const gated = await actionGate(user, "award");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}#approval-heading`);
  const amount = Number(String(formData.get("counterAmount") || "").replace(/[$,\s]/g, ""));
  const result = await counterAnyBid({ inquiryId, sellerId: user.id, amount });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#approval-heading`);
  revalidatePath(back);
  revalidatePath("/buyer/offers");
  revalidatePath("/admin/offers");
  redirect(`${back}?notice=${encodeURIComponent("Your counter is with the buyer. If they accept it, the desk can award it at that price.")}#approval-heading`);
}

// The hours the seller has to answer the desk's next ask.
export async function saveResponseWindow(formData: FormData) {
  const { user, listing, back } = await ownListing(String(formData.get("listingId") || ""));
  const result = await setResponseWindow({ listingId: listing.id, actorId: user.id, hours: formData.get("sellerResponseHours") });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#seller-terms`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent(result.unchanged ? "Your window to answer is unchanged." : `You have ${result.hours} hours to answer each ask from the desk, from the next one.`)}#seller-terms`);
}

// Who pays UPB's fees, until the listing goes live.
export async function saveFeePayer(formData: FormData) {
  const { user, listing, back } = await ownListing(String(formData.get("listingId") || ""));
  const result = await setFeePayer({ listingId: listing.id, actorId: user.id, payer: String(formData.get("feePayer") || "") });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#seller-terms`);
  revalidatePath(back);
  revalidatePath(`/marketplace/${listing.id}`);
  revalidatePath(`/admin/listings/${listing.id}`);
  redirect(`${back}?notice=${encodeURIComponent(result.unchanged ? "Who pays the fees is unchanged." : `${FEE_PAYER_LABELS[result.payer]}. It locks when the listing goes live.`)}#seller-terms`);
}
