import { MIN_TRADES, type CompCell } from "@/lib/comps";
import { prettyDate } from "@/lib/format";
import { headlinePrices, pricingValue, type PricingNote, type ValueEstimate } from "@/lib/underwriting";

// An indicative price for a listing: the desk model at a set yield, the closed-trade comps median, and the top
// standing buy-box bid, each as a percent of UPB, folded into one range with its basis and date. The pure helpers
// here are safe to import in a client tree; the loaders at the bottom read the database through dynamic imports.

// The yield the book's indicative price is solved for when the desk hasn't set one. Forum sellers price near 9% and
// buyers expect about 12% (BiggerPockets, 2026), so the default sits with the buyer.
export const DEFAULT_INDICATIVE_YIELD = 12;
// The model's own band: its price one point of IRR either side of the target.
export const MODEL_BAND_POINTS = 1;
// A 10-year rate older than this reads as stale on every spread-based figure.
export const RATE_STALE_DAYS = 7;

export const INDICATIVE_DISCLAIMER = "An estimate from the desk's model and UPB's own trades and standing bids. Not an appraisal, an offer or advice.";

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

// "an 11.95% IRR", "a 12% IRR": the article follows how the figure is said.
export function articleFor(figure: number | string) {
  return /^(8|11|18)(\.|$)|^8\d/.test(String(figure)) ? "an" : "a";
}

// ---------------------------------------------------------------------------------------------------------------
// The 10-year rate.

export type MarketRate = { rate: number; asOf: Date };

// The desk's 10-year Treasury rate, or null until both the rate and its date are on file.
export function marketRate(settings: { tenYearRate?: number | null; tenYearAsOf?: Date | string | null } | null | undefined): MarketRate | null {
  const asOf = toDate(settings?.tenYearAsOf);
  const rate = settings?.tenYearRate;
  if (rate == null || !Number.isFinite(rate) || !(rate > 0) || !asOf) return null;
  return { rate, asOf };
}

// Older than RATE_STALE_DAYS. A missing date is stale too.
export function rateStale(asOf: Date | string | null | undefined, now = new Date()) {
  const date = toDate(asOf);
  if (!date) return true;
  return now.getTime() - date.getTime() > RATE_STALE_DAYS * DAY_MS;
}

export type RateStamp = { asOf: string; text: string; stale: boolean };

// "rate as of Nov 3, 2026", and whether it shows in the warn colour.
export function rateStamp(asOf: Date | string | null | undefined, now = new Date()): RateStamp | null {
  const date = toDate(asOf);
  if (!date) return null;
  return { asOf: isoDay(date), text: `rate as of ${prettyDate(date)}`, stale: rateStale(date, now) };
}

// The target the book's indicative price solves for, and whether it is the default.
export function indicativeTarget(setting: number | null | undefined) {
  const set = setting != null && Number.isFinite(setting) && setting > 0 && setting < 100;
  const target = set ? setting : DEFAULT_INDICATIVE_YIELD;
  return { target, assumed: !set, label: set ? `${target}% IRR, set by the desk` : `${target}% IRR, the desk's default` };
}

// ---------------------------------------------------------------------------------------------------------------
// The range.

// A loan as the indicative prices it. avm is a value estimate already cleared by showableAvm, or nothing.
export type IndicativeNote = PricingNote & {
  avm?: ValueEstimate | null;
  valueType?: string | null;
  valueAsOf?: Date | string | null;
};

// One standing price, with nothing that names its buyer or box.
export type StandingPoint = { price: number; rateAsOf?: Date | string | null; pricedAt?: Date | string | null };

export type IndicativeSource = {
  key: "model" | "comps" | "standing";
  label: string;
  // The point this source puts on the range, and the band it adds, all in percent of UPB.
  ofUpb: number;
  low: number;
  high: number;
  count: number | null;
  basis: string;
  asOf: string;
  // Spread-priced standing bids only.
  rate: RateStamp | null;
};

export type IndicativeResult = {
  // Whole percent of UPB.
  low: number;
  high: number;
  lowPrice: number;
  highPrice: number;
  upb: number;
  sources: IndicativeSource[];
  basis: string;
  valueBasis: string;
  asOf: string;
  rate: RateStamp | null;
  disclaimer: string;
};

