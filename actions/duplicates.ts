"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clearDuplicates } from "@/lib/duplicates";
import { requireDesk } from "@/lib/staff";

// A possible duplicate holds approval until the desk compares the loans. Listing review is the sales side's, so the
// clearance is too. The action checks the role itself, since every export here is an endpoint.

function pageFor(listingId: string) {
  return /^[a-z0-9]{10,40}$/i.test(listingId) ? `/admin/listings/${listingId}` : "/admin/queue";
}

function back(page: string, kind: "notice" | "error", message: string): never {
  redirect(`${page}?${kind}=${encodeURIComponent(message)}#duplicates`);
}

export async function clearDuplicateHold(formData: FormData) {
  const listingId = String(formData.get("listingId") ?? "").trim();
  const page = pageFor(listingId);
  const user = await requireDesk("sales", page);
  const cleared = await clearDuplicates(user, { listingId, note: String(formData.get("note") ?? "") });
  if (!cleared.ok) back(page, "error", cleared.error);
  revalidatePath(page);
  revalidatePath("/admin/queue");
  back(page, "notice", "The match is cleared. Approval no longer waits on it.");
}
