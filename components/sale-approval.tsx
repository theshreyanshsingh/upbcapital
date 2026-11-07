import { answerSaleApproval, pickBid, saveBuyNow, setReserve } from "@/actions/sale-approval";
import { withdrawListing } from "@/actions/seller-controls";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { deadlinePassed, sealedFromSeller } from "@/lib/auction";
import { askedPartPrice, askedPriceStands, awaitingSeller, partAsked, rivalBids } from "@/lib/awards";
import { bidderNamer } from "@/lib/bidder-alias";
import { BUY_NOW_STATUSES, buyNowClearBlock, buyNowConsent, buyNowSellerNext, buyNowSellerSummary, buyNowSetBlock } from "@/lib/buy-now";
import { depositTerms } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { launchPending } from "@/lib/launch-rules";
import { listingWithdrawBlock } from "@/lib/listing-status";
import { money, prettyDate } from "@/lib/format";
import { bidExpired, buyerPrice, type OfferMoney } from "@/lib/offers";
import { feeTerms, feesFor, rateText } from "@/lib/fee-schedule";
import { getSettings } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { standingLoanPrices } from "@/lib/loan-prices";

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
  // A pool bid's price for each loan, which a question about part of the pool is priced from.
  loanPrices?: unknown;
  // The seller's own pick of this bid, and the price they agreed to with it.
  sellerRequestedAt?: Date | null;
  sellerApprovedAmount?: number | null;
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
  // The fees fixed when the listing went live, which the sale is charged at.
  feeBuyerPremiumBps?: number | null;
  feeSellerCommissionBps?: number | null;
  feeSchedule?: unknown;
  launchAt?: Date | null;
  // The sale event the listing trades in, which names each bid's round.
  saleEventId?: string | null;
};

const live = (offer: Offer) => offer.type === "OFFER" && (offer.status === "OPEN" || offer.status === "REVIEWED");