export type IndicativeInput = {
  notes: IndicativeNote[];
  // The desk's indicativeTargetYield. Missing means DEFAULT_INDICATIVE_YIELD.
  targetYield?: number | null;
  // From compsFor(). Used only with MIN_TRADES or more trades behind it.
  comps?: CompCell | null;
  compsWindowMonths?: number;
  standing?: StandingPoint[];
  // The buyer premium, so the model's bid holds its yield on what the buyer pays, as a standing yield rule does.
  premiumBps?: number;
  now?: Date;
  // Past this many loans the model is left out, so a big tape doesn't hold up a list page.
  modelLimit?: number;
};

export const MODEL_LIMIT = 500;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function share(amount: number, upb: number) {
  return (amount / upb) * 100;
}

function valueBasisOf(labels: { source: string; label: string }[]) {
  const known = labels.filter((row) => row.source !== "none");
  if (!known.length) return "No value on file, so there is no current LTV.";
  if (known.length < labels.length) return `${labels.length - known.length} of ${labels.length} loans have no value on file.`;
  const estimates = labels.filter((row) => row.source === "estimate").length;
  if (labels.length === 1) return `Priced on current LTV from the ${labels[0].label}.`;
  if (estimates === labels.length) return "Priced on current LTV from value estimates on every loan.";
  if (estimates === 0) return "Priced on current LTV from the seller's values.";
  return `Priced on current LTV from value estimates on ${estimates} of ${labels.length} loans and the seller's values on the rest.`;
}

// The desk model's bid for the whole listing at the target and one point either side, in percent of UPB. Null when
// any loan has no price, since a listing trades whole.
export function modelBand(notes: IndicativeNote[], target: number, premiumBps = 0, now = new Date()) {
  const upb = notes.reduce((sum, note) => sum + Math.max(0, note.upb), 0);
  if (!(upb > 0) || !notes.length) return null;
  const targets = [target + MODEL_BAND_POINTS, target, Math.max(0.5, target - MODEL_BAND_POINTS)];
  const sums = [0, 0, 0];
  const values: { source: string; label: string }[] = [];
  for (const note of notes) {
    if (![note.upb, note.interestRate, note.monthlyPi].every(Number.isFinite)) return null;
    const value = pricingValue(note.estimatedValue, note.avm, { type: note.valueType, asOf: note.valueAsOf });
    values.push(value);
    const bids = headlinePrices({ ...note, estimatedValue: value.value }, targets, { premiumBps, now });
    if (bids.some((bid) => bid == null || !(bid > 0))) return null;
    bids.forEach((bid, index) => (sums[index] += bid as number));
  }
  return { low: share(sums[0], upb), mid: share(sums[1], upb), high: share(sums[2], upb), valueBasis: valueBasisOf(values) };
}

