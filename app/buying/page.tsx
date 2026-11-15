import Link from "next/link";
import { PublicPage } from "@/components/public-page";
import { getCurrentUser } from "@/lib/auth";
import { currentDemandBoard, HIDDEN_LINE, MIN_FIRMS, type DemandCell } from "@/lib/demand-board";
import { isReleaseBuild } from "@/lib/deploy";
import { prettyDate } from "@/lib/format";
import { recordHit } from "@/lib/hits";

export const metadata = {
  title: "Who's buying",
  description: "How many approved buyers on UPB Capital are looking for each kind of mortgage note, by lien, performance and region. Counts only.",
};
export const dynamic = "force-dynamic";

// Counts only, by design: no price, yield, name or anything else that could point at a buyer (lib/demand-board.ts).
function Count({ cell }: { cell: DemandCell }) {
  if (cell.buyers == null) return <span className="text-xs text-muted-foreground">{HIDDEN_LINE}</span>;
  return (
    <span>
      <span className="block text-lg font-semibold tabular-nums text-foreground">{cell.buyers} buyers</span>
      <span className="block text-xs text-muted-foreground">{cell.standing == null ? "Standing bids: fewer than 3" : `${cell.standing} with standing bids`}</span>
    </span>
  );
}

export default async function BuyingPage() {
  await recordHit("/buying");
  const [board, user] = await Promise.all([currentDemandBoard(), getCurrentUser().catch(() => null)]);
  const statuses = board.liens[0]?.cells ?? [];
  return (
    <PublicPage
      title="Who's buying."
      lede="How many approved buyers have an active buy box for each kind of note, and how many of them have a standing bid rule that prices new paper as it arrives."
      authed={Boolean(user)}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        As of {prettyDate(board.asOf)}. Each count is distinct buyer firms, not boxes, and a buyer whose box takes any lien or any state counts in each.
        Counts only: no prices, yields or names. Any count under {MIN_FIRMS} buyers is not shown.
        {isReleaseBuild(process.env) ? "" : " Buyers on this demo server are sample accounts."}
      </p>
      <section className="glass p-5 md:p-6" aria-labelledby="total-heading">
        <h2 id="total-heading" className="eyebrow">All approved buyers with an active buy box</h2>
        <div className="mt-3"><Count cell={board.total} /></div>
      </section>
      <section className="glass p-5 md:p-6" aria-labelledby="lien-heading">
        <h2 id="lien-heading" className="eyebrow">By lien and performance</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">Lien</th>
                {statuses.map((status) => <th key={status.value} scope="col" className="px-3 py-2 font-medium">{status.label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {board.liens.map((lien) => (
                <tr key={lien.value}>
                  <th scope="row" className="py-3 pr-3 text-left font-medium text-foreground">{lien.label}</th>
                  {lien.cells.map((item) => <td key={item.value} className="px-3 py-3 align-top"><Count cell={item.cell} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="glass p-5 md:p-6" aria-labelledby="region-heading">
        <h2 id="region-heading" className="eyebrow">By region</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          {board.regions.map((row) => (
            <div key={row.region}>
              <dt className="text-[13px] text-muted-foreground">{row.region}</dt>
              <dd className="mt-1"><Count cell={row.cell} /></dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">U.S. Census regions.</p>
      </section>
      <p className="text-sm leading-relaxed text-muted-foreground">
        A buy box is a buyer&apos;s standing interest, not a bid. A price is set only when buyers bid on a listing, after the desk reviews the file.
      </p>
      <div className="flex flex-wrap gap-4">
        <Link href="/sell/value" className="inline-flex h-11 items-center rounded-lg bg-primary px-5 text-[13px] font-medium text-primary-foreground">Value my loans</Link>
        <Link href="/sell" className="inline-flex h-11 items-center text-[13px] font-medium text-muted-foreground">Get a quote on one note</Link>
      </div>
    </PublicPage>
  );
}
