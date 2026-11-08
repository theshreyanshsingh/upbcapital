"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { requireUser } from "@/lib/auth";
import { seatGate, seatLimitBlock } from "@/lib/seats";
import { requireDesk } from "@/lib/staff";
import { confirmStanding, inviteToConfirm, passStanding } from "@/lib/standing-bids";

async function requireBuyer() {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  return user;
}

// The desk sends one standing price to its buyer to confirm. The lib checks the match is on this listing.
export async function inviteStandingBid(formData: FormData) {
  const listingId = String(formData.get("listingId") || "");
  const user = await requireDesk("sales", `/admin/listings/${listingId}`);
  const matchId = String(formData.get("matchId") || "");
  const back = `/admin/listings/${listingId}`;
  const result = await inviteToConfirm(matchId, listingId, user.id);
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#standing-bids`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent("Sent. The buyer has the figure and a link to confirm or pass.")}#standing-bids`);
}

// Binding: the buyer's standing price becomes an offer, after every check the bid form runs.
export async function confirmStandingBid(formData: FormData) {
  const user = await requireBuyer();
  // A seat confirms only as far as its role and limit go (lib/seats.ts).
  const price = Number(String(formData.get("price") || "").replace(/[$,]/g, ""));
  const gated = (await actionGate(user, "bid")) ?? seatLimitBlock(user, price);
  if (gated) redirect(`/buyer/buy-box?error=${encodeURIComponent(gated)}#invitations`);
  const result = await confirmStanding({
    matchId: String(formData.get("matchId") || ""),
    user,
    price,
    goodUntil: String(formData.get("goodUntil") || ""),
    buyerEntityId: String(formData.get("buyerEntityId") || ""),
  });
  if (result.error !== null) {
    redirect(result.verification ? `/buyer/verification?error=${encodeURIComponent(result.error)}` : `/buyer/buy-box?error=${encodeURIComponent(result.error)}#invitations`);
  }
  revalidatePath("/buyer/buy-box");
  revalidatePath("/buyer/offers");
  revalidatePath("/admin/offers");
  revalidatePath(`/admin/listings/${result.listingId}`);
  redirect(`/buyer/offers?notice=${encodeURIComponent("Your bid is placed at the standing price. It binds if the desk accepts it.")}`);
}

export async function passStandingBid(formData: FormData) {
  const user = await requireBuyer();
  const gated = await seatGate(user, "bid");
  if (gated) redirect(`/buyer/buy-box?error=${encodeURIComponent(gated)}#invitations`);
  const result = await passStanding(String(formData.get("matchId") || ""), user.id);
  if (result.error !== null) redirect(`/buyer/buy-box?error=${encodeURIComponent(result.error)}#invitations`);
  revalidatePath("/buyer/buy-box");
  redirect(`/buyer/buy-box?notice=${encodeURIComponent("Passed. The desk will see it on the listing.")}`);
}
