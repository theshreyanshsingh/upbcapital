import { deadlinePassed } from "@/lib/auction";
import { prettyDate } from "@/lib/format";

export type OfferMoney = { amount: number | null; kind: string; createdAt: Date; authorId?: string };

function pricedNewestFirst(messages: OfferMoney[]) {
  return messages
    .filter((message) => (message.kind === "OFFER" || message.kind === "COUNTER") && message.amount != null && message.amount > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// The newest price either side has put on the table: where the negotiation stands.
export function workingAmount(inquiryAmount: number | null, messages: OfferMoney[]) {
  return pricedNewestFirst(messages)[0]?.amount ?? inquiryAmount;
}

// What the buyer has agreed to pay: the opening bid, or the newest price the buyer posted, which includes
// accepting a desk or seller counter. A counter on its own is a proposal, so it is never what gets awarded.
export function buyerPrice(inquiryAmount: number | null, messages: OfferMoney[], buyerId: string) {
  return pricedNewestFirst(messages).find((message) => message.authorId === buyerId)?.amount ?? inquiryAmount;
}

// The desk's or the seller's counter when it is the newest price on the table, so the buyer still has to answer it.
export function openCounter(messages: OfferMoney[], buyerId: string) {
  const latest = pricedNewestFirst(messages)[0];
  return latest && latest.authorId !== buyerId ? latest.amount : null;
}

// Who put the open counter on the table, so the buyer knows whether accepting it is already agreed by the seller.
export function counterFrom(messages: OfferMoney[], buyerId: string, sellerId: string) {
  const latest = pricedNewestFirst(messages)[0];
  if (!latest || latest.authorId === buyerId) return null;
  return latest.authorId === sellerId ? ("seller" as const) : ("desk" as const);
}

export function canCounter(status: string) {
  return status === "OPEN" || status === "REVIEWED";
}

export function threadLabel(status: string, messages: OfferMoney[]) {
  if (status === "ACCEPTED") return "Accepted";
  if (status === "DECLINED") return "Declined";
  if (status === "WITHDRAWN") return "Withdrawn";
  if (status === "EXPIRED") return "Expired";
  const latest = [...messages].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (latest?.kind === "COUNTER") return "Counter open";
  return "Open";
}

const DAY = 24 * 60 * 60 * 1000;
export const MAX_GOOD_UNTIL_DAYS = 90;

// A bid past its good-until date can't be awarded, even before the expiry job marks it.
export function bidExpired(expiresAt: Date | null | undefined, now = new Date()) {
  return Boolean(expiresAt && expiresAt.getTime() <= now.getTime());
}

// The buyer's good-until date from the form: the end of that day in UTC, as closing dates are. Blank means the bid
// stands until it is withdrawn or decided. A sealed or best-and-final bid can only be awarded after the deadline,
// so a date before it would make the bid dead on arrival.
export function readGoodUntil(raw: string, listing: { bidMode: string; bidDeadline: Date | null }, now = new Date()): { error: string | null; expiresAt: Date | null } {
  const value = raw.trim();
  if (!value) return { error: null, expiresAt: null };
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:00Z`) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) return { error: "Enter the good-until date as a date, or leave it blank.", expiresAt: null };
  if (expiresAt.getTime() <= now.getTime()) return { error: "The good-until date has to be in the future.", expiresAt: null };
  if (expiresAt.getTime() - now.getTime() > MAX_GOOD_UNTIL_DAYS * DAY) return { error: `Keep the good-until date within ${MAX_GOOD_UNTIL_DAYS} days.`, expiresAt: null };
  if (listing.bidMode !== "NONE" && listing.bidDeadline && expiresAt.getTime() < listing.bidDeadline.getTime()) {
    return { error: "Bids here are decided after the deadline, so the good-until date has to be on or after it.", expiresAt: null };
  }
  return { error: null, expiresAt };
}

// Why the buyer can't take this bid back, or null when they can. Once a sealed or best-and-final round closes the
// bids in it bind until the desk decides them, because the seller weighs them as a set. A group's bid belongs to
// its seats, so it comes back through the group.
export function withdrawBlock(input: { type: string; status: string; bidMode: string; bidDeadline: Date | null; group: boolean; now?: Date }) {
  if (input.type !== "OFFER") return "Only a bid can be withdrawn.";
  if (input.status === "ACCEPTED") return "This bid was accepted, so it can't be withdrawn. Write the desk on the closing.";
  if (input.status !== "OPEN" && input.status !== "REVIEWED") return "This bid is already closed.";
  if (input.group) return "A group's offer is withdrawn by the group. Drop your seat or dissolve the group on the group page.";
  if (input.bidMode !== "NONE" && deadlinePassed(input.bidDeadline, input.now)) {
    return "The bid deadline has passed, so this bid binds until the desk decides it.";
  }
  return null;
}

// What the bid confirmation says about the time limits on both sides: the buyer's withdrawal right before an award,
// and the diligence window after one.
export function bidTerms(diligenceDays?: number) {
  const diligence = diligenceDays ? ` After an award you have ${diligenceDays} day${diligenceDays === 1 ? "" : "s"} of diligence in which you can walk away for a finding.` : "";
  return `${diligence} You can withdraw the bid from your inquiries until it's accepted, except in a sealed or best-and-final round once the deadline passes.`;
}

export function goodUntilRow(goodUntil: string): [string, string] {
  return ["Good until", goodUntil ? prettyDate(`${goodUntil}T23:59:00Z`) : "No end date"];
}
