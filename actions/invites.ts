"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setSession } from "@/lib/auth";
import { acceptInvite as openAccount, inviteUser, resendInvite, withdrawInvite } from "@/lib/invites";
import { homeFor } from "@/lib/labels";
import { requestMeta } from "@/lib/request-meta";
import { consumeRateLimit } from "@/lib/rate-limit";
import { screenInBackground, screenUser } from "@/lib/screening";
import { requireDesk } from "@/lib/staff";

const BACK = "/admin/users";

function done(kind: "notice" | "error", text: string): never {
  revalidatePath(BACK);
  redirect(`${BACK}?${kind}=${encodeURIComponent(text)}#invites`);
}

export async function sendInvite(formData: FormData) {
  const actor = await requireDesk("admin", BACK);
  const result = await inviteUser({
    actor,
    name: String(formData.get("name") || ""),
    email: String(formData.get("email") || ""),
    companyName: String(formData.get("companyName") || ""),
    role: String(formData.get("role") || ""),
    status: String(formData.get("status") || ""),
  });
  if (result.error !== null) done("error", result.error);
  // Screened as a sign-up is, before the person has done anything.
  screenInBackground(() => screenUser(result.userId, "Invitation"));
  done("notice", "Invitation sent. The link to set a password is good for 7 days.");
}

export async function resendInvitation(formData: FormData) {
  const actor = await requireDesk("admin", BACK);
  const result = await resendInvite(String(formData.get("userId") || ""), actor);
  if (result.error !== null) done("error", result.error);
  done("notice", "A fresh link went out. The earlier one no longer works.");
}

export async function withdrawInvitation(formData: FormData) {
  const actor = await requireDesk("admin", BACK);
  const result = await withdrawInvite(String(formData.get("userId") || ""), actor);
  if (result.error !== null) done("error", result.error);
  done("notice", "Invitation withdrawn. The link no longer works.");
}

// The invited person's set-your-password form. Signing them in straight after puts them on the usual onboarding.
export async function acceptInvitation(formData: FormData) {
  const token = String(formData.get("token") || "");
  const again = `/login/welcome?token=${encodeURIComponent(token)}`;
  const meta = await requestMeta();
  if (!(await consumeRateLimit(`invite-ip:${meta.ipAddress}`, 10, 60 * 60 * 1000))) {
    redirect(`${again}&error=${encodeURIComponent("Too many tries from this network. Wait and try again.")}`);
  }
  const result = await openAccount({
    token,
    password: String(formData.get("password") || ""),
    confirm: String(formData.get("confirm") || ""),
    terms: formData.get("terms"),
  });
  if (result.error !== null) redirect(result.expired ? `/login?error=${encodeURIComponent(result.error)}` : `${again}&error=${encodeURIComponent(result.error)}`);
  const { user } = result;
  await setSession({ sub: user.id, email: user.email, role: user.role, name: user.name });
  if (user.role === "BUYER") redirect(user.accountStatus === "APPROVED" ? "/buyer/verification" : "/buyer/pending");
  if (user.role === "BROKER") redirect("/broker/onboarding");
  redirect(homeFor(user.role));
}
