import { inputValue } from "@/lib/sale-events";

type Dates = { ndaDueAt?: Date | null; qaCutoffAt?: Date | null; awardTargetAt?: Date | null; closingTargetAt?: Date | null; processNotes?: string };

// The rest of the sale calendar and the letter's notes, for the event forms. Every date is optional and read as UTC.
// The NDA date and the Q&A cutoff fall before indications; the award and closing targets after best and final.
export function EventCalendarFields({ values = {}, open = false }: { values?: Dates; open?: boolean }) {
  const date = (name: keyof Omit<Dates, "processNotes">, label: string) => (
    <label className="block">
      <span className="text-[13px] text-muted-foreground">{label} (UTC)</span>
      <input name={name} type="datetime-local" defaultValue={inputValue(values[name])} className="desk-input mt-2" />
    </label>
  );
  return (
    <details open={open} className="rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer text-[13px] font-medium text-foreground">Process calendar and letter notes</summary>
      <div className="mt-3 space-y-4 pb-1">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Optional. Each date has to fall after the one before it: NDA, Q&amp;A cutoff, indications, best and final, award, closing. Questions stop at the cutoff.
        </p>
        {date("ndaDueAt", "NDA signed by")}
        {date("qaCutoffAt", "Questions close")}
        {date("awardTargetAt", "Award target")}
        {date("closingTargetAt", "Closing target")}
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Notes for the process letter</span>
          <textarea name="processNotes" maxLength={4000} defaultValue={values.processNotes ?? ""} className="desk-input mt-2 min-h-24" placeholder="Anything bidders should know: site visits, a seller's conditions, how to reach the desk." />
        </label>
      </div>
    </details>
  );
}
