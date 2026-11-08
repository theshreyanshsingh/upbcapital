"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { addDays } from "@/lib/borrower-notices";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";
import { assignmentDays, BACKFILL_GRACE_DAYS, confirmReceived, recordSent, recordTransferee, scheduleTrailingDocs, waiveTrailingDoc } from "@/lib/trailing-docs";

// The closing id only says where to send the person back. Each item is loaded by its own id, and lib/trailing-docs.ts
// checks the person against that item's closing.
function backTo(formData: FormData) {
  const closingId = String(formData.get("closingId") || "").replace(/[^A-Za-z0-9_-]/g, "");
  return closingId ? `/closings/${closingId}` : "/closings";
}

function done(back: string, outcome: { ok: true } | { ok: false; error: string }, notice: string): never {
  if (!outcome.ok) redirect(`${back}?error=${encodeURIComponent(outcome.error)}#trailing`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent(notice)}#trailing`);
}

export async function recordTrailingSent(formData: FormData) {
  const user = await requireUser();
  const back = backTo(formData);
  const upload = formData.get("file");
  const file = upload instanceof File && upload.size > 0 ? { name: upload.name, type: upload.type, bytes: Buffer.from(await upload.arrayBuffer()) } : null;
  const outcome = await recordSent(user, {
    docId: String(formData.get("docId") || ""),
    carrier: String(formData.get("carrier") || ""),
    trackingNumber: String(formData.get("trackingNumber") || ""),
    instrument: String(formData.get("instrument") || ""),
    book: String(formData.get("book") || ""),
    page: String(formData.get("page") || ""),
    transferId: String(formData.get("transferId") || ""),
    reference: String(formData.get("reference") || ""),
    withAllonge: formData.get("withAllonge") === "on",
    file,
  });
  done(back, outcome, "Recorded as sent. The other side was told to confirm receipt.");
}

export async function confirmTrailingReceived(formData: FormData) {
  const user = await requireUser();
  const back = backTo(formData);
  const outcome = await confirmReceived(user, { docId: String(formData.get("docId") || "") });
  done(back, outcome, outcome.ok && outcome.value.complete ? "Received. Every trailing document is in, so the file is complete." : "Recorded as received.");
}

export async function waiveTrailing(formData: FormData) {
  const user = await requireUser();
  const back = backTo(formData);
  const outcome = await waiveTrailingDoc(user, { docId: String(formData.get("docId") || ""), reason: String(formData.get("reason") || "") });
  done(back, outcome, outcome.ok && outcome.value.complete ? "Waived. Every trailing document is in, so the file is complete." : "Waived, with your reason on the list.");
}

export async function nameTransferee(formData: FormData) {
  const user = await requireUser();
  const back = backTo(formData);
  const outcome = await recordTransferee(user, { docId: String(formData.get("docId") || ""), orgId: String(formData.get("orgId") || "") });
  done(back, outcome, "Saved. The seller was sent the Org ID to transfer to.");
}

// A closing that closed before the list existed gets one now rather than at the next job run. It gets the backfill's
// week of grace too, so nobody hears "late" about an item they were never asked for.
export async function buildTrailingList(formData: FormData) {
  const back = backTo(formData);
  const actor = await requireDesk("closings", back);
  const closingId = back.split("/")[2] ?? "";
  const closing = closingId ? await prisma.closing.findUnique({ where: { id: closingId }, select: { status: true } }) : null;
  if (!closing || closing.status !== "COMPLETE") redirect(`${back}?error=${encodeURIComponent("Trailing documents start once the file is closed.")}#trailing`);
  const { created } = await scheduleTrailingDocs(closingId, { notBefore: addDays(new Date(), BACKFILL_GRACE_DAYS) });
  await audit(actor.id, "TRAILING_LISTED", "closing", closingId, `${created} items`);
  done(back, { ok: true }, created ? "The trailing documents are listed." : "The list was already up to date.");
}

// Days after closing the recorded assignment is due. Blank keeps the default.
export async function saveTrailingDocDays(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const back = (message: string, kind: "notice" | "error"): never => redirect(`/admin/settings?${kind}=${encodeURIComponent(message)}#trailing-docs`);
  const text = String(formData.get("trailingDocDays") || "").trim();
  const days = text ? Number(text) : null;
  if (days !== null && (!/^\d+$/.test(text) || days < 10 || days > 365)) back("Set the recorded assignment's due date as a whole number of days from 10 to 365, or leave it blank.", "error");
  const before = await getSettings();
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: { trailingDocDays: days }, create: { id: "default", trailingDocDays: days } });
  clearSettingsCache();
  await audit(actor.id, "TRAILING_SETTINGS", "settings", "default", `Recorded assignment due ${assignmentDays(before.trailingDocDays)} to ${assignmentDays(days)} days after closing.`);
  revalidatePath("/admin/settings");
  back(`Recorded assignments are due ${assignmentDays(days)} days after closing, on closings from now on.`, "notice");
}
