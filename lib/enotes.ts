import type { TemplateKey } from "@/lib/closing-docs";

// eNotes: notes signed and held electronically on the MERS eRegistry, past 3 million of them by March 2026. An eNote
// has no paper to endorse, courier or lose. Who owns it (control) and whose eVault holds the authoritative copy
// (location) move by an eRegistry transfer, and the eRegistry names each by MERS Org ID. No database here, so the
// tape, the loan file and the closing papers all read the same rules.

export const ENOTE_LINE = "eNote on the MERS eRegistry";

// Missing or false is paper, as every loan was before the field existed.
export function isENote(note: object | null | undefined) {
  return Boolean(note) && (note as { eNote?: unknown }).eNote === true;
}

// A MERS Org ID is 7 digits, the same ones that open a MIN. Dashes and spaces are formatting. Null when it isn't.
export function parseMersOrgId(raw: string | null | undefined) {
  const digits = String(raw ?? "").trim().replace(/[\s-]/g, "");
  return /^\d{7}$/.test(digits) ? digits : null;
}

export function isMersOrgId(raw: string | null | undefined) {
  return parseMersOrgId(raw) !== null;
}

// An eRegistry transfer's ID as the eVault shows it: letters, digits and dashes.
export function parseTransferId(raw: string | null | undefined) {
  const text = String(raw ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{3,59}$/.test(text) ? text : null;
}

export type ENoteTransfer = "ENOTE_CONTROL" | "ENOTE_LOCATION";

// What the seller needs from the buyer before it can start a transfer: a MERS Org ID to name as the new controller
// and one for the new location. A buyer without its own MERS membership names its custodian's, and a custodian
// usually takes both.
export function transferNeeds(kind: ENoteTransfer, custodian?: string | null) {
  const theirs = custodian ? `your custodian's (${custodian})` : "your custodian's";
  return kind === "ENOTE_CONTROL"
    ? `The seller needs the MERS Org ID to make controller: yours, or ${theirs}.`
    : `The seller needs the MERS Org ID of the eVault that will hold the eNote: ${theirs}, or yours if you run your own eVault.`;
}

// The buyer's answer is kept on the item's note, in words both sides read.
const TRANSFEREE = /^Transfer to MERS Org ID (\d{7})\b/;

export function transfereeNote(orgId: string) {
  return `Transfer to MERS Org ID ${orgId}`;
}

export function transfereeOf(note: string | null | undefined) {
  return TRANSFEREE.exec(note ?? "")?.[1] ?? null;
}

// For an eNote the paper original and its allonges aren't part of the file. The eVault's confirmation of control
// and location stands in for them, and the desk checks the eRegistry fields against it.
export const ENOTE_NOT_REQUIRED: Partial<Record<string, string>> = {
  ORIGINAL_NOTE: "An eNote has no paper original. The eVault's confirmation of control and location on the MERS eRegistry replaces it.",
  ALLONGE: "An eNote moves by eRegistry transfer, not by endorsement, so it has no allonge.",
};

// The closing forms that exist only for paper.
export const PAPER_FORMS: readonly TemplateKey[] = ["ALLONGE", "LOST_NOTE_AFFIDAVIT"];

export const ENOTE_NO_PAPER =
  "Every loan on this closing is an eNote. An eNote moves by eRegistry transfer of control and location, so it has no allonge and can't be a lost note.";

export function isPaperForm(kind: string) {
  return (PAPER_FORMS as readonly string[]).includes(kind);
}

// The loans a form is drawn for. The allonge and the lost note affidavit leave eNotes out; everything else covers
// every loan.
export function paperLoans<T extends object>(kind: string, loans: T[]) {
  return isPaperForm(kind) ? loans.filter((loan) => !isENote(loan)) : loans;
}

// The line on a listing: one eNote, a pool of them, or some loans in a pool.
export function eNoteSummary(notes: object[]) {
  const count = notes.filter((note) => isENote(note)).length;
  if (!count) return null;
  const title = notes.length === 1 ? ENOTE_LINE : count === notes.length ? `Every loan is an ${ENOTE_LINE}` : `${count} of ${notes.length} loans are eNotes on the MERS eRegistry`;
  return {
    count,
    title,
    text: "Control and location move by an eRegistry transfer to the buyer's MERS Org ID or its custodian's, within two business days of closing. There is no original to courier and no allonge.",
  };
}
