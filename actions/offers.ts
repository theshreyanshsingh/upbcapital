"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { onGroupCounter } from "@/actions/group";
import { deadlinePassed, sealedFromSeller } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { notify, notifyDesk } from "@/lib/email";
import { canCounter, openCounter } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
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
  const back = desk ? `/admin/offers?notice=message` : `/buyer/offers?notice=message`;
  if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
    redirect(`${back.split("?")[0]}?error=${encodeURIComponent("Enter a counter amount.")}`);
  }
  if (amount != null && !canCounter(inquiry.status)) {
    redirect(`${back.split("?")[0]}?error=${encodeURIComponent("This offer is already decided.")}`);
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
  const counter = openCounter(
    inquiry.messages.map((message) => ({ kind: message.kind, amount: message.amount, createdAt: message.createdAt, authorId: message.authorId })),
    inquiry.buyerId,
  );
  const accepting = buyer && amount != null && counter != null && Math.abs(counter - amount) < 0.005;
  if (buyer && amount != null && !accepting && inquiry.listing.bidMode !== "NONE") {
    if (deadlinePassed(inquiry.listing.bidDeadline)) {
      redirect(`${back.split("?")[0]}?error=${encodeURIComponent("The bid deadline has passed. You can accept a desk counter, but not name a new price.")}`);
    }
    if (inquiry.listing.bidMode === "BEST_AND_FINAL") {
      redirect(`${back.split("?")[0]}?error=${encodeURIComponent("Best and final allows one bid. You can accept a desk counter, but not change your price.")}`);
    }
  }
  await prisma.offerMessage.create({
    data: {
      inquiryId,
      authorId: user.id,
      kind: amount != null ? "COUNTER" : "NOTE",
      amount,
      body: body || (accepting ? `Accepted the desk's counter at ${money(amount!)}.` : amount != null ? `Counter at ${money(amount)}.` : ""),
    },
  });
  if (inquiry.status === "OPEN" && desk) {
    await prisma.inquiry.update({ where: { id: inquiryId }, data: { status: "REVIEWED" } });
  }
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
  if (desk) await notify(inquiry.buyer.email, subject, text);
  else {
    await notify(inquiry.listing.seller.email, subject, sealed ? `${user.name} wrote on a sealed bid. It opens at the deadline.` : text);
    await notifyDesk(subject, text);
  }
  revalidatePath("/admin/offers");
  revalidatePath("/buyer/offers");
  revalidatePath(`/marketplace/${inquiry.listingId}`);
  redirect(back);
}
