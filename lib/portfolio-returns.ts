import type { Proceeds, SplitReceipt } from "@/lib/portfolio-tax";

// What the book has actually made, as Fundrise shows it: money in, money back, and the gain between, with an IRR on
// the dated cash flows beside the yield each note was bought for. lib/underwriting's monthlyIrr and annualize work on
// a flow per month; receipts land on any day, so this solves on the dates themselves (XIRR, actual/365).

const DAY = 24 * 60 * 60 * 1000;
const MONTH = (365.25 / 12) * DAY;
export const MIN_RECEIPTS = 3;
export const NOT_ENOUGH = "Not enough history";

export type Flow = { at: Date; amount: number };

function presentValue(flows: Flow[], rate: number, origin: number) {
  let value = 0;
  let slope = 0;
  for (const flow of flows) {
    const years = (flow.at.getTime() - origin) / DAY / 365;
    const factor = (1 + rate) ** years;
    value += flow.amount / factor;
    slope -= (years * flow.amount) / (factor * (1 + rate));
  }
  return { value, slope };
}

// The annual rate, as a fraction, at which the dated flows are worth nothing today. Newton first, then bisection when
// Newton wanders, which lumpy recoveries can make it do. Null without money both in and out, or with no root.
export function xirr(flows: Flow[]) {
  const live = flows.filter((flow) => Number.isFinite(flow.amount) && flow.amount !== 0);
  if (!live.some((flow) => flow.amount < 0) || !live.some((flow) => flow.amount > 0)) return null;
  const origin = Math.min(...live.map((flow) => flow.at.getTime()));
  const scale = live.reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
  let rate = 0.1;
  for (let step = 0; step < 100; step += 1) {
    const { value, slope } = presentValue(live, rate, origin);
    if (Math.abs(value) <= scale * 1e-10) return rate;
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-12) break;
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - rate) < 1e-12) return next;
    rate = next;
  }
  let low = -0.9999;
  let high = 10;
  let atLow = presentValue(live, low, origin).value;
  if (!Number.isFinite(atLow) || atLow * presentValue(live, high, origin).value > 0) return null;
  for (let step = 0; step < 300 && high - low > 1e-12; step += 1) {
    const mid = (low + high) / 2;
    const atMid = presentValue(live, mid, origin).value;
    if (atMid * atLow > 0) {
      low = mid;
      atLow = atMid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

export type ReturnInput = {
  costBasis: number;
  acquiredAt: Date;
  upb: number;
  status: string;
  underwrittenYield: number | null;
  receipts: SplitReceipt[];
  proceeds: Proceeds[];
};

export type HoldingReturn = {
  moneyIn: number;
  moneyBack: number;
  netGain: number;
  // The cost still out on a note the holder keeps, at their own cost per dollar of balance. Zero once sold or resolved.
  heldAtCost: number;
  receiptCount: number;
  enoughHistory: boolean;
  irrPct: number | null;
  underwrittenYield: number | null;
  // Realised less underwritten, in percentage points. Negative is behind.
  gapPts: number | null;
};

const cents = (value: number) => Math.round(value * 100) / 100;

// A note still held counts its unpaid balance at cost, so the IRR reads as a yield so far rather than a loss on every
// note not yet paid off. Principal comes from the logged or estimated split; a receipt with no split is
// all income, which keeps the full cost out.
function heldValue(input: ReturnInput) {
  if (input.proceeds.length || input.status === "RESOLVED") return 0;
  const repaid = input.receipts.reduce((sum, receipt) => sum + (receipt.split?.principal ?? 0), 0);
  const share = input.upb > 0 ? Math.max(0, 1 - repaid / input.upb) : 1;
  return cents(input.costBasis * share);
}

// The held balance is marked a month before today, or at the last receipt if that is later. A note between payments
// isn't marked down for the month not yet due, and one that stopped paying shows every month it missed.
export function markDate(input: Pick<ReturnInput, "acquiredAt" | "receipts">, now = new Date()) {
  const last = input.receipts.reduce((latest, receipt) => Math.max(latest, receipt.paidOn.getTime()), input.acquiredAt.getTime());
  return new Date(Math.min(now.getTime(), Math.max(last, now.getTime() - MONTH)));
}

export function flowsOf(input: ReturnInput, now = new Date()) {
  const flows: Flow[] = [
    { at: input.acquiredAt, amount: -input.costBasis },
    ...input.receipts.map((receipt) => ({ at: receipt.paidOn, amount: receipt.amount })),
    ...input.proceeds.map((sale) => ({ at: sale.on, amount: sale.amount })),
  ];
  const held = heldValue(input);
  if (held > 0) flows.push({ at: markDate(input, now), amount: held });
  return { flows, held };
}

export function holdingReturn(input: ReturnInput, now = new Date()): HoldingReturn {
  const moneyIn = cents(input.costBasis);
  const moneyBack = cents(input.receipts.reduce((sum, receipt) => sum + receipt.amount, 0) + input.proceeds.reduce((sum, sale) => sum + sale.amount, 0));
  const { flows, held } = flowsOf(input, now);
  // A sale settles the record, however few receipts came before it.
  const enoughHistory = input.receipts.length >= MIN_RECEIPTS || input.proceeds.length > 0;
  const rate = enoughHistory ? xirr(flows) : null;
  const irrPct = rate == null ? null : rate * 100;
  return {
    moneyIn,
    moneyBack,
    netGain: cents(moneyBack - moneyIn),
    heldAtCost: held,
    receiptCount: input.receipts.length,
    enoughHistory,
    irrPct,
    underwrittenYield: input.underwrittenYield,
    gapPts: irrPct != null && input.underwrittenYield != null ? irrPct - input.underwrittenYield : null,
  };
}

// The whole book: every holding's flows as one, and the yield underwritten weighted by what each note cost.
export function portfolioReturn(holdings: ReturnInput[], now = new Date()): HoldingReturn {
  const moneyIn = cents(holdings.reduce((sum, holding) => sum + holding.costBasis, 0));
  const moneyBack = cents(holdings.reduce((sum, holding) => sum + holding.receipts.reduce((total, receipt) => total + receipt.amount, 0) + holding.proceeds.reduce((total, sale) => total + sale.amount, 0), 0));
  const parts = holdings.map((holding) => flowsOf(holding, now));
  const receiptCount = holdings.reduce((sum, holding) => sum + holding.receipts.length, 0);
  const enoughHistory = receiptCount >= MIN_RECEIPTS || holdings.some((holding) => holding.proceeds.length > 0);
  const rate = enoughHistory && holdings.length ? xirr(parts.flatMap((part) => part.flows)) : null;
  const priced = holdings.filter((holding) => holding.underwrittenYield != null && holding.costBasis > 0);
  const weight = priced.reduce((sum, holding) => sum + holding.costBasis, 0);
  const underwrittenYield = weight > 0 ? priced.reduce((sum, holding) => sum + (holding.underwrittenYield as number) * holding.costBasis, 0) / weight : null;
  const irrPct = rate == null ? null : rate * 100;
  return {
    moneyIn,
    moneyBack,
    netGain: cents(moneyBack - moneyIn),
    heldAtCost: cents(parts.reduce((sum, part) => sum + part.held, 0)),
    receiptCount,
    enoughHistory,
    irrPct,
    underwrittenYield,
    gapPts: irrPct != null && underwrittenYield != null ? irrPct - underwrittenYield : null,
  };
}

// "1.2 points behind the 11.0% underwritten", for the page.
export function gapLine(result: Pick<HoldingReturn, "gapPts" | "underwrittenYield">) {
  if (result.gapPts == null || result.underwrittenYield == null) return null;
  const size = Math.abs(result.gapPts);
  if (size < 0.05) return `On the ${result.underwrittenYield.toFixed(1)}% underwritten`;
  return `${size.toFixed(1)} point${size.toFixed(1) === "1.0" ? "" : "s"} ${result.gapPts < 0 ? "behind" : "ahead of"} the ${result.underwrittenYield.toFixed(1)}% underwritten`;
}
