export const DODD_FRANK = "Seller-financed notes to an owner-occupant can fall under Dodd-Frank ability-to-repay rules. Confirm an exemption before the file closes. This is a reminder, not legal advice.";

export const SAFE_ACT = "Originating seller financing can require a state mortgage license under the SAFE Act. UPB Capital is a desk, not a licensee. This is a reminder, not legal advice.";

export const FLORIDA_DISCLOSURE = {
  state: "FL",
  license: "Florida is the home desk. Confirm any mortgage-lender or broker registration that applies to this trade before funds move.",
  body: "Florida judicial foreclosure is the timing used when a state timeline is missing. A note secured by Florida property should carry the assignment, the allonge, and the collateral file. Licensing for the holder is a separate question from this marketplace.",
};

export function retentionCutoff(years: number, now = new Date()) {
  const cutoff = new Date(now);
  const safeYears = Math.max(1, Math.round(years) || 1);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - safeYears);
  return cutoff;
}

export function showsOriginationReminder(input: { sellerFinanced: boolean; sellerRole: string }) {
  return input.sellerFinanced || input.sellerRole === "INDIVIDUAL_SELLER";
}
