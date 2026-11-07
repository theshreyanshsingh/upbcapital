import { money } from "@/lib/format";
import { standingLoanPrices } from "@/lib/loan-prices";

// A pool bid's price for each loan, folded under the bid. The desk's bid sheet and the seller's page both use it,
// and the page decides who the bidder is called: a name for the desk, a letter for the seller.
export function BidLoanPrices({
  loanPrices,
  allowPartial,
  price,
  loans,
}: {
  loanPrices: unknown;
  allowPartial: boolean | null | undefined;
  // The buyer's price now. Prices that no longer add up to it aren't shown as the bid's.
  price: number | null;
  loans: { id: string; label: string }[];
}) {
  const prices = standingLoanPrices(loanPrices, price);
  if (!prices) return null;
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        Priced loan by loan · {allowPartial ? "part of the pool may be taken" : "whole pool only"}
      </summary>
      <ul className="mt-1 space-y-0.5 tabular-nums">
        {loans.map((loan) => (
          <li key={loan.id} className="flex justify-between gap-3">
            <span>{loan.label}</span>
            <span className="text-foreground">{prices[loan.id] != null ? money(prices[loan.id], 2) : "Not priced"}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
