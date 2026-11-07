"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { sellerPage } from "@/lib/awards";
import { prisma } from "@/lib/prisma";
import { setPublishResult } from "@/lib/results";
import { guardDesk } from "@/lib/staff";

export async function savePublishResult(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const publish = formData.get("publish") === "yes";
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true } });
  const page = user.role === "ADMIN" ? `/admin/listings/${listingId}` : listing?.brokerId === user.id ? `/broker/deals/${listingId}` : listing ? sellerPage(listing, user.role) : "/";
  guardDesk(user, "sales", page);
  const result = await setPublishResult(user, listingId, publish);
  if (result.error) redirect(`${page}?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/results");
  const done = publish
    ? "This sale's result will show on the public results page once it closes, without the address, the parties or the exact balance."
    : "This sale's result won't show on the public results page.";
  redirect(`${page}?notice=${encodeURIComponent(done)}#public-result`);
}
