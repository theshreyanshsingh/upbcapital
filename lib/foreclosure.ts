// State foreclosure timelines and costs, for pricing non-performing paper.
//
// Days run from the first public foreclosure filing to completion, the way ATTOM measures them for homes whose
// foreclosure completed in a quarter. ATTOM publishes state averages only for its five longest and five shortest
// states each quarter; the full 51-row series needs the ATTOM licence (roadmap rank 9). So every row says where its
// days come from:
//
// "ATTOM": the newest quarter in which ATTOM published that state.
//   Q2 2026, released July 16, 2026. National average 563 days. LA 3,491; HI 2,293; NY 2,007; CT 1,626; NV 1,507;
//     TX 155; NH 157; WY 173; WV 196; AK 199.
//     https://www.attomdata.com/news/market-trends/foreclosures/2026-mid-year-foreclosure-market-report/
//   Q1 2026, released April 16, 2026. RI 219 (it was 1,929 in Q3 2025: few completions, so it swings).
//     https://www.attomdata.com/news/market-trends/foreclosures/q1-and-march-2026-foreclosure-market-report/
//   Q4 2025, released January 15, 2026. KS 1,594.
//     https://www.attomdata.com/news/most-recent/2025-year-end-foreclosure-market-report/
//   Q3 2025, released October 9, 2025. VA 160; MT 174.
//     https://www.attomdata.com/news/market-trends/foreclosures/q3-and-september-2025-foreclosure-market-report/
//   Q2 2025, released July 17, 2025. MN 162.
//     https://www.attomdata.com/news/market-trends/foreclosures/mid-year-2025-foreclosure-market-report/
//   ATTOM had not published Q3 2026 when this table was set on November 5, 2026.
//
// "Desk estimate": every other state. The statutory steps (notice, cure, mediation, sale, redemption) plus the court
//   or trustee backlog, placed between ATTOM's published short and long states and against its 563-day national
//   average. Not an ATTOM figure. Replace with the licensed series when UPB has it.
//
// The process is the route most home loans take under state law, cited per row. Cost is the desk's estimate of
// legal, court, trustee and publication costs through the sale (see processCost); carry, eviction and the REO sale
// are modelled in lib/underwriting.ts.

export type ForeclosureProcess = "Judicial" | "Non-judicial";

export type ForeclosureRule = {
  months: number;
  cost: number;
  process: ForeclosureProcess | "Unknown";
  // Average days from the first filing to completion.
  days: number;
  basis: "ATTOM" | "Desk estimate" | "National average";
  // The ATTOM quarter, or the date the desk set its estimate.
  asOf: string;
  source: string;
  law: string;
  name: string;
};

type Row = [name: string, process: ForeclosureProcess, days: number, basis: "ATTOM" | "Desk estimate", asOf: string, law: string];

export const TABLE_SET_ON = "2026-11-05";
export const NATIONAL_AVERAGE_DAYS = 563;
export const NATIONAL_AS_OF = "Q2 2026";
const ATTOM_RELEASES: Record<string, string> = {
  "Q2 2026": "released July 16, 2026",
  "Q1 2026": "released April 16, 2026",
  "Q4 2025": "released January 15, 2026",
  "Q3 2025": "released October 9, 2025",
  "Q2 2025": "released July 17, 2025",
};
const DESK = "Desk estimate";
const SET = "Nov 2026";

