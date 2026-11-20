import { answerListingQuestion, askListingQuestion, citeListingAnswer, declineListingQuestion } from "@/actions/questions";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { AiDraftNote } from "@/components/document-reader";
import { SubmitButton } from "@/components/submit-button";
import { prettyDate } from "@/lib/format";
import { docLabel } from "@/lib/labels";
import { citableDocuments, QUOTE_MAX, uncited, type SourceView } from "@/lib/qa-citations";
import { ANSWER_MAX, NOTE_MAX, QUESTION_MAX } from "@/lib/questions";

type Published = { id: string; noteId: string | null; question: string; answer: string; answeredAt: Date | null; source?: SourceView | null };
type Mine = Omit<Published, "source"> & { status: string; createdAt: Date };

// Where a published answer comes from in the data room. The name links to the file only for someone the room already
// opens it to (lib/qa-citations.ts sourcesFor); anyone else reads the kind of file and the page, and no quote.
export function AnswerSource({ source }: { source: SourceView }) {
  return (
    <div className="mt-3 min-w-0">
      <p className="break-words text-[13px] text-muted-foreground">
        Source:{" "}
        {source.href ? (
          <a href={source.href} className="font-medium text-link">{source.name}</a>
        ) : (
          <span className="font-medium text-foreground">{source.name}</span>
        )}
        {source.page ? `, page ${source.page}` : ""}
      </p>
      {!source.href && <p className="mt-0.5 text-xs text-muted-foreground">Opens with data-room access</p>}
      {source.quote && (
        <blockquote className="mt-2 whitespace-pre-line break-words rounded-lg bg-muted/50 px-3 py-2 text-[13px] leading-relaxed text-muted-foreground">
          &ldquo;{source.quote}&rdquo;
        </blockquote>
      )}
    </div>
  );
}
type Loan = { id: string; label: string };

