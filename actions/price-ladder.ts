"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { setPriceLadder, stopPriceLadder } from "@/lib/price-ladder";

// Back to the page the form sits on: the seller's listing or the desk's.
function back(formData: FormData, listingId: string, outcome: { ok: true; message: string } | { ok: false; error: string }): never {
  const page = String(formData.get("from") || "") === "desk" ? `/admin/listings/${listingId}` : `/seller/listings/${listingId}`;
  revalidatePath(page);
  revalidatePath(`/marketplace/${listingId}`);
  const param = outcome.ok ? `notice=${encodeURIComponent(outcome.message)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`${page}?${param}#price-ladder`);
}

export async function setLadder(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const outcome = await setPriceLadder(user, listingId, { step: formData.get("step"), every: formData.get("every"), floor: formData.get("floor") });
  back(formData, listingId, outcome);
}

export async function stopLadder(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  back(formData, listingId, await stopPriceLadder(user, listingId));
}
