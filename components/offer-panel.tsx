"use client";

import { useState } from "react";
import Link from "next/link";
import { submitInquiry } from "@/actions/buyer";
import { buyItNow } from "@/actions/buy-now";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { flatTerms, payerText, premiumOn, type FeeTerms } from "@/lib/fee-schedule";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { EntityField, EntityPicker, entityRows, useEntityChoice, type EntityOption } from "@/components/entity-picker";
import { LoanPriceFields, type LoanPriceSummary, type PricedLoan } from "@/components/loan-price-fields";
import { BUY_NOW_BUYER_SUMMARY, buyNowTerms } from "@/lib/buy-now";
import { ACKNOWLEDGE_FIRST } from "@/lib/eligibility";
import { money } from "@/lib/format";
import { bidTerms, goodUntilRow } from "@/lib/offers";
import { RENEW_FUNDS, bidTarget, credentialRows, headroomAfter, type BidStanding } from "@/lib/verification";

export function OfferPanel({
  listingId,
  premiumBps,
  fees,
  canOffer,
  pro,
  verified,
  noteId,
  heading,
  closedText = "This listing is not taking new bids.",
  deposit,
  diligenceDays,
  buyNow,
  notices = [],
  acknowledgeFirst = false,
  standing = null,
  loans = [],
  entities = [],
  suggested,
}: {
  listingId: string;
  premiumBps: number;
  // The listing's fee terms, so a graded premium follows the figure typed. Missing means premiumBps flat.
  fees?: FeeTerms;
  canOffer: boolean;
  pro: boolean;
  verified: boolean;
  noteId?: string;
  heading?: string;
  closedText?: string;
  // The deposit a winning bidder owes, so the confirmation can say so: [percent, days to wire].
  deposit?: [number, number];
  // Days after an award in which the buyer may walk away. The listing page passes it when the desk sets one.
  diligenceDays?: number;
  // The seller's buy-it-now price, when this buyer can take it now. `price: null` means one is set but veiled.
  buyNow?: { price: number | null; pool: boolean };
  // Eligibility notices for this listing, restated in every bid confirmation.
  notices?: string[];
  // The buyer acknowledges the ROAD Act notice on the page before bidding.
  acknowledgeFirst?: boolean;
  // The buyer's verified-funds credential and any strike pause, from bidStanding in lib/inquiry. The server checks
  // both on every bid; this shows them before the buyer types a figure.
  standing?: BidStanding | null;
  // A whole pool's loans, so the buyer can price each one. Empty for a single note or a one-loan bid.
  loans?: PricedLoan[];
  // The buying entities a bid can be for. With more than one, the buyer picks once for every bid on the page.
  entities?: EntityOption[];
  // A forward-flow buyer's price grid pre-fills the bid, with a line saying how (lib/flow-programs.ts). They still confirm.
  suggested?: { amount: number; line: string };
}) {
  const [amount, setAmount] = useState(suggested ? String(suggested.amount) : "");
  const [entity] = useEntityChoice(listingId, entities);
  const buyingAs = entityRows(entity, entities);
  const [priced, setPriced] = useState<LoanPriceSummary>({ priced: 0, sum: 0, allowPartial: false });
  const [goodUntil, setGoodUntil] = useState("");
  const offer = Number(amount.replace(/[$,]/g, ""));
  const terms = fees ?? flatTerms(premiumBps);
  const premium = premiumOn(terms, offer);
  const notice = notices.length ? ` ${notices.join(" ")}` : "";
  const credential = standing?.credential ?? null;
  // A pause or an expired proof stops bids, not information requests.
  const stopped = standing?.paused ?? (credential?.expired ? `${credential.line}. ${RENEW_FUNDS}` : null);
  const bidding = canOffer && verified && !acknowledgeFirst && !stopped;
  const key = bidTarget(listingId, noteId);
  const room = offer > 0 ? headroomAfter(credential, key, offer + premium) : null;
  const pricedPool = !noteId && loans.length > 1;
  const partial = pricedPool && priced.priced > 0 && priced.allowPartial;
  const loanRows: [string, string][] = pricedPool
    ? [
        ["Loan prices", priced.priced ? `${priced.priced} loans, ${money(priced.sum, 2)} in all` : "None"],
        ["Part of the pool", partial ? "The seller may take part at your loan prices" : "Whole pool only"],
      ]
    : [];
  return (
    <div className="glass p-5">
      <p className="eyebrow">Make a bid</p>
      <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{heading || "Offer or ask for the file"}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {/* Says who pays UPB's fees, which the seller chose before the listing went live. */}
        {payerText(terms)}{" "}
        <Link href="/fees" className="text-link">See the fee schedule</Link>.
      </p>
      {credential && !credential.expired && canOffer && verified && (
        <p className="mt-3 rounded-lg border border-border px-3 py-2 text-[13px] text-foreground tabular-nums">
          {credential.line} · {money(Math.max(0, credential.headroom))} headroom
        </p>
      )}
      {/* A cap below the verified funds holds every bid here, buy it now included (lib/bid-caps.ts). */}
      {bidding && standing?.cap && <p className="mt-2 text-[13px] text-foreground tabular-nums">{standing.cap.line}</p>}
      {/* Loan bids in the pool table carry the same choice, so it shows whenever the buyer can bid at all. */}
      {verified && !stopped && !acknowledgeFirst && <EntityPicker listingId={listingId} options={entities} />}
      {bidding && buyNow && <BuyNowForm listingId={listingId} terms={terms} buyNow={buyNow} deposit={deposit} diligenceDays={diligenceDays} notice={notice} standing={standing} entity={entity} buyingAs={buyingAs} />}
      {canOffer && verified && stopped ? (
        <p className="mt-4 text-sm leading-relaxed text-foreground">
          {stopped}{" "}
          <Link href="/buyer/verification" className="text-link">Open your buyer file</Link>.
        </p>
      ) : canOffer && verified && acknowledgeFirst ? (
        <p className="mt-4 text-sm leading-relaxed text-foreground">
          {ACKNOWLEDGE_FIRST}{" "}
          <a href="#eligibility" className="text-link">Read the notice</a>.
        </p>
      ) : bidding ? (
        <form action={submitInquiry} className="mt-4 space-y-3">
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="type" value="OFFER" />
          {noteId ? <input type="hidden" name="noteId" value={noteId} /> : null}
          <EntityField chosen={entity} />
          <label className="block text-[13px] text-muted-foreground">
            Your bid
            <Input
              name="amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-1 h-11 bg-card tabular-nums"
            />
            {suggested && <span className="mt-1 block text-xs leading-relaxed">{suggested.line}</span>}
          </label>
          {offer > 0 && (
            <div className="space-y-1 text-sm text-muted-foreground tabular-nums">
              <div className="flex justify-between"><span>Your bid</span><span className="text-foreground">{money(offer)}</span></div>
              <div className="flex justify-between"><span>Buyer premium</span><span className="text-foreground">{money(premium)}</span></div>
              <div className="flex justify-between border-t border-border pt-2 font-semibold tracking-tight text-xl text-foreground">
                <span>All-in</span><span>{money(offer + premium)}</span>
              </div>
              {room != null && (
                <div className={`flex justify-between ${room < 0 ? "text-bad" : ""}`}>
                  <span>Headroom after this bid</span><span className={room < 0 ? "" : "text-foreground"}>{money(room)}</span>
                </div>
              )}
              {room != null && room < 0 && <p className="text-xs text-bad">This all-in is over your verified funds, so the desk will refuse it. Bid less, or withdraw another bid.</p>}
            </div>
          )}
          {pricedPool && <LoanPriceFields loans={loans} total={offer > 0 ? offer : null} onSummary={setPriced} />}
          {/* Optional terms fold away, so the panel fits beside the page and the bid button stays in view. */}
          <details className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-[13px] font-medium text-foreground">Good-until date or a note (optional)</summary>
            <div className="mt-3 space-y-4 pb-1">
              <label className="block text-[13px] text-muted-foreground">
                Good until (optional)
                <Input name="goodUntil" type="date" value={goodUntil} onChange={(event) => setGoodUntil(event.target.value)} className="mt-1 h-11 bg-card" />
                <span className="mt-1 block text-xs">Leave it blank and the bid stands until you withdraw it or the desk decides it.</span>
              </label>
              <label className="block text-[13px] text-muted-foreground">
                Note to the desk (optional)
                <Textarea name="message" placeholder="Terms, proof of funds, questions" className="mt-1 min-h-20 bg-card" />
              </label>
            </div>
          </details>
          <ConfirmSubmit
            title={`Bid ${money(offer)}?`}
            consequence={`If the desk accepts it, you're committed to buy ${partial ? "the whole pool, or the part of it the desk awards at your loan prices," : "at this price"} plus the buyer premium${deposit ? `, and a ${deposit[0]}% deposit is due within ${deposit[1]} day${deposit[1] === 1 ? "" : "s"}` : ""}.${bidTerms(diligenceDays)}${notice}`}
            details={<ConfirmRows rows={[["Your bid", money(offer)], ["Buyer premium", money(premium)], ["All-in", money(offer + premium)], ...loanRows, ...buyingAs, ...credentialRows(credential?.line ?? null, room), goodUntilRow(goodUntil)]} />}
            confirmLabel="Place the bid"
            pendingLabel="Sending…"
            className="h-11 w-full text-[13px] font-medium"
          >
            {buyNow?.price != null ? "Submit a different offer" : "Submit offer"}
          </ConfirmSubmit>
        </form>
      ) : canOffer ? (
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Offers open after the desk approves your buyer file.{" "}
          <Link href="/buyer/verification" className="text-link">
            Submit verification
          </Link>
          .
        </p>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{closedText}</p>
      )}
      <div className="mt-3 grid gap-2">
        <form action={submitInquiry}>
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="type" value="INFO_REQUEST" />
          <input type="hidden" name="message" value="Please share anything further a buyer should know before a bid." />
          <SubmitButton variant="outline" className="h-10 w-full text-[13px] font-medium" pendingLabel="Sending…">
            Request more information
          </SubmitButton>
        </form>
        {pro ? (
          <form action={submitInquiry}>
            <input type="hidden" name="listingId" value={listingId} />
            <input type="hidden" name="type" value="DATA_ROOM" />
            <input type="hidden" name="message" value="Requesting the full data room." />
            <SubmitButton variant="ghost" className="h-10 w-full text-[13px] font-medium" pendingLabel="Sending…">
              Request the data room
            </SubmitButton>
          </form>
        ) : (
          <ButtonLink />
        )}
      </div>
    </div>
  );
}