// The bidder's side: answers the seller published to the room, the bidder's own questions, and the form to ask.
// Who asked a published question is never shown, to anyone outside the desk.
export function QuestionBoard({
  listingId,
  published,
  mine,
  canAsk,
  inRoom,
  loans,
  waiting,
}: {
  listingId: string;
  published: Published[];
  mine: Mine[] | null;
  canAsk: boolean;
  // Published answers read inside the room. Everyone else sees only that there are some.
  inRoom: boolean;
  loans: Loan[];
  waiting?: string | null;
}) {
  const loanName = new Map(loans.map((loan) => [loan.id, loan.label]));
  const own = (mine ?? []).filter((row) => row.status !== "ANSWERED");
  return (
    <section id="questions" aria-labelledby="questions-heading" className="mt-8 scroll-mt-6">
      <h2 id="questions-heading" className="eyebrow">Questions and answers</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Bidders in the data room ask here. A published answer goes to every bidder in the room, and never says who asked.
      </p>
      {!inRoom ? (
        <p className="mt-4 border border-border px-4 py-4 text-sm text-muted-foreground rounded-xl">
          {waiting ?? (published.length
            ? `${published.length} answered question${published.length === 1 ? "" : "s"}. They open with the data room.`
            : "No answered questions yet. Questions open with the data room.")}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
          {published.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">No answered questions yet.</li>}
          {published.map((row) => (
            <li key={row.id} className="px-4 py-4">
              <p className="text-[13px] font-medium text-muted-foreground">
                {row.noteId && loanName.get(row.noteId) ? `${loanName.get(row.noteId)} · ` : ""}Answered {prettyDate(row.answeredAt)}
              </p>
              <p className="mt-1 whitespace-pre-line text-sm font-medium text-foreground">{row.question}</p>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/85">{row.answer}</p>
              {row.source && <AnswerSource source={row.source} />}
            </li>
          ))}
        </ul>
      )}
      {own.length > 0 && (
        <div className="mt-6">
          <p className="text-[13px] font-semibold text-foreground">Your questions</p>
          <ul className="mt-2 space-y-2">
            {own.map((row) => (
              <li key={row.id} className="border border-border px-4 py-3 rounded-xl">
                <p className="text-[13px] font-medium text-muted-foreground">
                  {row.status === "OPEN" ? `Asked ${prettyDate(row.createdAt)} · waiting for the seller` : `Closed ${prettyDate(row.answeredAt)} without a published answer`}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-foreground">{row.question}</p>
                {row.status === "DECLINED" && row.answer && <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">The seller&apos;s note: {row.answer}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canAsk && (
        <form action={askListingQuestion} className="mt-6 space-y-3 border border-border p-4 rounded-xl">
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="from" value="marketplace" />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Ask the seller</span>
            <textarea name="question" required minLength={5} maxLength={QUESTION_MAX} className="desk-input mt-2 min-h-24" placeholder="One question. Leave out who you are; the answer goes to every bidder." />
          </label>
          {loans.length > 1 && (
            <label className="block">
              <span className="text-[13px] text-muted-foreground">About</span>
              <select name="noteId" defaultValue="" className="desk-input mt-2">
                <option value="">The whole pool</option>
                {loans.map((loan) => (
                  <option key={loan.id} value={loan.id}>{loan.label}</option>
                ))}
              </select>
            </label>
          )}
          <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Sending…">Send the question</SubmitButton>
        </form>
      )}
    </section>
  );
}

type Queued = {
  id: string;
  // Present on the queue's rows (lib/questions.ts questionQueue), so the answer form can offer the room's files.
  listingId?: string;
  noteId: string | null;
  question: string;
  answer: string;
  status: string;
  createdAt: Date;
  answeredAt: Date | null;
  asker: string;
  // The document reader's draft, for the room's owners and the desk. Never passed to a bidder's page.
  aiDraft?: string | null;
  aiSources?: string | null;
  // The published answer's source in the data room (lib/qa-citations.ts).
  answerSourceDocId?: string | null;
  answerSourcePage?: number | null;
  answerSourceQuote?: string | null;
};

type RoomFile = Awaited<ReturnType<typeof citableDocuments>>[number];

// The optional source fields, inside the answer form or the form that adds a source later. The ids let the reader's
// draft fill them (components/draft-insert.tsx).
function SourceFields({ id, documents }: { id: string; documents: RoomFile[] }) {
  return (
    <fieldset className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-[13px] text-muted-foreground">Source in the data room, optional</legend>
      <label className="block min-w-0">
        <span className="text-[13px] text-muted-foreground">File</span>
        <select id={`source-doc-${id}`} name="sourceDocId" defaultValue="" className="desk-input mt-2 min-w-0">
          <option value="">No source</option>
          {documents.map((document) => (
            <option key={document.id} value={document.id}>{document.originalName} · {docLabel(document.type)}</option>
          ))}
        </select>
      </label>
      <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Page</span>
          <input id={`source-page-${id}`} name="sourcePage" type="number" inputMode="numeric" min={1} step={1} className="desk-input mt-2" />
        </label>
        <label className="block min-w-0">
          <span className="text-[13px] text-muted-foreground">The words relied on</span>
          <textarea id={`source-quote-${id}`} name="sourceQuote" maxLength={QUOTE_MAX} className="desk-input mt-2 min-h-16 py-2" />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        A bidder who can open the file reads its name, the page and these words, with a link. Others read the kind of file and the page. UPB checks the words are in the file where it can read the file.
      </p>
    </fieldset>
  );
}

// The answering side's view of a published answer's source, which it can always open.
function storedSource(row: Queued, byId: Map<string, RoomFile>): SourceView | null {
  if (!row.answerSourceDocId) return null;
  const document = byId.get(row.answerSourceDocId);
  return {
    name: document?.originalName ?? "A removed file",
    page: row.answerSourcePage ?? null,
    quote: row.answerSourceQuote || null,
    href: document ? `/api/documents/${document.id}` : null,
  };
}

const excerpt = (text: string) => (text.length > 90 ? `${text.slice(0, 90)}…` : text);

// The seller's, broker's and desk's side: open questions to answer for the room or decline, then what was decided.
export async function QuestionQueue({
  rows,
  from,
  live,
  loans,
  readOnly = false,
}: {
  rows: Queued[];
  from: "seller" | "broker" | "admin" | "resale";
  live: boolean;
  loans: Loan[];
  // A desk role outside sales reads the questions without the answer and decline forms. The actions refuse it too.
  readOnly?: boolean;
}) {
  const loanName = new Map(loans.map((loan) => [loan.id, loan.label]));
  const open = rows.filter((row) => row.status === "OPEN");
  const closed = rows.filter((row) => row.status !== "OPEN");
  const listingId = rows.find((row) => row.listingId)?.listingId;
  const documents = listingId ? await citableDocuments(listingId) : [];
  const byId = new Map(documents.map((document) => [document.id, document]));
  // The desk's count of published answers that name no source, each with a link to add one.
  const missing = from === "admin" ? uncited(closed) : [];
  return (
    <section id="questions" aria-labelledby="queue-heading" className="mt-10 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="queue-heading" className="eyebrow">Bidder questions</p>
      <p className="mt-2 text-sm text-muted-foreground">
        An answer is published to every bidder in the data room, without the asker&apos;s name. Declining closes the question, and only the bidder who asked is told.
      </p>
      {rows.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No questions yet.</p>}
      {missing.length > 0 && (
        <div className="mt-4 rounded-lg border border-border p-3">
          <p className="text-sm text-foreground">
            {missing.length} published answer{missing.length === 1 ? " has" : "s have"} no source in the data room.
          </p>
          {readOnly ? null : documents.length === 0 ? (
            <p className="mt-1 text-[13px] text-muted-foreground">The data room has no files to cite yet.</p>
          ) : (
            <ul className="mt-1">
              {missing.map((row) => (
                <li key={row.id} className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px]">
                  <a href={`#source-${row.id}`} className="inline-flex min-h-10 items-center font-medium text-link">Add a source</a>
                  <span className="min-w-0 break-words text-muted-foreground">{excerpt(row.question)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {readOnly && open.length > 0 && <p className="mt-4 text-sm text-muted-foreground">Answers are for the sales side of the desk.</p>}
      {open.map((row) => (
        <div key={row.id} className="mt-4 border border-link/30 bg-link/5 p-4 rounded-xl">
          <p className="text-[13px] text-muted-foreground">
            {row.asker} · asked {prettyDate(row.createdAt)}{row.noteId && loanName.get(row.noteId) ? ` · ${loanName.get(row.noteId)}` : ""}
          </p>
          <p className="mt-1 whitespace-pre-line text-sm font-medium text-foreground">{row.question}</p>
          {live && !readOnly && <AiDraftNote question={row} from={from} documents={documents} />}
          {readOnly ? null : live ? (
            <form action={answerListingQuestion} className="mt-3 space-y-2">
              <input type="hidden" name="questionId" value={row.id} />
              <input type="hidden" name="from" value={from} />
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Answer for every bidder</span>
                <textarea id={`answer-${row.id}`} name="answer" required maxLength={ANSWER_MAX} className="desk-input mt-2 min-h-20" />
              </label>
              {documents.length > 0 && <SourceFields id={row.id} documents={documents} />}
              <ConfirmSubmit
                title="Publish this answer?"
                consequence="Every bidder in the data room can read the question and your answer, and they are told. The asker isn't named. A published answer can't be taken back from here."
                confirmLabel="Publish the answer"
                pendingLabel="Publishing…"
                className="h-9 px-3 text-[13px] font-medium"
              >
                Publish the answer
              </ConfirmSubmit>
            </form>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">The listing isn&apos;t live, so an answer has no bidders to go to.</p>
          )}
          {!readOnly && <form action={declineListingQuestion} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="questionId" value={row.id} />
            <input type="hidden" name="from" value={from} />
            <label className="block min-w-0 flex-1">
              <span className="text-[13px] text-muted-foreground">Or decline, with an optional note to the asker</span>
              <input name="note" maxLength={NOTE_MAX} className="desk-input mt-2" />
            </label>
            <SubmitButton variant="outline" pendingLabel="Declining…" className="h-11 px-3 text-[13px] font-medium">Decline</SubmitButton>
          </form>}
        </div>
      ))}
      {closed.length > 0 && (
        <ul className="mt-5 divide-y divide-border border-t border-border">
          {closed.map((row) => {
            const source = row.status === "ANSWERED" ? storedSource(row, byId) : null;
            return (
              <li key={row.id} className="py-3">
                <p className="text-[13px] text-muted-foreground">
                  {row.asker} · {row.status === "ANSWERED" ? "published" : "declined"} {prettyDate(row.answeredAt)}{row.noteId && loanName.get(row.noteId) ? ` · ${loanName.get(row.noteId)}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-foreground">{row.question}</p>
                {row.answer && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{row.status === "ANSWERED" ? row.answer : `Note to the asker: ${row.answer}`}</p>}
                {source && <AnswerSource source={source} />}
                {row.status === "ANSWERED" && !source && !readOnly && documents.length > 0 && (
                  <details id={`source-${row.id}`} className="mt-2 scroll-mt-6">
                    <summary className="inline-flex min-h-10 cursor-pointer items-center text-[13px] font-medium text-link">Add a source</summary>
                    <form action={citeListingAnswer} className="mt-2 space-y-2">
                      <input type="hidden" name="questionId" value={row.id} />
                      <input type="hidden" name="from" value={from} />
                      <SourceFields id={`cite-${row.id}`} documents={documents} />
                      <SubmitButton pendingLabel="Adding…" className="h-10 px-3 text-[13px] font-medium">Add the source</SubmitButton>
                    </form>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
