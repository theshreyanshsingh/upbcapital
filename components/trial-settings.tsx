import { saveTrialSettings } from "@/actions/trial";
import { SubmitButton } from "@/components/submit-button";
import { MAX_TRIAL_DAYS, TRIAL_REMINDER_DAYS, trialDaysOf } from "@/lib/trial";

// The Pro trial a new buyer may take once. Only an owner changes it.
export function TrialSettings({ owns, days, stripe }: { owns: boolean; days: number | null | undefined; stripe: boolean }) {
  return (
    <form id="trial" action={saveTrialSettings} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="trial-heading">
      <div>
        <p id="trial-heading" className="eyebrow">Pro trial</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {stripe
            ? "A free buyer who never had Pro can try it once. Stripe takes the card at checkout and bills when the trial ends."
            : "A free buyer who never had Pro can try it once, with no card. Access ends on the last day and nothing is charged."}{" "}
          Each buyer hears {TRIAL_REMINDER_DAYS} days before the end and when it ends.
        </p>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Trial days</span>
        {/* With no save button for other roles, a lone text field would still submit on Enter, so it reads only. */}
        <input name="proTrialDays" inputMode="numeric" disabled={!owns} defaultValue={trialDaysOf(days)} className="desk-input mt-2 tabular-nums" />
        <span className="mt-1 block text-xs text-muted-foreground">From 0 to {MAX_TRIAL_DAYS}. 0 means no trial.</span>
      </label>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save the trial</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the trial.</p>}
    </form>
  );
}
