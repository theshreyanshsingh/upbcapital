import { prisma } from "@/lib/prisma";

// Dates for the notices a borrower gets when a note trades. UPB never contacts borrowers. These dates are for
// the new owner and the servicers, who send them. This is UPB's read of the rules, not legal advice, and counsel
// confirms it.
//
// Sale notice (12 CFR 1026.39): the new owner sends it on or before the 30th calendar day after the date of
// transfer. It covers consumer credit to a natural person secured by a dwelling or real property. Credit for a
// tenant-occupied rental is deemed business purpose (comment 3(a)-4), and credit to a company is outside Reg Z
// (1026.3(a)(2)). Trusts for estate planning and land trusts count as natural persons (comment 3(a)-10).
// Only a "covered person" owes it: an owner that acquires more than one mortgage loan in any 12-month period,
// counting loans bought anywhere (1026.39(a)(1)). Even then it isn't owed when the owner sells or assigns the loan
// on or before the 30th day after acquiring it (1026.39(c)(1)), or when it acquires only a partial interest and the
// party that takes the borrower's rescission notice and payment questions doesn't change (1026.39(c)(3)). The third
// exception, a loan taken under a repurchase agreement (1026.39(c)(2)), isn't offered: a note sale on UPB is an
// outright sale.
//
// Servicing transfer (12 CFR 1024.33): the old servicer writes at least 15 days before the effective date, the
// new one no more than 15 days after, or both in one notice at least 15 days before. For the 60 days beginning on
// the effective date a payment sent on time to the old servicer can't be treated as late.

const DAY = 24 * 60 * 60 * 1000;
const SOON_DAYS = 5;

export const SALE_NOTICE_DAYS = 30;
export const SERVICER_LETTER_DAYS = 15;
export const PAYMENT_GRACE_DAYS = 60;

export type LoanPurpose = "CONSUMER" | "BUSINESS";
export type PaymentPolicy = "APPLY" | "HOLD" | "REJECT";
export type NoticeState = "sent" | "not_needed" | "late" | "due_soon" | "upcoming" | "waiting";
export type NoticeExemption = "ONE_LOAN" | "RESOLD_30" | "PARTIAL";

export const PAYMENT_POLICIES: Record<PaymentPolicy, string> = {
  APPLY: "If you send a payment that is less than the full amount due, we will accept it and apply it to your loan.",
  HOLD: "If you send a payment that is less than the full amount due, we will hold it in a separate account until you pay the rest of the payment, and then apply the full payment to your loan.",
  REJECT: "If you send a payment that is less than the full amount due, we will not accept it and will return it to you.",
};

// Why no sale notice is owed, as UPB reads 12 CFR 1026.39. The owner records one; counsel confirms it first.
export const NOTICE_EXEMPTIONS: Record<NoticeExemption, { label: string; reason: string }> = {
  ONE_LOAN: {
    label: "Not a covered person",
    reason: "The owner acquired no other mortgage loan in the 12 months, on UPB or anywhere else, so this is its only one (1026.39(a)(1)).",
  },
  RESOLD_30: {
    label: "Resold within 30 days",
    reason: "The owner sold or assigned this loan on or before the 30th day after acquiring it (1026.39(c)(1)). Record it once that sale has closed.",
  },
  PARTIAL: {
    label: "Partial interest only",
    reason: "The owner acquired only a partial interest, and the party that takes the borrower's rescission notice and payment questions didn't change (1026.39(c)(3)).",
  },
};

export function readExemption(value: unknown): NoticeExemption | null {
  return typeof value === "string" && Object.hasOwn(NOTICE_EXEMPTIONS, value) ? (value as NoticeExemption) : null;
}

// How the notice went and the proof of it: a certified-mail or tracking number, or a certificate of mailing
// reference. A sent date needs one.
export const PROOF_MIN = 6;

export function readNoticeProof(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function proofProblem(sentAt: Date | null | undefined, proof: string) {
  if (!sentAt || proof.length >= PROOF_MIN) return null;
  return "Say how the sale notice went and give its proof: the certified-mail or tracking number, or the certificate of mailing reference.";
}

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
  ownerNoticeProof?: string | null;
  ownerNoticeExemption?: string | null;
};

export type NoticeBoarding = { boardedAt: Date | null; goodbyeSentAt?: Date | null; helloSentAt?: Date | null } | null;

// The date of transfer is the one the parties record, or the day the file closed.
export function transferDate(closing: NoticeClosing) {
  const raw = closing.transferAt ?? (closing.status === "COMPLETE" ? closing.closedAt : null);
  return raw ? calendarDay(raw) : null;
}

// Every clock from the dates on file. The servicing transfer takes effect on the boarding form's date once it's set;
// until then the date of transfer stands in for it, so the servicers' letters are dated from the start. The trailing
// documents read the same dates. lib/trailing-docs.ts.
export function noticeClocks(closing: NoticeClosing, boarding: NoticeBoarding) {
  const transfer = transferDate(closing);
  const effective = boarding?.boardedAt ? calendarDay(boarding.boardedAt) : transfer;
  return {
    transfer,
    effective,
    // Whether the servicing transfer date is the boarding form's own, not the date of transfer standing in.
    effectiveSet: Boolean(boarding?.boardedAt),
    saleDue: transfer ? addDays(transfer, SALE_NOTICE_DAYS) : null,
    goodbyeDue: effective ? addDays(effective, -SERVICER_LETTER_DAYS) : null,
    helloDue: effective ? addDays(effective, SERVICER_LETTER_DAYS) : null,
    // Day 1 is the effective date itself, so the 60th day is 59 days after it.
    graceThrough: effective ? addDays(effective, PAYMENT_GRACE_DAYS - 1) : null,
  };
}

