import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { forecastHoldings, leftOutLine, PaymentSchedule } from "../components/payment-schedule";
import { canOpenListing } from "../lib/access";
import {
  MAX_PAYMENTS,
  NON_PERFORMING_LINE,
  noteSchedule,
  paymentForecast,
  paymentSchedule,
  SCHEDULE_CAVEAT,
  scheduleByYear,
  scheduleDownload,
  type DownloadLoan,
  type ForecastHolding,
  type Schedule,
  type ScheduleLoan,
} from "../lib/amortization";
import { prisma } from "../lib/prisma";
import { isPro } from "../lib/settings";

// The app compiles JSX with Next. Under tsx a component's JSX reads React from the global scope.
(globalThis as { React?: typeof React }).React = React;

const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const NOW = day("2026-11-27");
const cents = (value: number) => Math.round(value * 100);

function schedule(loan: ScheduleLoan, options: { now?: Date; cap?: number } = {}): Schedule {
  const result = paymentSchedule(loan, { now: NOW, ...options });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result;
}

// Every row's payment is its interest and principal to the cent, the balance falls by the principal exactly, and the
// principal adds up to the starting balance.
function assertExact(result: Schedule, upb: number) {
  let balance = cents(upb);
  for (const row of result.rows) {
    for (const value of [row.payment, row.interest, row.principal, row.balance]) assert.equal(cents(value) / 100, value, `${value} has more than two places`);
    assert.equal(cents(row.payment), cents(row.interest) + cents(row.principal), `payment ${row.number}`);
    balance -= cents(row.principal);
    assert.equal(cents(row.balance), balance, `balance after ${row.number}`);
  }
  assert.equal(cents(result.totals.principal) + cents(result.totals.balanceLeft), cents(upb));
}

// ---------------------------------------------------------------------------------------------------------------
// The schedule

test("a 30-year loan at 6% follows the textbook schedule: $1,000 interest first, the balance reaching zero on time", () => {
  const loan = { upb: 200000, interestRate: 6, monthlyPi: 1199.1, maturityDate: day("2056-11-01"), nextDueDate: day("2026-12-01") };
  const result = schedule(loan);
  assert.equal(result.rows.length, 360);
  assert.deepEqual(result.rows[0], { number: 1, date: day("2026-12-01"), payment: 1199.1, interest: 1000, principal: 199.1, balance: 199800.9 });
  assert.equal(result.rows[1].interest, 999);
  assert.equal(result.rows[1].principal, 200.1);
  assert.deepEqual(result.rows[2].date, day("2027-02-01"));
  // The balance after a year, against the closed form B(1+r)^n - P((1+r)^n - 1)/r, within cents of rounding.
  const growth = 1.005 ** 12;
  const closed = 200000 * growth - 1199.1 * ((growth - 1) / 0.005);
  assert.ok(Math.abs(result.rows[11].balance - closed) < 0.05, `${result.rows[11].balance} against ${closed}`);
  const final = result.rows[359];
  assert.equal(final.balance, 0);
  assert.deepEqual(final.date, day("2056-11-01"));
  // The P&I is rounded to the cent, so the last payment differs by a dollar or so: rounding, not a balloon.
  assert.ok(Math.abs(final.payment - 1199.1) < 3);
  assert.equal(result.balloon, null);
  assert.equal(result.paidOffEarly, false);
  assert.equal(result.termDerived, false);
  assert.equal(result.totals.principal, 200000);
  assert.ok(Math.abs(result.totals.interest - 231676.38) < 2, String(result.totals.interest));
  assert.deepEqual(result.totals.payoffDate, day("2056-11-01"));
  assertExact(result, 200000);
  // Years: one payment in 2026, twelve in 2027, the last year ending at zero, and the years adding to the totals.
  const years = scheduleByYear(result.rows);
  assert.deepEqual(years.slice(0, 2).map((year) => [year.year, year.payments]), [[2026, 1], [2027, 12]]);
  assert.equal(years[0].interest, 1000);
  assert.equal(years[1].balance, result.rows[12].balance);
  assert.equal(years[years.length - 1].balance, 0);
  assert.equal(years.reduce((sum, year) => sum + cents(year.interest), 0), cents(result.totals.interest));
  assert.deepEqual(result.lines, ["Starts at the next due date on the tape, Dec 1, 2026."]);
});

