// The desk buying for its own book never pays itself a premium, which would only inflate revenue and broker
// pools. The setting decides whether the seller still pays the commission.
export function deskFeeBps(chargeDeskFees: boolean, commissionBps: number) {
  return { premiumBps: 0, commissionBps: chargeDeskFees ? commissionBps : 0 };
}

type FeeSettings = { buyerPremiumBps: number; sellerCommissionBps: number };
type ListingFees = { feeBuyerPremiumBps?: number | null; feeSellerCommissionBps?: number | null };

// What the desk's approval writes on a listing: the fees in force as it goes live, so a later change in the settings
// doesn't reprice paper already marketed.
export function feesAtApproval(settings: FeeSettings) {
  return { feeBuyerPremiumBps: settings.buyerPremiumBps, feeSellerCommissionBps: settings.sellerCommissionBps };
}

// The fees a listing trades at. A listing approved before fees were kept on it takes the settings of the day.
export function listingFeeBps(listing: ListingFees | null | undefined, settings: FeeSettings) {
  return {
    premiumBps: listing?.feeBuyerPremiumBps ?? settings.buyerPremiumBps,
    commissionBps: listing?.feeSellerCommissionBps ?? settings.sellerCommissionBps,
  };
}
