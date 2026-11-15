"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { giveStatement, reconfirmAvailable } from "@/lib/provenance";

// Where each form came from, so the answer lands on the same page. A listing id the form can't have sent goes home.
const PAGES: Record<string, (id: string) => string> = {
  seller: (id) => `/seller/listings/${id}`,
  broker: (id) => `/broker/deals/${id}`,
  resale: (id) => `/buyer/resales/${id}`,
  desk: (id) => `/admin/listings/${id}`,
};

function pageFor(formData: FormData) {
  const listingId = String(formData.get("listingId") || "");
  const page = PAGES[String(formData.get("from") || "")] ?? PAGES.seller;
  return { listingId, page: /^[a-z0-9]{10,40}$/i.test(listingId) ? page(listingId) : "/" };
}

function back(page: string, kind: "notice" | "error", text: string): never {
  redirect(`${page}?${kind}=${encodeURIComponent(text)}#availability`);
}

function refresh(listingId: string, page: string) {
  for (const path of [page, "/marketplace", `/marketplace/${listingId}`, `/admin/listings/${listingId}`, "/admin/queue"]) revalidatePath(path);
}

// The seller of record, their seat, the broker, or the desk with a note, confirms the loans are still for sale.
export async function confirmAvailable(formData: FormData) {
  const user = await requireUser();
  const { listingId, page } = pageFor(formData);
  const result = await reconfirmAvailable(user, { listingId, statement: formData.get("ownership"), note: String(formData.get("note") ?? "") });
  if (!result.ok) back(page, "error", result.error);
  refresh(listingId, page);
  back(page, "notice", result.value.unpaused ? "Confirmed. The listing is back on the book and takes bids again." : "Confirmed. Buyers see today's date as the last time you confirmed it.");
}

// The ownership statement on a listing in review that has none.
export async function giveOwnershipStatement(formData: FormData) {
  const user = await requireUser();
  const { listingId, page } = pageFor(formData);
  const result = await giveStatement(user, { listingId, statement: formData.get("ownership") });
  if (!result.ok) back(page, "error", result.error);
  refresh(listingId, page);
  back(page, "notice", "Thank you. The desk has your ownership statement.");
}
