"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { clearExceptions, issueBaileeLetter, nameCustodian, recordCustodianReceipt, recordExceptions } from "@/lib/custody";

// The closing id names the closing; lib/custody.ts loads it and checks the person against it for each action.
function closingOf(formData: FormData) {
  return String(formData.get("closingId") || "").replace(/[^A-Za-z0-9_-]/g, "");
}

function done(closingId: string, outcome: { ok: true } | { ok: false; error: string }, notice: string): never {
  const back = closingId ? `/closings/${closingId}` : "/closings";
  if (!outcome.ok) redirect(`${back}?error=${encodeURIComponent(outcome.error)}#custody`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent(notice)}#custody`);
}

// A date from the form: null when blank, undefined when it isn't a date.
function dateField(formData: FormData, key: string) {
  const raw = String(formData.get(key) || "");
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : undefined;
}

export async function saveCustodian(formData: FormData) {
  const user = await requireUser();
  const closingId = closingOf(formData);
  const own = formData.get("holder") === "self";
  const outcome = await nameCustodian(user, { closingId, name: formData.get("custodianName"), contact: formData.get("custodianContact"), selfHeld: own });
  done(closingId, outcome, outcome.ok && !outcome.value.changed ? "Nothing changed." : own ? "Saved. The seller was told the buyer holds the file itself." : "Saved. The seller was told where the collateral file goes.");
}

export async function issueBailee(formData: FormData) {
  const user = await requireUser();
  const closingId = closingOf(formData);
  const outcome = await issueBaileeLetter(user, { closingId });
  done(closingId, outcome, "The bailee letter is issued. Download it and send it with the collateral file.");
}

export async function saveCustodianReceipt(formData: FormData) {
  const user = await requireUser();
  const closingId = closingOf(formData);
  const upload = formData.get("file");
  const file = upload instanceof File && upload.size > 0 ? { name: upload.name, type: upload.type, bytes: Buffer.from(await upload.arrayBuffer()) } : null;
  const outcome = await recordCustodianReceipt(user, { closingId, receivedAt: dateField(formData, "receivedAt"), file });
  done(closingId, outcome, "The custodian's receipt is recorded. The seller was told.");
}

export async function saveCustodyExceptions(formData: FormData) {
  const user = await requireUser();
  const closingId = closingOf(formData);
  const outcome = await recordExceptions(user, { closingId, text: formData.get("exceptions") });
  done(closingId, outcome, "The exceptions are recorded. The seller and the desk were told.");
}

export async function clearCustodyExceptions(formData: FormData) {
  const user = await requireUser();
  const closingId = closingOf(formData);
  const outcome = await clearExceptions(user, { closingId, clearedAt: dateField(formData, "clearedAt") });
  done(closingId, outcome, outcome.ok && outcome.value.complete ? "Cleared. Every trailing document is in too, so the file is complete." : "The exceptions are recorded as cleared.");
}
