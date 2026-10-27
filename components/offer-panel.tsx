"use client";

import { useState } from "react";
import Link from "next/link";
import { submitInquiry } from "@/actions/buyer";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { bpsToPercent } from "@/lib/money";
import { money } from "@/lib/format";

export function OfferPanel({
  listingId,
  premiumBps,
  canOffer,
  pro,
  verified,
  noteId,
  heading,
}: {
  listingId: string;
  premiumBps: number;
  canOffer: boolean;
  pro: boolean;
  verified: boolean;
  noteId?: string;
  heading?: string;
}) {
  const [amount, setAmount] = useState("");
  const offer = Number(amount.replace(/[$,]/g, ""));
  const premium = Number.isFinite(offer) ? (offer * premiumBps) / 10000 : 0;
  return (
    <div className="glass p-6">
      <p className="eyebrow">Make a bid</p>
      <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{heading || "Offer or ask for the file"}</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        A buyer premium of {bpsToPercent(premiumBps).toFixed(2)}% is added to an accepted price. It is not part of your bid.
      </p>
      {canOffer && verified ? (
        <form action={submitInquiry} className="mt-6 space-y-4">
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="type" value="OFFER" />
          {noteId ? <input type="hidden" name="noteId" value={noteId} /> : null}
          <Input
            name="amount"
            inputMode="decimal"
            placeholder="Offer price"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="h-12 bg-card"
          />
          {offer > 0 && (
            <div className="space-y-1 text-sm text-muted-foreground">
              <div className="flex justify-between"><span>Your bid</span><span className="text-foreground">{money(offer)}</span></div>
              <div className="flex justify-between"><span>Buyer premium</span><span className="text-foreground">{money(premium)}</span></div>
              <div className="flex justify-between border-t border-border pt-2 font-semibold tracking-tight text-xl text-foreground">
                <span>All-in</span><span>{money(offer + premium)}</span>
              </div>
            </div>
          )}
          <Textarea name="message" placeholder="Terms, proof of funds, questions" className="min-h-28 bg-card" />
          <SubmitButton className="h-11 w-full text-[13px] font-medium" pendingLabel="Sending…">
            Submit offer
          </SubmitButton>
        </form>
      ) : canOffer ? (
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          Offers open after the desk approves your buyer file.{" "}
          <Link href="/buyer/verification" className="text-link">
            Submit verification
          </Link>
          .
        </p>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">This listing is not taking new bids.</p>
      )}
      <div className="mt-4 grid gap-2">
        <form action={submitInquiry}>
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="type" value="INFO_REQUEST" />
          <input type="hidden" name="message" value="Please share anything further a buyer should know before a bid." />
          <SubmitButton variant="outline" className="h-11 w-full text-[13px] font-medium" pendingLabel="Sending…">
            Request more information
          </SubmitButton>
        </form>
        {pro ? (
          <form action={submitInquiry}>
            <input type="hidden" name="listingId" value={listingId} />
            <input type="hidden" name="type" value="DATA_ROOM" />
            <input type="hidden" name="message" value="Requesting the full data room." />
            <SubmitButton variant="ghost" className="h-11 w-full text-[13px] font-medium" pendingLabel="Sending…">
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

function ButtonLink() {
  return (
    <Link href="/buyer/subscription?reason=dataroom" className="inline-flex h-11 w-full items-center justify-center border border-border text-[13px] font-medium text-link rounded-lg">
      Data room is a Pro privilege
    </Link>
  );
}
