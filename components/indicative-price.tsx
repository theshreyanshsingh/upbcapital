import Link from "next/link";
import { money, prettyDate } from "@/lib/format";
import type { IndicativeResult, IndicativeSource, PriceLadder, RateStamp } from "@/lib/indicative";

// The indicative price for one listing, and the seller's price-against-time-to-sell view. Presentational only, so
// both render in a server or a client tree.
//
// On the listing page, load on the server and pass the result in:
//   const indicative = pro ? await loadIndicative(listing.id) : null;
//   <IndicativePrice indicative={indicative} pro={pro} ask={asking} />
export type IndicativePriceProps = {
  // From loadIndicative() or loadIndicatives() in lib/indicative. Null shows the empty state.
  indicative: IndicativeResult | null;
  // Free members see the figures veiled, as everywhere else on the book. Pass the page's own `pro`.
  pro: boolean;
  // The listing's total ask, to place it against the range. Optional.
  ask?: number | null;
  // Where the veil sends a free member. Defaults to the membership page.
  upgradeHref?: string;
};

function pctText(value: number) {
  return `${Math.round(value)}%`;
}

function sourceFigure(source: IndicativeSource) {
  if (source.key === "model") return `${pctText(source.low)}–${pctText(source.high)}`;
  return pctText(source.ofUpb);
}

// "rate as of Oct 20, 2026", in the warn colour once it is over a week old.
export function RateNote({ rate, className = "" }: { rate: RateStamp | null; className?: string }) {
  if (!rate) return null;
  return <span className={`${rate.stale ? "text-warn" : "text-muted-foreground"} ${className}`}>{rate.stale ? `10-year ${rate.text}, over a week old` : `10-year ${rate.text}`}</span>;
}

