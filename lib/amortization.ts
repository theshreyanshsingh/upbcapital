import { addMonths } from "@/lib/accretion";
import { toCsv } from "@/lib/csv";
import { isoDate, money, pct, prettyDate } from "@/lib/format";

// A loan's remaining payments, month by month, from what the tape says: the unpaid balance, the note rate, the monthly
// P&I and the maturity date, starting at the next due date, or the month after the last paid date. Every payment is
// assumed to arrive as scheduled, so this is arithmetic on the tape and not a forecast of the borrower. Money moves in
// whole cents: each month's interest is rounded once, principal is what the payment leaves after it, and the balance
// falls by exactly that, so the principal paid adds up to the starting balance to the cent.

export const MAX_PAYMENTS = 480;
export const SCHEDULE_CAVEAT = "Assumes every payment arrives as scheduled. This is UPB's arithmetic from the tape, not a forecast of the borrower.";
// A loan that isn't paying gets no schedule: the contract's payments would read as income the tape doesn't support.
export const NON_PERFORMING_LINE = "No payment schedule for a non-performing loan. The borrower isn't paying, so the price rests on how the loan resolves, which the analyzer's resolution cases model.";
// A last payment this far above the regular P&I is a balloon. Closer than that, the difference is the tape's rounding.
const BALLOON_OVER = 1.1;

export type ScheduleLoan = {
  upb: number;
  // A year, in percent, as the tape carries it: 6.5 is 6.5%.
  interestRate: number | null;
  monthlyPi: number | null;
  maturityDate: Date | null;
  nextDueDate?: Date | null;
  lastPaidDate?: Date | null;
  balloonDate?: Date | null;
  // FIXED, ARM, INTEREST_ONLY, BALLOON or OTHER (lib/tape-fields.ts).
  paymentType?: string | null;
};

export type ScheduleRow = { number: number; date: Date; payment: number; interest: number; principal: number; balance: number };

// Where the first payment date came from: the tape's next due date, a month on from its last paid date, or neither.
export type ScheduleStart = "next-due" | "last-paid" | "assumed";

export type Schedule = {
  ok: true;
  rows: ScheduleRow[];
  start: ScheduleStart;
  firstDue: Date;
  // When the balance falls due on the tape: the balloon date where it comes before maturity. Null with neither.
  dueBy: Date | null;
  interestOnly: boolean;
  // No maturity on the tape, so the schedule runs until the P&I pays the balance off.
  termDerived: boolean;
  capped: boolean;
  paidOffEarly: boolean;
  balloon: { date: Date; amount: number } | null;
  totals: { payments: number; paid: number; interest: number; principal: number; payoffDate: Date | null; balanceLeft: number };
  // Plain lines for the page and the download: where the schedule starts and anything it had to assume.
  lines: string[];
};

export type NoSchedule = { ok: false; reason: string };

const valid = (date: Date | null | undefined): date is Date => date instanceof Date && !Number.isNaN(date.getTime());
const utcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const dayKey = (date: Date) => date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();

// A day of the month, held to the month's last day.
function dueIn(year: number, month: number, day: number) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last)));
}

// The tape's next due date. Failing that, the first due day after the last paid date, or from today with neither. The
// due day is the maturity's day of the month, or the 1st without one.
function firstDue(loan: ScheduleLoan, maturity: Date | null, now: Date): { date: Date; start: ScheduleStart } {
  if (valid(loan.nextDueDate)) return { date: utcDay(loan.nextDueDate), start: "next-due" };
  const day = maturity ? maturity.getUTCDate() : 1;
  const paid = valid(loan.lastPaidDate) ? utcDay(loan.lastPaidDate) : null;
  const from = paid ?? utcDay(now);
  let date = dueIn(from.getUTCFullYear(), from.getUTCMonth(), day);
  // A payment on the last paid date itself is the one already made. From today, a payment due today still counts.
  if (paid ? dayKey(date) <= dayKey(from) : dayKey(date) < dayKey(from)) date = dueIn(from.getUTCFullYear(), from.getUTCMonth() + 1, day);
  return { date, start: paid ? "last-paid" : "assumed" };
}

