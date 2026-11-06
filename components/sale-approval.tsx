import { answerSaleApproval, saveBuyNow, setReserve } from "@/actions/sale-approval";
import { withdrawListing } from "@/actions/seller-controls";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { sealedFromSeller } from "@/lib/auction";
import { askedPriceStands, awaitingSeller, rivalBids } from "@/lib/awards";
import { BUY_NOW_STATUSES, buyNowClearBlock, buyNowConsent, buyNowSellerNext, buyNowSellerSummary, buyNowSetBlock } from "@/lib/buy-now";
import { depositTerms } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { listingWithdrawBlock } from "@/lib/listing-status";
import { money, prettyDate } from "@/lib/format";
import { bpsToPercent } from "@/lib/money";
import { bidExpired, buyerPrice, type OfferMoney } from "@/lib/offers";
import { getSettings } from "@/lib/settings";

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
  buyNow?: boolean | null;
  createdAt?: Date;
  buyer: { name: string; companyName: string };
  messages: OfferMoney[];
};

type Listing = {
  id: string;
  status: string;
  reservePrice: number | null;
  bidMode: string;
  bidDeadline: Date | null;
  // Optional, so a page that doesn't load them still renders the rest. Every seller page passes the whole listing.
  kind?: string;
  buyNowPrice?: number | null;
  buyNowSetAt?: Date | null;
  notes?: { askingPrice: number; tradeStatus: string }[];
};

const live = (offer: Offer) => offer.type === "OFFER" && (offer.status === "OPEN" || offer.status === "REVIEWED");

// The seller's side of every sale: bids the desk recommends, the standing reserve that spares a question, and the
// buy-it-now price that sells to the first verified buyer who confirms it.
export async function SaleApproval({ listing, offers, canAnswer }: { listing: Listing; offers: Offer[]; canAnswer: boolean }) {
  const settings = await getSettings();
  const waiting = offers.filter((offer) => live(offer) && awaitingSeller(offer));
  // A counter stands as the seller's approval of that price until the bid is awarded or closed.
  const countered = offers.filter((offer) => live(offer) && !awaitingSeller(offer) && offer.sellerCounterAmount != null && offer.sellerCounteredAt);
  const sealed = sealedFromSeller(listing);
  return (
    <section className="mt-10 border border-border p-5 rounded-xl" aria-labelledby="approval-heading">
      <p id="approval-heading" className="eyebrow">Sale approval</p>
      <p className="mt-2 text-sm text-muted-foreground">Nothing sells without your word on the price. Approve each sale the desk recommends or counter it with your own price, or set a reserve and the desk may accept any bid at or above it. A buy-it-now price sells to the first verified buyer who takes it.</p>
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
      <BuyNow listing={listing} offers={offers} canAnswer={canAnswer} settings={settings} />
    </section>
  );
}

