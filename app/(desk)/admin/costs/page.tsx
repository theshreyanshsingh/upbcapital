import { ensureUnitCosts, saveUnitCost } from "@/actions/rehab";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { money, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Unit costs" };

export default async function CostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole(["ADMIN"]);
  await ensureUnitCosts();
  const query = await searchParams;
  const costs = await prisma.unitCost.findMany({ where: { region: "South Florida" }, orderBy: { trade: "asc" } });
  return (
    <div>
      <PageIntro eyebrow="South Florida" title="Unit costs." lede="These are desk defaults for rehab lines, not a contractor’s quote. Editing a trade updates the next line that uses it." />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      <ul className="mt-8 divide-y divide-border border border-border rounded-xl">
        {costs.map((cost) => (
          <li key={cost.id} className="flex items-baseline justify-between px-5 py-4">
            <span className="text-foreground">{cost.trade}</span>
            <span className="text-sm text-muted-foreground">{cost.unit} · {money(cost.costCents / 100)}</span>
          </li>
        ))}
      </ul>
      <form action={saveUnitCost} className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3">
        <input name="trade" className="desk-input" aria-label="Trade" placeholder="Trade" required />
        <input name="unit" className="desk-input" aria-label="Unit" placeholder="sqft, each, square" required />
        <input name="cost" className="desk-input" aria-label="Cost" placeholder="Cost in dollars" required />
        <SubmitButton className="h-11 text-[13px] font-medium">Save cost</SubmitButton>
      </form>
    </div>
  );
}
