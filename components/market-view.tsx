import { RangeBar } from "@/components/comps-panel";
import type { CompCell, MarketView as MarketViewData } from "@/lib/comps";
import { prettyDate } from "@/lib/format";

// A read-only, anonymised view of what closed on UPB, for sellers and brokers. Pass marketView(await
// loadClosedTrades()). Presentational only.
export type MarketViewProps = {
  view: MarketViewData;
  audience?: "seller" | "broker";
  // True on a demo server, where the trades are seeded and fictional.
  demo?: boolean;
};

const STATUS: Record<string, string> = { PERFORMING: "Performing", SUB_PERFORMING: "Sub-performing", NON_PERFORMING: "Non-performing" };
const LIEN: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third", OTHER: "Other" };

export function MarketView({ view, audience = "seller", demo = false }: MarketViewProps) {
  const rows = [...view.national, ...view.regional];
  const lede =
    audience === "broker"
      ? "What notes like your clients' have closed at. Share the shape of the market, not a single trade."
      : "What notes like yours have closed at, to set an ask that trades.";
  return (
    <section className="glass p-5 md:p-6">
      <p className="eyebrow">Closed trades</p>
      <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">What closed notes sold for</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{lede}</p>
      {rows.length === 0 ? (
        <p className="mt-5 border border-dashed border-border px-4 py-6 text-sm text-muted-foreground rounded-xl">
          No group has three closed trades yet, so there is nothing to show. The view fills in as trades close.
        </p>
      ) : (
        <div className="mt-5 relative overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">Price as a percent of UPB on closed trades, by lien, performance and place</caption>
            <thead className="text-xs font-medium text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">Lien</th>
                <th scope="col" className="px-3 py-2 font-normal">Performance</th>
                <th scope="col" className="px-3 py-2 font-normal">Where</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Trades</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Median</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Range</th>
                <th scope="col" className="hidden px-3 py-2 font-normal md:table-cell"><span className="sr-only">Range chart</span></th>
                <th scope="col" className="px-3 py-2 font-normal">Typical UPB</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={`${row.geo}-${row.lienPosition}-${row.paymentStatus}-${row.place}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground tabular-nums">
        Gross price over UPB on {view.total} closing{view.total === 1 ? "" : "s"} completed on UPB in the {view.windowMonths} months to {prettyDate(view.asOf)}, before the buyer premium and seller commission. A group shows only with three or more trades, and sizes show as bands, so no single trade can be read from it.
        {view.suppressed > 0 ? ` ${view.suppressed} trade${view.suppressed === 1 ? " sits" : "s sit"} in regional groups too small to show.` : ""}
        {demo ? " Trades on this demo server are fictional." : ""}
      </p>
    </section>
  );
}

function Row({ row }: { row: CompCell }) {
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-3 text-foreground">{LIEN[row.lienPosition] ?? row.lienPosition}</td>
      <td className="px-3 py-3 text-foreground">{STATUS[row.paymentStatus] ?? row.paymentStatus}</td>
      <td className="px-3 py-3 text-muted-foreground">{row.place === "National" ? "All states" : row.place}</td>
      <td className="px-3 py-3 text-right tabular-nums">{row.count}</td>
      <td className="px-3 py-3 text-right font-medium tabular-nums text-foreground">{row.median}%</td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{row.low}–{row.high}%</td>
      <td className="hidden w-40 px-3 py-3 md:table-cell">
        <RangeBar low={row.low} high={row.high} median={row.median} className="mt-0" />
      </td>
      <td className="px-3 py-3 text-muted-foreground">{row.upbBand}</td>
    </tr>
  );
}