const ROWS: Record<string, Row> = {
  AL: ["Alabama", "Non-judicial", 200, DESK, SET, "Ala. Code § 35-10-1 et seq. (power of sale); one-year redemption, § 6-5-248"],
  AK: ["Alaska", "Non-judicial", 199, "ATTOM", "Q2 2026", "Alaska Stat. § 34.20.070 (deed of trust)"],
  AZ: ["Arizona", "Non-judicial", 200, DESK, SET, "A.R.S. § 33-807 et seq. (trustee sale)"],
  AR: ["Arkansas", "Non-judicial", 250, DESK, SET, "Ark. Code § 18-50-101 et seq. (Statutory Foreclosure Act)"],
  CA: ["California", "Non-judicial", 350, DESK, SET, "Cal. Civ. Code § 2924 et seq. (trustee sale)"],
  CO: ["Colorado", "Non-judicial", 300, DESK, SET, "C.R.S. § 38-38-101 et seq. (public trustee), with a C.R.C.P. 120 hearing"],
  CT: ["Connecticut", "Judicial", 1626, "ATTOM", "Q2 2026", "Conn. Gen. Stat. § 49-24 et seq. (strict foreclosure); mediation, § 49-31k"],
  DE: ["Delaware", "Judicial", 600, DESK, SET, "10 Del. C. § 5061 et seq. (scire facias sur mortgage)"],
  DC: ["District of Columbia", "Non-judicial", 600, DESK, SET, "D.C. Code § 42-815 (power of sale); mediation, § 42-815.02"],
  FL: ["Florida", "Judicial", 750, DESK, SET, "Fla. Stat. ch. 702"],
  GA: ["Georgia", "Non-judicial", 200, DESK, SET, "O.C.G.A. § 44-14-160 et seq. (power of sale)"],
  HI: ["Hawaii", "Judicial", 2293, "ATTOM", "Q2 2026", "HRS ch. 667, part I; the part II power of sale exists but is rarely used on homes"],
  ID: ["Idaho", "Non-judicial", 300, DESK, SET, "Idaho Code § 45-1502 et seq. (trustee sale)"],
  IL: ["Illinois", "Judicial", 800, DESK, SET, "735 ILCS 5/15-1101 et seq. (Mortgage Foreclosure Law)"],
  IN: ["Indiana", "Judicial", 450, DESK, SET, "Ind. Code § 32-30-10"],
  IA: ["Iowa", "Judicial", 420, DESK, SET, "Iowa Code ch. 654; the ch. 655A non-judicial route is rare"],
  KS: ["Kansas", "Judicial", 1594, "ATTOM", "Q4 2025", "K.S.A. 60-2410 et seq."],
  KY: ["Kentucky", "Judicial", 500, DESK, SET, "KRS 426.525 et seq."],
  LA: ["Louisiana", "Judicial", 3491, "ATTOM", "Q2 2026", "La. C.C.P. art. 2631 et seq. (executory process) and ordinary process"],
  ME: ["Maine", "Judicial", 900, DESK, SET, "14 M.R.S. § 6321 et seq.; mediation, § 6321-A"],
  MD: ["Maryland", "Judicial", 800, DESK, SET, "Md. Code, Real Prop. § 7-105.1 and Md. Rule 14-201 et seq. (docketed in circuit court)"],
  MA: ["Massachusetts", "Non-judicial", 600, DESK, SET, "M.G.L. c. 244 § 14 (power of sale); 150-day right to cure, § 35A"],
  MI: ["Michigan", "Non-judicial", 300, DESK, SET, "MCL 600.3201 et seq. (by advertisement); redemption, § 600.3240"],
  MN: ["Minnesota", "Non-judicial", 162, "ATTOM", "Q2 2025", "Minn. Stat. ch. 580 (by advertisement); redemption, § 580.23"],
  MS: ["Mississippi", "Non-judicial", 200, DESK, SET, "Miss. Code § 89-1-55"],
  MO: ["Missouri", "Non-judicial", 200, DESK, SET, "Mo. Rev. Stat. § 443.290 et seq."],
  MT: ["Montana", "Non-judicial", 174, "ATTOM", "Q3 2025", "Mont. Code § 71-1-301 et seq. (Small Tract Financing Act)"],
  NE: ["Nebraska", "Non-judicial", 250, DESK, SET, "Neb. Rev. Stat. § 76-1001 et seq. (Trust Deeds Act)"],
  NV: ["Nevada", "Non-judicial", 1507, "ATTOM", "Q2 2026", "NRS 107.080; mediation, NRS 107.086"],
  NH: ["New Hampshire", "Non-judicial", 157, "ATTOM", "Q2 2026", "RSA 479:25 (power of sale)"],
  NJ: ["New Jersey", "Judicial", 1200, DESK, SET, "N.J.S.A. 2A:50-53 et seq. (Fair Foreclosure Act)"],
  NM: ["New Mexico", "Judicial", 700, DESK, SET, "NMSA 1978 § 39-5-1 et seq. (judicial sale); redemption, § 39-5-18"],
  NY: ["New York", "Judicial", 2007, "ATTOM", "Q2 2026", "RPAPL art. 13; settlement conferences, CPLR 3408"],
  NC: ["North Carolina", "Non-judicial", 350, DESK, SET, "N.C. Gen. Stat. § 45-21.1 et seq. (power of sale, clerk's hearing under § 45-21.16)"],
  ND: ["North Dakota", "Judicial", 300, DESK, SET, "N.D.C.C. ch. 32-19"],
  OH: ["Ohio", "Judicial", 500, DESK, SET, "Ohio Rev. Code ch. 2323"],
  OK: ["Oklahoma", "Judicial", 450, DESK, SET, "12 O.S. § 686; the power of sale under 46 O.S. § 40 et seq. is rare on homes"],
  OR: ["Oregon", "Non-judicial", 450, DESK, SET, "ORS 86.705 et seq. (Trust Deed Act); mediation, ORS 86.726"],
  PA: ["Pennsylvania", "Judicial", 650, DESK, SET, "Pa. R.C.P. 1141 et seq.; Act 91 notice, 35 P.S. § 1680.403c"],
  RI: ["Rhode Island", "Non-judicial", 219, "ATTOM", "Q1 2026", "R.I. Gen. Laws § 34-11-22 (power of sale); mediation, § 34-27-3.2"],
  SC: ["South Carolina", "Judicial", 450, DESK, SET, "S.C. Code tit. 29, ch. 3 (judicial sale by the master in equity)"],
  SD: ["South Dakota", "Non-judicial", 300, DESK, SET, "SDCL ch. 21-48 (power of sale); judicial under ch. 21-47"],
  TN: ["Tennessee", "Non-judicial", 200, DESK, SET, "Tenn. Code § 35-5-101 et seq."],
  TX: ["Texas", "Non-judicial", 155, "ATTOM", "Q2 2026", "Tex. Prop. Code § 51.002"],
  UT: ["Utah", "Non-judicial", 250, DESK, SET, "Utah Code § 57-1-19 et seq. (trust deeds)"],
  VT: ["Vermont", "Judicial", 700, DESK, SET, "12 V.S.A. § 4941 et seq."],
  VA: ["Virginia", "Non-judicial", 160, "ATTOM", "Q3 2025", "Va. Code § 55.1-320 et seq."],
  WA: ["Washington", "Non-judicial", 450, DESK, SET, "RCW 61.24 (Deeds of Trust Act); mediation, RCW 61.24.163"],
  WV: ["West Virginia", "Non-judicial", 196, "ATTOM", "Q2 2026", "W. Va. Code § 38-1-3 et seq."],
  WI: ["Wisconsin", "Judicial", 600, DESK, SET, "Wis. Stat. ch. 846"],
  WY: ["Wyoming", "Non-judicial", 173, "ATTOM", "Q2 2026", "Wyo. Stat. § 34-4-101 et seq."],
};

