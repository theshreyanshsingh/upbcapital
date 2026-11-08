import type { DiscrepancyStatus, Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { tellSellerOfDifferences } from "@/lib/discrepancy-notice";
import { parsePayString } from "@/lib/tape-fields";
import { prettyDate } from "@/lib/format";
import {
  canonical,
  displayValue,
  exactValue,
  fieldSpec,
  sameReading,
  sourcePhrase,
  tapeValue,
  verifiedMap,
  type FieldSpec,
  type Outcome,
} from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";

// The discrepancy gate. When the desk reads a document and it says something other than the tape, the seller has
// to fix the tape to the document or explain the difference before the listing goes live. The desk may instead
// apply the document's value itself, or waive the question, each with a reason. Buyers see every answer, dated.

export type DiscrepancyRow = {
  id: string;
  noteId: string;
  listingId: string;
  field: string;
  tapeValue: string;
  documentValue: string;
  source: string;
  status: DiscrepancyStatus | string;
  // The one note on the answer: the seller's explanation, or the desk's reason when the desk resolved it.
  sellerNote: string;
  raisedById: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt?: Date;
};

export const DISCREPANCY_LABELS: Record<DiscrepancyStatus, string> = {
  OPEN: "Open",
  FIXED: "Tape fixed by the seller",
  EXPLAINED: "Explained by the seller",
  ACCEPTED: "Document value applied by the desk",
  WAIVED: "Waived by the desk",
};

export function discrepancyLabel(status: string) {
  return DISCREPANCY_LABELS[status as DiscrepancyStatus] ?? status;
}

// While the tape is still in play. Once a listing is in contract or closed, its tape changes only through the desk.
const ANSWERABLE = new Set(["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"]);

export function answerable(listingStatus: string) {
  return ANSWERABLE.has(listingStatus);
}

// The seller on file answers, and so does the broker who filed it for a client.
export function canAnswer(actorId: string, listing: { sellerId: string; brokerId?: string | null }) {
  return Boolean(actorId) && (listing.sellerId === actorId || listing.brokerId === actorId);
}

export function gateMessage(open: number) {
  if (open <= 0) return null;
  const lead = open === 1 ? "One tape difference is open" : `${open} tape differences are open`;
  return `${lead}. The seller fixes or explains each one, or the desk applies the document's value or waives it, before the listing can go live.`;
}

// What stops an approval, in words, or null when nothing does.
export async function approvalHold(listingId: string) {
  return gateMessage(await prisma.fieldDiscrepancy.count({ where: { listingId, status: "OPEN" } }));
}

const fail = (error: string): Outcome<never> => ({ ok: false, error });
const clean = (text: string | null | undefined, max: number) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// The document's value typed for the note's own column, or why it can't be written there.
export function noteValue(spec: FieldSpec, value: string): Outcome<unknown> {
  const text = value.trim();
  if (!text) return fail(`The document shows no ${spec.label.toLowerCase()}. Explain the difference instead.`);
  if (spec.kind === "money" || spec.kind === "percent") {
    const number = Number(text);
    // An escrow account the servicer advanced runs below zero, and the tape keeps it that way.
    const floorOk = number >= 0 || spec.field === "escrowBalance";
    return Number.isFinite(number) && floorOk ? { ok: true, value: number } : fail("The document's value isn't a number the tape can take.");
  }
  if (spec.kind === "number") {
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? { ok: true, value: Math.round(number) } : fail("The document's value isn't a number the tape can take.");
  }
  if (spec.kind === "date") {
    const date = new Date(text.length === 10 ? `${text}T00:00:00.000Z` : text);
    return Number.isNaN(date.getTime()) ? fail("The document's value isn't a date the tape can take.") : { ok: true, value: date };
  }
  if (spec.kind === "bool") {
    const read = canonical(spec, text);
    return read == null ? fail("The document's value isn't a yes or no.") : { ok: true, value: read === "yes" };
  }
  if (spec.kind === "choice") {
    const option = spec.options?.find((row) => row.value === canonical(spec, text));
    return option ? { ok: true, value: option.value } : fail("The document's value isn't one of the tape's choices. Explain the difference, or ask the desk.");
  }
  if (spec.field === "payString") {
    const parsed = parsePayString(text);
    return parsed ? { ok: true, value: parsed } : fail("The document's pay string doesn't read as months.");
  }
  if (spec.field === "streetAddress" && text.length < 3) return fail("The document's street is too short to use.");
  return { ok: true, value: text.slice(0, 200) };
}

// Writes the document's value into the tape. A new street or value makes the stored pin and valuation wrong, so
// they are cleared and read again, as a seller's own edit does.
async function writeToTape(noteId: string, spec: FieldSpec, value: unknown, extra: Prisma.NoteUpdateInput = {}) {
  const resets: Prisma.NoteUpdateInput =
    spec.field === "streetAddress"
      ? { latitude: null, longitude: null, avmValue: null, avmProvider: "", avmAsOf: null }
      : spec.field === "estimatedValue"
        ? { avmValue: null, avmProvider: "", avmAsOf: null }
        : {};
  await prisma.note.update({ where: { id: noteId }, data: { [spec.field]: value, ...resets, ...extra } as Prisma.NoteUpdateInput });
}

async function loadOpen(id: string) {
  const row = id ? await prisma.fieldDiscrepancy.findUnique({ where: { id } }) : null;
  if (!row) return { error: "That difference isn't on file." } as const;
  const spec = fieldSpec(row.field);
  const listing = await prisma.listing.findUnique({ where: { id: row.listingId }, select: { id: true, sellerId: true, brokerId: true, status: true, title: true } });
  if (!spec || !listing) return { error: "That difference isn't on file." } as const;
  return { row, spec, listing } as const;
}

// Moves a question off OPEN only if it is still open, so two answers landing together can't both stand.
async function claim(id: string, data: Prisma.FieldDiscrepancyUpdateManyMutationInput) {
  const moved = await prisma.fieldDiscrepancy.updateMany({ where: { id, status: "OPEN" }, data });
  return moved.count === 1;
}

const remainingOn = (listingId: string) => prisma.fieldDiscrepancy.count({ where: { listingId, status: "OPEN" } });

export type Answered = { listingId: string; noteId: string; field: string; status: DiscrepancyStatus; remaining: number; tapeChanged: boolean };

// The seller's answer: use the document's value, which changes the tape, or explain why the tape stands.
export async function answerDiscrepancy(actorId: string, input: { id: string; answer: "FIX" | "EXPLAIN"; note?: string }): Promise<Outcome<Answered>> {
  const found = await loadOpen(input.id);
  if ("error" in found) return fail(found.error ?? "That difference isn't on file.");
  const { row, spec, listing } = found;
  if (!canAnswer(actorId, listing)) return fail("That difference isn't on your listing.");
  if (row.status !== "OPEN") return fail("That difference is already answered.");
  if (!answerable(listing.status)) return fail("This listing is in contract or closed, so its tape can't change here. Write to the desk.");
  const now = new Date();
  if (input.answer === "EXPLAIN") {
    const note = clean(input.note, 600);
    if (note.length < 10) return fail("Write the explanation in a sentence. Buyers who can open the loan read it.");
    if (!(await claim(row.id, { status: "EXPLAINED", sellerNote: note, resolvedById: actorId, resolvedAt: now }))) return fail("That difference was answered a moment ago. Reload to see it.");
    await audit(actorId, "DISCREPANCY_EXPLAINED", "note", row.noteId, `${row.field} · ${row.source}`);
    return { ok: true, value: { listingId: listing.id, noteId: row.noteId, field: row.field, status: "EXPLAINED", remaining: await remainingOn(listing.id), tapeChanged: false } };
  }
  const value = noteValue(spec, row.documentValue);
  if (!value.ok) return value;
  if (!(await claim(row.id, { status: "FIXED", sellerNote: "", resolvedById: actorId, resolvedAt: now }))) return fail("That difference was answered a moment ago. Reload to see it.");
  try {
    await writeToTape(row.noteId, spec, value.value);
  } catch {
    // The tape didn't take the value, so the question goes back to open rather than reading as fixed.
    await prisma.fieldDiscrepancy.updateMany({ where: { id: row.id, status: "FIXED" }, data: { status: "OPEN", resolvedById: null, resolvedAt: null } });
    return fail("The tape couldn't take that value. Try again, or explain the difference.");
  }
  await audit(actorId, "DISCREPANCY_FIXED", "note", row.noteId, `${row.field} · ${row.source}`);
  return { ok: true, value: { listingId: listing.id, noteId: row.noteId, field: row.field, status: "FIXED", remaining: await remainingOn(listing.id), tapeChanged: true } };
}

// The desk's answer: apply the document's value to the tape and sign it as verified, or waive the question.
export async function deskResolveDiscrepancy(actorId: string, input: { id: string; answer: "ACCEPT" | "WAIVE"; reason?: string }): Promise<Outcome<Answered>> {
  const found = await loadOpen(input.id);
  if ("error" in found) return fail(found.error ?? "That difference isn't on file.");
  const { row, spec, listing } = found;
  if (row.status !== "OPEN") return fail("That difference is already answered.");
  const reason = clean(input.reason, 400);
  if (reason.length < 3) return fail("Give the reason. Buyers who can open the loan read it.");
  const now = new Date();
  if (input.answer === "WAIVE") {
    if (!(await claim(row.id, { status: "WAIVED", sellerNote: reason, resolvedById: actorId, resolvedAt: now }))) return fail("That difference was answered a moment ago. Reload to see it.");
    await audit(actorId, "DISCREPANCY_WAIVED", "note", row.noteId, `${row.field} · ${row.source}`);
    return { ok: true, value: { listingId: listing.id, noteId: row.noteId, field: row.field, status: "WAIVED", remaining: await remainingOn(listing.id), tapeChanged: false } };
  }
  if (!answerable(listing.status)) return fail("This listing is in contract or closed. Waive the difference, or change the tape through the closing.");
  const value = noteValue(spec, row.documentValue);
  if (!value.ok) return value;
  if (!(await claim(row.id, { status: "ACCEPTED", sellerNote: reason, resolvedById: actorId, resolvedAt: now }))) return fail("That difference was answered a moment ago. Reload to see it.");
  const note = await prisma.note.findUnique({ where: { id: row.noteId }, select: { verifiedFields: true } });
  // The desk applied what it read, so the field is desk-verified against that document from now.
  const map = verifiedMap(note?.verifiedFields);
  map[spec.field] = { at: now.toISOString(), by: actorId, source: row.source, value: canonical(spec, row.documentValue) };
  try {
    await writeToTape(row.noteId, spec, value.value, { verifiedFields: map });
  } catch {
    await prisma.fieldDiscrepancy.updateMany({ where: { id: row.id, status: "ACCEPTED" }, data: { status: "OPEN", sellerNote: "", resolvedById: null, resolvedAt: null } });
    return fail("The tape couldn't take that value. Waive the difference, or edit the listing.");
  }
  await audit(actorId, "DISCREPANCY_ACCEPTED", "note", row.noteId, `${row.field} · ${row.source}`);
  return { ok: true, value: { listingId: listing.id, noteId: row.noteId, field: row.field, status: "ACCEPTED", remaining: await remainingOn(listing.id), tapeChanged: true } };
}

// The desk raises a question by hand, without signing the field as verified: "the BPO says vacant, explain".
// `via` says how the question arose, for the audit log and the seller's email: the desk by hand, a servicer report,
// or the desk's document reader (lib/ai-reading.ts), which raises under its own id rather than an account's.
export async function raiseDiscrepancy(
  actorId: string,
  input: { noteId: string; field: string; document: string; source: string; via?: "hand" | "servicer" | "reader" },
): Promise<Outcome<DiscrepancyRow>> {
  const spec = fieldSpec(input.field);
  if (!spec) return fail("Pick a field.");
  const source = clean(input.source, 60);
  if (!source) return fail("Name the document the desk read.");
  const note = input.noteId ? await prisma.note.findUnique({ where: { id: input.noteId } }) : null;
  if (!note) return fail("That loan isn't on file.");
  const typed = clean(input.document, 200);
  const document = typed ? exactValue(spec, typed) : null;
  if (document == null) return fail("Enter what the document shows.");
  const tape = exactValue(spec, (note as Record<string, unknown>)[spec.field]);
  if (sameReading(spec, document, tape)) return fail("The document matches the tape. Verify the field instead.");
  const data = { tapeValue: tape ?? "", documentValue: document, source, raisedById: actorId };
  const open = await prisma.fieldDiscrepancy.findFirst({ where: { noteId: note.id, field: spec.field, status: "OPEN" } });
  const row = open
    ? await prisma.fieldDiscrepancy.update({ where: { id: open.id }, data })
    : await prisma.fieldDiscrepancy.create({ data: { noteId: note.id, listingId: note.listingId, field: spec.field, ...data } });
  const via = input.via === "servicer" ? "from a servicer report" : input.via === "reader" ? "from the document reader" : "by hand";
  await audit(input.via === "reader" ? null : actorId, "DISCREPANCY_RAISED", "note", note.id, `${spec.field} · ${source} · ${via}`);
  if (!open) await tellSellerOfDifferences(note.listingId, input.via === "servicer" ? "servicer" : "desk");
  return { ok: true, value: row };
}

// After a seller edits the note, any open question whose document value the tape now carries is fixed.
export async function settleByEdit(actorId: string, noteId: string) {
  const [note, open] = await Promise.all([
    prisma.note.findUnique({ where: { id: noteId } }),
    prisma.fieldDiscrepancy.findMany({ where: { noteId, status: "OPEN" } }),
  ]);
  if (!note) return 0;
  let settled = 0;
  for (const row of open) {
    const spec = fieldSpec(row.field);
    if (!spec || !sameReading(spec, row.documentValue, tapeValue(note, row.field))) continue;
    if (await claim(row.id, { status: "FIXED", sellerNote: "", resolvedById: actorId, resolvedAt: new Date() })) {
      settled += 1;
      await audit(actorId, "DISCREPANCY_FIXED", "note", noteId, `${row.field} · ${row.source} · by edit`);
    }
  }
  return settled;
}

// ---------------------------------------------------------------------------------------------------------
// The buyer's change log

export type ChangeEntry = {
  id: string;
  at: Date;
  status: string;
  text: string;
  // The seller's explanation or the desk's reason, when this viewer may read it.
  note: { by: "Seller" | "Desk"; text: string } | null;
  // Why a note that exists isn't shown.
  noteGate: string | null;
};

// A figure shows here only where the listing already shows it: identity fields with the loan's street and borrower,
// balances and rates with Pro. Free text can carry either, so it shows only when both are open to this viewer.
export function figureVisible(spec: FieldSpec, viewer: { open: boolean; pro: boolean }) {
  return !(spec.identity && !viewer.open) && !(spec.pro && !viewer.pro);
}

export function changeLog(rows: DiscrepancyRow[], viewer: { open: boolean; pro: boolean }): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  for (const row of rows) {
    const spec = fieldSpec(row.field);
    if (!spec) continue;
    const figures = figureVisible(spec, viewer);
    const shown = (value: string) => (value ? displayValue(spec, value) : "blank");
    const the = sourcePhrase(row.source);
    const at = row.status === "OPEN" ? row.createdAt : row.resolvedAt ?? row.updatedAt ?? row.createdAt;
    const when = prettyDate(at);
    const versus = figures ? `, which shows ${shown(row.documentValue)} against the tape's ${shown(row.tapeValue)}` : "";
    let text: string;
    if (row.status === "FIXED" || row.status === "ACCEPTED") {
      text = figures
        // Counsel: the change-log sentences are what buyers rely on about a corrected tape.
        ? `${spec.label} changed from ${shown(row.tapeValue)} to ${shown(row.documentValue)} on ${when} to match ${the}.`
        : `${spec.label} changed on ${when} to match ${the}.`;
      if (row.status === "ACCEPTED") text += " The desk made the change.";
    } else if (row.status === "EXPLAINED") {
      text = `${spec.label} differs from ${the}${versus}. The seller explained it on ${when}.`;
    } else if (row.status === "WAIVED") {
      text = `${spec.label} differs from ${the}${versus}. The desk waived it on ${when}.`;
    } else {
      text = `${spec.label} differs from ${the}${versus}. Raised on ${when}. The seller hasn't answered yet.`;
    }
    const written = row.sellerNote.trim();
    const readable = viewer.open && figures;
    entries.push({
      id: row.id,
      at,
      status: row.status,
      text,
      note: written && readable ? { by: row.status === "EXPLAINED" ? "Seller" : "Desk", text: written } : null,
      noteGate: written && !readable ? (viewer.open ? "The note shows with Pro." : "The note opens with the loan's street and borrower.") : null,
    });
  }
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
}