// Folds the three sources into one range. Null when none of them can price.
export function indicativeRange(input: IndicativeInput): IndicativeResult | null {
  const now = input.now ?? new Date();
  const today = isoDay(now);
  const upb = input.notes.reduce((sum, note) => sum + Math.max(0, note.upb), 0);
  if (!(upb > 0)) return null;
  const goal = indicativeTarget(input.targetYield);
  const sources: IndicativeSource[] = [];

  const model = input.notes.length <= (input.modelLimit ?? MODEL_LIMIT) ? modelBand(input.notes, goal.target, input.premiumBps ?? 0, now) : null;
  if (model) {
    const fees = input.premiumBps ? `, after the ${(input.premiumBps / 100).toFixed(2)}% buyer premium` : "";
    sources.push({
      key: "model",
      label: `Desk model at ${goal.target - MODEL_BAND_POINTS}–${goal.target + MODEL_BAND_POINTS}% IRR`,
      ofUpb: model.mid,
      low: model.low,
      high: model.high,
      count: null,
      basis: `The bid for ${articleFor(goal.target)} ${goal.label}${fees}, with the band one point either side. Performing loans on their contract; others on weighted resolutions over the state foreclosure timeline. ${model.valueBasis}`,
      asOf: today,
      rate: null,
    });
  }

  const comps = input.comps;
  if (comps && comps.count >= MIN_TRADES) {
    const window = input.compsWindowMonths ?? 24;
    sources.push({
      key: "comps",
      label: `Median of ${plural(comps.count, "closed trade")}`,
      ofUpb: comps.median,
      low: comps.median,
      high: comps.median,
      count: comps.count,
      basis: `${comps.label}, closed on UPB in the ${window} months to ${prettyDate(now)}. Gross price over UPB, before the buyer premium. Trades ranged ${comps.low}–${comps.high}%.`,
      asOf: today,
      rate: null,
    });
  }

  const standing = (input.standing ?? []).filter((row) => Number.isFinite(row.price) && row.price > 0);
  if (standing.length) {
    const top = standing.reduce((best, row) => (row.price > best.price ? row : best));
    const point = share(top.price, upb);
    const priced = toDate(top.pricedAt) ?? now;
    sources.push({
      key: "standing",
      label: standing.length === 1 ? "One standing bid" : `Top of ${plural(standing.length, "standing bid")}`,
      ofUpb: point,
      low: point,
      high: point,
      count: standing.length,
      basis: `${standing.length === 1 ? "A buy box's standing price" : "The highest buy-box standing price"}, capped at the ask, as of ${prettyDate(priced)}. Indicative until a buyer confirms it as a bid. No bidder is named.`,
      asOf: isoDay(priced),
      rate: rateStamp(top.rateAsOf, now),
    });
  }

  if (!sources.length) return null;
  const low = Math.floor(Math.min(...sources.map((row) => row.low)));
  const high = Math.ceil(Math.max(...sources.map((row) => row.high)));
  const rate = sources.find((row) => row.rate)?.rate ?? null;
  return {
    low,
    high,
    lowPrice: Math.round((upb * low) / 100),
    highPrice: Math.round((upb * high) / 100),
    upb,
    sources,
    basis: `${sources.map((row, index) => (index ? row.label.charAt(0).toLowerCase() + row.label.slice(1) : row.label)).join(", ")}, as of ${prettyDate(now)}.`,
    valueBasis: model?.valueBasis ?? "",
    asOf: today,
    rate,
    disclaimer: INDICATIVE_DISCLAIMER,
  };
}

// The compact form for a card or a table cell.
export function indicativeText(result: Pick<IndicativeResult, "low" | "high"> | null) {
  if (!result) return null;
  return result.low === result.high ? `indicative ${result.low}% of UPB` : `indicative ${result.low}–${result.high}% of UPB`;
}

