import Link from "next/link";
import { changeBuyerRequest, declineRequestAnswer, postBuyerRequest } from "@/actions/bids-wanted";
import { CriteriaList, RequestForm } from "@/components/bids-wanted";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { BUYER_ANSWER_LABELS, buyerRequests, criteriaLines, OPEN_LIMIT, REQUEST_STATUS_LABELS, requestBlock, type StatusAction } from "@/lib/bids-wanted";
import { bidEntities } from "@/lib/buyer-entities";
import { prettyDate, q } from "@/lib/format";

export const metadata = { title: "Requests" };

type Row = Awaited<ReturnType<typeof buyerRequests>>[number];

function statusLine(row: Row) {
  const posted = `Posted ${prettyDate(row.createdAt)}`;
  if (row.expired) return `${posted} · ran out ${prettyDate(row.expiresAt)}. Edit it to post it again.`;
  if (row.status === "OPEN") return `${posted} · runs until ${prettyDate(row.expiresAt)}`;
  if (row.status === "PAUSED") return `${posted} · paused, so sellers don't see it`;
  return posted;
}

function StatusButton({ id, action, label }: { id: string; action: StatusAction; label: string }) {
  return (
    <form action={changeBuyerRequest}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="move" value={action} />
      <SubmitButton variant="outline" pendingLabel="Saving…" className="h-10 px-3 text-[13px] font-medium">{label}</SubmitButton>
    </form>
  );
}

// The buyer's requests: what the firm asked for, where each stands, and the listings sellers sent in answer.
export default async function BuyerRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["BUYER"]);
  const params = await searchParams;
  const [requests, block, entities] = await Promise.all([buyerRequests(user.id), requestBlock(user), bidEntities(user.id)]);
  const open = requests.filter((row) => row.live).length;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0">
        <PageIntro
          eyebrow="Requests"
          title="Tell sellers what you buy."
          lede={`Post what you want to buy. Sellers and brokers see it on their board with your firm named only by type, such as Fund or Bank, and answer by sending you a listing. A private one comes to you alone. Your firm keeps up to ${OPEN_LIMIT} requests open at once.`}
        />
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
        <p className="mt-6 text-sm text-muted-foreground tabular-nums">{open} of {OPEN_LIMIT} open.</p>
        <ul className="mt-3 space-y-4">
          {requests.length === 0 && (
            <li className="rounded-xl border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground">No requests yet. The form starts one.</li>
          )}
          {requests.map((row) => {
            const editable = row.status === "OPEN" || row.status === "PAUSED";
            return (
              <li key={row.id} id={`request-${row.id}`} className="glass scroll-mt-6 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold break-words text-foreground">{row.title}</h2>
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">{statusLine(row)}</p>
                  </div>
                  <span className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-foreground">
                    {row.expired ? "Expired" : REQUEST_STATUS_LABELS[row.status] ?? row.status}
                  </span>
                </div>
                <CriteriaList lines={criteriaLines(row.criteria)} />
                {row.notes && <p className="mt-3 text-sm leading-relaxed whitespace-pre-line break-words text-foreground">{row.notes}</p>}
                <p className="mt-2 text-xs text-muted-foreground">Sellers see your firm as {row.buyerType}.</p>
                {row.deskReason && <p className="mt-2 text-sm break-words text-warn">The desk closed it: {row.deskReason}</p>}
                {editable && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link href={`/buyer/requests/${row.id}`} className="inline-flex h-10 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-hover">
                      Edit
                    </Link>
                    {row.status === "OPEN" && !row.expired && <StatusButton id={row.id} action="PAUSE" label="Pause" />}
                    {row.status === "PAUSED" && <StatusButton id={row.id} action="RESUME" label="Resume" />}
                    <StatusButton id={row.id} action="FILLED" label="Mark filled" />
                    <StatusButton id={row.id} action="CLOSE" label="Close" />
                  </div>
                )}
                <div className="mt-5 border-t border-border pt-4">
                  <h3 className="text-[13px] font-semibold text-foreground">Answers · {row.answers.length}</h3>
                  {row.answers.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">{row.live ? "None yet. Sellers and brokers see it on their board." : "None."}</p>
                  ) : (
                    <ul className="mt-1 divide-y divide-border">
                      {row.answers.map((answer) => (
                        <li key={answer.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            {answer.opens ? (
                              <Link href={`/marketplace/${answer.listingId}`} className="text-sm font-medium break-words text-link">{answer.title}</Link>
                            ) : (
                              <p className="text-sm font-medium break-words text-foreground">{answer.title}</p>
                            )}
                            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                              {answer.what} · seller: {answer.sellerType} · {answer.private ? "private, sent to you" : "on the open book"} · {prettyDate(answer.at)}
                              {answer.inReview ? " · in review at the desk, opens to you once approved" : ""}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-medium text-foreground">{BUYER_ANSWER_LABELS[answer.status] ?? answer.status}</span>
                            {(answer.status === "SENT" || answer.status === "VIEWED") && (
                              <form action={declineRequestAnswer}>
                                <input type="hidden" name="responseId" value={answer.id} />
                                <input type="hidden" name="requestId" value={row.id} />
                                <SubmitButton variant="ghost" pendingLabel="Saving…" className="h-10 px-3 text-[13px] font-medium text-muted-foreground">Pass</SubmitButton>
                              </form>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <section aria-labelledby="new-request-heading" className="glass h-fit min-w-0 p-5">
        <h2 id="new-request-heading" className="eyebrow">New request</h2>
        {block ? (
          <p className="mt-3 text-sm leading-relaxed text-foreground">{block}</p>
        ) : open >= OPEN_LIMIT ? (
          <p className="mt-3 text-sm leading-relaxed text-foreground">Your firm has {OPEN_LIMIT} requests open, the most at once. Pause, close or mark one filled to post another.</p>
        ) : (
          <div className="mt-4">
            <RequestForm action={postBuyerRequest} entities={entities} submitLabel="Post the request" />
          </div>
        )}
      </section>
    </div>
  );
}
