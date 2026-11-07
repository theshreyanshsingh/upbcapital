// A whole-pool bid may carry a price for each loan, as { noteId: dollars }, summing to the bid. The prices let the
// desk take part of the pool when the buyer allows it, and size a kick-out. Plain functions, so the bid form can run
// the same check the server does.

export type LoanPrices = Record<string, number>;

// A dollar either way is rounding across a pool's loans, not a different bid.
export const LOAN_PRICE_SLACK = 1;

export function sumPrices(prices: LoanPrices, noteIds?: readonly string[]) {
  const ids = noteIds ?? Object.keys(prices);
  return ids.reduce((sum, id) => sum + (prices[id] ?? 0), 0);
}

// The stored JSON as prices, or null when it is missing or malformed.
export function readLoanPrices(raw: unknown): LoanPrices | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const prices: LoanPrices = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const amount = typeof value === "number" ? value : Number(value);
    if (!id || !Number.isFinite(amount) || amount <= 0) return null;
    prices[id] = amount;
  }
  return Object.keys(prices).length ? prices : null;
}

// The prices only while they still add up to what the buyer is bidding. A counter the buyer accepted without
// re-pricing leaves them behind, and they no longer describe the bid.
export function standingLoanPrices(raw: unknown, price: number | null | undefined) {
  const prices = readLoanPrices(raw);
  if (!prices || price == null || !(price > 0)) return null;
  return Math.abs(sumPrices(prices) - price) <= LOAN_PRICE_SLACK ? prices : null;
}

// The buyer's prices for exactly these loans, while they add up to what the loans sell for: a part-pool closing, or
// a pool closing after a kick-out. Null when any loan is unpriced or the sum has moved.
export function pricesFor(raw: unknown, noteIds: readonly string[], total: number) {
  const prices = readLoanPrices(raw);
  if (!prices || !noteIds.length || noteIds.some((id) => prices[id] == null)) return null;
  return Math.abs(sumPrices(prices, noteIds) - total) <= LOAN_PRICE_SLACK ? prices : null;
}

// Why these loan prices can't go with this bid, or null. Every loan in the pool needs a price above zero, and the
// prices must add up to the bid within a dollar.
export function loanPriceProblem(input: { prices: LoanPrices; loanIds: readonly string[]; amount: number }) {
  const loans = new Set(input.loanIds);
  if (Object.keys(input.prices).some((id) => !loans.has(id))) return "A loan price is for a loan that isn't in this pool.";
  if (input.loanIds.some((id) => input.prices[id] == null)) return "Price every loan in the pool, or leave the loan prices blank.";
  if (Object.values(input.prices).some((amount) => !Number.isFinite(amount) || amount < 1)) return "Each loan price must be at least $1.";
  const total = sumPrices(input.prices);
  if (Math.abs(total - input.amount) > LOAN_PRICE_SLACK) {
    return `The loan prices add up to ${dollars(total)}, not your bid of ${dollars(input.amount)}. They must match within $1.`;
  }
  return null;
}

// The loan prices and the partial permission from a bid form: `loanPrice_<noteId>` fields and an `allowPartial`
// box. Blank fields are no loan prices at all. A figure that doesn't read as dollars is an error, not a blank.
export function loanPricesFromForm(formData: FormData) {
  const prices: LoanPrices = {};
  let typed = 0;
  let unreadable = false;
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith("loanPrice_")) continue;
    const raw = String(value ?? "").replace(/[$,\s]/g, "");
    if (!raw) continue;
    typed += 1;
    const amount = Number(raw);
    if (!Number.isFinite(amount)) unreadable = true;
    else prices[name.slice("loanPrice_".length)] = amount;
  }
  const allowPartial = String(formData.get("allowPartial") || "") === "yes";
  if (unreadable) return { prices: null, allowPartial, error: "Enter each loan price in dollars." } as const;
  if (!typed) {
    return allowPartial
      ? ({ prices: null, allowPartial, error: "Price each loan to let the seller take part of the pool." } as const)
      : ({ prices: null, allowPartial: false, error: null } as const);
  }
  return { prices, allowPartial, error: null } as const;
}

// The bid spread across the loans by their asking prices, in whole dollars, with the last loan taking the rounding.
// Equal shares when the asks are missing. The buyer edits from here.
export function spreadByAsk(amount: number, loans: readonly { id: string; ask: number | null }[]) {
  if (!loans.length || !(amount > 0)) return {} as LoanPrices;
  const asks = loans.map((loan) => (loan.ask != null && loan.ask > 0 ? loan.ask : 0));
  const total = asks.reduce((sum, ask) => sum + ask, 0);
  const prices: LoanPrices = {};
  let left = Math.round(amount);
  loans.forEach((loan, index) => {
    if (index === loans.length - 1) {
      prices[loan.id] = left;
      return;
    }
    const share = Math.round(total > 0 ? (amount * asks[index]) / total : amount / loans.length);
    prices[loan.id] = share;
    left -= share;
  });
  return prices;
}

function dollars(amount: number) {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
