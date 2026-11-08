import { applyBps, bpsToPercent, dollarsToCents, feeBreakdown, percentToBps, typedNumber } from "@/lib/money";

// The desk's fees, flat or graded by the size of the sale. Every fee the app charges or shows is worked out by
// chargeFees below, through feesFor when the caller has a listing and the settings. Nothing here reads the
// database, so a bid form can price the premium as the buyer types.
//
// A graded schedule charges the whole price at the rate of the tier the price falls in. It is not marginal: a
// $150,000 sale in a "$100,001 to $250,000" tier pays that tier's rate on all $150,000, not the first tier's rate on
// the first $100,000. Each side then pays at least its minimum, and never more than the price itself.

// One price band. upTo is in dollars and inclusive; null is the last, open-ended tier.
export type FeeTier = { upTo: number | null; premiumBps: number; commissionBps: number };

export type FeeSchedule = { tiers: FeeTier[]; minPremiumCents: number; minCommissionCents: number };

// Who pays UPB's fees on a listing. SPLIT is the default: the buyer pays the premium and the seller the commission.
// SELLER pays both out of the proceeds, and BUYER pays both on top of the price. Both fees are worked out as for a
// split, on the same tiers and minimums, and then the one side pays the two. The seller picks before go-live.
export const FEE_PAYERS = ["SPLIT", "SELLER", "BUYER"] as const;
export type FeePayer = (typeof FEE_PAYERS)[number];

export function feePayerOf(value: unknown): FeePayer {
  return value === "SELLER" || value === "BUYER" ? value : "SPLIT";
}

export const FEE_PAYER_LABELS: Record<FeePayer, string> = {
  SPLIT: "Split: the buyer pays the premium, the seller the commission",
  SELLER: "The seller pays both fees",
  BUYER: "The buyer pays both fees",
};

// What a listing trades at: a graded schedule, or flat rates when there is none. Plain data, so a server page can
// hand it to a bid form. payer is left off for a split, which is how every listing traded before the choice.
export type FeeTerms = { schedule: FeeSchedule | null; premiumBps: number; commissionBps: number; payer?: FeePayer };

export type FeeSettings = {
  buyerPremiumBps: number;
  sellerCommissionBps: number;
  // The settings row's JSON. Missing or null means the flat rates.
  feeSchedule?: unknown;
  chargeDeskFees?: boolean | null;
};

export type ListingFees = {
  feeBuyerPremiumBps?: number | null;
  feeSellerCommissionBps?: number | null;
  feeSchedule?: unknown;
  // SPLIT, SELLER or BUYER. Missing means SPLIT.
  feePayer?: string | null;
};

export const MAX_TIER_BPS = 1000;
export const MAX_TIERS = 8;
// $100,000, so a typo in the minimum can't swallow a sale.
export const MAX_MINIMUM_CENTS = 10_000_000;

// The sizes the fee page works through.
export const EXAMPLE_PRICES = [25_000, 100_000, 500_000] as const;

type Checked = { error: string; schedule?: undefined } | { error: null; schedule: FeeSchedule };

function wholeBps(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_TIER_BPS;
}

function wholeCents(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_MINIMUM_CENTS;
}

// The rules a schedule keeps: tiers in ascending order, one open tier at the end, rates from 0 to 10%, and
// minimums from $0 to $100,000.
export function checkSchedule(input: unknown): Checked {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  const tiers = Array.isArray(raw?.tiers) ? (raw.tiers as unknown[]) : null;
  if (!tiers || !tiers.length) return { error: "Add at least one tier." };
  if (tiers.length > MAX_TIERS) return { error: `Keep the schedule to ${MAX_TIERS} tiers or fewer.` };
  const out: FeeTier[] = [];
  let floor = 0;
  for (const [index, item] of tiers.entries()) {
    const tier = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const last = index === tiers.length - 1;
    const upTo = tier.upTo ?? null;
    if (!wholeBps(tier.premiumBps) || !wholeBps(tier.commissionBps)) return { error: "Keep each rate between 0% and 10%, to two decimal places." };
    if (last && upTo !== null) return { error: "Leave “up to” blank on the last tier, so every price has a tier." };
    if (!last && upTo === null) return { error: "Only the last tier is open-ended. Give the others an “up to” price." };
    if (upTo !== null) {
      if (typeof upTo !== "number" || !Number.isFinite(upTo) || upTo <= 0) return { error: "Each “up to” is a dollar amount above zero." };
      if (upTo <= floor) return { error: "Tiers go up in price. Each “up to” must be above the one before it." };
      floor = upTo;
    }
    out.push({ upTo: upTo === null ? null : Math.round(upTo * 100) / 100, premiumBps: tier.premiumBps as number, commissionBps: tier.commissionBps as number });
  }
  const minPremiumCents = raw?.minPremiumCents ?? 0;
  const minCommissionCents = raw?.minCommissionCents ?? 0;
  if (!wholeCents(minPremiumCents) || !wholeCents(minCommissionCents)) return { error: "Minimums are dollar amounts from $0 to $100,000." };
  return { error: null, schedule: { tiers: out, minPremiumCents: minPremiumCents as number, minCommissionCents: minCommissionCents as number } };
}

