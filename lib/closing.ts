import { feeBreakdown } from "@/lib/money";

export const CLOSING_STEPS = [
  { key: "PURCHASE_AGREEMENT", label: "Purchase agreement" },
  { key: "BUYER_DEPOSIT", label: "Buyer deposit" },
  { key: "COLLATERAL_TRANSFER", label: "Collateral file transfer" },
  { key: "ASSIGNMENT", label: "Assignment and allonge" },
  { key: "PAYMENT_RECEIVED", label: "Payment received" },
  { key: "CLOSED", label: "Closed" },
] as const;

export type ClosingStepKey = (typeof CLOSING_STEPS)[number]["key"];

export function closingTotals(salePrice: number, premiumBps: number, commissionBps: number) {
  return feeBreakdown(salePrice, premiumBps, commissionBps);
}

export function stepLabel(key: string) {
  return CLOSING_STEPS.find((step) => step.key === key)?.label ?? key;
}

export function canCompleteStep(steps: { key: string; status: string }[], key: string) {
  if (key !== "CLOSED") return true;
  return steps.filter((step) => step.key !== "CLOSED").every((step) => step.status === "COMPLETE");
}

export function closingIsComplete(steps: { status: string }[]) {
  return steps.length > 0 && steps.every((step) => step.status === "COMPLETE");
}
