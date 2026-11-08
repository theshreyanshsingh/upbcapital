"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";
import { MAX_TRIAL_DAYS, startFreeTrial, trialDaysOf } from "@/lib/trial";

// The buyer's button on the membership page, for the no-card trial. A Stripe trial starts from checkout instead.
export async function startProTrial() {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const result = await startFreeTrial(user.id);
  if (result.error !== null) redirect(`/buyer/subscription?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/buyer/subscription");
  redirect(`/buyer/subscription?notice=${encodeURIComponent(`Your Pro trial runs until ${prettyDate(result.endsAt)}. Nothing is charged.`)}`);
}

// The trial length, from the settings page. 0 turns the offer off; trials already running keep their end date.
export async function saveTrialSettings(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const raw = String(formData.get("proTrialDays") || "").trim();
  const days = Number(raw || "0");
  if (!/^\d*$/.test(raw) || !Number.isInteger(days) || days < 0 || days > MAX_TRIAL_DAYS) {
    redirect(`/admin/settings?error=${encodeURIComponent(`Set the trial as a whole number of days from 0 to ${MAX_TRIAL_DAYS}.`)}#trial`);
  }
  const before = trialDaysOf((await getSettings()).proTrialDays);
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: { proTrialDays: days }, create: { id: "default", proTrialDays: days } });
  clearSettingsCache();
  await audit(actor.id, "TRIAL_SETTINGS", "settings", "default", `Pro trial ${before} to ${days} days.`);
  revalidatePath("/admin/settings");
  redirect(`/admin/settings?notice=${encodeURIComponent(days ? `New buyers can try Pro for ${days} day${days === 1 ? "" : "s"}, once.` : "The Pro trial is off. Trials already running keep their end date.")}#trial`);
}
