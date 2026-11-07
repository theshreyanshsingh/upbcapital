"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { answerBackup, awardBackup } from "@/lib/backup-bids";
import { prettyDate } from "@/lib/format";
import { requireDesk } from "@/lib/staff";

// The buyer answers the desk's question about standing as backup, on their own bid only.
export async function answerBackupAsk(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const result = await answerBackup({ inquiryId: String(formData.get("inquiryId") || ""), buyerId: user.id, answer: String(formData.get("answer") || "") });
  if (result.error !== null) redirect(`/buyer/offers?error=${encodeURIComponent(result.error)}#backup`);
  revalidatePath("/buyer/offers");
  const notice = result.accepted
    ? `Your bid stands as backup until ${prettyDate(result.until)}. The desk can award it if the winning closing fails.`
    : "Your bid is closed. Thank you for bidding.";
  redirect(`/buyer/offers?notice=${encodeURIComponent(notice)}#backup`);
}

// The desk awards a backup bid from the failed closing's page, through every check an award makes.
export async function awardBackupBid(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const back = `/closings/${closingId}`;
  const actor = await requireDesk("sales", back);
  const result = await awardBackup(actor, String(formData.get("inquiryId") || ""));
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#backups`);
  revalidatePath(back);
  revalidatePath("/admin/offers");
  revalidatePath("/closings");
  if (result.closingId) redirect(`/closings/${result.closingId}?notice=${encodeURIComponent("The backup bid is awarded. The closing checklist is open.")}`);
  redirect(`${back}?notice=${encodeURIComponent("The seller's approval doesn't cover this price, so the seller was asked. The award goes through when they approve.")}#backups`);
}
