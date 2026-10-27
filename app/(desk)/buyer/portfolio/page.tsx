import Link from "next/link";
import { quoteSlice, relistBuyerNote } from "@/actions/assets";
import { addOwnedNote, logBuyerPayment, setBuyerHoldingStatus } from "@/actions/portfolio";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { money, q } from "@/lib/format";
import { bookReturn } from "@/lib/holdings";
import { ensureBuyerHolding } from "@/lib/portfolio";
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
  const [holdings, open] = await Promise.all([
    prisma.buyerHolding.findMany({ where: { userId: user.id }, include: { payments: { orderBy: { paidOn: "desc" } } }, orderBy: { acquiredAt: "desc" } }),
    prisma.closing.findMany({
      where: { status: "OPEN", OR: [{ inquiryId: { in: inquiryIds } }, { funders: { some: { userId: user.id } } }] },
      include: { listing: true },
      orderBy: { openedAt: "desc" },
    }),
  ]);
  const now = new Date();
  return (
    <div>
      <PageIntro eyebrow="Portfolio" title="Notes you hold." lede="Closed trades land here. Log what the servicer sends and compare it with the yield you underwrote. A note bought before this desk can be added by hand." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {(q(params, "buyerIrr") || q(params, "sellerIrr")) && (
        <p className="mt-4 text-sm text-foreground">Split model · buyer IRR {q(params, "buyerIrr") || "—"}% · you keep {q(params, "sellerIrr") || "—"}%.</p>
      )}
      <a className="text-[13px] font-medium text-link" href="/api/portfolio/statement">Download statement</a>
      <section className="mt-8 space-y-4">
        {holdings.length === 0 && <p className="border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground rounded-xl">No owned notes yet. A completed closing, or the form below, starts the ledger.</p>}
        {holdings.map((holding) => {
          const received = holding.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
          const stats = bookReturn({
            cost: Number(holding.costBasis),
            received,
            acquiredAt: holding.acquiredAt,
            now,
            underwrittenYield: holding.underwrittenYield == null ? null : Number(holding.underwrittenYield),
          });
          return (
            <article key={holding.id} className="glass p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold tracking-tight text-lg text-foreground">{holding.title}</h2>
                  {holding.sharePercent != null && Number(holding.sharePercent) < 99.9 && (
                    <p className="mt-1 text-[13px] font-medium text-link">Your position · {Number(holding.sharePercent).toFixed(1)}%</p>
                  )}
                  <p className="mt-2 text-sm text-muted-foreground">
                    Cost {money(Number(holding.costBasis))} · UPB {money(Number(holding.upb))} · received {money(received)}
                    {holding.underwrittenYield != null ? ` · underwritten ${Number(holding.underwrittenYield).toFixed(1)}%` : ""}
                    {stats.variance != null ? ` · ${stats.variance >= 0 ? "ahead" : "behind"} ${money(Math.abs(stats.variance))}` : ""}
                  </p>
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
              <form action={logBuyerPayment} className="mt-4 grid gap-3 sm:grid-cols-4">
                <input type="hidden" name="holdingId" value={holding.id} />
                <input name="amount" className="desk-input" aria-label={`Payment for ${holding.title}`} placeholder="Amount" />
                <input name="paidOn" type="date" className="desk-input" aria-label="Payment date" />
                <input name="memo" className="desk-input" aria-label="Payment memo" placeholder="Memo" />
                <SubmitButton className="h-11 text-[13px] font-medium">Log payment</SubmitButton>
              </form>
              <div className="mt-4 grid gap-4 border-t border-border pt-4 lg:grid-cols-2">
                <form action={relistBuyerNote} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="holdingId" value={holding.id} />
                  <input name="askingPrice" className="desk-input" aria-label={`Relist price for ${holding.title}`} placeholder="Ask" />
                  <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Relist</SubmitButton>
                </form>
                <form action={quoteSlice} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="holdingId" value={holding.id} />
                  <input type="hidden" name="side" value="buyer" />
                  <input name="percent" className="desk-input w-24" aria-label={`Percent of ${holding.title}`} placeholder="%" />
                  <input name="monthly" className="desk-input w-28" aria-label={`Monthly payment for ${holding.title}`} placeholder="Monthly" />
                  <input name="paymentCount" className="desk-input w-28" aria-label="Payments to sell" placeholder="Payments" />
                  <input name="price" className="desk-input" aria-label={`Slice price for ${holding.title}`} placeholder="Slice price" />
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
      <form action={addOwnedNote} className="glass mt-12 grid gap-3 p-5 sm:grid-cols-2">
        <p className="eyebrow sm:col-span-2">Add a note you already hold</p>
        <label className="block sm:col-span-2"><span className="text-[13px] text-muted-foreground">Title</span><input name="title" className="desk-input mt-2" aria-label="Holding title" required /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Cost</span><input name="amount" className="desk-input mt-2" aria-label="Cost" required /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">UPB</span><input name="upb" className="desk-input mt-2" aria-label="UPB" required /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Underwritten yield %</span><input name="underwrittenYield" className="desk-input mt-2" aria-label="Underwritten yield" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Acquired</span><input name="acquiredAt" type="date" className="desk-input mt-2" aria-label="Acquired date" required /></label>
        <div className="sm:col-span-2">
          <SubmitButton className="h-11 text-[13px] font-medium">Add to the book</SubmitButton>
        </div>
      </form>
    </div>
  );
}