// How many monthly payments fall on or before the date the balance is due. Zero or less when it comes first.
function paymentsBy(first: Date, end: Date) {
  let months = (end.getUTCFullYear() - first.getUTCFullYear()) * 12 + end.getUTCMonth() - first.getUTCMonth();
  if (dayKey(addMonths(first, months)) > dayKey(end)) months -= 1;
  return months + 1;
}

function startLine(start: ScheduleStart, first: Date, loan: ScheduleLoan, now: Date) {
  // A tape filed a while ago starts the schedule before today. Its balance is the tape's, so payments made since would
  // have lowered it, and the page says so rather than show past dates as the next payments.
  const passed = dayKey(first) < dayKey(now) ? " That date has passed, so the first payments shown fall before today, and any paid since then would have lowered the balance." : "";
  if (start === "next-due") return `Starts at the next due date on the tape, ${prettyDate(first)}.${passed}`;
  if (start === "last-paid") return `The tape has no next due date, so the first payment is taken as ${prettyDate(first)}, the first due day after the last paid date of ${prettyDate(loan.lastPaidDate)}.${passed}`;
  return `The tape has no next due or last paid date, so the first payment is taken as ${prettyDate(first)}, the first due day from today.`;
}

type Walk = { rows: ScheduleRow[]; balance: number; paid: number; interest: number; principal: number; stopped: boolean };

// The schedule's set-up, or the plain reason the tape can't give one.
function plan(loan: ScheduleLoan, now: Date) {
  const upb = Math.round(Number(loan.upb) * 100);
  if (!Number.isFinite(upb) || upb <= 0) return { ok: false as const, reason: "No unpaid balance on the tape, so there is nothing to schedule." };
  const annual = loan.interestRate == null ? Number.NaN : Number(loan.interestRate);
  if (!Number.isFinite(annual) || annual < 0) return { ok: false as const, reason: "No note rate on the tape, so the interest in each payment can't be worked out." };
  const interestOnly = loan.paymentType === "INTEREST_ONLY";
  const pi = Math.round(Number(loan.monthlyPi ?? 0) * 100);
  if (!interestOnly && !(pi > 0)) return { ok: false as const, reason: "No monthly P&I on the tape, so the payments can't be scheduled." };
  const rate = annual / 100 / 12;
  const maturity = valid(loan.maturityDate) ? utcDay(loan.maturityDate) : null;
  const balloonAt = valid(loan.balloonDate) && (!maturity || dayKey(loan.balloonDate) < dayKey(maturity)) ? utcDay(loan.balloonDate) : null;
  const dueBy = balloonAt ?? maturity;
  const first = firstDue(loan, maturity, now);
  const firstInterest = Math.round(upb * rate);
  if (!interestOnly && pi < firstInterest) {
    return { ok: false as const, reason: `The monthly P&I on the tape, ${money(pi / 100, 2)}, doesn't cover a month's interest at ${pct(annual, 2)}, so the schedule can't be worked out from the tape.` };
  }
  let count: number | null = null;
  if (dueBy) {
    count = paymentsBy(first.date, dueBy);
    if (count < 1) return { ok: false as const, reason: `The ${balloonAt ? "balloon" : "maturity"} date on the tape, ${prettyDate(dueBy)}, comes before the next payment due, so the whole balance is due and there is no schedule to show.` };
  } else if (interestOnly) {
    return { ok: false as const, reason: "An interest-only loan with no maturity date on the tape never pays down, so there is no end to schedule." };
  } else if (pi === firstInterest) {
    return { ok: false as const, reason: "The P&I on the tape only covers the interest, and there is no maturity date to end the schedule." };
  }
  return { ok: true as const, upb, annual, rate, pi, interestOnly, dueBy, balloonAt, first, count };
}

type Plan = Extract<ReturnType<typeof plan>, { ok: true }>;

