export function bookReturn(input: {
  cost: number;
  received: number;
  acquiredAt: Date;
  now: Date;
  underwrittenYield: number | null;
}) {
  const days = Math.max(0, (input.now.getTime() - input.acquiredAt.getTime()) / 86400000);
  const months = Math.max(days / 30, 0);
  const cashOnCash = input.cost > 0 ? (input.received / input.cost) * 100 : null;
  const profit = input.received - input.cost;
  const roi = input.cost > 0 ? (profit / input.cost) * 100 : null;
  const expected =
    input.underwrittenYield != null && input.cost > 0 ? input.cost * (input.underwrittenYield / 100) * (months / 12) : null;
  const variance = expected == null ? null : input.received - expected;
  return { days, months, cashOnCash, roi, expected, variance };
}

export function annualYield(monthlyPi: number, price: number) {
  if (price <= 0 || monthlyPi <= 0) return null;
  return ((monthlyPi * 12) / price) * 100;
}
