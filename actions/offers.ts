"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { onGroupCounter } from "@/actions/group";
import { sealedFromSeller } from "@/lib/auction";
import { requireUser } from "@/lib/auth";
import { notify, notifyDesk } from "@/lib/email";
import { canCounter } from "@/lib/offers";
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
    include: { buyer: true, listing: { include: { seller: true } }, note: true },
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
  await prisma.offerMessage.create({
    data: {
      inquiryId,
      authorId: user.id,
      kind: amount != null ? "COUNTER" : "NOTE",
      amount,
      body: body || (amount != null ? `Counter at ${money(amount)}.` : ""),
    },
  });
  if (inquiry.status === "OPEN" && desk) {
    await prisma.inquiry.update({ where: { id: inquiryId }, data: { status: "REVIEWED" } });
  }
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
