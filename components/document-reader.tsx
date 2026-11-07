import { confirmReading, readFileAgain, rejectReading, saveReaderMode } from "@/actions/ai-reading";
import { DraftInsert } from "@/components/draft-insert";
import { Tag } from "@/components/loan-file-view";
import { SubmitButton } from "@/components/submit-button";
import { ACCURACY_FLOOR, latestEval, onBlock, percent } from "@/lib/ai-eval";
import {
  activeReader,
  draftSources,
  draftVisible,
  MODE_LABELS,
  readerPanel,
  readerSummary,
  readingMode,
  sourceLabel,
  summaryLine,
  type Comparison,
  type ReadingMode,
} from "@/lib/ai-reading";
import { prettyDate } from "@/lib/format";
import { docLabel } from "@/lib/labels";

const COMPARISON: Record<Comparison, { tone: "good" | "warn" | "plain"; label: string }> = {
  match: { tone: "good", label: "Matches the tape" },
  mismatch: { tone: "warn", label: "Differs from the tape" },
  blank: { tone: "warn", label: "The tape is blank" },
  none: { tone: "plain", label: "Nothing to compare" },
};

const MODE_NOTES: Record<ReadingMode, string> = {
  OFF: "The reader is off, so new files aren't read. Turn it on in settings.",
  SHADOW: "Shadow mode: only the desk sees this, and nothing changes until the desk confirms a finding.",
  ON: "A difference the reader finds also goes to the seller to fix or explain, and holds approval like any other.",
};

function readLine(document: { readStatus: string | null; readAt: Date | null; reason: string }) {
  if (!document.readStatus) return "Not read yet";
  const when = document.readAt ? ` · ${prettyDate(document.readAt)}` : "";
  if (document.readStatus === "READ") return `Read${when}`;
  if (document.readStatus === "SKIPPED") return `Skipped${when} · ${document.reason}`;
  return `Didn't read${when} · ${document.reason}`;
}