test("a P&I that doesn't amortize by the balloon date ends in a balloon on that date", () => {
  const loan = { upb: 100000, interestRate: 7, monthlyPi: 665.3, maturityDate: day("2056-12-01"), balloonDate: day("2033-11-01"), nextDueDate: day("2026-12-01"), paymentType: "BALLOON" };
  const result = schedule(loan);
  assert.equal(result.rows.length, 84);
  assert.deepEqual(result.dueBy, day("2033-11-01"));
  assert.ok(result.balloon);
  assert.deepEqual(result.balloon.date, day("2033-11-01"));
  const before = result.rows[82];
  assert.equal(result.balloon.amount, result.rows[83].payment);
  assert.equal(cents(result.balloon.amount), cents(before.balance) + cents(result.rows[83].interest));
  assert.ok(result.balloon.amount > 90000);
  assert.match(result.lines.join(" "), /balloon of \$91,812\.98/);
  assertExact(result, 100000);
  // A balloon loan without a balloon date falls due at maturity, and the same short P&I leaves the same kind of balloon.
  const atMaturity = schedule({ ...loan, balloonDate: null, maturityDate: day("2031-11-01") });
  assert.equal(atMaturity.rows.length, 60);
  assert.ok(atMaturity.balloon && atMaturity.balloon.amount > 90000);
  assert.match(atMaturity.lines.join(" "), /by the maturity date, Nov 1, 2031/);
});

test("a P&I larger than the loan needs pays it off early and stops at zero", () => {
  const result = schedule({ upb: 50000, interestRate: 5, monthlyPi: 2000, maturityDate: day("2056-12-01"), nextDueDate: day("2026-12-01") });
  assert.equal(result.rows.length, 27);
  assert.equal(result.paidOffEarly, true);
  assert.equal(result.balloon, null);
  const final = result.rows[26];
  assert.equal(final.balance, 0);
  assert.ok(final.payment < 2000);
  assert.deepEqual(result.totals.payoffDate, day("2029-02-01"));
  assert.match(result.lines.join(" "), /pays off on Feb 1, 2029, ahead of the maturity date/);
  assertExact(result, 50000);
});

test("interest-only pays no principal until maturity, then the balance; without a maturity there is no schedule", () => {
  const loan = { upb: 120000, interestRate: 9, monthlyPi: 900, maturityDate: day("2028-11-01"), nextDueDate: day("2026-12-01"), paymentType: "INTEREST_ONLY" };
  const result = schedule(loan);
  assert.equal(result.rows.length, 24);
  assert.equal(result.interestOnly, true);
  for (const row of result.rows.slice(0, 23)) assert.deepEqual([row.payment, row.principal, row.balance], [900, 0, 120000]);
  assert.deepEqual(result.rows[23], { number: 24, date: day("2028-11-01"), payment: 120900, interest: 900, principal: 120000, balance: 0 });
  assert.deepEqual(result.balloon, { date: day("2028-11-01"), amount: 120900 });
  assert.equal(result.totals.interest, 21600);
  assert.match(result.lines.join(" "), /Interest-only/);
  // The interest is worked from the rate, so a missing P&I doesn't matter on an interest-only loan.
  assert.equal(schedule({ ...loan, monthlyPi: 0 }).rows[0].payment, 900);
  const open = paymentSchedule({ ...loan, maturityDate: null }, { now: NOW });
  assert.equal(open.ok, false);
  assert.match(open.ok ? "" : open.reason, /interest-only loan with no maturity date/);
});

