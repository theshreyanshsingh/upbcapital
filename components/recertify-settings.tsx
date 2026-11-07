import { saveRecertifySettings } from "@/actions/verification";
import { SubmitButton } from "@/components/submit-button";
import { DEFAULT_RECERTIFY_MONTHS, RECERT_NOTICE_DAYS, recertifyMonthsOf } from "@/lib/verification";

// How long an approved buyer file stays current before the buyer re-certifies it. Only an owner changes it.
export function RecertifySettings({ owns, months }: { owns: boolean; months: number | null | undefined }) {
  return (
    <form id="recertify" action={saveRecertifySettings} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="recertify-heading">
      <div>
        <p id="recertify-heading" className="eyebrow">Buyer re-certification</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          An approved buyer file is current for this many months. Each buyer hears {RECERT_NOTICE_DAYS} days before. Past the date, new bids stop until the buyer confirms or updates the file and the desk approves it again. Files keep the date they were approved with.
        </p>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Months a file stays current</span>
        {/* With no save button for other roles, a lone text field would still submit on Enter, so it reads only. */}
        <input name="recertifyMonths" inputMode="numeric" required disabled={!owns} defaultValue={recertifyMonthsOf(months)} className="desk-input mt-2 tabular-nums" />
        <span className="mt-1 block text-xs text-muted-foreground">From 1 to 36. Left unset, it is {DEFAULT_RECERTIFY_MONTHS}.</span>
      </label>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save re-certification</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes re-certification.</p>}
    </form>
  );
}
