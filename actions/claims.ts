"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import {
  acceptCure,
  addClaimFiles,
  answerClaim,
  askDeskReview,
  confirmSettlement,
  decideClaim,
  fileClaim,
  readClaimSettings,
  responseDaysOf,
  survivalDaysOf,
  withdrawClaim,
  type ClaimUpload,
} from "@/lib/claims";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";

// Every rule, and who may do what, is in lib/claims.ts. These read the form and say what happened.

async function uploadsFrom(formData: FormData): Promise<ClaimUpload[]> {
  const files = formData.getAll("files").filter((file): file is File => file instanceof File && file.size > 0 && file.name !== "");
  return Promise.all(files.map(async (file) => ({ name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) })));
}

function finish(closingId: string, outcome: { error: string | null }, notice: string): never {
  const back = `/closings/${closingId}`;
  if (outcome.error !== null) redirect(`${back}?error=${encodeURIComponent(outcome.error)}#claims`);
  revalidatePath(back);
  revalidatePath("/admin/claims");
  redirect(`${back}?notice=${encodeURIComponent(notice)}#claims`);
}

// The closing a claim is on, read from the claim rather than the form.
async function claimHome(formData: FormData) {
  const claimId = String(formData.get("claimId") || "");
  const claim = claimId ? await prisma.repurchaseClaim.findUnique({ where: { id: claimId }, select: { id: true, closingId: true } }) : null;
  if (!claim) redirect("/closings?error=That claim no longer exists.");
  return claim;
}

export async function fileRepurchaseClaim(formData: FormData) {
  const user = await requireUser();
  const closingId = String(formData.get("closingId") || "");
  const result = await fileClaim(user, {
    closingId,
    rep: formData.get("rep"),
    noteId: formData.get("noteId") || undefined,
    description: formData.get("description"),
    remedy: formData.get("remedy"),
    amount: formData.get("amount"),
    files: await uploadsFrom(formData),
  });
  finish(closingId, result, "Your claim is filed. The seller and the desk were told.");
}

export async function answerRepurchaseClaim(formData: FormData) {
  const user = await requireUser();
  const claim = await claimHome(formData);
  // The form's values read as words in the confirmation, so "Dispute" arrives and is read as DISPUTE.
  const kind = String(formData.get("kind") || "").trim().toUpperCase();
  const result = await answerClaim(user, { claimId: claim.id, kind, text: formData.get("text"), files: await uploadsFrom(formData) });
  finish(claim.closingId, result, kind === "DISPUTE" ? "Your answer is in. The desk reviews the claim and decides." : "Your answer is in. The buyer and the desk were told.");
}

export async function addRepurchaseClaimFiles(formData: FormData) {
  const user = await requireUser();
  const claim = await claimHome(formData);
  const result = await addClaimFiles(user, { claimId: claim.id, files: await uploadsFrom(formData) });
  finish(claim.closingId, result, "Added to the claim.");
}

export async function confirmClaimSettled(formData: FormData) {
  const user = await requireUser();
  const claim = await claimHome(formData);
  const result = await confirmSettlement(user, { claimId: claim.id });
  finish(claim.closingId, result, result.error === null && result.settled ? "Both sides confirmed. The claim is settled." : "Confirmed. The other side confirms next.");
}

export async function acceptClaimCure(formData: FormData) {
  const user = await requireUser();
  const claim = await claimHome(formData);
  finish(claim.closingId, await acceptCure(user, { claimId: claim.id }), "The claim is closed as cured.");
}

export async function sendClaimToDesk(formData: FormData) {
  const user = await requireUser();
  const claim = await claimHome(formData);
  finish(claim.closingId, await askDeskReview(user, { claimId: claim.id, reason: formData.get("reason") }), "The desk will review the claim and decide.");
}

export async function withdrawRepurchaseClaim(formData: FormData) {
  const user = await requireUser();
  const claim = await claimHome(formData);
  finish(claim.closingId, await withdrawClaim(user, { claimId: claim.id }), "Your claim is withdrawn.");
}

// The desk's decision, under the compliance role. lib/claims.ts refuses anyone on the closing.
export async function decideRepurchaseClaim(formData: FormData) {
  const claim = await claimHome(formData);
  const actor = await requireDesk("compliance", `/closings/${claim.closingId}`);
  const outcome = String(formData.get("outcome") || "").trim().toUpperCase().replaceAll(" ", "_");
  const result = await decideClaim(actor, { claimId: claim.id, outcome, amount: formData.get("amount"), reason: formData.get("reason") });
  finish(claim.closingId, result, "The decision is recorded, and both sides were told.");
}

// The claim window and the seller's answer time, from the settings page. Only an owner changes them. Blank keeps
// the default.
export async function saveClaimSettings(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const read = readClaimSettings({ repSurvivalDays: formData.get("repSurvivalDays"), claimResponseDays: formData.get("claimResponseDays") });
  if (read.error !== null) redirect(`/admin/settings?error=${encodeURIComponent(read.error)}#claim-settings`);
  const before = await getSettings();
  const data = { repSurvivalDays: read.repSurvivalDays, claimResponseDays: read.claimResponseDays };
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: data, create: { id: "default", ...data } });
  clearSettingsCache();
  const window = survivalDaysOf(data.repSurvivalDays);
  const answer = responseDaysOf(data.claimResponseDays);
  await audit(
    actor.id,
    "CLAIM_SETTINGS",
    "settings",
    "default",
    `Claim window ${survivalDaysOf(before.repSurvivalDays)} to ${window} days after closing. Seller's answer ${responseDaysOf(before.claimResponseDays)} to ${answer} days.`,
  );
  revalidatePath("/admin/settings");
  redirect(`/admin/settings?notice=${encodeURIComponent(`Buyers file claims up to ${window} days after closing, and sellers have ${answer} days to answer.`)}#claim-settings`);
}
