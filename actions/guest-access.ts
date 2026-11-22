"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createGuestPass, revokeGuestPass } from "@/lib/guest-access";

// Outside parties: a guest link for an attorney, a title officer, a custodian or an auditor, from the closing page or
// the seller's view of the room. lib/guest-access.ts checks the person against the closing or the listing each time.

const id = (formData: FormData, key: string) => String(formData.get(key) || "").replace(/[^A-Za-z0-9_-]/g, "");

// Back to the page the form was on: the closing, or the seller's listing.
function back(formData: FormData, outcome: { ok: true } | { ok: false; error: string }, notice: string): never {
  const closingId = id(formData, "closingId");
  const listingId = id(formData, "listingId");
  const from = formData.get("from");
  // Back to the page the form was on: the seller's listing, the buyer's listing page, the broker's deal, or the closing.
  const roomPage = listingId
    ? from === "seller"
      ? `/seller/listings/${listingId}`
      : from === "buyer"
        ? `/marketplace/${listingId}`
        : from === "broker"
          ? `/broker/deals/${listingId}`
          : null
    : null;
  const page = roomPage ?? (closingId ? `/closings/${closingId}` : "/closings");
  if (!outcome.ok) redirect(`${page}?error=${encodeURIComponent(outcome.error)}#outside-parties`);
  revalidatePath(page);
  redirect(`${page}?notice=${encodeURIComponent(notice)}#outside-parties`);
}

export async function addGuestPass(formData: FormData) {
  const user = await requireUser();
  // On the closing page a guest reads the closing, or the listing's data room when the form says so.
  const from = formData.get("from");
  const room = from === "seller" || from === "buyer" || from === "broker" || formData.get("reads") === "room";
  const outcome = await createGuestPass(user, {
    closingId: room ? null : id(formData, "closingId"),
    listingId: room ? id(formData, "listingId") : null,
    name: formData.get("name"),
    email: formData.get("email"),
    role: formData.get("role"),
    days: formData.get("days"),
  });
  back(formData, outcome, "The link is on its way to the guest. The other side sees their name and role.");
}

export async function endGuestPass(formData: FormData) {
  const user = await requireUser();
  const outcome = await revokeGuestPass(user, id(formData, "passId"));
  back(formData, outcome, outcome.ok && !outcome.value.changed ? "That link had already ended." : "The link has ended. It opens nothing now.");
}