const DAYS_PER_MONTH = 30.44;

// Legal, court, trustee and publication costs through the sale: a base by process, plus about $200 for each month a
// case runs past a year (continuances, mediation, motions), capped at $12,000 extra and rounded to $500. A desk
// estimate, not a quote.
export function processCost(process: ForeclosureProcess | "Unknown", days: number) {
  const base = process === "Non-judicial" ? 4500 : 9000;
  const extra = Math.min(12000, (Math.max(0, days - 365) / DAYS_PER_MONTH) * 200);
  return Math.round((base + extra) / 500) * 500;
}

function sourceLine(basis: ForeclosureRule["basis"], asOf: string) {
  if (basis === "ATTOM") return `ATTOM average for homes foreclosed in ${asOf}, ${ATTOM_RELEASES[asOf] ?? ""}`.replace(/, $/, "");
  if (basis === "National average") return `ATTOM national average for ${NATIONAL_AS_OF}, ${ATTOM_RELEASES[NATIONAL_AS_OF]}`;
  return "Desk estimate from state law and court backlog, not an ATTOM figure";
}

function build(row: Row): ForeclosureRule {
  const [name, process, days, basis, asOf, law] = row;
  return {
    name,
    process,
    days,
    months: Math.round(days / DAYS_PER_MONTH),
    cost: processCost(process, days),
    basis,
    asOf,
    source: sourceLine(basis, asOf),
    law,
  };
}

export const FORECLOSURE_TABLE: Record<string, ForeclosureRule> = Object.fromEntries(
  Object.entries(ROWS).map(([code, row]) => [code, build(row)]),
);

