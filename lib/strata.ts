export type TapeLoan = {
  state: string;
  lien: string;
  status: string;
  upb: number;
  value: number;
  rate: number;
  monthsDelinquent: number;
};

export type Stratum = { label: string; count: number; upb: number; share: number };

export function upbBucket(upb: number) {
  if (upb < 100000) return "Under $100k";
  if (upb < 250000) return "$100–250k";
  if (upb < 500000) return "$250–500k";
  return "$500k and up";
}

export function ltvBucket(upb: number, value: number) {
  if (value <= 0) return "Unknown";
  const ltv = (upb / value) * 100;
  if (ltv < 50) return "Under 50%";
  if (ltv < 70) return "50–70%";
  if (ltv < 90) return "70–90%";
  return "90% and up";
}

export function couponBucket(rate: number) {
  if (rate < 5) return "Under 5%";
  if (rate < 7) return "5–7%";
  if (rate < 9) return "7–9%";
  return "9% and up";
}

function group(loans: TapeLoan[], keyOf: (loan: TapeLoan) => string, totalUpb: number): Stratum[] {
  const map = new Map<string, { count: number; upb: number }>();
  for (const loan of loans) {
    const key = keyOf(loan);
    const row = map.get(key) ?? { count: 0, upb: 0 };
    row.count += 1;
    row.upb += loan.upb;
    map.set(key, row);
  }
  return [...map.entries()]
    .map(([label, row]) => ({ label, count: row.count, upb: row.upb, share: totalUpb > 0 ? (row.upb / totalUpb) * 100 : 0 }))
    .sort((a, b) => b.upb - a.upb);
}

export function stratify(loans: TapeLoan[]) {
  const totalUpb = loans.reduce((sum, loan) => sum + loan.upb, 0);
  const weight = (pick: (loan: TapeLoan) => number) => (totalUpb > 0 ? loans.reduce((sum, loan) => sum + pick(loan) * loan.upb, 0) / totalUpb : 0);
  return {
    count: loans.length,
    totalUpb,
    wac: weight((loan) => loan.rate),
    waltv: weight((loan) => (loan.value > 0 ? (loan.upb / loan.value) * 100 : 0)),
    weightedDelinquency: weight((loan) => loan.monthsDelinquent),
    byState: group(loans, (loan) => loan.state, totalUpb),
    byLien: group(loans, (loan) => loan.lien, totalUpb),
    byStatus: group(loans, (loan) => loan.status, totalUpb),
    byUpb: group(loans, (loan) => upbBucket(loan.upb), totalUpb),
    byLtv: group(loans, (loan) => ltvBucket(loan.upb, loan.value), totalUpb),
    byCoupon: group(loans, (loan) => couponBucket(loan.rate), totalUpb),
  };
}
