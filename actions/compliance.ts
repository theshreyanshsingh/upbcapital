"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireDesk } from "@/lib/staff";
import { cleanRetention } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { ofacOpen } from "@/lib/ofac";
import { openReviewWhere, sameReviewIds, screenAndRecord } from "@/lib/screening";
import { clearSettingsCache } from "@/lib/settings";
import { US_STATES } from "@/lib/labels";

export async function saveDisclosure(formData: FormData) {
  await requireDesk("compliance", "/admin/compliance");
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
  await requireDesk("compliance", "/admin/compliance");
  const years = Number(formData.get("retentionYears") || 7);
  if (!Number.isFinite(years) || years < 1 || years > 25) redirect("/admin/compliance?error=Keep retention between 1 and 25 years.");
  await prisma.platformSettings.update({ where: { id: "default" }, data: { retentionYears: Math.round(years) } });
  clearSettingsCache();
  redirect("/admin/compliance?notice=compliance");
}

export async function runRetention() {
  await requireDesk("compliance", "/admin/compliance");
  const summary = await cleanRetention();
  redirect(`/admin/compliance?notice=${encodeURIComponent(summary)}`);
}

export async function screenName(formData: FormData) {
  const user = await requireDesk("compliance", "/admin/compliance");
  const name = String(formData.get("name") || "").trim();
  if (name.length < 2) redirect("/admin/compliance?error=Enter a name to screen.");
  const { screen, check } = await screenAndRecord(name, { context: "Manual screen" });
  await audit(user.id, "OFAC_SCREEN", "ofac", check.id, `${name}: ${screen.result}`);
  revalidatePath("/admin/compliance");
  redirect(`/admin/compliance?notice=${encodeURIComponent(`${screen.result}: ${screen.detail}`)}`);
}

// A decision applies to every row for this name and list entry, so one person is not asked twice.
export async function decideOfacReview(formData: FormData) {
  const user = await requireDesk("compliance", "/admin/compliance");
  const id = String(formData.get("checkId") || "");
  const decision = String(formData.get("decision") || "");
  const note = String(formData.get("note") || "").trim().slice(0, 500);
  if (decision !== "CLEARED" && decision !== "CONFIRMED") redirect("/admin/compliance?error=Choose to clear it or confirm it.");
  if (note.length < 3) redirect("/admin/compliance?error=Write why, so the record stands on its own.");
  const check = await prisma.ofacCheck.findUnique({ where: { id } });
  if (!check || check.result !== "REVIEW") redirect("/admin/compliance?error=That review is not on file.");
  if (!ofacOpen(check)) redirect(`/admin/compliance?error=${encodeURIComponent("That review is already decided. Reopen it to change the decision.")}`);
  // The decision covers this party's screens of this name, never someone else who happens to share it.
  // Only rows still open change, so two people deciding at once can't overwrite each other.
  const same = await sameReviewIds(check);
  const { count } = await prisma.ofacCheck.updateMany({
    where: { id: { in: same }, ...openReviewWhere },
    data: { status: decision, reviewedById: user.id, reviewedAt: new Date(), reviewNote: note },
  });
  if (count === 0) redirect(`/admin/compliance?error=${encodeURIComponent("Someone decided that review a moment ago.")}`);
  await audit(user.id, `OFAC_${decision}`, "ofac", id, `${check.name} against ${check.matched ?? "an unrecorded entry"}: ${note}`);
  revalidatePath("/admin/compliance");
  revalidatePath("/admin/users");
  redirect("/admin/compliance?notice=ofac");
}

// For a mis-click, or a decision that new facts undo. The party's rows go back to open, so every hold applies
// again until someone decides. The audit log keeps the decision it replaced.
export async function reopenOfacReview(formData: FormData) {
  const user = await requireDesk("compliance", "/admin/compliance");
  const id = String(formData.get("checkId") || "");
  const note = String(formData.get("note") || "").trim().slice(0, 500);
  if (note.length < 3) redirect(`/admin/compliance?error=${encodeURIComponent("Write why it needs another look.")}`);
  const check = await prisma.ofacCheck.findUnique({ where: { id } });
  if (!check || check.result !== "REVIEW") redirect("/admin/compliance?error=That review is not on file.");
  if (ofacOpen(check)) redirect(`/admin/compliance?error=${encodeURIComponent("That review is already open.")}`);
  const same = await sameReviewIds(check);
  const { count } = await prisma.ofacCheck.updateMany({
    where: { id: { in: same }, status: check.status },
    data: { status: "OPEN", reviewedById: null, reviewedAt: null, reviewNote: null },
  });
  if (count === 0) redirect(`/admin/compliance?error=${encodeURIComponent("That review changed a moment ago. Look again.")}`);
  await audit(
    user.id,
    "OFAC_REOPENED",
    "ofac",
    id,
    `${check.name} against ${check.matched ?? "an unrecorded entry"}: was ${String(check.status).toLowerCase()} (${check.reviewNote ?? "no note"}). Reopened: ${note}`,
  );
  revalidatePath("/admin/compliance");
  revalidatePath("/admin/users");
  redirect(`/admin/compliance?notice=${encodeURIComponent("The review is open again. Decide it below.")}`);
}