test("a zero rate makes every payment principal; a missing rate gives no schedule", () => {
  const result = schedule({ upb: 12000, interestRate: 0, monthlyPi: 500, maturityDate: day("2028-11-01"), nextDueDate: day("2026-12-01") });
  assert.equal(result.rows.length, 24);
  assert.ok(result.rows.every((row) => row.interest === 0 && row.payment === 500));
  assert.equal(result.totals.interest, 0);
  assert.match(result.lines.join(" "), /0% note rate/);
  // A short P&I at zero interest still leaves a balloon at maturity.
  const short = schedule({ upb: 12000, interestRate: 0, monthlyPi: 400, maturityDate: day("2028-11-01"), nextDueDate: day("2026-12-01") });
  assert.deepEqual(short.balloon, { date: day("2028-11-01"), amount: 2800 });
  for (const rate of [null, Number.NaN, -1]) {
    const missing = paymentSchedule({ upb: 12000, interestRate: rate, monthlyPi: 500, maturityDate: day("2028-11-01") }, { now: NOW });
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.reason, /No note rate/);
  }
});

test("without a maturity the term comes from the P&I, and a P&I that never pays down gives a plain reason", () => {
  const result = schedule({ upb: 200000, interestRate: 6, monthlyPi: 1199.1, maturityDate: null, nextDueDate: day("2026-12-01") });
  // The cent the tape's P&I is short of the exact payment leaves $1.05 at the end, which goes with the 360th payment.
  assert.equal(result.rows.length, 360);
  assert.equal(result.termDerived, true);
  assert.equal(result.rows[359].balance, 0);
  assert.equal(result.balloon, null);
  assert.match(result.lines.join(" "), /no maturity date, so the term is worked out from the P&I: 360 payments/);
  assertExact(result, 200000);
  const zero = schedule({ upb: 12000, interestRate: 0, monthlyPi: 500, maturityDate: null, nextDueDate: day("2026-12-01") });
  assert.equal(zero.rows.length, 24);
  const flat = paymentSchedule({ upb: 100000, interestRate: 6, monthlyPi: 500, maturityDate: null }, { now: NOW });
  assert.equal(flat.ok, false);
  assert.match(flat.ok ? "" : flat.reason, /only covers the interest, and there is no maturity date/);
  // Short of a month's interest is refused with or without a maturity, rather than shown growing.
  const short = paymentSchedule({ upb: 100000, interestRate: 6, monthlyPi: 400, maturityDate: day("2040-01-01") }, { now: NOW });
  assert.equal(short.ok, false);
  assert.match(short.ok ? "" : short.reason, /doesn't cover a month's interest at 6\.00%/);
  const noPi = paymentSchedule({ upb: 100000, interestRate: 6, monthlyPi: 0, maturityDate: day("2040-01-01") }, { now: NOW });
  assert.match(noPi.ok ? "" : noPi.reason, /No monthly P&I/);
  const noBalance = paymentSchedule({ upb: 0, interestRate: 6, monthlyPi: 500, maturityDate: day("2040-01-01") }, { now: NOW });
  assert.match(noBalance.ok ? "" : noBalance.reason, /No unpaid balance/);
  const matured = paymentSchedule({ upb: 50000, interestRate: 6, monthlyPi: 500, maturityDate: day("2026-06-01"), nextDueDate: day("2026-12-01") }, { now: NOW });
  assert.match(matured.ok ? "" : matured.reason, /maturity date on the tape, Jun 1, 2026, comes before the next payment due/);
});

test("the schedule stops at 480 payments and says what is still owed", () => {
  // $10 a month of principal on $300,000 runs well past 480 months.
  const result = schedule({ upb: 300000, interestRate: 6, monthlyPi: 1510, maturityDate: null });
  assert.equal(result.rows.length, MAX_PAYMENTS);
  assert.equal(result.capped, true);
  assert.equal(result.totals.payoffDate, null);
  assert.ok(result.totals.balanceLeft > 250000);
  assert.equal(result.rows[MAX_PAYMENTS - 1].balance, result.totals.balanceLeft);
  assert.match(result.lines.join(" "), /Shown to 480 payments/);
  assertExact(result, 300000);
  // A maturity past the cap stops there too, with no balloon claimed for a date it never reached.
  const long = schedule({ upb: 200000, interestRate: 6, monthlyPi: 1199.1, maturityDate: day("2056-11-01"), nextDueDate: day("2026-12-01") }, { cap: 12 });
  assert.equal(long.rows.length, 12);
  assert.equal(long.capped, true);
  assert.equal(long.balloon, null);
});

