"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { awaitingSeller, awardOffer, sellerPage } from "@/lib/awards";
import { notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";

// The seller of record answers the desk's recommended bid. A broker who filed the listing is that seller.
export async function answerSaleApproval(formData: FormData) {
  const user = await requireUser();
  const inquiryId = String(formData.get("inquiryId") || "");
  const answer = String(formData.get("answer") || "");
  const offer = await prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { listing: true } });
  if (!offer || offer.listing.sellerId !== user.id) redirect(user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller");
  const back = sellerPage(offer.listing, user.role);
  if (!awaitingSeller(offer) || offer.sellerAskedAmount == null || (offer.status !== "OPEN" && offer.status !== "REVIEWED")) {
    redirect(`${back}?error=${encodeURIComponent("Nothing on this listing is waiting for your answer.")}`);
  }
  const amount = Number(offer.sellerAskedAmount);
  const price = `$${amount.toLocaleString("en-US")}`;
  if (answer === "DECLINE") {
    await prisma.inquiry.update({ where: { id: offer.id }, data: { sellerAnsweredAt: new Date(), sellerDeclined: true } });
    await audit(user.id, "SELLER_DECLINED", "inquiry", offer.id, `${offer.listing.title} · ${price}`);
    await notifyDesk(`Seller declined · ${offer.listing.title}`, `${user.name} declined the sale at ${price}. The bid stays open for the desk to counter or decline.`);
    revalidatePath(back);
    redirect(`${back}?notice=seller_declined`);
  }
  if (answer !== "APPROVE") redirect(`${back}?error=${encodeURIComponent("Approve or decline the sale.")}`);
  await prisma.inquiry.update({ where: { id: offer.id }, data: { sellerApprovedAmount: amount, sellerAnsweredAt: new Date(), sellerDeclined: false } });
  await audit(user.id, "SELLER_APPROVED", "inquiry", offer.id, `${offer.listing.title} · ${price}`);
  const result = await awardOffer(offer.id, user.id);
  if (result.error !== null) {
    // The approval stands. The desk finishes the award once whatever stopped it is cleared.
    await notifyDesk(`Seller approved · ${offer.listing.title}`, `${user.name} approved the sale at ${price}, but the award didn't finish: ${result.error}`);
    revalidatePath(back);
    redirect(`${back}?notice=approved_pending`);
  }
  await notifyDesk(`Seller approved · ${offer.listing.title}`, `${user.name} approved the sale at ${price}. The closing is open.`);
  redirect(`/closings/${result.closingId}?notice=approved`);
}

// A standing approval: the desk may award any bid at or above it without asking again. Blank removes it.
export async function setReserve(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.sellerId !== user.id) redirect(user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller");
  const back = sellerPage(listing, user.role);
  const raw = String(formData.get("reservePrice") || "").replace(/[$,\s]/g, "");
  const reserve = raw ? Number(raw) : null;
  if (reserve !== null && !(Number.isFinite(reserve) && reserve > 0)) redirect(`${back}?error=${encodeURIComponent("Enter a reserve in dollars, or leave it blank.")}`);
  await prisma.listing.update({ where: { id: listingId }, data: { reservePrice: reserve } });
  await audit(user.id, "RESERVE", "listing", listingId, reserve === null ? "Removed" : `$${reserve.toLocaleString("en-US")}`);
  revalidatePath(back);
  redirect(`${back}?notice=reserve`);
}