export type NoticeClocks = ReturnType<typeof noticeClocks>;

// The sale notice isn't needed when no loan is in scope, or when the owner recorded why it isn't owed. A notice
// recorded as sent stays sent.
function saleState(closing: NoticeClosing, inScope: number, due: Date | null, now: Date): NoticeState {
  if (inScope === 0) return "not_needed";
  if (closing.ownerNoticeSentAt) return "sent";
  if (readExemption(closing.ownerNoticeExemption)) return "not_needed";
  return stateFor(due, null, now);
}

export function borrowerNotices(closing: NoticeClosing, boarding: NoticeBoarding, inScope: number, now = new Date()) {
  const clocks = noticeClocks(closing, boarding);
  const state = saleState(closing, inScope, clocks.saleDue, now);
  const sale = {
    due: clocks.saleDue,
    state,
    // The exemption on file, when it's what makes the notice not needed.
    exemption: state === "not_needed" && inScope > 0 ? readExemption(closing.ownerNoticeExemption) : null,
    proof: closing.ownerNoticeProof?.trim() || null,
  };
  return {
    transfer: clocks.transfer,
    inScope,
    sale,
    effective: clocks.effective,
    effectiveSet: clocks.effectiveSet,
    goodbye: { due: clocks.goodbyeDue, state: stateFor(clocks.goodbyeDue, boarding?.goodbyeSentAt, now) },
    hello: { due: clocks.helloDue, state: stateFor(clocks.helloDue, boarding?.helloSentAt, now) },
    graceThrough: clocks.graceThrough,
  };
}

// One reminder five days out and one more once it's late, then nothing until someone records it. A notice recorded
// as sent, which takes its proof, or an exemption on file ends them.
export function saleNoticeNeedsReminder(due: Date | null, sent: Date | null | undefined, remindedAt: Date | null | undefined, now = new Date(), exemption?: string | null) {
  if (readExemption(exemption)) return false;
  const state = stateFor(due, sent, now);
  if (state === "due_soon") return !remindedAt;
  if (state === "late") return !remindedAt || (due !== null && remindedAt < due);
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// The covered-person question

export type CoveredFacts = {
  // The owner's answer: did it acquire any other mortgage loan, on UPB or elsewhere, in the 12 months? Null is unanswered.
  otherLoans: boolean | null | undefined;
  // Other purchases by the owner on UPB within 12 months of this transfer. A floor, since purchases elsewhere count.
  otherOnUpb: number;
  // Loans on this closing that look in scope. Two or more makes the owner a covered person by themselves.
  loansHere: number;
};

// UPB suggests "not a covered person" only when the owner said no, UPB's own record agrees, and this closing moves
// one loan in scope. Anything else, the owner and its counsel decide.
export function suggestedExemption(facts: CoveredFacts): NoticeExemption | null {
  return facts.otherLoans === false && facts.otherOnUpb === 0 && facts.loansHere <= 1 ? "ONE_LOAN" : null;
}

// Why an exemption can't be recorded, or null. "Not a covered person" has to agree with the owner's answer and with
// what UPB can see. The others rest on facts UPB doesn't hold, so the owner's record of them stands.
export function exemptionProblem(exemption: NoticeExemption | null, facts: CoveredFacts) {
  if (exemption !== "ONE_LOAN") return null;
  if (facts.otherLoans !== false) return "Answer no to other mortgage loans in the 12 months before choosing not a covered person.";
  if (facts.loansHere > 1) return "This closing moves more than one mortgage loan, so the owner looks like a covered person.";
  if (facts.otherOnUpb > 0) return "UPB's record shows another purchase by this owner within 12 months, so it looks like a covered person.";
  return null;
}

// The owner's other purchases on UPB within 12 months either side of this transfer, since any 12-month period
// counts: closed closings it bought, or funded a share of, other than this one. On a desk purchase the owner is UPB,
// so these are the desk's other purchases.
export async function otherPurchasesOnUpb(
  closing: { id: string; deskBidId?: string | null; funders?: { userId: string }[] },
  buyerId: string | null,
  transfer: Date | null,
  now = new Date(),
) {
  const around = calendarDay(transfer ?? now);
  const base = { id: { not: closing.id }, status: "COMPLETE" as const, closedAt: { gte: addDays(around, -365), lt: addDays(around, 366) } };
  if (closing.deskBidId) return prisma.closing.count({ where: { ...base, deskBidId: { not: null } } });
  const ids = [...new Set([buyerId, ...(closing.funders ?? []).map((funder) => funder.userId)].filter((id): id is string => Boolean(id)))];
  if (!ids.length) return 0;
  const won = await prisma.inquiry.findMany({ where: { buyerId: { in: ids }, status: "ACCEPTED" }, select: { id: true } });
  return prisma.closing.count({ where: { ...base, OR: [{ inquiryId: { in: won.map((row) => row.id) } }, { funders: { some: { userId: { in: ids } } } }] } });
}
