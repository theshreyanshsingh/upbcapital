"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { awardCombination, type ComponentOutcome } from "@/lib/awards";
import { money } from "@/lib/format";
import { BASIS_TEXT, excessLine, kickOutLoan } from "@/lib/kickouts";
import { loadPoolPlan, planKey } from "@/lib/pool-optimizer";
import { requireDesk } from "@/lib/staff";

function count(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// What the desk reads back after a combination: what went through, what waits on the seller, and what failed and why.
function outcomeNotice(outcomes: ComponentOutcome[], bidders: Map<string, string>) {
  const awarded = outcomes.filter((row) => row.result === "awarded");
  const asked = outcomes.filter((row) => row.result === "asked");
  const failed = outcomes.filter((row) => row.result === "failed");
  const lines = [
    awarded.length ? `${count(awarded.length, "award")} went through.` : "",
    asked.length ? `${count(asked.length, "award")} went to the seller to approve first.` : "",
    ...failed.map((row) => `${bidders.get(row.bidId) ?? "A bid"} failed: ${row.error}`),
  ].filter(Boolean);
  return lines.join(" ") || "Nothing was awarded.";
}

// The desk awards the optimiser's combination in one go. The plan is worked out again here, and the form's copy has
// to match it, so a bid that moved after the page loaded can't be awarded on figures the desk didn't see.
export async function awardPoolPlan(formData: FormData) {
  const listingId = String(formData.get("listingId") || "");
  const back = `/admin/listings/${listingId}`;
  const user = await requireDesk("sales", back);
  const loaded = await loadPoolPlan(listingId);
  if (!loaded) redirect("/admin");
  const { plan } = loaded;
  if (!plan.picks.length) redirect(`${back}?error=${encodeURIComponent("No bid on this pool can be awarded right now.")}#pool-plan`);
  if (String(formData.get("plan") || "") !== planKey(plan)) {
    redirect(`${back}?error=${encodeURIComponent("The bids changed since the page loaded. Check the new combination and award again.")}#pool-plan`);
  }
  const outcomes = await awardCombination(plan.picks, user.id);
  const bidders = new Map(plan.picks.map((pick) => [pick.bidId, pick.bidder]));
  const notice = outcomeNotice(outcomes, bidders);
  await audit(user.id, "POOL_PLAN", "listing", listingId, `${loaded.listing.title} · ${money(plan.proceeds)} across ${count(plan.picks.length, "bid")} · ${notice}`);
  revalidatePath(back);
  revalidatePath("/admin/offers");
  revalidatePath(`/marketplace/${listingId}`);
  const failed = outcomes.some((row) => row.result === "failed");
  redirect(`${back}?${failed ? "error" : "notice"}=${encodeURIComponent(notice)}#pool-plan`);
}

// The desk takes one loan out of an open closing that covers more than one, with a reason both sides read.
export async function kickOutClosingLoan(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const back = `/closings/${closingId}`;
  const user = await requireDesk("closings", back);
  const result = await kickOutLoan({ closingId, noteId: String(formData.get("noteId") || ""), reason: String(formData.get("reason") || ""), actorId: user.id });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#kickout`);
  revalidatePath(back);
  revalidatePath("/closings");
  revalidatePath("/marketplace");
  const excess = excessLine(result);
  redirect(
    `${back}?notice=${encodeURIComponent(`${result.label} is out of the closing. The price came down ${money(result.dropCents / 100, 2)}, ${BASIS_TEXT[result.basis]}, to ${money(result.salePrice, 2)}.${excess ? ` ${excess}` : ""}`)}`,
  );
}
