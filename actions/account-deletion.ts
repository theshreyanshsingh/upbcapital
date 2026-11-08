"use server";

import { redirect } from "next/navigation";
import { completeDeletion, refuseDeletion, requestDeletion } from "@/lib/account-deletion";
import { requireUser } from "@/lib/auth";
import { requireDesk } from "@/lib/staff";

const to = (path: string, key: "notice" | "error", text: string, anchor: string) => `${path}?${key}=${encodeURIComponent(text)}#${anchor}`;

// From the account's security page. The box is required in the form too; this is for a form posted without it.
export async function requestAccountDeletion(formData: FormData) {
  const user = await requireUser({ secondFactorSetup: true });
  // A seat acts for the firm, and the firm's account isn't a seat's to delete (lib/seats.ts).
  if (user.actor) redirect(to("/account/security", "error", "A seat can't delete the firm's account. The account owner can.", "delete"));
  if (formData.get("confirm") !== "yes") redirect(to("/account/security", "error", "Tick the box to confirm you want the account deleted.", "delete"));
  const result = await requestDeletion(user, String(formData.get("reason") || ""));
  if (result.error) redirect(to("/account/security", "error", result.error, "delete"));
  redirect(to("/account/security", "notice", "Your request is with the desk. You'll hear by email when it is decided.", "delete"));
}

export async function decideDeletionRequest(formData: FormData) {
  const desk = await requireDesk("compliance", "/admin/compliance");
  const id = String(formData.get("requestId") || "");
  const note = String(formData.get("note") || "");
  const decision = formData.get("decision");
  const result =
    decision === "COMPLETED" ? await completeDeletion(id, desk, note) : decision === "REFUSED" ? await refuseDeletion(id, desk, note) : ({ error: "Pick complete or refuse." } as const);
  if (result.error) redirect(to("/admin/compliance", "error", result.error, "deletion"));
  redirect(
    to(
      "/admin/compliance",
      "notice",
      decision === "COMPLETED" ? "The account is anonymised and locked. Its deal records stay." : "The request is refused, and the account holder was told why.",
      "deletion",
    ),
  );
}
