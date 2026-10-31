"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, requireUser } from "@/lib/auth";
import { openClosing } from "@/lib/closing-service";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";

function amountOf(formData: FormData, key = "amount") {
  const value = Number(String(formData.get(key) || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : NaN;
}

export async function placeDeskBid(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true, seller: true } });
  if (!listing || !["APPROVED", "SUBMITTED", "UNDER_REVIEW", "PENDING"].includes(listing.status)) {
    redirect(`/admin/listings/${listingId}?error=That listing is not open for a desk bid.`);
  }
  const amount = amountOf(formData);
  if (!(amount > 0)) redirect(`/admin/listings/${listingId}?error=Enter a bid.`);
  const noteId = String(formData.get("noteId") || "");
  const note = noteId ? listing.notes.find((item) => item.id === noteId) : null;
  if (noteId && !note) redirect(`/admin/listings/${listingId}?error=That loan is not on this listing.`);
  const message = String(formData.get("message") || "").trim().slice(0, 1000);
  await prisma.deskBid.create({
    data: { listingId, noteId: note?.id, amount, message },
  });
  await audit(user.id, "DESK_BID", "listing", listingId, `Desk bid $${amount.toLocaleString("en-US")}`);
  await notify(
    listing.seller.email,
    `The desk bid on ${listing.title}`,
    `UPB Capital offered $${amount.toLocaleString("en-US")}${note ? ` for one loan` : ""}.${message ? ` ${message}` : ""} Accept or decline it on your listing. Nothing happens without your answer.`,
  );
  revalidatePath("/admin/book");
  redirect(`/admin/listings/${listingId}?notice=bid`);
}

type OpenDeskBid = { id: string; listingId: string; noteId: string | null; amount: number; listing: { status: string; title: string; sellerId: string } };

async function acceptDeskBid(bid: OpenDeskBid) {
  await prisma.deskBid.update({ where: { id: bid.id }, data: { status: "ACCEPTED" } });
  if (bid.noteId) {
    await prisma.note.update({ where: { id: bid.noteId }, data: { tradeStatus: "IN_CONTRACT" } });
  }
  if (bid.listing.status !== "SOLD") {
    await prisma.listing.update({ where: { id: bid.listingId }, data: { status: "PENDING" } });
  }
  return openClosing({
    listingId: bid.listingId,
    deskBidId: bid.id,
    noteId: bid.noteId,
    salePrice: Number(bid.amount),
    title: bid.listing.title,
  });
}

// The desk is the buyer on its own bid, so taking it stands in for the seller only with a recorded agreement.
export async function decideDeskBid(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "");
  const decision = String(formData.get("decision") || "");
  const consent = String(formData.get("consent") || "").trim().slice(0, 300);
  const bid = await prisma.deskBid.findUnique({ where: { id }, include: { listing: { include: { notes: true, seller: true } } } });
  if (!bid || bid.status !== "OPEN") redirect("/admin/book?error=That bid is already decided.");
  if (decision === "DECLINED" || decision === "WITHDRAWN") {
    await prisma.deskBid.update({ where: { id }, data: { status: decision } });
    await audit(user.id, "DESK_BID_PASSED", "listing", bid.listingId, `$${Number(bid.amount).toLocaleString("en-US")}`);
    await notify(bid.listing.seller.email, `Desk bid withdrawn · ${bid.listing.title}`, "The desk withdrew its bid on this listing.");
    redirect("/admin/book?notice=bid");
  }
  if (decision !== "ACCEPTED") redirect("/admin/book?error=Unknown decision.");
  if (consent.length < 3) redirect(`/admin/book?error=${encodeURIComponent("Record how the seller agreed, such as the email and its date.")}`);
  if (await ofacHold({ listingId: bid.listingId, userIds: [bid.listing.sellerId] })) redirect(`/admin/book?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
  const closing = await acceptDeskBid(bid);
  const price = `$${Number(bid.amount).toLocaleString("en-US")}`;
  await audit(user.id, "DESK_BID_ACCEPTED", "listing", bid.listingId, `Closing ${closing.id} at ${price}. Seller agreement: ${consent}`);
  await notify(
    bid.listing.seller.email,
    `Desk purchase · ${bid.listing.title}`,
    `The desk recorded your agreement to sell at ${price} (${consent}) and opened the closing. If you did not agree, write the desk now.`,
  );
  redirect(`/closings/${closing.id}?notice=desk_closing`);
}

export async function answerDeskBid(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("bidId") || "");
  const answer = String(formData.get("answer") || "");
  const bid = await prisma.deskBid.findUnique({ where: { id }, include: { listing: true } });
  if (!bid || bid.listing.sellerId !== user.id) redirect("/seller");
  const back = `/seller/listings/${bid.listingId}`;
  if (bid.status !== "OPEN") redirect(`${back}?error=${encodeURIComponent("That bid is already decided.")}`);
  const price = `$${Number(bid.amount).toLocaleString("en-US")}`;
  if (answer === "DECLINED") {
    await prisma.deskBid.update({ where: { id }, data: { status: "DECLINED" } });
    await audit(user.id, "DESK_BID_DECLINED", "listing", bid.listingId, price);
    await notifyDesk(`Seller declined · ${bid.listing.title}`, `${user.name} declined the desk bid of ${price}.`);
    revalidatePath(back);
    redirect(`${back}?notice=answered`);
  }
  if (answer !== "ACCEPTED") redirect(`${back}?error=${encodeURIComponent("Choose accept or decline.")}`);
  if (await ofacHold({ listingId: bid.listingId, userIds: [user.id] })) {
    await notifyDesk(`Seller accepted · ${bid.listing.title}`, `${user.name} accepted the desk bid of ${price}, but an OFAC review is open. Decide it, then take the bid from the book.`);
    redirect(`${back}?notice=answered`);
  }
  const closing = await acceptDeskBid(bid);
  await audit(user.id, "DESK_BID_ACCEPTED", "listing", bid.listingId, `Closing ${closing.id} at ${price}. Accepted by the seller.`);
  await notifyDesk(`Seller accepted · ${bid.listing.title}`, `${user.name} accepted the desk bid of ${price}. The closing is open.`);
  redirect(`/closings/${closing.id}?notice=desk_closing`);
}

export async function logDeskPayment(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const amount = amountOf(formData);
  const paidOn = String(formData.get("paidOn") || "");
  const memo = String(formData.get("memo") || "").trim().slice(0, 240);
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) redirect("/admin/book?error=Amount and date are required.");
  const holding = await prisma.deskHolding.findUnique({ where: { id: holdingId } });
  if (!holding) redirect("/admin/book?error=That note is not on the desk book.");
  await prisma.cashReceipt.create({
    data: { deskHoldingId: holdingId, amount, paidOn: new Date(`${paidOn}T00:00:00Z`), memo },
  });
  await audit(user.id, "CASH_RECEIPT", "holding", holdingId, `$${amount.toLocaleString("en-US")} on ${paidOn}`);
  revalidatePath("/admin/book");
  redirect("/admin/book?notice=payment");
}

export async function setDeskHoldingStatus(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "");
  const status = String(formData.get("status") || "");
  if (!["CURRENT", "WATCH", "RESOLVED"].includes(status)) redirect("/admin/book?error=Unknown status.");
  await prisma.deskHolding.update({ where: { id }, data: { status: status as "CURRENT" } });
  await audit(user.id, "HOLDING_STATUS", "holding", id, status);
  redirect("/admin/book?notice=owned");
}
