import Link from "next/link";
import { CompareToggle } from "@/components/compare-picker";
import { StatusPill } from "@/components/status-pill";
import { BID_MODES, type BookSort, type SortKey } from "@/lib/filters";
import { money, pct, prettyDate } from "@/lib/format";
import type { RateStamp } from "@/lib/indicative";

export type BookTableRow = {
  id: string;
  href: string;
  title: string;
  kind: string;
  place: string;
  lien: string;
  performance: string;
  loanCount: number;
  status: string;
  bidMode: string;
  deadline: string | null;
  hold: "early" | "limit" | null;
  // Null when this viewer sees the figures veiled, exactly as on the card.
  figures: { upb: number; asking: number; priceToUpb: number | null; yield: number | null; value: number; ltv?: number | null } | null;
  // The desk's indicative range in whole percent of UPB, from loadIndicatives(). Null when veiled or unpriced.
  indicative?: { low: number; high: number; rate?: RateStamp | null } | null;
};

type Column = { label: string; sort?: SortKey; figure?: boolean; numeric?: boolean };

const COLUMNS: Column[] = [
  { label: "Type" },
  { label: "Place", sort: "state" },
  { label: "Lien" },
  { label: "Performance" },
  { label: "UPB", sort: "upb", figure: true, numeric: true },
  { label: "Ask", sort: "ask", figure: true, numeric: true },
  { label: "Price / UPB", sort: "discount", figure: true, numeric: true },
  { label: "Yield", sort: "yield", figure: true, numeric: true },
  { label: "Value", sort: "value", figure: true, numeric: true },
  { label: "LTV", sort: "ltv", figure: true, numeric: true },
  { label: "Indicative", figure: true, numeric: true },
  { label: "Status" },
  { label: "Deadline", sort: "deadline" },
];

// The book as rows. The first column stays put while the figures scroll sideways on a narrow screen.
export function BookTable({
  rows,
  sort,
  sortHref,
  pro,
}: {
  rows: BookTableRow[];
  sort: BookSort;
  sortHref: (key: SortKey) => string;
  pro: boolean;
}) {
  return (
    <div className="glass relative overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <caption className="px-4 pt-4 pb-2 text-left text-xs leading-relaxed text-muted-foreground">
          {pro
            ? "Yield is current yield at the ask: the tape's annual P&I over the price, gross before servicing and closing costs, on performing loans only. Value is the seller's estimate, and LTV is UPB over that value. Indicative is the desk's estimate as of today, as a percent of UPB, from its model, closed-trade comps and the top standing bid. It is not an appraisal or advice. A pool shows the totals of the loans still for sale."
            : "Balances, prices, ratios, yields and values are on Pro, so they show as a dash here and can't be sorted."}
        </caption>
        <thead className="text-xs font-medium text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="sticky left-0 z-[1] bg-card px-4 py-2 font-normal">Listing</th>
            {COLUMNS.map((column) => {
              const sortable = column.sort && (!column.figure || pro);
              const current = sortable && sort.key === column.sort;
              return (
                <th
                  key={column.label}
                  scope="col"
                  aria-sort={current ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={`whitespace-nowrap px-3 py-2 font-normal ${column.numeric ? "text-right" : ""}`}
                >
                  {sortable && column.sort ? (
                    <Link href={sortHref(column.sort)} className={`inline-flex min-h-6 items-center gap-1 ${current ? "text-foreground" : "hover:text-foreground"}`}>
                      {column.label}
                      <span aria-hidden="true">{current ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
                      <span className="sr-only">{current ? `, sorted ${sort.dir === "asc" ? "ascending" : "descending"}. Select to reverse` : ", select to sort"}</span>
                    </Link>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-border hover:bg-muted/40">
              <th scope="row" className="sticky left-0 z-[1] min-w-56 bg-card px-4 py-3 text-left font-normal">
                <Link href={row.hold ? `/buyer/subscription?reason=${row.hold}` : row.href} className="font-medium text-foreground hover:text-link">
                  {row.title}
                </Link>
                {row.hold && <span className="block text-xs font-medium text-link">{row.hold === "early" ? "Early access · Pro" : "Beyond the free book"}</span>}
                <span className="mt-1 block"><CompareToggle listingId={row.id} title={row.title} /></span>
              </th>
              <td className="px-3 py-3 whitespace-nowrap">{row.kind === "POOL" ? `Pool · ${row.loanCount} loans` : "Note"}</td>
              <td className="px-3 py-3 whitespace-nowrap">{row.place}</td>
              <td className="px-3 py-3">{row.lien}</td>
              <td className="px-3 py-3">{row.performance}</td>
              <Figure value={row.figures ? money(row.figures.upb) : null} />
              <Figure value={row.figures ? money(row.figures.asking) : null} />
              <Figure value={row.figures ? pct(row.figures.priceToUpb) : null} />
              <Figure value={row.figures ? (row.figures.yield == null ? "None" : pct(row.figures.yield)) : null} />
              <Figure value={row.figures ? (row.figures.value ? money(row.figures.value) : "—") : null} />
              <Figure value={row.figures ? (row.figures.ltv == null ? "—" : pct(row.figures.ltv, 0)) : null} />
              <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                {!row.figures ? (
                  <span className="text-muted-foreground">
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">On Pro</span>
                  </span>
                ) : row.indicative ? (
                  <>
                    {row.indicative.low === row.indicative.high ? `${row.indicative.low}%` : `${row.indicative.low}–${row.indicative.high}%`}
                    {row.indicative.rate?.stale && <span className="block text-xs text-warn">{row.indicative.rate.text}</span>}
                  </>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </td>
              <td className="px-3 py-3"><StatusPill status={row.status} /></td>
              <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                {row.deadline ? (
                  <>
                    {prettyDate(row.deadline)}
                    <span className="block text-xs text-muted-foreground">{BID_MODES.find((mode) => mode.value === row.bidMode)?.label}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Figure({ value }: { value: string | null }) {
  return (
    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
      {value ?? (
        <span className="text-muted-foreground">
          <span aria-hidden="true">—</span>
          <span className="sr-only">On Pro</span>
        </span>
      )}
    </td>
  );
}
