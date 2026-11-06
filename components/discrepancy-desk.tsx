import Link from "next/link";
import { raiseDifference, resolveDifference } from "@/actions/discrepancies";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { Tag } from "@/components/loan-file-view";
import { SubmitButton } from "@/components/submit-button";
import { answerable, discrepancyLabel, gateMessage, type DiscrepancyRow } from "@/lib/discrepancies";
import { prettyDate } from "@/lib/format";
import { displayValue, fieldLabel, fieldSpec, LOAN_FIELDS, sameReading, sourcePhrase, tapeValue, VERIFY_SOURCES } from "@/lib/loan-file";

type Loan = { id: string; label: string; record: object };

const shown = (field: string, value: string | null) => {
  const spec = fieldSpec(field);
  return spec && value ? displayValue(spec, value) : "blank";
};

// Desk-only: every tape difference on the listing, open ones first, with the desk's two answers. Render it only
// on pages an admin is viewing, since it shows every value.
export function DiscrepancyDesk({
  rows,
  loans,
  people,
  listingId,
  listingStatus,
}: {
  rows: DiscrepancyRow[];
  loans: Loan[];
  people: Record<string, string>;
  listingId: string;
  listingStatus: string;
}) {
  const byId = new Map(loans.map((loan) => [loan.id, loan]));
  const open = rows.filter((row) => row.status === "OPEN");
  const closed = rows.filter((row) => row.status !== "OPEN").slice(0, 100);
  const who = (id: string | null) => (id ? people[id] ?? "Desk" : "Desk");
  const gate = gateMessage(open.length);
  const canApply = answerable(listingStatus);
  return (
    <section id="differences" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl" aria-labelledby="differences-heading">
      <h2 id="differences-heading" className="eyebrow">Tape differences</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Raised when a document the desk read differs from the tape. The seller fixes or explains each one. The desk can apply the document&apos;s value or waive it instead, with a reason buyers read.
      </p>
      {gate ? <p className="mt-3 text-sm text-foreground">{gate}</p> : rows.length > 0 && <p className="mt-3 text-sm text-good">Every difference has an answer.</p>}
      {rows.length === 0 && <p className="mt-3 text-sm text-muted-foreground">None raised.</p>}
      {open.length > 0 && (
        <ul className="mt-3 space-y-3">
          {open.map((row) => {
            const loan = byId.get(row.noteId);
            const current = loan ? tapeValue(loan.record, row.field) : null;
            const spec = fieldSpec(row.field);
            const moved = spec ? !sameReading(spec, current, row.tapeValue) : false;
            return (
              <li key={row.id} className="rounded-lg border border-warn/40 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">{fieldLabel(row.field)}</p>
                  <Tag tone="warn">Open</Tag>
                  {loans.length > 1 && loan && <Link className="text-xs text-link" href={`/admin/listings/${listingId}?loan=${loan.id}#loan-file`}>{loan.label}</Link>}
                </div>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                  <div><dt className="text-xs text-muted-foreground">Tape said</dt><dd className="tabular-nums text-foreground">{shown(row.field, row.tapeValue)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{row.source || "Document"} shows</dt><dd className="tabular-nums text-foreground">{shown(row.field, row.documentValue)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Raised</dt><dd className="tabular-nums text-muted-foreground">{prettyDate(row.createdAt)} · {who(row.raisedById)}</dd></div>
                </dl>
                {moved && <p className="mt-1 text-xs text-muted-foreground tabular-nums">The tape now reads {shown(row.field, current)}.</p>}
                <form action={resolveDifference} className="mt-3 space-y-2">
                  <input type="hidden" name="discrepancyId" value={row.id} />
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Reason, which buyers who can open the loan read</span>
                    <textarea name="reason" required minLength={3} maxLength={400} className="desk-input mt-2 min-h-16" />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {canApply && (
                      <ConfirmSubmit
                        name="answer"
                        value="ACCEPT"
                        title="Apply the document's value to the tape?"
                        consequence={`The tape's ${fieldLabel(row.field).toLowerCase()} becomes what ${sourcePhrase(row.source)} shows, and the desk signs it as verified. Buyers see the change, dated, in the loan file.`}
                        details={<ConfirmRows rows={[["Tape now", shown(row.field, current)], ["Becomes", shown(row.field, row.documentValue)]]} />}
                        typed={[["Reason", "reason", "text"]]}
                        confirmLabel="Apply the value"
                        pendingLabel="Applying…"
                        className="h-9 text-[13px] font-medium"
                      >
                        Apply the document&apos;s value
                      </ConfirmSubmit>
                    )}
                    <ConfirmSubmit
                      name="answer"
                      value="WAIVE"
                      title="Waive this difference?"
                      consequence="The tape stays as the seller filed it. The difference stays in the buyer's change log with your reason, and it no longer holds up approval."
                      typed={[["Reason", "reason", "text"]]}
                      confirmLabel="Waive it"
                      pendingLabel="Waiving…"
                      variant="outline"
                      className="h-9 text-[13px] font-medium"
                    >
                      Waive
                    </ConfirmSubmit>
                  </div>
                </form>
              </li>
            );
          })}
        </ul>
      )}
      {closed.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] font-medium text-link">Answered ({closed.length})</summary>
          <ul className="mt-2 divide-y divide-border text-sm">
            {closed.map((row) => {
              const loan = byId.get(row.noteId);
              return (
                <li key={row.id} className="py-2">
                  <p className="text-foreground tabular-nums">
                    {fieldLabel(row.field)}{loans.length > 1 && loan ? ` · ${loan.label}` : ""} · tape {shown(row.field, row.tapeValue)} · {row.source || "document"} {shown(row.field, row.documentValue)}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {discrepancyLabel(row.status)} · {who(row.resolvedById)} · {prettyDate(row.resolvedAt ?? row.createdAt)}{row.sellerNote ? ` · ${row.sellerNote}` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}

// Raises a question for the seller without signing the field as verified, for a document the desk wants answered
// before it relies on it.
export function DiscrepancyRaise({ noteId }: { noteId: string }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[13px] font-medium text-link">Raise a difference by hand</summary>
      <form action={raiseDifference} className="mt-3 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-3">
        <input type="hidden" name="noteId" value={noteId} />
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Field</span>
          <select name="field" required defaultValue="" className="desk-input mt-2">
            <option value="" disabled>Choose</option>
            {LOAN_FIELDS.map((spec) => <option key={spec.field} value={spec.field}>{spec.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Document shows</span>
          <input name="document" required maxLength={200} className="desk-input mt-2" placeholder="As the document reads" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Document</span>
          <select name="source" defaultValue="Pay history" className="desk-input mt-2">
            {VERIFY_SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}
          </select>
        </label>
        <p className="text-xs text-muted-foreground sm:col-span-3">The seller is asked to fix or explain it. The field stays seller-stated until the desk verifies it.</p>
        <div className="sm:col-span-3"><SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Raising…">Raise it</SubmitButton></div>
      </form>
    </details>
  );
}
