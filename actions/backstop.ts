"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { stallDaysOf } from "@/lib/backstop";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";

function back(message: string, kind: "notice" | "error"): never {
  redirect(`/admin/settings?${kind}=${encodeURIComponent(message)}#backstop`);
}

// Days past the target close before the backstop fails a deal with no money moved. Blank keeps the default.
export async function saveStallDays(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const text = String(formData.get("stallDays") || "").trim();
  const days = text ? Number(text) : null;
  if (days !== null && (!/^\d+$/.test(text) || days < 5 || days > 90)) back("Set the backstop as a whole number of days from 5 to 90, or leave it blank.", "error");
  const before = await getSettings();
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: { stallDays: days }, create: { id: "default", stallDays: days } });
  clearSettingsCache();
  await audit(actor.id, "BACKSTOP_SETTINGS", "settings", "default", `Backstop ${stallDaysOf(before.stallDays)} to ${stallDaysOf(days)} days past the target close.`);
  revalidatePath("/admin/settings");
  back(`Open closings fail ${stallDaysOf(days)} days past their target close when no money has moved.`, "notice");
}