test("cents stay exact on awkward figures, and the first payment falls back from the next due date", () => {
  const loan = { upb: 123456.78, interestRate: 7.125, monthlyPi: 950, maturityDate: day("2047-03-31"), nextDueDate: day("2027-01-31") };
  const result = schedule(loan);
  assertExact(result, 123456.78);
  // A due day of the 31st is held to the month's end and comes back: Jan 31, Feb 28, Mar 31.
  assert.deepEqual(result.rows.slice(0, 3).map((row) => row.date), [day("2027-01-31"), day("2027-02-28"), day("2027-03-31")]);
  assert.deepEqual(result.rows[result.rows.length - 1].date, day("2047-03-31"));
  // No next due date: the first due day after the last paid date, on the maturity's day of the month.
  const paid = schedule({ ...loan, nextDueDate: null, lastPaidDate: day("2026-11-30") });
  assert.equal(paid.start, "last-paid");
  assert.deepEqual(paid.firstDue, day("2026-12-31"));
  assert.doesNotMatch(paid.lines[0], /has passed/);
  // A tape last paid long ago starts before today, and the line says the balance may since have come down.
  const oldTape = schedule({ ...loan, nextDueDate: null, lastPaidDate: day("2025-08-01") });
  assert.equal(oldTape.start, "last-paid");
  assert.match(oldTape.lines[0], /That date has passed, so the first payments shown fall before today, and any paid since then would have lowered the balance\./);
  // Neither: the first due day from today.
  const neither = schedule({ ...loan, nextDueDate: null, maturityDate: day("2047-03-01") });
  assert.equal(neither.start, "assumed");
  assert.deepEqual(neither.firstDue, day("2026-12-01"));
  assert.match(neither.lines[0], /no next due or last paid date/);
  // A next due date already past is kept, and the line says so.
  const stale = schedule({ ...loan, nextDueDate: day("2026-09-30") });
  assert.match(stale.lines[0], /That date has passed/);
  assert.deepEqual(stale.rows[0].date, day("2026-09-30"));
});

// ---------------------------------------------------------------------------------------------------------------
// The listing page and its download

const loanOf = (id: string, extra: Partial<DownloadLoan> = {}): DownloadLoan & { streetAddress: string; borrowerName: string; loanNumber: string } => ({
  id,
  city: "Tampa",
  state: "FL",
  paymentStatus: "PERFORMING",
  upb: 200000,
  interestRate: 6,
  monthlyPi: 1199.1,
  maturityDate: day("2056-11-01"),
  nextDueDate: day("2026-12-01"),
  lastPaidDate: day("2026-11-01"),
  balloonDate: null,
  paymentType: "FIXED",
  streetAddress: `12 Schedule Street ${tag}`,
  borrowerName: `Borrower ${tag}`,
  loanNumber: `LN-${tag}`,
  ...extra,
});

test("a non-performing loan gets the reason, not a schedule", () => {
  const result = noteSchedule(loanOf("npl", { paymentStatus: "NON_PERFORMING" }), { now: NOW });
  assert.deepEqual(result, { ok: false, reason: NON_PERFORMING_LINE });
  assert.equal(noteSchedule(loanOf("sub", { paymentStatus: "SUB_PERFORMING" }), { now: NOW }).ok, true);
});

