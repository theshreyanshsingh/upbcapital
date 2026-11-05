import { answerSaleApproval, setReserve } from "@/actions/sale-approval";
import { withdrawListing } from "@/actions/seller-controls";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { sealedFromSeller } from "@/lib/auction";
import { askedPriceStands, awaitingSeller, rivalBids } from "@/lib/awards";
import { listingWithdrawBlock } from "@/lib/listing-status";
import { money, prettyDate } from "@/lib/format";
import { bidExpired, buyerPrice, type OfferMoney } from "@/lib/offers";

type Offer = {
  id: string;
  status: string;
  type: string;
  buyerId: string;
  noteId: string | null;
  amount: number | null;
  sellerAskedAt: Date | null;
  sellerAskedAmount: number | null;
  sellerAnsweredAt: Date | null;
  sellerCounterAmount?: number | null;
  sellerCounteredAt?: Date | null;
  expiresAt?: Date | null;
  buyer: { name: string; companyName: string };
  messages: OfferMoney[];
};

type Listing = { id: string; status: string; reservePrice: number | null; bidMode: string; bidDeadline: Date | null };

const live = (offer: Offer) => offer.type === "OFFER" && (offer.status === "OPEN" || offer.status === "REVIEWED");

// The seller's side of every sale: bids the desk recommends, and the standing reserve that spares a question.
export function SaleApproval({ listing, offers, canAnswer }: { listing: Listing; offers: Offer[]; canAnswer: boolean }) {
  const waiting = offers.filter((offer) => live(offer) && awaitingSeller(offer));
  // A counter stands as the seller's approval of that price until the bid is awarded or closed.
  const countered = offers.filter((offer) => live(offer) && !awaitingSeller(offer) && offer.sellerCounterAmount != null && offer.sellerCounteredAt);
  const sealed = sealedFromSeller(listing);
  return (
    <section className="mt-10 border border-border p-5 rounded-xl" aria-labelledby="approval-heading">
      <p id="approval-heading" className="eyebrow">Sale approval</p>
      <p className="mt-2 text-sm text-muted-foreground">Nothing sells without your word on the price. Approve each sale the desk recommends or counter it with your own price, or set a reserve and the desk may accept any bid at or above it.</p>
      {waiting.map((offer) => {
        const rest = rivalBids(offer, offers);
        // The buyer can reprice after the desk asks, and then this answer can't sell at the old figure.
        const current = buyerPrice(offer.amount, offer.messages, offer.buyerId);
        const moved = !askedPriceStands(offer.sellerAskedAmount, current);
        const notLive = listing.status !== "APPROVED";
        const lapsed = bidExpired(offer.expiresAt);
        return (
          <div key={offer.id} className="mt-4 border border-link/30 bg-link/5 p-4 rounded-xl">
            <p className="text-[13px] text-muted-foreground">The desk recommends · {prettyDate(offer.sellerAskedAt)}</p>
            <p className="mt-1 font-semibold tracking-tight text-2xl">{money(Number(offer.sellerAskedAmount))}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {offer.buyer.companyName || offer.buyer.name} · {offer.noteId ? "one loan" : "the whole listing"}
              {rest.count ? ` · ${rest.count} other open bid${rest.count === 1 ? "" : "s"} for it${rest.best && !sealed ? `, highest ${money(rest.best)}` : ""}` : " · no other open bids for it"}
            </p>
            {moved && current != null && (
              <p className="mt-2 text-sm text-foreground">The buyer has since changed their bid to {money(current)}, so this figure can no longer be approved.</p>
            )}
            {notLive && <p className="mt-2 text-sm text-foreground">This listing isn&apos;t live right now, so the sale can&apos;t be approved.</p>}
            {offer.expiresAt && (
              <p className="mt-2 text-sm text-muted-foreground">
                {lapsed ? `The buyer's bid lapsed on ${prettyDate(offer.expiresAt)}, so there is nothing to answer.` : `The buyer's bid is good until ${prettyDate(offer.expiresAt)}.`}
              </p>
            )}
            {canAnswer && !lapsed && (
              <form action={answerSaleApproval} className="mt-3 flex flex-wrap gap-2">
                {/* Not name="id": it shadows form.id in the DOM, and React then drops the clicked button's value. */}
                <input type="hidden" name="inquiryId" value={offer.id} />
                {!moved && !notLive && (
                  <ConfirmSubmit
                    name="answer"
                    value="APPROVE"
                    title={`Sell at ${money(Number(offer.sellerAskedAmount))}?`}
                    consequence={`Approving binds you to sell ${offer.noteId ? "this loan" : "the whole listing"} at this price. The desk opens the closing, and the commission comes off the price at closing.`}
                    details={<ConfirmRows rows={[["Buyer", offer.buyer.companyName || offer.buyer.name], ["Sale price", money(Number(offer.sellerAskedAmount))]]} />}
                    confirmLabel="Approve the sale"
                    pendingLabel="Approving…"
                    className="h-9 px-3 text-[13px] font-medium"
                  >
                    Approve the sale
                  </ConfirmSubmit>
                )}
                <SubmitButton name="answer" value="DECLINE" variant="outline" pendingLabel="Declining…" className="h-9 px-3 text-[13px] font-medium">
                  Decline
                </SubmitButton>
              </form>
            )}
            {canAnswer && !lapsed && !notLive && (
              <form action={answerSaleApproval} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="inquiryId" value={offer.id} />
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Or counter with your price</span>
                  <input name="counterAmount" inputMode="decimal" required placeholder="Your price" className="desk-input mt-2 w-48" />
                </label>
                <ConfirmSubmit
                  name="answer"
                  value="COUNTER"
                  title={`Counter ${money(Number(offer.sellerAskedAmount))}?`}
                  consequence={`The buyer sees your price as a counter. Countering approves a sale of ${offer.noteId ? "this loan" : "the whole listing"} at exactly that price, so if the buyer accepts it the desk can award it without asking you again. Their bid of ${money(Number(current ?? offer.sellerAskedAmount))} stays open meanwhile.`}
                  typed={[["Your counter", "counterAmount", "money"]]}
                  confirmLabel="Send the counter"
                  pendingLabel="Sending…"
                  variant="outline"
                  className="h-11 px-3 text-[13px] font-medium"
                >
                  Counter
                </ConfirmSubmit>
              </form>
            )}
          </div>
        );
      })}
      {countered.map((offer) => {
        const taken = askedPriceStands(offer.sellerCounterAmount, buyerPrice(offer.amount, offer.messages, offer.buyerId));
        return (
          <div key={offer.id} className="mt-4 border border-border p-4 rounded-xl">
            <p className="text-[13px] text-muted-foreground">You countered · {prettyDate(offer.sellerCounteredAt)}</p>
            <p className="mt-1 font-semibold tracking-tight text-2xl">{money(Number(offer.sellerCounterAmount))}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {offer.buyer.companyName || offer.buyer.name} · {offer.noteId ? "one loan" : "the whole listing"} ·{" "}
              {taken ? "the buyer accepted it. The desk awards it next." : "waiting on the buyer. If they accept, the desk can award it at this price."}
            </p>
          </div>
        );
      })}
      {canAnswer && (
        <form action={setReserve} className="mt-5 flex flex-wrap items-end gap-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Approve any bid at or above</span>
            <input name="reservePrice" inputMode="decimal" defaultValue={listing.reservePrice ?? ""} placeholder="No reserve" className="desk-input mt-2 w-48" />
          </label>
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Save reserve</SubmitButton>
          <p className="w-full text-xs text-muted-foreground">Buyers never see it. Leave it blank and the desk asks you before every sale.</p>
        </form>
      )}
    </section>
  );
}

