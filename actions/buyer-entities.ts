"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { addBuyerEntity, reviewBuyerEntity, screenEntity } from "@/lib/buyer-entities";
import { screenInBackground } from "@/lib/screening";
import { requireDesk } from "@/lib/staff";

const field = (formData: FormData, key: string) => String(formData.get(key) || "");

// A buyer adds another buying entity to their file. The sanctions screen runs after the reply, since the desk's
// approval screens again and waits for the answer.
export async function addEntity(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const result = await addBuyerEntity(user, {
    name: field(formData, "name"),
    entityType: field(formData, "entityType"),
    jurisdiction: field(formData, "jurisdiction"),
    iraCustodian: field(formData, "iraCustodian"),
    iraAccountTitle: field(formData, "iraAccountTitle"),
  });
  if (result.error !== null) redirect(`/buyer/verification?error=${encodeURIComponent(result.error)}#entities`);
  const entity = result.entity;
  screenInBackground(() => screenEntity(entity, "Buying entity added"));
  revalidatePath("/buyer/verification");
  revalidatePath("/admin/verification");
  redirect(`/buyer/verification?notice=${encodeURIComponent("The entity is with the desk. You can bid through it once they approve it.")}#entities`);
}

// The desk approves or rejects one entity, with a note.
export async function reviewEntity(formData: FormData) {
  const reviewer = await requireDesk("compliance", "/admin/verification");
  const result = await reviewBuyerEntity(reviewer, { entityId: field(formData, "entityId"), decision: field(formData, "decision"), note: field(formData, "note") });
  const back = `/admin/verification${field(formData, "userId") ? `#buyer-${field(formData, "userId")}` : ""}`;
  if (result.error !== null) redirect(`/admin/verification?error=${encodeURIComponent(result.error)}${back.slice("/admin/verification".length)}`);
  revalidatePath("/admin/verification");
  revalidatePath("/buyer/verification");
  redirect(`/admin/verification?notice=${encodeURIComponent(result.status === "APPROVED" ? "Entity approved. The buyer can bid through it." : "Entity declined. The buyer has your note.")}${back.slice("/admin/verification".length)}`);
}
