"use server";

import { redirect } from "next/navigation";
import { applyUnsubscribe, readUnsubscribeToken } from "@/lib/unsubscribe";

// The button on the unsubscribe page. No sign-in: the signed token is the permission, and it turns off one kind of mail.
export async function confirmUnsubscribe(formData: FormData) {
  const token = String(formData.get("token") || "");
  const found = readUnsubscribeToken(token);
  if (!found) redirect("/unsubscribe");
  await applyUnsubscribe(found);
  redirect(`/unsubscribe?token=${encodeURIComponent(token)}&done=1`);
}