export function IndicativePrice({ indicative, pro, ask, upgradeHref = "/buyer/subscription?reason=access" }: IndicativePriceProps) {
  if (!pro) {
    return (
      <section className="glass p-6" aria-labelledby="indicative-heading">
        <h2 id="indicative-heading" className="eyebrow">Indicative price</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          The desk&apos;s indicative range, from its model, closed-trade comps and standing bids, opens with Pro. <Link href={upgradeHref} className="text-link">See Pro</Link>
        </p>
      </section>
    );
  }
  if (!indicative) {
    return (
      <section className="glass p-6" aria-labelledby="indicative-heading">
        <h2 id="indicative-heading" className="eyebrow">Indicative price</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          The model can&apos;t price this paper from what is on file, there are fewer than three closed trades like it, and no standing bid fits it yet. So there is no indicative range.
        </p>
      </section>
    );
  }
  const askPct = ask && indicative.upb > 0 ? (ask / indicative.upb) * 100 : null;
  const range = indicative.low === indicative.high ? `${indicative.low}% of UPB` : `${indicative.low}–${indicative.high}% of UPB`;
  const dollars = indicative.low === indicative.high ? money(indicative.lowPrice) : `${money(indicative.lowPrice)}–${money(indicative.highPrice)}`;
  return (
    <section className="glass p-6" aria-labelledby="indicative-heading">
      <h2 id="indicative-heading" className="eyebrow">Indicative price · an estimate</h2>
      <p className="mt-3 font-semibold tracking-tight text-3xl tabular-nums text-foreground">{range}</p>
      <p className="mt-1 text-sm text-muted-foreground tabular-nums">
        {dollars} on {money(indicative.upb)} UPB
        {askPct != null ? ` · the ask is ${pctText(askPct)} of UPB` : ""}
      </p>
      <SourceBar indicative={indicative} askPct={askPct} />
      <dl className="mt-5 divide-y divide-border text-sm">
        {indicative.sources.map((source) => (
          <div key={source.key} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
            <dt className="text-foreground">
              {source.label}
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{source.basis}</span>
              {source.rate && <RateNote rate={source.rate} className="mt-1 block text-xs" />}
            </dt>
            <dd className="font-medium tabular-nums text-foreground sm:text-right">{sourceFigure(source)} of UPB</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground tabular-nums">
        The range runs from the lowest to the highest of these, as of {prettyDate(indicative.asOf)}. {indicative.disclaimer}
      </p>
    </section>
  );
}

// Each source's point on one scale, with the model's band and the ask. Decoration; the list above carries the figures.
function SourceBar({ indicative, askPct }: { indicative: IndicativeResult; askPct: number | null }) {
  const values = [indicative.low, indicative.high, ...(askPct != null ? [askPct] : [])];
  const lo = Math.max(0, Math.min(...values) - 5);
  const hi = Math.max(...values) + 5;
  const at = (value: number) => `${((value - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="relative mt-6 h-8" aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-link/25" style={{ left: at(indicative.low), width: `calc(${at(indicative.high)} - ${at(indicative.low)})` }} />
      {indicative.sources.map((source) => (
        <div key={source.key} className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground" style={{ left: at(source.ofUpb) }} />
      ))}
      {askPct != null && (
        <div className="absolute -top-1 h-10 w-0.5 bg-link" style={{ left: at(askPct) }}>
          <span className="absolute -top-4 left-1 whitespace-nowrap text-[11px] text-link">Ask</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

// The seller's ask against standing demand and closed-trade comps, at upload. Pass the ladder from checkNoteMarket
// or checkTapeMarket in actions/market-rates.
export type PriceAgainstTimeProps = {
  ladder: PriceLadder | null;
  // True while the check runs.
  loading?: boolean;
  // Why the check couldn't run, in the desk's words.
  error?: string | null;
};

export function PriceAgainstTime({ ladder, loading = false, error = null }: PriceAgainstTimeProps) {
  return (
    <section className="border border-border p-5 rounded-xl" aria-labelledby="price-time-heading" aria-busy={loading}>
      <h3 id="price-time-heading" className="eyebrow">Price against time to sell</h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Standing bids can confirm as soon as the listing is live. A price at or under more of them can sell sooner; a price above them waits for buyers on the book.
      </p>
      {loading && <p className="mt-4 text-sm text-muted-foreground">Checking the market…</p>}
      {!loading && error && <p className="mt-4 text-sm text-muted-foreground">{error}</p>}
      {!loading && !error && ladder && <LadderBody ladder={ladder} />}
    </section>
  );
}

function LadderBody({ ladder }: { ladder: PriceLadder }) {
  return (
    <>
      <p className="mt-4 text-sm font-medium text-foreground tabular-nums">{ladder.summary}</p>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        {ladder.fits} buy box{ladder.fits === 1 ? "" : "es"} on UPB fit{ladder.fits === 1 ? "s" : ""} this paper at your ask, and {ladder.standingCount} carr{ladder.standingCount === 1 ? "ies" : "y"} a standing price.
      </p>
      {ladder.rate && (
        <p className="mt-1 text-xs">
          Spread-priced standing bids use the <RateNote rate={ladder.rate} />.
        </p>
      )}
      {ladder.rows.length > 0 && (
        <div className="mt-4 relative overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">Standing bids at or above each price, as a percent of UPB</caption>
            <thead className="text-xs font-medium text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">Price</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Of UPB</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Standing bids at or above</th>
                <th scope="col" className="px-3 py-2 font-normal"><span className="sr-only">Marks</span></th>
              </tr>
            </thead>
            <tbody>
              {ladder.rows.map((row) => (
                <tr key={row.ofUpb} className={`border-t border-border ${row.tags.includes("Your ask") ? "bg-link/5" : ""}`}>
                  <td className="px-3 py-2.5 tabular-nums text-foreground">{money(row.price)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{Number.isInteger(row.ofUpb) ? row.ofUpb : row.ofUpb.toFixed(1)}%</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {row.atOrAbove} of {ladder.standingCount}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{row.tags.join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="mt-4 space-y-1 text-xs leading-relaxed text-muted-foreground tabular-nums">
        <li>
          {ladder.comps
            ? `Closed trades like this: median ${ladder.comps.median}% of UPB across ${ladder.comps.count} trades, ranging ${ladder.comps.low}–${ladder.comps.high}%. ${ladder.comps.label}.`
            : "Fewer than three closed trades like this on UPB, so there is no comp yet."}
        </li>
        <li>
          {ladder.model
            ? `${ladder.model.label}: about ${Math.round(ladder.model.mid)}% of UPB, ${Math.round(ladder.model.low)}–${Math.round(ladder.model.high)}% one point of IRR either side, on the seller's value.`
            : "The desk model can't price this from what is entered."}
        </li>
        <li>{ladder.basis}</li>
        <li>{ladder.disclaimer}</li>
      </ul>
    </>
  );
}