// Month by month in cents. The last payment due takes the whole balance, and so does a payment that would overpay it.
// `through` stops the rows after a date, for a window that needs no more.
function walk(setup: Plan, cap: number, through: Date | null): Walk {
  const out: Walk = { rows: [], balance: setup.upb, paid: 0, interest: 0, principal: 0, stopped: false };
  const limit = setup.count == null ? cap : Math.min(setup.count, cap);
  const stopAt = through ? dayKey(through) : null;
  for (let index = 0; index < limit && out.balance > 0; index += 1) {
    const date = addMonths(setup.first.date, index);
    if (stopAt != null && dayKey(date) > stopAt) {
      out.stopped = true;
      break;
    }
    const interest = Math.round(out.balance * setup.rate);
    let principal = setup.interestOnly ? 0 : setup.pi - interest;
    // Without a maturity, a remainder under 1% of the P&I is the tape's rounding of the payment, and goes with this one.
    const crumb = setup.count == null && out.balance - principal <= setup.pi * 0.01;
    if (index === (setup.count ?? 0) - 1 || principal >= out.balance || crumb) principal = out.balance;
    out.balance -= principal;
    out.paid += principal + interest;
    out.interest += interest;
    out.principal += principal;
    out.rows.push({ number: index + 1, date, payment: (principal + interest) / 100, interest: interest / 100, principal: principal / 100, balance: out.balance / 100 });
  }
  return out;
}

export function paymentSchedule(loan: ScheduleLoan, options: { now?: Date; cap?: number } = {}): Schedule | NoSchedule {
  const now = options.now ?? new Date();
  const cap = Math.max(1, Math.floor(options.cap ?? MAX_PAYMENTS));
  const setup = plan(loan, now);
  if (!setup.ok) return setup;
  const run = walk(setup, cap, null);
  const { rows } = run;
  const final = rows[rows.length - 1];
  const paidOff = run.balance === 0;
  const capped = !paidOff && rows.length >= cap;
  const reachedDue = setup.count != null && rows.length === setup.count;
  const regular = setup.interestOnly ? (rows.length > 1 ? rows[rows.length - 2].payment : 0) : setup.pi / 100;
  const balloon = paidOff && reachedDue && final.payment > regular * BALLOON_OVER ? { date: final.date, amount: final.payment } : null;
  const paidOffEarly = paidOff && setup.count != null && rows.length < setup.count;
  const dueWord = setup.balloonAt ? "balloon date" : "maturity date";
  const lines = [startLine(setup.first.start, setup.first.date, loan, now)];
  if (setup.count == null && paidOff) lines.push(`The tape has no maturity date, so the term is worked out from the P&I: ${rows.length} payments.`);
  if (setup.interestOnly) {
    lines.push(`Interest-only, as the tape's payment type says. No principal is paid until the balance falls due on ${prettyDate(setup.dueBy)}. A loan that starts paying principal after an interest-only period isn't modelled.`);
  } else if (balloon) {
    lines.push(`The P&I doesn't pay the loan off by the ${dueWord}, ${prettyDate(setup.dueBy)}, so the last payment is a balloon of ${money(balloon.amount, 2)}.`);
  }
  if (paidOffEarly) lines.push(`The P&I is more than the loan needs, so it pays off on ${prettyDate(final.date)}, ahead of the ${dueWord}, ${prettyDate(setup.dueBy)}.`);
  if (capped) lines.push(`Shown to ${cap} payments. On the tape's figures the loan runs longer, with ${money(run.balance / 100, 2)} still owed after the last one shown.`);
  if (setup.annual === 0) lines.push("At a 0% note rate, every payment is principal.");
  if (loan.paymentType === "ARM") lines.push("An adjustable rate is shown at the note rate on the tape. Its resets aren't modelled.");
  return {
    ok: true,
    rows,
    start: setup.first.start,
    firstDue: setup.first.date,
    dueBy: setup.dueBy,
    interestOnly: setup.interestOnly,
    termDerived: setup.count == null,
    capped,
    paidOffEarly,
    balloon,
    totals: {
      payments: rows.length,
      paid: run.paid / 100,
      interest: run.interest / 100,
      principal: run.principal / 100,
      payoffDate: paidOff ? final.date : null,
      balanceLeft: run.balance / 100,
    },
    lines,
  };
}

