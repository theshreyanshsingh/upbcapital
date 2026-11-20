import Link from "next/link";
import { answerBuyerRequest } from "@/actions/bids-wanted";
import { RequestBoardCard } from "@/components/bids-wanted";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { answerChoices, boardRequest } from "@/lib/bids-wanted";
import { q } from "@/lib/format";

export const metadata = { title: "Answer a request" };

const NEW_LISTING: Record<string, string> = {
  INDIVIDUAL_SELLER: "/seller/notes/new",
  INSTITUTIONAL_SELLER: "/seller/pools/new",
  BROKER: "/broker/deals/new",
};

// One request and the viewer's listings that can answer it. Sending a private listing invites the buyer's account to
// it (lib/private-listings.ts); a public one stays public and the buyer hears about it.
export default async function WantedRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "BROKER", "ADMIN"]);
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const request = await boardRequest(user, id);
  const choices = request ? await answerChoices(user, request.id) : [];
  const fresh = NEW_LISTING[user.role];
  return (
    <div className="max-w-3xl">
      <Link href="/wanted" className="inline-flex min-h-10 items-center text-[13px] font-medium text-link">Back to the board</Link>
      <PageIntro eyebrow="Answer a request" title="Send this buyer a listing." />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      {!request ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-5 py-6 text-sm text-muted-foreground">That request is no longer open.</p>
      ) : (
        <>
          <div className="mt-6">
            <RequestBoardCard request={request} />
          </div>
          <section className="mt-8" aria-labelledby="answer-heading">
            <h2 id="answer-heading" className="eyebrow">Your listings</h2>
            {choices.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">You have no live or in-review listing to send.</p>
            ) : (
              <form action={answerBuyerRequest} className="mt-3 space-y-4">
                <input type="hidden" name="requestId" value={request.id} />
                <fieldset>
                  <legend className="sr-only">Choose a listing to send</legend>
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {choices.map((choice) => {
                      const blocked = choice.sent || choice.paused;
                      return (
                        <li key={choice.id}>
                          <label className={`flex min-h-12 items-start gap-3 px-4 py-3 ${blocked ? "opacity-60" : "cursor-pointer hover:bg-hover"}`}>
                            <input type="radio" name="listingId" value={choice.id} disabled={blocked} required className="mt-1 size-4 shrink-0" />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium break-words text-foreground">{choice.title}</span>
                              <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                                {choice.what} · {choice.status === "APPROVED" ? "Live" : "In review"} · {choice.private ? "Private" : "Public"}
                                {choice.sent ? " · already sent to this buyer" : ""}
                                {choice.paused ? " · paused until you reconfirm it" : ""}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  A private listing is invited to this buyer&apos;s account: it shows on their book and on no other buyer&apos;s. A public listing stays public, and the buyer hears about it.
                  Sending changes neither; make a listing private on the listing itself. The buyer sees your listing as the book shows it, with you named by type until the data room opens to them. Each listing goes to a request once.
                </p>
                <SubmitButton pendingLabel="Sending…" className="h-11 w-full px-4 text-[13px] font-medium sm:w-auto">Send to this buyer</SubmitButton>
              </form>
            )}
            {fresh && (
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Nothing that fits? <Link href={fresh} className="text-link">Start a new listing</Link>. Once it is filed, come back to this request and send it. A filed listing can be made private before it goes live.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
