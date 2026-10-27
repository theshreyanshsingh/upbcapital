import { setLeadStatus } from "@/actions/leads";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { money, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Seller leads" };

const STATUSES = ["NEW", "CONTACTED", "LISTING", "PASSED"] as const;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const leads = await prisma.sellerLead.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <div>
      <PageIntro eyebrow="Acquisitions" title="People who want to sell." lede="Each quote is an indicative range. Move a lead when you have spoken, when they file, or when you pass." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <ul className="mt-8 divide-y divide-border border border-border rounded-xl">
        {leads.length === 0 && <li className="px-5 py-10 text-sm text-muted-foreground">No quotes yet. The public form is at Sell your note.</li>}
        {leads.map((lead) => (
          <li key={lead.id} className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0">
              <p className="font-semibold tracking-tight text-2xl text-foreground">{lead.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {lead.email}{lead.city ? ` · ${lead.city}` : ""}, {lead.state} · {labelOf("payment", lead.paymentStatus)} · {labelOf("lien", lead.lienPosition)}
              </p>
              <p className="mt-2 text-sm text-foreground">
                {money(Number(lead.indicativeLow))} – {money(Number(lead.indicativeHigh))} on {money(Number(lead.upb))} UPB
              </p>
              {lead.note && <p className="mt-2 text-sm text-muted-foreground">{lead.note}</p>}
            </div>
            <form action={setLeadStatus} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="id" value={lead.id} />
              <select name="status" defaultValue={lead.status} className="desk-input" aria-label={`Status for ${lead.name}`}>
                {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Save</SubmitButton>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
