import { walkAway } from "@/actions/closing";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Textarea } from "@/components/ui/textarea";
import { money, prettyDate } from "@/lib/format";
import { WALK_AWAY_HINTS, WALK_AWAY_LABELS, WALK_AWAY_REASONS } from "@/lib/retrade";

// The buyer's walk-away inside the diligence window: one finding from the list, and their own words, which Other
// needs. The seller and the desk read both (lib/retrade.ts).
export function WalkAwayForm({ closing }: { closing: { id: string; salePrice: number; diligenceEndsAt: Date; title: string } }) {
  return (
    <form action={walkAway} className="glass space-y-3 p-6">
      <input type="hidden" name="closingId" value={closing.id} />
      <p className="eyebrow">Walk away in diligence</p>
      {/* Counsel: confirm "returned per the purchase terms" matches the deposit and refund language in the purchase agreement. */}
      <p className="text-sm text-muted-foreground">
        Until {prettyDate(closing.diligenceEndsAt)} you can walk away for something you found in the file. The closing is canceled, the note goes back on the book, and the seller and the desk are told. Money already wired is returned per the purchase terms.
      </p>
      <p className="text-sm text-muted-foreground">
        Your record shows each walk-away and its finding. A walk-away is never a strike. If you bid on these loans again, here or on a later listing, the bid can&apos;t be lower than this price.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-[13px] text-muted-foreground">What you found</legend>
        {WALK_AWAY_REASONS.map((reason) => (
          <label key={reason} className="flex items-start gap-2 text-sm text-foreground">
            <input type="radio" name="reason" value={reason} required className="mt-1" />
            <span>
              {WALK_AWAY_LABELS[reason]}
              <span className="block text-xs text-muted-foreground">{WALK_AWAY_HINTS[reason]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="block text-[13px] text-muted-foreground">
        In your own words. Needed for Other, and optional otherwise. The seller reads this.
        <Textarea name="words" className="mt-1 min-h-20 bg-card" maxLength={500} />
      </label>
      <ConfirmSubmit
        title={`Walk away from ${money(closing.salePrice)} on ${closing.title}?`}
        consequence="The closing is canceled for both sides and the note goes back on the book. It can't be reopened, and a new bid on these loans can't be lower than this price. Money already wired is returned per the purchase terms."
        typed={[["Your words the seller will read", "words", "text"]]}
        confirmLabel="Walk away"
        pendingLabel="Canceling…"
        tone="danger"
        className="h-9 text-[13px] font-medium"
      >
        Walk away
      </ConfirmSubmit>
    </form>
  );
}