// A pool takes the comps of the lien, performance and state that hold the most of its UPB.
export function compSubjectOf(notes: { upb: number; lienPosition?: string | null; paymentStatus?: string | null; state?: string | null }[]) {
  const top = (pick: (note: (typeof notes)[number]) => string) => {
    const shares = new Map<string, number>();
    for (const note of notes) shares.set(pick(note), (shares.get(pick(note)) ?? 0) + Math.max(0, note.upb));
    return [...shares.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };
  return {
    lienPosition: top((note) => note.lienPosition ?? "FIRST"),
    paymentStatus: top((note) => note.paymentStatus ?? "PERFORMING"),
    state: top((note) => (note.state ?? "").toUpperCase()),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Price against time to sell: the seller's ask against standing demand and comps. Standing demand is what could
// confirm as soon as the listing is live; comps are what notes like it took to sell through the book.

export type LadderRow = { ofUpb: number; price: number; atOrAbove: number; tags: string[] };

export type PriceLadder = {
  askOfUpb: number | null;
  upb: number;
  rows: LadderRow[];
  standingCount: number;
  // Buy boxes that fit at the ask, with or without a standing price.
  fits: number;
  summary: string;
  comps: { median: number; low: number; high: number; count: number; label: string } | null;
  model: { low: number; mid: number; high: number; label: string } | null;
  // The oldest spread rate behind any standing price counted here.
  rate: RateStamp | null;
  asOf: string;
  basis: string;
  disclaimer: string;
};

export type LadderInput = {
  upb: number;
  ask: number;
  // Each box's own price for the loans, before the ask caps it.
  standing: StandingPoint[];
  comps?: CompCell | null;
  model?: { low: number; mid: number; high: number } | null;
  targetYield?: number | null;
  fits?: number;
  now?: Date;
};

function roundPct(value: number) {
  return Math.round(value * 10) / 10;
}

function fmtPct(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function ladderSummary(askOfUpb: number | null, levels: number[]) {
  const count = levels.length;
  if (!count) return "No standing bid fits this paper yet.";
  if (askOfUpb == null) return `${plural(count, "standing bid")} fit${count === 1 ? "s" : ""} this paper. Enter an ask to place it against them.`;
  const below = levels.filter((level) => level < askOfUpb - 1e-9).length;
  const one = count === 1;
  if (below === 0) {
    return one
      ? `At ${fmtPct(askOfUpb)} of UPB, the one standing bid would be at or above your ask.`
      : `At ${fmtPct(askOfUpb)} of UPB, all ${count} standing bids would be at or above your ask.`;
  }
  const floor = Math.floor(Math.min(...levels));
  if (one) return `At ${fmtPct(askOfUpb)} of UPB, the one standing bid would be below your ask; at ${floor}% it would be at or above.`;
  return `At ${fmtPct(askOfUpb)} of UPB, ${below} standing bid${below === 1 ? "" : "s"} would be below your ask; at ${floor}% all would be at or above.`;
}

export function priceLadder(input: LadderInput): PriceLadder {
  const now = input.now ?? new Date();
  const upb = Math.max(0, input.upb);
  const askOfUpb = upb > 0 && input.ask > 0 ? roundPct(share(input.ask, upb)) : null;
  const points = input.standing.filter((row) => Number.isFinite(row.price) && row.price > 0);
  const levels = upb > 0 ? points.map((row) => share(row.price, upb)) : [];
  const goal = indicativeTarget(input.targetYield);
  const comps = input.comps && input.comps.count >= MIN_TRADES ? input.comps : null;
  // Whole-percent rungs, each standing price taken down to the percent below it, so no rung shows a buyer's figure
  // more finely than that.
  const rungs = new Map<number, Set<string>>();
  const add = (level: number, tag?: string) => {
    if (!Number.isFinite(level) || level <= 0) return;
    const key = roundPct(level);
    const tags = rungs.get(key) ?? new Set<string>();
    if (tag) tags.add(tag);
    rungs.set(key, tags);
  };
  if (askOfUpb != null) add(askOfUpb, "Your ask");
  for (const level of levels) add(Math.floor(level));
  if (comps) add(comps.median, "Comps median");
  if (input.model) add(roundPct(input.model.mid), `Desk model at ${goal.target}%`);
  const rows = [...rungs.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 10)
    .map(([ofUpb, tags]) => ({
      ofUpb,
      price: Math.round((upb * ofUpb) / 100),
      atOrAbove: levels.filter((level) => level >= ofUpb - 1e-9).length,
      tags: [...tags],
    }));
  // The oldest rate behind a counted price is the one that most needs saying.
  const rated = points.map((row) => toDate(row.rateAsOf)).filter((date): date is Date => date != null).sort((a, b) => a.getTime() - b.getTime());
  return {
    askOfUpb,
    upb,
    rows,
    standingCount: points.length,
    fits: input.fits ?? points.length,
    summary: ladderSummary(askOfUpb, levels),
    comps: comps ? { median: comps.median, low: comps.low, high: comps.high, count: comps.count, label: comps.label } : null,
    model: input.model ? { ...input.model, label: `Desk model at ${goal.label}` } : null,
    rate: rated.length ? rateStamp(rated[0], now) : null,
    asOf: isoDay(now),
    basis: `Standing bids are buy boxes on UPB that fit this paper, at each box's own price before your ask caps it. They are indicative, and each buyer confirms before anything binds. Comps are closed trades on UPB, shown only with ${MIN_TRADES} or more. As of ${prettyDate(now)}.`,
    disclaimer: INDICATIVE_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Loaders. Server only: each reads the database through a dynamic import, so the helpers above stay safe anywhere.

export type LoaderNote = {
  upb: number;
  interestRate: number;
  monthlyPi: number;
  estimatedValue: number;
  state: string;
  paymentStatus: string;
  occupancy: string;
  lienPosition: string;
  monthsDelinquent: number;
  maturityDate: Date | null;
  foreclosureFiledAt?: Date | null;
  avmValue: number | null;
  avmProvider: string;
  avmAsOf: Date | null;
  valueType?: string | null;
  valueAsOf?: Date | null;
  seniorLienBalance?: number | null;
  tradeStatus: string;
};

export type LoaderListing = { id: string; status: string; notes: LoaderNote[] };

// Indicative ranges for many listings at once, with one read of settings, trades and standing prices. A listing
// prices the loans still for sale. Standing prices count only while nobody has answered them: a pass is no demand,
// and a confirmed one is a bid, not an indicative. Nothing read here names a buyer or a box. `standing: false` leaves
// standing prices out, for a desk role behind the sealed-bid wall (lib/auction.ts deskWalled).
export async function loadIndicatives(listings: LoaderListing[], now = new Date(), options: { standing?: boolean } = {}): Promise<Map<string, IndicativeResult>> {
  const result = new Map<string, IndicativeResult>();
  if (!listings.length) return result;
  const [{ prisma }, { getSettings }, { loadClosedTrades, compsFor, COMP_WINDOW_MONTHS }, { showableAvm }, { unset }, { loansForSale }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/settings"),
    import("@/lib/comps"),
    import("@/lib/enrichment"),
    import("@/lib/db-filters"),
    import("@/lib/metrics"),
  ]);
  const [settings, trades, matches] = await Promise.all([
    getSettings(),
    loadClosedTrades(now).catch(() => []),
    options.standing === false
      ? Promise.resolve([])
      : prisma.listingMatch.findMany({
          where: { listingId: { in: listings.map((listing) => listing.id) }, indicativePrice: { not: null }, ...unset("answeredAt") },
          select: { listingId: true, indicativePrice: true, indicativeAt: true, rateAsOf: true },
        }),
  ]);
  const standing = new Map<string, StandingPoint[]>();
  for (const match of matches) {
    if (match.indicativePrice == null) continue;
    standing.set(match.listingId, [...(standing.get(match.listingId) ?? []), { price: match.indicativePrice, pricedAt: match.indicativeAt, rateAsOf: match.rateAsOf }]);
  }
  for (const listing of listings) {
    const loans = loansForSale(listing.status, listing.notes);
    const notes: IndicativeNote[] = loans.map((note) => ({
      upb: note.upb,
      interestRate: note.interestRate,
      monthlyPi: note.monthlyPi,
      estimatedValue: note.estimatedValue,
      state: note.state,
      paymentStatus: note.paymentStatus,
      occupancy: note.occupancy,
      lienPosition: note.lienPosition,
      monthsDelinquent: note.monthsDelinquent,
      maturityDate: note.maturityDate,
      foreclosureFiledAt: note.foreclosureFiledAt ?? null,
      // A junior lien's combined LTV uses the tape's senior balance when it carries one.
      seniorBalance: note.seniorLienBalance ?? null,
      avm: { value: showableAvm({ avmValue: note.avmValue, avmProvider: note.avmProvider }), provider: note.avmProvider, asOf: note.avmAsOf },
      valueType: note.valueType ?? null,
      valueAsOf: note.valueAsOf ?? null,
    }));
    const range = indicativeRange({
      notes,
      targetYield: settings.indicativeTargetYield,
      comps: notes.length ? compsFor(compSubjectOf(notes), trades) : null,
      compsWindowMonths: COMP_WINDOW_MONTHS,
      standing: standing.get(listing.id) ?? [],
      premiumBps: settings.buyerPremiumBps,
      now,
    });
    if (range) result.set(listing.id, range);
  }
  return result;
}

// One listing's range, for its page.
export async function loadIndicative(listingId: string, now = new Date(), options: { standing?: boolean } = {}): Promise<IndicativeResult | null> {
  const { prisma } = await import("@/lib/prisma");
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, status: true, notes: true } });
  if (!listing) return null;
  return (await loadIndicatives([listing], now, options)).get(listing.id) ?? null;
}
