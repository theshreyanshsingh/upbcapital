"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { counterLoanPrices } from "@/lib/awards";
import { onGroupCounter } from "@/lib/group-events";
import { deadlinePassed, sealedFromSeller } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { bidderAlias } from "@/lib/bidder-alias";
import { bidCapBlock } from "@/lib/bid-caps";
import { requireUser } from "@/lib/auth";
import { guardDesk } from "@/lib/staff";
import { notify, notifyDesk } from "@/lib/email";
import { fundsLimitBlock } from "@/lib/inquiry";
import { loanPricesFromForm } from "@/lib/loan-prices";
import { bidExpired, canCounter, counterFrom, openCounter } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { recertBlock } from "@/lib/verification";
import { emitWebhook } from "@/lib/webhooks";

function money(amount: number) {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

export async function postOfferMessage(formData: FormData) {
  const user = await requireUser();
  const inquiryId = String(formData.get("inquiryId") || "");
  const body = String(formData.get("body") || "").trim();
  const rawAmount = String(formData.get("amount") || "").replace(/[$,]/g, "");
  const amount = rawAmount ? Number(rawAmount) : null;
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    include: { buyer: true, listing: { include: { seller: true } }, note: true, messages: true },
  });
  if (!inquiry) redirect("/marketplace");
  const desk = user.role === "ADMIN";
  const buyer = user.id === inquiry.buyerId;
  if (!desk && !buyer) redirect("/");
  // A desk counter is a sales decision, and a desk reply quotes the bid, so both sit behind the sales role.
  guardDesk(user, "sales", "/admin/offers");
  const back = desk ? `/admin/offers?notice=message` : `/buyer/offers?notice=message`;
  if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
    redirect(`${back.split("?")[0]}?error=${encodeURIComponent("Enter a counter amount.")}`);
  }
  if (amount != null && !canCounter(inquiry.status)) {
    redirect(`${back.split("?")[0]}?error=${encodeURIComponent("This offer is already decided.")}`);
  }
  if (amount != null && bidExpired(inquiry.expiresAt)) {
    redirect(`${back.split("?")[0]}?error=${encodeURIComponent("This bid passed its good-until date, so its price can't move. The buyer can send a new bid from the listing.")}`);
  }
  if (!body && amount == null) {
    redirect(`${back.split("?")[0]}?error=${encodeURIComponent("Write a note or a counter.")}`);
  }
  // A group's price belongs to its seats: the desk counters and each seat reconfirms. The lead can't move it alone.
  if (buyer && amount != null && (await prisma.groupBuy.count({ where: { inquiryId } })) > 0) {
    redirect(`${back.split("?")[0]}?error=${encodeURIComponent("A group's price changes through its seats. Reconfirm or drop your seat on the group page.")}`);
  }
  // A buyer naming the desk's open counter is accepting it. Anything else is a new price, which the bid rules
  // limit: none after the deadline, and none at all in best and final, where the first bid is the bid.
  const priced = inquiry.messages.map((message) => ({ kind: message.kind, amount: message.amount, createdAt: message.createdAt, authorId: message.authorId }));
  const counter = openCounter(priced, inquiry.buyerId);
  const accepting = buyer && amount != null && counter != null && Math.abs(counter - amount) < 0.005;
  // The seller's own counter is already their approval, so the desk hears the bid is ready to award. One that closed
  // when another bid was awarded (lib/seller-decisions.ts closeOtherCounters) no longer stands as their approval.
  const sellerCounter = accepting && counterFrom(priced, inquiry.buyerId, inquiry.listing.sellerId) === "seller" && inquiry.sellerCounterAmount != null;
  if (buyer && amount != null && !accepting && inquiry.listing.bidMode !== "NONE") {
    if (deadlinePassed(inquiry.listing.bidDeadline)) {
      redirect(`${back.split("?")[0]}?error=${encodeURIComponent("The bid deadline has passed. You can accept a desk counter, but not name a new price.")}`);
    }
    if (inquiry.listing.bidMode === "BEST_AND_FINAL") {
      redirect(`${back.split("?")[0]}?error=${encodeURIComponent("Best and final allows one bid. You can accept a desk counter, but not change your price.")}`);
    }
  }
  // A buyer whose file is past its yearly re-certification names no new price. Accepting a counter still goes through.
  if (buyer && amount != null && !accepting) {
    const lapsed = recertBlock(await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { status: true, recertifyBy: true } }));
    if (lapsed) redirect(`/buyer/verification?error=${encodeURIComponent(lapsed)}`);
  }
  // A new price, or a higher counter accepted, holds the buyer to more, so it fits inside their verified funds too.
  if (buyer && amount != null) {
    const limit = await fundsLimitBlock({ userId: user.id, listingId: inquiry.listingId, noteId: inquiry.noteId, amount });
    if (limit.error) redirect(`${limit.verification ? "/buyer/verification" : back.split("?")[0]}?error=${encodeURIComponent(limit.error)}`);
    // And under the buyer's bid cap, as a new bid is (lib/bid-caps.ts).
    const capped = await bidCapBlock(user.id, amount);
    if (capped) redirect(`${back.split("?")[0]}?error=${encodeURIComponent(capped)}`);
  }
  // A counter is a price for the whole bid, so loan prices under the old total clear, unless the buyer prices each
  // loan again with their own price.
  const typed = buyer ? loanPricesFromForm(formData) : { prices: null, allowPartial: false, error: null };
  if (typed.error) redirect(`${back.split("?")[0]}?error=${encodeURIComponent(typed.error)}`);
  if (typed.prices && amount == null) redirect(`${back.split("?")[0]}?error=${encodeURIComponent("Loan prices go with a new price. Enter the price they add up to.")}`);
  const repriced = amount != null ? await counterLoanPrices({ inquiry, amount, prices: typed.prices, allowPartial: typed.allowPartial }) : null;
  if (repriced?.error) redirect(`${back.split("?")[0]}?error=${encodeURIComponent(repriced.error)}`);
  await prisma.offerMessage.create({
    data: {
      inquiryId,
      authorId: user.id,
      kind: amount != null ? "COUNTER" : "NOTE",
      amount,
      body: body || (accepting ? `Accepted the ${sellerCounter ? "seller" : "desk"}'s counter at ${money(amount!)}.` : amount != null ? `Counter at ${money(amount)}.` : ""),
    },
  });
  if (inquiry.status === "OPEN" && desk) {
    await prisma.inquiry.update({ where: { id: inquiryId }, data: { status: "REVIEWED" } });
  }
  if (repriced?.data) await prisma.inquiry.update({ where: { id: inquiryId }, data: repriced.data });
  if (amount != null) await audit(user.id, "OFFER_COUNTER", "inquiry", inquiryId, `${money(amount)} on ${inquiry.listing.title}`);
  const sealed = sealedFromSeller(inquiry.listing);
  if (desk && amount != null) {
    await onGroupCounter(inquiry.id, amount);
    await emitWebhook(inquiry.listing.sellerId, "offer.countered", {
      inquiryId: inquiry.id,
      listingId: inquiry.listingId,
      amount: sealed ? null : amount,
      sealed,
    });
  }
  const subject = amount != null ? `Counter · ${inquiry.listing.title}` : `Note on ${inquiry.listing.title}`;
  const text = `${user.name}: ${body || money(amount || 0)}`;
  if (desk) await notify(inquiry.buyer.email, subject, repriced?.cleared ? `${text} Your loan prices were cleared with the counter, so price each loan again when you answer if the seller may take part of the pool.` : text);
  else if (sellerCounter) {
    await notify(inquiry.listing.seller.email, `Counter accepted · ${inquiry.listing.title}`, `The buyer accepted your counter at ${money(amount!)}. The desk awards it next.`);
    await notifyDesk(`Seller counter accepted · ${inquiry.listing.title}`, `${user.name} accepted the seller's counter at ${money(amount!)}. The seller already agreed to that price, so it can be awarded from the offer book.`, { capability: "sealedBids" });
  } else {
    // The seller reads the bidder's letter until an award, the desk the name.
    const alias = inquiry.status === "ACCEPTED" ? user.companyName || user.name : await bidderAlias(inquiry.listingId, user.id);
    await notify(inquiry.listing.seller.email, subject, sealed ? `${alias} wrote on a sealed bid. It opens at the deadline.` : `${alias}: ${body || money(amount || 0)}`);
    await notifyDesk(subject, text, { capability: "sealedBids" });
  }
  revalidatePath("/admin/offers");
  revalidatePath("/buyer/offers");
  revalidatePath(`/marketplace/${inquiry.listingId}`);
  redirect(back);
}
