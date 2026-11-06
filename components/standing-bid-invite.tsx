"use client";

import { useState } from "react";
import Link from "next/link";
import { confirmStandingBid, passStandingBid } from "@/actions/standing-bids";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { money } from "@/lib/format";
import { bidTerms, goodUntilRow } from "@/lib/offers";

// One invitation from the desk to confirm a standing price. Bidding it is binding, so the dialog restates the price,
// the premium, the all-in, the deposit and the good-until date first.
export function StandingBidInvite({
  matchId,
  listingId,
  title,
  boxName,
  rule,
  price,
  ofUpb,
  invitedAt,
  premiumBps,
  deposit,
  diligenceDays,
}: {
  matchId: string;
  listingId: string;
  title: string;
  boxName: string;
  rule: string;
  price: number;
  ofUpb: number | null;
  invitedAt: string;
  premiumBps: number;
  // The deposit a winning bidder owes: [percent, days to wire].
  deposit?: [number, number];
  diligenceDays?: number;
}) {
  const [goodUntil, setGoodUntil] = useState("");
  const premium = (price * premiumBps) / 10000;
  const rows: [string, string][] = [
    ["Your bid", money(price)],
    ["Buyer premium", money(premium)],
    ["All-in", money(price + premium)],
    ["Deposit at award", deposit ? `${money((price * deposit[0]) / 100)} within ${deposit[1]} day${deposit[1] === 1 ? "" : "s"}` : "None"],
    goodUntilRow(goodUntil),
  ];
  return (
    <li className="glass p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/marketplace/${listingId}`} className="font-semibold tracking-tight text-xl text-foreground hover:text-link">{title}</Link>
          <p className="mt-1 text-sm text-muted-foreground">{boxName} · {rule} · sent {invitedAt}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold tracking-tight text-2xl text-foreground tabular-nums">{money(price)}</p>
          {ofUpb != null && <p className="text-xs text-muted-foreground tabular-nums">{ofUpb.toFixed(1)}% of UPB</p>}
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">Your rule priced this tape and the desk sent you the figure. It is indicative until you bid it.</p>
      <div className="mt-3">
        <ConfirmRows rows={rows.slice(0, 3)} />
      </div>
      <form action={confirmStandingBid} className="mt-4 space-y-3">
        <input type="hidden" name="matchId" value={matchId} />
        <input type="hidden" name="price" value={price} />
        <label className="block text-[13px] text-muted-foreground">
          Good until (optional)
          <Input name="goodUntil" type="date" value={goodUntil} onChange={(event) => setGoodUntil(event.target.value)} className="mt-1 h-11 bg-card" />
          <span className="mt-1 block text-xs">Leave it blank and the bid stands until you withdraw it or the desk decides it.</span>
        </label>
        <ConfirmSubmit
          title={`Bid ${money(price)}?`}
          consequence={`If the desk accepts it, you're committed to buy at this price plus the buyer premium${deposit ? `, and a ${deposit[0]}% deposit is due within ${deposit[1]} day${deposit[1] === 1 ? "" : "s"}` : ""}.${bidTerms(diligenceDays)}`}
          details={<ConfirmRows rows={rows} />}
          confirmLabel="Place the bid"
          pendingLabel="Sending…"
          className="h-10 text-[13px] font-medium"
        >
          Bid this price
        </ConfirmSubmit>
      </form>
      <form action={passStandingBid} className="mt-2">
        <input type="hidden" name="matchId" value={matchId} />
        <SubmitButton variant="ghost" pendingLabel="Saving…" className="h-10 text-[13px] font-medium">Pass</SubmitButton>
      </form>
    </li>
  );
}
