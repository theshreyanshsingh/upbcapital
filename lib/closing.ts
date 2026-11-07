import { feeBreakdown } from "@/lib/money";

export const CLOSING_STEPS = [
  { key: "PURCHASE_AGREEMENT", label: "Purchase agreement" },
  { key: "BUYER_DEPOSIT", label: "Buyer deposit" },
  { key: "COLLATERAL_TRANSFER", label: "Collateral file transfer" },
  { key: "ASSIGNMENT", label: "Assignment and allonge" },
  { key: "PAYMENT_RECEIVED", label: "Payment received" },
  { key: "CLOSED", label: "Closed" },
] as const;

export type ClosingStepKey = (typeof CLOSING_STEPS)[number]["key"];

export function closingTotals(salePrice: number, premiumBps: number, commissionBps: number) {
  return feeBreakdown(salePrice, premiumBps, commissionBps);
}

export function stepLabel(key: string) {
  return CLOSING_STEPS.find((step) => step.key === key)?.label ?? key;
}

export function canCompleteStep(steps: { key: string; status: string }[], key: string) {
  if (key !== "CLOSED") return true;
  return steps.filter((step) => step.key !== "CLOSED").every((step) => step.status === "COMPLETE");
}

export function closingIsComplete(steps: { status: string }[]) {
  return steps.length > 0 && steps.every((step) => step.status === "COMPLETE");
}

// noteIds is optional so a caller that selected only noteId still reads the same way it always did. Select it
// wherever a closing's loans are read, or a part-pool closing reads as the whole listing.
type ClosingScope = { noteId: string | null; noteIds?: string[] };

// The loans a closing covers: the loans it names when it is part of a pool or a pool after a kick-out, else its
// one loan, else every loan on the listing for a whole-listing sale.
export function closingLoans<T extends { id: string }>(closing: ClosingScope, notes: T[]) {
  if (closing.noteIds?.length) {
    const named = new Set(closing.noteIds);
    return notes.filter((note) => named.has(note.id));
  }
  return closing.noteId ? notes.filter((note) => note.id === closing.noteId) : notes;
}

// Whether a closing covers this loan, without loading the listing's loans.
export function closingCovers(closing: ClosingScope, noteId: string) {
  if (closing.noteIds?.length) return closing.noteIds.includes(noteId);
  return closing.noteId === null || closing.noteId === noteId;
}

// A closing that covers the whole listing, which no other closing can share.
export function closingIsWhole(closing: ClosingScope) {
  return !closing.noteIds?.length && !closing.noteId;
}
