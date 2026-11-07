"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDesk } from "@/lib/staff";
import { decideWireChange } from "@/lib/wire-changes";

// A second desk member approves or rejects a proposed wire change. The proposer can withdraw their own by rejecting
// it, but never approve it.
export async function decideWires(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const back = closingId ? `/closings/${closingId}` : "/admin/settings";
  const actor = await requireDesk("approveWires", back);
  const decision = String(formData.get("decision") || "");
  const result = await decideWireChange(actor, { changeId: String(formData.get("changeId") || ""), decision, note: String(formData.get("note") || "") });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#wires`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent(result.applied ? (closingId ? "The new wire instructions are in force, and both sides were told." : "The new default wire instructions are in force for new closings.") : "withdrawn" in result && result.withdrawn ? "You withdrew the wire change. The instructions on file are unchanged." : "The wire change was rejected. The instructions on file are unchanged.")}#wires`);
}
