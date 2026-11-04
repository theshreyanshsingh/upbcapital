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
// accepting a desk counter. A desk counter on its own is a proposal, so it is never what gets awarded.
export function buyerPrice(inquiryAmount: number | null, messages: OfferMoney[], buyerId: string) {
  return pricedNewestFirst(messages).find((message) => message.authorId === buyerId)?.amount ?? inquiryAmount;
}

// The desk's counter when it is the newest price on the table, so the buyer still has to answer it.
export function openCounter(messages: OfferMoney[], buyerId: string) {
  const latest = pricedNewestFirst(messages)[0];
  return latest && latest.authorId !== buyerId ? latest.amount : null;
}

export function canCounter(status: string) {
  return status === "OPEN" || status === "REVIEWED";
}

export function threadLabel(status: string, messages: OfferMoney[]) {
  if (status === "ACCEPTED") return "Accepted";
  if (status === "DECLINED") return "Declined";
  const latest = [...messages].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (latest?.kind === "COUNTER") return "Counter open";
  return "Open";
}
