"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { requireDesk } from "@/lib/staff";
import { prisma } from "@/lib/prisma";
import { sendDueDigests } from "@/lib/jobs";
import { REPORT_ROLES } from "@/lib/seller-report";

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
      // The monthly market dispatch is opt-in, for every role.
      marketDispatch: formData.get("marketDispatch") === "on",
      // The deal-announcement list is opt-in too. lib/announcements.ts.
      announcements: formData.get("announcements") === "on",
      ...(user.role === "BUYER" ? { dealAlerts: formData.get("dealAlerts") === "on", watchAlerts: formData.get("watchAlerts") === "on" } : {}),
      ...((REPORT_ROLES as readonly string[]).includes(user.role) ? { sellerReport: formData.get("sellerReport") === "on" } : {}),
    },
  });
  redirect("/account/notifications?notice=prefs");
}

export async function sendMatchDigests() {
  await requireDesk("sales", "/admin/analytics");
  const { sent, failed } = await sendDueDigests();
  const missed = failed ? ` ${failed} could not be sent. The server log has the reason.` : "";
  redirect(`/admin/analytics?notice=${encodeURIComponent(`Digest sent to ${sent} buyer${sent === 1 ? "" : "s"}.${missed}`)}`);
}
