import Link from "next/link";
import { decideDeskBid, logDeskPayment, setDeskHoldingStatus } from "@/actions/desk-book";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { ensureAcceptedDeskClosings } from "@/lib/closing-service";
import { money, prettyDate, q } from "@/lib/format";
import { bookReturn } from "@/lib/holdings";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Desk book" };

export default async function DeskBookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  await ensureAcceptedDeskClosings();
  const [bids, holdings, closings, tasks] = await Promise.all([
    prisma.deskBid.findMany({ where: { status: "OPEN" }, include: { listing: true }, orderBy: { createdAt: "desc" } }),
    prisma.deskHolding.findMany({ include: { payments: true, listing: true }, orderBy: { acquiredAt: "desc" } }),
    prisma.closing.findMany({ where: { deskBidId: { not: null } }, select: { id: true, listingId: true, noteId: true, status: true } }),
    prisma.lossTask.findMany({
      where: { doneAt: null, dueOn: { lte: new Date(Date.now() + 7 * 86400000) } },
      include: { case: { include: { holding: true } } },
      orderBy: { dueOn: "asc" },
      take: 8,
    }),
  ]);
  const now = new Date();
  return (
    <div>
      <PageIntro eyebrow="Desk book" title="Paper the desk owns." lede="Accepting a desk bid opens the same closing checklist as a buyer deal. The note lands here when that file is marked closed. Fees follow the schedule unless desk purchases are set to zero." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <div className="mt-4">
        <a className="text-[13px] font-medium text-link" href="/api/admin/book/statement">Download the book</a>
      </div>
      <section className="mt-8">
        <p className="eyebrow">Open bids</p>
        <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
          {bids.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">No open desk bids. Place one from a listing in the queue.</li>}
          {bids.map((bid) => (
            <li key={bid.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <Link href={`/admin/listings/${bid.listingId}`} className="font-semibold tracking-tight text-2xl text-foreground">{bid.listing.title}</Link>
                <p className="mt-1 text-sm text-muted-foreground">{money(Number(bid.amount))}{bid.message ? ` · ${bid.message}` : ""}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <form action={decideDeskBid} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={bid.id} />
                  <input type="hidden" name="decision" value="ACCEPTED" />
                  <input name="consent" className="desk-input w-56" aria-label={`How the seller agreed to the bid on ${bid.listing.title}`} placeholder="How the seller agreed" required minLength={3} />
                  <SubmitButton className="h-10 text-[13px] font-medium">Take it</SubmitButton>
                </form>
                <form action={decideDeskBid}>
                  <input type="hidden" name="id" value={bid.id} />
                  <input type="hidden" name="decision" value="DECLINED" />
                  <SubmitButton variant="ghost" className="h-10 text-[13px] font-medium">Pass</SubmitButton>
                </form>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {tasks.length > 0 && (
        <section className="mt-10">
          <p className="eyebrow">Due this week</p>
          <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-4">
                <Link href={`/admin/book/${task.case.holdingId}`} className="font-semibold tracking-tight text-2xl text-foreground">{task.title}</Link>
                <span className="text-sm text-muted-foreground">{task.case.holding.title} · {prettyDate(task.dueOn)}{task.dueOn < now ? " · overdue" : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mt-12 space-y-4">
        <p className="eyebrow">Owned</p>
        {holdings.length === 0 && <p className="border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground rounded-xl">Nothing owned yet.</p>}
        {holdings.map((holding) => {
          const received = holding.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
          const stats = bookReturn({ cost: Number(holding.costBasis), received, acquiredAt: holding.acquiredAt, now, underwrittenYield: null });
          const closing = closings.find((row) => row.listingId === holding.listingId && row.noteId === holding.noteId) || closings.find((row) => row.id === holding.closingId);
          return (
            <article key={holding.id} className="glass p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold tracking-tight text-lg text-foreground">{holding.title}</h2>
                  <p className="mt-2 flex flex-wrap gap-4 text-[13px] font-medium">
                    <Link href={`/admin/book/${holding.id}`} className="text-link">Loss file</Link>
                    {closing && <Link href={`/closings/${closing.id}`} className="text-link">Closing · {closing.status.toLowerCase()}</Link>}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Cost {money(Number(holding.costBasis))} · UPB {money(Number(holding.upb))} · received {money(received)}
                    {stats.roi != null ? ` · ROI ${stats.roi.toFixed(1)}%` : ""}
                  </p>
                </div>
                <form action={setDeskHoldingStatus} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={holding.id} />
                  <select name="status" defaultValue={holding.status} className="desk-input" aria-label={`Status for ${holding.title}`}>
                    <option value="CURRENT">Current</option>
                    <option value="WATCH">Watch</option>
                    <option value="RESOLVED">Resolved</option>
                  </select>
                  <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Save</SubmitButton>
                </form>
              </div>
              <form action={logDeskPayment} className="mt-4 grid gap-3 sm:grid-cols-4">
                <input type="hidden" name="holdingId" value={holding.id} />
                <input name="amount" className="desk-input" aria-label={`Payment for ${holding.title}`} placeholder="Amount" />
                <input name="paidOn" type="date" className="desk-input" aria-label="Payment date" />
                <input name="memo" className="desk-input" aria-label="Payment memo" placeholder="Memo" />
                <SubmitButton className="h-11 text-[13px] font-medium">Log payment</SubmitButton>
              </form>
            </article>
          );
        })}
      </section>
    </div>
  );
}
