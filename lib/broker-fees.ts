export type FeeTerms = {
  basis: "PERCENT" | "FLAT";
  bps: number;
  cents: number;
};

export type DealRole = "SELLER_BROKER" | "AFFILIATE";

export type AssessedFee = {
  brokerId: string;
  role: DealRole;
  amountCents: number;
  basis: "PERCENT" | "FLAT";
};

export type AssessInput = {
  premiumCents: number;
  commissionCents: number;
  sellerId: string;
  buyerId: string | null;
  clientSellerName: string;
  brokerName: string;
  deal: { brokerId: string; role: DealRole; terms: FeeTerms | null } | null;
  referrer: { brokerId: string; terms: FeeTerms | null } | null;
  brokerSchedule: FeeTerms;
  affiliateSchedule: FeeTerms;
};

export function feeFromPool(poolCents: number, terms: FeeTerms) {
  if (terms.basis === "FLAT") return Math.max(0, Math.round(terms.cents));
  return Math.max(0, Math.round((poolCents * terms.bps) / 10000));
}

export function sameParty(left: string, right: string) {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a.length > 0 && a === b;
}

export function payoutNoteProblem(note: string) {
  const trimmed = note.trim();
  if (!trimmed) return "Say how the desk should pay you.";
  if (trimmed.length > 280) return "Keep the payout note under 280 characters.";
  if (/\d[\d\s-]{6,}\d/.test(trimmed)) return "Don't put account or routing numbers in the payout note. Name the method only.";
  if (/\b(routing|account number|iban|swift|aba)\b/i.test(trimmed)) return "Don't put bank coordinates in the payout note. Name the method only.";
  return null;
}

export function assessBrokerFees(input: AssessInput): { fees: AssessedFee[]; withheld: string[] } {
  const withheld: string[] = [];
  const fees: AssessedFee[] = [];
  const pool = Math.max(0, input.premiumCents) + Math.max(0, input.commissionCents);
  const scheduleFor = (role: DealRole) => (role === "AFFILIATE" ? input.affiliateSchedule : input.brokerSchedule);

  if (input.deal) {
    const brokerIsBuyer = Boolean(input.buyerId) && input.deal.brokerId === input.buyerId;
    const namedAsSeller = sameParty(input.clientSellerName, input.brokerName);
    const unnamedSelf = input.deal.brokerId === input.sellerId && !input.clientSellerName.trim();
    if (brokerIsBuyer) {
      withheld.push("No broker fee. The broker is the buyer on this trade.");
    } else if (namedAsSeller || unnamedSelf) {
      withheld.push("No broker fee. The broker is the seller on this trade.");
    } else {
      const terms = input.deal.terms ?? scheduleFor(input.deal.role);
      const amountCents = feeFromPool(pool, terms);
      if (amountCents > 0) fees.push({ brokerId: input.deal.brokerId, role: input.deal.role, amountCents, basis: terms.basis });
      else withheld.push("The listing fee calculated to zero.");
    }
  }

  if (input.referrer) {
    if (input.deal && input.referrer.brokerId === input.deal.brokerId) {
      withheld.push("Referral fee skipped. This broker is already paid on the listing.");
    } else if (input.buyerId && input.referrer.brokerId === input.buyerId) {
      withheld.push("No referral fee. The affiliate is the buyer.");
    } else if (input.referrer.brokerId === input.sellerId) {
      withheld.push("No referral fee. The affiliate is the seller.");
    } else {
      const terms = input.referrer.terms ?? input.affiliateSchedule;
      const amountCents = feeFromPool(pool, terms);
      if (amountCents > 0) fees.push({ brokerId: input.referrer.brokerId, role: "AFFILIATE", amountCents, basis: terms.basis });
      else withheld.push("The referral fee calculated to zero.");
    }
  }

  return { fees, withheld };
}

export function feeMonths(
  fees: { at: Date; amountCents: number; status: "OWED" | "PAID" }[],
  now = new Date(),
) {
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - index), 1));
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      label: date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      paid: 0,
      owed: 0,
    };
  });
  for (const fee of fees) {
    const slot = months.find((month) => month.year === fee.at.getUTCFullYear() && month.month === fee.at.getUTCMonth());
    if (!slot) continue;
    if (fee.status === "PAID") slot.paid += fee.amountCents;
    else slot.owed += fee.amountCents;
  }
  return months;
}

export function brokerRoleLabel(role: string | null | undefined) {
  if (role === "SELLER_BROKER") return "Seller's broker";
  if (role === "AFFILIATE") return "Referring affiliate";
  return "Broker";
}

export function splitStates(value: string) {
  return value
    .split(/[,/|]+/)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

export function portraitSrc(userId: string, key: string) {
  if (!key) return "";
  if (key.startsWith("/")) return key;
  return `/api/brokers/${userId}/portrait`;
}

export function brokerGate(input: {
  accountStatus: string;
  profile: { company: string; states: string; welcomedAt: Date | null } | null;
}) {
  if (!input.profile?.company.trim() || !input.profile.states.trim()) return "/broker/onboarding";
  if (input.accountStatus === "APPROVED" && !input.profile.welcomedAt) return "/broker/welcome";
  return null;
}
