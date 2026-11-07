import { answerListingQuestion, askListingQuestion, declineListingQuestion } from "@/actions/questions";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { AiDraftNote } from "@/components/document-reader";
import { SubmitButton } from "@/components/submit-button";
import { prettyDate } from "@/lib/format";
import { ANSWER_MAX, NOTE_MAX, QUESTION_MAX } from "@/lib/questions";

type Published = { id: string; noteId: string | null; question: string; answer: string; answeredAt: Date | null };
type Mine = Published & { status: string; createdAt: Date };
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
};

// The seller's, broker's and desk's side: open questions to answer for the room or decline, then what was decided.
export function QuestionQueue({
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
  return (
    <section id="questions" aria-labelledby="queue-heading" className="mt-10 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="queue-heading" className="eyebrow">Bidder questions</p>
      <p className="mt-2 text-sm text-muted-foreground">
        An answer is published to every bidder in the data room, without the asker&apos;s name. Declining closes the question, and only the bidder who asked is told.
      </p>
      {rows.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No questions yet.</p>}
      {readOnly && open.length > 0 && <p className="mt-4 text-sm text-muted-foreground">Answers are for the sales side of the desk.</p>}
      {open.map((row) => (
        <div key={row.id} className="mt-4 border border-link/30 bg-link/5 p-4 rounded-xl">
          <p className="text-[13px] text-muted-foreground">
            {row.asker} · asked {prettyDate(row.createdAt)}{row.noteId && loanName.get(row.noteId) ? ` · ${loanName.get(row.noteId)}` : ""}
          </p>
          <p className="mt-1 whitespace-pre-line text-sm font-medium text-foreground">{row.question}</p>
          {live && !readOnly && <AiDraftNote question={row} from={from} />}
          {readOnly ? null : live ? (
            <form action={answerListingQuestion} className="mt-3 space-y-2">
              <input type="hidden" name="questionId" value={row.id} />
              <input type="hidden" name="from" value={from} />
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Answer for every bidder</span>
                <textarea id={`answer-${row.id}`} name="answer" required maxLength={ANSWER_MAX} className="desk-input mt-2 min-h-20" />
              </label>
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
          {closed.map((row) => (
            <li key={row.id} className="py-3">
              <p className="text-[13px] text-muted-foreground">
                {row.asker} · {row.status === "ANSWERED" ? "published" : "declined"} {prettyDate(row.answeredAt)}{row.noteId && loanName.get(row.noteId) ? ` · ${loanName.get(row.noteId)}` : ""}
              </p>
              <p className="mt-1 whitespace-pre-line text-sm text-foreground">{row.question}</p>
              {row.answer && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{row.status === "ANSWERED" ? row.answer : `Note to the asker: ${row.answer}`}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
