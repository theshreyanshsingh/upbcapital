import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { MIN_AWARDS, loadBacktest, type BacktestGroup, type BacktestStats } from "@/lib/backtest";
import { money, prettyDate } from "@/lib/format";
import { indicativeTarget } from "@/lib/indicative";
import { requireDesk } from "@/lib/staff";

export const metadata = { title: "Indicative back-test" };
export const dynamic = "force-dynamic";

// Points of UPB, signed: "+2.4 pts", "−1.0 pts".
function points(value: number | null, signed = true) {
  if (value == null) return "—";
  const sign = signed ? (value > 0.05 ? "+" : value < -0.05 ? "−" : "") : "";
  return `${sign}${Math.abs(value).toFixed(1)} pts`;
}

function share(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function Tile({ term, value, basis }: { term: string; value: string; basis: string }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-[13px] text-muted-foreground">{term}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{basis}</p>
    </div>
  );
}

function GroupTable({ title, groups }: { title: string; groups: BacktestGroup[] }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="eyebrow">{title}</h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[26rem] text-sm tabular-nums">
          <thead>
            <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">Group</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Awards</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Median error</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Mean abs. error</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Bias</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {groups.map((group) => (
              <tr key={group.key}>
                <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">{group.label}</th>
                <td className="px-3 py-2 text-right text-muted-foreground">{group.count}</td>
                <td className="px-3 py-2 text-right text-foreground">{points(group.medianError)}</td>
                <td className="px-3 py-2 text-right text-foreground">{points(group.meanAbsError, false)}</td>
                <td className="px-3 py-2 text-right text-foreground">{points(group.bias)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Summary({ stats }: { stats: BacktestStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile term="Median error" value={points(stats.medianError)} basis="Half the awards came in above this, half below." />
      <Tile term="Mean absolute error" value={points(stats.meanAbsError, false)} basis="How far off the middle of the range is, on average." />
      <Tile term="Bias" value={points(stats.bias)} basis="Positive means buyers paid more than the range said." />
      <Tile term="Inside the range" value={share(stats.inRange)} basis="Awards that fell between its low and high." />
    </div>
  );
}

export default async function BacktestPage() {
  await requireDesk("sales", "/admin/analytics");
  const test = await loadBacktest();
  const target = indicativeTarget(test.targetYield);
  return (
    <div className="max-w-5xl space-y-8">
      <PageIntro
        eyebrow="Back-test"
        title="The indicative price against awards."
        lede={`Each buyer award's price over UPB, against the middle of the indicative range for the same loans. The book doesn't keep the range a listing showed, so each one is recomputed as of its award date: the desk model at today's target, ${target.label}, on the loans as they are on file now, and the closed-trade comps from before the award. Standing buy-box bids and desk purchases are left out.`}
      />
      {!test.enough ? (
        <p className="rounded-xl border border-warn/40 bg-warn/5 px-4 py-3 text-sm text-foreground">
          Too few awards to judge yet. {test.rows.length === 1 ? "There is 1 scored award" : `There are ${test.rows.length} scored awards`}, and the statistics wait for {MIN_AWARDS}. The awards so far are listed below.
        </p>
      ) : (
        <>
          <Summary stats={test.overall} />
          <div className="grid gap-6 lg:grid-cols-2">
            <GroupTable title="By lien" groups={test.byLien} />
            <GroupTable title="By performance" groups={test.byPerformance} />
          </div>
        </>
      )}
      <section aria-labelledby="awards-heading">
        <h2 id="awards-heading" className="eyebrow">Awards</h2>
        {test.unpriced > 0 && <p className="mt-2 text-sm text-muted-foreground">{test.unpriced === 1 ? "1 award" : `${test.unpriced} awards`} couldn&apos;t be priced again, so {test.unpriced === 1 ? "it isn't" : "they aren't"} scored.</p>}
        {test.rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No awards to score yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[44rem] text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">Listing</th>
                  <th scope="col" className="px-3 py-2 font-medium">Awarded</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Of UPB</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Range, recomputed</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {test.rows.map((row) => (
                  <tr key={row.closingId}>
                    <td className="max-w-[16rem] truncate px-3 py-2"><Link href={`/admin/listings/${row.listingId}`} className="text-link">{row.title}</Link><span className="block text-xs text-muted-foreground">{row.loans === 1 ? "1 loan" : `${row.loans} loans`} · {money(row.upb)} UPB</span></td>
                    <td className="px-3 py-2 text-muted-foreground">{prettyDate(row.awardedAt)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{money(row.price)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{row.awardOfUpb.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{row.low === row.high ? `${row.low}%` : `${row.low}–${row.high}%`}</td>
                    <td className={`px-3 py-2 text-right ${row.inRange ? "text-foreground" : "text-warn"}`}>{points(row.error)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
