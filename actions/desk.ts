"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isPrivateDocument } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function ownerOrDesk(listingId: string) {
  const user = await requireUser();
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true, documents: true } });
  if (!listing) redirect("/seller");
  if (listing.sellerId !== user.id && user.role !== "ADMIN") redirect("/");
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
  await prisma.listing.update({
    where: { id: listingId },
    data: {
      bidMode,
      bidDeadline: bidMode === "NONE" ? null : deadline,
      auctionNotifiedAt: null,
    },
  });
  await audit(user.id, "AUCTION", "listing", listingId, `${bidMode} ${deadline ? deadline.toISOString() : "open"}`);
  revalidatePath(`/marketplace/${listingId}`);
  revalidatePath(`/seller/listings/${listingId}`);
  revalidatePath(`/admin/listings/${listingId}`);
  const back = user.role === "ADMIN" && listing.sellerId !== user.id ? `/admin/listings/${listingId}` : `/seller/listings/${listingId}`;
  redirect(`${back}?notice=auction`);
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
  await prisma.$transaction(
    listing.notes.map((note) =>
      prisma.note.update({
        where: { id: note.id },
        data: { askingPrice: Math.round(Number(note.upb) * percent) / 100 },
      }),
    ),
  );
  await audit(user.id, "REPRICE", "listing", listingId, `${percent}% of UPB`);
  revalidatePath(`/seller/listings/${listingId}`);
  revalidatePath(`/marketplace/${listingId}`);
  redirect(`/seller/listings/${listingId}?notice=repriced`);
}
