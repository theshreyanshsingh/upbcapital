import Link from "next/link";
import { removeFlowTranche } from "@/actions/flow";
import { SubmitButton } from "@/components/submit-button";
import { timeLeft, TRANCHE_LABEL, type TrancheReport } from "@/lib/flow-programs";
import { money, pct, prettyDate } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { launchTime } from "@/lib/launch-rules";

// Each tranche of a programme for its seller and the desk: loans and UPB, the first look, bids in it against bids
// after the release, the award as a percent of UPB and how many committed buyers bid. Counts only, so no bidder is
// named and no bid but the award is priced.
export function FlowTranches({
  programId,
  rows,
  listingHref,
  removable = false,
  now = new Date(),
}: {
  programId: string;
  rows: TrancheReport[];
  listingHref: (listingId: string) => string;
  removable?: boolean;
  now?: Date;
}) {
  if (!rows.length) return <p className="mt-3 text-sm text-muted-foreground">No tranches yet.</p>;
  return (
    <div className="relative mt-3 overflow-x-auto rounded-xl border border-border">
      <table className="min-w-full text-left text-sm">
        <caption className="sr-only">Tranches</caption>
        <thead className="text-xs font-medium text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-normal">Tranche</th>
            <th scope="col" className="px-3 py-2 font-normal">Loans and UPB</th>
            <th scope="col" className="px-3 py-2 font-normal">First look</th>
            <th scope="col" className="px-3 py-2 font-normal">Bids, first look · after release</th>
            <th scope="col" className="px-3 py-2 font-normal">Award</th>
            <th scope="col" className="px-3 py-2 font-normal">Committed take-up</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-border align-top">
              <td className="px-3 py-3">
                <p className="font-medium text-foreground">#{row.sequence} · {TRANCHE_LABEL[row.status] ?? row.status}</p>
                {row.listing ? (
                  <Link href={listingHref(row.listing.id)} className="text-link">{row.listing.title}</Link>
                ) : (
                  <span className="text-muted-foreground">Listing removed</span>
                )}
                {row.listing && <p className="text-xs text-muted-foreground">{labelOf("status", row.listing.status)}</p>}
                {removable && row.status === "FIRST_LOOK" && !row.firstLookEndsAt && (
                  <form action={removeFlowTranche} className="mt-1">
                    <input type="hidden" name="programId" value={programId} />
                    <input type="hidden" name="trancheId" value={row.id} />
                    <SubmitButton variant="ghost" pendingLabel="Taking out…" className="h-8 px-0 text-[13px] font-medium text-link">Take out of the programme</SubmitButton>
                  </form>
                )}
              </td>
              <td className="px-3 py-3 tabular-nums">
                {row.loans} loan{row.loans === 1 ? "" : "s"} · {money(row.upb)}
                {row.flagged > 0 && <p className="text-xs text-bad">{row.flagged} outside the criteria</p>}
              </td>
              <td className="px-3 py-3 tabular-nums">
                {row.status === "FIRST_LOOK" && row.firstLookEndsAt ? (
                  <>
                    <p className="text-foreground">Until {launchTime(row.firstLookEndsAt)}</p>
                    <p className="text-xs text-muted-foreground">{timeLeft(row.firstLookEndsAt, now)}</p>
                  </>
                ) : row.status === "FIRST_LOOK" ? (
                  <span className="text-muted-foreground">Starts when the desk approves it</span>
                ) : row.releasedAt ? (
                  <span className="text-muted-foreground">Released {prettyDate(row.releasedAt)}</span>
                ) : row.firstLookEndsAt ? (
                  <span className="text-muted-foreground">Ended {prettyDate(row.firstLookEndsAt)}</span>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </td>
              <td className="px-3 py-3 tabular-nums">{row.firstLookBids} · {row.marketBids}</td>
              <td className="px-3 py-3 tabular-nums">{row.awardPct == null ? "—" : `${pct(row.awardPct)} of UPB`}</td>
              <td className="px-3 py-3 tabular-nums">{row.committed ? `${row.committedBidders} of ${row.committed} bid` : "No committed buyers"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
