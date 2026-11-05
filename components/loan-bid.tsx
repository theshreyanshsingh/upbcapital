"use client";

import { useState } from "react";
import Link from "next/link";
import { submitInquiry } from "@/actions/buyer";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { money } from "@/lib/format";
import { bidTerms, goodUntilRow } from "@/lib/offers";

export function LoanBid({
  listingId,
  noteId,
  premiumBps,
  verified,
  closed,
  loanName,
  deposit,
  diligenceDays,
}: {
  listingId: string;
  noteId: string;
  premiumBps: number;
  verified: boolean;
  closed: boolean;
  // What screen readers hear for this box, and what the confirmation names: "the loan in Tampa, FL".
  loanName: string;
  deposit?: [number, number];
  diligenceDays?: number;
}) {
  const [amount, setAmount] = useState("");
  const [goodUntil, setGoodUntil] = useState("");
  const offer = Number(amount.replace(/[$,]/g, ""));
  const premium = Number.isFinite(offer) && offer > 0 ? (offer * premiumBps) / 10000 : 0;
  if (closed) return <span className="text-[13px] font-medium text-muted-foreground">Closed</span>;
  if (!verified) {
    return (
      <Link href="/buyer/verification" className="text-[13px] font-medium text-link">
        Verify to bid
      </Link>
    );
  }
  return (
    <form action={submitInquiry} className="flex min-w-40 flex-col gap-1">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="noteId" value={noteId} />
      <input type="hidden" name="type" value="OFFER" />
      <input type="hidden" name="message" value="Loan-level bid." />
      <label className="sr-only" htmlFor={`bid-${noteId}`}>Bid for {loanName}</label>
      <input
        id={`bid-${noteId}`}
        name="amount"
        inputMode="decimal"
        required
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        placeholder="Bid this loan"
        className="desk-input h-9 px-2"
      />
      {premium > 0 && <span className="text-xs text-muted-foreground">All-in {money(offer + premium)}</span>}
      <label className="text-xs text-muted-foreground" htmlFor={`until-${noteId}`}>Good until (optional)</label>
      <input
        id={`until-${noteId}`}
        name="goodUntil"
        type="date"
        value={goodUntil}
        onChange={(event) => setGoodUntil(event.target.value)}
        className="desk-input h-9 px-2"
      />
      <ConfirmSubmit
        title={`Bid ${money(offer)} for ${loanName}?`}
        consequence={`If the desk accepts it, you're committed to buy this loan at this price plus the buyer premium${deposit ? `, and a ${deposit[0]}% deposit is due within ${deposit[1]} day${deposit[1] === 1 ? "" : "s"}` : ""}.${bidTerms(diligenceDays)}`}
        details={<ConfirmRows rows={[["Your bid", money(offer)], ["Buyer premium", money(premium)], ["All-in", money(offer + premium)], goodUntilRow(goodUntil)]} />}
        confirmLabel="Place the bid"
        pendingLabel="Sending…"
        className="h-8 text-xs font-medium"
      >
        Bid loan
      </ConfirmSubmit>
    </form>
  );
}
