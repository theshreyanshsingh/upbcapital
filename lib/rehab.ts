export const SOUTH_FLORIDA_COSTS: { trade: string; unit: string; costCents: number }[] = [
  { trade: "Roofing", unit: "square", costCents: 45000 },
  { trade: "Kitchen", unit: "each", costCents: 2800000 },
  { trade: "Bathroom", unit: "each", costCents: 1500000 },
  { trade: "Flooring", unit: "sqft", costCents: 850 },
  { trade: "Interior paint", unit: "sqft", costCents: 350 },
  { trade: "HVAC", unit: "each", costCents: 850000 },
  { trade: "Windows", unit: "each", costCents: 65000 },
  { trade: "Electrical", unit: "sqft", costCents: 400 },
];

export function lineCost(quantity: number, unitCostCents: number) {
  return (Math.max(0, quantity) * Math.max(0, unitCostCents)) / 100;
}

export function rehabPicture(input: {
  basis: number;
  lines: { quantity: number; unitCostCents: number }[];
  bids: { amount: number; selected: boolean }[];
  arv: number;
  holdingMonths: number;
  monthlyHold: number;
  monthlyRent: number;
  expenseRatio: number;
}) {
  const budget = input.lines.reduce((sum, line) => sum + lineCost(line.quantity, line.unitCostCents), 0);
  const chosen = input.bids.find((bid) => bid.selected) ?? null;
  const hard = chosen ? chosen.amount : budget;
  const holding = Math.max(0, input.holdingMonths) * Math.max(0, input.monthlyHold);
  const allIn = input.basis + hard + holding;
  const resaleProfit = input.arv - allIn;
  const ratio = Math.min(100, Math.max(0, input.expenseRatio)) / 100;
  const noi = input.monthlyRent * 12 * (1 - ratio);
  const capRate = allIn > 0 ? (noi / allIn) * 100 : null;
  return { budget, hard, holding, allIn, resaleProfit, noi, capRate, usingBid: Boolean(chosen) };
}

export function drawDollars(hard: number, percent: number) {
  return (hard * percent) / 100;
}
