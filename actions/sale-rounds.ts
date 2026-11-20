"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { requireUser } from "@/lib/auth";
import { sellerPage } from "@/lib/awards";
import { prisma } from "@/lib/prisma";
import { setFinalRoundOnly, setSaleRounds, setShortlist } from "@/lib/sale-rounds";
import { when } from "@/lib/sale-events";
import { seatGate } from "@/lib/seats";
import { guardDesk } from "@/lib/staff";

// The two-round sale's forms (lib/sale-rounds.ts holds the rules): the setting, the shortlist and the final-round
// files. The seller, the filing broker and the sales desk use them from the seller's terms or the desk's listing page.

const HASH = "#sale-rounds";

async function roundsActor(listingId: string, gate: "list" | "award") {
  const user = await requireUser();
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true } });
  if (!listing) redirect(user.role === "ADMIN" ? "/admin/listings" : "/");
  const desk = user.role === "ADMIN";
  const back = desk ? `/admin/listings/${listing.id}` : listing.brokerId === user.id && listing.sellerId !== user.id ? `/broker/deals/${listing.id}` : sellerPage(listing, user.role);
  if (desk) {
    guardDesk(user, "sales", back);
  } else {
    if (listing.sellerId !== user.id && listing.brokerId !== user.id) redirect("/");
    // The sale's terms and its shortlist are the firm's decisions, so a seat needs the role for them (lib/seats.ts).
    const gated = gate === "award" ? await actionGate(user, "award") : await seatGate(user, "list");
    if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}${HASH}`);
  }
  return { user, listing, back };
}

function done(back: string, listingId: string, notice: string) {
  revalidatePath(back);
  revalidatePath(`/marketplace/${listingId}`);
  revalidatePath(`/admin/listings/${listingId}`);
  redirect(`${back}?notice=${encodeURIComponent(notice)}${HASH}`);
}

export async function saveSaleRounds(formData: FormData) {
  const { user, listing, back } = await roundsActor(String(formData.get("listingId") || ""), "list");
  const on = String(formData.get("twoRounds") || "") === "on";
  const result = await setSaleRounds(user, { listingId: listing.id, on, roundOneEndsAt: formData.get("roundOneEndsAt") });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}${HASH}`);
  const notice = result.unchanged
    ? "The rounds are unchanged."
    : result.on && result.roundOneEndsAt && result.bidDeadline
      ? `Two rounds are on. Indicative bids are due ${when(result.roundOneEndsAt)}, and final bids from the shortlist ${when(result.bidDeadline)}.`
      : "This sale runs one round again.";
  done(back, listing.id, notice);
}

export async function saveShortlist(formData: FormData) {
  const { user, listing, back } = await roundsActor(String(formData.get("listingId") || ""), "award");
  const result = await setShortlist(user, { listingId: listing.id, inquiryIds: formData.getAll("inquiryId").map(String) });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}${HASH}`);
  revalidatePath("/buyer/offers");
  revalidatePath("/admin/offers");
  done(back, listing.id, `The shortlist is set with ${result.shortlisted} of the ${result.of} bidder${result.of === 1 ? "" : "s"} from round one, and each bidder has been told.`);
}

export async function saveFinalRoundFile(formData: FormData) {
  const { user, listing, back } = await roundsActor(String(formData.get("listingId") || ""), "list");
  const documentId = String(formData.get("documentId") || "");
  const document = await prisma.document.findUnique({ where: { id: documentId }, select: { listingId: true } });
  if (!document || document.listingId !== listing.id) redirect(`${back}?error=${encodeURIComponent("That file isn't on this listing.")}${HASH}`);
  const on = String(formData.get("finalRoundOnly") || "") === "on";
  const result = await setFinalRoundOnly(user, { documentId, on });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}${HASH}`);
  done(back, listing.id, result.unchanged ? "That file is unchanged." : on ? "That file now opens to shortlisted bidders only." : "That file opens to every bidder in the room again.");
}
