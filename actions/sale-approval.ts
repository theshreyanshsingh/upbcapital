"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { askedPartPrice, askedPriceStands, awaitingSeller, awardOffer, awardPartial, partAsked, recordSellerCounter, sameQuestion, sellerPage, sellerPickBid, setBuyNow } from "@/lib/awards";
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
  // Approving, declining or countering the sale is the seller's award decision (lib/seats.ts).
  const gated = await actionGate(user, "award");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}`);
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
    await notifyDesk(`Seller declined · ${offer.listing.title}`, `${user.name} declined the sale at ${price}. The bid stays open for the desk to counter or decline.`, { capability: "sealedBids" });
    revalidatePath(back);
    redirect(`${back}?notice=seller_declined`);
  }
  if (answer !== "APPROVE") redirect(`${back}?error=${encodeURIComponent("Approve, decline or counter the sale.")}`);
  // An approval only counts for the listing and the bid as they stand, so a stale page can't record one.
  if (offer.listing.status !== "APPROVED") redirect(`${back}?error=${encodeURIComponent("This listing isn't live right now, so the sale can't be approved.")}`);
  // A question about part of a pool is priced at the buyer's loan prices for those loans, as they stand now.
  const part = await partAsked(offer);
  const priced = offer.messages.map((message) => ({ kind: message.kind, amount: message.amount, createdAt: message.createdAt, authorId: message.authorId }));
  const current = part ? askedPartPrice({ ...offer, messages: priced }, part) : buyerPrice(offer.amount, priced, offer.buyerId);
  if (!askedPriceStands(amount, current)) {
    await notifyDesk(`Bid changed before approval · ${offer.listing.title}`, `${user.name} tried to approve the sale at ${price}, but the buyer's bid is now $${Number(current ?? 0).toLocaleString("en-US")}. Ask the seller again at the new price.`, { capability: "sealedBids" });
    redirect(`${back}?error=${encodeURIComponent("The buyer changed their bid since the desk asked, so this figure can no longer be approved.")}`);
  }
  const approved = await prisma.inquiry.updateMany({ where: sameQuestion(offer), data: { sellerApprovedAmount: amount, sellerAnsweredAt: new Date(), sellerDeclined: false } });
  if (approved.count !== 1) redirect(`${back}?error=${encodeURIComponent("This bid was answered a moment ago.")}`);
  await audit(user.id, "SELLER_APPROVED", "inquiry", offer.id, `${offer.listing.title} · ${price}${part ? ` for ${part.length} loan${part.length === 1 ? "" : "s"}` : ""}`);
  // A whole or one-loan award asks the next two bids to stand as backup (lib/backup-bids.ts).
  const result = part ? await awardPartial(offer.id, part, user.id) : await awardOffer(offer.id, user.id, { backups: true });
  if (result.error !== null) {
    // The approval stands. The desk finishes the award once whatever stopped it is cleared.
    await notifyDesk(`Seller approved · ${offer.listing.title}`, `${user.name} approved the sale at ${price}, but the award didn't finish: ${result.error}`, { capability: "sealedBids" });
    revalidatePath(back);
    redirect(`${back}?notice=approved_pending`);
  }
  await notifyDesk(`Seller approved · ${offer.listing.title}`, `${user.name} approved the sale at ${price}. The closing is open.`, { capability: "sealedBids" });
  redirect(`/closings/${result.closingId}?notice=approved`);
}

// The seller picks any live bid and asks the desk to award it, which records their agreement to its price. The desk
// awards it from the offer book once its checks pass, as it would an approved bid.
export async function pickBid(formData: FormData) {
  const user = await requireUser();
  const inquiryId = String(formData.get("inquiryId") || "");
  const offer = await prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { listing: true } });
  if (!offer || offer.listing.sellerId !== user.id) redirect(user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller");
  const back = sellerPage(offer.listing, user.role);
  const gated = await actionGate(user, "award");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}#approval-heading`);
  const result = await sellerPickBid({ inquiryId, sellerId: user.id, price: Number(String(formData.get("price") || "").replace(/[$,\s]/g, "")) });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#approval-heading`);
  revalidatePath(back);
  revalidatePath("/admin/offers");
  revalidatePath(`/admin/listings/${offer.listingId}`);
  redirect(`${back}?notice=${encodeURIComponent(`You asked the desk to award ${result.alias}'s bid of $${result.price.toLocaleString("en-US")}. Your agreement to that price is recorded, and the desk awards it once its checks pass.`)}#approval-heading`);
}

// A standing approval: the desk may award any bid at or above it without asking again. Blank removes it.
export async function setReserve(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.sellerId !== user.id) redirect(user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller");
  const back = sellerPage(listing, user.role);
  // A reserve is a standing approval of any bid above it.
  const gated = await actionGate(user, "award");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}`);
  const raw = String(formData.get("reservePrice") || "").replace(/[$,\s]/g, "");
  const reserve = raw ? Number(raw) : null;
  if (reserve !== null && !(Number.isFinite(reserve) && reserve > 0)) redirect(`${back}?error=${encodeURIComponent("Enter a reserve in dollars, or leave it blank.")}`);
  await prisma.listing.update({ where: { id: listingId }, data: { reservePrice: reserve } });
  await audit(user.id, "RESERVE", "listing", listingId, reserve === null ? "Removed" : `$${reserve.toLocaleString("en-US")}`);
  revalidatePath(back);
  redirect(`${back}?notice=reserve`);
}

// The seller of record, or the broker who filed the listing, commits to a buy-it-now price, changes it, or takes it
// off. Setting it is confirmed in the browser with the consent text, which the lib stores with the date.
export async function saveBuyNow(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true } });
  if (!listing || (listing.sellerId !== user.id && listing.brokerId !== user.id)) redirect(user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller");
  const back = sellerPage(listing, user.role);
  // A buy-it-now price is an award agreed in advance.
  const gated = await actionGate(user, "award");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}#buy-now`);
  const clearing = String(formData.get("intent") || "") === "clear";
  const raw = String(formData.get("buyNowPrice") || "").replace(/[$,\s]/g, "");
  const price = clearing ? null : raw ? Number(raw) : NaN;
  const result = await setBuyNow(listingId, user.id, price);
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#buy-now`);
  revalidatePath(back);
  revalidatePath(`/marketplace/${listingId}`);
  revalidatePath(`/admin/listings/${listingId}`);
  // Counsel: the set notice restates the seller's commitment.
  const notice = clearing
    ? "Buy it now is off. Bids go by your reserve and your approval again."
    : result.unchanged
      ? "The buy-it-now price is unchanged."
      : `Buy it now is set at $${Number(result.price).toLocaleString("en-US")}. The first verified buyer who confirms it opens the closing.`;
  redirect(`${back}?notice=${encodeURIComponent(notice)}#buy-now`);
}
