import Link from "next/link";
import { deskCloseBuyerRequest } from "@/actions/bids-wanted";
import { CriteriaList } from "@/components/bids-wanted";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { deskRequests, REASON_MAX, REQUEST_STATUS_LABELS, SELLER_ANSWER_LABELS } from "@/lib/bids-wanted";
import { prettyDate, q } from "@/lib/format";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Buyer requests" };

type Row = Awaited<ReturnType<typeof deskRequests>>["requests"][number];

// Every buyer request with its buyer named, and every answer. Sellers and brokers see the same requests on /wanted
// with the buyer as a type. Every desk role reads this page; the sales side closes a request, with a reason the buyer
// reads and the audit log keeps.
export default async function DeskRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["ADMIN"]);
  const closes = deskCan(user, "sales");
  const params = await searchParams;
  const { counts, requests } = await deskRequests();
  const tiles: [string, number][] = [
    ["Open", counts.open],
    ["Paused", counts.paused],
    ["Expired", counts.expired],
    ["Filled", counts.filled],
    ["Closed", counts.closed],
  ];
  const groups: { key: string; title: string; rows: Row[] }[] = [
    { key: "open", title: "Open", rows: requests.filter((row) => row.live) },
    { key: "paused", title: "Paused", rows: requests.filter((row) => row.status === "PAUSED") },
    { key: "expired", title: "Expired", rows: requests.filter((row) => row.expired) },
    { key: "done", title: "Filled and closed", rows: requests.filter((row) => row.status === "FILLED" || row.status === "CLOSED") },
  ];
  return (
    <div>
      <PageIntro
        eyebrow="Buyer requests"
        title="Bids wanted."
        lede={`Every request buyers posted, with the buyer named, and every listing sellers and brokers sent in answer. They see each buyer only as a type, on their board at /wanted.${closes ? " Closing a request takes a reason, which the buyer reads and the audit log keeps." : " The sales side of the desk closes requests."}`}
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map(([label, value]) => (
          <div key={label} className="glass p-4">
            <dt className="eyebrow">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-foreground tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm text-muted-foreground tabular-nums">
        Answers: {counts.answers.SENT} sent and not yet opened · {counts.answers.VIEWED} opened · {counts.answers.BID} bid on · {counts.answers.DECLINED} passed.
      </p>
      <div className="mt-8 space-y-8">
        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`requests-${group.key}`}>
            <h2 id={`requests-${group.key}`} className="text-[13px] font-semibold text-foreground">{group.title} · {group.rows.length}</h2>
            {group.rows.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-border px-5 py-6 text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
                {group.rows.map((row) => (
                  <li key={row.id} id={`request-${row.id}`} className="scroll-mt-6 px-5 py-4">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                      <div className="min-w-0">
                        <p className="font-medium break-words text-foreground">{row.title}</p>
                        <p className="mt-1 text-sm break-words text-foreground">
                          {row.buyer.company || row.buyer.name}
                          {row.buyer.company ? ` · ${row.buyer.name}` : ""} · <span className="break-all">{row.buyer.email}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Shows to sellers as {row.buyerType}
                          {row.buyer.entity ? ` · buying as ${row.buyer.entity}` : ""}
                        </p>
                      </div>
                      <p className="shrink-0 text-[13px] font-medium text-link">{row.expired ? "Expired" : REQUEST_STATUS_LABELS[row.status] ?? row.status}</p>
                    </div>
                    <CriteriaList lines={row.criteria} />
                    {row.notes && <p className="mt-3 text-sm leading-relaxed whitespace-pre-line break-words text-foreground">{row.notes}</p>}
                    <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                      Posted {prettyDate(row.createdAt)} · {row.expired ? "ran out" : "runs until"} {prettyDate(row.expiresAt)}
                    </p>
                    {row.deskClosed && (
                      <p className="mt-1 text-xs break-words text-muted-foreground">
                        The desk closed it {prettyDate(row.deskClosed.createdAt)}: {row.deskClosed.detail}
                      </p>
                    )}
                    {row.answers.length > 0 && (
                      <ul className="mt-3 space-y-2 border-t border-border pt-3">
                        {row.answers.map((answer) => (
                          <li key={answer.id} className="flex flex-col gap-0.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                            <span className="min-w-0 break-words">
                              <Link href={`/admin/listings/${answer.listingId}`} className="text-link">{answer.title}</Link>
                              <span className="text-muted-foreground"> · from {answer.seller}{answer.private ? " · private" : ""}</span>
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{SELLER_ANSWER_LABELS[answer.status] ?? answer.status} · {prettyDate(answer.at)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {closes && (row.status === "OPEN" || row.status === "PAUSED") && (
                      <form action={deskCloseBuyerRequest} className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <input type="hidden" name="requestId" value={row.id} />
                        <label className="min-w-0 sm:flex-1">
                          <span className="sr-only">Why the desk is closing it</span>
                          <input name="reason" required minLength={3} maxLength={REASON_MAX} placeholder="Why the desk is closing it. The buyer reads this." className="desk-input" />
                        </label>
                        <SubmitButton variant="outline" pendingLabel="Closing…" className="h-10 px-4 text-[13px] font-medium">Close the request</SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
