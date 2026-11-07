"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assignDealOwner, requireDesk, setDeskRole } from "@/lib/staff";

// An owner sets what each desk account may do. The change is audited and applies on the account's next page.
export async function saveDeskRole(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/users");
  const userId = String(formData.get("userId") || "");
  const result = await setDeskRole(actor, userId, String(formData.get("deskRole") || ""));
  if (result.error !== null) redirect(`/admin/users?error=${encodeURIComponent(result.error)}#staff`);
  revalidatePath("/admin/users");
  redirect(`/admin/users?notice=${encodeURIComponent(result.changed ? "The desk role is saved." : "That was already their role.")}#staff`);
}

// The desk member named to the seller, the broker and the buyer as their contact on a deal.
export async function saveDealOwner(formData: FormData) {
  const kind = String(formData.get("kind") || "") === "closing" ? "closing" : "listing";
  const id = String(formData.get("id") || "");
  const back = kind === "listing" ? `/admin/listings/${id}` : `/closings/${id}`;
  const actor = await requireDesk(kind === "listing" ? "sales" : "closings", back);
  const result = await assignDealOwner(actor, { kind, id, ownerId: String(formData.get("ownerId") || "") });
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent(result.owner ? `${result.owner.name} owns this deal now.` : "This deal has no named owner now.")}`);
}
