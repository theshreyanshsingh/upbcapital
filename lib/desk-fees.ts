import { feeTerms, readSchedule, type FeeSchedule, type FeeSettings, type ListingFees } from "@/lib/fee-schedule";

// The desk buying for its own book never pays itself a premium, which would only inflate revenue and broker
// pools. The setting decides whether the seller still pays the commission. chargeFees in lib/fee-schedule.ts applies
// the same rule to a graded schedule.
export function deskFeeBps(chargeDeskFees: boolean, commissionBps: number) {
  return { premiumBps: 0, commissionBps: chargeDeskFees ? commissionBps : 0 };
}

// What the desk's approval writes on a listing: the fees in force as it goes live, so a later change in the settings
// doesn't reprice paper already marketed. Settings read from the database carry feeSchedule, and the listing keeps
// the schedule too, or null to clear one kept by an earlier approval.
export function feesAtApproval(settings: FeeSettings): { feeBuyerPremiumBps: number; feeSellerCommissionBps: number; feeSchedule?: FeeSchedule | null } {
  const flat = { feeBuyerPremiumBps: settings.buyerPremiumBps, feeSellerCommissionBps: settings.sellerCommissionBps };
  if (settings.feeSchedule === undefined) return flat;
  return { ...flat, feeSchedule: readSchedule(settings.feeSchedule) };
}

// The flat rates a listing trades at. A graded listing has no single rate, so anything that charges or shows a fee
// goes through feesFor in lib/fee-schedule.ts; this stays for a caller that only needs the flat fields.
export function listingFeeBps(listing: ListingFees | null | undefined, settings: FeeSettings) {
  const terms = feeTerms(listing, settings);
  return { premiumBps: terms.premiumBps, commissionBps: terms.commissionBps };
}
