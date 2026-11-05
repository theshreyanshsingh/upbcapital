"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { askedPriceStands, awaitingSeller, awardOffer, recordSellerCounter, sameQuestion, sellerPage } from "@/lib/awards";
import { notifyDesk } from "@/lib/email";
import { bidExpired, buyerPrice } from "@/lib/offers";
import { prisma } from "@/lib/prisma";

// The seller of record answers the desk's recommended bid: approve it, decline it, or counter with their own figure.
// A broker who filed the listing is that seller.
export async function answerSaleApproval(formData: FormData) {
  const user = await requireUser();
  const inquiryId = String(formData.get("inquiryId") || "");
  const answer = String(formData.get("answer") || "");
  const offer = await prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { listing: true, messages: true } });
  if (!offer || offer.listing.sellerId !== user.id) redirect(user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller");
  const back = sellerPage(offer.listing, user.role);
  if (!awaitingSeller(offer) || offer.sellerAskedAmount == null || (offer.status !== "OPEN" && offer.status !== "REVIEWED")) {
    redirect(`${back}?error=${encodeURIComponent("Nothing on this listing is waiting for your answer.")}`);
  }
  const amount = Number(offer.sellerAskedAmount);
  const price = `$${amount.toLocaleString("en-US")}`;
  if (bidExpired(offer.expiresAt)) redirect(`${back}?error=${encodeURIComponent("That bid passed the buyer's good-until date, so there is nothing to answer.")}`);
  if (answer === "COUNTER") {
    const counter = Number(String(formData.get("counterAmount") || "").replace(/[$,\s]/g, ""));
    const result = await recordSellerCounter(offer.id, user.id, counter);
    if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}`);
    revalidatePath(back);
    revalidatePath("/buyer/offers");
    revalidatePath("/admin/offers");
    redirect(`${back}?notice=${encodeURIComponent("Your counter is with the buyer. If they accept it, the desk can award it at that price.")}`);
  }
  if (answer === "DECLINE") {
    const declined = await prisma.inquiry.updateMany({ where: sameQuestion(offer), data: { sellerAnsweredAt: new Date(), sellerDeclined: true } });
    if (declined.count !== 1) redirect(`${back}?error=${encodeURIComponent("This bid was answered a moment ago.")}`);
    await audit(user.id, "SELLER_DECLINED", "inquiry", offer.id, `${offer.listing.title} · ${price}`);
    await notifyDesk(`Seller declined · ${offer.listing.title}`, `${user.name} declined the sale at ${price}. The bid stays open for the desk to counter or decline.`);
    revalidatePath(back);
    redirect(`${back}?notice=seller_declined`);
  }
  if (answer !== "APPROVE") redirect(`${back}?error=${encodeURIComponent("Approve, decline or counter the sale.")}`);
  // An approval only counts for the listing and the bid as they stand, so a stale page can't record one.
  if (offer.listing.status !== "APPROVED") redirect(`${back}?error=${encodeURIComponent("This listing isn't live right now, so the sale can't be approved.")}`);
  const current = buyerPrice(offer.amount, offer.messages.map((message) => ({ kind: message.kind, amount: message.amount, createdAt: message.createdAt, authorId: message.authorId })), offer.buyerId);
  if (!askedPriceStands(amount, current)) {
    await notifyDesk(`Bid changed before approval · ${offer.listing.title}`, `${user.name} tried to approve the sale at ${price}, but the buyer's bid is now $${Number(current ?? 0).toLocaleString("en-US")}. Ask the seller again at the new price.`);
    redirect(`${back}?error=${encodeURIComponent("The buyer changed their bid since the desk asked, so this figure can no longer be approved.")}`);
  }
  const approved = await prisma.inquiry.updateMany({ where: sameQuestion(offer), data: { sellerApprovedAmount: amount, sellerAnsweredAt: new Date(), sellerDeclined: false } });
  if (approved.count !== 1) redirect(`${back}?error=${encodeURIComponent("This bid was answered a moment ago.")}`);
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
