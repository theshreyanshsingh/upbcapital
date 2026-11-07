import { changeLaunch } from "@/actions/launch";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { MAX_LAUNCH_DAYS } from "@/lib/launch-rules";

function utcInput(value: Date) {
  return value.toISOString().slice(0, 16);
}

// For a coming-soon listing: move its launch, or put it live now. The action checks the same limits as approval.
export function LaunchControls({ listingId, launchAt }: { listingId: string; launchAt: Date }) {
  return (
    <section aria-labelledby="launch-heading" className="space-y-3 rounded-xl border border-border p-4">
      <p id="launch-heading" className="eyebrow">Launch</p>
      <form action={changeLaunch} className="space-y-2">
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="intent" value="move" />
        <label className="block text-sm text-muted-foreground">
          New launch time (UTC)
          <input name="launchAt" type="datetime-local" required defaultValue={utcInput(launchAt)} className="desk-input mt-2" aria-describedby="launch-move-hint" />
          <span id="launch-move-hint" className="mt-1 block text-xs">Within {MAX_LAUNCH_DAYS} days. The seller and buyers who saved it hear the new date.</span>
        </label>
        <SubmitButton variant="outline" pendingLabel="Saving…" className="h-10 w-full text-[13px] font-medium">Move the launch</SubmitButton>
      </form>
      <form action={changeLaunch}>
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="intent" value="now" />
        <ConfirmSubmit
          title="Put this listing live now?"
          consequence="The coming-soon wait ends. Buyers who saved it hear it is live, saved-search alerts go out, and the data room and bids open. The launch can't be put back."
          confirmLabel="Go live now"
          pendingLabel="Going live…"
          variant="outline"
          className="h-10 w-full text-[13px] font-medium"
        >
          Cancel the wait and go live now
        </ConfirmSubmit>
      </form>
    </section>
  );
}
