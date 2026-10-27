"use client";

import { useState } from "react";
import Link from "next/link";
import { submitInquiry } from "@/actions/buyer";
import { SubmitButton } from "@/components/submit-button";
import { money } from "@/lib/format";

export function LoanBid({
  listingId,
  noteId,
  premiumBps,
  verified,
  closed,
}: {
  listingId: string;
  noteId: string;
  premiumBps: number;
  verified: boolean;
  closed: boolean;
}) {
  const [amount, setAmount] = useState("");
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
      <input
        name="amount"
        inputMode="decimal"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        placeholder="Bid this loan"
        className="h-9 border border-border bg-card px-2 text-sm text-foreground rounded-lg"
      />
      {premium > 0 && <span className="text-[10px] text-muted-foreground">All-in {money(offer + premium)}</span>}
      <SubmitButton className="h-8 text-xs font-medium" pendingLabel="Sending…">
        Bid loan
      </SubmitButton>
    </form>
  );
}
