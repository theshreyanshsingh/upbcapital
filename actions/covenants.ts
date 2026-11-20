"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { acknowledgeAgain } from "@/lib/covenants";
import { seatGate } from "@/lib/seats";

// A buyer whose live bids or group seats on a listing wait on the covenants as they stand now acknowledges them again
// on the listing. A new bid ticks the box in its own form instead (lib/covenants.ts).
export async function acknowledgeCovenants(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const listingId = String(formData.get("listingId") || "");
  const back = `/marketplace/${listingId}`;
  // The acknowledgement is the firm's statement about bids it placed, so a seat needs a role that bids (lib/seats.ts).
  const gated = await seatGate(user, "bid");
  if (gated) redirect(`${back}?error=${encodeURIComponent(gated)}#covenants`);
  const result = await acknowledgeAgain(user, listingId, formData.get("covenantsAck"));
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#covenants`);
  revalidatePath(back);
  revalidatePath("/buyer/offers");
  redirect(`${back}?notice=${encodeURIComponent(result.count ? "Acknowledged. Your bids and seats here carry the covenants as they stand now." : "Nothing here was waiting on your acknowledgement.")}#covenants`);
}
