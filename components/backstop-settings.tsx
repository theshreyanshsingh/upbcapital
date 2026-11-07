import { saveStallDays } from "@/actions/backstop";
import { SubmitButton } from "@/components/submit-button";
import { DEFAULT_STALL_DAYS, stallDaysOf } from "@/lib/backstop";
import { BACKUP_GRACE_DAYS } from "@/lib/backup-bids";

// The stalled-deal backstop on the fee schedule page. Only an owner changes it.
export function BackstopSettings({ owns, stallDays }: { owns: boolean; stallDays: number | null }) {
  return (
    <form id="backstop" action={saveStallDays} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="backstop-heading">
      <div>
        <p id="backstop-heading" className="eyebrow">Stalled-deal backstop</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          An open closing past its target close warns both sides at the target, and again three days before the backstop. At the backstop, a deal with no money moved is canceled as nobody&apos;s fault and the note goes back on the book. A deal with money moved goes to the desk instead.
        </p>
        <p className="mt-2 text-sm text-foreground">Now: {stallDaysOf(stallDays)} days past the target close.</p>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Days past the target close</span>
        {/* With no save button for other roles, a lone text field would still submit on Enter, so it reads only. */}
        <input name="stallDays" inputMode="numeric" disabled={!owns} defaultValue={stallDays ?? ""} placeholder={`${DEFAULT_STALL_DAYS}, the default`} className="desk-input mt-2 tabular-nums" />
        <span className="mt-1 block text-xs text-muted-foreground">From 5 to 90. Backup bids stand {BACKUP_GRACE_DAYS} days past it, so a deal the backstop cancels can still go to a backup. Blank keeps the default.</span>
      </label>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save backstop</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the backstop.</p>}
    </form>
  );
}
