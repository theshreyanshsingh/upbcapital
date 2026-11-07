import { irrPct, monthlyIrr, monthlyRate, projectFlows } from "@/lib/underwriting";

// Discount accretion. A note bought below its unpaid principal earns the gap over its life, on top of the interest
// and principal each payment carries. This works that gap out month by month, apart from the receipts' own split in
// lib/portfolio-tax.ts. Constant yield when the note's rate, term and payment are on file: the price's yield on the
// scheduled payments, less the note rate, on the balance at each month. Straight-line otherwise, over the months left
// to maturity or, without a maturity, an assumed horizon that the label states. The figure is for the holder's tax
// adviser, who decides whether and how it is reported. It is not tax advice.

export const ACCRETION_NOTE = "Discount accretion is worked out for your tax adviser. It is not tax advice.";
export const ASSUMED_HORIZON_MONTHS = 60;
export const CONSTANT_YIELD = "Constant yield";
export const STRAIGHT_LINE = "Straight-line";

const DAY = 24 * 60 * 60 * 1000;
const MONTH = (365.25 / 12) * DAY;

// One loan behind a holding, at its full balance. A share of a note is scaled down to the holding's own balance.
export type AccretionLoan = { upb: number; annualRate: number | null; monthlyPi: number | null; termMonths: number | null };

export type AccretionInput = {
  costBasis: number;
  upb: number;
  acquiredAt: Date;
  loans: AccretionLoan[];
  // Straight-line only, when no loan has a maturity on file.
  horizonMonths?: number;
};

export type AccretionPeriod = { month: number; endsOn: Date; amount: number };

export type Accretion = {
  method: "constant-yield" | "straight-line";
  discount: number;
  months: number;
  // Constant yield only: the yield the price buys on the scheduled payments, a year, as a percent.
  yieldPct: number | null;
  // Straight-line only: the horizon is an assumption, not the note's term.
  assumedHorizon: boolean;
  periods: AccretionPeriod[];
  // "Constant yield at 11.84% a year over 120 months of scheduled payments", for the page.
  label: string;
  // "Constant yield", "Straight-line, 120 months", for a statement column.
  basis: string;
};

const cents = (value: number) => Math.round(value * 100) / 100;

// Whole months from one date to another, at least one. Null when the second is not after the first.
export function monthsBetween(from: Date, to: Date | null | undefined) {
  if (!to || to.getTime() <= from.getTime()) return null;
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / MONTH));
}

// The same day some months on, held to the month's last day, so a note bought on the 31st steps through February.
export function addMonths(date: Date, months: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), last), date.getUTCHours(), date.getUTCMinutes()));
}

function known(loan: AccretionLoan) {
  return (
    loan.annualRate != null && Number.isFinite(loan.annualRate) && loan.annualRate >= 0 &&
    loan.monthlyPi != null && Number.isFinite(loan.monthlyPi) && loan.monthlyPi > 0 &&
    loan.termMonths != null && Number.isFinite(loan.termMonths) && loan.termMonths >= 1 &&
    Number.isFinite(loan.upb) && loan.upb > 0
  );
}

// Rounded to cents, with the last month taking what rounding left, so the months add to the discount exactly.
function settle(amounts: number[], discount: number, acquiredAt: Date): AccretionPeriod[] {
  let running = 0;
  return amounts.map((raw, index) => {
    const last = index === amounts.length - 1;
    const amount = last ? cents(discount - running) : cents(raw);
    running = cents(running + amount);
    return { month: index + 1, endsOn: addMonths(acquiredAt, index + 1), amount };
  });
}

// Each loan's scheduled payments from lib/underwriting's projectFlows, scaled to the holding's balance, with the note
// rate's interest on the balance before each one. The balance moves as projectFlows moves it.
function scheduled(loans: AccretionLoan[], scale: number) {
  const payments: number[] = [];
  const interest: number[] = [];
  for (const loan of loans) {
    const upb = loan.upb * scale;
    const rate = (loan.annualRate as number) / 100 / 12;
    const flows = projectFlows({ bid: 0, upb, annualRate: loan.annualRate as number, monthlyPi: (loan.monthlyPi as number) * scale, termMonths: loan.termMonths as number }).slice(1);
    let balance = upb;
    flows.forEach((payment, index) => {
      const owed = balance * rate;
      payments[index] = (payments[index] ?? 0) + payment;
      interest[index] = (interest[index] ?? 0) + owed;
      balance = Math.max(0, balance + owed - payment);
    });
  }
  return { payments: Array.from(payments, (value) => value ?? 0), interest: Array.from(interest, (value) => value ?? 0) };
}

