"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, requireUser } from "@/lib/auth";
import { sellerPage } from "@/lib/awards";
import { answerDiscrepancy, canAnswer, deskResolveDiscrepancy, raiseDiscrepancy, type Answered } from "@/lib/discrepancies";
import { flagDuplicates } from "@/lib/duplicates";
import { notifyDesk } from "@/lib/email";
import { rescoreListing } from "@/lib/matching";
import { prisma } from "@/lib/prisma";

// Each action checks who may answer itself, since a server action is a public endpoint. Values never go in the
// address bar: a notice says what happened, not what the figure was.

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

const IDENTIFYING = new Set(["streetAddress", "upb", "loanNumber", "servicerName"]);

function refresh(listingId: string) {
  for (const path of [`/seller/listings/${listingId}`, `/broker/deals/${listingId}`, `/buyer/resales/${listingId}`, `/admin/listings/${listingId}`, `/marketplace/${listingId}`]) revalidatePath(path);
}

// A changed tape is scored against buy boxes again, and checked for duplicates when what identifies the loan moved.
async function afterAnswer(actorId: string, answered: Answered) {
  if (answered.tapeChanged) {
    await rescoreListing(answered.listingId, false).catch(() => null);
    if (IDENTIFYING.has(answered.field)) await flagDuplicates(answered.listingId, actorId);
  }
  if (answered.remaining === 0) {
    const listing = await prisma.listing.findUnique({ where: { id: answered.listingId }, select: { title: true } });
    await notifyDesk(`Tape differences answered · ${listing?.title ?? "a listing"}`, "Every tape difference on this listing has an answer. It can be approved once the desk is satisfied.").catch(() => null);
  }
  refresh(answered.listingId);
}

// The seller, or the broker who filed the listing, fixes the tape to the document or explains the difference.
export async function answerDifference(formData: FormData) {
  const user = await requireUser();
  const id = text(formData, "discrepancyId");
  const row = id ? await prisma.fieldDiscrepancy.findUnique({ where: { id }, select: { listingId: true } }) : null;
  const listing = row ? await prisma.listing.findUnique({ where: { id: row.listingId }, select: { id: true, sellerId: true, brokerId: true } }) : null;
  const home = user.role === "BROKER" ? "/broker" : user.role === "BUYER" ? "/buyer/portfolio" : "/seller";
  if (!listing || !canAnswer(user.id, listing)) redirect(`${home}?error=${encodeURIComponent("That difference isn't on your listing.")}`);
  // The filing broker reads the result on the deal page, the seller of record on theirs.
  const page = listing.brokerId === user.id ? `/broker/deals/${listing.id}` : sellerPage(listing, user.role);
  const answer = text(formData, "answer") === "FIX" ? "FIX" : "EXPLAIN";
  const outcome = await answerDiscrepancy(user.id, { id, answer, note: text(formData, "sellerNote") });
  if (!outcome.ok) redirect(`${page}?error=${encodeURIComponent(outcome.error)}#differences`);
  await afterAnswer(user.id, outcome.value);
  const notice = answer === "FIX" ? "The tape now carries the document's value. Buyers see the change, dated." : "Your explanation is on file. Buyers who can open the loan read it.";
  redirect(`${page}?notice=${encodeURIComponent(notice)}#differences`);
}

function deskBack(listingId: string, noteId: string | null, notice: { ok: boolean; text: string }): never {
  const loan = noteId ? `loan=${noteId}&` : "";
  redirect(`/admin/listings/${listingId}?${loan}${notice.ok ? "notice" : "error"}=${encodeURIComponent(notice.text)}#differences`);
}

// The desk applies the document's value to the tape, or waives the question, with a reason buyers can read.
export async function resolveDifference(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const id = text(formData, "discrepancyId");
  const row = id ? await prisma.fieldDiscrepancy.findUnique({ where: { id }, select: { listingId: true, noteId: true } }) : null;
  if (!row) redirect(`/admin/queue?error=${encodeURIComponent("That difference isn't on file.")}`);
  const answer = text(formData, "answer") === "ACCEPT" ? "ACCEPT" : "WAIVE";
  const outcome = await deskResolveDiscrepancy(user.id, { id, answer, reason: text(formData, "reason") });
  if (!outcome.ok) deskBack(row.listingId, row.noteId, { ok: false, text: outcome.error });
  await afterAnswer(user.id, outcome.value);
  deskBack(row.listingId, row.noteId, { ok: true, text: answer === "ACCEPT" ? "The document's value is on the tape, verified by the desk." : "The difference is waived. Buyers see the reason." });
}

// The desk raises a question by hand, without marking the field verified.
export async function raiseDifference(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const noteId = text(formData, "noteId");
  const note = noteId ? await prisma.note.findUnique({ where: { id: noteId }, select: { id: true, listingId: true } }) : null;
  if (!note) redirect(`/admin/queue?error=${encodeURIComponent("That loan isn't on file.")}`);
  const outcome = await raiseDiscrepancy(user.id, { noteId: note.id, field: text(formData, "field"), document: text(formData, "document"), source: text(formData, "source") });
  refresh(note.listingId);
  deskBack(note.listingId, note.id, outcome.ok ? { ok: true, text: "The difference is raised. The seller answers it on their listing page." } : { ok: false, text: outcome.error });
}
