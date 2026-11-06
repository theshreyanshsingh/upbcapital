import Link from "next/link";
import { inviteStandingBid } from "@/actions/standing-bids";
import { SubmitButton } from "@/components/submit-button";
import { money, pct, prettyDate } from "@/lib/format";
import type { SheetRow } from "@/lib/standing-bids";

// The desk's indicative bid sheet: what each buy box with a price rule would pay for this tape. None of it binds
// until a buyer confirms, and only a live listing can be sent to buyers.
export function StandingBidSheet({ listingId, status, rows }: { listingId: string; status: string; rows: SheetRow[] }) {
  return (
    <section id="standing-bids" className="mt-8 scroll-mt-6" aria-labelledby="standing-bids-heading">
      <p id="standing-bids-heading" className="eyebrow">Standing bids</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Buy boxes with a price rule priced this tape as it arrived. The figures are indicative, and nothing binds until a buyer confirms one.
        {status === "APPROVED" ? " Invite a buyer and they get the figure with a link to bid it or pass." : " Invites open once the listing is live."}
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No buy box with a price rule fits this listing.</p>
      ) : (
        <div className="mt-3 relative overflow-x-auto border border-border rounded-xl">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs font-medium text-muted-foreground">
              <tr>{["Buyer", "Rule", "Price", "Of UPB", "Of ask", "State"].map((heading) => <th key={heading} className="px-3 py-2 font-normal">{heading}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.matchId} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <p className="text-foreground">{row.buyerName}</p>
                    <p className="text-xs text-muted-foreground">{row.boxName}</p>
                  </td>
                  <td className={row.rateStale ? "px-3 py-2 text-warn" : "px-3 py-2 text-muted-foreground"}>{row.rule}</td>
                  <td className="px-3 py-2">
                    <p className="font-medium text-foreground tabular-nums">{row.price != null ? money(row.price) : "No price"}</p>
                    <p className="text-xs text-muted-foreground">{row.price != null ? `Priced ${prettyDate(row.pricedAt)}` : row.why}</p>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{pct(row.ofUpb)}</td>
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{pct(row.ofAsk)}</td>
                  <td className="px-3 py-2">
                    <RowState row={row} listingId={listingId} />
                    {row.flags.map((flag) => <p key={flag} className="text-xs text-muted-foreground">{flag}</p>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RowState({ row, listingId }: { row: SheetRow; listingId: string }) {
  if (row.inquiryId) {
    return (
      <p className="text-good">
        Bid {prettyDate(row.answeredAt)} · <Link href={`/admin/offers#offer-${row.inquiryId}`} className="text-link">Offer book</Link>
      </p>
    );
  }
  if (row.answeredAt) return <p className="text-muted-foreground">Passed {prettyDate(row.answeredAt)}</p>;
  if (row.invitedAt) return <p className="text-foreground">Invited {prettyDate(row.invitedAt)}</p>;
  if (row.canInvite) {
    return (
      <form action={inviteStandingBid}>
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="matchId" value={row.matchId} />
        <SubmitButton variant="outline" pendingLabel="Sending…" className="h-9 text-[13px] font-medium">Invite to confirm</SubmitButton>
      </form>
    );
  }
  return row.price != null ? <p className="text-xs text-muted-foreground">{row.block}</p> : null;
}
