export function deskFeeBps(chargeDeskFees: boolean, premiumBps: number, commissionBps: number) {
  if (!chargeDeskFees) return { premiumBps: 0, commissionBps: 0 };
  return { premiumBps, commissionBps };
}
