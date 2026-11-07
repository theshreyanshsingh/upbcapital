"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { decideDepositOutcome, proposeDepositOutcome } from "@/lib/deposits";
import { requireDesk } from "@/lib/staff";

// A desk member who approves wires proposes a refund or a forfeit of a canceled deal's deposit, with a note.
export async function proposeDeposit(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const back = `/closings/${closingId}`;
  const actor = await requireDesk("approveWires", back);
  const result = await proposeDepositOutcome(actor, { closingId, outcome: String(formData.get("outcome") || ""), note: String(formData.get("note") || "") });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#deposit`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent("The deposit decision is waiting for another desk member to approve it. The buyer was told.")}#deposit`);
}

// A different desk member approves it, with the refund's wire reference, or rejects it. The proposer can withdraw
// their own by rejecting it, but never approve it.
export async function decideDeposit(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const back = `/closings/${closingId}`;
  const actor = await requireDesk("approveWires", back);
  const result = await decideDepositOutcome(actor, { closingId, decision: String(formData.get("decision") || ""), reference: String(formData.get("reference") || "") });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#deposit`);
  revalidatePath(back);
  const notice = result.applied ? "The deposit is decided, and the buyer was told." : result.withdrawn ? "You withdrew the deposit decision." : "The deposit decision was rejected. The deposit stands as it was.";
  redirect(`${back}?notice=${encodeURIComponent(notice)}#deposit`);
}