// A stored schedule, or null when there is none. A stored value that no longer passes the rules reads as none, so
// the flat rates apply rather than a half-read schedule.
export function readSchedule(raw: unknown): FeeSchedule | null {
  if (raw == null) return null;
  const checked = checkSchedule(raw);
  return checked.error === null ? checked.schedule : null;
}

export type ScheduleForm = { upTo: string[]; premium: string[]; commission: string[]; minPremium: string; minCommission: string };

// The settings form: one row per tier, rates as percents and prices as people type them. A row left wholly blank is
// skipped, so the form can offer spare rows.
export function scheduleFromForm(form: ScheduleForm): Checked {
  const tiers: Record<string, unknown>[] = [];
  const rows = Math.max(form.upTo.length, form.premium.length, form.commission.length);
  for (let index = 0; index < rows; index += 1) {
    const upText = String(form.upTo[index] ?? "").trim();
    const premiumText = String(form.premium[index] ?? "").trim();
    const commissionText = String(form.commission[index] ?? "").trim();
    if (!upText && !premiumText && !commissionText) continue;
    if (!premiumText || !commissionText) return { error: "Each tier needs a buyer premium and a seller commission, as a percent." };
    const premium = typedNumber(premiumText);
    const commission = typedNumber(commissionText);
    if (!Number.isFinite(premium) || !Number.isFinite(commission)) return { error: "Enter each rate as a percent, such as 2.5." };
    const upTo = upText ? typedNumber(upText) : null;
    if (upTo !== null && !Number.isFinite(upTo)) return { error: "Enter each “up to” as a dollar amount, such as 250,000." };
    // Two decimal places of a percent is a whole basis point; anything finer is refused rather than rounded away.
    const premiumBps = Math.abs(premium * 100 - Math.round(premium * 100)) < 1e-6 ? percentToBps(premium) : Number.NaN;
    const commissionBps = Math.abs(commission * 100 - Math.round(commission * 100)) < 1e-6 ? percentToBps(commission) : Number.NaN;
    tiers.push({ upTo, premiumBps, commissionBps });
  }
  const minimum = (text: string) => {
    const value = text.trim() ? typedNumber(text) : 0;
    return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN;
  };
  return checkSchedule({ tiers, minPremiumCents: minimum(form.minPremium), minCommissionCents: minimum(form.minCommission) });
}

// The tier a price falls in. Prices are compared in dollars, and each tier's upTo is included in it.
export function tierFor(schedule: FeeSchedule, price: number): FeeTier {
  return schedule.tiers.find((tier) => tier.upTo === null || price <= tier.upTo) ?? schedule.tiers[schedule.tiers.length - 1];
}

// What a listing trades at. The schedule kept on it at approval wins. A listing approved with flat rates keeps
// them, whatever the settings say later. A listing with nothing kept on it, approved before fees were kept or not
// yet approved, takes the settings of the day: the desk's schedule when one is set, else the flat rates.
export function feeTerms(listing: ListingFees | null | undefined, settings: FeeSettings): FeeTerms {
  const premiumBps = listing?.feeBuyerPremiumBps ?? settings.buyerPremiumBps;
  const commissionBps = listing?.feeSellerCommissionBps ?? settings.sellerCommissionBps;
  // The seller's choice of who pays, which locks with the rates at go-live.
  const payer = feePayerOf(listing?.feePayer);
  const paid = payer === "SPLIT" ? {} : { payer };
  const kept = readSchedule(listing?.feeSchedule);
  if (kept) return { schedule: kept, premiumBps, commissionBps, ...paid };
  const keptFlat = listing?.feeBuyerPremiumBps != null || listing?.feeSellerCommissionBps != null;
  return { schedule: keptFlat ? null : readSchedule(settings.feeSchedule), premiumBps, commissionBps, ...paid };
}

// Flat terms from a single rate, for a caller that has only the premium.
export function flatTerms(premiumBps: number, commissionBps = 0): FeeTerms {
  return { schedule: null, premiumBps, commissionBps };
}

