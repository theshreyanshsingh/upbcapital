import { money, prettyDate } from "@/lib/format";
import { changePercent, sourceLabel, type PriceRow } from "@/lib/price-history";

// A live listing's asks as they moved, newest first (lib/price-history.ts). Buyers see the dates and amounts; the
// seller and the desk also see who moved it (`showSource`). A pool's row names how many loans moved.
export function PriceHistory({ rows, showSource = false, className = "mt-6" }: { rows: PriceRow[]; showSource?: boolean; className?: string }) {
  if (!rows.length) return null;
  return (
    <section aria-labelledby="price-history-heading" className={`${className} border border-border p-5 rounded-xl`}>
      <h2 id="price-history-heading" className="eyebrow">Price history</h2>
      <ol className="mt-3 divide-y divide-border text-sm">
        {[...rows].reverse().map((row, index) => {
          const change = changePercent(row.before, row.after);
          return (
            <li key={`${row.createdAt.getTime()}-${index}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 tabular-nums">
              <span className="text-muted-foreground">
                {prettyDate(row.createdAt)}
                {showSource ? ` · ${sourceLabel(row.source)}` : ""}
              </span>
              <span className="min-w-0 text-foreground">
                {row.loans > 1 ? `${row.loans} loans: ` : ""}
                {money(row.before)} to {money(row.after)}{" "}
                <span className={change < 0 ? "text-good" : "text-warn"}>
                  ({change > 0 ? "+" : ""}
                  {change}%)
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