test("the schedule CSV: refused without the listing's figures, and never carries the borrower, street or loan number", () => {
  const listing = { id: `listing${tag}`, notes: [loanOf("a"), loanOf("b", { paymentStatus: "NON_PERFORMING" }), loanOf("c", { monthlyPi: 0 })] };
  const ask = { visible: true, opens: true, figures: true, listing, noteId: null, now: NOW };
  assert.equal(scheduleDownload({ ...ask, visible: false }).status, 404);
  assert.deepEqual(scheduleDownload({ ...ask, figures: false }), { status: 403, body: "Payment schedules are part of Pro." });
  // Hidden listings learn nothing, even for a viewer without Pro.
  assert.equal(scheduleDownload({ ...ask, visible: false, figures: false }).status, 404);
  assert.equal(scheduleDownload({ ...ask, opens: false }).status, 404);
  assert.equal(scheduleDownload({ ...ask, noteId: "nope" }).status, 404);
  assert.deepEqual(scheduleDownload({ ...ask, noteId: "b" }), { status: 422, body: NON_PERFORMING_LINE });
  assert.match(scheduleDownload({ ...ask, noteId: "c" }).body, /No monthly P&I/);

  const served = scheduleDownload(ask);
  assert.equal(served.status, 200);
  assert.equal(served.filename, `schedule-${listing.id.slice(-6)}-loan-1.csv`);
  for (const secret of [`12 Schedule Street ${tag}`, `Borrower ${tag}`, `LN-${tag}`, "Schedule Street", "Borrower"]) assert.ok(!served.body.includes(secret), secret);
  const [summary, rows] = served.body.trim().split("\n\n");
  assert.match(summary, /^field,value\n/);
  assert.match(summary, /loan,Loan 1 of 3/);
  assert.match(summary, /location,"Tampa, FL"/);
  assert.match(summary, /payments_left,360/);
  assert.ok(summary.includes(SCHEDULE_CAVEAT));
  const lines = rows.split("\n");
  assert.equal(lines[0], "payment_number,date,payment,interest,principal,balance_after");
  assert.equal(lines[1], "1,2026-12-01,1199.10,1000.00,199.10,199800.90");
  assert.equal(lines.length, 361);
  assert.match(lines[360], /^360,2056-11-01,.*,0\.00$/);
});

test("the CSV route's inputs, built as the route builds them: Pro and an open listing, or nothing", () => {
  const listing = { id: `listing${tag}`, status: "APPROVED" as const, approvedAt: day("2026-10-01"), sellerId: "seller", brokerId: null, launchAt: null as Date | null };
  const viewer = (role: "BUYER" | "ADMIN" | "INSTITUTIONAL_SELLER", tier: "FREE" | "PRO", id: string = role) => ({
    id,
    role,
    accountStatus: "APPROVED" as const,
    subscriptionTier: tier,
    subscriptionStatus: "ACTIVE" as const,
    subscriptionCurrentPeriodEnd: null,
    trialEndsAt: null,
  });
  const answer = (who: ReturnType<typeof viewer>, on = listing) => scheduleDownload({
    visible: true,
    opens: canOpenListing({ viewer: who, status: on.status, approvedAt: on.approvedAt, earlyAccessHours: 48, openableIds: new Set(), listingId: on.id, sellerId: on.sellerId, brokerId: on.brokerId, launchAt: on.launchAt, now: NOW }).ok,
    figures: who.role === "ADMIN" || isPro(who, NOW),
    listing: { id: on.id, notes: [loanOf("a")] },
    noteId: null,
    now: NOW,
  }).status;
  assert.equal(answer(viewer("BUYER", "FREE")), 403);
  assert.equal(answer(viewer("BUYER", "PRO")), 200);
  assert.equal(answer(viewer("ADMIN", "FREE")), 200);
  // The seller's own listing page shows no Pro figures, so neither does the download.
  assert.equal(answer(viewer("INSTITUTIONAL_SELLER", "FREE", "seller")), 403);
  // A coming-soon listing holds even a Pro buyer, as the page does.
  assert.equal(answer(viewer("BUYER", "PRO"), { ...listing, launchAt: new Date(Date.now() + 86400000) }), 404);
});

