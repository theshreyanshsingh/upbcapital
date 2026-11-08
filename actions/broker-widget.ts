"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth";
import { readWidgetOrigins } from "@/lib/broker-widget";
import { prisma } from "@/lib/prisma";

function back(key: "notice" | "error", text: string): never {
  return redirect(`/broker/widget?${key}=${encodeURIComponent(text)}`);
}

// The broker turns their intake form on or off and lists the sites that may show it. Only their own profile.
export async function saveWidgetSettings(formData: FormData) {
  const user = await requireRole(["BROKER"]);
  if (user.accountStatus !== "APPROVED") back("error", "The form opens when the desk approves your seat.");
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: user.id }, select: { userId: true } });
  if (!profile) redirect("/broker/onboarding");
  const enabled = formData.get("widgetEnabled") === "on";
  const { origins, error } = readWidgetOrigins(String(formData.get("widgetOrigins") || ""));
  if (error) back("error", error);
  if (enabled && !origins.length) back("error", "List at least one site that may show the form.");
  await prisma.brokerProfile.update({ where: { userId: user.id }, data: { widgetEnabled: enabled, widgetOrigins: origins } });
  await audit(user.id, "BROKER_WIDGET", "user", user.id, `${enabled ? "On" : "Off"} · ${origins.length} site${origins.length === 1 ? "" : "s"}${origins.length ? `: ${origins.join(", ")}` : ""}`);
  revalidatePath("/broker/widget");
  back("notice", enabled ? `The form is on for ${origins.length} site${origins.length === 1 ? "" : "s"}.` : "The form is off. Sites that embed it show nothing.");
}
