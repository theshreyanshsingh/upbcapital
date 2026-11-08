import Link from "next/link";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { cadenceLabel, PROGRAM_LABEL, programList } from "@/lib/flow-programs";
import { money, prettyDate, q } from "@/lib/format";

export const metadata = { title: "Forward flow" };

export default async function SellerFlowPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["INSTITUTIONAL_SELLER"]);
  const params = await searchParams;
  const programs = await programList({ sellerId: user.id });
  return (
    <div className="max-w-4xl">
      <PageIntro
        eyebrow="Forward flow"
        title="Sell in tranches to committed buyers."
        lede="List on a schedule, and the buyers who signed your programme's terms see each tranche first, before it opens to the market. The desk approves each programme and reviews every tranche."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <Link href="/seller/flow/new" className="inline-flex h-11 items-center rounded-lg bg-primary px-5 text-[13px] font-medium text-primary-foreground">
        Start a programme
      </Link>
      <section aria-labelledby="programs-heading" className="mt-8">
        <h2 id="programs-heading" className="eyebrow">Your programmes</h2>
        {programs.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">None yet. A programme needs a name, a cadence, the loans it takes and the terms buyers accept.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {programs.map((program) => (
              <li key={program.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <Link href={`/seller/flow/${program.id}`} className="font-medium text-link">{program.name}</Link>
                  <p className="text-sm text-muted-foreground">
                    {cadenceLabel(program.cadence)} · {program.firstLookHours}-hour first look
                    {program.expectedVolumeCents ? ` · about ${money(program.expectedVolumeCents / 100)} a tranche` : ""} · started {prettyDate(program.createdAt)}
                  </p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {program.tranches.length} tranche{program.tranches.length === 1 ? "" : "s"} · {program.commitments.ACTIVE} committed buyer{program.commitments.ACTIVE === 1 ? "" : "s"}
                    {program.commitments.INVITED ? ` · ${program.commitments.INVITED} invited` : ""}
                  </p>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">{PROGRAM_LABEL[program.status] ?? program.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