test("the listing's section: the next twelve payments, the years, the totals and the caveat; a pool picks a loan", () => {
  const html = (selected: string | null, notes = [loanOf("a"), loanOf("b", { paymentStatus: "NON_PERFORMING" })]) =>
    renderToStaticMarkup(createElement(PaymentSchedule, { listingId: "L1", notes, forSale: notes.map((note) => note.id), selected, now: NOW }));
  const first = html(null);
  assert.match(first, /Payment schedule/);
  assert.match(first, /The next 12 payments/);
  assert.match(first, /Year by year, 2026 to 2056/);
  assert.match(first, /\$1,199\.10/);
  assert.match(first, /name="schedule"/);
  assert.match(first, /\/api\/listings\/L1\/schedule\?loan=a/);
  assert.ok(first.includes("Assumes every payment arrives as scheduled."));
  assert.ok(!first.includes("Schedule Street") && !first.includes("Borrower"));
  const npl = html("b");
  assert.ok(npl.includes("No payment schedule for a non-performing loan."));
  assert.ok(!npl.includes("Download the full monthly schedule"));
  // A single note has no picker.
  assert.doesNotMatch(html(null, [loanOf("a")]), /name="schedule"/);
});

// ---------------------------------------------------------------------------------------------------------------
// The portfolio forecast

const forecastLoan = (extra: Partial<ScheduleLoan & { paymentStatus: string }> = {}) => ({
  upb: 100000,
  interestRate: 6,
  monthlyPi: 1000,
  maturityDate: day("2040-01-01"),
  nextDueDate: day("2026-11-01"),
  lastPaidDate: null,
  balloonDate: null,
  paymentType: "FIXED",
  paymentStatus: "PERFORMING",
  ...extra,
});

test("the forecast sums scheduled P&I by month at each share, and counts what it leaves out", () => {
  // A note whose balance falls due in March 2027, so the months change partway.
  const shortLoan = forecastLoan({ maturityDate: day("2027-03-01") });
  const holdings: ForecastHolding[] = [
    { id: "whole", active: true, share: 1, loans: [shortLoan] },
    { id: "quarter-pool", active: true, share: 0.25, loans: [forecastLoan({ monthlyPi: 2000, upb: 200000 }), forecastLoan({ maturityDate: null, monthlyPi: 0 })] },
    { id: "by-hand", active: true, share: 1, loans: [] },
    { id: "missing", active: true, share: 1, loans: [forecastLoan({ interestRate: null })] },
    { id: "npl", active: true, share: 1, loans: [forecastLoan({ paymentStatus: "NON_PERFORMING" })] },
    { id: "sold", active: false, share: 1, loans: [forecastLoan({ monthlyPi: 99999 })] },
  ];
  const forecast = paymentForecast(holdings, NOW);
  assert.equal(forecast.months.length, 12);
  assert.deepEqual(forecast.months[0].start, day("2026-12-01"));
  assert.deepEqual(forecast.months[11].start, day("2027-11-01"));
  const balloon = schedule(shortLoan).rows.find((row) => row.date.getTime() === day("2027-03-01").getTime());
  assert.ok(balloon);
  // November's payment falls before the window. December to February: $1,000 and a quarter of $2,000.
  assert.deepEqual(forecast.months.slice(0, 3).map((month) => month.amount), [1500, 1500, 1500]);
  assert.equal(forecast.months[3].amount, (cents(balloon.payment) + 50000) / 100);
  assert.deepEqual(forecast.months.slice(4).map((month) => month.amount), Array(8).fill(500));
  assert.equal(cents(forecast.total), forecast.months.reduce((sum, month) => sum + cents(month.amount), 0));
  assert.deepEqual(
    { included: forecast.included, leftOut: forecast.leftOut, nonPerforming: forecast.nonPerforming, loansLeftOut: forecast.loansLeftOut, inactive: forecast.inactive },
    { included: 2, leftOut: 2, nonPerforming: 1, loansLeftOut: 1, inactive: 1 },
  );
  assert.equal(
    leftOutLine(forecast),
    "Left out: 2 holdings without the loan terms a schedule needs: a note added by hand has none on file, and a loan can lack its rate, P&I or maturity; 1 holding non-performing on the tape; 1 loan inside a pool you hold, for the same reasons.",
  );
  assert.equal(leftOutLine({ leftOut: 0, nonPerforming: 0, loansLeftOut: 0 }), null);
});

