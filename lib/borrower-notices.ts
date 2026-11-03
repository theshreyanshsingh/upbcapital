// Dates for the notices a borrower gets when a note trades. UPB never contacts borrowers. These dates are for
// the new owner and the servicers, who send them. This is UPB's read of the rules, not legal advice.
//
// Sale notice (12 CFR 1026.39): the new owner sends it on or before the 30th calendar day after the date of
// transfer. It covers consumer credit to a natural person secured by a dwelling or real property. Credit for a
// tenant-occupied rental is deemed business purpose (comment 3(a)-4), and credit to a company is outside Reg Z
// (1026.3(a)(2)). Trusts for estate planning and land trusts count as natural persons (comment 3(a)-10).
//
// Servicing transfer (12 CFR 1024.33): the old servicer writes at least 15 days before the effective date, the
// new one no more than 15 days after, and for the 60 days beginning on the effective date a payment sent on time
// to the old servicer can't be treated as late.

const DAY = 24 * 60 * 60 * 1000;
const SOON_DAYS = 5;

export type LoanPurpose = "CONSUMER" | "BUSINESS";
export type PaymentPolicy = "APPLY" | "HOLD" | "REJECT";
export type NoticeState = "sent" | "not_needed" | "late" | "due_soon" | "upcoming" | "waiting";

export const PAYMENT_POLICIES: Record<PaymentPolicy, string> = {
  APPLY: "If you send a payment that is less than the full amount due, we will accept it and apply it to your loan.",
  HOLD: "If you send a payment that is less than the full amount due, we will hold it in a separate account until you pay the rest of the payment, and then apply the full payment to your loan.",
  REJECT: "If you send a payment that is less than the full amount due, we will not accept it and will return it to you.",
};

// The date as a UTC calendar day, so a 30-day count doesn't drift with the hour the file closed.
export function calendarDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function addDays(value: Date, days: number) {
  return new Date(calendarDay(value).getTime() + days * DAY);
}

const COMPANY = /\b(l\.?l\.?c|inc|incorporated|corp|corporation|l\.?p|l\.?l\.?p|ltd|limited|company|co|pllc|plc)\.?$/i;

export function looksLikeCompany(name: string) {
  return COMPANY.test(name.trim().replace(/[,\s]+$/, ""));
}

// A suggestion from what the tape says. The buyer and its counsel decide.
export function loanScope(note: { occupancy: string; borrowerName: string }) {
  if (looksLikeCompany(note.borrowerName)) return { inScope: false, reason: "The borrower is a company, so Reg Z doesn't apply." };
  if (note.occupancy === "TENANT") return { inScope: false, reason: "Credit for a tenant-occupied rental is treated as business purpose." };
  if (note.occupancy === "OWNER_OCCUPIED") return { inScope: true, reason: "An owner-occupied home loan to a person is consumer credit." };
  return { inScope: true, reason: "Occupancy isn't known, so treat it as in scope until the purpose is confirmed." };
}

export function loansInScope<T extends { occupancy: string; borrowerName: string }>(notes: T[], purpose: string | null | undefined) {
  if (purpose === "BUSINESS") return [];
  if (purpose === "CONSUMER") return notes;
  return notes.filter((note) => loanScope(note).inScope);
}

function stateFor(due: Date | null, sent: Date | null | undefined, now: Date): NoticeState {
  if (sent) return "sent";
  if (!due) return "waiting";
  const left = Math.round((calendarDay(due).getTime() - calendarDay(now).getTime()) / DAY);
  if (left < 0) return "late";
  return left <= SOON_DAYS ? "due_soon" : "upcoming";
}

export type NoticeClosing = {
  status: string;
  closedAt: Date | null;
  transferAt?: Date | null;
  loanPurpose?: string | null;
  ownerNoticeSentAt?: Date | null;
};

export type NoticeBoarding = { boardedAt: Date | null; goodbyeSentAt?: Date | null; helloSentAt?: Date | null } | null;

// The date of transfer is the one the parties record, or the day the file closed.
export function transferDate(closing: NoticeClosing) {
  const raw = closing.transferAt ?? (closing.status === "COMPLETE" ? closing.closedAt : null);
  return raw ? calendarDay(raw) : null;
}

export function borrowerNotices(closing: NoticeClosing, boarding: NoticeBoarding, inScope: number, now = new Date()) {
  const transfer = transferDate(closing);
  const saleDue = transfer ? addDays(transfer, 30) : null;
  const effective = boarding?.boardedAt ? calendarDay(boarding.boardedAt) : null;
  const sale = {
    due: saleDue,
    state: inScope === 0 ? ("not_needed" as const) : stateFor(saleDue, closing.ownerNoticeSentAt, now),
  };
  const goodbyeDue = effective ? addDays(effective, -15) : null;
  const helloDue = effective ? addDays(effective, 15) : null;
  return {
    transfer,
    inScope,
    sale,
    effective,
    goodbye: { due: goodbyeDue, state: stateFor(goodbyeDue, boarding?.goodbyeSentAt, now) },
    hello: { due: helloDue, state: stateFor(helloDue, boarding?.helloSentAt, now) },
    // Day 1 is the effective date itself, so the 60th day is 59 days after it.
    graceThrough: effective ? addDays(effective, 59) : null,
  };
}

// One reminder five days out and one more once it's late, then nothing until someone records it.
export function saleNoticeNeedsReminder(due: Date | null, sent: Date | null | undefined, remindedAt: Date | null | undefined, now = new Date()) {
  const state = stateFor(due, sent, now);
  if (state === "due_soon") return !remindedAt;
  if (state === "late") return !remindedAt || (due !== null && remindedAt < due);
  return false;
}
