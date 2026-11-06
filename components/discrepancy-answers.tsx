import { answerDifference } from "@/actions/discrepancies";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { Tag } from "@/components/loan-file-view";
import { answerable, discrepancyLabel, type DiscrepancyRow } from "@/lib/discrepancies";
import { prettyDate } from "@/lib/format";
import { displayValue, fieldLabel, fieldSpec, sourcePhrase } from "@/lib/loan-file";

const shown = (field: string, value: string) => {
  const spec = fieldSpec(field);
  return spec && value ? displayValue(spec, value) : "blank";
};

// The seller's side of the discrepancy gate, on their own listing page or the filing broker's deal page. The
// viewer owns the listing, so every value shows.
export function DiscrepancyAnswers({
  rows,
  loanLabels,
  canAnswer,
  listingStatus,
  client,
}: {
  rows: DiscrepancyRow[];
  // Which loan each difference is on, for a pool.
  loanLabels: Record<string, string>;
  canAnswer: boolean;
  listingStatus: string;
  // A broker answers for a client, and only with their agreement.
  client?: string;
}) {
  if (!rows.length) return null;
  const open = rows.filter((row) => row.status === "OPEN");
  const closed = rows.filter((row) => row.status !== "OPEN");
  const pool = Object.keys(loanLabels).length > 1;
  const live = listingStatus === "APPROVED";
  const takesAnswers = canAnswer && answerable(listingStatus);
  return (
    <section id="differences" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl" aria-labelledby="differences-heading">
      <h2 id="differences-heading" className="eyebrow">Differences to answer</h2>
      {/* Counsel: the panel intro, both confirmation dialogs and the explanation hint set what the seller is told
          their answer means for buyers. Review before launch. */}
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        The loan&apos;s documents or a servicer report differ from your tape. Each line names its source. Use that value, or explain why the tape stands. The listing goes live only once each one has an answer. Buyers see every answer, dated.
      </p>
      {open.length > 0 && (
        <p className="mt-3 text-sm font-medium text-foreground tabular-nums">{open.length === 1 ? "One difference waits on your answer." : `${open.length} differences wait on your answer.`}</p>
      )}
      {open.length > 0 && takesAnswers && client && (
        <p className="mt-1 text-sm text-muted-foreground">Answer only with {client}&apos;s agreement.</p>
      )}
      {open.length > 0 && !takesAnswers && (
        <p className="mt-1 text-sm text-muted-foreground">{canAnswer ? "This listing is in contract or closed, so its tape can't change here. Write to the desk." : "Only the seller on file can answer."}</p>
      )}
      <ul className="mt-3 space-y-3">
        {open.map((row) => {
          const label = fieldLabel(row.field);
          return (
            <li key={row.id} className="rounded-lg border border-warn/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{label}</p>
                <Tag tone="warn">Waiting on you</Tag>
                {pool && loanLabels[row.noteId] && <span className="text-xs text-muted-foreground">{loanLabels[row.noteId]}</span>}
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-muted-foreground">Your tape</dt><dd className="tabular-nums text-foreground">{shown(row.field, row.tapeValue)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{row.source || "Document"} shows</dt><dd className="tabular-nums text-foreground">{shown(row.field, row.documentValue)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Raised</dt><dd className="tabular-nums text-muted-foreground">{prettyDate(row.createdAt)}</dd></div>
              </dl>
              {takesAnswers && (
                <div className="mt-3 grid gap-4 md:grid-cols-[auto_minmax(0,1fr)] md:items-end">
                  <form action={answerDifference}>
                    <input type="hidden" name="discrepancyId" value={row.id} />
                    <input type="hidden" name="answer" value="FIX" />
                    <ConfirmSubmit
                      title="Use the document's value?"
                      consequence={`Your tape's ${label.toLowerCase()} changes to what ${sourcePhrase(row.source)} shows.${live ? " The listing is live, so buyers see the new value at once." : ""} The change is logged, dated, in the loan file buyers read.`}
                      details={<ConfirmRows rows={[["Your tape", shown(row.field, row.tapeValue)], ["Becomes", shown(row.field, row.documentValue)]]} />}
                      confirmLabel="Use the document's value"
                      pendingLabel="Saving…"
                      className="h-10 text-[13px] font-medium"
                    >
                      Use the document&apos;s value
                    </ConfirmSubmit>
                  </form>
                  <form action={answerDifference} className="space-y-2">
                    <input type="hidden" name="discrepancyId" value={row.id} />
                    <input type="hidden" name="answer" value="EXPLAIN" />
                    <label className="block">
                      <span className="text-[13px] text-muted-foreground">Or explain why your tape stands</span>
                      <textarea name="sellerNote" required minLength={10} maxLength={600} className="desk-input mt-2 min-h-16" placeholder="For example, the pay history predates the October payment." />
                    </label>
                    <p className="text-xs text-muted-foreground">Buyers who can open the loan read this beside the document&apos;s value. Leave out the borrower&apos;s name and street.</p>
                    <ConfirmSubmit
                      title="Send this explanation?"
                      consequence="Your tape stays as filed. The explanation goes on the loan file beside the document's value, and the desk reads it before the listing goes live."
                      typed={[["Explanation", "sellerNote", "text"]]}
                      confirmLabel="Send the explanation"
                      pendingLabel="Sending…"
                      variant="outline"
                      className="h-10 text-[13px] font-medium"
                    >
                      Explain
                    </ConfirmSubmit>
                  </form>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {closed.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] font-medium text-foreground">Answered</p>
          <ul className="mt-1 divide-y divide-border text-sm">
            {closed.map((row) => (
              <li key={row.id} className="py-2">
                <p className="text-foreground tabular-nums">
                  {fieldLabel(row.field)}{pool && loanLabels[row.noteId] ? ` · ${loanLabels[row.noteId]}` : ""} · tape {shown(row.field, row.tapeValue)} · {row.source || "document"} {shown(row.field, row.documentValue)}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {discrepancyLabel(row.status)} · {prettyDate(row.resolvedAt ?? row.createdAt)}{row.sellerNote ? ` · ${row.sellerNote}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
