import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { overdueTrailingDocs } from "@/lib/trailing-docs";
import { cn } from "@/lib/utils";

export const metadata = { title: "Trailing documents" };

// Every desk role reads it. Chasing and waiving happen on each closing's page, under the closings capability.
export default async function TrailingDocsPage() {
  await requireRole(["ADMIN"]);
  const now = new Date();
  const [{ late, waiting }, open] = await Promise.all([
    overdueTrailingDocs(now),
    prisma.closing.count({ where: { status: "COMPLETE", trailingDocs: { some: { status: { in: ["DUE", "SENT"] } } } } }),
  ]);
  const byClosing = new Map<string, typeof late>();
  for (const doc of late) byClosing.set(doc.closingId, [...(byClosing.get(doc.closingId) ?? []), doc]);
  return (
    <div>
      <PageIntro
        eyebrow="Trailing documents"
        title="What is late after closing."
        lede="Items still due past their date, across every closed file. The owner is reminded weekly while one is late, and the deal owner hears once at 14 days. Open the closing to chase or waive an item."
      />
      <dl className="grid grid-cols-3 gap-px bg-muted sm:max-w-xl">
        <Stat k="Late items" v={late.length} bad={late.length > 0} />
        <Stat k="Closings late" v={byClosing.size} bad={byClosing.size > 0} />
        <Stat k="Closings still open" v={open} />
      </dl>
      <section className="mt-8" aria-labelledby="late-heading">
        <h2 id="late-heading" className="eyebrow">Late</h2>
        {late.length === 0 ? (
          <p className="mt-3 border border-dashed border-border px-5 py-8 text-sm text-muted-foreground rounded-xl">Nothing is late. Items show here the day after they fall due.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {[...byClosing.entries()].map(([closingId, docs]) => (
              <li key={closingId} className="glass p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <Link href={`/closings/${closingId}#trailing`} className="font-semibold tracking-tight text-lg text-link">{docs[0].title}</Link>
                  <p className="text-[13px] text-muted-foreground">{docs[0].owner ? `Deal owner ${docs[0].owner}` : "No deal owner"}</p>
                </div>
                <ul className="mt-3 divide-y divide-border text-sm">
                  {docs.map((doc) => (
                    <li key={doc.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                      <span className="text-foreground">
                        {doc.kind}
                        {doc.loan ? <span className="text-muted-foreground"> · {doc.loan}</span> : null}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        From the {doc.from} · due {prettyDate(doc.dueAt)} · <span className="text-bad">{doc.daysLate} days late</span>
                        {doc.escalated ? " · escalated" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
      {waiting.length > 0 && (
        <section className="mt-10" aria-labelledby="waiting-heading">
          <h2 id="waiting-heading" className="eyebrow">Sent, not yet confirmed</h2>
          <p className="mt-2 text-sm text-muted-foreground">Recorded as sent more than two weeks ago, with no receipt from the other side.</p>
          <ul className="mt-3 divide-y divide-border text-sm">
            {waiting.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="text-foreground">
                  <Link href={`/closings/${doc.closingId}#trailing`} className="text-link">{doc.title}</Link> · {doc.kind}
                  {doc.loan ? <span className="text-muted-foreground"> · {doc.loan}</span> : null}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">Sent {prettyDate(doc.sentAt)} by the {doc.from}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ k, v, bad = false }: { k: string; v: number; bad?: boolean }) {
  return (
    <div className="bg-card/80 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className={cn("mt-1 text-xl font-semibold tabular-nums", bad ? "text-bad" : "text-foreground")}>{v}</dd>
    </div>
  );
}