const BY_NAME = new Map(Object.entries(ROWS).map(([code, row]) => [row[0].toUpperCase(), code]));

export function stateCode(state: string) {
  const text = (state || "").trim().toUpperCase();
  if (FORECLOSURE_TABLE[text]) return text;
  return BY_NAME.get(text) ?? text;
}

// Unknown codes (territories, typos, blanks) get the national average, marked assumed. No state stands in for
// another.
export function foreclosureFor(state: string): ForeclosureRule & { state: string; assumed: boolean } {
  const code = stateCode(state);
  const rule = FORECLOSURE_TABLE[code];
  if (rule) return { ...rule, state: code, assumed: false };
  return {
    name: "National average",
    process: "Unknown",
    days: NATIONAL_AVERAGE_DAYS,
    months: Math.round(NATIONAL_AVERAGE_DAYS / DAYS_PER_MONTH),
    cost: processCost("Unknown", NATIONAL_AVERAGE_DAYS),
    basis: "National average",
    asOf: NATIONAL_AS_OF,
    source: sourceLine("National average", NATIONAL_AS_OF),
    law: "State not recognised, so no state law applies",
    state: code,
    assumed: true,
  };
}

// Whole months between two dates, in 30.44-day months, the way the scenario model counts them. Null for a missing
// or unreadable date.
export function monthsSince(from: Date | string | null | undefined, now = new Date()) {
  if (!from) return null;
  const date = typeof from === "string" ? new Date(from) : from;
  if (Number.isNaN(date.getTime())) return null;
  return Math.round((now.getTime() - date.getTime()) / (DAYS_PER_MONTH * 24 * 60 * 60 * 1000));
}

// The model never runs a filed case shorter than this, however long it has been open.
export const MIN_MONTHS_LEFT = 2;

export type ForeclosureProgress = {
  filedAt: string;
  monthsIn: number;
  // Months left of the state's average, never below MIN_MONTHS_LEFT.
  monthsLeft: number;
  // The case is already older than the state's average.
  pastAverage: boolean;
  line: string;
};

function basisShort(rule: ForeclosureRule) {
  if (rule.basis === "ATTOM") return `ATTOM, ${rule.asOf}`;
  if (rule.basis === "National average") return `ATTOM national average, ${NATIONAL_AS_OF}`;
  return "desk estimate";
}

// A filed foreclosure's place on the state timeline. Inventory is ageing in the pipeline (ICE, September 2026:
// foreclosure inventory up 37% while starts fell 3%), so a buyer needs the months left, not only the months behind.
// Null when nothing is filed, or the date is in the future.
export function foreclosureProgress(rule: ForeclosureRule & { state: string; assumed: boolean }, filedAt: Date | string | null | undefined, now = new Date()): ForeclosureProgress | null {
  const monthsIn = monthsSince(filedAt, now);
  if (monthsIn == null || monthsIn < 0 || !filedAt) return null;
  const date = typeof filedAt === "string" ? new Date(filedAt) : filedAt;
  const pastAverage = monthsIn >= rule.months;
  const monthsLeft = Math.max(MIN_MONTHS_LEFT, rule.months - monthsIn);
  const where = rule.assumed ? "the national average" : `the ${rule.name} average`;
  const line = pastAverage
    ? `${monthsIn} months in foreclosure, past ${where} of ${rule.months} months (${basisShort(rule)}). The model allows ${monthsLeft} more months to the sale.`
    : `${monthsIn} months in foreclosure. About ${monthsLeft} months left of ${where} of ${rule.months} months (${basisShort(rule)}).`;
  return { filedAt: date.toISOString().slice(0, 10), monthsIn, monthsLeft, pastAverage, line };
}

// One plain line for a page or a memo: where, which route, how long, and on what basis.
export function timelineLine(rule: ForeclosureRule & { state: string; assumed: boolean }) {
  const days = rule.days.toLocaleString("en-US");
  if (rule.assumed) {
    return `State not recognised, so this uses the national average: about ${rule.months} months (${days} days). ${rule.source}.`;
  }
  return `${rule.name} · ${rule.process.toLowerCase()} · about ${rule.months} months (${days} days) from first filing to completion. ${rule.source}.`;
}
