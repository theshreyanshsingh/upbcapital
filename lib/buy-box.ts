import { performingCase } from "@/lib/underwriting";

export type BoxCriteria = {
  states: string[];
  liens: string[];
  statuses: string[];
  upbMin: number | null;
  upbMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  maxPriceToUpb: number | null;
  targetYield: number | null;
  // The highest loan to value the box takes, in percent, and the fewest months since origination. Optional, so a
  // box saved before these existed reads as no limit.
  maxLtv?: number | null;
  minSeasoningMonths?: number | null;
};

export type ScoreNote = {
  state: string;
  lienPosition: string;
  paymentStatus: string;
  upb: number;
  askingPrice: number;
  monthlyPi: number;
  interestRate: number;
  termMonths?: number;
  // The seller's estimated value, for the LTV limit. Left out, the LTV can't be checked.
  estimatedValue?: number;
  // Whole months since the loan was made, or null when the tape has no origination date.
  seasoningMonths?: number | null;
};

export type BoxScore = { score: number; reasons: string[] };

// A fit with its reasons, or the first limit the paper misses, in words.
export type BoxFit = ({ fit: true } & BoxScore) | { fit: false; reason: string };

// Whole months from origination to now. A loan made on the 20th has a month of seasoning on the next 20th.
export function seasoningMonths(originationDate: Date | null | undefined, now = new Date()) {
  if (!originationDate || Number.isNaN(originationDate.getTime())) return null;
  const months = (now.getUTCFullYear() - originationDate.getUTCFullYear()) * 12 + (now.getUTCMonth() - originationDate.getUTCMonth());
  return Math.max(0, now.getUTCDate() < originationDate.getUTCDate() ? months - 1 : months);
}

