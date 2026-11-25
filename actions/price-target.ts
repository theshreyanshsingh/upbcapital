"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { clearTarget, setTarget } from "@/lib/target-alerts";

// Back to the listing's price alert form, with what happened.
function back(listingId: string, outcome: { ok: true; message: string } | { ok: false; error: string }): never {
  const page = `/marketplace/${encodeURIComponent(listingId)}`;
  revalidatePath(page);
  revalidatePath("/buyer/favorites");
  const param = outcome.ok ? `notice=${encodeURIComponent(outcome.message)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`${page}?${param}#price-alert`);
}

export async function setPriceTarget(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const listingId = String(formData.get("listingId") || "");
  back(listingId, await setTarget(user, listingId, formData.get("target")));
}

export async function clearPriceTarget(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const listingId = String(formData.get("listingId") || "");
  back(listingId, await clearTarget(user, listingId));
}
