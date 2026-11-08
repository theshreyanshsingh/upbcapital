import Link from "next/link";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { ANSWER_LABELS, DESK_PARTY_TEXT, deskClaimQueue, statusLabel } from "@/lib/claims";
import { money, prettyDate, q } from "@/lib/format";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Repurchase claims" };

type Row = Awaited<ReturnType<typeof deskClaimQueue>>["review"][number];

export default async function ClaimsQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Every desk role reads the queue. Deciding is compliance work, on the closing page, by someone not on the deal.
  const user = await requireRole(["ADMIN"]);
  const decides = deskCan(user, "compliance");
  const params = await searchParams;
  const queue = await deskClaimQueue();
  const groups: { key: string; title: string; hint: string; rows: Row[] }[] = [
    { key: "review", title: "To decide", hint: "Disputed, sent to the desk by a party, or past the seller's answer date.", rows: queue.review },
    { key: "answered", title: "Answered", hint: "The seller accepted or cured. The parties settle, or either sends it here.", rows: queue.answered },
    { key: "waiting", title: "Waiting on the seller", hint: "The seller hears two days before the answer date. With no answer, the claim moves to decide.", rows: queue.waiting },
    { key: "party", title: "UPB is a party", hint: DESK_PARTY_TEXT, rows: queue.deskParty },
    { key: "settling", title: "Decided, settling", hint: "The decision says what the seller owes. Both sides confirm once they settle.", rows: queue.settling },
    { key: "closed", title: "Closed", hint: "Denied, cured, settled or withdrawn.", rows: queue.closed },
  ];
  return (
    <div>
      <PageIntro
        eyebrow="Repurchase claims"
        title="Claims after closing."
        lede={`A buyer's claim that a seller representation proved untrue, the seller's answer and the desk's decision. UPB moves no money on a claim.${decides ? "" : " Your desk role reads the queue; a compliance desk member decides."}`}
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <div className="mt-6 space-y-8">
        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`claims-${group.key}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={`claims-${group.key}`} className="text-[13px] font-semibold text-foreground">{group.title} · {group.rows.length}</h2>
              <p className="text-xs text-muted-foreground">{group.hint}</p>
            </div>
            {group.rows.length === 0 ? (
              <p className="mt-3 border border-dashed border-border px-5 py-6 text-sm text-muted-foreground rounded-xl">None.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border border border-border rounded-xl">
                {group.rows.map((row) => (
                  <li key={row.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <Link href={`/closings/${row.closingId}#claim-${row.id}`} className="font-medium text-link">{row.title}</Link>
                      <p className="mt-1 text-sm text-foreground">{row.rep} · {row.buyer} against {row.seller}</p>
                      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                        Filed {prettyDate(row.createdAt)} · {row.remedy.toLowerCase()}
                        {row.amountCents != null && row.remedyKey !== "CURE" ? ` · ${money(row.amountCents / 100, 2)}` : ""}
                        {row.status === "FILED" ? ` · answer due ${prettyDate(row.respondBy)}` : ""}
                        {row.answer ? ` · the seller ${ANSWER_LABELS[row.answer.kind].toLowerCase()}` : ""}
                        {row.files ? ` · ${row.files} file${row.files === 1 ? "" : "s"}` : ""}
                      </p>
                      {row.decidedAt && (
                        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                          Decided {prettyDate(row.decidedAt)}{row.decidedBy ? ` by ${row.decidedBy}` : ""}
                          {row.outcomeCents ? ` · the seller owes ${money(row.outcomeCents / 100, 2)}` : ""}
                        </p>
                      )}
                    </div>
                    <p className="shrink-0 text-[13px] font-medium text-link">{statusLabel(row.status, row.deskParty)}</p>
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
