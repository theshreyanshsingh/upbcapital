import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
import { COVER_BID_HEADER, COVER_BID_NOTE, DISPATCH_FOOTNOTE, dispatchView, loadDispatch, pctText, safeSourceUrl, seesFullDispatch, type AgencyLine, type DispatchTables } from "@/lib/dispatch";
import { moneyCompact, prettyDate } from "@/lib/format";

export const metadata = { title: "Market dispatch" };

const LIEN: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third", OTHER: "Other" };
const STATUS: Record<string, string> = { PERFORMING: "Performing", SUB_PERFORMING: "Sub-performing", NON_PERFORMING: "Non-performing" };

export default async function MarketDispatchPage() {
  const user = await requireUser();
  const now = new Date();
  const view = dispatchView(await loadDispatch(now), { full: seesFullDispatch(user, now) });
  return (
    <div className="max-w-5xl">
      <PageIntro
        eyebrow="Market dispatch"
        title={`The note market, ${view.title}.`}
        lede="Agency and HUD sales, what closed on UPB and what is on the book, once a month. Market data, not advice."
      />
      <section className="glass p-5 md:p-6" aria-labelledby="brief-heading">
        <h2 id="brief-heading" className="eyebrow">The month in brief</h2>
        <ul className="mt-4 space-y-3">
          {view.story.map((line, index) => (
            <li key={`${index}-${line.slice(0, 24)}`} className="max-w-3xl text-sm leading-relaxed text-foreground tabular-nums">{line}</li>
          ))}
        </ul>
        <p className="mt-5 text-xs text-muted-foreground tabular-nums">
          As of {prettyDate(view.asOf)}. The new-listing count covers {view.periodLabel}.
        </p>
      </section>

      {view.tables ? (
        <Tables tables={view.tables} />
      ) : (
        <section className="mt-8 rounded-xl border border-dashed border-link/30 px-5 py-6" aria-labelledby="tables-heading">
          <h2 id="tables-heading" className="font-semibold tracking-tight text-foreground">The full tables are part of Pro</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Pro members read every agency result with its cover bid and BPO LTV, UPB&apos;s closed-trade comps by lien, performance and region, the book&apos;s median ask by performance and the depth of standing demand.
          </p>
          {user.role === "BUYER" ? (
            <Link href="/buyer/subscription" className="mt-3 inline-block text-[13px] font-medium text-link">See Pro membership</Link>
          ) : (
            <p className="mt-3 text-[13px] text-muted-foreground">They are open to Pro buyers and the desk.</p>
          )}
        </section>
      )}

      <footer className="mt-10 max-w-3xl space-y-2 border-t border-border pt-5 text-xs leading-relaxed text-muted-foreground">
        <p>{COVER_BID_NOTE}</p>
        <p>{DISPATCH_FOOTNOTE}</p>
        <p>
          {user.marketDispatch === true ? "This issue reaches you by email on the first of each month. " : "Each issue can reach you by email on the first of the month. "}
          <Link href="/account/notifications" className="text-link">{user.marketDispatch === true ? "Change it under Notices" : "Turn it on under Notices"}</Link>.
        </p>
      </footer>
    </div>
  );
}

