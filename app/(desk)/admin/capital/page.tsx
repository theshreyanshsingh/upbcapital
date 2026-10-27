import { addCommitment, addInvestor, allocateCapital } from "@/actions/capital";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { money, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Capital" };

export default async function CapitalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const [investors, holdings] = await Promise.all([
    prisma.investor.findMany({
      include: { commitments: true, allocations: { include: { holding: { include: { payments: true } } } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.deskHolding.findMany({ orderBy: { acquiredAt: "desc" } }),
  ]);
  return (
    <div>
      <PageIntro
        eyebrow="Capital"
        title="Who funded the book."
        lede="Commitments sit until you assign them to a note the desk bought. A statement attributes cash receipts in proportion to that allocation."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <a className="text-[13px] font-medium text-link" href="/api/admin/capital/statement">Download statements</a>

      <section className="mt-8 space-y-4">
        {investors.length === 0 && <p className="border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground rounded-xl">No investors yet. Add the first commitment below.</p>}
        {investors.map((investor) => {
          const committed = investor.commitments.reduce((sum, row) => sum + Number(row.amount), 0);
          const allocated = investor.allocations.reduce((sum, row) => sum + Number(row.amount), 0);
          const received = investor.allocations.reduce((sum, row) => {
            const cost = Number(row.holding.costBasis);
            const cash = row.holding.payments.reduce((inner, payment) => inner + Number(payment.amount), 0);
            return sum + (cost > 0 ? cash * (Number(row.amount) / cost) : 0);
          }, 0);
          const returned = allocated > 0 ? (received / allocated) * 100 : null;
          return (
            <article key={investor.id} className="glass p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="font-semibold tracking-tight text-lg text-foreground">{investor.name}</h2>
                <p className="text-sm text-muted-foreground">{investor.entity || investor.email}</p>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Committed {money(committed)} · allocated {money(allocated)} · receipts {money(received)}
                {returned != null ? ` · cash return ${returned.toFixed(1)}%` : ""}
              </p>
              <ul className="mt-3 space-y-1 text-sm text-foreground/80">
                {investor.allocations.map((row) => (
                  <li key={row.id}>{row.holding.title} · {money(Number(row.amount))}</li>
                ))}
              </ul>
              <form action={addCommitment} className="mt-4 grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)_auto]">
                <input type="hidden" name="investorId" value={investor.id} />
                <input name="amount" className="desk-input" aria-label={`Commitment for ${investor.name}`} placeholder="Commitment" />
                <input name="note" className="desk-input" aria-label="Commitment note" placeholder="Note" />
                <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Add commitment</SubmitButton>
              </form>
            </article>
          );
        })}
      </section>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <form action={addInvestor} className="border border-border p-5 rounded-xl">
          <p className="eyebrow">New investor</p>
          <div className="mt-4 grid gap-3">
            <input name="name" className="desk-input" aria-label="Investor name" placeholder="Name" required />
            <input name="email" type="email" className="desk-input" aria-label="Investor email" placeholder="Email" required />
            <input name="entity" className="desk-input" aria-label="Investor entity" placeholder="Entity, if any" />
            <SubmitButton className="h-11 text-[13px] font-medium">Add investor</SubmitButton>
          </div>
        </form>
        <form action={allocateCapital} className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Assign capital</p>
          <div className="mt-4 grid gap-3">
            <select name="investorId" className="desk-input" aria-label="Investor" required>
              <option value="">Investor</option>
              {investors.map((investor) => <option key={investor.id} value={investor.id}>{investor.name}</option>)}
            </select>
            <select name="holdingId" className="desk-input" aria-label="Desk note" required>
              <option value="">Note</option>
              {holdings.map((holding) => <option key={holding.id} value={holding.id}>{holding.title}</option>)}
            </select>
            <input name="amount" className="desk-input" aria-label="Allocation amount" placeholder="Amount" required />
            <SubmitButton className="h-11 text-[13px] font-medium">Allocate</SubmitButton>
          </div>
        </form>
      </div>
    </div>
  );
}
