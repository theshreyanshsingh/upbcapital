// Statute of limitations on a defaulted note: when the time to sue on the note, or to foreclose, may run out.
//
// Two periods per state, both from the state's own statute, cited per row:
//
// note: the written-contract period, the usual limit on suing for the debt. A negotiable note can carry the six
//   years of UCC § 3-118 instead, and a note under seal or witnessed can run longer. The row says so where the
//   statute is plain about it.
// foreclosure: a period that bars foreclosing the mortgage or ends the lien, where the state has one the desk is
//   sure of. Some run from the default or the acceleration, some from the maturity date on record.
//
// Where the desk wasn't confident of a figure, the state is null and the page says "check with counsel". No figure
// here is an estimate. Set by the desk on November 8, 2026, from the statutes as published; not reviewed by counsel.
//
// The dates are a flag, not an answer. A payment, an acceleration and its rescission, a bankruptcy stay, a tolling
// agreement, a modification or a dismissed foreclosure can each move them, and several states restart the clock on
// each missed installment. Not legal advice.

export const SOL_TABLE_SET_ON = "2026-11-08";
export const SOL_HEADLINE = "SOL exposure: check with counsel";
export const SOL_CAVEAT =
  "Not legal advice. These are the statutes as UPB read them, counted from the tape's dates. A payment, an acceleration or its rescission, a bankruptcy, a tolling agreement, a modification or a dismissed case can move the date, and some states restart the clock on each missed payment. Check with counsel before pricing on it.";
// Inside this many months of the earliest date, the time is running out.
export const RUNNING_OUT_MONTHS = 12;

// default: from the first missed payment, the earliest the debt could have been accelerated. maturity: from the
// maturity date on record.
export type SolAnchor = "default" | "maturity";

export type SolRule = { years: number; from: SolAnchor; law: string };

type StateRow = { name: string; note: SolRule | null; foreclosure: SolRule[] | null; caveat?: string };

const note = (years: number, law: string): SolRule => ({ years, from: "default", law });
const fc = (years: number, from: SolAnchor, law: string): SolRule => ({ years, from, law });

