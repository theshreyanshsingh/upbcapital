"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireDesk } from "@/lib/staff";
import { settlementLabel, settlementSetting } from "@/lib/closing-clock";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { strikeLimitOf } from "@/lib/strikes";

function back(message: string, kind: "notice" | "error"): never {
  redirect(`/admin/settings?${kind}=${encodeURIComponent(message)}#settlement`);
}

// The weekdays closings settle on, and the strikes before a buyer's bidding pauses. New closings take the
// weekdays; open closings keep their dates.
export async function saveSettlementSettings(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const chosen = formData.getAll("settlementDays").map((value) => String(value).toUpperCase());
  const limitText = String(formData.get("strikeLimit") || "").trim();
  const limit = Number(limitText);
  if (!/^\d+$/.test(limitText) || limit < 1 || limit > 10) back("Set the strike limit as a whole number from 1 to 10.", "error");
  const settlementDays = settlementSetting(chosen);
  const before = await getSettings();
  const data = { settlementDays, strikeLimit: limit };
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: data, create: { id: "default", ...data } });
  clearSettingsCache();
  await audit(
    actor.id,
    "SETTLEMENT_SETTINGS",
    "settings",
    "default",
    `Settlement days ${settlementLabel(before.settlementDays)} to ${settlementLabel(settlementDays)}. Strike limit ${strikeLimitOf(before.strikeLimit)} to ${limit}.`,
  );
  revalidatePath("/admin/settings");
  back(`New closings settle on ${settlementLabel(settlementDays)}. Bidding pauses at ${limit} strike${limit === 1 ? "" : "s"}.`, "notice");
}