// The seller's side of every sale: bids the desk recommends, the standing reserve that spares a question, and the
// buy-it-now price that sells to the first verified buyer who confirms it. Bidders show by letter until an award;
// the desk, opening a seller's page, passes revealNames and sees who they are.
export async function SaleApproval({ listing, offers, canAnswer, revealNames = false }: { listing: Listing; offers: Offer[]; canAnswer: boolean; revealNames?: boolean }) {
  const [settings, nameOf] = await Promise.all([getSettings(), bidderNamer(listing.id, { role: revealNames ? "ADMIN" : "SELLER" })]);
  const who = (offer: Offer) => nameOf({ id: offer.buyerId, name: offer.buyer.name, companyName: offer.buyer.companyName });
  const waiting = offers.filter((offer) => live(offer) && awaitingSeller(offer));
  // A counter stands as the seller's approval of that price until the bid is awarded or closed.
  const countered = offers.filter((offer) => live(offer) && !awaitingSeller(offer) && offer.sellerCounterAmount != null && offer.sellerCounteredAt);
  const sealed = sealedFromSeller(listing);
  // A question about part of a pool names its loans, and the seller sees each one at the buyer's loan price.
  const parts = new Map(await Promise.all(waiting.map(async (offer) => [offer.id, await partAsked(offer)] as const)));
  const partIds = [...parts.values()].flatMap((ids) => ids ?? []);
  const [placed, poolSize] = partIds.length
    ? await Promise.all([
        prisma.note.findMany({ where: { id: { in: partIds } }, select: { id: true, streetAddress: true, city: true, state: true } }),
        prisma.note.count({ where: { listingId: listing.id } }),
      ])
    : [[], 0];
  const placeOf = new Map(placed.map((note) => [note.id, `${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}`]));
  return (
    <section className="mt-10 border border-border p-5 rounded-xl" aria-labelledby="approval-heading">
      <p id="approval-heading" className="eyebrow">Sale approval</p>
      <p className="mt-2 text-sm text-muted-foreground">Nothing sells without your word on the price. Approve each sale the desk recommends or counter it with your own price, or set a reserve and the desk may accept any bid at or above it. A buy-it-now price sells to the first verified buyer who takes it.</p>
      {waiting.map((offer) => {
        const rest = rivalBids(offer, offers);
        const part = parts.get(offer.id) ?? null;
        const partPrices = part ? standingLoanPrices(offer.loanPrices, buyerPrice(offer.amount, offer.messages, offer.buyerId)) : null;
        // The buyer can reprice after the desk asks, and then this answer can't sell at the old figure.
        const current = part ? askedPartPrice(offer, part) : buyerPrice(offer.amount, offer.messages, offer.buyerId);
        const moved = !askedPriceStands(offer.sellerAskedAmount, current);
        const scope = part ? `${part.length} of the ${poolSize} loans in the pool` : offer.noteId ? "one loan" : "the whole listing";
        const notLive = listing.status !== "APPROVED";
        const lapsed = bidExpired(offer.expiresAt);
        // What this sale leaves the seller, at the fees the listing went live with.
        const sale = feesFor(listing, settings, Number(offer.sellerAskedAmount));
        return (
          <div key={offer.id} className="mt-4 border border-link/30 bg-link/5 p-4 rounded-xl">
            <p className="text-[13px] text-muted-foreground">The desk recommends · {prettyDate(offer.sellerAskedAt)}</p>
            <p className="mt-1 font-semibold tracking-tight text-2xl">{money(Number(offer.sellerAskedAmount))}</p>
            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
              Commission {money(sale.commissionCents / 100)} · your estimated net {money(sale.netToSellerCents / 100)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {who(offer)} · {scope}
              {part ? " · the other loans stay on the book" : rest.count ? ` · ${rest.count} other open bid${rest.count === 1 ? "" : "s"} for it${rest.best && !sealed ? `, highest ${money(rest.best)}` : ""}` : " · no other open bids for it"}
            </p>
            {part && (
              <ul className="mt-2 space-y-0.5 text-sm text-muted-foreground tabular-nums">
                {part.map((noteId) => (
                  <li key={noteId} className="flex justify-between gap-3">
                    <span>{placeOf.get(noteId) ?? "A loan"}</span>
                    <span className="text-foreground">{partPrices?.[noteId] != null ? money(partPrices[noteId], 2) : "Not priced"}</span>
                  </li>
                ))}
              </ul>
            )}
            {moved && current != null && (
              <p className="mt-2 text-sm text-foreground">The buyer has since changed their bid{part ? " for these loans" : ""} to {money(current)}, so this figure can no longer be approved.</p>
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
                    consequence={`Approving binds you to sell ${part ? `these ${part.length} loans` : offer.noteId ? "this loan" : "the whole listing"} at this price.${part ? " The other loans stay on the book for other buyers." : ""} The desk opens the closing, and the commission comes off the price at closing.`}
                    details={<ConfirmRows rows={[["Buyer", who(offer)], ["Sale price", money(Number(offer.sellerAskedAmount))], ...(part ? ([["Loans", `${part.length} of ${poolSize}`]] as [string, string][]) : [])]} />}
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
            {/* A counter is a price for the whole bid, so a question about part of the pool is approved or declined. */}
            {canAnswer && !lapsed && !notLive && !part && (
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
              {who(offer)} · {offer.noteId ? "one loan" : "the whole listing"} ·{" "}
              {taken ? "the buyer accepted it. The desk awards it next." : "waiting on the buyer. If they accept, the desk can award it at this price."}
            </p>
          </div>
        );
      })}
      {/* The desk reads bids on its own sheet, behind the sealed-bids wall, so this list is the seller's view only. */}
      {!revealNames && <LiveBids listing={listing} offers={offers} canAnswer={canAnswer} sealed={sealed} who={who} settings={settings} />}
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
      <BuyNow listing={listing} offers={offers} canAnswer={canAnswer} settings={settings} who={who} />
    </section>
  );
}

// Every live bid, so the seller can pick the one to sell to rather than only answer the desk's recommendation.
// Each shows by its bidder letter, with its round, its good-until date and whether it meets the reserve. While a sealed
// round runs the amounts stay hidden from the seller, and so does anything that would hint at them.
async function LiveBids({
  listing,
  offers,
  canAnswer,
  sealed,
  who,
  settings,
}: {
  listing: Listing;
  offers: Offer[];
  canAnswer: boolean;
  sealed: boolean;
  who: (offer: Offer) => string;
  settings: Parameters<typeof feesFor>[1];
}) {
  const bids = offers.filter((offer) => live(offer) && !bidExpired(offer.expiresAt));
  if (!bids.length) return null;
  const [event, loans] = await Promise.all([
    listing.saleEventId ? prisma.saleEvent.findUnique({ where: { id: listing.saleEventId }, select: { indicationsAt: true } }) : null,
    prisma.note.findMany({ where: { id: { in: bids.map((bid) => bid.noteId).filter((id): id is string => Boolean(id)) } }, select: { id: true, city: true, state: true } }),
  ]);
  const placeOf = new Map(loans.map((note) => [note.id, `${note.city}, ${note.state}`]));
  const priceOf = (offer: Offer) => buyerPrice(offer.amount, offer.messages, offer.buyerId);
  const round = (offer: Offer) =>
    event && offer.createdAt
      ? offer.createdAt.getTime() < event.indicationsAt.getTime() ? "Indication" : "Best and final"
      : listing.bidMode === "SEALED" ? "Sealed bid" : listing.bidMode === "BEST_AND_FINAL" ? "Best and final" : "Open offer";
  const reserve = listing.reservePrice != null && listing.reservePrice > 0 ? Number(listing.reservePrice) : null;
  const sorted = sealed ? bids : [...bids].sort((a, b) => (priceOf(b) ?? 0) - (priceOf(a) ?? 0));
  const waitsForDeadline = listing.bidMode !== "NONE" && !deadlinePassed(listing.bidDeadline);
  return (
    <div className="mt-6 border-t border-border pt-5">
      <p className="text-[13px] font-semibold text-foreground">Every live bid</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {sealed
          ? "Bids are sealed until the deadline, so their amounts stay hidden from you. Once it passes you can pick any bid."
          : "You can ask the desk to award any bid here, not only the one it recommends. Asking records your agreement to that price, and the desk awards it once its checks pass."}
      </p>
      <ul className="mt-3 divide-y divide-border border border-border rounded-xl">
        {sorted.map((offer) => {
          const price = priceOf(offer);
          const scope = offer.noteId ? `Loan in ${placeOf.get(offer.noteId) ?? "the pool"}` : "Whole listing";
          const picked = Boolean(offer.sellerRequestedAt) && askedPriceStands(offer.sellerApprovedAmount, price);
          const asked = awaitingSeller(offer);
          const sale = price != null ? feesFor(listing, settings, price) : null;
          return (
            <li key={offer.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-foreground">
                  {who(offer)}
                  {sealed ? <span className="font-normal text-muted-foreground"> · amount sealed until the deadline</span> : price != null && <span className="tabular-nums"> · {money(price)}</span>}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {scope} · {round(offer)} · {offer.expiresAt ? `good until ${prettyDate(offer.expiresAt)}` : "no end date"}
                  {!sealed && price != null && ` · ${reserve == null ? "no reserve set" : price >= reserve ? "meets your reserve" : "under your reserve"}`}
                </p>
                {picked && <p className="mt-1 text-[13px] font-medium text-good">You asked the desk to award this bid{offer.sellerRequestedAt ? ` on ${prettyDate(offer.sellerRequestedAt)}` : ""}.</p>}
                {offer.sellerRequestedAt && !picked && <p className="mt-1 text-[13px] text-foreground">You picked this bid, but the buyer has changed it since. Pick it again to agree to the new price.</p>}
                {asked && <p className="mt-1 text-[13px] text-muted-foreground">The desk asked you about this bid above.</p>}
              </div>
              {canAnswer && !sealed && !asked && !picked && price != null && listing.status === "APPROVED" && (
                <form action={pickBid}>
                  <input type="hidden" name="inquiryId" value={offer.id} />
                  <input type="hidden" name="price" value={price} />
                  <ConfirmSubmit
                    title={`Ask the desk to award ${who(offer)} at ${money(price)}?`}
                    consequence={`This records your agreement to sell ${offer.noteId ? "this loan" : "the whole listing"} at this price. The desk awards it once its checks pass${waitsForDeadline ? ", after the bid deadline" : ""}, and the other bids on it then close. Until the award you can pick a different bid instead.`}
                    details={
                      <ConfirmRows
                        rows={[
                          ["Bidder", who(offer)],
                          ["Sale price", money(price)],
                          ["What sells", scope],
                          ...(sale ? ([["Commission", money(sale.commissionCents / 100)], ["Your estimated net", money(sale.netToSellerCents / 100)]] as [string, string][]) : []),
                        ]}
                      />
                    }
                    confirmLabel="Ask the desk to award it"
                    pendingLabel="Sending…"
                    variant="outline"
                    className="h-9 px-3 text-[13px] font-medium"
                  >
                    Pick this bid
                  </ConfirmSubmit>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Buy it now, set or changed with the seller's consent restated, and taken off while no buyer has confirmed it.
// Whole listing only, open offers only: a sealed or best-and-final round sets its price at the deadline.
function BuyNow({
  listing,
  offers,
  canAnswer,
  settings,
  who,
}: {
  listing: Listing;
  offers: Offer[];
  canAnswer: boolean;
  who: (offer: Offer) => string;
  settings: { buyerPremiumBps: number; sellerCommissionBps: number; feeSchedule?: unknown; depositBps?: number | null; depositDays?: number | null; diligenceDays?: number | null };
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
  const fees = feeTerms(listing, settings);
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
          {who(offer)} confirmed it{offer.createdAt ? ` on ${prettyDate(offer.createdAt)}` : ""}. The desk is clearing the award, so the price stays until it decides.
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
            consequence={`${buyNowConsent({ pool })} ${buyNowSellerNext({ deposit: terms.bps > 0 ? [terms.bps / 100, terms.days] : undefined, diligenceDays: diligence || undefined, live: listing.status === "APPROVED" && !launchPending(listing) })}`}
            typed={[["Buy-it-now price", "buyNowPrice", "money"]]}
            details={
              <ConfirmRows
                rows={[
                  ...(ask > 0 ? ([["Asking price", money(ask)]] as [string, string][]) : []),
                  ["Buyer premium, paid by the buyer", rateText(fees, "premium")],
                  ["Seller commission, off the price", rateText(fees, "commission")],
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
