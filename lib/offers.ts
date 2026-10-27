export type OfferMoney = { amount: number | null; kind: string; createdAt: Date };

export function workingAmount(inquiryAmount: number | null, messages: OfferMoney[]) {
  const priced = messages
    .filter((message) => (message.kind === "OFFER" || message.kind === "COUNTER") && message.amount != null && message.amount > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return priced[0]?.amount ?? inquiryAmount;
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
