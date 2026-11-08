"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { addExclusion, inviteBuyers, removeExclusion, revokeInvite, setVisibility } from "@/lib/private-listings";
import { deskDenied } from "@/lib/staff";

// The seller's controls on a listing's audience, from the seller's, broker's or desk's listing page, and the seller's
// standing list of excluded buyers. Each action checks the person against the listing in lib/private-listings.ts.

const PAGES: Record<string, (id: string) => string> = {
  seller: (id) => `/seller/listings/${id}`,
  broker: (id) => `/broker/deals/${id}`,
  admin: (id) => `/admin/listings/${id}`,
  resale: (id) => `/buyer/resales/${id}`,
};

function back(formData: FormData, listingId: string, outcome: { ok: true } | { ok: false; error: string }, notice: string): never {
  for (const page of [...Object.values(PAGES), (id: string) => `/marketplace/${id}`]) revalidatePath(page(listingId));
  revalidatePath("/marketplace");
  const page = (PAGES[String(formData.get("from") || "")] ?? PAGES.seller)(listingId);
  const message = outcome.ok ? `notice=${encodeURIComponent(notice)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`${page}?${message}#audience`);
}

export async function setListingVisibility(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const outcome = deskDenied(user, "sales") ?? (await setVisibility(user, { listingId, visibility: formData.get("visibility") }));
  const notice = outcome.ok && outcome.value.visibility === "PRIVATE"
    ? "Private. Only the buyers you invite, the desk and you see this listing."
    : "Public. Every approved buyer can find it on the book.";
  back(formData, listingId, outcome, outcome.ok && !outcome.value.changed ? "Nothing changed." : notice);
}

export async function inviteListingBuyers(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const outcome = deskDenied(user, "sales") ?? (await inviteBuyers(user, { listingId, emails: formData.get("emails") }));
  let notice = "";
  if (outcome.ok) {
    const { invited, skipped } = outcome.value;
    const sent = invited.length ? `Invited ${invited.length} buyer${invited.length === 1 ? "" : "s"}.` : "No new invitations went out.";
    const passed = skipped.map((row) => `${row.email} (${row.reason})`).join(", ");
    notice = passed ? `${sent} Skipped ${passed}.` : sent;
  }
  back(formData, listingId, outcome, notice);
}

export async function revokeListingInvite(formData: FormData) {
  const user = await requireUser();
  const inviteId = String(formData.get("inviteId") || "");
  const invite = await prisma.listingInvite.findUnique({ where: { id: inviteId }, select: { listingId: true } });
  if (!invite) redirect("/");
  const outcome = deskDenied(user, "sales") ?? (await revokeInvite(user, inviteId));
  back(formData, invite.listingId, outcome, "Invitation revoked. The link no longer opens the listing.");
}

function exclusionsBack(outcome: { ok: true } | { ok: false; error: string }, notice: string): never {
  revalidatePath("/seller/exclusions");
  const message = outcome.ok ? `notice=${encodeURIComponent(notice)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`/seller/exclusions?${message}`);
}

export async function addSellerExclusion(formData: FormData) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);
  const outcome = await addExclusion(user, { kind: formData.get("kind"), value: formData.get("value"), reason: formData.get("reason") });
  exclusionsBack(outcome, "Added. None of your listings shows to that buyer, and they aren't told.");
}

export async function removeSellerExclusion(formData: FormData) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);
  const outcome = await removeExclusion(user, String(formData.get("exclusionId") || ""));
  exclusionsBack(outcome, "Removed. Your public listings show to that buyer again.");
}
