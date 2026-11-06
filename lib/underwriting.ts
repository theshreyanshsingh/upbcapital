import { foreclosureFor, foreclosureProgress, MIN_MONTHS_LEFT, monthsSince, type ForeclosureProgress, type ForeclosureRule } from "@/lib/foreclosure";
import { prettyDate } from "@/lib/format";

export type ArmReset = { month: number; annualRate: number };

export type CashFlowInput = {
  bid: number;
  upb: number;
  annualRate: number;
  monthlyPi: number;
  termMonths: number;
  balloonMonth?: number | null;
  armResets?: ArmReset[];
  missedMonths?: number[];
};

export function projectFlows(input: CashFlowInput) {
  const flows: number[] = [-input.bid];
  let annual = input.annualRate;
  let balance = Math.max(input.upb, 0);
  const term = Math.max(1, Math.min(Math.round(input.termMonths) || 1, 480));
  const balloon = input.balloonMonth && input.balloonMonth > 0 ? Math.min(term, Math.round(input.balloonMonth)) : null;
  const missed = new Set((input.missedMonths ?? []).map((month) => Math.round(month)));
  const resets = [...(input.armResets ?? [])].filter((row) => row.month > 0).sort((a, b) => a.month - b.month);
  const horizon = balloon ?? term;
  for (let month = 1; month <= horizon && balance > 1; month += 1) {
    const reset = resets.find((row) => row.month === month);
    if (reset && Number.isFinite(reset.annualRate)) annual = reset.annualRate;
    const interest = balance * (annual / 100 / 12);
    const payoff = balance + interest;
    const last = month === horizon || input.monthlyPi + 0.01 >= payoff;
    if (missed.has(month) && !last) {
      balance += interest;
      flows.push(0);
      continue;
    }
    if (last) {
      flows.push(payoff);
      break;
    }
    balance = Math.max(0, balance - (input.monthlyPi - interest));
    flows.push(input.monthlyPi);
  }
  return flows;
}

export function monthlyIrr(flows: number[]) {
  if (flows.length < 2) return null;
  let rate = 0.01;
  for (let step = 0; step < 60; step += 1) {
    let npv = 0;
    let derivative = 0;
    for (let t = 0; t < flows.length; t += 1) {
      const discount = (1 + rate) ** t;
      npv += flows[t] / discount;
      if (t > 0) derivative -= (t * flows[t]) / (1 + rate) ** (t + 1);
    }
    if (!Number.isFinite(npv) || Math.abs(derivative) < 1e-10) return null;
    const next = rate - npv / derivative;
    if (!Number.isFinite(next) || next <= -0.99) return null;
    if (Math.abs(next - rate) < 1e-8) return next;
    rate = next;
  }
  return rate;
}

export function annualize(monthly: number | null) {
  if (monthly == null) return null;
  return ((1 + monthly) ** 12 - 1) * 100;
}

