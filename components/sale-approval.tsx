import { answerSaleApproval, setReserve } from "@/actions/sale-approval";
import { SubmitButton } from "@/components/submit-button";
import { awaitingSeller } from "@/lib/awards";
import { money, prettyDate } from "@/lib/format";

type Offer = {
  id: string;
  status: string;
  type: string;
  noteId: string | null;
  amount: number | null;
  sellerAskedAt: Date | null;
  sellerAskedAmount: number | null;
  sellerAnsweredAt: Date | null;
  buyer: { name: string; companyName: string };
};

// The seller's side of every sale: bids the desk recommends, and the standing reserve that spares a question.
export function SaleApproval({ listing, offers, canAnswer }: { listing: { id: string; reservePrice: number | null }; offers: Offer[]; canAnswer: boolean }) {
  const waiting = offers.filter((offer) => offer.type === "OFFER" && (offer.status === "OPEN" || offer.status === "REVIEWED") && awaitingSeller(offer));
  const others = offers.filter((offer) => offer.type === "OFFER" && (offer.status === "OPEN" || offer.status === "REVIEWED"));
  return (
    <section className="mt-10 border border-border p-5 rounded-xl" aria-labelledby="approval-heading">
      <p id="approval-heading" className="eyebrow">Sale approval</p>
      <p className="mt-2 text-sm text-muted-foreground">Nothing sells without your word on the price. Approve each sale the desk recommends, or set a reserve and the desk may accept any bid at or above it.</p>
      {waiting.map((offer) => {
        const rest = others.filter((other) => other.id !== offer.id);
        const best = rest.reduce((top, other) => Math.max(top, Number(other.amount ?? 0)), 0);
        return (
          <div key={offer.id} className="mt-4 border border-link/30 bg-link/5 p-4 rounded-xl">
            <p className="text-[13px] text-muted-foreground">The desk recommends · {prettyDate(offer.sellerAskedAt)}</p>
            <p className="mt-1 font-semibold tracking-tight text-2xl">{money(Number(offer.sellerAskedAmount))}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {offer.buyer.companyName || offer.buyer.name} · {offer.noteId ? "one loan" : "the whole listing"}
              {rest.length ? ` · ${rest.length} other open bid${rest.length === 1 ? "" : "s"}${best ? `, highest ${money(best)}` : ""}` : " · no other open bids"}
            </p>
            {canAnswer && (
              <form action={answerSaleApproval} className="mt-3 flex flex-wrap gap-2">
                {/* Not name="id": it shadows form.id in the DOM, and React then drops the clicked button's value. */}
                <input type="hidden" name="inquiryId" value={offer.id} />
                <button type="submit" name="answer" value="APPROVE" className="h-9 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background">Approve the sale</button>
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