// The seller's standing price, one confirmation away. The first verified buyer to confirm opens the closing.
function BuyNowForm({
  listingId,
  terms,
  buyNow,
  deposit,
  diligenceDays,
  notice,
  standing,
  entity,
  buyingAs,
}: {
  listingId: string;
  terms: FeeTerms;
  buyNow: { price: number | null; pool: boolean };
  deposit?: [number, number];
  diligenceDays?: number;
  notice: string;
  standing: BidStanding | null;
  entity: EntityOption | null;
  buyingAs: [string, string][];
}) {
  if (buyNow.price == null) {
    return <p className="mt-4 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">The seller set a buy-it-now price. It shows on Pro, like the ask.</p>;
  }
  const price = buyNow.price;
  const premium = premiumOn(terms, price);
  const room = headroomAfter(standing?.credential, bidTarget(listingId, null), price + premium);
  return (
    <form id="buy-now" action={buyItNow} className="mt-4 scroll-mt-6 space-y-3 rounded-lg border border-link/30 bg-link/5 p-3">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="price" value={price} />
      <EntityField chosen={entity} />
      <div className="space-y-1 text-sm text-muted-foreground tabular-nums">
        <div className="flex justify-between"><span>Buy-it-now price</span><span className="text-foreground">{money(price)}</span></div>
        <div className="flex justify-between"><span>Buyer premium</span><span className="text-foreground">{money(premium)}</span></div>
        <div className="flex justify-between border-t border-border pt-2 font-semibold tracking-tight text-foreground"><span>All-in</span><span>{money(price + premium)}</span></div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{BUY_NOW_BUYER_SUMMARY}</p>
      {standing?.cap && Math.round(price * 100) > standing.cap.cents + 1 && <p className="text-[13px] text-bad tabular-nums">This price is over your cap. {standing.cap.line}</p>}
      <ConfirmSubmit
        title={`Buy it now at ${money(price)}?`}
        consequence={`${buyNowTerms({ pool: buyNow.pool, deposit, diligenceDays })}${notice}`}
        details={
          <ConfirmRows
            rows={[
              ["Price", money(price)],
              ["Buyer premium", money(premium)],
              ["All-in", money(price + premium)],
              ...buyingAs,
              ...credentialRows(standing?.credential?.line ?? null, room),
              ["Deposit", deposit ? `${money((price * deposit[0]) / 100)} within ${deposit[1]} day${deposit[1] === 1 ? "" : "s"}` : "None"],
              ["Diligence window", diligenceDays ? `${diligenceDays} day${diligenceDays === 1 ? "" : "s"} after the award` : "None"],
            ]}
          />
        }
        confirmLabel="Buy it now"
        pendingLabel="Buying…"
        className="h-11 w-full text-[13px] font-medium"
      >
        Buy it now at {money(price)}
      </ConfirmSubmit>
    </form>
  );
}

function ButtonLink() {
  return (
    <Link href="/buyer/subscription?reason=dataroom" className="inline-flex h-10 w-full items-center justify-center border border-border text-[13px] font-medium text-link rounded-lg">
      Data room is a Pro privilege
    </Link>
  );
}
