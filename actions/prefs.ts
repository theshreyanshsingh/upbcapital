"use server";

import { redirect } from "next/navigation";
import { requireRole, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendDueDigests } from "@/lib/jobs";

export async function saveNotificationPrefs(formData: FormData) {
  const user = await requireUser();
  const digest = String(formData.get("digest") || "WEEKLY");
  if (!["OFF", "DAILY", "WEEKLY"].includes(digest)) redirect("/account/notifications?error=Unknown digest.");
  await prisma.user.update({
    where: { id: user.id },
    data: {
      notifyEmail: formData.get("notifyEmail") === "on",
      notifyInApp: formData.get("notifyInApp") === "on",
      digest: digest as "WEEKLY",
      ...(user.role === "BUYER" ? { dealAlerts: formData.get("dealAlerts") === "on" } : {}),
    },
  });
  redirect("/account/notifications?notice=prefs");
}

export async function sendMatchDigests() {
  await requireRole(["ADMIN"]);
  const { sent, failed } = await sendDueDigests();
  const missed = failed ? ` ${failed} could not be sent. The server log has the reason.` : "";
  redirect(`/admin/analytics?notice=${encodeURIComponent(`Digest sent to ${sent} buyer${sent === 1 ? "" : "s"}.${missed}`)}`);
}