// The schedule a listing shows for one of its loans. A non-performing loan gets the reason instead.
export function noteSchedule(note: ScheduleLoan & { paymentStatus: string }, options: { now?: Date; cap?: number } = {}): Schedule | NoSchedule {
  if (note.paymentStatus === "NON_PERFORMING") return { ok: false, reason: NON_PERFORMING_LINE };
  return paymentSchedule(note, options);
}

export type ScheduleYear = { year: number; payments: number; paid: number; interest: number; principal: number; balance: number };

// Calendar years, oldest first: what was paid in each, and the balance after its last payment.
export function scheduleByYear(rows: ScheduleRow[]): ScheduleYear[] {
  const years: ScheduleYear[] = [];
  const cents = (value: number) => Math.round(value * 100);
  let current: (ScheduleYear & { cents: [number, number, number] }) | null = null;
  for (const row of rows) {
    const year = row.date.getUTCFullYear();
    if (!current || current.year !== year) {
      current = { year, payments: 0, paid: 0, interest: 0, principal: 0, balance: 0, cents: [0, 0, 0] };
      years.push(current);
    }
    current.payments += 1;
    current.cents = [current.cents[0] + cents(row.payment), current.cents[1] + cents(row.interest), current.cents[2] + cents(row.principal)];
    current.paid = current.cents[0] / 100;
    current.interest = current.cents[1] / 100;
    current.principal = current.cents[2] / 100;
    current.balance = row.balance;
  }
  return years.map(({ year, payments, paid, interest, principal, balance }) => ({ year, payments, paid, interest, principal, balance }));
}

// ---------------------------------------------------------------------------------------------------------------
// The monthly schedule as a download. It carries the loan's city and state and its figures, never the borrower, the
// street or the loan number.

export type DownloadLoan = ScheduleLoan & { id: string; city: string; state: string; paymentStatus: string };

const twoPlaces = (value: number) => value.toFixed(2);

export function scheduleCsv(input: { listingId: string; position: number; count: number; loan: DownloadLoan; schedule: Schedule }) {
  const { loan, schedule } = input;
  const summary: { field: string; value: string | number }[] = [
    { field: "listing", value: input.listingId },
    { field: "loan", value: input.count > 1 ? `Loan ${input.position} of ${input.count}` : "Single loan" },
    { field: "location", value: `${loan.city}, ${loan.state}` },
    { field: "upb", value: twoPlaces(Number(loan.upb)) },
    { field: "note_rate_pct", value: Number(loan.interestRate) },
    { field: "monthly_pi", value: twoPlaces(Number(loan.monthlyPi ?? 0)) },
    { field: "first_payment", value: isoDate(schedule.firstDue) ?? "" },
    { field: "balance_due_by", value: isoDate(schedule.dueBy) ?? "" },
    { field: "payments_left", value: schedule.totals.payments },
    { field: "total_paid", value: twoPlaces(schedule.totals.paid) },
    { field: "total_interest", value: twoPlaces(schedule.totals.interest) },
    { field: "total_principal", value: twoPlaces(schedule.totals.principal) },
    { field: "payoff_date", value: isoDate(schedule.totals.payoffDate) ?? "" },
    { field: "balloon_payment", value: schedule.balloon ? twoPlaces(schedule.balloon.amount) : "" },
    { field: "balance_after_last_row", value: twoPlaces(schedule.totals.balanceLeft) },
    ...schedule.lines.map((line) => ({ field: "note", value: line })),
    { field: "assumption", value: SCHEDULE_CAVEAT },
  ];
  const rows = schedule.rows.map((row) => ({
    payment_number: row.number,
    date: isoDate(row.date) ?? "",
    payment: twoPlaces(row.payment),
    interest: twoPlaces(row.interest),
    principal: twoPlaces(row.principal),
    balance_after: twoPlaces(row.balance),
  }));
  return `${toCsv(summary)}\n\n${toCsv(rows)}\n`;
}

export type DownloadAnswer = { status: number; body: string; filename?: string };

