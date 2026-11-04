// The desk buying for its own book never pays itself a premium, which would only inflate revenue and broker
// pools. The setting decides whether the seller still pays the commission.
export function deskFeeBps(chargeDeskFees: boolean, commissionBps: number) {
  return { premiumBps: 0, commissionBps: chargeDeskFees ? commissionBps : 0 };
}