export const SOL_TABLE: Record<string, StateRow> = {
  AL: { name: "Alabama", note: note(6, "Ala. Code § 6-2-34(4), promises in writing not under seal"), foreclosure: null },
  AK: { name: "Alaska", note: note(3, "Alaska Stat. § 09.10.053, contract"), foreclosure: null },
  AZ: { name: "Arizona", note: note(6, "A.R.S. § 12-548(A)(1), written contract"), foreclosure: null },
  AR: { name: "Arkansas", note: note(5, "Ark. Code § 16-56-111(a), written obligation"), foreclosure: null },
  CA: {
    name: "California",
    note: note(4, "Cal. Code Civ. Proc. § 337(a), written contract"),
    foreclosure: [fc(10, "maturity", "Cal. Civ. Code § 882.020(a)(1), the lien expires 10 years after the final maturity date on record")],
  },
  CO: { name: "Colorado", note: note(6, "C.R.S. § 13-80-103.5(1)(a), liquidated debt and instruments securing it"), foreclosure: null },
  CT: { name: "Connecticut", note: note(6, "Conn. Gen. Stat. § 52-576, written contract"), foreclosure: null },
  DE: { name: "Delaware", note: note(3, "10 Del. C. § 8106, contract"), foreclosure: null, caveat: "A note under seal can run longer." },
  DC: { name: "District of Columbia", note: note(3, "D.C. Code § 12-301(7), simple contract"), foreclosure: null, caveat: "An instrument under seal runs 12 years, § 12-301(6)." },
  FL: {
    name: "Florida",
    note: note(5, "Fla. Stat. § 95.11(2)(b), written instrument"),
    foreclosure: [
      fc(5, "default", "Fla. Stat. § 95.11(2)(c), action to foreclose a mortgage"),
      fc(5, "maturity", "Fla. Stat. § 95.281(1)(a), the lien ends 5 years after a maturity date on record"),
    ],
    caveat: "Florida courts let a later default start a new foreclosure (Bartram v. U.S. Bank, 2016).",
  },
  GA: {
    name: "Georgia",
    note: note(6, "O.C.G.A. § 9-3-24, simple written contract"),
    foreclosure: [fc(7, "maturity", "O.C.G.A. § 44-14-80(a)(1), title under a security deed reverts 7 years after the debt's maturity on record")],
  },
  HI: { name: "Hawaii", note: note(6, "HRS § 657-1(1), contract"), foreclosure: null },
  ID: { name: "Idaho", note: note(5, "Idaho Code § 5-216, written contract"), foreclosure: null },
  IL: {
    name: "Illinois",
    note: note(10, "735 ILCS 5/13-206, written contract or promissory note"),
    foreclosure: [fc(10, "default", "735 ILCS 5/13-115, foreclosure within 10 years after the right accrues")],
  },
  IN: { name: "Indiana", note: note(6, "Ind. Code § 34-11-2-9, promissory notes and written contracts for money"), foreclosure: null },
  IA: { name: "Iowa", note: note(10, "Iowa Code § 614.1(5), written contract"), foreclosure: null },
  KS: { name: "Kansas", note: note(5, "K.S.A. 60-511(1), written contract"), foreclosure: null },
  // KRS 413.090 turns on when the contract was made, which the helper doesn't read.
  KY: { name: "Kentucky", note: null, foreclosure: null },
  LA: { name: "Louisiana", note: note(5, "La. Civ. Code art. 3498, promissory notes"), foreclosure: null },
  ME: { name: "Maine", note: note(6, "14 M.R.S. § 752, civil actions"), foreclosure: null, caveat: "A note signed before an attesting witness runs 20 years, 14 M.R.S. § 751." },
  MD: { name: "Maryland", note: note(3, "Md. Code, Cts. & Jud. Proc. § 5-101"), foreclosure: null, caveat: "A note under seal is a specialty, 12 years, § 5-102." },
  MA: {
    name: "Massachusetts",
    note: note(6, "M.G.L. c. 260, § 2, contract"),
    foreclosure: [fc(5, "maturity", "M.G.L. c. 260, § 33, no foreclosure 5 years after the stated term or maturity")],
  },
  MI: {
    name: "Michigan",
    note: note(6, "MCL 600.5807, contract"),
    foreclosure: [fc(15, "default", "MCL 600.5803, 15 years after the mortgage comes due or the last payment")],
  },
  MN: {
    name: "Minnesota",
    note: note(6, "Minn. Stat. § 541.05, subd. 1(1), contract"),
    foreclosure: [fc(15, "maturity", "Minn. Stat. § 541.03, subd. 1, 15 years from the maturity of the whole debt")],
  },
  MS: { name: "Mississippi", note: note(3, "Miss. Code § 15-1-49"), foreclosure: null },
  MO: { name: "Missouri", note: note(10, "RSMo § 516.110(1), writing for the payment of money"), foreclosure: null },
  MT: { name: "Montana", note: note(8, "Mont. Code § 27-2-202(1), written contract"), foreclosure: null },
  NE: { name: "Nebraska", note: note(5, "Neb. Rev. Stat. § 25-205, written contract"), foreclosure: null },
  NV: {
    name: "Nevada",
    note: note(6, "NRS 11.190(1)(b), written contract"),
    foreclosure: [fc(10, "default", "NRS 106.240, the lien ends 10 years after the debt becomes wholly due, which an acceleration can bring forward")],
  },
  NH: { name: "New Hampshire", note: note(3, "RSA 508:4, personal actions"), foreclosure: null },
  NJ: {
    name: "New Jersey",
    note: note(6, "N.J.S.A. 2A:14-1, contract"),
    foreclosure: [
      fc(6, "maturity", "N.J.S.A. 2A:50-56.1(a)(1), 6 years from the maturity date"),
      fc(20, "default", "N.J.S.A. 2A:50-56.1(a)(3), 20 years from the default"),
    ],
  },
  NM: { name: "New Mexico", note: note(6, "NMSA § 37-1-3(A), written contract"), foreclosure: null },
  NY: {
    name: "New York",
    note: note(6, "CPLR 213(2) and 213(4)"),
    foreclosure: [fc(6, "default", "CPLR 213(4), from acceleration or each missed payment")],
    caveat: "The Foreclosure Abuse Prevention Act of 2022 stops a lender resetting the clock by withdrawing an acceleration.",
  },
  NC: {
    name: "North Carolina",
    note: note(3, "N.C.G.S. § 1-52(1), contract"),
    foreclosure: [fc(10, "default", "N.C.G.S. § 1-47(3), power of sale, 10 years after the forfeiture or the last payment")],
    caveat: "A sealed note runs 10 years, § 1-47(2).",
  },
  ND: { name: "North Dakota", note: note(6, "N.D.C.C. § 28-01-16(1), contract"), foreclosure: null },
  OH: { name: "Ohio", note: note(6, "Ohio Rev. Code § 2305.06, written contract"), foreclosure: null, caveat: "The 6 years apply from June 16, 2021. An older contract can carry the earlier period." },
  OK: { name: "Oklahoma", note: note(5, "12 O.S. § 95(A)(1), written contract"), foreclosure: null },
  OR: { name: "Oregon", note: note(6, "ORS 12.080(1), contract"), foreclosure: null },
  PA: { name: "Pennsylvania", note: note(4, "42 Pa.C.S. § 5525(a)(7), note or other instrument in writing"), foreclosure: null, caveat: "An instrument under seal runs 20 years, § 5529(b)." },
  RI: { name: "Rhode Island", note: note(10, "R.I. Gen. Laws § 9-1-13(a), civil actions"), foreclosure: null },
  SC: { name: "South Carolina", note: note(3, "S.C. Code § 15-3-530(1), contract"), foreclosure: null, caveat: "A sealed instrument runs 20 years, § 15-3-520." },
  SD: { name: "South Dakota", note: note(6, "SDCL 15-2-13(1), contract"), foreclosure: null },
  TN: { name: "Tennessee", note: note(6, "Tenn. Code § 28-3-109(a)(3), contract"), foreclosure: null },
  TX: {
    name: "Texas",
    note: note(4, "Tex. Civ. Prac. & Rem. Code § 16.004(a)(3), debt"),
    foreclosure: [fc(4, "default", "Tex. Civ. Prac. & Rem. Code § 16.035, from acceleration or maturity")],
    caveat: "A rescinded acceleration can restart the clock, § 16.038.",
  },
  UT: { name: "Utah", note: note(6, "Utah Code § 78B-2-309(2), written contract"), foreclosure: null },
  VT: { name: "Vermont", note: note(6, "12 V.S.A. § 511, civil actions"), foreclosure: null },
  VA: { name: "Virginia", note: note(5, "Va. Code § 8.01-246(2), written contract"), foreclosure: null },
  WA: {
    name: "Washington",
    note: note(6, "RCW 4.16.040(1), written contract"),
    foreclosure: [fc(6, "default", "RCW 4.16.040(1), on each missed payment, and on the whole debt from acceleration or maturity")],
  },
  WV: { name: "West Virginia", note: note(10, "W. Va. Code § 55-2-6, written contract"), foreclosure: null },
  WI: { name: "Wisconsin", note: note(6, "Wis. Stat. § 893.43, contract"), foreclosure: null },
  WY: { name: "Wyoming", note: note(10, "Wyo. Stat. § 1-3-105(a)(i), written contract"), foreclosure: null },
};

