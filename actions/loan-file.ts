"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDesk } from "@/lib/staff";
import {
  chainDetail,
  clearFieldVerified,
  fileLoanDocument,
  isChainKind,
  logRiskCheck,
  markFieldVerified,
  moveChainLink,
  removeCollateralItem,
  saveCollateralItem,
  type Outcome,
} from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";

// Every action here is the desk's. Each one checks the role itself, since a server action is a public endpoint.

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

// A three-way answer: yes, no, or not checked yet.
function yesNo(value: string) {
  return value === "yes" ? true : value === "no" ? false : null;
}

async function loanOf(formData: FormData) {
  const noteId = text(formData, "noteId");
  const note = noteId ? await prisma.note.findUnique({ where: { id: noteId }, select: { id: true, listingId: true } }) : null;
  if (!note) redirect("/admin/queue?error=That loan isn't on file.");
  return note;
}

// Back to the same loan's file on the desk page, with the result in words.
function back(note: { id: string; listingId: string }, outcome: Outcome<unknown>, notice: string): never {
  const path = `/admin/listings/${note.listingId}`;
  revalidatePath(path);
  revalidatePath(`/marketplace/${note.listingId}`);
  // A field check can raise a tape difference the seller answers on their own page.
  revalidatePath(`/seller/listings/${note.listingId}`);
  revalidatePath(`/broker/deals/${note.listingId}`);
  const message = outcome.ok ? `notice=${encodeURIComponent(notice)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`${path}?loan=${note.id}&${message}#loan-file`);
}

export async function saveCollateral(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const note = await loanOf(formData);
  const kind = text(formData, "kind");
  // A chain link's parties are typed apart and kept together, so the chain can be checked for gaps.
  const detail = isChainKind(kind) && (formData.has("from") || formData.has("to"))
    ? chainDetail(text(formData, "from"), text(formData, "to"), text(formData, "note"))
    : text(formData, "detail");
  const outcome = await saveCollateralItem(user.id, {
    id: text(formData, "itemId") || null,
    noteId: note.id,
    kind,
    status: text(formData, "status"),
    detail,
    cureOwner: text(formData, "cureOwner"),
    cureBy: text(formData, "cureBy") || null,
    recordedAt: text(formData, "recordedAt") || null,
    recording: text(formData, "recording"),
    datedOn: text(formData, "datedOn") || null,
    attachedAt: text(formData, "attachedAt") || null,
    endorsement: text(formData, "endorsement") || null,
    loanNumberMatch: yesNo(text(formData, "loanNumberMatch")),
    photoDocumentId: text(formData, "photoDocumentId") || null,
    documentId: text(formData, "documentId") || null,
  });
  back(note, outcome, "The collateral line is saved.");
}

export async function removeCollateral(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const note = await loanOf(formData);
  const outcome = await removeCollateralItem(user.id, { noteId: note.id, id: text(formData, "itemId") });
  back(note, outcome, "The collateral line is removed.");
}

export async function moveCollateral(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const note = await loanOf(formData);
  const direction = text(formData, "direction") === "up" ? "up" : "down";
  const outcome = await moveChainLink(user.id, { noteId: note.id, id: text(formData, "itemId"), direction });
  back(note, outcome, "The chain order is saved.");
}

export async function logRisk(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const note = await loanOf(formData);
  const outcome = await logRiskCheck(user.id, {
    noteId: note.id,
    kind: text(formData, "kind"),
    result: text(formData, "result"),
    source: text(formData, "source"),
    detail: text(formData, "detail"),
    documentId: text(formData, "documentId") || null,
    checkedAt: text(formData, "checkedAt") || null,
  });
  back(note, outcome, "The check is logged.");
}

export async function verifyField(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const note = await loanOf(formData);
  const outcome = await markFieldVerified(user.id, {
    noteId: note.id,
    field: text(formData, "field"),
    source: text(formData, "source"),
    document: text(formData, "document"),
  });
  const differs = outcome.ok && outcome.value.document != null;
  const notice = !differs
    ? "The field is marked verified."
    : outcome.ok && outcome.value.raised
      ? "Saved. The document differs from the tape. The seller fixes or explains it before the listing can go live."
      : "Saved. The document differs from the tape. The seller already answered this difference.";
  back(note, outcome, notice);
}

export async function clearField(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const note = await loanOf(formData);
  const outcome = await clearFieldVerified(user.id, { noteId: note.id, field: text(formData, "field") });
  back(note, outcome, "The check is cleared. The field reads as seller-stated.");
}

export async function uploadLoanReport(formData: FormData) {
  const user = await requireDesk("sales", "/admin/queue");
  const note = await loanOf(formData);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size <= 0) back(note, { ok: false, error: "Choose a file." }, "");
  const outcome = await fileLoanDocument(user.id, {
    noteId: note.id,
    type: text(formData, "type"),
    name: file.name,
    bytes: Buffer.from(await file.arrayBuffer()),
    mime: file.type,
  });
  back(note, outcome, "The file is on this loan. It opens with the loan's street and borrower.");
}