export function performingCase(input: CashFlowInput) {
  const flows = projectFlows(input);
  const yieldPct = input.bid > 0 ? ((input.monthlyPi * 12) / input.bid) * 100 : null;
  const paybackMonths = input.monthlyPi > 0 ? input.bid / input.monthlyPi : null;
  return {
    flows,
    yieldPct,
    cashOnCash: yieldPct,
    irrPct: annualize(monthlyIrr(flows)),
    paybackMonths,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cash-flow helpers shared by the scenario model and the solver.

export function monthlyRate(annualPct: number) {
  return (1 + annualPct / 100) ** (1 / 12) - 1;
}

export function npv(flows: number[], rate: number) {
  let total = 0;
  for (let t = 0; t < flows.length; t += 1) total += flows[t] / (1 + rate) ** t;
  return total;
}

// Annual IRR of any flow vector. Newton first, then bisection when Newton stalls, which mixed carry and recovery
// flows can do. A vector that never returns cash is a total loss.
export function irrPct(flows: number[]) {
  if (flows.length < 2) return null;
  if (!flows.some((flow, t) => t > 0 && flow > 0)) return -100;
  const quick = monthlyIrr(flows);
  const scale = flows.reduce((sum, flow) => sum + Math.abs(flow), 0);
  if (quick != null && Number.isFinite(quick) && Math.abs(npv(flows, quick)) <= scale * 1e-7) return annualize(quick);
  let low = -0.5;
  let high = 1;
  let atLow = npv(flows, low);
  if (!Number.isFinite(atLow) || atLow * npv(flows, high) > 0) return quick == null ? null : annualize(quick);
  for (let step = 0; step < 200 && high - low > 1e-10; step += 1) {
    const mid = (low + high) / 2;
    const atMid = npv(flows, mid);
    if (atMid * atLow > 0) {
      low = mid;
      atLow = atMid;
    } else {
      high = mid;
    }
  }
  return annualize((low + high) / 2);
}

// What the buyer actually wires: the bid, the buyer premium on it, and closing costs. Both optional, so a figure
// without them says so on the page.
export type PricingCosts = { premiumBps?: number | null; closingCost?: number | null };

export function cashIn(bid: number, costs: PricingCosts = {}) {
  return bid * (1 + Math.max(0, costs.premiumBps ?? 0) / 10000) + Math.max(0, costs.closingCost ?? 0);
}

function withCashIn(flows: number[], bid: number, costs: PricingCosts) {
  return [-cashIn(bid, costs), ...flows.slice(1)];
}

// The bid at which the flows return the target annual IRR. Bisection on NPV at the target rate, since NPV falls as
// the bid rises; it needs nothing from the flows but that they come from a function of the bid. Null when no
// positive bid reaches the target.
export function solveBid(flowsAt: (bid: number) => number[], targetAnnualPct: number, ceiling: number) {
  if (!Number.isFinite(targetAnnualPct) || targetAnnualPct <= -100 || !(ceiling > 0)) return null;
  const rate = monthlyRate(targetAnnualPct);
  const value = (bid: number) => npv(flowsAt(bid), rate);
  // Written so a NaN from a broken input reads as no price rather than a price near zero.
  if (!(value(0) > 0)) return null;
  let low = 0;
  let high = ceiling;
  for (let grow = 0; grow < 20 && value(high) > 0; grow += 1) high *= 2;
  if (value(high) > 0) return null;
  for (let step = 0; step < 200 && high - low > 0.005; step += 1) {
    const mid = (low + high) / 2;
    if (value(mid) > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

// Weighted quantiles over discrete outcomes, for the 10th-to-90th range and the dotplot.
export type Weighted = { value: number; weight: number };

export function weightedQuantile(points: Weighted[], p: number) {
  const rows = points.filter((row) => Number.isFinite(row.value) && row.weight > 0).sort((a, b) => a.value - b.value);
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!rows.length || total <= 0) return null;
  let seen = 0;
  for (const row of rows) {
    seen += row.weight / total;
    if (seen >= p - 1e-9) return row.value;
  }
  return rows[rows.length - 1].value;
}

// A quantile dotplot: each dot is a 1-in-n outcome, read off the weighted distribution at (i + 0.5) / n.
export function quantileDots(points: Weighted[], count = 20) {
  const dots: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = weightedQuantile(points, (index + 0.5) / count);
    if (value != null) dots.push(value);
  }
  return dots;
}

export type Spread = { p10: number; p50: number; p90: number };

function spreadOf(points: Weighted[]): Spread | null {
  const p10 = weightedQuantile(points, 0.1);
  const p50 = weightedQuantile(points, 0.5);
  const p90 = weightedQuantile(points, 0.9);
  return p10 == null || p50 == null || p90 == null ? null : { p10, p50, p90 };
}

// ---------------------------------------------------------------------------------------------------------------
// Non-performing resolutions.

export type ScenarioKey = "reinstatement" | "modification" | "short_sale" | "deed" | "foreclosure";
export const SCENARIO_KEYS: ScenarioKey[] = ["reinstatement", "modification", "short_sale", "deed", "foreclosure"];
const SCENARIO_LABELS: Record<ScenarioKey, string> = {
  reinstatement: "Reinstatement",
  modification: "Loan modification",
  short_sale: "Payoff or short sale",
  deed: "Deed in lieu",
  foreclosure: "Foreclosure to REO",
};

type OccupancyKey = "OWNER_OCCUPIED" | "TENANT" | "VACANT" | "UNKNOWN";
type Mix = Record<ScenarioKey, number>;

// How a non-performing loan resolves, by who lives there and where the lien sits. Desk assumptions that follow the
// mix NPL buyers describe (owners cure and modify more, vacant houses go to REO, a junior lien settles or is wiped
// out more often than it forecloses), not a model fitted to UPB's own closings. Each row sums to 1.
export const FIRST_LIEN_MIX: Record<OccupancyKey, Mix> = {
  OWNER_OCCUPIED: { reinstatement: 0.2, modification: 0.3, short_sale: 0.15, deed: 0.05, foreclosure: 0.3 },
  TENANT: { reinstatement: 0.15, modification: 0.15, short_sale: 0.2, deed: 0.05, foreclosure: 0.45 },
  VACANT: { reinstatement: 0.05, modification: 0.05, short_sale: 0.15, deed: 0.1, foreclosure: 0.65 },
  UNKNOWN: { reinstatement: 0.15, modification: 0.2, short_sale: 0.15, deed: 0.05, foreclosure: 0.45 },
};
export const JUNIOR_LIEN_MIX: Record<OccupancyKey, Mix> = {
  OWNER_OCCUPIED: { reinstatement: 0.25, modification: 0.25, short_sale: 0.25, deed: 0.02, foreclosure: 0.23 },
  TENANT: { reinstatement: 0.2, modification: 0.15, short_sale: 0.3, deed: 0.02, foreclosure: 0.33 },
  VACANT: { reinstatement: 0.05, modification: 0.05, short_sale: 0.3, deed: 0.02, foreclosure: 0.58 },
  UNKNOWN: { reinstatement: 0.18, modification: 0.17, short_sale: 0.28, deed: 0.02, foreclosure: 0.35 },
};

// The longer a borrower is behind, the less often they cure: the reinstatement weight is scaled, then the mix is
// renormalised.
function cureFactor(monthsDelinquent: number) {
  if (monthsDelinquent <= 3) return 1.5;
  if (monthsDelinquent < 12) return 1;
  if (monthsDelinquent < 24) return 0.6;
  return 0.35;
}

function occupancyKey(value: string | null | undefined): OccupancyKey {
  return value === "OWNER_OCCUPIED" || value === "TENANT" || value === "VACANT" ? value : "UNKNOWN";
}

function isJunior(lien: string | null | undefined) {
  return lien === "SECOND" || lien === "THIRD" || lien === "OTHER";
}

const OCCUPANCY_WORDS: Record<OccupancyKey, string> = {
  OWNER_OCCUPIED: "Owner-occupied",
  TENANT: "Tenant-occupied",
  VACANT: "Vacant",
  UNKNOWN: "Occupancy unknown",
};

export function scenarioWeights(input: { occupancy?: string | null; lienPosition?: string | null; monthsDelinquent?: number | null }) {
  const occupancy = occupancyKey(input.occupancy);
  const junior = isJunior(input.lienPosition);
  const behind = Math.max(0, Math.round(input.monthsDelinquent ?? 0));
  const base = (junior ? JUNIOR_LIEN_MIX : FIRST_LIEN_MIX)[occupancy];
  const scaled = { ...base, reinstatement: base.reinstatement * cureFactor(behind) };
  const total = SCENARIO_KEYS.reduce((sum, key) => sum + scaled[key], 0);
  const weights = Object.fromEntries(SCENARIO_KEYS.map((key) => [key, scaled[key] / total])) as Mix;
  const lien = junior ? "junior lien" : "first lien";
  return {
    weights,
    basis: `${OCCUPANCY_WORDS[occupancy]} ${lien}, ${behind} month${behind === 1 ? "" : "s"} behind. Desk weights, not a fitted model.`,
  };
}

// Every number the resolution model leans on, so a page can state them.
export const NPL_ASSUMPTIONS = {
  // Taxes and insurance a first-lien holder advances, a year, as a share of value.
  carryRate: 0.02,
  // Special servicing, a month.
  servicingMonthly: 100,
  // The new servicer boards the loan and sends the demand letter.
  boardingMonths: 2,
  // No first filing before the borrower is 120 days behind (12 CFR 1024.41(f)).
  filingAfterMonths: 4,
  // The borrower cures within six months, usually once the filing lands, and pays everything past due.
  reinstateMonths: 6,
  reinstateCost: 2500,
  // A cured loan sells at 85% of the lower of UPB and value.
  reperformingMark: 0.85,
  // Three trial months and six seasoning months at 80% of the old payment, then a sale at 70%.
  modTrialStart: 4,
  modMonths: 12,
  modPayment: 0.8,
  modifiedMark: 0.7,
  modCost: 4500,
  // A payoff or short sale nets 80% of value after the borrower's sale costs, about halfway through the foreclosure.
  shortSaleRecovery: 0.8,
  shortSaleCost: 3500,
  // A deed in lieu: title in six months, then the REO sells at 85% of value.
  deedMonths: 6,
  deedRecovery: 0.85,
  deedCost: 5000,
  // After a foreclosure the REO sells at 75% of value, after eviction if anyone lives there.
  reoRecovery: 0.75,
  reoMonths: 4,
  evictionMonths: 2,
  evictionCost: 2500,
  // Agent, transfer and closing costs on an REO sale.
  saleCost: 0.08,
  // A junior with no equity still collects about 8% of UPB to release its lien in a short sale.
  juniorRelease: 0.08,
  // A senior lien, when its balance is unknown, is taken as 70% of value.
  seniorShare: 0.7,
  // A junior with no equity stops servicing after six months and is wiped out when the senior forecloses.
  chargeOffMonths: 6,
};

// Slower and lower, as modelled, and faster and higher: the spread around each resolution.
export const VARIANTS = [
  { key: "slow", label: "slower, lower value", weight: 0.25, time: 1.35, value: 0.9 },
  { key: "base", label: "as modelled", weight: 0.5, time: 1, value: 1 },
  { key: "fast", label: "faster, higher value", weight: 0.25, time: 0.75, value: 1.05 },
] as const;

export type Resolution = {
  key: string;
  label: string;
  months: number;
  // Everything paid out after purchase: process costs and carry.
  cost: number;
  // Everything received: payments, net sale or settlement proceeds, and the exit mark.
  recovery: number;
  net: number;
  profit: number;
  // Simple annualised return on the bid, kept for older callers.
  annualized: number | null;
  note: string;
  weight: number;
  // Annual IRR on the monthly flows, including carry.
  irrPct: number | null;
  flows: number[];
};

export function annualizedReturn(profit: number, bid: number, months: number) {
  if (bid <= 0 || months <= 0) return null;
  return (profit / bid) * (12 / months) * 100;
}

export type NplInput = {
  bid: number;
  upb: number;
  value: number;
  monthlyPi: number;
  monthsDelinquent: number;
  foreclosureMonths: number;
  foreclosureCost: number;
  process: string;
  occupancy?: string | null;
  lienPosition?: string | null;
  // The senior lien's balance, for a junior. Unknown takes seniorShare of value.
  seniorBalance?: number | null;
  // Months since the foreclosure was filed, when it already has been.
  foreclosureMonthsElapsed?: number | null;
  premiumBps?: number | null;
  closingCost?: number | null;
};

function money(value: number) {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function resolution(input: NplInput, key: ScenarioKey, variant: { time: number; value: number }) {
  const a = NPL_ASSUMPTIONS;
  const behind = Math.max(0, input.monthsDelinquent);
  const upb = Math.max(0, input.upb);
  const payment = Math.max(0, input.monthlyPi);
  const collateral = Math.max(0, input.value) * variant.value;
  const junior = isJunior(input.lienPosition);
  const senior = junior ? Math.max(0, input.seniorBalance ?? input.value * a.seniorShare) : 0;
  const equity = Math.max(0, collateral - senior);
  // A paying junior trades on its payments, but with little equity behind it only half its UPB counts.
  const markBase = junior ? Math.min(upb, Math.max(equity, upb * 0.5)) : Math.min(upb, collateral);
  const taxes = junior ? 0 : (a.carryRate * collateral) / 12;
  const elapsed = Math.max(0, Math.round(input.foreclosureMonthsElapsed ?? 0));
  const preFiling = elapsed > 0 ? 0 : Math.max(a.boardingMonths, a.filingAfterMonths + 1 - behind);
  const legalMonths = Math.max(MIN_MONTHS_LEFT, Math.round(Math.max(1, input.foreclosureMonths) * variant.time) - elapsed);
  const completion = preFiling + legalMonths;
  const occupancy = occupancyKey(input.occupancy);
  const occupied = occupancy === "VACANT" ? 0 : occupancy === "UNKNOWN" ? 0.5 : 1;
  // What the borrower owes by a given month: the balance, every missed payment, and what the holder advanced. A sale
  // never pays the holder more; any surplus is the borrower's.
  const claim = (months: number, advanced: number) => upb + (behind + months) * payment + advanced;
  const carryFor = (months: number) => months * (a.servicingMonthly + taxes);

  let months: number;
  let fixedCost: number;
  let proceeds: number;
  let taxMonths: number;
  let servicingMonths: number | null = null;
  const payments: { month: number; amount: number }[] = [];
  let note: string;

  switch (key) {
    case "reinstatement": {
      months = a.reinstateMonths;
      fixedCost = a.reinstateCost;
      taxMonths = months;
      const pastDue = (behind + months) * payment;
      proceeds = pastDue + a.reperformingMark * markBase;
      note = `Borrower pays about ${money(pastDue)} past due. The cured loan is marked at ${Math.round(a.reperformingMark * 100)}% of the lower of UPB and value.`;
      break;
    }
    case "modification": {
      months = a.modMonths;
      fixedCost = a.modCost;
      taxMonths = a.modTrialStart - 1;
      for (let month = a.modTrialStart; month <= months; month += 1) payments.push({ month, amount: payment * a.modPayment });
      proceeds = a.modifiedMark * markBase;
      note = `Trial and seasoning payments at ${Math.round(a.modPayment * 100)}% of the old payment, then a sale at ${Math.round(a.modifiedMark * 100)}% of the lower of UPB and value.`;
      break;
    }
    case "short_sale": {
      months = Math.max(6, Math.round(completion * 0.5));
      fixedCost = a.shortSaleCost;
      taxMonths = months;
      const owed = claim(months, fixedCost + carryFor(months));
      const net = collateral * a.shortSaleRecovery;
      proceeds = junior ? Math.min(owed, Math.max(net - senior, a.juniorRelease * upb)) : Math.min(owed, net);
      note = junior
        ? `The senior is paid first. This lien takes what is left, or about ${Math.round(a.juniorRelease * 100)}% of UPB to release.`
        : `Borrower refinances or sells before the foreclosure sale. Nets the lower of the debt and ${Math.round(a.shortSaleRecovery * 100)}% of value.`;
      break;
    }
    case "deed": {
      months = a.deedMonths + a.reoMonths;
      fixedCost = a.deedCost;
      taxMonths = months;
      const net = collateral * a.deedRecovery * (1 - a.saleCost);
      proceeds = Math.min(claim(months, fixedCost + carryFor(months)), Math.max(0, net - senior));
      note = `Borrower deeds the house. The REO sells at ${Math.round(a.deedRecovery * 100)}% of value, less ${Math.round(a.saleCost * 100)}% sale costs${junior ? ", after the senior is paid off" : ""}.`;
      break;
    }
    case "foreclosure":
    default: {
      const net = collateral * a.reoRecovery * (1 - a.saleCost);
      if (junior && net - senior <= input.foreclosureCost) {
        // Nothing above the senior worth the legal spend: the junior is wiped out when the senior forecloses.
        months = Math.max(1, Math.min(completion, a.chargeOffMonths));
        fixedCost = 0;
        taxMonths = 0;
        servicingMonths = months;
        proceeds = 0;
        note = "Too little equity above the senior to foreclose. The lien is wiped out when the senior forecloses.";
        break;
      }
      months = completion + Math.round(a.evictionMonths * occupied) + a.reoMonths;
      fixedCost = input.foreclosureCost + a.evictionCost * occupied;
      taxMonths = months;
      proceeds = Math.min(claim(months, fixedCost + carryFor(months)), Math.max(0, net - senior));
      note = `${elapsed > 0 ? `${elapsed} months into the case, about ${legalMonths} months of the ${input.process.toLowerCase()} timeline still to run` : `${input.process} timeline of about ${legalMonths} months after ${preFiling} months to file`}, then ${occupied ? "eviction and " : ""}an REO sale at ${Math.round(a.reoRecovery * 100)}% of value less sale costs${junior ? ", after the senior is paid off" : ""}. Desk estimates, not legal advice.`;
      break;
    }
  }

  // Monthly flows from month 1: servicing, taxes while the holder carries them, process costs spread evenly, and
  // the exit proceeds in the last month.
  const flows = [-cashIn(input.bid, { premiumBps: input.premiumBps, closingCost: input.closingCost })];
  let paidOut = 0;
  let received = 0;
  for (let month = 1; month <= months; month += 1) {
    const servicing = servicingMonths == null || month <= servicingMonths ? a.servicingMonthly : 0;
    const out = servicing + (month <= taxMonths ? taxes : 0) + fixedCost / months;
    const inflow = payments.filter((row) => row.month === month).reduce((sum, row) => sum + row.amount, 0) + (month === months ? proceeds : 0);
    paidOut += out;
    received += inflow;
    flows.push(inflow - out);
  }
  return { months, cost: paidOut, recovery: received, flows, note };
}

export function nplCases(input: NplInput, variant: { time: number; value: number } = { time: 1, value: 1 }): Resolution[] {
  const { weights } = scenarioWeights(input);
  return SCENARIO_KEYS.map((key) => {
    const row = resolution(input, key, variant);
    const net = row.recovery - row.cost;
    const profit = net - cashIn(input.bid, input);
    return {
      key,
      label: SCENARIO_LABELS[key],
      months: row.months,
      cost: row.cost,
      recovery: row.recovery,
      net,
      profit,
      annualized: annualizedReturn(profit, input.bid, row.months),
      note: row.note,
      weight: weights[key],
      irrPct: irrPct(row.flows),
      flows: row.flows,
    };
  });
}

export type Outcome = { key: string; label: string; variant: string; weight: number; months: number; flows: number[]; irrPct: number | null };

// Five resolutions times three timelines, each weighted: the outcomes behind the range and the dotplot.
export function nplOutcomes(input: NplInput): Outcome[] {
  return VARIANTS.flatMap((variant) =>
    nplCases(input, variant).map((row) => ({
      key: row.key,
      label: row.label,
      variant: variant.key,
      weight: row.weight * variant.weight,
      months: row.months,
      flows: row.flows,
      irrPct: row.irrPct,
    })),
  );
}

// The probability-weighted flows. Their IRR is the expected case, and the bid that zeroes their NPV at a target is
// the weighted average of each outcome's price at that target.
export function expectedFlows(outcomes: { weight: number; flows: number[] }[]) {
  const length = Math.max(0, ...outcomes.map((row) => row.flows.length));
  const total = outcomes.reduce((sum, row) => sum + row.weight, 0) || 1;
  const flows = new Array<number>(length).fill(0);
  for (const row of outcomes) row.flows.forEach((flow, t) => (flows[t] += (flow * row.weight) / total));
  return flows;
}

// ---------------------------------------------------------------------------------------------------------------
// Performing paths: the contract, an early payoff, and a default. The payoff weight comes from a prepayment speed;
// the default weight is the desk's. Neither is a fitted model.

// A low prepayment default, labelled wherever it is used. ICE's First Look for September 2026 (27 October) put the
// single-month speed at 0.59% SMM, the lowest since February 2025, which is about 7% a year (CPR). Seasoned private
// notes rarely refinance faster than agency paper, so the default isn't raised for them.
export const PREPAYMENT = {
  cpr: 7,
  source: "ICE First Look, September 2026: 0.59% SMM, about 7% CPR",
  asOf: "2026-10-27",
};

export const PAYOFF_MONTH = 36;
export const DEFAULT_MONTH = 24;
export const DEFAULT_WEIGHT = 0.1;

// The chance a loan pays off in full within `months` at an annual speed (CPR) in percent.
export function payoffChance(cpr: number, months = PAYOFF_MONTH) {
  const annual = Math.min(0.95, Math.max(0, (Number.isFinite(cpr) ? cpr : PREPAYMENT.cpr) / 100));
  return 1 - (1 - annual) ** (months / 12);
}

// The three paths' weights at a CPR. The payoff weight is capped so the contract always keeps some weight.
export function performingWeights(cpr = PREPAYMENT.cpr) {
  const payoff = Math.min(1 - DEFAULT_WEIGHT - 0.05, payoffChance(cpr));
  return [
    { key: "contract", label: "Pays as agreed", weight: 1 - payoff - DEFAULT_WEIGHT },
    { key: "payoff", label: `Pays off at month ${PAYOFF_MONTH}`, weight: payoff },
    { key: "default", label: `Stops paying at month ${DEFAULT_MONTH}`, weight: DEFAULT_WEIGHT },
  ];
}

// Kept for older callers: the weights at the default speed.
export const PERFORMING_PATHS = performingWeights();

export type PrepaymentBasis = { cpr: number; payoffWeight: number; assumed: boolean; label: string };

export function prepaymentBasis(cpr?: number | null): PrepaymentBasis {
  const assumed = cpr == null || !Number.isFinite(cpr);
  const speed = assumed ? PREPAYMENT.cpr : Math.min(95, Math.max(0, cpr));
  const payoffWeight = performingWeights(speed)[1].weight;
  const why = assumed ? `${speed}% CPR, a low default (${PREPAYMENT.source})` : `${speed}% CPR, as entered`;
  return {
    cpr: speed,
    payoffWeight,
    assumed,
    label: `Prepayment at ${why}. That gives the month-${PAYOFF_MONTH} payoff a ${Math.round(payoffWeight * 100)}% weight, the chance of a full payoff within ${PAYOFF_MONTH / 12} years. An assumption, not a forecast.`,
  };
}

function performingPaths(input: CashFlowInput & { value: number; state: string; cpr?: number | null }) {
  const contract = projectFlows(input);
  const weights = performingWeights(prepaymentBasis(input.cpr).cpr);
  const paths: { key: string; label: string; weight: number; flows: number[] }[] = [
    { key: "contract", label: weights[0].label, weight: weights[0].weight, flows: contract },
  ];
  if (contract.length - 1 > PAYOFF_MONTH) {
    const early = projectFlows({ ...input, balloonMonth: PAYOFF_MONTH });
    paths.push({ key: "payoff", label: weights[1].label, weight: weights[1].weight, flows: early });
  }
  if (contract.length - 1 > DEFAULT_MONTH && input.value > 0) {
    // Paid through month 24, then the loan resolves as a non-performing first lien would from that point.
    const paid = contract.slice(0, DEFAULT_MONTH + 1);
    const balance = balanceAfter(input, DEFAULT_MONTH);
    const rule = foreclosureFor(input.state);
    const rest = expectedFlows(
      nplOutcomes({
        bid: 0,
        upb: balance,
        value: input.value,
        monthlyPi: input.monthlyPi,
        monthsDelinquent: 0,
        foreclosureMonths: rule.months,
        foreclosureCost: rule.cost,
        process: rule.process,
      }),
    ).slice(1);
    paths.push({ key: "default", label: weights[2].label, weight: weights[2].weight, flows: [...paid, ...rest] });
  }
  const total = paths.reduce((sum, path) => sum + path.weight, 0);
  return paths.map((path) => ({ ...path, weight: path.weight / total }));
}

function balanceAfter(input: CashFlowInput, months: number) {
  const flows = projectFlows({ ...input, balloonMonth: months + 1 });
  // The last flow is the payoff at month + 1: balance plus a month of interest.
  const payoff = flows[flows.length - 1];
  return Math.max(0, payoff / (1 + input.annualRate / 100 / 12));
}

// ---------------------------------------------------------------------------------------------------------------
// The pricing API. Field names follow the Note model, so a loan row can be passed as it is.

export type PricingNote = {
  upb: number;
  interestRate: number;
  monthlyPi: number;
  estimatedValue?: number | null;
  state?: string | null;
  paymentStatus?: string | null;
  occupancy?: string | null;
  lienPosition?: string | null;
  monthsDelinquent?: number | null;
  // Remaining term. Without it, maturityDate sets it, and without that 360 months.
  termMonths?: number | null;
  maturityDate?: Date | string | null;
  foreclosureFiledAt?: Date | string | null;
  seniorBalance?: number | null;
  balloonMonth?: number | null;
  armResets?: ArmReset[];
  missedMonths?: number[];
};

// cpr: the prepayment speed for the performing paths, in percent a year. Missing means the labelled default.
export type PricingOptions = PricingCosts & { now?: Date; cpr?: number | null };

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

function monthsBetween(from: Date | string | null | undefined, to: Date) {
  if (!from) return null;
  const date = typeof from === "string" ? new Date(from) : from;
  if (Number.isNaN(date.getTime())) return null;
  return Math.round((to.getTime() - date.getTime()) / MONTH_MS);
}

function prepared(note: PricingNote, options: PricingOptions = {}) {
  const now = options.now ?? new Date();
  const toMaturity = monthsBetween(now, note.maturityDate ? new Date(note.maturityDate) : now);
  const term = note.termMonths && note.termMonths > 0 ? note.termMonths : note.maturityDate && toMaturity != null ? Math.max(1, Math.min(480, toMaturity)) : 360;
  const filed = monthsSince(note.foreclosureFiledAt, now);
  const performing = (note.paymentStatus ?? "PERFORMING") === "PERFORMING";
  const rule = foreclosureFor(note.state ?? "");
  return {
    performing,
    upb: Math.max(0, note.upb),
    value: Math.max(0, note.estimatedValue ?? 0),
    rule,
    term,
    elapsed: filed != null && filed > 0 ? filed : 0,
    // Only a loan priced on its resolutions runs the foreclosure clock.
    progress: performing ? null : foreclosureProgress(rule, note.foreclosureFiledAt, now),
    costs: { premiumBps: options.premiumBps ?? 0, closingCost: options.closingCost ?? 0 },
    cpr: options.cpr ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The value a price leans on, and the loan-to-value it gives.

export type ValueEstimate = { value: number | null; provider?: string | null; asOf?: Date | string | null };
export type PricingValue = { value: number; source: "estimate" | "seller" | "none"; label: string };

const VALUE_WORDS: Record<string, string> = { BPO: "BPO", AVM: "AVM", APPRAISAL: "appraisal", SELLER: "own estimate" };

// Current value first: a value estimate when one may be shown (pass only what showableAvm allows), otherwise the
// seller's figure. Either way the label says which, so a price on the seller's value reads as that.
export function pricingValue(
  seller: number | null | undefined,
  estimate?: ValueEstimate | null,
  sellerBasis?: { type?: string | null; asOf?: Date | string | null } | null,
): PricingValue {
  if (estimate?.value != null && Number.isFinite(estimate.value) && estimate.value > 0) {
    const provider = (estimate.provider ?? "").trim();
    const who = !provider ? "value estimate" : provider.toLowerCase() === "mock" ? "stand-in value estimate (demo data)" : `${provider} value estimate`;
    return { value: estimate.value, source: "estimate", label: estimate.asOf ? `${who}, ${prettyDate(estimate.asOf)}` : who };
  }
  if (seller != null && Number.isFinite(seller) && seller > 0) {
    const kind = sellerBasis?.type ? VALUE_WORDS[sellerBasis.type] ?? null : null;
    const when = sellerBasis?.asOf && prettyDate(sellerBasis.asOf) !== "—" ? prettyDate(sellerBasis.asOf) : null;
    const detail = [kind, when].filter(Boolean).join(", ");
    return { value: seller, source: "seller", label: detail ? `seller's value (${detail})` : "seller's value" };
  }
  return { value: 0, source: "none", label: "no value on file" };
}

export type CurrentLtv = { pct: number; combined: boolean; seniorAssumed: boolean };

// UPB over value, and for a junior lien the senior's balance too (assumed at seniorShare of value when unknown).
export function currentLtv(note: Pick<PricingNote, "upb" | "lienPosition" | "seniorBalance">, value: number): CurrentLtv | null {
  if (!(value > 0) || !(note.upb > 0)) return null;
  const junior = isJunior(note.lienPosition);
  const seniorAssumed = junior && note.seniorBalance == null;
  const senior = junior ? Math.max(0, note.seniorBalance ?? value * NPL_ASSUMPTIONS.seniorShare) : 0;
  return { pct: ((note.upb + senior) / value) * 100, combined: junior, seniorAssumed };
}

function cashInput(note: PricingNote, term: number, bid: number): CashFlowInput {
  return {
    bid,
    upb: Math.max(0, note.upb),
    annualRate: note.interestRate,
    monthlyPi: note.monthlyPi,
    termMonths: term,
    balloonMonth: note.balloonMonth ?? null,
    armResets: note.armResets ?? [],
    missedMonths: note.missedMonths ?? [],
  };
}

function nplInput(note: PricingNote, base: ReturnType<typeof prepared>, bid: number): NplInput {
  return {
    bid,
    upb: base.upb,
    value: base.value,
    monthlyPi: note.monthlyPi,
    monthsDelinquent: Math.max(0, note.monthsDelinquent ?? 0),
    foreclosureMonths: base.rule.months,
    foreclosureCost: base.rule.cost,
    process: base.rule.process === "Unknown" ? "National average" : base.rule.process,
    occupancy: note.occupancy,
    lienPosition: note.lienPosition,
    seniorBalance: note.seniorBalance,
    foreclosureMonthsElapsed: base.elapsed,
    premiumBps: base.costs.premiumBps,
    closingCost: base.costs.closingCost,
  };
}

function costBasis(costs: PricingCosts) {
  const parts = [];
  if (costs.premiumBps) parts.push(`the ${(costs.premiumBps / 100).toFixed(2)}% buyer premium`);
  if (costs.closingCost) parts.push(`${money(costs.closingCost)} of closing costs`);
  return parts.length ? `After ${parts.join(" and ")}.` : "Before the buyer premium and closing costs.";
}

export type ScenarioPrice = { key: string; label: string; weight: number; bid: number | null; pctOfUpb: number | null };

// What every solution carries besides its figures: the state timeline and how far a filed case has run, the
// prepayment speed behind the performing paths, and the loan-to-value on the value used.
type SolutionContext = {
  timeline: (ForeclosureRule & { state: string; assumed: boolean }) | null;
  foreclosure: ForeclosureProgress | null;
  prepayment: PrepaymentBasis | null;
  ltv: CurrentLtv | null;
};

export type PriceSolution = SolutionContext & {
  targetYield: number;
  performing: boolean;
  // The headline bid: the contract for performing paper, the weighted resolutions for non-performing.
  bid: number | null;
  pctOfUpb: number | null;
  pctOfValue: number | null;
  scenarios: ScenarioPrice[];
  // Bids across every weighted outcome, and a 20-dot quantile strip of them.
  range: Spread | null;
  dots: number[];
  basis: string;
  weightsBasis: string | null;
};

function pctOf(amount: number | null, of: number) {
  return amount == null || of <= 0 ? null : (amount / of) * 100;
}

function contextOf(note: PricingNote, base: ReturnType<typeof prepared>): SolutionContext {
  return {
    timeline: base.performing ? null : base.rule,
    foreclosure: base.progress,
    prepayment: base.performing ? prepaymentBasis(base.cpr) : null,
    ltv: currentLtv(note, base.value),
  };
}

function performingBasis(base: ReturnType<typeof prepared>) {
  const speed = prepaymentBasis(base.cpr);
  return `Annual IRR on the contractual payments, unlevered. ${costBasis(base.costs)} The early-payoff weight comes from a ${speed.cpr}% CPR${speed.assumed ? ", a low default" : ""}, and the default weight is the desk's. Neither is a fitted model.`;
}

// The bid that returns targetYield (an annual IRR, in percent) on this loan. For performing paper that is the
// contract's IRR; for anything else, the IRR of the probability-weighted resolutions.
export function priceForYield(note: PricingNote, targetYield: number, options: PricingOptions = {}): PriceSolution {
  const base = prepared(note, options);
  const ceiling = Math.max(base.upb, base.value, 1) * 2;
  if (base.performing) {
    const paths = performingPaths({ ...cashInput(note, base.term, 0), value: base.value, state: note.state ?? "", cpr: base.cpr });
    const priced = paths.map((path) => ({
      key: path.key,
      label: path.label,
      weight: path.weight,
      bid: solveBid((bid) => withCashIn(path.flows, bid, base.costs), targetYield, ceiling),
    }));
    const bid = solveBid((bid) => withCashIn(projectFlows(cashInput(note, base.term, bid)), bid, base.costs), targetYield, ceiling);
    const points = priced.filter((row) => row.bid != null).map((row) => ({ value: row.bid as number, weight: row.weight }));
    return {
      targetYield,
      performing: true,
      bid,
      pctOfUpb: pctOf(bid, base.upb),
      pctOfValue: pctOf(bid, base.value),
      scenarios: priced.map((row) => ({ ...row, pctOfUpb: pctOf(row.bid, base.upb) })),
      range: spreadOf(points),
      dots: quantileDots(points),
      basis: performingBasis(base),
      weightsBasis: null,
      ...contextOf(note, base),
    };
  }
  const input = nplInput(note, base, 0);
  const outcomes = nplOutcomes(input);
  const priceOf = (flows: number[]) => solveBid((bid) => withCashIn(flows, bid, base.costs), targetYield, ceiling);
  const bid = solveBid((bid) => withCashIn(expectedFlows(outcomes), bid, base.costs), targetYield, ceiling);
  const baseRows = nplCases(input);
  const points = outcomes.map((row) => ({ value: priceOf(row.flows) ?? 0, weight: row.weight }));
  return {
    targetYield,
    performing: false,
    bid,
    pctOfUpb: pctOf(bid, base.upb),
    pctOfValue: pctOf(bid, base.value),
    scenarios: baseRows.map((row) => {
      const price = priceOf(row.flows);
      return { key: row.key, label: row.label, weight: row.weight, bid: price, pctOfUpb: pctOf(price, base.upb) };
    }),
    range: spreadOf(points),
    dots: quantileDots(points),
    basis: `Annual IRR on the probability-weighted resolutions, unlevered, with carry and sale costs. ${costBasis(base.costs)}`,
    weightsBasis: scenarioWeights(input).basis,
    ...contextOf(note, base),
  };
}

// Only the headline bid, at one or more targets, for a list page or a standing rule. The same figure priceForYield
// heads with, at a fraction of the work: the flows depend on the bid only through the cash in, so they are built once.
export function headlinePrices(note: PricingNote, targets: number[], options: PricingOptions = {}): (number | null)[] {
  const base = prepared(note, options);
  const ceiling = Math.max(base.upb, base.value, 1) * 2;
  const flows = base.performing ? projectFlows(cashInput(note, base.term, 0)) : expectedFlows(nplOutcomes(nplInput(note, base, 0)));
  return targets.map((target) => solveBid((bid) => withCashIn(flows, bid, base.costs), target, ceiling));
}

export type YieldSolution = SolutionContext & {
  bid: number;
  performing: boolean;
  // The contract's IRR for performing paper; the expected IRR across resolutions otherwise.
  irrPct: number | null;
  scenarios: { key: string; label: string; weight: number; irrPct: number | null; months: number }[];
  // The five resolutions as modelled, with their flows, for a table. Empty for performing paper.
  cases: Resolution[];
  range: Spread | null;
  dots: number[];
  basis: string;
  weightsBasis: string | null;
};

// The other direction: the IRR, and its spread, at a given bid.
export function yieldAtPrice(note: PricingNote, bid: number, options: PricingOptions = {}): YieldSolution {
  const base = prepared(note, options);
  if (base.performing) {
    const paths = performingPaths({ ...cashInput(note, base.term, bid), value: base.value, state: note.state ?? "", cpr: base.cpr }).map((path) => ({
      ...path,
      flows: withCashIn(path.flows, bid, base.costs),
    }));
    const scenarios = paths.map((path) => ({ key: path.key, label: path.label, weight: path.weight, irrPct: irrPct(path.flows), months: path.flows.length - 1 }));
    const points = scenarios.filter((row) => row.irrPct != null).map((row) => ({ value: row.irrPct as number, weight: row.weight }));
    return {
      bid,
      performing: true,
      irrPct: irrPct(withCashIn(projectFlows(cashInput(note, base.term, bid)), bid, base.costs)),
      scenarios,
      cases: [],
      range: spreadOf(points),
      dots: quantileDots(points),
      basis: performingBasis(base),
      weightsBasis: null,
      ...contextOf(note, base),
    };
  }
  const input = nplInput(note, base, bid);
  const outcomes = nplOutcomes(input);
  const points = outcomes.filter((row) => row.irrPct != null).map((row) => ({ value: row.irrPct as number, weight: row.weight }));
  const cases = nplCases(input);
  return {
    bid,
    performing: false,
    irrPct: irrPct(expectedFlows(outcomes)),
    scenarios: cases.map((row) => ({ key: row.key, label: row.label, weight: row.weight, irrPct: row.irrPct, months: row.months })),
    cases,
    range: spreadOf(points),
    dots: quantileDots(points),
    basis: `Expected annual IRR across the weighted resolutions, unlevered, with carry and sale costs. ${costBasis(base.costs)}`,
    weightsBasis: scenarioWeights(input).basis,
    ...contextOf(note, base),
  };
}

// A pool's price at one target is the sum of its loans' prices: each loan's NPV is zero at the target, so the pool's is.
export function priceForPool(notes: PricingNote[], targetYield: number, options: PricingOptions = {}) {
  const loans = notes.map((note) => priceForYield(note, targetYield, options));
  const priced = loans.every((loan) => loan.bid != null);
  const bid = priced ? loans.reduce((sum, loan) => sum + (loan.bid ?? 0), 0) : null;
  const upb = notes.reduce((sum, note) => sum + Math.max(0, note.upb), 0);
  const value = notes.reduce((sum, note) => sum + Math.max(0, note.estimatedValue ?? 0), 0);
  return { bid, pctOfUpb: pctOf(bid, upb), pctOfValue: pctOf(bid, value), loans };
}
