import { saveBidCapSettings } from "@/actions/desk-tools";
import { SubmitButton } from "@/components/submit-button";
import { DEFAULT_NEW_BIDDER_CLOSES, MAX_NEW_BIDDER_CLOSES, newBidderClosesOf } from "@/lib/bid-caps";

// The new-bidder cap: a buyer's largest single bid until they have closed this many deals. Only an owner changes it.
// The desk lifts it, or sets a buyer's own cap, from the buyer's profile.
export function BidCapSettings({ owns, capCents, closes }: { owns: boolean; capCents: number | null | undefined; closes: number | null | undefined }) {
  return (
    <form id="bid-caps" action={saveBidCapSettings} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="bid-caps-heading">
      <div>
        <p id="bid-caps-heading" className="eyebrow">New-bidder cap</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Until a buyer has closed enough deals, no single bid of theirs can be larger than this. Verified funds still cap every buyer. Leave the cap blank for none.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Largest single bid</span>
          <input name="newBidderCap" inputMode="decimal" disabled={!owns} defaultValue={capCents ? String(capCents / 100) : ""} placeholder="No cap" className="desk-input mt-2 tabular-nums" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Closings that lift it</span>
          <input name="newBidderCloses" inputMode="numeric" disabled={!owns} defaultValue={newBidderClosesOf(closes)} className="desk-input mt-2 tabular-nums" />
          <span className="mt-1 block text-xs text-muted-foreground">From 1 to {MAX_NEW_BIDDER_CLOSES}. Left unset, it is {DEFAULT_NEW_BIDDER_CLOSES}. A closing counts as the winning buyer or a group funder.</span>
        </label>
      </div>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save the cap</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the new-bidder cap.</p>}
    </form>
  );
}
