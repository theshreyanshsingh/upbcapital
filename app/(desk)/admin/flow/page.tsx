import Link from "next/link";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { cadenceLabel, PROGRAM_LABEL, programList, timeLeft } from "@/lib/flow-programs";
import { prettyDate, q } from "@/lib/format";
import { launchTime } from "@/lib/launch-rules";
import { prisma } from "@/lib/prisma";
import { requireDesk } from "@/lib/staff";

export const metadata = { title: "Forward flow" };

const ORDER = ["DRAFT", "OPEN", "PAUSED", "CLOSED"];

export default async function AdminFlowPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireDesk("sales", "/admin");
  const params = await searchParams;
  const programs = await programList();
  const now = new Date();
  const running = programs.flatMap((program) =>
    program.tranches.filter((tranche) => tranche.status === "FIRST_LOOK" && tranche.firstLookEndsAt).map((tranche) => ({ program, tranche, endsAt: tranche.firstLookEndsAt as Date })),
  );
  const titles = running.length
    ? await prisma.listing.findMany({ where: { id: { in: running.map((row) => row.tranche.listingId) } }, select: { id: true, title: true } })
    : [];
  const titleOf = new Map(titles.map((row) => [row.id, row.title]));
  const groups = ORDER.map((status) => ({ status, rows: programs.filter((program) => program.status === status) })).filter((group) => group.rows.length);
  return (
    <div className="max-w-5xl">
      <PageIntro
        eyebrow="Forward flow"
        title="Sellers' programmes."
        lede="Approve, pause or close each programme. Its tranches come through the review queue as any listing, and each one's first look starts at approval."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />

      <section aria-labelledby="running-heading">
        <h2 id="running-heading" className="eyebrow">In first look now</h2>
        {running.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No tranche is in its first look.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {running
              .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime())
              .map(({ program, tranche, endsAt }) => (
                <li key={tranche.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <div className="min-w-0">
                    <Link href={`/admin/listings/${tranche.listingId}`} className="font-medium text-link">{titleOf.get(tranche.listingId) ?? "Listing"}</Link>
                    <p className="text-muted-foreground">Tranche {tranche.sequence} of {program.name} · {program.commitments.ACTIVE} committed buyer{program.commitments.ACTIVE === 1 ? "" : "s"}</p>
                  </div>
                  <span className="text-foreground tabular-nums">Until {launchTime(endsAt)} · {timeLeft(endsAt, now)}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      {groups.length === 0 && <p className="mt-10 text-sm text-muted-foreground">No seller has started a programme yet.</p>}
      {groups.map((group) => (
        <section key={group.status} aria-labelledby={`flow-${group.status}`} className="mt-10">
          <h2 id={`flow-${group.status}`} className="eyebrow">{PROGRAM_LABEL[group.status]}</h2>
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {group.rows.map((program) => (
              <li key={program.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <Link href={`/admin/flow/${program.id}`} className="font-medium text-link">{program.name}</Link>
                  <p className="text-sm text-muted-foreground">
                    {program.seller} · {cadenceLabel(program.cadence)} · {program.firstLookHours}-hour first look · since {prettyDate(program.createdAt)}
                  </p>
                </div>
                <p className="text-sm text-foreground tabular-nums">
                  {program.tranches.length} tranche{program.tranches.length === 1 ? "" : "s"} · {program.commitments.ACTIVE} active · {program.commitments.INVITED} invited · {program.commitments.PAUSED} paused
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
