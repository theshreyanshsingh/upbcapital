import { answerSaleApproval, setReserve } from "@/actions/sale-approval";
import { SubmitButton } from "@/components/submit-button";
import { sealedFromSeller } from "@/lib/auction";
import { askedPriceStands, awaitingSeller, rivalBids } from "@/lib/awards";
import { money, prettyDate } from "@/lib/format";
import { buyerPrice, type OfferMoney } from "@/lib/offers";

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
  buyer: { name: string; companyName: string };
  messages: OfferMoney[];
};

type Listing = { id: string; status: string; reservePrice: number | null; bidMode: string; bidDeadline: Date | null };

const live = (offer: Offer) => offer.type === "OFFER" && (offer.status === "OPEN" || offer.status === "REVIEWED");

// The seller's side of every sale: bids the desk recommends, and the standing reserve that spares a question.
export function SaleApproval({ listing, offers, canAnswer }: { listing: Listing; offers: Offer[]; canAnswer: boolean }) {
  const waiting = offers.filter((offer) => live(offer) && awaitingSeller(offer));
  const sealed = sealedFromSeller(listing);
  return (
    <section className="mt-10 border border-border p-5 rounded-xl" aria-labelledby="approval-heading">
      <p id="approval-heading" className="eyebrow">Sale approval</p>
      <p className="mt-2 text-sm text-muted-foreground">Nothing sells without your word on the price. Approve each sale the desk recommends, or set a reserve and the desk may accept any bid at or above it.</p>
      {waiting.map((offer) => {
        const rest = rivalBids(offer, offers);
        // The buyer can reprice after the desk asks, and then this answer can't sell at the old figure.
        const current = buyerPrice(offer.amount, offer.messages, offer.buyerId);
        const moved = !askedPriceStands(offer.sellerAskedAmount, current);
        const notLive = listing.status !== "APPROVED";
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
            {canAnswer && (
              <form action={answerSaleApproval} className="mt-3 flex flex-wrap gap-2">
                {/* Not name="id": it shadows form.id in the DOM, and React then drops the clicked button's value. */}
                <input type="hidden" name="inquiryId" value={offer.id} />
                {!moved && !notLive && (
                  <button type="submit" name="answer" value="APPROVE" className="h-9 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background">Approve the sale</button>
                )}
                <button type="submit" name="answer" value="DECLINE" className="h-9 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-hover">Decline</button>
              </form>
            )}
          </div>
        );
      })}
      {canAnswer && (
        <form action={setReserve} className="mt-5 flex flex-wrap items-end gap-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Approve any bid at or above</span>
            <input name="reservePrice" inputMode="decimal" defaultValue={listing.reservePrice ?? ""} placeholder="No reserve" className="desk-input mt-2 w-48" aria-label="Reserve price" />
          </label>
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Save reserve</SubmitButton>
          <p className="w-full text-xs text-muted-foreground">Buyers never see it. Leave it blank and the desk asks you before every sale.</p>
        </form>
      )}
    </section>
  );
}
