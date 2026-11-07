"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isPrivateDocument } from "@/lib/acl";
import { deadlinePassed, eventSetsTerms } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { guardDesk } from "@/lib/staff";
import { unset } from "@/lib/db-filters";
import { notifyDesk } from "@/lib/email";
import { sendAudience, sendListing } from "@/lib/outreach";
import { prisma } from "@/lib/prisma";
import { watchReprice } from "@/lib/watchers";

async function ownerOrDesk(listingId: string) {
  const user = await requireUser();
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true, documents: true } });
  if (!listing) redirect("/seller");
  if (listing.sellerId !== user.id && user.role !== "ADMIN") redirect("/");
  if (listing.sellerId !== user.id) guardDesk(user, "sales", `/admin/listings/${listingId}`);
  return { user, listing };
}

export async function setAuction(formData: FormData) {
  const listingId = String(formData.get("listingId") || "");
  const { user, listing } = await ownerOrDesk(listingId);
  const bidMode = String(formData.get("bidMode") || "NONE");
  if (bidMode !== "NONE" && bidMode !== "SEALED" && bidMode !== "BEST_AND_FINAL") {
    redirect(`/seller/listings/${listingId}?error=${encodeURIComponent("Choose a bid style.")}`);
  }
  const raw = String(formData.get("bidDeadline") || "");
  const deadline = raw ? new Date(`${raw}:00Z`) : null;
  if (bidMode !== "NONE" && (!deadline || Number.isNaN(deadline.getTime()))) {
    redirect(`/seller/listings/${listingId}?error=${encodeURIComponent("A sealed or best-and-final bid needs a deadline.")}`);
  }
  const terms = user.role === "ADMIN" && listing.sellerId !== user.id ? `/admin/listings/${listingId}` : `/seller/listings/${listingId}`;
  if (!["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(listing.status)) {
    redirect(`${terms}?error=${encodeURIComponent("Bid terms are fixed once a listing is in contract, sold, or declined.")}`);
  }
  // An open sale event sets this listing's rounds from its two dates, so its terms change only through the event.
  const saleEvent = listing.saleEventId ? await prisma.saleEvent.findUnique({ where: { id: listing.saleEventId }, select: { name: true, status: true } }) : null;
  if (saleEvent && eventSetsTerms(saleEvent.status)) {
    redirect(`${terms}?error=${encodeURIComponent(`This listing is in the sale event ${saleEvent.name}, which sets its bid terms. The desk can take it out of the event first.`)}`);
  }
  // Once bids are in, the round's rules hold until it ends. Changing the style or pulling the deadline in would
  // unseal sealed amounts, or cut bidders short. The deadline can still move later.
  const running = listing.bidMode !== "NONE" && !deadlinePassed(listing.bidDeadline);
  const bids = running ? await prisma.inquiry.count({ where: { listingId, type: "OFFER", status: { in: ["OPEN", "REVIEWED", "ACCEPTED"] } } }) : 0;
  if (bids > 0) {
    if (bidMode !== listing.bidMode) redirect(`${terms}?error=${encodeURIComponent("Bids are in, so the bid style can't change until this round ends.")}`);
    if (!deadline || (listing.bidDeadline && deadline.getTime() < listing.bidDeadline.getTime())) {
      redirect(`${terms}?error=${encodeURIComponent("Bids are in. The deadline can move later, not earlier.")}`);
    }
  }
  // Written only while the listing is still outside the event it was read with, so a listing the desk enters in a
  // sale event at the same moment keeps the event's terms.
  const saved = await prisma.listing.updateMany({
    where: { id: listingId, ...(listing.saleEventId ? { saleEventId: listing.saleEventId } : unset("saleEventId")) },
    data: {
      bidMode,
      bidDeadline: bidMode === "NONE" ? null : deadline,
      auctionNotifiedAt: null,
      // A new deadline gets its own 24-hour reminder, to bidders and to watchers.
      ...((listing.bidDeadline?.getTime() ?? null) !== (bidMode === "NONE" ? null : deadline?.getTime() ?? null) ? { bidReminderAt: null, watchReminderAt: null } : {}),
    },
  });
  if (saved.count !== 1) redirect(`${terms}?error=${encodeURIComponent("The listing changed a moment ago. Check its terms and try again.")}`);
  await audit(user.id, "AUCTION", "listing", listingId, `${bidMode} ${deadline ? deadline.toISOString() : "open"}`);
  let announced = "";
  if (user.role === "ADMIN" && formData.get("announce") === "on" && bidMode !== "NONE") {
    const audience = (await sendAudience(listingId)).filter((row) => row.eligible).map((row) => row.userId);
    const result = await sendListing({ listingId, userIds: audience, kind: "DEADLINE", note: "", actorId: user.id });
    if (result.problem) announced = ` Not announced: ${result.problem}`;
    else {
      announced = ` Announced to ${result.sent} buyer${result.sent === 1 ? "" : "s"}.`;
      await audit(user.id, "SEND_DEADLINE", "listing", listingId, `Sent to ${result.sent}. Skipped ${result.skipped}.`);
    }
  }
  revalidatePath(`/marketplace/${listingId}`);
  revalidatePath(`/seller/listings/${listingId}`);
  revalidatePath(`/admin/listings/${listingId}`);
  const back = user.role === "ADMIN" && listing.sellerId !== user.id ? `/admin/listings/${listingId}` : `/seller/listings/${listingId}`;
  redirect(`${back}?notice=${announced ? encodeURIComponent(`Bid terms saved.${announced}`) : "auction"}`);
}

export async function duplicateListing(formData: FormData) {
  const listingId = String(formData.get("listingId") || "");
  const { user, listing } = await ownerOrDesk(listingId);
  const copy = await prisma.listing.create({
    data: {
      kind: listing.kind,
      sellerId: listing.sellerId,
      status: "SUBMITTED",
      title: `Copy of ${listing.title}`.slice(0, 140),
      summary: listing.summary,
      // A copy keeps what the desk reviews it by: the compliance flag, the broker on the deal, and the reserve.
      sellerFinanced: listing.sellerFinanced,
      brokerId: listing.brokerId,
      brokerRole: listing.brokerRole,
      clientSellerName: listing.clientSellerName,
      clientRelationship: listing.clientRelationship,
      reservePrice: listing.reservePrice,
      notes: {
        create: listing.notes.map((note) => ({
          streetAddress: note.streetAddress,
          city: note.city,
          state: note.state,
          zip: note.zip,
          propertyType: note.propertyType,
          occupancy: note.occupancy,
          estimatedValue: note.estimatedValue,
          lienPosition: note.lienPosition,
          upb: note.upb,
          interestRate: note.interestRate,
          monthlyPi: note.monthlyPi,
          paymentStatus: note.paymentStatus,
          monthsDelinquent: note.monthsDelinquent,
          lastPaidDate: note.lastPaidDate,
          originationDate: note.originationDate,
          maturityDate: note.maturityDate,
          askingPrice: note.askingPrice,
          foreclosureStatus: note.foreclosureStatus,
          borrowerName: note.borrowerName,
          memo: note.memo,
        })),
      },
      documents: {
        create: listing.documents
          .filter((document) => !isPrivateDocument(document, listing))
          .map((document) => ({
            type: document.type,
            originalName: document.originalName,
            storedName: document.storedName,
            mime: document.mime,
            size: document.size,
          })),
      },
    },
  });
  await audit(user.id, "DUPLICATE", "listing", copy.id, `Copied from ${listing.id}`);
  revalidatePath("/seller");
  redirect(`/seller/listings/${copy.id}?notice=duplicated`);
}

export async function bulkReprice(formData: FormData) {
  const listingId = String(formData.get("listingId") || "");
  const { user, listing } = await ownerOrDesk(listingId);
  const percent = Number(formData.get("percent"));
  if (!Number.isFinite(percent) || percent < 1 || percent > 150) {
    redirect(`/seller/listings/${listingId}?error=${encodeURIComponent("Price the tape between 1% and 150% of UPB.")}`);
  }
  const back = `/seller/listings/${listingId}`;
  if (!["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(listing.status)) {
    redirect(`${back}?error=${encodeURIComponent("A listing in contract, sold, or declined can't be repriced.")}`);
  }
  if (listing.bidMode !== "NONE" && !deadlinePassed(listing.bidDeadline)) {
    redirect(`${back}?error=${encodeURIComponent("A bid round is running. Reprice after the deadline, so prices don't move under bidders.")}`);
  }
  // Loans already in contract or sold keep the price they trade at.
  const open = listing.notes.filter((note) => note.tradeStatus === "AVAILABLE");
  const priced = open.map((note) => ({ note, price: Math.round(Number(note.upb) * percent) / 100 }));
  await prisma.$transaction(priced.map(({ note, price }) => prisma.note.update({ where: { id: note.id }, data: { askingPrice: price } })));
  await audit(user.id, "REPRICE", "listing", listingId, `${percent}% of UPB on ${open.length} loan${open.length === 1 ? "" : "s"}`);
  if (listing.status === "APPROVED" && user.role !== "ADMIN") {
    await notifyDesk(`Live tape repriced · ${listing.title}`, `${user.name} repriced ${open.length} live loan${open.length === 1 ? "" : "s"} to ${percent}% of UPB.`);
  }
  // Buyers who saved it hear too, whoever repriced it. Only the loans whose price moved count.
  const moved = priced.filter(({ note, price }) => Math.round(Number(note.askingPrice) * 100) !== Math.round(price * 100));
  await watchReprice({
    listingId,
    before: moved.reduce((sum, { note }) => sum + Number(note.askingPrice), 0),
    after: moved.reduce((sum, { price }) => sum + price, 0),
    loans: moved.length,
    actorId: user.id,
  });
  revalidatePath(`/seller/listings/${listingId}`);
  revalidatePath(`/marketplace/${listingId}`);
  redirect(`/seller/listings/${listingId}?notice=repriced`);
}
