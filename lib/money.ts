export function dollarsToCents(dollars: number) {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number) {
  return cents / 100;
}

export function applyBps(amountCents: number, bps: number) {
  return Math.round((amountCents * bps) / 10000);
}

// Flat rates on a price. A sale is charged through chargeFees or feesFor in lib/fee-schedule.ts, which use this for
// flat terms and add the tiers and minimums of a graded schedule.
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

// A figure as people type it: "1,250,000", "$1.25M", "70%", "250k". Anything else is NaN, for the caller to refuse.
export function typedNumber(raw: unknown) {
  const match = /^(\d+(?:\.\d+)?|\.\d+)([km]?)$/i.exec(String(raw ?? "").replace(/[$,%\s]/g, ""));
  if (!match) return Number.NaN;
  const scale = match[2].toLowerCase() === "m" ? 1e6 : match[2].toLowerCase() === "k" ? 1e3 : 1;
  return Number(match[1]) * scale;
}
