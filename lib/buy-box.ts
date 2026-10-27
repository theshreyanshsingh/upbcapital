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
};

export type BoxScore = { score: number; reasons: string[] };

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
      box.targetYield != null,
  );
}

export function scoreAgainstBox(notes: ScoreNote[], box: BoxCriteria): BoxScore | null {
  if (!notes.length || !boxHasConstraint(box)) return null;
  const upb = notes.reduce((sum, note) => sum + note.upb, 0);
  const price = notes.reduce((sum, note) => sum + note.askingPrice, 0);
  if (upb <= 0 || price <= 0) return null;
  const reasons: string[] = [];
  if (box.states.length) {
    const covered = share(notes, (note) => box.states.includes(note.state));
    if (covered < 0.5) return null;
    reasons.push(covered >= 0.999 ? "State fits" : `${Math.round(covered * 100)}% of UPB is in the states`);
  }
  if (box.liens.length) {
    const covered = share(notes, (note) => box.liens.includes(note.lienPosition));
    if (covered < 0.5) return null;
    reasons.push("Lien fits");
  }
  if (box.statuses.length) {
    const covered = share(notes, (note) => box.statuses.includes(note.paymentStatus));
    if (covered < 0.5) return null;
    reasons.push("Performance fits");
  }
  if (box.upbMin != null && upb < box.upbMin) return null;
  if (box.upbMax != null && upb > box.upbMax) return null;
  if (box.upbMin != null || box.upbMax != null) reasons.push("UPB is in range");
  if (box.priceMin != null && price < box.priceMin) return null;
  if (box.priceMax != null && price > box.priceMax) return null;
  if (box.priceMin != null || box.priceMax != null) reasons.push("Price is in range");
  const priceToUpb = (price / upb) * 100;
  if (box.maxPriceToUpb != null && priceToUpb > box.maxPriceToUpb + 0.05) return null;
  if (box.maxPriceToUpb != null) reasons.push(`${priceToUpb.toFixed(0)}% of UPB`);
  const irr = poolIrr(notes);
  if (box.targetYield != null && (irr == null || irr + 0.05 < box.targetYield)) return null;
  if (box.targetYield != null && irr != null) reasons.push(`${irr.toFixed(1)}% IRR`);

  let score = 55;
  if (box.states.length && share(notes, (note) => box.states.includes(note.state)) >= 0.999) score += 10;
  if (box.maxPriceToUpb != null && box.maxPriceToUpb - priceToUpb >= 10) score += 15;
  if (box.targetYield != null && irr != null && irr - box.targetYield >= 2) score += 15;
  if (reasons.length >= 3) score += 5;
  return { score: Math.min(100, score), reasons };
}

export function parseList(raw: string) {
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}
