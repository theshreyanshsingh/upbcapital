import { saveBidderCount } from "@/actions/bidder-count";
import { SubmitButton } from "@/components/submit-button";
import { BIDDER_COUNT_SWITCH, bidderCountLock, type BidderCount } from "@/lib/bidder-count";

// The live bidder count (lib/bidder-count.ts): the line on a listing's bid rail, and the seller's switch.

// On the bid rail, for an approved buyer, when the seller chose to show it. Counts only.
export function BidderCountLine({ count }: { count: BidderCount | null }) {
  if (!count) return null;
  return (
    <div className="rounded-xl border border-border px-4 py-3">
      <p className="text-sm font-medium text-foreground tabular-nums">{count.label}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Firms other than yours with a live bid here, shown because the seller chose to. Never an amount, a rank or when anyone bid.
      </p>
    </div>
  );
}

type SwitchListing = { id: string; status: string; bidMode?: string; bidDeadline?: Date | null; showBidderCount?: boolean | null };

// Under the seller's terms, and on the desk's listing page. The seller of record sets it, and the desk's sales side
// can set it with the seller's agreement. It locks once the deadline passes. readOnly is for a desk role outside sales.
export function BidderCountChoice({ listing, canAnswer = false, desk = false, readOnly = false }: { listing: SwitchListing; canAnswer?: boolean; desk?: boolean; readOnly?: boolean }) {
  const on = listing.showBidderCount === true;
  const locked = bidderCountLock({ status: listing.status, bidMode: listing.bidMode ?? "NONE", bidDeadline: listing.bidDeadline ?? null });
  const editable = (canAnswer || desk) && !readOnly && !locked;
  const state = on
    ? "Bidders see how many other firms are bidding while the round is open. Never an amount, a rank or when anyone bid."
    : "Bidders don't see how many others are bidding.";
  const body = (
    <>
      <p className="text-sm text-muted-foreground">{state}{locked ? ` ${locked}` : ""}</p>
      {editable && (
        <form action={saveBidderCount} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="flex min-h-10 min-w-0 items-center gap-2 text-sm text-foreground">
            <input type="checkbox" name="showBidderCount" defaultChecked={on} className="size-4 shrink-0" />
            {BIDDER_COUNT_SWITCH}
          </label>
          <SubmitButton variant="outline" pendingLabel="Saving…" className="h-10 px-3 text-[13px] font-medium">Save</SubmitButton>
        </form>
      )}
      {desk && editable && !on && <p className="mt-1 text-xs text-muted-foreground">Turn this on only with the seller&apos;s agreement.</p>}
      {desk && readOnly && !locked && <p className="mt-2 text-sm text-muted-foreground">The sales side of the desk changes this.</p>}
    </>
  );
  if (!desk) return <div id="bidder-count" className="mt-4 scroll-mt-6">{body}</div>;
  return (
    <section id="bidder-count" aria-labelledby="bidder-count-heading" className="mt-6 scroll-mt-6 border border-border p-4 rounded-xl">
      <p id="bidder-count-heading" className="eyebrow">Bidder count</p>
      <div className="mt-2">{body}</div>
    </section>
  );
}