test("the forecast reads each holding's own loans: a closing's loans, a listing's, none by hand, nothing once resolved", async () => {
  const userIds: string[] = [];
  const listingIds: string[] = [];
  try {
    const buyer = await prisma.user.create({ data: { email: `amortization-${tag}@example.org`, name: `Amortization ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
    userIds.push(buyer.id);
    const note = (extra: Record<string, unknown>) => ({
      streetAddress: `1 Forecast Way ${tag}`, city: "Ocala", state: "FL", zip: "34470", propertyType: "SFR", lienPosition: "FIRST",
      estimatedValue: 150000, upb: 100000, interestRate: 6, monthlyPi: 1000, paymentStatus: "PERFORMING", askingPrice: 80000,
      maturityDate: day("2040-01-01"), nextDueDate: day("2026-12-01"), ...extra,
    });
    // Off the book, so no other test's listing reads see them.
    const pool = await prisma.listing.create({
      data: { kind: "POOL", sellerId: buyer.id, status: "WITHDRAWN", title: `Forecast pool ${tag}`, notes: { create: [note({ monthlyPi: 1000 }), note({ monthlyPi: 3000 })] as never } },
      include: { notes: true },
    });
    const single = await prisma.listing.create({
      data: { kind: "SINGLE", sellerId: buyer.id, status: "WITHDRAWN", title: `Forecast single ${tag}`, notes: { create: [note({ monthlyPi: 700 })] as never } },
    });
    listingIds.push(pool.id, single.id);
    const kept = pool.notes.find((row) => row.monthlyPi === 3000);
    assert.ok(kept);
    const closing = await prisma.closing.create({
      data: { listingId: pool.id, status: "CANCELED", salePrice: 1, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 0, netToSellerCents: 0, noteIds: [kept.id] },
    });
    const holding = (title: string, extra: { listingId?: string; closingId?: string; sharePercent?: number; status?: "RESOLVED" }) =>
      prisma.buyerHolding.create({ data: { userId: buyer.id, title: `${title} ${tag}`, costBasis: 1000, upb: 1000, acquiredAt: day("2026-01-01"), ...extra } });
    const fromClosing = await holding("closing", { listingId: pool.id, closingId: closing.id, sharePercent: 50 });
    const fromListing = await holding("listing", { listingId: single.id });
    const byHand = await holding("by hand", {});
    const resolved = await holding("resolved", { listingId: single.id, status: "RESOLVED" });
    const relisted = await holding("sold", { listingId: single.id });
    const rows = [fromClosing, fromListing, byHand, resolved, relisted].map((row) => ({
      id: row.id,
      status: row.status,
      sharePercent: row.sharePercent,
      proceeds: row.id === relisted.id ? [{ amount: 1, on: NOW, listingId: "x" }] : [],
    }));
    const input = await forecastHoldings(buyer.id, rows);
    const of = (id: string) => input.find((row) => row.id === id);
    // The closing names one loan of the pool, at the seat's half.
    assert.deepEqual(of(fromClosing.id)?.loans.map((loan) => loan.monthlyPi), [3000]);
    assert.equal(of(fromClosing.id)?.share, 0.5);
    assert.deepEqual(of(fromListing.id)?.loans.map((loan) => loan.monthlyPi), [700]);
    assert.equal(of(fromListing.id)?.share, 1);
    assert.deepEqual(of(byHand.id)?.loans, []);
    assert.equal(of(resolved.id)?.active, false);
    assert.equal(of(relisted.id)?.active, false);
    const forecast = paymentForecast(input, NOW);
    assert.equal(forecast.months[0].amount, 1500 + 700);
    assert.deepEqual([forecast.included, forecast.leftOut, forecast.inactive], [2, 1, 2]);
  } finally {
    await prisma.buyerHolding.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.closing.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});
