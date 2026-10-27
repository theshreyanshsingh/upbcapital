"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { cleanRetention } from "@/lib/jobs";
import { screenParty } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache } from "@/lib/settings";
import { US_STATES } from "@/lib/labels";

export async function saveDisclosure(formData: FormData) {
  await requireRole(["ADMIN"]);
  const state = String(formData.get("state") || "").trim().toUpperCase();
  const license = String(formData.get("license") || "").trim().slice(0, 500);
  const body = String(formData.get("body") || "").trim();
  if (!(US_STATES as readonly string[]).includes(state) || body.length < 20) {
    redirect("/admin/compliance?error=Choose a state and write the disclosure.");
  }
  await prisma.stateDisclosure.upsert({
    where: { state },
    create: { state, license, body },
    update: { license, body },
  });
  redirect("/admin/compliance?notice=compliance");
}

export async function saveRetention(formData: FormData) {
  await requireRole(["ADMIN"]);
  const years = Number(formData.get("retentionYears") || 7);
  if (!Number.isFinite(years) || years < 1 || years > 25) redirect("/admin/compliance?error=Keep retention between 1 and 25 years.");
  await prisma.platformSettings.update({ where: { id: "default" }, data: { retentionYears: Math.round(years) } });
  clearSettingsCache();
  redirect("/admin/compliance?notice=compliance");
}

export async function runRetention() {
  await requireRole(["ADMIN"]);
  const summary = await cleanRetention();
  redirect(`/admin/compliance?notice=${encodeURIComponent(summary)}`);
}

export async function screenName(formData: FormData) {
  await requireRole(["ADMIN"]);
  const name = String(formData.get("name") || "").trim();
  if (name.length < 2) redirect("/admin/compliance?error=Enter a name to screen.");
  const screen = await screenParty(name);
  await prisma.ofacCheck.create({ data: { name, result: screen.result, provider: screen.provider } });
  redirect(`/admin/compliance?notice=${encodeURIComponent(`${screen.result}: ${screen.detail}`)}`);
}
