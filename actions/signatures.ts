"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requestMeta } from "@/lib/request-meta";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { MAX_SIGN_HOURS, declineRequest, sendForSignatures, signHours, signRequest, vendorName, voidRequest } from "@/lib/signatures";
import { seatGate } from "@/lib/seats";
import { requireDesk } from "@/lib/staff";
import { isTemplateKey } from "@/lib/templates";

// Back to the page with the outcome, at the panel the form was on.
function back(path: string, kind: "notice" | "error", message: string, hash = "#signatures"): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}${hash}`);
}

// Ids come from hidden fields, so each is checked for its shape before it reaches a query or a path.
function idOf(formData: FormData, key: string) {
  const value = String(formData.get(key) || "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "";
}

// The desk sends a form to every party, or sends it again, which voids the copy still open.
export async function sendSignatures(formData: FormData) {
  const closingId = idOf(formData, "closingId");
  if (!closingId) redirect("/closings");
  const page = `/closings/${closingId}`;
  const actor = await requireDesk("closings", page);
  const kind = String(formData.get("kind") || "");
  if (!isTemplateKey(kind)) back(page, "error", "Choose a form to send.");
  const sent = await sendForSignatures(closingId, kind, actor);
  if (sent.error !== null) back(page, "error", sent.error);
  revalidatePath(page);
  const how = sent.request.provider === "in_app" ? "Each party has a link to sign here." : `${vendorName(sent.request.provider)} is emailing each party.`;
  const fell = sent.fellBack ? " The signing service didn't take the file, so the parties sign here instead." : "";
  back(page, "notice", `Sent for signature.${sent.replaced ? " The open copy is voided." : ""} ${how}${fell}`);
}

export async function voidSignatures(formData: FormData) {
  const closingId = idOf(formData, "closingId");
  const requestId = idOf(formData, "requestId");
  if (!closingId || !requestId) redirect("/closings");
  const page = `/closings/${closingId}`;
  const actor = await requireDesk("closings", page);
  const voided = await voidRequest(requestId, closingId, actor, String(formData.get("reason") || ""));
  if (voided.error !== null) back(page, "error", voided.error);
  revalidatePath(page);
  back(page, "notice", "The request is voided, and every party was told.");
}

// A party signs their own line. The lib checks the line is theirs, still open and inside its time.
export async function signSignature(formData: FormData) {
  const closingId = idOf(formData, "closingId");
  const requestId = idOf(formData, "requestId");
  if (!closingId || !requestId) redirect("/closings");
  const user = await requireUser();
  const page = `/closings/${closingId}/sign/${requestId}`;
  // A firm signs through its approving and managing seats, or its owner (lib/seats.ts).
  const gated = await actionGate(user, "sign");
  if (gated) back(page, "error", gated, "#sign");
  const request = await prisma.signatureRequest.findUnique({ where: { id: requestId }, select: { closingId: true } });
  if (!request || request.closingId !== closingId) redirect(`/closings/${closingId}`);
  const meta = await requestMeta();
  const signed = await signRequest(requestId, user, { name: String(formData.get("signedName") || ""), consent: formData.get("consent") === "on", ip: meta.ipAddress });
  if (signed.error !== null) back(page, "error", signed.error, "#sign");
  revalidatePath(`/closings/${closingId}`);
  back(page, "notice", signed.status === "SIGNED" ? "Signed. Every party has now signed." : "Signed. The others are still to sign.", "#sign");
}

export async function declineSignature(formData: FormData) {
  const closingId = idOf(formData, "closingId");
  const requestId = idOf(formData, "requestId");
  if (!closingId || !requestId) redirect("/closings");
  const user = await requireUser();
  const page = `/closings/${closingId}/sign/${requestId}`;
  // Declining answers for the firm as signing does, so the same seats can.
  const gated = await seatGate(user, "sign");
  if (gated) back(page, "error", gated, "#sign");
  const request = await prisma.signatureRequest.findUnique({ where: { id: requestId }, select: { closingId: true } });
  if (!request || request.closingId !== closingId) redirect(`/closings/${closingId}`);
  const declined = await declineRequest(requestId, user, String(formData.get("reason") || ""));
  if (declined.error !== null) back(page, "error", declined.error, "#sign");
  revalidatePath(`/closings/${closingId}`);
  back(page, "notice", "You declined. The desk and the other parties were told.", "#sign");
}

// Hours from the send for every party to sign. Blank goes back to the default.
export async function saveSignHours(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const page = "/admin/settings";
  const raw = String(formData.get("psaSignHours") || "").trim();
  const hours = raw === "" ? null : Number(raw);
  if (hours !== null && (!/^\d+$/.test(raw) || hours < 1 || hours > MAX_SIGN_HOURS)) back(page, "error", `Set the hours to sign as a whole number from 1 to ${MAX_SIGN_HOURS}, or leave it blank for the default.`, "#signing");
  const before = signHours((await getSettings()).psaSignHours);
  const data = { psaSignHours: hours };
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: data, create: { id: "default", ...data } });
  clearSettingsCache();
  const after = signHours(hours);
  await audit(actor.id, "SIGN_HOURS", "settings", "default", `Hours to sign ${before} to ${after}${hours === null ? " (the default)" : ""}.`);
  revalidatePath("/admin/settings");
  back(page, "notice", `Parties now have ${after} hours to sign papers sent from here on. Requests already out keep their time.`, "#signing");
}
