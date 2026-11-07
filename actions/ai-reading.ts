"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setReadingMode } from "@/lib/ai-eval";
import { confirmFinding, readDocument, rejectFinding, type ReadingMode } from "@/lib/ai-reading";
import { prisma } from "@/lib/prisma";
import { requireDesk } from "@/lib/staff";

// The desk's side of the document reader. Each action checks the role itself, since a server action is a public
// endpoint.

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function refresh(listingId: string) {
  for (const path of [`/admin/listings/${listingId}`, `/seller/listings/${listingId}`, `/broker/deals/${listingId}`, `/marketplace/${listingId}`]) revalidatePath(path);
}

// Back to the reader panel on the same loan, with the result in words.
function back(listingId: string, loan: string, outcome: { ok: true } | { ok: false; error: string }, notice: string): never {
  refresh(listingId);
  const message = outcome.ok ? `notice=${encodeURIComponent(notice)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`/admin/listings/${listingId}?${loan ? `loan=${encodeURIComponent(loan)}&` : ""}${message}#reader`);
}

export async function readFileAgain(formData: FormData) {
  await requireDesk("sales", "/admin/queue");
  const document = await prisma.document.findUnique({ where: { id: text(formData, "documentId") }, select: { id: true, listingId: true, originalName: true } });
  if (!document) redirect(`/admin/queue?error=${encodeURIComponent("That file isn't on file.")}`);
  const outcome = await readDocument(document.id);
  const loan = text(formData, "noteId");
  if (!outcome.ok) back(document.listingId, loan, outcome, "");
  const report = outcome.value;
  if (report.status === "FAILED") back(document.listingId, loan, { ok: false, error: `The reader couldn't read ${document.originalName}. ${report.reason}` }, "");
  const notice =
    report.status === "SKIPPED"
      ? `The reader skipped ${document.originalName}. ${report.reason}`
      : `The reader read ${document.originalName}. ${report.findings === 0 ? "It found nothing new to confirm." : `${report.findings} finding${report.findings === 1 ? "" : "s"} to confirm.`}${report.raised ? ` ${report.raised} difference${report.raised === 1 ? " went" : "s went"} to the seller.` : ""}`;
  back(document.listingId, loan, { ok: true }, notice);
}

export async function confirmReading(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const outcome = await confirmFinding(user.id, text(formData, "findingId"));
  const listingId = outcome.ok ? outcome.value.listingId : text(formData, "listingId");
  if (!listingId) redirect(`/admin/queue?error=${encodeURIComponent(outcome.ok ? "That reading isn't on file." : outcome.error)}`);
  const notice = !outcome.ok
    ? ""
    : !outcome.value.verified
      ? "Confirmed. The tape has no original balance, so there is no field to verify."
      : outcome.value.raised
        ? "Confirmed. The file differs from the tape, so the seller fixes or explains it before the listing can go live."
        : "Confirmed. The field is marked verified against the file.";
  back(listingId, text(formData, "noteId"), outcome, notice);
}

export async function rejectReading(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const outcome = await rejectFinding(user.id, text(formData, "findingId"));
  const listingId = outcome.ok ? outcome.value.listingId : text(formData, "listingId");
  if (!listingId) redirect(`/admin/queue?error=${encodeURIComponent(outcome.ok ? "That reading isn't on file." : outcome.error)}`);
  const notice = outcome.ok && outcome.value.waived ? "Rejected. The difference the reader opened is waived, with a reason buyers can read." : "Rejected. The tape is unchanged.";
  back(listingId, text(formData, "noteId"), outcome, notice);
}

const MODE_NOTICES: Record<ReadingMode, string> = {
  OFF: "The document reader is off. New files aren't read.",
  SHADOW: "The document reader runs in shadow mode. Only the desk sees what it reads.",
  ON: "The document reader is on. A difference it finds goes to the seller to fix or explain.",
};

// The settings page's switch. ON waits on the reader's accuracy test, which the library checks.
export async function saveReaderMode(formData: FormData) {
  const user = await requireDesk("admin", "/admin/settings");
  const outcome = await setReadingMode(user.id, text(formData, "aiReading"));
  revalidatePath("/admin/settings");
  const message = outcome.ok ? `notice=${encodeURIComponent(MODE_NOTICES[outcome.value])}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`/admin/settings?${message}#reader`);
}
