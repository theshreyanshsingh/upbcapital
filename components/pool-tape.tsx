import Link from "next/link";
import { LoanBid } from "@/components/loan-bid";
import type { BidStanding } from "@/lib/verification";
import { money, pct } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import type { completeness } from "@/lib/loan-file";

export type TapeLoan = {
  id: string;
  open: boolean;
  streetAddress: string;
  city: string;
  state: string;
  lienPosition: string;
  paymentStatus: string;
  monthsDelinquent: number;
  interestRate: number;
  upb: number;
  askingPrice: number;
  estimatedValue: number;
  tradeStatus: string;
};

// A pool's loans, one row each, with the loan's file in brief and, for a buyer, a bid box per loan. Streets show
// only where the loan is open to this viewer, and figures only on Pro. On a phone each loan is a card instead of
// a row, so the tape reads top to bottom without a sideways scroll.
export function PoolTape({
  listingId,
  loans,
  pro,
  bidding,
  fileHref,
  fileSummary,
}: {
  listingId: string;
  loans: TapeLoan[];
  pro: boolean;
  // Set for a buyer: the bid terms each loan's box restates, and whether the listing takes bids.
  bidding: { deposit?: [number, number]; diligenceDays?: number; premiumBps: number; verified: boolean; listingOpen: boolean; noticesFor?: (noteId: string) => string[]; standing?: BidStanding | null } | null;
  fileHref: (noteId: string) => string;
  fileSummary: (noteId: string) => ReturnType<typeof completeness> | null;
}) {
  const headings = ["Collateral", "Lien", "Status", "Months late", "Rate", "UPB", "Ask", "Value", "Trade", "File"].concat(bidding ? ["Bid"] : []);
  const numeric = new Set(["Months late", "Rate", "UPB", "Ask", "Value"]);
  const bidFor = (note: TapeLoan) =>
    bidding && (
      <LoanBid
        listingId={listingId}
        noteId={note.id}
        loanName={note.open ? note.streetAddress : `the loan in ${note.city}, ${note.state}`}
        deposit={bidding.deposit}
        diligenceDays={bidding.diligenceDays}
        premiumBps={bidding.premiumBps}
        verified={bidding.verified}
        closed={!bidding.listingOpen || note.tradeStatus !== "AVAILABLE"}
        notices={bidding.noticesFor?.(note.id) ?? []}
        standing={bidding.standing ?? null}
      />
    );
  return (
    <section aria-labelledby="tape-heading" className="mt-8">
      <h2 id="tape-heading" className="eyebrow">Loan tape</h2>
      <ul className="mt-3 space-y-3 md:hidden">
        {loans.map((note) => (
          <li key={note.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] leading-5 font-medium text-foreground">{note.open ? note.streetAddress : "Withheld"}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{note.city}, {note.state}</p>
              </div>
              <span className="shrink-0 rounded-full bg-muted px-2 text-xs leading-5 font-medium text-muted-foreground">{note.tradeStatus.replaceAll("_", " ").toLowerCase()}</span>
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {labelOf("lien", note.lienPosition)} lien · {labelOf("payment", note.paymentStatus)} · <span className="tabular-nums">{note.monthsDelinquent}</span> months late
            </p>
            {pro ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3">
                {[
                  ["Rate", pct(note.interestRate, 2)],
                  ["UPB", money(note.upb)],
                  ["Ask", money(note.askingPrice)],
                  ["Value", money(note.estimatedValue)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-[15px] font-medium text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Rate, balance, ask and value are on Pro.</p>
            )}
            <div className="mt-3">
              <FileCell href={fileHref(note.id)} file={fileSummary(note.id)} />
            </div>
            {bidding && <div className="mt-4 border-t border-border pt-4">{bidFor(note)}</div>}
          </li>
        ))}
      </ul>
      <div className="mt-3 relative overflow-x-auto rounded-xl border border-border max-md:hidden">
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs font-medium text-muted-foreground">
            <tr>
              {headings.map((heading) => <th key={heading} scope="col" className={`whitespace-nowrap px-3 py-2 font-normal ${numeric.has(heading) ? "text-right" : ""}`}>{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {loans.map((note) => (
              <tr key={note.id} className="border-t border-border align-top">
                <td className="px-3 py-3 text-foreground">{note.open ? note.streetAddress : "Withheld"}<span className="block text-xs text-muted-foreground">{note.city}, {note.state}</span></td>
                <td className="px-3 py-3">{labelOf("lien", note.lienPosition)}</td>
                <td className="px-3 py-3">{labelOf("payment", note.paymentStatus)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{note.monthsDelinquent}</td>
                <td className="px-3 py-3 text-right tabular-nums">{pro ? pct(note.interestRate, 2) : "—"}</td>
                <td className="px-3 py-3 text-right tabular-nums">{pro ? money(note.upb) : "—"}</td>
                <td className="px-3 py-3 text-right tabular-nums">{pro ? money(note.askingPrice) : "—"}</td>
                <td className="px-3 py-3 text-right tabular-nums">{pro ? money(note.estimatedValue) : "—"}</td>
                <td className="px-3 py-3 text-[13px] font-medium text-muted-foreground">{note.tradeStatus.replaceAll("_", " ").toLowerCase()}</td>
                <td className="px-3 py-3"><FileCell href={fileHref(note.id)} file={fileSummary(note.id)} /></td>
                {bidding && <td className="px-3 py-3">{bidFor(note)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// A loan's file in a few words for the pool table, linking to the full file.
function FileCell({ href, file }: { href: string; file: ReturnType<typeof completeness> | null }) {
  if (!file) return null;
  const open = file.defects.length + file.chainBreaks;
  return (
    <Link href={href} className="text-[13px] font-medium text-link tabular-nums">
      {file.reviewed ? `${file.collateral.present} of ${file.collateral.required} on file` : "Not reviewed"}
      {open > 0 && <span className="block text-xs text-bad">{open} open defect{open === 1 ? "" : "s"}</span>}
    </Link>
  );
}
