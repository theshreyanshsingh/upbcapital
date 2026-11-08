import { counterBid, saveFeePayer, saveResponseWindow } from "@/actions/seller-decisions";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { FEE_PAYERS, FEE_PAYER_LABELS, feePayerOf, feesFor, type FeeSettings, type ListingFees } from "@/lib/fee-schedule";
import { money } from "@/lib/format";
import {
  DEFAULT_RESPONSE_HOURS,
  MAX_RESPONSE_HOURS,
  MIN_RESPONSE_HOURS,
  answerWindowText,
  feePayerBlock,
  responseHours,
  trackLine,
  type TrackRecord,
} from "@/lib/seller-decisions";

// The seller's decision tools on their sale approval panel (lib/seller-decisions.ts holds the rules).

// The bidder's record beside their letter. Never a name, an email, a company or the funds figure.
export function TrackRecordLine({ record }: { record: TrackRecord | undefined }) {
  if (!record) return null;
  return <p className="mt-0.5 text-[13px] text-muted-foreground tabular-nums">{trackLine(record)}</p>;
}

// The date the desk's ask is due, under the ask.
export function AnswerBy({ offer }: { offer: { sellerAskedAt: Date | null; sellerAnsweredAt: Date | null; sellerRespondBy?: Date | null } }) {
  const text = answerWindowText(offer);
  return text ? <p className="mt-2 text-sm text-foreground tabular-nums">{text}</p> : null;
}

export function BidSummaryLinks({ listingId }: { listingId: string }) {
  return (
    <p className="mt-3 text-[13px] text-muted-foreground">
      Bid summary, with each bidder&apos;s record:{" "}
      <a className="text-link" href={`/api/listings/${listingId}/bid-summary`}>CSV</a> ·{" "}
      <a className="text-link" href={`/api/listings/${listingId}/bid-summary?format=pdf`}>PDF</a>. Sealed amounts stay out until the deadline.
    </p>
  );
}

// A counter to a live bid the desk didn't ask about. It approves that price, and the desk still makes the award.
export function CounterBid({ offerId, who, price, scope }: { offerId: string; who: string; price: number; scope: string }) {
  return (
    <form action={counterBid} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="inquiryId" value={offerId} />
      <label className="block">
        <span className="sr-only">Your counter to {who}</span>
        <input name="counterAmount" inputMode="decimal" required placeholder="Your counter" aria-label={`Your counter to ${who}`} className="desk-input w-36" />
      </label>
      <ConfirmSubmit
        title={`Counter ${who} at your price?`}
        consequence={`The buyer sees your price as a counter. Countering approves a sale of ${scope === "Whole listing" ? "the whole listing" : "this loan"} at exactly that price, so if the buyer accepts it the desk can award it without asking you again. Their bid of ${money(price)} stays open meanwhile. You can counter other bidders too. When one bid is awarded, your other counters close.`}
        typed={[["Your counter", "counterAmount", "money"]]}
        confirmLabel="Send the counter"
        pendingLabel="Sending…"
        variant="outline"
        className="h-9 px-3 text-[13px] font-medium"
      >
        Counter
      </ConfirmSubmit>
    </form>
  );
}

type TermsListing = ListingFees & {
  id: string;
  status: string;
  sellerResponseHours?: number | null;
  notes?: { askingPrice: number }[];
};

// The seller's own terms: how long they have to answer the desk, and who pays UPB's fees. The payer locks at go-live.
export function SellerTerms({ listing, canAnswer, settings }: { listing: TermsListing; canAnswer: boolean; settings: FeeSettings }) {
  const hours = responseHours(listing);
  const payer = feePayerOf(listing.feePayer);
  const locked = feePayerBlock(listing.status);
  const ask = (listing.notes ?? []).reduce((sum, note) => sum + Number(note.askingPrice), 0);
  const closed = listing.status === "SOLD" || listing.status === "WITHDRAWN";
  const at = (choice: string) => feesFor({ ...listing, feePayer: choice }, settings, ask);
  return (
    <div id="seller-terms" className="mt-6 scroll-mt-6 border-t border-border pt-5">
      <p className="text-[13px] font-semibold text-foreground">Your terms</p>
      <p className="mt-1 text-sm text-muted-foreground">
        You have {hours} hours to answer each ask from the desk{listing.sellerResponseHours == null ? `, the default` : ""}. Halfway through you get a reminder, and at the end the desk is told. Nothing is declined for you.
      </p>
      {canAnswer && !closed && (
        <form action={saveResponseWindow} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Hours to answer, {MIN_RESPONSE_HOURS} to {MAX_RESPONSE_HOURS}</span>
            <input
              name="sellerResponseHours"
              type="number"
              min={MIN_RESPONSE_HOURS}
              max={MAX_RESPONSE_HOURS}
              step={1}
              required
              defaultValue={listing.sellerResponseHours ?? DEFAULT_RESPONSE_HOURS}
              className="desk-input mt-2 w-32 tabular-nums"
            />
          </label>
          <SubmitButton variant="outline" pendingLabel="Saving…" className="h-11 text-[13px] font-medium">Save the window</SubmitButton>
          <p className="w-full text-xs text-muted-foreground">It counts from the desk&apos;s next ask. An ask already open keeps its date.</p>
        </form>
      )}
      <p className="mt-4 text-sm text-muted-foreground">
        UPB&apos;s fees: <span className="text-foreground">{FEE_PAYER_LABELS[payer].toLowerCase()}</span>.{" "}
        {locked ? "This was fixed when the listing went live, with the rates." : "You can change it until the listing goes live. Then it locks with the rates."}
      </p>
      {canAnswer && !locked && (
        <form action={saveFeePayer} className="mt-3 space-y-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <fieldset>
            <legend className="text-[13px] text-muted-foreground">Who pays{ask > 0 ? `, at your asking price of ${money(ask)} and today's rates` : ""}</legend>
            <div className="mt-2 space-y-2">
              {FEE_PAYERS.map((choice) => {
                const fees = at(choice);
                return (
                  <label key={choice} className="flex items-start gap-2 text-sm text-foreground">
                    <input type="radio" name="feePayer" value={choice} defaultChecked={payer === choice} className="mt-1" />
                    <span>
                      {FEE_PAYER_LABELS[choice]}
                      {ask > 0 && (
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          The buyer pays {money(fees.buyerTotalCents / 100)} · you net {money(fees.netToSellerCents / 100)}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <p className="text-xs text-muted-foreground">Buyers see the fee on the listing before they bid. A buyer who pays both fees may bid lower.</p>
          <SubmitButton variant="outline" pendingLabel="Saving…" className="h-11 text-[13px] font-medium">Save who pays</SubmitButton>
        </form>
      )}
    </div>
  );
}
