"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { requireUser } from "@/lib/auth";
import { placeBuyNow } from "@/lib/inquiry";
import { seatLimitBlock } from "@/lib/seats";

// Binding: a verified buyer takes the seller's buy-it-now price. Every check and the award live in lib/inquiry.ts.
export async function buyItNow(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const listingId = String(formData.get("listingId") || "");
  const back = `/marketplace/${listingId}`;
  const price = Number(String(formData.get("price") || "").replace(/[$,\s]/g, ""));
  // Buy it now can't wait for an approver, so a trading seat takes it only inside its limit (lib/seats.ts).
  const gated = (await actionGate(user, "bid")) ?? seatLimitBlock(user, price);
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}#offer`);
  const result = await placeBuyNow({
    user,
    listingId,
    price,
    buyerEntityId: String(formData.get("buyerEntityId") || ""),
  });
  if (result.error !== null) {
    redirect(result.verification ? `/buyer/verification?error=${encodeURIComponent(result.error)}` : `${back}?error=${encodeURIComponent(result.error)}#offer`);
  }
  revalidatePath(back);
  revalidatePath("/marketplace");
  revalidatePath("/buyer/offers");
  revalidatePath("/admin/offers");
  revalidatePath(`/admin/listings/${listingId}`);
  if (result.closingId) redirect(`/closings/${result.closingId}?notice=${encodeURIComponent("You bought it at the buy-it-now price. The closing checklist is open.")}`);
  redirect(`${back}?notice=${encodeURIComponent("Your bid is placed at the buy-it-now price. The desk has to clear one step before the closing opens, and it has been told.")}#offer`);
}
