export function dollarsToCents(dollars: number) {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number) {
  return cents / 100;
}

export function applyBps(amountCents: number, bps: number) {
  return Math.round((amountCents * bps) / 10000);
}

export function feeBreakdown(salePriceDollars: number, premiumBps: number, commissionBps: number) {
  const saleCents = dollarsToCents(salePriceDollars);
  const premiumCents = applyBps(saleCents, premiumBps);
  const commissionCents = applyBps(saleCents, commissionBps);
  return {
    saleCents,
    premiumCents,
    commissionCents,
    buyerTotalCents: saleCents + premiumCents,
    netToSellerCents: saleCents - commissionCents,
  };
}

export function bpsToPercent(bps: number) {
  return bps / 100;
}

export function percentToBps(percent: number) {
  return Math.round(percent * 100);
}
