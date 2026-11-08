import { pricesFor } from "@/lib/loan-prices";

// Proration, as the purchase agreement's article 5 sets it (lib/closing-docs.ts). The price is set from the tape's
// unpaid principal at the cut-off date. Principal the borrower paid down between the cut-off and closing comes off
// the price at the price-to-UPB ratio the buyer paid, so a loan bought at 90% of UPB takes 90 cents off for each dollar
// paid down. Interest before the closing date is the seller's and from it the buyer's, so the days between the date
// the borrower's interest is paid to and the closing date move at the note rate, per diem on an actual/365 basis:
// accrued and unpaid is owed to the seller, collected past closing is owed back to the buyer. A pool is done loan by
// loan. Pure functions, so the desk form and the tests run the same maths.
//
// The adjustment is its own line. The closing's stored price and fees never change with it: positive cents are owed to
// the seller, so the buyer wires that much more and the seller nets that much more.

const DAY = 24 * 60 * 60 * 1000;

// The days a paid-to date may sit from closing, either way, before it reads as a typing slip.
export const PRORATION_MAX_DAYS = 366;

export type ProrationLoanInput = {
  noteId: string;
  label: string;
  // This loan's part of the price, the UPB on the tape at the cut-off, and the UPB at closing.
  priceCents: number;
  tapeUpbCents: number;
  closingUpbCents: number;
  // The note rate, as a percent a year.
  ratePercent: number;
  // The date the borrower's interest is paid to. Null leaves interest out, as for a loan bought without its arrears.
  interestPaidTo: Date | null;
};

export type ProrationLoan = Omit<ProrationLoanInput, "interestPaidTo"> & {
  interestPaidTo: string | null;
  // Principal paid down since the cut-off, positive when the balance fell.
  paidDownCents: number;
  principalCents: number;
  perDiemCents: number;
  interestDays: number;
  interestCents: number;
  totalCents: number;
};

export type PriceBasis = "loanPrice" | "upbShare";

export type Proration = {
  cutoffDate: string;
  closingDate: string;
  basis: PriceBasis;
  loans: ProrationLoan[];
  principalCents: number;
  interestCents: number;
  totalCents: number;
};

export const BASIS_TEXT: Record<PriceBasis, string> = {
  loanPrice: "by the buyer's own price for each loan",
  upbShare: "by each loan's share of the unpaid principal, so every loan carries the pool's price-to-UPB ratio",
};

