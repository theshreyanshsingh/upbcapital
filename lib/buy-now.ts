import { money } from "@/lib/format";
import { launchBlock } from "@/lib/launch-rules";

// Buy it now: a price the seller commits to in advance, taken by the first verified buyer who confirms it. These
// rules are pure, so the seller's page, the buyer's panel and the award all read the same ones.

// The seller may set it while the desk reviews the file or once it is live, so a listing can open with it.
export const BUY_NOW_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"] as const;

type Scope = { pool: boolean };

export function samePrice(a: number | null | undefined, b: number | null | undefined) {
  return a != null && b != null && Math.abs(a - b) < 0.005;
}

// Why the seller can't set or change the price now, or null when they can.
export function buyNowSetBlock(input: { status: string; bidMode: string; price: number; tradedLoans: number; openBuyNowBids: number }) {
  if (!(BUY_NOW_STATUSES as readonly string[]).includes(input.status)) return "Buy it now can be set while the listing is in review or live.";
  // A sealed or best-and-final round is weighed as a set at its deadline, and a take-it price would cut it short.
  if (input.bidMode !== "NONE") return "A sealed or best-and-final round sets the price at its deadline, so buy it now is for open offers only.";
  if (input.tradedLoans > 0) return "Some loans in this pool have traded, so it can't sell whole at one price.";
  if (input.openBuyNowBids > 0) return "A buyer confirmed buy it now, so the price stays until the desk decides that bid.";
  // Whole dollars, so the figure in the seller's consent and the one a buyer confirms read the same everywhere.
  if (!Number.isInteger(input.price) || input.price <= 0 || input.price > 1_000_000_000) return "Enter the buy-it-now price in whole dollars.";
  return null;
}

// Why the seller can't take the price off now, or null when they can. Once a buyer has confirmed, it is the
// record of what the seller agreed.
export function buyNowClearBlock(input: { status: string; buyNowPrice: number | null | undefined; openBuyNowBids: number }) {
  if (input.buyNowPrice == null) return "This listing has no buy-it-now price.";
  if (input.status === "PENDING" || input.status === "SOLD") return "This listing is in contract, so its buy-it-now price stays on the record.";
  if (input.openBuyNowBids > 0) return "A buyer confirmed buy it now, so the price stays until the desk decides that bid.";
  return null;
}

type OfferListing = { status: string; bidMode: string; buyNowPrice: number | null | undefined; launchAt?: Date | null };

// The price a buyer can take right now, or why not. Open offers only, and a pool only whole, while every loan in
// it is still for sale. A coming-soon listing waits for its launch like every other bid.
export function buyNowOffer(listing: OfferListing, wholeOpen: boolean, now = new Date()): { price: number; reason: null } | { price: null; reason: string } {
  if (listing.buyNowPrice == null || !(listing.buyNowPrice > 0)) return { price: null, reason: "This listing has no buy-it-now price." };
  if (listing.status !== "APPROVED") return { price: null, reason: "This listing isn't taking bids right now." };
  const coming = launchBlock(listing, "buyNow", now);
  if (coming) return { price: null, reason: coming };
  if (listing.bidMode !== "NONE") return { price: null, reason: "Buy it now is paused while a sealed or best-and-final round runs." };
  if (!wholeOpen) return { price: null, reason: "Some loans in this pool have traded, so it can't be bought whole." };
  return { price: listing.buyNowPrice, reason: null };
}

// A bid placed as buy it now, at exactly the seller's standing buy-it-now price, is one the seller agreed to in
// advance. A buyer who reprices it after, or a seller who changed the price before it, falls back to approval.
export function buyNowAgreed(input: { buyNow: boolean | null | undefined; price: number; buyNowPrice: number | null | undefined }) {
  return input.buyNow === true && input.buyNowPrice != null && input.buyNowPrice > 0 && samePrice(input.price, input.buyNowPrice);
}

// The words the seller agrees to. Shown in the confirmation with the typed price below it, and stored with the
// figure and the date as the record of the commitment.
export function buyNowConsent(input: Scope & { price?: number | null }) {
  const at = input.price == null ? "the price below" : money(input.price);
  return [
    // Counsel: the seller's pre-commitment to sell without a further approval.
    `I agree to sell ${input.pool ? "the whole pool" : "this note"} at ${at} to the first verified buyer who confirms it, without being asked again.`,
    // Counsel: how the fees fall on the committed price.
    "The buyer premium is added on top of that price, and the seller commission comes off it at closing.",
    // Counsel: the seller's right to withdraw the offer before acceptance.
    "I can change or remove this price until a buyer confirms it.",
  ].join(" ");
}

// The seller's panel, before and after they set a price.
export function buyNowSellerSummary(input: Scope & { set: boolean }) {
  const scope = input.pool ? "the whole pool" : "the note";
  return input.set
    ? // Counsel: the binding effect of the seller's price, restated on their page.
      `The first verified buyer who confirms it buys ${scope} at that price, and the closing opens at once with no further approval.`
    : // Counsel: what setting a price commits the seller to.
      `Name a price you'll take for ${scope} from the first verified buyer who confirms it. The closing opens at once, with no question to you first.`;
}

// Counsel: the buyer's panel, beside the price.
export const BUY_NOW_BUYER_SUMMARY = "The seller agreed this price in advance. The first verified buyer to confirm it opens the closing.";

// What happens after the seller commits, for the seller's confirmation.
export function buyNowSellerNext(input: { deposit?: [number, number]; diligenceDays?: number; live: boolean }) {
  const parts = [
    input.live ? "Verified buyers who can open the listing see it now." : "Verified buyers see it once the listing is live.",
    "When one confirms, the closing opens at once, the other bids close, and you and the desk are told.",
  ];
  if (input.deposit) parts.push(`The buyer owes a ${input.deposit[0]}% deposit within ${input.deposit[1]} day${input.deposit[1] === 1 ? "" : "s"}.`);
  if (input.diligenceDays) {
    // Counsel: the buyer's walk-away right, as the seller hears it.
    parts.push(`The buyer has ${input.diligenceDays} day${input.diligenceDays === 1 ? "" : "s"} of diligence in which they can walk away for a finding.`);
  }
  return parts.join(" ");
}

// What the buyer's confirmation says happens, for the offer panel's dialog.
export function buyNowTerms(input: Scope & { deposit?: [number, number]; diligenceDays?: number }) {
  const parts = [
    // Counsel: the seller's advance agreement, as the buyer hears it.
    `The seller agreed in advance to sell ${input.pool ? "the whole pool" : "this note"} at this price to the first verified buyer who confirms it.`,
    // Counsel: the buyer's commitment. Confirming binds them with no further acceptance.
    "If you are first, you're committed to buy at this price plus the buyer premium. The closing opens at once and the other bids close.",
  ];
  if (input.deposit) parts.push(`A ${input.deposit[0]}% deposit is due within ${input.deposit[1]} day${input.deposit[1] === 1 ? "" : "s"}.`);
  if (input.diligenceDays) {
    // Counsel: the buyer's walk-away right during diligence.
    parts.push(`After the award you have ${input.diligenceDays} day${input.diligenceDays === 1 ? "" : "s"} of diligence in which you can walk away for a finding.`);
  }
  // Counsel: what a buyer who isn't first owes.
  parts.push("If another buyer confirms first, your bid closes and nothing is owed.");
  return parts.join(" ");
}