// The pool's LTV as the book shows it: total UPB over total estimated value, in percent.
export function boxLtv(notes: ScoreNote[]) {
  if (notes.some((note) => note.estimatedValue === undefined)) return null;
  const value = notes.reduce((sum, note) => sum + (note.estimatedValue ?? 0), 0);
  if (!(value > 0)) return null;
  return (notes.reduce((sum, note) => sum + note.upb, 0) / value) * 100;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function poolIrr(notes: ScoreNote[]) {
  const upb = notes.reduce((sum, note) => sum + note.upb, 0);
  const price = notes.reduce((sum, note) => sum + note.askingPrice, 0);
  const monthly = notes.reduce((sum, note) => sum + note.monthlyPi, 0);
  if (upb <= 0 || price <= 0 || monthly <= 0) return null;
  const rate = notes.reduce((sum, note) => sum + note.interestRate * note.upb, 0) / upb;
  const term = notes.reduce((sum, note) => sum + (note.termMonths || 360) * note.upb, 0) / upb;
  return performingCase({
    bid: price,
    upb,
    annualRate: rate,
    monthlyPi: monthly,
    termMonths: Math.round(term) || 360,
  }).irrPct;
}

function share(notes: ScoreNote[], pick: (note: ScoreNote) => boolean) {
  const total = notes.reduce((sum, note) => sum + note.upb, 0);
  if (total <= 0) return 0;
  return notes.filter(pick).reduce((sum, note) => sum + note.upb, 0) / total;
}

export function boxHasConstraint(box: BoxCriteria) {
  return Boolean(
    box.states.length ||
      box.liens.length ||
      box.statuses.length ||
      box.upbMin != null ||
      box.upbMax != null ||
      box.priceMin != null ||
      box.priceMax != null ||
      box.maxPriceToUpb != null ||
      box.targetYield != null ||
      box.maxLtv != null ||
      box.minSeasoningMonths != null,
  );
}

export function scoreAgainstBox(notes: ScoreNote[], box: BoxCriteria): BoxScore | null {
  const result = assessAgainstBox(notes, box);
  return result.fit ? { score: result.score, reasons: result.reasons } : null;
}

// The box test. A pool fits a place, lien, performance or seasoning limit when at least half its UPB does, and a
// balance, price, ratio, IRR or LTV limit on its totals.
export function assessAgainstBox(notes: ScoreNote[], box: BoxCriteria): BoxFit {
  const miss = (reason: string): BoxFit => ({ fit: false, reason });
  if (!notes.length) return miss("There are no loans to score.");
  if (!boxHasConstraint(box)) return miss("The box has no limits to score against.");
  const upb = notes.reduce((sum, note) => sum + note.upb, 0);
  const price = notes.reduce((sum, note) => sum + note.askingPrice, 0);
  if (upb <= 0 || price <= 0) return miss("The tape has no balance or price to score.");
  const reasons: string[] = [];
  if (box.states.length) {
    const covered = share(notes, (note) => box.states.includes(note.state));
    if (covered < 0.5) return miss("Less than half the UPB is in the box's states.");
    reasons.push(covered >= 0.999 ? "State fits" : `${Math.round(covered * 100)}% of UPB is in the states`);
  }
  if (box.liens.length) {
    const covered = share(notes, (note) => box.liens.includes(note.lienPosition));
    if (covered < 0.5) return miss("Less than half the UPB is in the box's lien positions.");
    reasons.push("Lien fits");
  }
  if (box.statuses.length) {
    const covered = share(notes, (note) => box.statuses.includes(note.paymentStatus));
    if (covered < 0.5) return miss("Less than half the UPB has the box's performance.");
    reasons.push("Performance fits");
  }
  if ((box.upbMin != null && upb < box.upbMin) || (box.upbMax != null && upb > box.upbMax)) return miss("The UPB is outside the box's range.");
  if (box.upbMin != null || box.upbMax != null) reasons.push("UPB is in range");
  if ((box.priceMin != null && price < box.priceMin) || (box.priceMax != null && price > box.priceMax)) return miss("The price is outside the box's range.");
  if (box.priceMin != null || box.priceMax != null) reasons.push("Price is in range");
  const priceToUpb = (price / upb) * 100;
  if (box.maxPriceToUpb != null && priceToUpb > box.maxPriceToUpb + 0.05) return miss(`At ${priceToUpb.toFixed(0)}% of UPB, the price is over the box's ${box.maxPriceToUpb}%.`);
  if (box.maxPriceToUpb != null) reasons.push(`${priceToUpb.toFixed(0)}% of UPB`);
  const irr = poolIrr(notes);
  if (box.targetYield != null && (irr == null || irr + 0.05 < box.targetYield)) return miss("The IRR at this price is under the box's target.");
  if (box.targetYield != null && irr != null) reasons.push(`${irr.toFixed(1)}% IRR`);
  if (box.maxLtv != null) {
    const ltv = boxLtv(notes);
    if (ltv == null) return miss("No estimated value is on file, so the LTV can't be checked.");
    if (ltv > box.maxLtv + 0.05) return miss(`The LTV of ${ltv.toFixed(0)}% is over the box's ${box.maxLtv}%.`);
    reasons.push(`${ltv.toFixed(0)}% LTV`);
  }
  if (box.minSeasoningMonths != null) {
    const min = box.minSeasoningMonths;
    // A loan with no origination date can't show its seasoning, so it never counts as seasoned.
    const undated = notes.filter((note) => note.seasoningMonths == null).length;
    const seasoned = share(notes, (note) => note.seasoningMonths != null && note.seasoningMonths >= min);
    if (notes.length === 1 && undated) return miss(`No origination date is on file, so the loan can't show ${min} months of seasoning.`);
    if (notes.length === 1 && seasoned < 0.5) return miss(`Seasoned ${notes[0].seasoningMonths} months, under the box's ${min}.`);
    if (seasoned < 0.5) {
      return miss(`Less than half the UPB is seasoned ${min} months or more.${undated ? ` ${plural(undated, "loan has", "loans have")} no origination date.` : ""}`);
    }
    reasons.push(seasoned >= 0.999 ? `Seasoned ${min}+ months` : `${Math.round(seasoned * 100)}% of UPB seasoned ${min}+ months`);
    if (undated) reasons.push(`${plural(undated, "loan has", "loans have")} no origination date`);
  }

  let score = 55;
  if (box.states.length && share(notes, (note) => box.states.includes(note.state)) >= 0.999) score += 10;
  if (box.maxPriceToUpb != null && box.maxPriceToUpb - priceToUpb >= 10) score += 15;
  if (box.targetYield != null && irr != null && irr - box.targetYield >= 2) score += 15;
  if (reasons.length >= 3) score += 5;
  return { fit: true, score: Math.min(100, score), reasons };
}

export function parseList(raw: string) {
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}
