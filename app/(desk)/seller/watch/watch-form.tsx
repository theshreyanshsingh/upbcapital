import type { TrackedNote } from "@prisma/client";
import { SubmitButton } from "@/components/submit-button";
import { isoDate } from "@/lib/format";
import { LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, PROPERTY_TYPES, US_STATES } from "@/lib/labels";
import { MAX_LABEL } from "@/lib/note-watch";
import { LOAN_PROGRAMS } from "@/lib/tape-fields";

// The short form for a note on watch: the wizard's options for the few figures a reading needs. The server checks
// them with the wizard's own rules (lib/note-watch.ts readWatchForm).
export function WatchForm({ action, note, submitLabel, pendingLabel }: { action: (formData: FormData) => Promise<void>; note?: TrackedNote; submitLabel: string; pendingLabel: string }) {
  const amount = (value: number | null | undefined) => (value == null ? "" : String(value));
  return (
    <form action={action} className="glass space-y-6 p-4 sm:p-6">
      {note && <input type="hidden" name="noteId" value={note.id} />}
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Label, only you see it</span>
        <input name="label" required maxLength={MAX_LABEL} defaultValue={note?.label ?? ""} placeholder="Maple Street note" className="desk-input mt-2" />
      </label>
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="eyebrow mb-4">The loan</legend>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">State</span>
          <select name="state" required defaultValue={note?.state ?? ""} className="desk-input mt-2">
            <option value="">Choose</option>
            {US_STATES.map((state) => <option key={state}>{state}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Property type</span>
          <select name="propertyType" defaultValue={note?.propertyType ?? "SFR"} className="desk-input mt-2">
            {PROPERTY_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Lien</span>
          <select name="lienPosition" defaultValue={note?.lienPosition ?? "FIRST"} className="desk-input mt-2">
            {LIEN_POSITIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Payment status</span>
          <select name="paymentStatus" defaultValue={note?.paymentStatus ?? "PERFORMING"} className="desk-input mt-2">
            {PAYMENT_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Unpaid balance</span>
          <input name="upb" required inputMode="decimal" defaultValue={amount(note?.upb)} className="desk-input mt-2 tabular-nums" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Note rate %</span>
          <input name="interestRate" required inputMode="decimal" defaultValue={amount(note?.interestRate)} className="desk-input mt-2 tabular-nums" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Monthly P&amp;I</span>
          <input name="monthlyPi" required inputMode="decimal" defaultValue={amount(note?.monthlyPi)} className="desk-input mt-2 tabular-nums" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Property value</span>
          <input name="estimatedValue" required inputMode="decimal" defaultValue={amount(note?.estimatedValue)} className="desk-input mt-2 tabular-nums" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Origination date</span>
          <input name="originationDate" type="date" defaultValue={isoDate(note?.originationDate) ?? ""} className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Maturity date</span>
          <input name="maturityDate" type="date" defaultValue={isoDate(note?.maturityDate) ?? ""} className="desk-input mt-2" />
        </label>
      </fieldset>
      <details className="group" open={Boolean(note?.occupancy || note?.loanProgram || note?.seniorLienBalance != null)}>
        <summary className="cursor-pointer text-sm text-link">More detail, if you have it</summary>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Occupancy</span>
            <select name="occupancy" defaultValue={note?.occupancy ?? ""} className="desk-input mt-2">
              <option value="">Not sure</option>
              {OCCUPANCIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Loan program</span>
            <select name="loanProgram" defaultValue={note?.loanProgram ?? ""} className="desk-input mt-2">
              <option value="">Not sure</option>
              {LOAN_PROGRAMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Senior lien balance, for a second or third</span>
            <input name="seniorLienBalance" inputMode="decimal" defaultValue={amount(note?.seniorLienBalance)} className="desk-input mt-2 tabular-nums" />
          </label>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Each carries into the listing form if you list the note. Some buyers&apos; boxes take only certain loan programs, so the program can change the buyer count.</p>
      </details>
      <SubmitButton className="h-11 w-full px-6 text-[13px] font-medium sm:w-auto" pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
    </form>
  );
}
