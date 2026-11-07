"use client";

import { useState } from "react";
import { money } from "@/lib/format";
import { LOAN_PRICE_SLACK, spreadByAsk } from "@/lib/loan-prices";

export type PricedLoan = { id: string; label: string; ask: number | null };

export type LoanPriceSummary = { priced: number; sum: number; allowPartial: boolean };

// A page of inputs is fine for a pool of a few hundred loans. Past that the buyer sends the desk a file instead.
export const MAX_PRICED_LOANS = 250;

// A price for each loan of a whole-pool bid, and the buyer's permission for the seller to take part of the pool at
// them. Blank means no loan prices, which is how most bids go in. The server checks the same sum.
export function LoanPriceFields({
  loans,
  total,
  onSummary,
  defaultPrices,
  defaultAllow = false,
}: {
  loans: PricedLoan[];
  // The bid the prices must add up to, when the form knows it.
  total: number | null;
  onSummary?: (summary: LoanPriceSummary) => void;
  defaultPrices?: Record<string, number> | null;
  defaultAllow?: boolean;
}) {
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(loans.map((loan) => [loan.id, defaultPrices?.[loan.id] != null ? String(defaultPrices[loan.id]) : ""])),
  );
  const [allow, setAllow] = useState(defaultAllow);
  if (loans.length > MAX_PRICED_LOANS) {
    return (
      <p className="rounded-lg border border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        Loan prices can be set here on pools of up to {MAX_PRICED_LOANS} loans. For a larger pool, send the desk your loan-level prices with the bid.
      </p>
    );
  }
  const read = (raw: string) => {
    const value = Number(raw.replace(/[$,\s]/g, ""));
    return raw.trim() && Number.isFinite(value) ? value : null;
  };
  const summarize = (next: Record<string, string>, nextAllow: boolean) => {
    const values = Object.values(next).map(read).filter((value): value is number => value != null);
    onSummary?.({ priced: values.length, sum: values.reduce((sum, value) => sum + value, 0), allowPartial: nextAllow });
  };
  const update = (next: Record<string, string>) => {
    setPrices(next);
    summarize(next, allow);
  };
  const values = Object.values(prices).map(read);
  const priced = values.filter((value) => value != null).length;
  const sum = values.reduce<number>((acc, value) => acc + (value ?? 0), 0);
  const gap = total != null && total > 0 ? total - sum : null;
  const status =
    priced === 0
      ? "No loan prices yet."
      : priced < loans.length
        ? `${priced} of ${loans.length} loans priced. Price every loan, or clear them all.`
        : gap == null
          ? `The loan prices add up to ${money(sum, 2)}.`
          : Math.abs(gap) <= LOAN_PRICE_SLACK
            ? `The loan prices add up to ${money(sum, 2)}, which matches your bid.`
            : gap > 0
              ? `The loan prices add up to ${money(sum, 2)}, ${money(gap, 2)} under your bid.`
              : `The loan prices add up to ${money(sum, 2)}, ${money(-gap, 2)} over your bid.`;
  const off = priced > 0 && (priced < loans.length || (gap != null && Math.abs(gap) > LOAN_PRICE_SLACK));
  return (
    <details className="rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer text-[13px] font-medium text-foreground">Price each loan (optional)</summary>
      <div className="mt-3 space-y-3 pb-1">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Some sellers need a price for every loan. Your loan prices must add up to your bid, within $1. The seller sees them by your bidder letter, not your name.
        </p>
        {total != null && total > 0 && (
          <button
            type="button"
            onClick={() => update(Object.fromEntries(Object.entries(spreadByAsk(total, loans)).map(([id, value]) => [id, String(value)])))}
            className="text-xs font-medium text-link"
          >
            {loans.some((loan) => loan.ask != null && loan.ask > 0) ? "Spread my bid by asking price" : "Spread my bid evenly"}
          </button>
        )}
        <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {loans.map((loan) => (
            <li key={loan.id}>
              <label className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">
                  {loan.label}
                  {loan.ask != null && <span className="block tabular-nums">Ask {money(loan.ask)}</span>}
                </span>
                <input
                  name={`loanPrice_${loan.id}`}
                  inputMode="decimal"
                  value={prices[loan.id] ?? ""}
                  onChange={(event) => update({ ...prices, [loan.id]: event.target.value })}
                  aria-label={`Your price for ${loan.label}`}
                  className="desk-input h-9 w-32 px-2 tabular-nums max-md:h-11"
                />
              </label>
            </li>
          ))}
        </ul>
        <p role="status" className={`text-xs tabular-nums ${off ? "text-bad" : "text-muted-foreground"}`}>{status}</p>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            name="allowPartial"
            value="yes"
            checked={allow}
            onChange={(event) => {
              setAllow(event.target.checked);
              summarize(prices, event.target.checked);
            }}
            className="mt-1"
          />
          <span>
            The seller may take part of the pool at these loan prices
            <span className="block text-xs text-muted-foreground">The desk can then award you some of the loans at your prices and sell the rest to other buyers.</span>
          </span>
        </label>
      </div>
    </details>
  );
}
