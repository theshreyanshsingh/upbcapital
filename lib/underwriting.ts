export type ArmReset = { month: number; annualRate: number };

export type CashFlowInput = {
  bid: number;
  upb: number;
  annualRate: number;
  monthlyPi: number;
  termMonths: number;
  balloonMonth?: number | null;
  armResets?: ArmReset[];
  missedMonths?: number[];
};

export function projectFlows(input: CashFlowInput) {
  const flows: number[] = [-input.bid];
  let annual = input.annualRate;
  let balance = Math.max(input.upb, 0);
  const term = Math.max(1, Math.min(Math.round(input.termMonths) || 1, 480));
  const balloon = input.balloonMonth && input.balloonMonth > 0 ? Math.min(term, Math.round(input.balloonMonth)) : null;
  const missed = new Set((input.missedMonths ?? []).map((month) => Math.round(month)));
  const resets = [...(input.armResets ?? [])].filter((row) => row.month > 0).sort((a, b) => a.month - b.month);
  const horizon = balloon ?? term;
  for (let month = 1; month <= horizon && balance > 1; month += 1) {
    const reset = resets.find((row) => row.month === month);
    if (reset && Number.isFinite(reset.annualRate)) annual = reset.annualRate;
    const interest = balance * (annual / 100 / 12);
    const payoff = balance + interest;
    const last = month === horizon || input.monthlyPi + 0.01 >= payoff;
    if (missed.has(month) && !last) {
      balance += interest;
      flows.push(0);
      continue;
    }
    if (last) {
      flows.push(payoff);
      break;
    }
    balance = Math.max(0, balance - (input.monthlyPi - interest));
    flows.push(input.monthlyPi);
  }
  return flows;
}

export function monthlyIrr(flows: number[]) {
  if (flows.length < 2) return null;
  let rate = 0.01;
  for (let step = 0; step < 60; step += 1) {
    let npv = 0;
    let derivative = 0;
    for (let t = 0; t < flows.length; t += 1) {
      const discount = (1 + rate) ** t;
      npv += flows[t] / discount;
      if (t > 0) derivative -= (t * flows[t]) / (1 + rate) ** (t + 1);
    }
    if (!Number.isFinite(npv) || Math.abs(derivative) < 1e-10) return null;
    const next = rate - npv / derivative;
    if (!Number.isFinite(next) || next <= -0.99) return null;
    if (Math.abs(next - rate) < 1e-8) return next;
    rate = next;
  }
  return rate;
}

export function annualize(monthly: number | null) {
  if (monthly == null) return null;
  return ((1 + monthly) ** 12 - 1) * 100;
}

export function performingCase(input: CashFlowInput) {
  const flows = projectFlows(input);
  const yieldPct = input.bid > 0 ? ((input.monthlyPi * 12) / input.bid) * 100 : null;
  const paybackMonths = input.monthlyPi > 0 ? input.bid / input.monthlyPi : null;
  return {
    flows,
    yieldPct,
    cashOnCash: yieldPct,
    irrPct: annualize(monthlyIrr(flows)),
    paybackMonths,
  };
}

export type Resolution = {
  key: string;
  label: string;
  months: number;
  cost: number;
  recovery: number;
  net: number;
  profit: number;
  annualized: number | null;
  note: string;
};

export function annualizedReturn(profit: number, bid: number, months: number) {
  if (bid <= 0 || months <= 0) return null;
  return (profit / bid) * (12 / months) * 100;
}

export function nplCases(input: {
  bid: number;
  upb: number;
  value: number;
  monthlyPi: number;
  monthsDelinquent: number;
  foreclosureMonths: number;
  foreclosureCost: number;
  process: string;
}): Resolution[] {
  const arrears = Math.max(0, input.monthsDelinquent) * input.monthlyPi;
  const rows: Omit<Resolution, "net" | "profit" | "annualized">[] = [
    {
      key: "reinstatement",
      label: "Reinstatement",
      months: 3,
      cost: 2500,
      recovery: input.upb * 0.9,
      note: `Borrower cures about ${Math.round(arrears).toLocaleString("en-US")} of arrears. The desk marks the reperforming note at 90% of UPB.`,
    },
    {
      key: "modification",
      label: "Loan modification",
      months: 6,
      cost: 4000,
      recovery: input.upb * 0.75,
      note: "Rate or payment is cut and the term is extended. Exit marked at 75% of UPB.",
    },
    {
      key: "short_sale",
      label: "Short sale",
      months: Math.max(4, Math.round(input.foreclosureMonths * 0.55)),
      cost: 8000,
      recovery: input.value * 0.72,
      note: "Sale short of the debt, before a judgment. Recovery is 72% of the modeled value.",
    },
    {
      key: "deed",
      label: "Deed in lieu",
      months: 4,
      cost: 6000,
      recovery: input.value * 0.8,
      note: "Borrower deeds the collateral. Recovery is 80% of the modeled value.",
    },
    {
      key: "foreclosure",
      label: "Foreclosure / REO",
      months: input.foreclosureMonths + 3,
      cost: input.foreclosureCost + input.value * 0.05,
      recovery: input.value * 0.7,
      note: `${input.process} timeline, then a three-month REO sale. Recovery is 70% of value. These timelines are desk estimates, not legal advice.`,
    },
  ];
  return rows.map((row) => {
    const net = row.recovery - row.cost;
    const profit = net - input.bid;
    return { ...row, net, profit, annualized: annualizedReturn(profit, input.bid, row.months) };
  });
}
