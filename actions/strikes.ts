"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDesk } from "@/lib/staff";
import { clearStrike } from "@/lib/strikes";

// The pages a clear can come from. Anything else goes back to the buyer files.
const BACK = ["/admin/verification", "/admin/users"] as const;

export async function clearBuyerStrike(formData: FormData) {
  const actor = await requireDesk("compliance", "/admin/verification");
  const strikeId = String(formData.get("strikeId") || "");
  const note = String(formData.get("note") || "");
  const asked = String(formData.get("back") || "");
  const back = (BACK as readonly string[]).includes(asked) ? asked : BACK[0];
  const result = await clearStrike({ strikeId, actorId: actor.id, note });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/admin/verification");
  revalidatePath("/admin/users");
  revalidatePath("/buyer/verification");
  redirect(`${back}?notice=${encodeURIComponent("The strike is cleared, and the note is in the audit log.")}`);
}