function utcDay(date: Date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// Whole days from one date to the next, counted on calendar dates in UTC.
export function daysBetween(from: Date, to: Date) {
  return Math.round((utcDay(to) - utcDay(from)) / DAY);
}

export function isoDay(date: Date) {
  return new Date(utcDay(date)).toISOString().slice(0, 10);
}

// A day's interest on a balance at the note rate, actual/365. Kept to a hundredth of a cent so a long gap rounds once.
export function perDiemCents(upbCents: number, ratePercent: number) {
  return Math.round(((upbCents * ratePercent) / 100 / 365) * 100) / 100;
}

export function prorateLoan(loan: ProrationLoanInput, closingDate: Date): ProrationLoan {
  const paidDownCents = loan.tapeUpbCents - loan.closingUpbCents;
  // The price moves in the same proportion as the balance. A loan with no balance on the tape has no ratio to scale.
  // `|| 0` keeps a nil adjustment from reading as -0.
  const principalCents = (loan.tapeUpbCents > 0 ? Math.round((-paidDownCents * loan.priceCents) / loan.tapeUpbCents) : 0) || 0;
  const perDiem = perDiemCents(loan.closingUpbCents, loan.ratePercent);
  const interestDays = loan.interestPaidTo ? daysBetween(loan.interestPaidTo, closingDate) : 0;
  const interestCents = Math.round(perDiem * interestDays) || 0;
  return {
    ...loan,
    interestPaidTo: loan.interestPaidTo ? isoDay(loan.interestPaidTo) : null,
    paidDownCents,
    principalCents,
    perDiemCents: perDiem,
    interestDays,
    interestCents,
    totalCents: principalCents + interestCents,
  };
}

export function prorate(input: { cutoffDate: Date; closingDate: Date; basis: PriceBasis; loans: ProrationLoanInput[] }): Proration {
  const loans = input.loans.map((loan) => prorateLoan(loan, input.closingDate));
  const principalCents = loans.reduce((sum, loan) => sum + loan.principalCents, 0);
  const interestCents = loans.reduce((sum, loan) => sum + loan.interestCents, 0);
  return {
    cutoffDate: isoDay(input.cutoffDate),
    closingDate: isoDay(input.closingDate),
    basis: input.basis,
    loans,
    principalCents,
    interestCents,
    totalCents: principalCents + interestCents,
  };
}

// Each loan's part of the closing's price, in cents, adding up to the price. The buyer's own loan prices when the bid
// priced every loan on the closing and they still add up to it; otherwise by share of the tape's unpaid principal, with
// the last loan taking the rounding. One loan takes the whole price.
export function loanPriceShares(input: { priceCents: number; loans: { id: string; upbCents: number }[]; loanPrices?: unknown }) {
  const { priceCents, loans } = input;
  const shares: Record<string, number> = {};
  if (!loans.length) return { basis: "upbShare" as PriceBasis, shares };
  const priced = loans.length > 1 ? pricesFor(input.loanPrices, loans.map((loan) => loan.id), priceCents / 100) : null;
  const totalUpb = loans.reduce((sum, loan) => sum + Math.max(0, loan.upbCents), 0);
  let left = priceCents;
  loans.forEach((loan, index) => {
    if (index === loans.length - 1) {
      shares[loan.id] = left;
      return;
    }
    const share = priced
      ? Math.round(priced[loan.id] * 100)
      : Math.round(totalUpb > 0 ? (priceCents * Math.max(0, loan.upbCents)) / totalUpb : priceCents / loans.length);
    shares[loan.id] = share;
    left -= share;
  });
  return { basis: (priced ? "loanPrice" : "upbShare") as PriceBasis, shares };
}

// Why these figures can't be prorated, or null.
export function prorationProblem(input: { cutoffDate: Date | null; closingDate: Date | null; loans: { label: string; tapeUpbCents: number; closingUpbCents: number; interestPaidTo: Date | null }[] }) {
  if (!input.cutoffDate) return "Enter the cut-off date.";
  if (!input.closingDate) return "Enter the closing date.";
  if (daysBetween(input.cutoffDate, input.closingDate) < 0) return "The closing date can't be before the cut-off date.";
  if (!input.loans.length) return "This closing has no loans to prorate.";
  for (const loan of input.loans) {
    if (!Number.isFinite(loan.closingUpbCents) || loan.closingUpbCents < 0) return `Enter the unpaid principal at closing for ${loan.label}.`;
    // A balance can rise with capitalised advances, but double the tape is a typing slip.
    if (loan.tapeUpbCents > 0 && loan.closingUpbCents > loan.tapeUpbCents * 2) return `The unpaid principal at closing for ${loan.label} is more than twice the tape's. Check it.`;
    if (loan.interestPaidTo && Math.abs(daysBetween(loan.interestPaidTo, input.closingDate)) > PRORATION_MAX_DAYS) {
      return `The interest paid-to date for ${loan.label} is more than a year from closing. Check it, or leave it blank to leave interest out.`;
    }
  }
  return null;
}

// The stored detail as a proration, or null when it is missing or malformed.
export function readProration(raw: unknown): Proration | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Partial<Proration>;
  if (typeof value.cutoffDate !== "string" || typeof value.closingDate !== "string" || !Array.isArray(value.loans)) return null;
  if (![value.principalCents, value.interestCents, value.totalCents].every((cents) => typeof cents === "number" && Number.isFinite(cents))) return null;
  return value as Proration;
}

// Whether a stored proration still covers the closing's loans. A kick-out after it leaves it out of date.
export function prorationCovers(proration: Proration | null, noteIds: readonly string[]) {
  if (!proration) return false;
  const stored = new Set(proration.loans.map((loan) => loan.noteId));
  return stored.size === noteIds.length && noteIds.every((id) => stored.has(id));
}

function dollars(cents: number) {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Which way the adjustment runs, in a few words.
export function prorationDirection(cents: number) {
  if (cents > 0) return `${dollars(cents)} owed to the seller`;
  if (cents < 0) return `${dollars(-cents)} owed to the buyer`;
  return "no change";
}

// One sentence for both parties' notices.
export function prorationSummary(proration: Proration) {
  const parts = [
    proration.principalCents ? `principal ${dollars(proration.principalCents)}` : "",
    proration.interestCents ? `interest ${dollars(proration.interestCents)}` : "",
  ].filter(Boolean);
  return `From the cut-off on ${proration.cutoffDate} to closing on ${proration.closingDate}, the proration is ${prorationDirection(proration.totalCents)}${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}
