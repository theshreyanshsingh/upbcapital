"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clearDiligenceWaiver, diligenceLabel, waiveDiligence } from "@/lib/diligence-checklist";
import { requireDesk } from "@/lib/staff";

// Waivers are a compliance decision. Each action checks the role itself, since every export here is an endpoint.

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function pageFor(listingId: string) {
  return /^[a-z0-9]{10,40}$/i.test(listingId) ? `/admin/listings/${listingId}` : "/admin/queue";
}

function back(page: string, kind: "notice" | "error", message: string): never {
  redirect(`${page}?${kind}=${encodeURIComponent(message)}#diligence`);
}

function refresh(listingId: string) {
  for (const path of [`/admin/listings/${listingId}`, `/seller/listings/${listingId}`, `/marketplace/${listingId}`]) revalidatePath(path);
}

export async function waiveDiligenceItem(formData: FormData) {
  const listingId = text(formData, "listingId");
  const page = pageFor(listingId);
  const user = await requireDesk("compliance", page);
  // "PAY_HISTORY" waives the item on every loan missing it, "PAY_HISTORY:<loan>" on that loan alone.
  const [item, noteId] = text(formData, "target").split(":");
  const waived = await waiveDiligence(user, { listingId, item: item ?? "", noteId: noteId || null, reason: text(formData, "reason") });
  if (!waived.ok) back(page, "error", waived.error);
  refresh(listingId);
  back(page, "notice", `${diligenceLabel(item)} is waived. Buyers see the item and your reason.`);
}

export async function clearDiligenceItemWaiver(formData: FormData) {
  const listingId = text(formData, "listingId");
  const page = pageFor(listingId);
  const user = await requireDesk("compliance", page);
  const cleared = await clearDiligenceWaiver(user, { listingId, key: text(formData, "key") });
  if (!cleared.ok) back(page, "error", cleared.error);
  refresh(listingId);
  back(page, "notice", "The waiver is withdrawn. The item is required again.");
}