// The seller's way off the book before a sale, for the seller of record or the filing broker. In contract and sold
// show nothing here; a pool with one loan in contract says why it can't go yet.
export function WithdrawListing({
  listing,
  offers,
  ask,
  openClosings,
  canWithdraw,
}: {
  listing: Listing & { title: string; withdrawnAt: Date | null };
  offers: Offer[];
  ask: number;
  openClosings: number;
  canWithdraw: boolean;
}) {
  if (listing.status === "WITHDRAWN") {
    return (
      <p role="status" className="mt-10 border border-border px-4 py-3 text-sm text-muted-foreground rounded-xl">
        Withdrawn{listing.withdrawnAt ? ` ${prettyDate(listing.withdrawnAt)}` : ""}. It is off the book and its bids were declined. To sell it later, list it again and the desk reviews it.
      </p>
    );
  }
  if (!canWithdraw || listing.status === "PENDING" || listing.status === "SOLD") return null;
  const blocked = listingWithdrawBlock(listing.status, openClosings);
  const open = offers.filter(live);
  const sealed = sealedFromSeller(listing);
  const best = open.reduce((top, offer) => Math.max(top, buyerPrice(offer.amount, offer.messages, offer.buyerId) ?? 0), 0);
  const bids = open.length ? `${open.length} open bid${open.length === 1 ? " is" : "s are"} declined and the bidder${open.length === 1 ? " is" : "s are"} told` : "It has no open bids";
  return (
    <section className="mt-10 border border-border p-5 rounded-xl" aria-labelledby="withdraw-heading">
      <p id="withdraw-heading" className="eyebrow">Withdraw the listing</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Take it off the book before a sale. Open bids are declined, open desk bids end, and any group buying it closes. It can&apos;t be put back. To sell it later, list it again and the desk reviews it.
      </p>
      {blocked ? (
        <p className="mt-3 text-sm text-foreground">{blocked}</p>
      ) : (
        <form action={withdrawListing} className="mt-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <ConfirmSubmit
            title={`Withdraw ${listing.title}?`}
            consequence={`It comes off the book now. ${bids}, and the desk is told. It can't be put back.`}
            details={
              <ConfirmRows
                rows={[
                  ["Asking price", money(ask)],
                  ["Open bids", String(open.length)],
                  ...(best > 0 && !sealed ? ([["Highest open bid", money(best)]] as [string, string][]) : []),
                ]}
              />
            }
            confirmLabel="Withdraw the listing"
            pendingLabel="Withdrawing…"
            tone="danger"
            variant="outline"
            className="h-9 px-3 text-[13px] font-medium"
          >
            Withdraw listing
          </ConfirmSubmit>
        </form>
      )}
    </section>
  );
}
