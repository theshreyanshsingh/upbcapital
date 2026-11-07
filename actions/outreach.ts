"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireDesk } from "@/lib/staff";
import { sendListing, type SendKind } from "@/lib/outreach";

export async function sendToBuyers(formData: FormData) {
  const user = await requireDesk("sales", `/admin/listings/${String(formData.get("listingId") || "")}`);
  const listingId = String(formData.get("listingId") || "");
  const kind = String(formData.get("kind") || "LISTING") as SendKind;
  const back = `/admin/listings/${listingId}`;
  if (kind !== "LISTING" && kind !== "DEADLINE") redirect(`${back}?error=Choose what to send.`);
  const userIds = formData.getAll("buyer").map(String).filter(Boolean);
  if (!userIds.length) redirect(`${back}?error=${encodeURIComponent("Pick at least one buyer.")}`);
  const result = await sendListing({ listingId, userIds, kind, note: String(formData.get("note") || ""), actorId: user.id });
  if (result.problem) redirect(`${back}?error=${encodeURIComponent(result.problem)}`);
  await audit(user.id, kind === "DEADLINE" ? "SEND_DEADLINE" : "SEND_LISTING", "listing", listingId, `Sent to ${result.sent}. Skipped ${result.skipped} sent recently or not eligible.`);
  revalidatePath(back);
  const skipped = result.skipped ? ` ${result.skipped} skipped because they had it recently or cannot receive it.` : "";
  redirect(`${back}?notice=${encodeURIComponent(`Sent to ${result.sent} buyer${result.sent === 1 ? "" : "s"}.${skipped}`)}`);
}
