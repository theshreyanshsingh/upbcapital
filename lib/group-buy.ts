import { annualize, monthlyIrr, performingCase, projectFlows } from "@/lib/underwriting";

export type Seat = { amount: number; status: string; slice?: string };

const ACTIVE = new Set(["PLEDGED", "RECONFIRM", "FUNDED"]);

export function filledAmount(seats: Seat[]) {
  return seats.filter((seat) => ACTIVE.has(seat.status)).reduce((sum, seat) => sum + seat.amount, 0);
}

export function fillState(target: number, seats: Seat[]) {
  const filled = filledAmount(seats);
  const remaining = Math.max(0, Math.round((target - filled) * 100) / 100);
  const pct = target > 0 ? Math.min(100, (filled / target) * 100) : 0;
  return { filled, remaining, pct, complete: target > 0 && remaining <= 0.01 };
}

export function resolvePositionAmount(input: {
  target: number;
  amount: number | null;
  percent: number | null;
  min: number;
  remaining: number;
}) {
  let dollars = input.amount;
  if ((dollars == null || dollars <= 0) && input.percent != null && input.percent > 0) {
    dollars = (input.target * input.percent) / 100;
  }
  if (dollars == null || !Number.isFinite(dollars) || dollars <= 0) return null;
  dollars = Math.round(dollars * 100) / 100;
  if (input.remaining - dollars < 1 && input.remaining - dollars > 0) dollars = Math.round(input.remaining * 100) / 100;
  if (dollars + 0.001 < input.min) return null;
  if (dollars > input.remaining + 0.05) return null;
  return dollars;
}

export function splitPremium(premiumCents: number, seats: { userId: string; amount: number }[]) {
  const total = seats.reduce((sum, seat) => sum + seat.amount, 0);
  if (total <= 0) return seats.map((seat) => ({ ...seat, premiumCents: 0 }));
  let used = 0;
  return seats.map((seat, index) => {
    const cents = index === seats.length - 1 ? premiumCents - used : Math.round((premiumCents * seat.amount) / total);
    used += cents;
    return { ...seat, premiumCents: cents };
  });
}

export function scaleToTarget(amount: number, oldTarget: number, nextTarget: number) {
  if (oldTarget <= 0) return amount;
  return Math.round(((amount / oldTarget) * nextTarget) * 100) / 100;
}

export function seatName(input: { seat: number; userId: string; name: string; viewerId: string; viewerRole: string }) {
  if (input.viewerRole === "ADMIN" || input.viewerId === input.userId) return input.name;
  return `Seat ${input.seat}`;
}

function levelPayment(principal: number, annualRate: number, months: number) {
  const r = annualRate / 100 / 12;
  if (months <= 0 || principal <= 0) return 0;
  if (Math.abs(r) < 1e-9) return principal / months;
  return (principal * r) / (1 - (1 + r) ** -months);
}

export function notePayments(input: { upb: number; annualRate: number; monthlyPi: number; termMonths: number }) {
  return projectFlows({ bid: 0, ...input }).slice(1);
}

export function positionEconomics(input: {
  structure: "PRO_RATA" | "SENIOR_JUNIOR";
  price: number;
  upb: number;
  annualRate: number;
  monthlyPi: number;
  termMonths: number;
  amount: number;
  slice: "PARI" | "SENIOR" | "JUNIOR";
  seniorYield: number;
  seniorCapital: number;
  juniorCapital: number;
}) {
  if (input.amount <= 0 || input.price <= 0) return { monthly: 0, yieldPct: null as number | null, irrPct: null as number | null };
  if (input.structure === "PRO_RATA" || input.slice === "PARI") {
    const share = input.amount / input.price;
    const result = performingCase({
      bid: input.amount,
      upb: input.upb * share,
      annualRate: input.annualRate,
      monthlyPi: input.monthlyPi * share,
      termMonths: input.termMonths,
    });
    return { monthly: input.monthlyPi * share, yieldPct: result.yieldPct, irrPct: result.irrPct };
  }
  const payments = notePayments(input);
  const service = levelPayment(input.seniorCapital, input.seniorYield, input.termMonths || payments.length);
  const mine = input.slice === "SENIOR" ? input.seniorCapital : input.juniorCapital;
  if (mine <= 0) return { monthly: 0, yieldPct: null, irrPct: null };
  const share = input.amount / mine;
  const flows = [-input.amount];
  for (const payment of payments) {
    const senior = Math.min(service, Math.max(payment, 0));
    const junior = Math.max(0, payment - senior);
    flows.push((input.slice === "SENIOR" ? senior : junior) * share);
  }
  const monthly = flows[1] ?? 0;
  const irr = annualize(monthlyIrr(flows));
  const yieldPct = input.amount > 0 ? ((monthly * 12) / input.amount) * 100 : null;
  return { monthly, yieldPct, irrPct: irr };
}
