"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { openClosing, tradeConflict } from "@/lib/closing-service";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { claimLoan, declineLosingBids, deskBidNotAcceptable, sellerPage } from "@/lib/awards";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";
import { DESK_ROLE_LABELS, deskRoleOf, requireDesk } from "@/lib/staff";

// Who on the desk placed or decided a book bid, for the audit log: the book's buyer is a named person.
function staffLine(user: { id: string; name: string; role: string; deskRole?: string | null }) {
  return `${user.name} (staff ${user.id}, ${DESK_ROLE_LABELS[deskRoleOf(user) ?? "OWNER"]})`;
}

function amountOf(formData: FormData, key = "amount") {
  const value = Number(String(formData.get(key) || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : NaN;
}

// The trader bidding here never sees a sealed amount: the desk's wall in lib/auction.ts hides them from any role
// without the sealedBids capability, and the bid sheet with them.
export async function placeDeskBid(formData: FormData) {
  const listingId = String(formData.get("listingId") || "");
  const user = await requireDesk("deskBook", `/admin/listings/${listingId}`);
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
  await audit(user.id, "DESK_BID", "listing", listingId, `Desk bid $${amount.toLocaleString("en-US")}${note ? " for one loan" : ""} by ${staffLine(user)}`);
  await notify(
    listing.seller.email,
    `The desk bid on ${listing.title}`,
    `UPB Capital offered $${amount.toLocaleString("en-US")}${note ? ` for one loan` : ""}.${message ? ` ${message}` : ""} Accept or decline it on your listing. Nothing happens without your answer.`,
  );
  revalidatePath("/admin/book");
  redirect(`/admin/listings/${listingId}?notice=bid`);
}

type OpenDeskBid = { id: string; listingId: string; noteId: string | null; amount: number; listing: { status: string; title: string; sellerId: string } };

// Returns no closing when the loan was taken by another award, or the bid was answered, in the meantime. The
// bid leaves OPEN in one conditional write, so a seller's accept and the desk's take or pass can't both land.
// A one-loan purchase leaves the rest of a pool on the book; only a whole-listing purchase puts it in contract.
async function acceptDeskBid(bid: OpenDeskBid) {
  if (bid.noteId && !(await claimLoan(bid.noteId))) return { closing: null, reason: "loan" } as const;
  const taken = await prisma.deskBid.updateMany({ where: { id: bid.id, status: "OPEN" }, data: { status: "ACCEPTED" } });
  if (taken.count !== 1) {
    if (bid.noteId) await prisma.note.updateMany({ where: { id: bid.noteId, tradeStatus: "IN_CONTRACT" }, data: { tradeStatus: "AVAILABLE" } });
    return { closing: null, reason: "decided" } as const;
  }
  if (!bid.noteId && bid.listing.status !== "SOLD") {
    await prisma.listing.update({ where: { id: bid.listingId }, data: { status: "PENDING" } });
  }
  const closing = await openClosing({
    listingId: bid.listingId,
    deskBidId: bid.id,
    noteId: bid.noteId,
    salePrice: Number(bid.amount),
    title: bid.listing.title,
  });
  await declineLosingBids({ id: null, listingId: bid.listingId, noteId: bid.noteId }, bid.listing.title);
  return { closing, reason: null } as const;
}

// The desk is the buyer on its own bid, so taking it stands in for the seller only with a recorded agreement.
export async function decideDeskBid(formData: FormData) {
  const user = await requireDesk("deskBook", "/admin/book");
  const id = String(formData.get("id") || "");
  const decision = String(formData.get("decision") || "");
  const consent = String(formData.get("consent") || "").trim().slice(0, 300);
  const bid = await prisma.deskBid.findUnique({ where: { id }, include: { listing: { include: { notes: true, seller: true } } } });
  if (!bid || bid.status !== "OPEN") redirect("/admin/book?error=That bid is already decided.");
  if (decision === "DECLINED" || decision === "WITHDRAWN") {
    const passed = await prisma.deskBid.updateMany({ where: { id, status: "OPEN" }, data: { status: decision } });
    if (passed.count !== 1) redirect("/admin/book?error=That bid is already decided.");
    await audit(user.id, "DESK_BID_PASSED", "listing", bid.listingId, `$${Number(bid.amount).toLocaleString("en-US")} by ${staffLine(user)}`);
    await notify(bid.listing.seller.email, `Desk bid withdrawn · ${bid.listing.title}`, "The desk withdrew its bid on this listing.");
    redirect("/admin/book?notice=bid");
  }
  if (decision !== "ACCEPTED") redirect("/admin/book?error=Unknown decision.");
  if (consent.length < 3) redirect(`/admin/book?error=${encodeURIComponent("Record how the seller agreed, such as the email and its date.")}`);
  const problem = deskBidNotAcceptable(bid.listing);
  if (problem) redirect(`/admin/book?error=${encodeURIComponent(problem)}`);
  if (await ofacHold({ listingId: bid.listingId, userIds: [bid.listing.sellerId] })) redirect(`/admin/book?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
  const conflict = await tradeConflict(bid.listingId, bid.noteId);
  if (conflict) redirect(`/admin/book?error=${encodeURIComponent(conflict)}`);
  const { closing, reason } = await acceptDeskBid(bid);
  if (!closing) {
    redirect(`/admin/book?error=${encodeURIComponent(reason === "loan" ? "That loan went into contract a moment ago. Check its open closing." : "That bid is already decided.")}`);
  }
  const price = `$${Number(bid.amount).toLocaleString("en-US")}`;
  await audit(user.id, "DESK_BID_ACCEPTED", "listing", bid.listingId, `Closing ${closing.id} at ${price}. Taken by ${staffLine(user)}. Seller agreement: ${consent}`);
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
  const home = user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller";
  if (!bid || bid.listing.sellerId !== user.id) redirect(home);
  // A broker or a reselling buyer is the seller of record, but answers from their own page.
  const back = sellerPage(bid.listing, user.role);
  if (bid.status !== "OPEN") redirect(`${back}?error=${encodeURIComponent("That bid is already decided.")}`);
  const price = `$${Number(bid.amount).toLocaleString("en-US")}`;
  if (answer === "DECLINED") {
    const passed = await prisma.deskBid.updateMany({ where: { id, status: "OPEN" }, data: { status: "DECLINED" } });
    if (passed.count !== 1) redirect(`${back}?error=${encodeURIComponent("That bid is already decided.")}`);
    await audit(user.id, "DESK_BID_DECLINED", "listing", bid.listingId, price);
    await notifyDesk(`Seller declined · ${bid.listing.title}`, `${user.name} declined the desk bid of ${price}.`);
    revalidatePath(back);
    redirect(`${back}?notice=answered`);
  }
  if (answer !== "ACCEPTED") redirect(`${back}?error=${encodeURIComponent("Choose accept or decline.")}`);
  const problem = deskBidNotAcceptable(bid.listing);
  if (problem) redirect(`${back}?error=${encodeURIComponent(problem)}`);
  if (await ofacHold({ listingId: bid.listingId, userIds: [user.id] })) {
    await notifyDesk(`Seller accepted · ${bid.listing.title}`, `${user.name} accepted the desk bid of ${price}, but an OFAC review is open. Decide it, then take the bid from the book.`);
    redirect(`${back}?notice=answered`);
  }
  const conflict = await tradeConflict(bid.listingId, bid.noteId);
  if (conflict) redirect(`${back}?error=${encodeURIComponent(conflict)}`);
  const { closing, reason } = await acceptDeskBid(bid);
  if (!closing) {
    redirect(`${back}?error=${encodeURIComponent(reason === "loan" ? "That loan went into contract a moment ago. The desk will be in touch." : "That bid is already decided.")}`);
  }
  await audit(user.id, "DESK_BID_ACCEPTED", "listing", bid.listingId, `Closing ${closing.id} at ${price}. Accepted by the seller.`);
  await notifyDesk(`Seller accepted · ${bid.listing.title}`, `${user.name} accepted the desk bid of ${price}. The closing is open.`);
  redirect(`/closings/${closing.id}?notice=desk_closing`);
}

export async function logDeskPayment(formData: FormData) {
  const user = await requireDesk("deskBook", "/admin/book");
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
  const user = await requireDesk("deskBook", "/admin/book");
  const id = String(formData.get("id") || "");
  const status = String(formData.get("status") || "");
  if (!["CURRENT", "WATCH", "RESOLVED"].includes(status)) redirect("/admin/book?error=Unknown status.");
  await prisma.deskHolding.update({ where: { id }, data: { status: status as "CURRENT" } });
  await audit(user.id, "HOLDING_STATUS", "holding", id, status);
  redirect("/admin/book?notice=owned");
}