// Desk-only: what the reader found in the files that bear on one loan, each finding beside the tape with the words it
// read. Render it only on pages an admin is viewing, since it shows every value.
export async function DocumentReaderPanel({ listingId, noteId, canAct }: { listingId: string; noteId: string | null; canAct: boolean }) {
  const panel = await readerPanel(listingId, noteId);
  const open = panel.findings.filter((finding) => finding.status === "PROPOSED");
  const decided = panel.findings.filter((finding) => finding.status !== "PROPOSED").slice(0, 40);
  return (
    <section id="reader" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl" aria-labelledby="reader-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="reader-heading" className="eyebrow">Document reader</h2>
        <Tag tone={panel.mode === "ON" ? "source" : "plain"}>{MODE_LABELS[panel.mode]}</Tag>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        The reader pulls loan facts from the files and sets each one beside the tape, with the words it read. Nothing here counts as verified until the desk confirms it. {MODE_NOTES[panel.mode]}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{sourceLabel(panel.source)}</p>

      <h3 className="mt-4 text-[13px] font-semibold text-foreground">Files</h3>
      {panel.documents.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No loan files to read yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border border-y border-border">
          {panel.documents.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{document.originalName}</p>
                <p className="text-xs text-muted-foreground">{docLabel(document.type)}{document.noteId ? " · this loan's own file" : ""} · {readLine(document)}</p>
              </div>
              {canAct && panel.mode !== "OFF" && (
                <form action={readFileAgain}>
                  <input type="hidden" name="documentId" value={document.id} />
                  <input type="hidden" name="noteId" value={noteId ?? ""} />
                  <SubmitButton variant="outline" className="h-8 px-3 text-[13px] font-medium" pendingLabel="Reading…">
                    {document.readStatus ? "Read the file again" : "Read the file"}
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-5 text-[13px] font-semibold text-foreground">Findings to confirm</h3>
      {open.length === 0 && <p className="mt-2 text-sm text-muted-foreground">None waiting.</p>}
      <ul className="mt-2 space-y-3">
        {open.map((finding) => {
          const compared = COMPARISON[finding.comparison];
          return (
            <li key={finding.id} className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{finding.label}</p>
                <Tag tone={compared.tone}>{compared.label}</Tag>
                <Tag tone="plain">AI-read, not confirmed</Tag>
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">The file shows</dt><dd className="tabular-nums text-foreground">{finding.shown}</dd></div>
                <div><dt className="text-xs text-muted-foreground">The tape says</dt><dd className="tabular-nums text-foreground">{finding.tape}</dd></div>
              </dl>
              <blockquote className="mt-2 border-l-2 border-border pl-3 text-sm text-foreground/85">&ldquo;{finding.quote}&rdquo;</blockquote>
              <p className="mt-1 text-xs text-muted-foreground">
                {finding.fileName}{finding.page ? ` · page ${finding.page}` : ""} · {sourceLabel(finding.source)}
                {!finding.quoteChecked && " · The file had no readable text, so this quote wasn't checked against it."}
                {!finding.noteId && " · The reader couldn't tell which loan this file is for."}
              </p>
              {canAct ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {finding.noteId && (
                    <form action={confirmReading}>
                      <input type="hidden" name="findingId" value={finding.id} />
                      <input type="hidden" name="listingId" value={listingId} />
                      <input type="hidden" name="noteId" value={noteId ?? ""} />
                      <SubmitButton className="h-9 px-3 text-[13px] font-medium" pendingLabel="Confirming…">
                        {finding.comparison === "match" ? "Confirm and verify" : finding.comparison === "none" ? "Confirm" : "Confirm the difference"}
                      </SubmitButton>
                    </form>
                  )}
                  <form action={rejectReading}>
                    <input type="hidden" name="findingId" value={finding.id} />
                    <input type="hidden" name="listingId" value={listingId} />
                    <input type="hidden" name="noteId" value={noteId ?? ""} />
                    <SubmitButton variant="outline" className="h-9 px-3 text-[13px] font-medium" pendingLabel="Rejecting…">Reject</SubmitButton>
                  </form>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">Confirming is for the sales side of the desk.</p>
              )}
            </li>
          );
        })}
      </ul>

      {decided.length > 0 && (
        <>
          <h3 className="mt-5 text-[13px] font-semibold text-foreground">Decided</h3>
          <ul className="mt-2 divide-y divide-border border-t border-border">
            {decided.map((finding) => (
              <li key={finding.id} className="py-2 text-sm">
                <span className="text-foreground">{finding.label}: {finding.shown}</span>
                <span className="text-muted-foreground"> · {finding.status === "CONFIRMED" ? "Confirmed" : "Rejected"} {prettyDate(finding.decidedAt)} · {finding.fileName}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// The seller's and broker's line, in ON mode only. It says the desk checks; the findings themselves stay with the desk.
export async function ReaderSummary({ listingId }: { listingId: string }) {
  const summary = await readerSummary(listingId);
  if (summary.mode !== "ON" || summary.files === 0) return null;
  return <p className="mt-4 max-w-2xl text-sm text-muted-foreground">{summaryLine(summary.files, summary.confirming)}</p>;
}

// The settings page's section: how the reader runs, its last test, and the switch. ON waits on the test.
export async function ReaderSettings({ owns }: { owns: boolean }) {
  const mode = await readingMode();
  const source = activeReader().source;
  const run = await latestEval(source);
  const block = onBlock(run);
  const choices: { value: ReadingMode; label: string; hint: string }[] = [
    { value: "OFF", label: "Off", hint: "New files aren't read." },
    { value: "SHADOW", label: "Shadow", hint: "Files are read. Only the desk sees the findings, marked AI-read, not confirmed." },
    { value: "ON", label: "On", hint: "A difference also opens a question the seller answers before the listing goes live. Sellers see drafted answers too." },
  ];
  return (
    <form id="reader" action={saveReaderMode} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="reader-settings-heading">
      <div>
        <p id="reader-settings-heading" className="eyebrow">Document reader</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The reader pulls loan facts from uploaded files and sets them beside the tape. The desk confirms each one before a field counts as verified. It goes on only after it scores {percent(ACCURACY_FLOOR)} or better on the labelled test files.
        </p>
        <p className="mt-2 text-sm text-foreground">Now: {MODE_LABELS[mode]}. {sourceLabel(source)}.</p>
        <p className="mt-1 text-sm tabular-nums text-foreground">
          {run ? `Last test: ${percent(run.accuracy)}, ${run.correct} of ${run.fields} fields, on ${prettyDate(run.createdAt)}.` : "No test on file for this reader yet."}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Run npm run ai:eval on the server to test the reader again.</p>
      </div>
      <fieldset>
        <legend className="text-[13px] text-muted-foreground">How the reader runs</legend>
        <div className="mt-2 space-y-2">
          {choices.map((choice) => (
            <label key={choice.value} className="flex items-start gap-2 text-sm text-foreground">
              <input type="radio" name="aiReading" value={choice.value} defaultChecked={mode === choice.value} className="mt-1" />
              <span>
                {choice.label}
                <span className="block text-xs text-muted-foreground">{choice.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {block && <p className="text-sm text-warn">{block}</p>}
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save the reader</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the reader.</p>}
    </form>
  );
}

// Beside an open question's answer form: the reader's draft and the files it came from. In shadow mode only the desk
// sees it. Buyers never do; their pages read published answers only.
export async function AiDraftNote({ question, from }: { question: { id: string; status: string; aiDraft?: string | null; aiSources?: string | null }; from: string }) {
  if (question.status !== "OPEN" || !question.aiDraft) return null;
  if (!draftVisible(await readingMode(), from)) return null;
  const sources = draftSources(question.aiSources);
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
      <p className="text-[13px] font-medium text-foreground">Drafted by the document reader from these files. Check it before you publish.</p>
      <p className="mt-2 whitespace-pre-line text-sm text-foreground/85">{question.aiDraft}</p>
      {sources.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {sources.map((source, index) => (
            <li key={`${source.documentId}-${index}`}>
              {source.name}: &ldquo;{source.quote}&rdquo;
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2">
        <DraftInsert target={`answer-${question.id}`} text={question.aiDraft} />
      </div>
    </div>
  );
}
