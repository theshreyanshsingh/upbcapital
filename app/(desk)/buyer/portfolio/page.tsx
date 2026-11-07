import Link from "next/link";
import { quoteSlice, relistBuyerNote } from "@/actions/assets";
import { addOwnedNote, emailStatement, logBuyerPayment, setBuyerHoldingStatus } from "@/actions/portfolio";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { ACCRETION_NOTE, accretedThrough, accretionByYear, type Accretion } from "@/lib/accretion";
import { requireRole } from "@/lib/auth";
import { money, pct, prettyDate, q } from "@/lib/format";
import { partialShare, participationsOpen, PARTICIPATIONS_PAUSED } from "@/lib/participation";
import { ensureBuyerHolding } from "@/lib/portfolio";
import { gapLine, holdingReturn, MIN_RECEIPTS, NOT_ENOUGH, portfolioReturn, type HoldingReturn } from "@/lib/portfolio-returns";
import { ESTIMATED, loadStatementHoldings, statementSeason, statementYears, type SplitReceipt } from "@/lib/portfolio-tax";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Portfolio" };

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BUYER"]);
  const params = await searchParams;
  const [mine, seats] = await Promise.all([
    prisma.inquiry.findMany({ where: { buyerId: user.id }, select: { id: true } }),
    prisma.closingFunder.findMany({ where: { userId: user.id }, select: { closingId: true } }),
  ]);
  const inquiryIds = mine.map((row) => row.id);
  const seatIds = seats.map((row) => row.closingId);
  const closings = await prisma.closing.findMany({
    where: { status: "COMPLETE", OR: [{ inquiryId: { in: inquiryIds } }, { id: { in: seatIds } }] },
    select: { id: true },
  });
  for (const closing of closings) await ensureBuyerHolding(closing.id);
  // Notes this buyer relisted. They answer the desk's sale recommendations from each resale page.
  const resales = await prisma.listing.findMany({ where: { sellerId: user.id }, select: { id: true, title: true, status: true }, orderBy: { createdAt: "desc" } });
  // Each holding with its receipts split, logged or estimated, and any resale proceeds.
  const [holdings, open] = await Promise.all([
    loadStatementHoldings(user.id),
    prisma.closing.findMany({
      where: { status: "OPEN", OR: [{ inquiryId: { in: inquiryIds } }, { funders: { some: { userId: user.id } } }] },
      include: { listing: true },
      orderBy: { openedAt: "desc" },
    }),
  ]);
  const now = new Date();
  const total = portfolioReturn(holdings, now);
  const season = statementSeason(now);
  const years = statementYears(holdings, now);
  const statementForm = (
    <form method="get" action="/api/portfolio/statement" className="mt-3 flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Tax year</span>
        <select name="year" defaultValue={String(years.includes(season.year) ? season.year : years[0])} className="desk-input mt-2 w-32">
          {years.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
      </label>
      <button type="submit" name="format" value="pdf" className="inline-flex h-11 items-center rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground">Download PDF</button>
      <button type="submit" name="format" value="csv" className="inline-flex h-11 items-center rounded-lg border border-border px-4 text-[13px] font-medium text-foreground">Download CSV</button>
      {/* The same year, sent to the buyer's own email with the PDF attached. */}
      <button type="submit" formAction={emailStatement} className="inline-flex h-11 items-center rounded-lg border border-border px-4 text-[13px] font-medium text-foreground">Email me the PDF</button>
    </form>
  );
  const statementHelp = "Interest, principal, fees and escrow received on each note, its cost, and any resale. Where you logged a total only, the split is estimated from the note rate and marked as such. A note bought below its balance also shows the discount accreted that year, for your tax adviser.";
  return (
    <div>
      <PageIntro eyebrow="Portfolio" title="Notes you hold." lede="Closed trades land here. Log what the servicer sends and compare it with the yield you underwrote. A note bought before this desk can be added by hand." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {(q(params, "buyerIrr") || q(params, "sellerIrr")) && (
        <p className="mt-4 text-sm text-foreground">Split model · buyer IRR {q(params, "buyerIrr") || "—"}% · you keep {q(params, "sellerIrr") || "—"}%.</p>
      )}

      {holdings.length > 0 && (
        <section aria-labelledby="returns-heading" className="mt-6 border border-border p-5 rounded-xl">
          <h2 id="returns-heading" className="eyebrow">Returns so far</h2>
          <ReturnFigures result={total} />
          <p className="mt-3 text-xs text-muted-foreground">
            Money back counts receipts and resale proceeds. The IRR uses the dates each dollar moved. A note you still hold counts the balance still owed at your cost, and a payment counts as missed once a month passes without it.
          </p>
        </section>
      )}

      {/* Prepared from January to April, when returns are filed. The year can be picked at any time. */}
      {holdings.length > 0 && season.season ? (
        <section aria-labelledby="statement-heading" className="mt-6 border border-link/30 bg-link/5 p-5 rounded-xl">
          <h2 id="statement-heading" className="text-[15px] font-semibold text-foreground">Your {season.year} year-end statement is ready.</h2>
          <p className="mt-1 text-sm text-muted-foreground">{statementHelp}</p>
          {statementForm}
        </section>
      ) : holdings.length > 0 ? (
        <details className="mt-6 border border-border p-5 rounded-xl">
          <summary className="cursor-pointer text-[13px] font-medium text-foreground">Year-end statement</summary>
          <p className="mt-2 text-sm text-muted-foreground">{statementHelp}</p>
          {statementForm}
        </details>
      ) : null}
      <a className="mt-4 inline-block text-[13px] font-medium text-link" href="/api/portfolio/statement">Download the full payment ledger</a>

      <section className="mt-6 space-y-4">
        {holdings.length === 0 && <p className="border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground rounded-xl">No owned notes yet. A completed closing, or the form below, starts the ledger.</p>}
        {holdings.map((holding) => {
          const result = holdingReturn(holding, now);
          return (
            <article key={holding.id} className="glass p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold tracking-tight text-lg text-foreground">{holding.title}</h2>
                  {holding.sharePercent != null && holding.sharePercent < 99.9 && (
                    <p className="mt-1 text-[13px] font-medium text-link">Your position · {holding.sharePercent.toFixed(1)}%</p>
                  )}
                  <p className="mt-2 text-sm text-muted-foreground">
                    Cost {money(holding.costBasis)} · UPB {money(holding.upb)} · bought {prettyDate(holding.acquiredAt)}
                    {holding.underwrittenYield != null ? ` · underwritten ${holding.underwrittenYield.toFixed(1)}%` : ""}
                  </p>
                  <ReturnLine result={result} />
                  {holding.accretion && <AccretionLine accretion={holding.accretion} title={holding.title} through={holding.proceeds.reduce((first, sale) => (sale.on < first ? sale.on : first), now)} />}
                  {/* The loan record, collateral, chain and payments as one PDF, for a note-on-note lender. */}
                  <a href={`/api/holdings/${holding.id}/lender-pack`} className="mt-2 inline-block text-[13px] font-medium text-link">
                    Download the lender pack<span className="sr-only"> for {holding.title}</span>
                  </a>
                </div>
                <form action={setBuyerHoldingStatus} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={holding.id} />
                  <select name="status" defaultValue={holding.status} className="desk-input" aria-label={`Status for ${holding.title}`}>
                    <option value="CURRENT">Current</option>
                    <option value="WATCH">Watch</option>
                    <option value="RESOLVED">Resolved</option>
                  </select>
                  <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Save</SubmitButton>
                </form>
              </div>
              {holding.receipts.length > 0 && <Receipts title={holding.title} receipts={holding.receipts} rateKnown={holding.annualRate != null} />}
              <form action={logBuyerPayment} className="mt-4">
                <input type="hidden" name="holdingId" value={holding.id} />
                <div className="grid gap-3 sm:grid-cols-4">
                  <input name="amount" inputMode="decimal" className="desk-input" aria-label={`Payment for ${holding.title}`} placeholder="Amount" />
                  <input name="paidOn" type="date" className="desk-input" aria-label="Payment date" />
                  <input name="memo" className="desk-input" aria-label="Payment memo" placeholder="Memo" />
                  <SubmitButton className="h-11 text-[13px] font-medium">Log payment</SubmitButton>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[13px] text-muted-foreground">Add the split from the servicer&apos;s statement</summary>
                  <div className="mt-2 grid gap-3 sm:grid-cols-4">
                    {(["principal", "interest", "fees", "escrow"] as const).map((part) => (
                      <label key={part} className="block">
                        <span className="text-[13px] text-muted-foreground capitalize">{part}</span>
                        <input name={part} inputMode="decimal" className="desk-input mt-1" aria-label={`${part} for ${holding.title}`} />
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">The parts must add up to the amount. Leave them blank and the statement estimates them from the note rate.</p>
                </details>
              </form>
              <div className="mt-4 grid gap-4 border-t border-border pt-4 lg:grid-cols-2">
                {partialShare(holding.sharePercent) && !participationsOpen() ? (
                  <p className="text-sm text-muted-foreground">{PARTICIPATIONS_PAUSED}</p>
                ) : (
                  <form action={relistBuyerNote} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="holdingId" value={holding.id} />
                    <input name="askingPrice" inputMode="decimal" className="desk-input" aria-label={`Relist price for ${holding.title}`} placeholder="Ask" />
                    <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Relist</SubmitButton>
                  </form>
                )}
                <form action={quoteSlice} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="holdingId" value={holding.id} />
                  <input type="hidden" name="side" value="buyer" />
                  <input name="percent" className="desk-input w-24" aria-label={`Percent of ${holding.title}`} placeholder="%" />
                  <input name="monthly" className="desk-input w-28" aria-label={`Monthly payment for ${holding.title}`} placeholder="Monthly" />
                  <input name="paymentCount" className="desk-input w-28" aria-label="Payments to sell" placeholder="Payments" />
                  <input name="price" inputMode="decimal" className="desk-input" aria-label={`Slice price for ${holding.title}`} placeholder="Slice price" />
                  <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Model split</SubmitButton>
                </form>
              </div>
            </article>
          );
        })}
      </section>
      {open.length > 0 && (
        <section className="mt-12">
          <p className="eyebrow">In contract</p>
          <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
            {open.map((closing) => (
              <li key={closing.id} className="px-5 py-4">
                <Link href={`/closings/${closing.id}`} className="font-semibold tracking-tight text-2xl text-foreground">{closing.listing.title}</Link>
                <p className="mt-1 text-sm text-muted-foreground">Tracking starts when the checklist closes.</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {resales.length > 0 && (
        <section className="mt-12" aria-labelledby="resales-heading">
          <h2 id="resales-heading" className="eyebrow">Your resales</h2>
          <ul className="mt-3 divide-y divide-border border border-border rounded-xl">
            {resales.map((resale) => (
              <li key={resale.id} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3">
                <Link href={`/buyer/resales/${resale.id}`} className="text-sm font-medium text-link">{resale.title}</Link>
                <span className="text-[13px] text-muted-foreground">{resale.status.replaceAll("_", " ").toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <form action={addOwnedNote} className="glass mt-12 grid gap-3 p-5 sm:grid-cols-2">
        <p className="eyebrow sm:col-span-2">Add a note you already hold</p>
        <label className="block sm:col-span-2"><span className="text-[13px] text-muted-foreground">Title</span><input name="title" className="desk-input mt-2" aria-label="Holding title" required /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Cost</span><input name="amount" inputMode="decimal" className="desk-input mt-2" aria-label="Cost" required /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">UPB</span><input name="upb" inputMode="decimal" className="desk-input mt-2" aria-label="UPB" required /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Underwritten yield %</span><input name="underwrittenYield" className="desk-input mt-2" aria-label="Underwritten yield" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Acquired</span><input name="acquiredAt" type="date" className="desk-input mt-2" aria-label="Acquired date" required /></label>
        <div className="sm:col-span-2">
          <SubmitButton className="h-11 text-[13px] font-medium">Add to the book</SubmitButton>
        </div>
      </form>
    </div>
  );
}

function irrText(result: HoldingReturn) {
  if (!result.enoughHistory) return NOT_ENOUGH;
  return result.irrPct == null ? "Can't be worked out yet" : pct(result.irrPct);
}

// The book's totals, side by side.
function ReturnFigures({ result }: { result: HoldingReturn }) {
  const cells: [string, string][] = [
    ["Money in", money(result.moneyIn)],
    ["Money back", money(result.moneyBack)],
    ["Net gain so far", `${result.netGain < 0 ? "−" : ""}${money(Math.abs(result.netGain))}`],
    ["Realised IRR", irrText(result)],
  ];
  const gap = result.enoughHistory ? gapLine(result) : null;
  return (
    <>
      <dl className="mt-3 grid grid-cols-2 gap-4 tabular-nums sm:grid-cols-4">
        {cells.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[13px] text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tracking-tight text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {gap && <p className="mt-2 text-sm text-foreground">{gap}.</p>}
      {!result.enoughHistory && <p className="mt-2 text-sm text-muted-foreground">The IRR shows once {MIN_RECEIPTS - result.receiptCount} more payment{MIN_RECEIPTS - result.receiptCount === 1 ? " is" : "s are"} logged.</p>}
    </>
  );
}

// One holding's figures in a line.
function ReturnLine({ result }: { result: HoldingReturn }) {
  const gap = result.enoughHistory ? gapLine(result) : null;
  return (
    <p className="mt-1 text-sm text-foreground tabular-nums">
      In {money(result.moneyIn)} · back {money(result.moneyBack)} · net {result.netGain < 0 ? "−" : ""}{money(Math.abs(result.netGain))} · IRR {irrText(result)}
      {gap ? ` · ${gap}` : ""}
    </p>
  );
}

// The discount a note bought below its balance earns over its life, apart from the split above. To date, and by year.
function AccretionLine({ accretion, title, through }: { accretion: Accretion; title: string; through: Date }) {
  const years = accretionByYear(accretion);
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm text-foreground tabular-nums">
        Discount {money(accretion.discount)} · accreted to date {money(accretedThrough(accretion, through), 2)} · for your tax adviser<span className="sr-only"> on {title}</span>
      </summary>
      <p className="mt-2 text-[13px] text-muted-foreground">{accretion.label}. {ACCRETION_NOTE}</p>
      <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] tabular-nums sm:grid-cols-4">
        {years.map((row) => (
          <li key={row.year} className="flex justify-between gap-3 border-b border-border pb-1">
            <span className="text-muted-foreground">{row.year}</span>
            <span className="text-foreground">{money(row.amount, 2)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// The receipts, newest first, with how each was split.
function Receipts({ title, receipts, rateKnown }: { title: string; receipts: SplitReceipt[]; rateKnown: boolean }) {
  const rows = [...receipts].reverse();
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[13px] font-medium text-foreground">
        {receipts.length} payment{receipts.length === 1 ? "" : "s"} logged<span className="sr-only"> for {title}</span>
      </summary>
      <ul className="mt-2 divide-y divide-border text-sm tabular-nums">
        {rows.map((receipt, index) => (
          <li key={receipt.id ?? index} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
            <span className="text-foreground">{prettyDate(receipt.paidOn)} · {money(receipt.amount, 2)}{receipt.memo ? ` · ${receipt.memo}` : ""}</span>
            <span className="text-[13px] text-muted-foreground">
              {receipt.split
                ? `${receipt.estimated ? `${ESTIMATED}: ` : ""}interest ${money(receipt.split.interest, 2)} · principal ${money(receipt.split.principal, 2)}${receipt.split.fees ? ` · fees ${money(receipt.split.fees, 2)}` : ""}${receipt.split.escrow ? ` · escrow ${money(receipt.split.escrow, 2)}` : ""}`
                : rateKnown ? "Not split" : "Not split · no note rate on file"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
