"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { rateText, scheduleFromForm, type FeeSchedule } from "@/lib/fee-schedule";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";

function back(message: string, kind: "notice" | "error"): never {
  redirect(`/admin/settings?${kind}=${encodeURIComponent(message)}#graded-fees`);
}

function summary(schedule: FeeSchedule | null) {
  if (!schedule) return "Graded schedule cleared; flat rates apply.";
  const terms = { schedule, premiumBps: 0, commissionBps: 0 };
  const tiers = schedule.tiers.map((tier) => `${tier.upTo === null ? "rest" : `to $${tier.upTo}`} ${tier.premiumBps}/${tier.commissionBps} bps`).join(", ");
  return `Graded schedule: ${tiers}. Premium ${rateText(terms, "premium")}; commission ${rateText(terms, "commission")}.`;
}

// The desk's graded schedule. Listings already live keep the fees they went live with; the next approval takes this.
export async function saveFeeSchedule(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const clear = formData.get("intent") === "clear";
  let schedule: FeeSchedule | null = null;
  if (!clear) {
    const checked = scheduleFromForm({
      upTo: formData.getAll("tierUpTo").map(String),
      premium: formData.getAll("tierPremium").map(String),
      commission: formData.getAll("tierCommission").map(String),
      minPremium: String(formData.get("minPremium") ?? ""),
      minCommission: String(formData.get("minCommission") ?? ""),
    });
    if (checked.error !== null) back(checked.error, "error");
    schedule = checked.schedule;
  }
  await prisma.platformSettings.upsert({
    where: { id: "default" },
    update: { feeSchedule: schedule },
    create: { id: "default", feeSchedule: schedule },
  });
  clearSettingsCache();
  await audit(actor.id, "FEE_SCHEDULE", "settings", "default", summary(schedule));
  revalidatePath("/admin/settings");
  revalidatePath("/fees");
  revalidatePath("/marketplace");
  back(
    schedule
      ? "The graded schedule is saved. Listings already live keep the fees they went live with."
      : "The graded schedule is cleared. New approvals take the flat rates.",
    "notice",
  );
}
