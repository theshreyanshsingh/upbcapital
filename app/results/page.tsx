import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/public-page";
import { recordHit } from "@/lib/hits";
import { loadResults, MIN_SALES, type Tally } from "@/lib/results";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Results",
  description: "How sales on UPB Capital have closed: deals closed, close rate, days from award to close, and anonymised results sellers agreed to publish.",
};

export default async function ResultsPage() {
  await recordHit("/results");
  const { record, results } = await loadResults();
  return (
    <PublicPage
      title="How sales here close."
      lede="Every closing that finished on the desk, closed or canceled. Sellers choose whether their own sale shows below, without the address, the parties or the exact balance."
    >
      {record.enough ? (
        <>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-muted sm:grid-cols-3">
            <Figure k="Deals closed" v={String(record.closed)} />
            <Figure k="Close rate" v={record.closeRate == null ? "—" : `${Math.round(record.closeRate * 100)}%`} hint={`${record.closed} closed · ${record.canceled} canceled`} />
            <Figure k="Median days, award to close" v={record.medianDays == null ? "—" : record.medianDays < 1 ? "Under a day" : String(Math.round(record.medianDays))} className="col-span-2 sm:col-span-1" />
          </dl>
          <div className="grid gap-6 sm:grid-cols-2">
            <Tallies heading="Closed sales by lien" rows={record.byLien} />
            <Tallies heading="Closed sales by performance" rows={record.byPerformance} />
          </div>
          <p className="text-sm text-muted-foreground">
            Close rate is closed sales over every closing that finished, closed or canceled. Days count from the award to the day the closing finished.
          </p>
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-5 py-6 text-muted-foreground">
          Too few closed sales to show yet. The figures appear once {MIN_SALES} sales have closed.
        </p>
      )}

      <section aria-labelledby="sales-heading">
        <h2 id="sales-heading" className="font-semibold tracking-tight text-3xl text-foreground">Sales sellers chose to show</h2>
        {results.length === 0 ? (
          <p className="mt-3 text-muted-foreground">None yet. A seller can choose to show their sale here once it closes.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {results.map((row, index) => (
              <li key={`${row.month}-${index}`} className="grid gap-1 bg-card px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-4">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium text-foreground">
                    {row.place} · {row.kind === "POOL" ? `Pool of ${row.loanCount}` : "Note"} · {row.lien}
                  </p>
                  <p className="text-sm text-muted-foreground">{row.performance} · UPB {row.upbBand} · closed {row.month}</p>
                </div>
                <p className="text-sm text-foreground tabular-nums sm:text-right">
                  {row.ofUpb == null ? "Price not shown" : <><span className="text-xl font-semibold tracking-tight">{row.ofUpb}%</span> of UPB</>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-sm text-muted-foreground">
        Past sales don&apos;t predict the price of another note. <Link href="/learn" className="text-link">How note pricing works</Link>
      </p>
    </PublicPage>
  );
}

function Figure({ k, v, hint, className = "" }: { k: string; v: string; hint?: string; className?: string }) {
  return (
    <div className={`bg-card px-4 py-4 ${className}`}>
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-1 text-3xl font-semibold tracking-tight text-foreground tabular-nums">{v}</dd>
      {hint && <dd className="mt-1 text-xs text-muted-foreground tabular-nums">{hint}</dd>}
    </div>
  );
}

function Tallies({ heading, rows }: { heading: string; rows: Tally[] }) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold text-foreground">{heading}</h2>
      <ul className="mt-2 space-y-1.5 text-sm">
        {rows.map((row) => (
          <li key={row.label} className="flex justify-between gap-4 border-b border-border pb-1.5">
            <span className="text-foreground">{row.label}</span>
            <span className="text-muted-foreground tabular-nums">{row.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