function Tables({ tables }: { tables: DispatchTables }) {
  const comps = [...tables.comps.national, ...tables.comps.regional];
  return (
    <>
      <Block id="calendar" eyebrow="Agency and HUD calendar" title="Sales coming up and awaiting results">
        {tables.calendar.length ? (
          <Table caption="Agency and HUD sales with bids due, or with results not yet published" head={["Sale", "Bid date", "Settles by", "Loans", "UPB", "Status"]} numeric={[3, 4]}>
            {tables.calendar.map((line) => (
              <tr key={line.id} className="border-t border-border">
                <Cell strong>{line.label}</Cell>
                <Cell>{line.bidDate ? prettyDate(line.bidDate) : "To come"}</Cell>
                <Cell>{line.settleBy ? prettyDate(line.settleBy) : "—"}</Cell>
                <Cell numeric>{line.loans != null ? line.loans.toLocaleString("en-US") : "—"}</Cell>
                <Cell numeric>{line.upb != null ? moneyCompact(line.upb) : "—"}</Cell>
                <Cell>{line.stage === "awaiting" ? "Results not yet published" : "Bids not yet due"}</Cell>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No agency or HUD sale is on the desk&apos;s calendar.</Empty>
        )}
      </Block>

      <Block id="results" eyebrow="Agency and HUD results" title="Cover bids, the second-highest bid">
        {tables.results.length ? (
          <Table
            caption="Agency and HUD results from the last six months. Cover bids are the second-highest bid; winning prices are not published."
            head={["Sale", "Bid date", "Loans", "UPB", `${COVER_BID_HEADER}, % of UPB`, "Cover bid, % of BPO", "BPO LTV", "Winner, as published", "Source"]}
            numeric={[2, 3, 4, 5, 6]}
          >
            {tables.results.map((line) => <ResultRow key={line.id} line={line} />)}
          </Table>
        ) : (
          <Empty>No agency or HUD result in the last six months.</Empty>
        )}
      </Block>

      <Block id="closed" eyebrow="Closed on UPB" title="What closed notes sold for">
        {comps.length ? (
          <Table caption="Gross price over UPB on trades closed on UPB, by lien, performance and place" head={["Lien", "Performance", "Where", "Trades", "Median", "Range", "Typical UPB"]} numeric={[3, 4, 5]}>
            {comps.map((cell) => (
              <tr key={`${cell.geo}-${cell.lienPosition}-${cell.paymentStatus}-${cell.place}`} className="border-t border-border">
                <Cell strong>{LIEN[cell.lienPosition] ?? cell.lienPosition}</Cell>
                <Cell>{STATUS[cell.paymentStatus] ?? cell.paymentStatus}</Cell>
                <Cell>{cell.place === "National" ? "All states" : cell.place}</Cell>
                <Cell numeric>{cell.count}</Cell>
                <Cell numeric strong>{cell.median}%</Cell>
                <Cell numeric>{cell.low}–{cell.high}%</Cell>
                <Cell>{cell.upbBand}</Cell>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No group has three closed trades yet. The table fills in as trades close.</Empty>
        )}
        <Note>
          Gross price over UPB on {tables.comps.total} trade{tables.comps.total === 1 ? "" : "s"} in the {tables.comps.windowMonths} months to {prettyDate(tables.comps.asOf)}, before the buyer premium and seller commission. A group shows only with three or more trades.
          {tables.comps.suppressed > 0 ? ` ${tables.comps.suppressed} trade${tables.comps.suppressed === 1 ? " sits" : "s sit"} in regional groups too small to show.` : ""}
        </Note>
      </Block>

      <Block id="book" eyebrow="On the book" title="Asks and standing demand">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            {tables.asks.length ? (
              <Table caption="Median asking price over UPB on loans for sale, by performance" head={["Performance", "Listings", "Loans", "Median ask over UPB"]} numeric={[1, 2, 3]}>
                {tables.asks.map((cell) => (
                  <tr key={cell.paymentStatus} className="border-t border-border">
                    <Cell strong>{cell.label}</Cell>
                    <Cell numeric>{cell.listings}</Cell>
                    <Cell numeric>{cell.loans}</Cell>
                    <Cell numeric strong>{cell.median}%</Cell>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No performance group has three listings on the book yet.</Empty>
            )}
            <Note>
              Sellers&apos; asks, not trades. A group shows only with three or more listings.
              {tables.suppressedAsks > 0 ? ` ${tables.suppressedAsks} loan${tables.suppressedAsks === 1 ? " sits" : "s sit"} in groups too small to show.` : ""}
            </Note>
          </div>
          <div>
            <Table caption="Live standing price rules from Pro buyers, by the performance they cover" head={["Performance", "Live rules"]} numeric={[1]}>
              {tables.standing.byStatus.map((row) => (
                <tr key={row.paymentStatus} className="border-t border-border">
                  <Cell strong>{row.label}</Cell>
                  <Cell numeric>{row.rules}</Cell>
                </tr>
              ))}
            </Table>
            <Note>
              {tables.standing.rules} live rule{tables.standing.rules === 1 ? "" : "s"}
              {tables.standing.buyers != null ? ` from ${tables.standing.buyers} buyers` : tables.standing.rules ? " from fewer than three buyers" : ""}. Counts only: no rule&apos;s price or holder is shown. A rule covering every kind of paper counts in each row.
            </Note>
          </div>
        </div>
      </Block>
    </>
  );
}

function ResultRow({ line }: { line: AgencyLine }) {
  const source = safeSourceUrl(line.sourceUrl);
  return (
    <tr className="border-t border-border">
      <Cell strong>{line.label}</Cell>
      <Cell>{line.bidDate ? prettyDate(line.bidDate) : "—"}</Cell>
      <Cell numeric>{line.loans != null ? line.loans.toLocaleString("en-US") : "—"}</Cell>
      <Cell numeric>{line.upb != null ? moneyCompact(line.upb) : "—"}</Cell>
      <Cell numeric strong>{line.coverPctUpb != null ? pctText(line.coverPctUpb) : "—"}</Cell>
      <Cell numeric>{line.coverPctBpo != null ? pctText(line.coverPctBpo) : "—"}</Cell>
      <Cell numeric>{line.bpoLtv != null ? pctText(line.bpoLtv) : "—"}</Cell>
      <Cell>{line.winner || "—"}</Cell>
      <Cell>
        {source ? (
          <a href={source} target="_blank" rel="noopener noreferrer" className="text-link">
            Source<span className="sr-only"> for {line.label}</span>
          </a>
        ) : (
          "—"
        )}
      </Cell>
    </tr>
  );
}

function Block({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section className="glass mt-8 p-5 md:p-6" aria-labelledby={`${id}-heading`}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={`${id}-heading`} className="mt-2 font-semibold tracking-tight text-lg text-foreground">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Table({ caption, head, numeric = [], children }: { caption: string; head: string[]; numeric?: number[]; children: React.ReactNode }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-xs font-medium text-muted-foreground">
          <tr>
            {head.map((label, index) => (
              <th key={label} scope="col" className={`px-3 py-2 font-normal ${numeric.includes(index) ? "text-right" : ""}`}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cell({ children, numeric = false, strong = false }: { children: React.ReactNode; numeric?: boolean; strong?: boolean }) {
  return <td className={`px-3 py-3 ${numeric ? "text-right tabular-nums" : ""} ${strong ? "font-medium text-foreground" : "text-muted-foreground"}`}>{children}</td>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{children}</p>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-xs leading-relaxed text-muted-foreground tabular-nums">{children}</p>;
}