// What app/api/listings/[id]/schedule serves. `visible` and `opens` are the listing page's own checks
// (lib/private-listings.ts listingSight, lib/access.ts canOpenListing), and `figures` is the page's Pro rule for its
// economics. Someone who can't see the listing learns nothing; someone who can but has no figures is told it's Pro.
export function scheduleDownload(ask: {
  visible: boolean;
  opens: boolean;
  figures: boolean;
  listing: { id: string; notes: DownloadLoan[] };
  noteId: string | null;
  now?: Date;
}): DownloadAnswer {
  if (!ask.visible) return { status: 404, body: "Not found." };
  if (!ask.figures) return { status: 403, body: "Payment schedules are part of Pro." };
  if (!ask.opens) return { status: 404, body: "Not found." };
  const index = ask.noteId ? ask.listing.notes.findIndex((note) => note.id === ask.noteId) : 0;
  const loan = index >= 0 ? ask.listing.notes[index] : undefined;
  if (!loan) return { status: 404, body: "No such loan on this listing." };
  const schedule = noteSchedule(loan, { now: ask.now });
  if (!schedule.ok) return { status: 422, body: schedule.reason };
  const count = ask.listing.notes.length;
  return {
    status: 200,
    body: scheduleCsv({ listingId: ask.listing.id, position: index + 1, count, loan, schedule }),
    filename: `schedule-${ask.listing.id.slice(-6)}${count > 1 ? `-loan-${index + 1}` : ""}.csv`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The portfolio's next twelve months: scheduled P&I across the holdings still held, at each holder's share.

export type ForecastLoan = ScheduleLoan & { paymentStatus: string };

export type ForecastHolding = {
  id: string;
  // False once sold or marked resolved, so a note that is gone adds nothing and isn't counted as left out.
  active: boolean;
  // The holder's part of the loans: 1 for a whole note, 0.25 for a quarter seat.
  share: number;
  // The loans behind the holding. None for a note added by hand.
  loans: ForecastLoan[];
};

export type Forecast = {
  months: { start: Date; amount: number }[];
  total: number;
  // Active holdings with at least one loan scheduled.
  included: number;
  // Active holdings with no loan that can be scheduled: no loan on file, or no rate, P&I or maturity to work from.
  leftOut: number;
  // Active holdings whose only loans were non-performing on the tape.
  nonPerforming: number;
  // Loans that couldn't be scheduled inside holdings that were included, as a pool with one loan short of data.
  loansLeftOut: number;
  // Sold or resolved.
  inactive: number;
};

// The twelve calendar months from the first of next month, so a month part gone isn't shown short.
export function paymentForecast(holdings: ForecastHolding[], now = new Date(), months = 12): Forecast {
  const starts = Array.from({ length: months }, (_, index) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1 + index, 1)));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1 + months, 0));
  const firstKey = dayKey(starts[0]);
  const sums = starts.map(() => 0);
  const out: Forecast = { months: [], total: 0, included: 0, leftOut: 0, nonPerforming: 0, loansLeftOut: 0, inactive: 0 };
  for (const holding of holdings) {
    if (!holding.active) {
      out.inactive += 1;
      continue;
    }
    const share = Number.isFinite(holding.share) ? Math.min(1, Math.max(0, holding.share)) : 1;
    let scheduled = 0;
    let skipped = 0;
    for (const loan of holding.loans) {
      const setup = loan.paymentStatus === "NON_PERFORMING" ? null : plan(loan, now);
      if (!setup?.ok) {
        skipped += 1;
        continue;
      }
      scheduled += 1;
      for (const row of walk(setup, MAX_PAYMENTS, last).rows) {
        if (dayKey(row.date) < firstKey) continue;
        const index = (row.date.getUTCFullYear() - starts[0].getUTCFullYear()) * 12 + row.date.getUTCMonth() - starts[0].getUTCMonth();
        if (index >= 0 && index < months) sums[index] += Math.round(Math.round(row.payment * 100) * share);
      }
    }
    if (scheduled) {
      out.included += 1;
      out.loansLeftOut += skipped;
    } else if (holding.loans.length && holding.loans.every((loan) => loan.paymentStatus === "NON_PERFORMING")) {
      out.nonPerforming += 1;
    } else {
      out.leftOut += 1;
    }
  }
  out.months = starts.map((start, index) => ({ start, amount: sums[index] / 100 }));
  out.total = sums.reduce((sum, value) => sum + value, 0) / 100;
  return out;
}
