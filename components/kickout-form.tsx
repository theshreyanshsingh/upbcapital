import { kickOutClosingLoan } from "@/actions/pool-sale";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/format";
import { BASIS_TEXT, excessLine, kickoutTerms } from "@/lib/kickouts";

type Loan = { id: string; streetAddress: string; city: string; state: string; askingPrice: number };

// The desk takes one loan out of an open closing that covers more than one. Each choice shows what the price would
// come down by and on what basis, so the desk sees the figures before both sides do.
export function KickoutForm({
  closing,
  loans,
  loanPrices,
  grouped,
}: {
  closing: {
    id: string;
    salePrice: number;
    buyerPremiumCents: number;
    sellerCommissionCents: number;
    depositCents: number | null;
    depositReceivedCents: number | null;
    fundsReceivedCents: number | null;
    proceedsSentCents: number | null;
  };
  loans: Loan[];
  loanPrices: unknown;
  // A group closing's shares are fixed seat by seat, so a loan can't come out of it.
  grouped: boolean;
}) {
  if (loans.length < 2) return null;
  const options = loans.map((loan) => ({
    loan,
    terms: kickoutTerms({ closing, loans: loans.map((item) => ({ id: item.id, ask: item.askingPrice })), noteId: loan.id, loanPrices }),
  }));
  const label = (loan: Loan) => `${loan.streetAddress ? `${loan.streetAddress}, ` : ""}${loan.city}, ${loan.state}`;
  const blocked = grouped
    ? "A group closing's shares are fixed seat by seat, so a loan can't come out of it. Cancel the closing instead."
    : closing.proceedsSentCents != null
      ? "The seller's proceeds are recorded as sent, so a loan can't come out now."
      : null;
  const excess = excessLine(options[0].terms);
  return (
    <form id="kickout" action={kickOutClosingLoan} className="glass scroll-mt-6 space-y-3 p-6">
      <input type="hidden" name="closingId" value={closing.id} />
      <p className="eyebrow">Take a loan out</p>
      <p className="text-sm text-muted-foreground">
        Remove one loan before settlement, such as for a title defect. The price comes down by the buyer&apos;s price for that loan, or by its share of the asking prices when the bid had none. Fees and the deposit follow. The loan goes back on the listing, and both sides are told.
      </p>
      {blocked ? (
        <p className="text-sm text-foreground">{blocked}</p>
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="text-[13px] text-muted-foreground">Which loan</legend>
            {options.map(({ loan, terms }) => (
              <label key={loan.id} className="flex items-start gap-2 text-sm text-foreground">
                <input type="radio" name="noteId" value={loan.id} required className="mt-1" />
                <span>
                  {label(loan)}
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    Down {money(terms.dropCents / 100, 2)} {BASIS_TEXT[terms.basis]}, to {money(terms.salePrice, 2)}
                    {terms.depositCents != null && terms.depositDropCents ? `. Deposit down ${money(terms.depositDropCents / 100, 2)}.` : "."}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="block text-[13px] text-muted-foreground">
            Why, in a sentence. Both sides see this.
            <Textarea name="reason" className="mt-1 min-h-20 bg-card" required minLength={3} />
          </label>
          {excess && <p className="text-sm text-bad">{excess}</p>}
          <ConfirmSubmit
            title="Take this loan out of the closing?"
            consequence={`The price, fees and deposit come down, the loan goes back on the listing, and both sides are told. It can't be put back into this closing.${excess ? ` ${excess}` : ""}`}
            typed={[["Reason both sides will see", "reason", "text"]]}
            confirmLabel="Take the loan out"
            pendingLabel="Removing…"
            tone="danger"
            className="h-9 text-[13px] font-medium"
          >
            Take loan out
          </ConfirmSubmit>
        </>
      )}
    </form>
  );
}
