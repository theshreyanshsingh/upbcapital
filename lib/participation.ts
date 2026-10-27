import { annualize, monthlyIrr, performingCase, projectFlows } from "@/lib/underwriting";

export type SplitInput = {
  basis: number;
  upb: number;
  annualRate: number;
  monthlyPi: number;
  termMonths: number;
  percent: number;
  paymentCount: number | null;
  slicePrice: number;
};

export type SplitModel = {
  mode: "percent" | "payments";
  buyerMonthly: number;
  sellerMonthly: number;
  buyerIrr: number | null;
  sellerIrr: number | null;
  buyerUpb: number;
};

export function modelParticipation(input: SplitInput): SplitModel | null {
  if (input.basis <= 0 || input.upb <= 0 || input.slicePrice <= 0 || input.slicePrice >= input.basis) return null;
  if (input.percent <= 0 || input.percent > 100) return null;
  const term = Math.max(1, input.termMonths || 360);
  if (input.paymentCount != null) {
    if (input.paymentCount < 1 || input.paymentCount >= term) return null;
    const flows = projectFlows({
      bid: input.basis,
      upb: input.upb,
      annualRate: input.annualRate,
      monthlyPi: input.monthlyPi,
      termMonths: term,
    });
    const sold = flows.slice(1, input.paymentCount + 1);
    const kept = flows.slice(input.paymentCount + 1);
    if (!sold.length || !kept.length) return null;
    return {
      mode: "payments",
      buyerMonthly: sold[0] ?? 0,
      sellerMonthly: kept[0] ?? 0,
      buyerIrr: annualize(monthlyIrr([-input.slicePrice, ...sold])),
      sellerIrr: annualize(monthlyIrr([-(input.basis - input.slicePrice), ...kept])),
      buyerUpb: 0,
    };
  }
  const share = input.percent / 100;
  const buyer = performingCase({
    bid: input.slicePrice,
    upb: input.upb * share,
    annualRate: input.annualRate,
    monthlyPi: input.monthlyPi * share,
    termMonths: term,
  });
  const seller = performingCase({
    bid: input.basis - input.slicePrice,
    upb: input.upb * (1 - share),
    annualRate: input.annualRate,
    monthlyPi: input.monthlyPi * (1 - share),
    termMonths: term,
  });
  return {
    mode: "percent",
    buyerMonthly: input.monthlyPi * share,
    sellerMonthly: input.monthlyPi * (1 - share),
    buyerIrr: buyer.irrPct,
    sellerIrr: seller.irrPct,
    buyerUpb: input.upb * share,
  };
}
