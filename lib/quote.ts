import { suggestedPrice, type Comp } from "@/lib/comps";

export type QuoteInput = {
  state: string;
  paymentStatus: string;
  upb: number;
  estimatedValue: number;
  interestRate: number;
  monthlyPi: number;
};

export type IndicativeQuote = {
  low: number;
  high: number;
  basis: string;
};

const BANDS: Record<string, [number, number]> = {
  PERFORMING: [0.72, 0.9],
  SUB_PERFORMING: [0.48, 0.68],
  NON_PERFORMING: [0.28, 0.48],
};

export function indicativeQuote(input: QuoteInput, book: Comp[] = []): IndicativeQuote {
  const upb = Math.max(input.upb, 0);
  const band = BANDS[input.paymentStatus] ?? BANDS.NON_PERFORMING;
  let lowRatio = band[0];
  let highRatio = band[1];
  if (input.paymentStatus === "PERFORMING" && input.interestRate > 0 && input.interestRate < 5.5) {
    lowRatio -= 0.08;
    highRatio -= 0.08;
  }
  if (input.paymentStatus === "NON_PERFORMING" && input.estimatedValue > 0) {
    const valueCap = (input.estimatedValue * 0.45) / Math.max(upb, 1);
    highRatio = Math.min(highRatio, Math.max(valueCap, lowRatio));
  }
  let low = Math.round(upb * lowRatio);
  let high = Math.round(upb * highRatio);
  const comp = suggestedPrice(
    { state: input.state, paymentStatus: input.paymentStatus, upb, askingPrice: 0 },
    book.map((row) => ({ ...row })),
  );
  let basis = "Desk band for this performance, before a file review.";
  if (comp) {
    const mid = comp.price;
    low = Math.round(Math.min(low, mid * 0.92));
    high = Math.round(Math.max(high, mid * 1.06));
    basis = `Desk band, tightened around ${comp.sample} comparable notes in ${input.state}.`;
  }
  if (input.monthlyPi > 0 && high > 0) {
    const yieldAtHigh = ((input.monthlyPi * 12) / high) * 100;
    if (input.paymentStatus === "PERFORMING" && yieldAtHigh < 6) {
      high = Math.round((input.monthlyPi * 12) / 0.06);
      basis = `${basis} The high end is held where cash yield stays near 6%.`;
    }
  }
  if (high < low) high = low;
  return { low, high, basis };
}
