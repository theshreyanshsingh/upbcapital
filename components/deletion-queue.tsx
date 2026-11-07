import { decideDeletionRequest } from "@/actions/account-deletion";
import { blockerSentence, deletionQueue } from "@/lib/account-deletion";
import { prettyDate } from "@/lib/format";

// The compliance page's deletion requests. Completing one anonymises the account; it is refused while something is
// still open, and the line says what.
export async function DeletionQueue() {
  const { open, decided } = await deletionQueue();
  return (
    <section id="deletion" className="glass mt-8 scroll-mt-6 p-6">
      <p className="eyebrow">Deletion requests</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Completing a request clears the person&apos;s name, email, phone, company and second factor, ends their sessions, and deletes their saved searches, favourites, buy boxes, keys and webhooks. Their proof of funds is removed when no closing names them. Closings, signed papers, NDAs and the audit log stay. The holder gets an email before anything is cleared.
      </p>
      {open.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No requests waiting.</p>}
      <ul className="mt-4 space-y-4">
        {open.map((request) => (
          <li key={request.id} className="border border-border p-4 rounded-xl">
            <p className="text-sm text-foreground">{request.user.name} · {request.user.email} · {request.user.role.replaceAll("_", " ").toLowerCase()}</p>
            <p className="mt-1 text-xs text-muted-foreground">Asked {prettyDate(request.requestedAt)}{request.reason ? ` · ${request.reason}` : ""}</p>
            {request.blockers.length > 0 && <p className="mt-2 text-xs text-bad">{blockerSentence(request.blockers)}</p>}
            <form action={decideDeletionRequest} className="mt-3 space-y-2">
              <input type="hidden" name="requestId" value={request.id} />
              <input name="note" className="desk-input" aria-label={`Note on the deletion request from ${request.user.name}`} placeholder="A note for the record. A refusal goes to the holder." />
              <div className="flex flex-wrap gap-2">
                <button type="submit" name="decision" value="COMPLETED" disabled={request.blockers.length > 0} className="h-9 rounded-lg border border-bad/40 px-3 text-[13px] font-medium text-bad hover:bg-bad/10 disabled:opacity-50">Delete and anonymise</button>
                <button type="submit" name="decision" value="REFUSED" className="h-9 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-hover">Refuse</button>
              </div>
            </form>
          </li>
        ))}
      </ul>
      {decided.length > 0 && (
        <>
          <p className="mt-6 text-[13px] text-muted-foreground">Decided</p>
          <ul className="mt-2 space-y-2 text-sm">
            {decided.map((request) => (
              <li key={request.id} className="text-muted-foreground">
                <span className="text-foreground">{request.user.name}</span> · {request.status === "COMPLETED" ? "deleted" : "refused"} {prettyDate(request.decidedAt)}{request.note ? ` · ${request.note}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