export type Fees = {
  saleCents: number;
  premiumCents: number;
  commissionCents: number;
  buyerTotalCents: number;
  netToSellerCents: number;
  // The rate each side was charged at before any minimum: the tier's, or the flat rate.
  premiumBps: number;
  commissionBps: number;
  graded: boolean;
  // Whether the minimum, or the price itself, set the fee rather than the rate.
  premiumFloor: boolean;
  commissionFloor: boolean;
  // Set when one side pays both fees. A split leaves it off.
  payer?: FeePayer;
};

export type ChargeOptions = {
  // The desk buying for its own book never pays itself a premium; chargeDeskFees decides the seller's commission.
  deskPurchase?: boolean;
  chargeDeskFees?: boolean | null;
};

// The one place a fee is worked out. Flat terms charge exactly what they always have: the rate on the price, with no
// minimum. A schedule charges the tier's rate on the whole price, then lifts each side to its minimum, and never
// past the price. When one side pays both, both fees are worked out as for a split and then move to that side.
export function chargeFees(terms: FeeTerms, price: number, options: ChargeOptions = {}): Fees {
  return movePayer(splitFees(terms, price, options), feePayerOf(terms.payer), options.deskPurchase === true);
}

// One side pays the premium and the commission together, never more than the price. A desk purchase has no premium
// to move, and with BUYER the desk doesn't pay itself the commission either.
export function movePayer(fees: Fees, payer: FeePayer, deskPurchase = false): Fees {
  if (payer === "SPLIT") return fees;
  const none = deskPurchase && payer === "BUYER";
  const sum = none ? 0 : fees.premiumCents + fees.commissionCents;
  const both = Math.min(fees.saleCents, sum);
  const floor = !none && (fees.premiumFloor || fees.commissionFloor || both !== sum);
  const bps = none ? 0 : fees.premiumBps + fees.commissionBps;
  if (payer === "SELLER") {
    return { ...fees, premiumCents: 0, commissionCents: both, buyerTotalCents: fees.saleCents, netToSellerCents: fees.saleCents - both, premiumBps: 0, commissionBps: bps, premiumFloor: false, commissionFloor: floor, payer };
  }
  return { ...fees, premiumCents: both, commissionCents: 0, buyerTotalCents: fees.saleCents + both, netToSellerCents: fees.saleCents, premiumBps: bps, commissionBps: 0, premiumFloor: floor, commissionFloor: false, payer };
}

function splitFees(terms: FeeTerms, price: number, options: ChargeOptions): Fees {
  const desk = options.deskPurchase === true;
  const chargeCommission = !desk || Boolean(options.chargeDeskFees);
  if (!terms.schedule) {
    const premiumBps = desk ? 0 : terms.premiumBps;
    const commissionBps = chargeCommission ? terms.commissionBps : 0;
    return { ...feeBreakdown(price, premiumBps, commissionBps), premiumBps, commissionBps, graded: false, premiumFloor: false, commissionFloor: false };
  }
  const saleCents = dollarsToCents(price);
  const tier = tierFor(terms.schedule, price);
  const side = (bps: number, minimumCents: number, charged: boolean) => {
    if (!charged || saleCents <= 0) return { cents: 0, floor: false };
    const byRate = applyBps(saleCents, bps);
    const cents = Math.min(saleCents, Math.max(byRate, minimumCents));
    return { cents, floor: cents !== byRate };
  };
  const premium = side(tier.premiumBps, terms.schedule.minPremiumCents, !desk);
  const commission = side(tier.commissionBps, terms.schedule.minCommissionCents, chargeCommission);
  return {
    saleCents,
    premiumCents: premium.cents,
    commissionCents: commission.cents,
    buyerTotalCents: saleCents + premium.cents,
    netToSellerCents: saleCents - commission.cents,
    premiumBps: desk ? 0 : tier.premiumBps,
    commissionBps: chargeCommission ? tier.commissionBps : 0,
    graded: true,
    premiumFloor: premium.floor,
    commissionFloor: commission.floor,
  };
}

// The fees on a sale of this listing at this price. A desk purchase passes deskPurchase, and the settings say
// whether the seller still pays the commission.
export function feesFor(listing: ListingFees | null | undefined, settings: FeeSettings, price: number, options: { deskPurchase?: boolean } = {}): Fees {
  return chargeFees(feeTerms(listing, settings), price, { deskPurchase: options.deskPurchase, chargeDeskFees: settings.chargeDeskFees });
}

