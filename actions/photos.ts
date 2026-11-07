"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { sellerPage } from "@/lib/awards";
import { addPhotos, removePhoto } from "@/lib/photos";
import { prisma } from "@/lib/prisma";
import { deskDenied } from "@/lib/staff";

// Back to the page the photos were managed from: the desk's review, the filing broker's deal, or the seller's own.
async function photoPage(user: { id: string; role: string }, listingId: string) {
  if (user.role === "ADMIN") return `/admin/listings/${listingId}`;
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true } });
  if (!listing) return "/";
  if (listing.brokerId === user.id) return `/broker/deals/${listingId}`;
  return sellerPage(listing, user.role);
}

function back(page: string, key: "notice" | "error", text: string): never {
  redirect(`${page}?${key}=${encodeURIComponent(text)}#photos`);
}

export async function uploadPhotos(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const page = await photoPage(user, listingId);
  const files = await Promise.all(
    formData
      .getAll("photos")
      .filter((file): file is File => file instanceof File && file.size > 0)
      .map(async (file) => ({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })),
  );
  const result = deskDenied(user, "sales") ?? (await addPhotos(user, { listingId, noteId: String(formData.get("noteId") || "") || null, files }));
  if (!result.ok) back(page, "error", result.error);
  revalidatePath(`/marketplace/${listingId}`);
  const { added, skipped } = result.value;
  const lead = added ? `${added} photo${added === 1 ? "" : "s"} added.` : "No photos were added.";
  const left = skipped.length ? ` ${skipped.length === 1 ? "One file wasn't" : `${skipped.length} files weren't`} added (${skipped.slice(0, 3).join(", ")}). Photos are JPEG, PNG or WebP, up to 8 MB, 12 to a listing.` : "";
  back(page, skipped.length && !added ? "error" : "notice", `${lead}${left}`);
}

export async function deletePhoto(formData: FormData) {
  const user = await requireUser();
  const photoId = String(formData.get("photoId") || "");
  const listingId = String(formData.get("listingId") || "");
  const page = await photoPage(user, listingId);
  const result = deskDenied(user, "sales") ?? (await removePhoto(user, photoId));
  if (!result.ok) back(page, "error", result.error);
  revalidatePath(`/marketplace/${listingId}`);
  back(page, "notice", "Photo removed.");
}