// Buy it now, set or changed with the seller's consent restated, and taken off while no buyer has confirmed it.
// Whole listing only, open offers only: a sealed or best-and-final round sets its price at the deadline.
function BuyNow({
  listing,
  offers,
  canAnswer,
  settings,
}: {
  listing: Listing;
  offers: Offer[];
  canAnswer: boolean;
  settings: { buyerPremiumBps: number; sellerCommissionBps: number; depositBps?: number | null; depositDays?: number | null; diligenceDays?: number | null };
}) {
  // A page that didn't load the field has nothing to show here.
  if (listing.buyNowPrice === undefined) return null;
  const price = listing.buyNowPrice;
  const pool = listing.kind === "POOL";
  const notes = listing.notes ?? [];
  const ask = notes.reduce((sum, note) => sum + Number(note.askingPrice), 0);
  const open = offers.filter((offer) => live(offer) && offer.buyNow);
  const tradedLoans = notes.filter((note) => note.tradeStatus !== "AVAILABLE").length;
  const editable = canAnswer && (BUY_NOW_STATUSES as readonly string[]).includes(listing.status);
  // A placeholder price, so only the listing's own state decides whether the form shows.
  const setBlock = buyNowSetBlock({ status: listing.status, bidMode: listing.bidMode, price: 1, tradedLoans, openBuyNowBids: open.length });
  const clearBlock = buyNowClearBlock({ status: listing.status, buyNowPrice: price, openBuyNowBids: open.length });
  if (price == null && !editable) return null;
  const terms = depositTerms(settings);
  const diligence = diligenceDays(settings.diligenceDays);
  const paused = price != null && listing.status === "APPROVED" && listing.bidMode !== "NONE";
  return (
    <div id="buy-now" className="mt-6 scroll-mt-6 border-t border-border pt-5">
      <p className="text-[13px] font-semibold text-foreground">Buy it now</p>
      {price != null ? (
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{money(price)}</span>, set {prettyDate(listing.buyNowSetAt)}.{" "}
          {listing.status === "PENDING" || listing.status === "SOLD" ? "The listing is in contract, so the price stays on the record." : buyNowSellerSummary({ pool, set: true })}
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">{buyNowSellerSummary({ pool, set: false })}</p>
      )}
      {price != null && listing.status !== "APPROVED" && listing.status !== "PENDING" && listing.status !== "SOLD" && (
        <p className="mt-2 text-sm text-muted-foreground">Buyers see it once the listing is live.</p>
      )}
      {paused && <p className="mt-2 text-sm text-foreground">Paused while the sealed or best-and-final round runs. Buyers see it again if the listing goes back to open offers.</p>}
      {open.map((offer) => (
        <p key={offer.id} className="mt-2 text-sm text-foreground">
          {offer.buyer.companyName || offer.buyer.name} confirmed it{offer.createdAt ? ` on ${prettyDate(offer.createdAt)}` : ""}. The desk is clearing the award, so the price stays until it decides.
        </p>
      ))}
      {editable && setBlock && open.length === 0 && !paused && <p className="mt-2 text-sm text-foreground">{setBlock}</p>}
      {editable && !setBlock && (
        <form action={saveBuyNow} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Buy-it-now price</span>
            <input
              name="buyNowPrice"
              inputMode="numeric"
              required
              defaultValue={price ?? (ask > 0 ? Math.round(ask) : "")}
              className="desk-input mt-2 w-48 tabular-nums"
            />
          </label>
          <ConfirmSubmit
            title={price != null ? "Change your buy-it-now price?" : "Commit to a buy-it-now price?"}
            consequence={`${buyNowConsent({ pool })} ${buyNowSellerNext({ deposit: terms.bps > 0 ? [terms.bps / 100, terms.days] : undefined, diligenceDays: diligence || undefined, live: listing.status === "APPROVED" })}`}
            typed={[["Buy-it-now price", "buyNowPrice", "money"]]}
            details={
              <ConfirmRows
                rows={[
                  ...(ask > 0 ? ([["Asking price", money(ask)]] as [string, string][]) : []),
                  ["Buyer premium, paid by the buyer", `${bpsToPercent(settings.buyerPremiumBps).toFixed(2)}%`],
                  ["Seller commission, off the price", `${bpsToPercent(settings.sellerCommissionBps).toFixed(2)}%`],
                  ["Buyer deposit", terms.bps > 0 ? `${terms.bps / 100}% within ${terms.days} day${terms.days === 1 ? "" : "s"}` : "None"],
                  ["Buyer's diligence window", diligence ? `${diligence} day${diligence === 1 ? "" : "s"}` : "None"],
                ]}
              />
            }
            confirmLabel="I agree. Set the price"
            pendingLabel="Saving…"
            variant="outline"
            className="h-11 px-3 text-[13px] font-medium"
          >
            {price != null ? "Change the price" : "Set buy it now"}
          </ConfirmSubmit>
        </form>
      )}
      {canAnswer && price != null && !clearBlock && (
        <form action={saveBuyNow} className="mt-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <input type="hidden" name="intent" value="clear" />
          <SubmitButton variant="ghost" pendingLabel="Removing…" className="h-9 px-3 text-[13px] font-medium">
            Take buy it now off
          </SubmitButton>
        </form>
      )}
    </div>
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
