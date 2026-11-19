"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { giveAttestation, revokeAttestation, setBidderLimits, withdrawAttestation } from "@/lib/attestations";
import { requireUser } from "@/lib/auth";
import { sellerPage } from "@/lib/awards";
import { prisma } from "@/lib/prisma";
import { seatGate } from "@/lib/seats";
import { guardDesk, requireDesk } from "@/lib/staff";

// Bidder attestations on the buyer file (lib/attestations.ts), and the listing settings that ask for them. Not the
// post-close trade feedback in actions/attestations.ts.

const field = (formData: FormData, key: string) => String(formData.get(key) || "");
const BACK = "/buyer/verification";
const HASH = "#attestations";

// A statement is the account's certification, so a firm's seat needs a role that signs (lib/seats.ts).
async function buyer(back: string) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus === "REJECTED") redirect("/buyer/pending");
  const gated = await actionGate(user, "sign");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}${HASH}`);
  return user;
}

// Giving one, or giving it again to renew it in the current wording.
export async function giveBidderAttestation(formData: FormData) {
  const user = await buyer(BACK);
  const result = await giveAttestation(user, {
    kind: field(formData, "kind"),
    buyerEntityId: field(formData, "buyerEntityId"),
    reference: field(formData, "reference"),
    agreed: field(formData, "agreed") === "yes",
  });
  if (result.error !== null) redirect(`${BACK}?error=${encodeURIComponent(result.error)}${HASH}`);
  revalidatePath(BACK);
  redirect(`${BACK}?notice=${encodeURIComponent(`The statement is on file for ${result.name}. It counts at each bid on a sale that asks for it.`)}${HASH}`);
}

export async function withdrawBidderAttestation(formData: FormData) {
  const user = await buyer(BACK);
  const result = await withdrawAttestation(user, field(formData, "attestationId"));
  if (result.error !== null) redirect(`${BACK}?error=${encodeURIComponent(result.error)}${HASH}`);
  revalidatePath(BACK);
  redirect(`${BACK}?notice=${encodeURIComponent(`Your ${result.label} is withdrawn. Bids already in stay. Sales that ask for it take no new bid for that entity.`)}${HASH}`);
}

// The desk revokes one from the buyer's page, with a reason the buyer reads.
export async function revokeBidderAttestation(formData: FormData) {
  const userId = field(formData, "userId").replace(/[^A-Za-z0-9_-]/g, "");
  const back = `/admin/buyers/${userId}`;
  const desk = await requireDesk("compliance", back);
  const result = await revokeAttestation(desk, { attestationId: field(formData, "attestationId"), reason: formData.get("reason") });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}${HASH}`);
  revalidatePath(back);
  revalidatePath(BACK);
  redirect(`${back}?notice=${encodeURIComponent(`The ${result.label} is revoked. The buyer has your reason.`)}${HASH}`);
}

// Who may bid on a listing and what each bidder needs on file, from the seller's terms or the desk's listing page.
export async function saveBidderLimits(formData: FormData) {
  const user = await requireUser();
  const listingId = field(formData, "listingId");
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true } });
  if (!listing) redirect(user.role === "ADMIN" ? "/admin/listings" : "/");
  const desk = user.role === "ADMIN";
  const back = desk ? `/admin/listings/${listing.id}` : sellerPage(listing, user.role);
  if (desk) {
    guardDesk(user, "sales", back);
  } else {
    if (listing.sellerId !== user.id) redirect("/");
    // The listing's terms are the seller's to set, so a firm's seat needs a role that lists.
    const gated = await seatGate(user, "list");
    if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}#bidder-limits`);
  }
  const result = await setBidderLimits(user, {
    listingId: listing.id,
    regulated: field(formData, "regulated") === "on",
    kinds: formData.getAll("kinds").map(String),
  });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#bidder-limits`);
  revalidatePath(back);
  revalidatePath(`/marketplace/${listing.id}`);
  revalidatePath(`/admin/listings/${listing.id}`);
  const notice = result.unchanged
    ? "Who may bid is unchanged."
    : `${result.regulated ? "Only banks and credit unions may bid now." : "Any approved buyer may bid."} ${result.kinds.length ? "Each bidder needs the statements you chose on file." : "No statements are asked for."}`;
  redirect(`${back}?notice=${encodeURIComponent(notice)}#bidder-limits`);
}
