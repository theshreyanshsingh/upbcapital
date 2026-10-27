export type ForeclosureRule = {
  months: number;
  cost: number;
  process: "Judicial" | "Non-judicial";
};

const RULES: Record<string, ForeclosureRule> = {
  AL: { months: 4, cost: 4000, process: "Non-judicial" },
  AZ: { months: 4, cost: 4500, process: "Non-judicial" },
  CA: { months: 6, cost: 6000, process: "Non-judicial" },
  CO: { months: 6, cost: 5500, process: "Non-judicial" },
  CT: { months: 18, cost: 12000, process: "Judicial" },
  FL: { months: 18, cost: 12000, process: "Judicial" },
  GA: { months: 4, cost: 4500, process: "Non-judicial" },
  IL: { months: 15, cost: 11000, process: "Judicial" },
  NC: { months: 5, cost: 5000, process: "Non-judicial" },
  NJ: { months: 20, cost: 14000, process: "Judicial" },
  NY: { months: 24, cost: 18000, process: "Judicial" },
  OH: { months: 12, cost: 8000, process: "Judicial" },
  PA: { months: 12, cost: 9000, process: "Judicial" },
  SC: { months: 8, cost: 6000, process: "Judicial" },
  TN: { months: 5, cost: 4500, process: "Non-judicial" },
  TX: { months: 3, cost: 4000, process: "Non-judicial" },
  VA: { months: 3, cost: 4000, process: "Non-judicial" },
  WA: { months: 6, cost: 5500, process: "Non-judicial" },
};

export function foreclosureFor(state: string): ForeclosureRule & { state: string; assumed: boolean } {
  const code = state.toUpperCase();
  const rule = RULES[code];
  if (rule) return { ...rule, state: code, assumed: false };
  return { ...RULES.FL, state: "FL", assumed: true };
}
