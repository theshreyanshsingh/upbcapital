"use server";

import { redirect } from "next/navigation";
import { applyMailings, applyUnsubscribe, MAILING_KEYS, preferenceAddress, readUnsubscribeToken, stopAllMailings } from "@/lib/unsubscribe";

// The button on the unsubscribe page. No sign-in: the signed token is the permission, and it turns off one kind of mail.
export async function confirmUnsubscribe(formData: FormData) {
  const token = String(formData.get("token") || "");
  const found = readUnsubscribeToken(token);
  if (!found) redirect("/unsubscribe");
  await applyUnsubscribe(found);
  redirect(`/unsubscribe?token=${encodeURIComponent(token)}&done=1`);
}

// The preference page's buttons. The signed link names one address; these change that address's mailings and nothing
// else. A box left unticked is a mailing turned off.
function preferencesPage(token: string, done: "saved" | "stopped") {
  return `/unsubscribe/preferences?token=${encodeURIComponent(token)}&done=${done}`;
}

export async function savePreferences(formData: FormData) {
  const token = String(formData.get("token") || "");
  const email = await preferenceAddress(token);
  if (!email) redirect("/unsubscribe/preferences");
  const on = new Set(formData.getAll("on").map(String));
  await applyMailings(email, Object.fromEntries(MAILING_KEYS.map((key) => [key, on.has(key)])));
  redirect(preferencesPage(token, "saved"));
}

export async function stopEverything(formData: FormData) {
  const token = String(formData.get("token") || "");
  const email = await preferenceAddress(token);
  if (!email) redirect("/unsubscribe/preferences");
  await stopAllMailings(email);
  redirect(preferencesPage(token, "stopped"));
}