export type SolStatus = "PAST" | "RUNNING_OUT" | "OPEN" | "UNKNOWN";

export type SolLine = SolRule & { kind: "note" | "foreclosure"; start: Date | null; date: Date | null; text: string };

export type SolExposure = {
  state: string;
  name: string;
  status: SolStatus;
  headline: string;
  // The earliest date any period may run out, and the line it comes from.
  date: Date | null;
  summary: string;
  lines: SolLine[];
  // Where the period starts when it counts from the default.
  defaultFrom: Date | null;
  caveat: string;
};

const DAY = 86400000;

function readDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMonths(date: Date, months: number) {
  const out = new Date(date);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

const pretty = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const plural = (years: number) => (years === 1 ? "1 year" : `${years} years`);

// The first missed payment: the next due date when the tape has one, else a month after the last payment.
export function firstMissed(input: { lastPaidDate?: Date | string | null; nextDueDate?: Date | string | null }) {
  const due = readDate(input.nextDueDate);
  if (due) return due;
  const paid = readDate(input.lastPaidDate);
  return paid ? addMonths(paid, 1) : null;
}

// A pure reading of the table for one loan. It never says a claim is barred: it says when the time to sue may run out,
// on what basis, and to check with counsel.
export function solExposure(input: {
  state: string;
  lastPaidDate?: Date | string | null;
  maturityDate?: Date | string | null;
  nextDueDate?: Date | string | null;
  now?: Date;
}): SolExposure {
  const now = input.now ?? new Date();
  const code = input.state.trim().toUpperCase();
  const row = SOL_TABLE[code];
  const name = row?.name ?? code;
  const defaultFrom = firstMissed(input);
  const maturity = readDate(input.maturityDate);
  const caveat = row?.caveat ? `${row.caveat} ${SOL_CAVEAT}` : SOL_CAVEAT;
  const base = { state: code, name, headline: SOL_HEADLINE, defaultFrom, caveat };
  const rules: (SolRule & { kind: "note" | "foreclosure" })[] = [
    ...(row?.note ? [{ ...row.note, kind: "note" as const }] : []),
    ...(row?.foreclosure ?? []).map((rule) => ({ ...rule, kind: "foreclosure" as const })),
  ];
  if (!rules.length) {
    return { ...base, status: "UNKNOWN", date: null, lines: [], summary: `UPB has no limitation period on file for ${name} that it is sure of.` };
  }
  const lines: SolLine[] = rules.map((rule) => {
    const start = rule.from === "default" ? defaultFrom : maturity;
    const date = start ? addMonths(start, rule.years * 12) : null;
    const what = rule.kind === "note" ? "to sue on the note" : "to foreclose";
    const from = rule.from === "default" ? "the first missed payment" : "maturity";
    const when = start ? `, counted from ${from}${rule.from === "default" ? ", about" : ","} ${pretty(start)}` : `, but the tape has no ${rule.from === "default" ? "last paid date" : "maturity date"} to count from`;
    return { ...rule, start, date, text: `${plural(rule.years)} ${what} (${rule.law})${when}.` };
  });
  const dated = lines.filter((line) => line.date).sort((a, b) => a.date!.getTime() - b.date!.getTime());
  const earliest = dated[0] ?? null;
  if (!earliest?.date) {
    return { ...base, status: "UNKNOWN", date: null, lines, summary: "The tape has no last paid date or maturity date to count from." };
  }
  const date = earliest.date;
  const status: SolStatus = date.getTime() < now.getTime() - DAY ? "PAST" : date.getTime() < addMonths(now, RUNNING_OUT_MONTHS).getTime() ? "RUNNING_OUT" : "OPEN";
  const what = earliest.kind === "note" ? "to sue on the note" : "to foreclose";
  const summary =
    status === "PAST" ? `The time ${what} may have run out about ${pretty(date)}.`
    : status === "RUNNING_OUT" ? `The time ${what} may run out about ${pretty(date)}, within ${RUNNING_OUT_MONTHS} months.`
    : `The earliest the time ${what} may run out is about ${pretty(date)}.`;
  return { ...base, status, date, lines, summary };
}

// States with no figure on file, for the page that lists them.
export function statesWithoutFigures() {
  return Object.entries(SOL_TABLE)
    .filter(([, row]) => !row.note && !row.foreclosure)
    .map(([code]) => code);
}