// The rate a fee comes to on its price, minimum included, for a form that takes a single rate. Not rounded to a
// whole basis point, so the rate times the price gives back the fee.
export function effectiveBps(fees: Fees, side: "premium" | "commission" = "premium") {
  if (fees.saleCents <= 0) return side === "premium" ? fees.premiumBps : fees.commissionBps;
  return ((side === "premium" ? fees.premiumCents : fees.commissionCents) * 10000) / fees.saleCents;
}

// The buyer premium in dollars on a price, for a bid form's running all-in.
export function premiumOn(terms: FeeTerms, price: number) {
  return Number.isFinite(price) && price > 0 ? chargeFees(terms, price).premiumCents / 100 : 0;
}

// The buyer's all-in in dollars: the price and the premium on it.
export function allInFor(terms: FeeTerms, price: number) {
  return Number.isFinite(price) && price > 0 ? chargeFees(terms, price).buyerTotalCents / 100 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Words for the pages.

function percent(bps: number) {
  return `${bpsToPercent(bps).toFixed(2)}%`;
}

function dollars(cents: number) {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

// The terms as one side pays them when it pays both: each tier's two rates added, and the two minimums added.
function bothSides(terms: FeeTerms): FeeTerms {
  const schedule = terms.schedule
    ? {
        tiers: terms.schedule.tiers.map((tier) => ({ upTo: tier.upTo, premiumBps: tier.premiumBps + tier.commissionBps, commissionBps: 0 })),
        minPremiumCents: terms.schedule.minPremiumCents + terms.schedule.minCommissionCents,
        minCommissionCents: 0,
      }
    : null;
  return { schedule, premiumBps: terms.premiumBps + terms.commissionBps, commissionBps: 0 };
}

// "2.50%", or for a schedule "0.75% to 3.50% by sale size, at least $750". When one side pays both fees, the other
// side reads 0.00% and the paying side reads the two together.
export function rateText(terms: FeeTerms, side: "premium" | "commission"): string {
  const payer = feePayerOf(terms.payer);
  if (payer !== "SPLIT") return (payer === "BUYER") === (side === "premium") ? rateText(bothSides(terms), "premium") : percent(0);
  if (!terms.schedule) return percent(side === "premium" ? terms.premiumBps : terms.commissionBps);
  const rates = terms.schedule.tiers.map((tier) => (side === "premium" ? tier.premiumBps : tier.commissionBps));
  const low = Math.min(...rates);
  const high = Math.max(...rates);
  const minimum = side === "premium" ? terms.schedule.minPremiumCents : terms.schedule.minCommissionCents;
  const range = low === high ? percent(low) : `${percent(low)} to ${percent(high)} by sale size`;
  return minimum > 0 ? `${range}, at least ${dollars(minimum)}` : range;
}

// The rate a sale at this price pays, said plainly: "3.00%", or "the $750 minimum" when the minimum set it.
export function chargedText(fees: Fees, side: "premium" | "commission") {
  const floor = side === "premium" ? fees.premiumFloor : fees.commissionFloor;
  const cents = side === "premium" ? fees.premiumCents : fees.commissionCents;
  if (floor && cents === fees.saleCents) return "capped at the price";
  // Both fees on one side: a minimum may have set one of the two, so the sum isn't a single minimum.
  if (floor && fees.payer && fees.payer !== "SPLIT") return "both fees, minimums included";
  if (floor) return `the ${dollars(cents)} minimum`;
  return percent(side === "premium" ? fees.premiumBps : fees.commissionBps);
}

// Who pays UPB's fees on these terms, in the words a bidder reads before they bid.
export function payerText(terms: FeeTerms) {
  const payer = feePayerOf(terms.payer);
  if (payer === "SELLER") return "The seller pays UPB's fees on this listing, so nothing is added to an accepted price.";
  if (payer === "BUYER") return `The buyer pays UPB's fees on this listing: a premium of ${rateText(terms, "premium")}, added to an accepted price, covers both sides. It is not part of your bid.`;
  return `A buyer premium of ${rateText(terms, "premium")} is added to an accepted price. It is not part of your bid.`;
}

// A tier's price band: "Up to $100,000", "$100,001 to $250,000", "Over $250,000".
export function tierLabel(schedule: FeeSchedule, index: number) {
  const tier = schedule.tiers[index];
  const below = index > 0 ? schedule.tiers[index - 1].upTo : null;
  const fmt = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (tier.upTo === null) return below === null ? "Any price" : `Over ${fmt(below)}`;
  if (below === null) return `Up to ${fmt(tier.upTo)}`;
  return `${fmt(Math.floor(below) + 1)} to ${fmt(tier.upTo)}`;
}