function constantYield(input: AccretionInput, discount: number): Accretion | null {
  const total = input.loans.reduce((sum, loan) => sum + loan.upb, 0);
  if (!(total > 0)) return null;
  const { payments, interest } = scheduled(input.loans, input.upb / total);
  if (!payments.length) return null;
  const flows = [-input.costBasis, ...payments];
  // Newton from lib/underwriting first, then its bisection, which works on an annual figure.
  let monthly = monthlyIrr(flows);
  if (monthly == null || !Number.isFinite(monthly)) {
    const annual = irrPct(flows);
    monthly = annual == null ? null : monthlyRate(annual);
  }
  if (monthly == null || !Number.isFinite(monthly) || monthly <= -1) return null;
  // Income each month is the yield on what the note is carried at. The part beyond the note rate's interest is the
  // discount coming in. The carrying value rises by it and falls by the principal paid, and meets the balance at the end.
  let carrying = input.costBasis;
  const amounts = payments.map((payment, index) => {
    const income = carrying * monthly;
    carrying = carrying + income - payment;
    return income - interest[index];
  });
  const yieldPct = ((1 + monthly) ** 12 - 1) * 100;
  return {
    method: "constant-yield",
    discount,
    months: amounts.length,
    yieldPct,
    assumedHorizon: false,
    periods: settle(amounts, discount, input.acquiredAt),
    label: `${CONSTANT_YIELD} at ${yieldPct.toFixed(2)}% a year over ${amounts.length} months of scheduled payments`,
    basis: CONSTANT_YIELD,
  };
}

function straightLine(input: AccretionInput, discount: number): Accretion {
  const terms = input.loans.map((loan) => loan.termMonths).filter((months): months is number => months != null && Number.isFinite(months) && months >= 1);
  const term = terms.length ? Math.round(Math.max(...terms)) : null;
  const months = Math.max(1, Math.round(term ?? input.horizonMonths ?? ASSUMED_HORIZON_MONTHS));
  const assumedHorizon = term == null;
  const amounts = Array.from({ length: months }, () => discount / months);
  return {
    method: "straight-line",
    discount,
    months,
    yieldPct: null,
    assumedHorizon,
    periods: settle(amounts, discount, input.acquiredAt),
    label: assumedHorizon
      ? `${STRAIGHT_LINE} over ${months} months, an assumed horizon. The note's maturity isn't on file`
      : `${STRAIGHT_LINE} over the ${months} months left to maturity. The note's rate or payment isn't on file, so constant yield can't be worked out`,
    basis: `${STRAIGHT_LINE}, ${months} months${assumedHorizon ? " assumed" : ""}`,
  };
}

// The schedule for one holding, or null when it was bought at or above its balance and there is nothing to accrete.
export function accretionSchedule(input: AccretionInput): Accretion | null {
  if (!(input.costBasis > 0) || !(input.upb > 0)) return null;
  const discount = cents(input.upb - input.costBasis);
  if (discount <= 0) return null;
  const solved = input.loans.length && input.loans.every(known) ? constantYield(input, discount) : null;
  return solved ?? straightLine(input, discount);
}

// What accreted in months ending on or after `from` and before `to`.
export function accretedBetween(schedule: Pick<Accretion, "periods">, from: Date, to: Date) {
  return cents(schedule.periods.reduce((sum, period) => (period.endsOn.getTime() >= from.getTime() && period.endsOn.getTime() < to.getTime() ? sum + period.amount : sum), 0));
}

// What accreted in months ending on or before a date.
export function accretedThrough(schedule: Pick<Accretion, "periods">, at: Date) {
  return cents(schedule.periods.reduce((sum, period) => (period.endsOn.getTime() <= at.getTime() ? sum + period.amount : sum), 0));
}

// Calendar years, oldest first, with what accreted in each.
export function accretionByYear(schedule: Pick<Accretion, "periods">) {
  const years = new Map<number, number>();
  for (const period of schedule.periods) {
    const year = period.endsOn.getUTCFullYear();
    years.set(year, cents((years.get(year) ?? 0) + period.amount));
  }
  return [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, amount]) => ({ year, amount }));
}
