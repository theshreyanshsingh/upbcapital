"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { currentSessionId, requirePerson } from "@/lib/auth";
import { cancelEmailChange, confirmEmail, confirmTarget, requestEmailChange, sendConfirmation } from "@/lib/email-confirm";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request-meta";
import { safeNext } from "@/lib/safe-next";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";

const SECURITY = "/account/security";

// The person signed in. A firm's seat confirms and changes its own address, never the firm's.
async function signedIn() {
  return (await requirePerson({ secondFactorSetup: true })).person;
}

// Back to the page the form sat on, with one notice or error on it.
function back(path: string, kind: "notice" | "error", text: string, anchor = ""): never {
  const [base, query = ""] = path.split("#")[0].split("?");
  const params = new URLSearchParams(query);
  params.delete("notice");
  params.delete("error");
  params.set(kind, text);
  redirect(`${base}?${params.toString()}${anchor}`);
}

// The button on the confirm page. Only a press uses the link, never opening it, and the answer lands on a page whose
// address carries the outcome rather than the token. The current device stays signed in through a change of address.
export async function confirmEmailLink(formData: FormData) {
  const meta = await requestMeta();
  if (!(await consumeRateLimit(`email-confirm-ip:${meta.ipAddress}`, 30, 60 * 60 * 1000))) {
    redirect(`/login/confirm?error=${encodeURIComponent("Too many tries from this network. Wait and try again.")}`);
  }
  const outcome = await confirmEmail(String(formData.get("token") || ""), { keepSessionId: await currentSessionId() });
  revalidatePath(SECURITY);
  redirect(`/login/confirm?state=${outcome.state}`);
}

// "Send the link again", from the shell's banner, the confirm page or the security page.
export async function resendConfirmation(formData: FormData) {
  const user = await signedIn();
  const to = safeNext(formData.get("back"), SECURITY);
  const sent = await sendConfirmation(user.id, confirmTarget(user));
  if (sent.error) back(to, "error", sent.error);
  back(to, "notice", "A new link is on its way. It works for 48 hours.");
}

export type ResendState = { notice: string; error: string };

// The shell's banner, which answers in place since it sits on every page.
export async function resendFromBanner(): Promise<ResendState> {
  const user = await signedIn();
  const sent = await sendConfirmation(user.id, confirmTarget(user));
  return sent.error ? { notice: "", error: sent.error } : { notice: "A new link is on its way.", error: "" };
}

export async function changeEmail(formData: FormData) {
  const user = await signedIn();
  const result = await requestEmailChange(user, { email: String(formData.get("email") || ""), password: String(formData.get("password") || "") });
  if (result.error) back(SECURITY, "error", result.error, "#email");
  revalidatePath(SECURITY);
  back(SECURITY, "notice", "Open the link we sent to the new address. Your email changes once you do.", "#email");
}

export async function cancelChange() {
  const user = await signedIn();
  await cancelEmailChange(user.id);
  revalidatePath(SECURITY);
  back(SECURITY, "notice", "The change is canceled. Your email stays as it was.", "#email");
}

// The desk resends an account's link, from Accounts.
export async function deskResendConfirmation(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/users");
  const user = await prisma.user.findUnique({ where: { id: String(formData.get("userId") || "") } });
  if (!user) back("/admin/users", "error", "That account isn't on the desk.");
  const sent = await sendConfirmation(user.id, confirmTarget(user));
  if (sent.error) back("/admin/users", "error", sent.error);
  await audit(actor.id, "EMAIL_CONFIRM_RESENT", "user", user.id, confirmTarget(user));
  back("/admin/users", "notice", `A new confirmation link went to ${user.name}.`);
}

const SETTING_VALUES: Record<string, boolean | null> = { on: true, off: false, default: null };
const settingLabel = (value: boolean | null | undefined) => (value === true ? "on" : value === false ? "off" : "the default");

// The confirmation gate: on, off, or the default, which is on in release builds.
export async function saveEmailConfirmSetting(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const chosen = String(formData.get("requireEmailConfirmation") || "");
  if (!Object.hasOwn(SETTING_VALUES, chosen)) back("/admin/settings", "error", "Choose on, off or the default.", "#email-confirmation");
  const value = SETTING_VALUES[chosen];
  const before = (await getSettings()).requireEmailConfirmation;
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: { requireEmailConfirmation: value }, create: { id: "default", requireEmailConfirmation: value } });
  clearSettingsCache();
  await audit(actor.id, "EMAIL_CONFIRM_SETTING", "settings", "default", `Email confirmation ${settingLabel(before)} to ${settingLabel(value)}.`);
  revalidatePath("/admin/settings");
  back("/admin/settings", "notice", `Email confirmation is ${settingLabel(value)}.`, "#email-confirmation");
}
