import type { CompCell } from "@/lib/comps";
import { prettyDate } from "@/lib/format";

// Closed-trade comps for one listing. Presentational only, so it renders in a server or a client tree.
//
// Load on the server and pass the cell in:
//   const trades = await loadClosedTrades();
//   const comps = compsFor({ state, lienPosition, paymentStatus }, trades);
//   <CompsPanel comps={comps} state={state} ask={ask} upb={upb} asOf={new Date()} />
export type CompsPanelProps = {
  // From compsFor(). It is the narrowest group (state, then region, then all states) with at least three trades.
  // Null shows the empty state.
  comps: CompCell | null;
  // The listing's state, so a wider group can say why it is wider.
  state?: string | null;
  // The ask and UPB, to place the ask on the range. Both optional.
  ask?: number | null;
  upb?: number | null;
  // When the trades were read.
  asOf: Date | string;
  windowMonths?: number;
};

export function CompsPanel({ comps, state, ask, upb, asOf, windowMonths = 24 }: CompsPanelProps) {
  const askPct = ask && upb && upb > 0 ? Math.round((ask / upb) * 100) : null;
  const basis = `Gross price over UPB on closings completed on UPB in the ${windowMonths} months to ${prettyDate(asOf)}, before the buyer premium and seller commission. A group shows only with three or more trades, and sizes show as bands, so no single trade can be read from it.`;
  if (!comps) {
    return (
      <section className="glass p-6">
        <p className="eyebrow">Closed-trade comps</p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Fewer than three closed trades like this one so far, so there is no comp to show yet.
        </p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{basis}</p>
      </section>
    );
  }
  const wider = comps.geo !== "state" && state ? `Fewer than three trades in ${state.toUpperCase()}, so this is the ${comps.geo === "region" ? `${comps.place} region` : "all-state"} figure.` : null;
  return (
    <section className="glass p-6">
      <p className="eyebrow">Closed-trade comps</p>
      <p className="mt-3 font-semibold tracking-tight text-3xl tabular-nums text-foreground">{comps.median}% of UPB</p>
      <p className="mt-1 text-sm text-muted-foreground tabular-nums">
        Median of {comps.count} closed trades · {comps.label} · typical UPB {comps.upbBand}
      </p>
      <RangeBar low={comps.low} high={comps.high} median={comps.median} mark={askPct} markLabel="Ask" />
      <p className="mt-2 text-sm text-foreground tabular-nums">
        Range {comps.low}% to {comps.high}% of UPB.{askPct != null ? ` The ask is ${askPct}% of UPB.` : ""}
      </p>
      {wider && <p className="mt-2 text-xs text-muted-foreground">{wider}</p>}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{basis}</p>
    </section>
  );
}

// A low-to-high band with the median and an optional marker, on a scale padded around both.
export function RangeBar({
  low,
  high,
  median,
  mark,
  markLabel,
  className = "mt-5",
}: {
  low: number;
  high: number;
  median: number;
  mark?: number | null;
  markLabel?: string;
  className?: string;
}) {
  const lo = Math.max(0, Math.min(low, mark ?? low) - 5);
  const hi = Math.max(high, mark ?? high) + 5;
  const at = (value: number) => `${((value - lo) / (hi - lo)) * 100}%`;
  return (
    <div className={`relative h-6 ${className}`} aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-link/30" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
      <div className="absolute top-0 h-6 w-0.5 bg-foreground" style={{ left: at(median) }} />
      {mark != null && (
        <div className="absolute -top-1 h-8 w-0.5 bg-link" style={{ left: at(mark) }}>
          <span className="absolute -top-4 left-1 whitespace-nowrap text-[11px] text-link">{markLabel}</span>
        </div>
      )}
    </div>
  );
}
