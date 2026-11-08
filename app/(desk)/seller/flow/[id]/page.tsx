import Link from "next/link";
import { notFound } from "next/navigation";
import { addFlowTranche, closeFlowProgram, inviteFlowBuyers } from "@/actions/flow";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { FlowProgramForm } from "@/components/flow-program-form";
import { FlowTranches } from "@/components/flow-tranches";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { requireRole } from "@/lib/auth";
import {
  attachCandidates,
  CADENCES,
  cadenceLabel,
  commitmentCounts,
  criteriaLines,
  criteriaOf,
  FIRST_LOOK_HOURS,
  flagLine,
  PROGRAM_LABEL,
  termsVersion,
  trancheCheck,
  trancheReports,
} from "@/lib/flow-programs";
import { money, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Forward-flow programme" };

const STATUS_LINE: Record<string, string> = {
  DRAFT: "With the desk for approval. You can change it until then.",
  OPEN: "Open. Invite buyers, and add each tranche as it is ready.",
  PAUSED: "Paused by the desk. It takes no new tranches, and one approved now goes straight to the market.",
  CLOSED: "Closed. Its tranches no longer go to committed buyers first.",
};

export default async function SellerFlowProgramPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["INSTITUTIONAL_SELLER"]);
  const { id } = await params;
  const query = await searchParams;
  const program = await prisma.flowProgram.findUnique({ where: { id } });
  if (!program || program.sellerId !== user.id) notFound();
  const checkId = q(query, "check");
  const [reports, counts, candidates, check] = await Promise.all([
    trancheReports(program.id),
    commitmentCounts(program.id),
    program.status === "OPEN" ? attachCandidates(user.id) : Promise.resolve([]),
    program.status === "OPEN" && checkId ? trancheCheck(user, program.id, checkId) : Promise.resolve(null),
  ]);
  const criteria = criteriaOf(program.criteria);
  const open = program.status === "OPEN";
  return (
    <div className="max-w-5xl">
      <PageIntro eyebrow={`Forward flow · ${PROGRAM_LABEL[program.status] ?? program.status}`} title={program.name} lede={STATUS_LINE[program.status]} />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />

      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Cadence and first look</dt>
          <dd className="text-foreground">{cadenceLabel(program.cadence)} · {program.firstLookHours} hours</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expected volume per tranche</dt>
          <dd className="text-foreground tabular-nums">{program.expectedVolumeCents ? money(program.expectedVolumeCents / 100) : "Not given"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Loans it takes</dt>
          <dd className="text-foreground">{criteriaLines(criteria).join(" · ")}</dd>
        </div>
      </dl>
      <details className="mt-4 rounded-xl border border-border px-4 py-3">
        <summary className="cursor-pointer text-[13px] font-medium text-foreground">Programme terms · version {termsVersion(program.terms)}</summary>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{program.terms}</p>
      </details>

      {program.status === "DRAFT" && (
        <details className="mt-4 rounded-xl border border-border px-4 py-3">
          <summary className="cursor-pointer text-[13px] font-medium text-foreground">Change the programme</summary>
          <div className="mt-4">
            <FlowProgramForm
              cadences={CADENCES}
              hours={FIRST_LOOK_HOURS}
              program={{
                id: program.id,
                name: program.name,
                cadence: program.cadence,
                firstLookHours: program.firstLookHours,
                expectedVolume: program.expectedVolumeCents == null ? null : program.expectedVolumeCents / 100,
                terms: program.terms,
                ...criteria,
              }}
            />
          </div>
        </details>
      )}

      {open && (
        <section id="add" aria-labelledby="add-heading" className="mt-10 scroll-mt-6">
          <h2 id="add-heading" className="eyebrow">Add a tranche</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            A tranche is a listing the desk reviews as usual. Its first look starts when the desk approves it. Loans outside the programme&apos;s criteria are
            flagged here before you submit.
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border p-5">
              <p className="text-[13px] font-semibold text-foreground">One of your listings with the desk</p>
              {candidates.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">None of your listings is filed or in review outside a programme right now.</p>
              ) : (
                <form method="get" action={`/seller/flow/${program.id}#add`} className="mt-3 space-y-3">
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Listing</span>
                    <select name="check" defaultValue={checkId} className="desk-input mt-1">
                      {candidates.map((listing) => (
                        <option key={listing.id} value={listing.id}>
                          {listing.title} · {listing._count.notes} loan{listing._count.notes === 1 ? "" : "s"} · {labelOf("status", listing.status)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <SubmitButton variant="outline" pendingLabel="Checking…" className="h-10 px-4 text-[13px] font-medium">Check the loans</SubmitButton>
                </form>
              )}
              {check && (
                <div className="mt-4 border-t border-border pt-4">
                  <p className="text-sm font-medium text-foreground">{check.listing.title}</p>
                  {check.listing.flowProgramId ? (
                    <p className="mt-1 text-sm text-foreground">This listing is already in a programme.</p>
                  ) : (
                    <>
                      {check.flags.length === 0 ? (
                        <p className="mt-1 text-sm text-foreground">All {check.listing.notes.length} loans fit the programme&apos;s criteria.</p>
                      ) : (
                        <>
                          <p className="mt-1 text-sm text-foreground">
                            {check.flags.length} of {check.listing.notes.length} loans sit outside the criteria. You can still submit, and the desk sees the flags.
                          </p>
                          <ul className="mt-2 space-y-1 text-sm text-bad">
                            {check.flags.slice(0, 20).map((flag) => (
                              <li key={flag.index}>{flagLine(flag)}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      <form action={addFlowTranche} className="mt-3">
                        <input type="hidden" name="programId" value={program.id} />
                        <input type="hidden" name="listingId" value={check.listing.id} />
                        <SubmitButton pendingLabel="Adding…" className="h-10 px-4 text-[13px] font-medium">Submit as tranche {reports.length + 1}</SubmitButton>
                      </form>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-border p-5">
              <p className="text-[13px] font-semibold text-foreground">A new tape</p>
              <p className="mt-2 text-sm text-muted-foreground">Upload and map it as any tape. The confirm step flags loans outside the criteria, and the pool joins this programme when you submit.</p>
              <Link href={`/seller/pools/new?flow=${program.id}`} className="mt-3 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground">
                Upload a tape for this programme
              </Link>
            </div>
          </div>
        </section>
      )}

      <section id="buyers" aria-labelledby="buyers-heading" className="mt-10 scroll-mt-6">
        <h2 id="buyers-heading" className="eyebrow">Committed buyers</h2>
        <p className="mt-2 text-sm text-foreground tabular-nums">
          {counts.ACTIVE} active · {counts.PAUSED} paused · {counts.INVITED} invited · {counts.ENDED} left
        </p>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">You see counts. Each buyer&apos;s price grid stays between them and the desk.</p>
        {open && (
          <form action={inviteFlowBuyers} className="mt-4 max-w-xl space-y-3">
            <input type="hidden" name="programId" value={program.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Invite buyers by email</span>
              <Textarea name="emails" required rows={3} placeholder="name@fund.com, desk@capital.com" className="mt-1 bg-card" />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">Only buyers whose file the desk approved can join. Up to 25 addresses at a time. Each one accepts the terms before it sees a tranche first.</p>
            <SubmitButton pendingLabel="Inviting…" className="h-10 px-4 text-[13px] font-medium">Send invitations</SubmitButton>
          </form>
        )}
      </section>

      <section id="tranches" aria-labelledby="tranches-heading" className="mt-10 scroll-mt-6">
        <h2 id="tranches-heading" className="eyebrow">Tranches</h2>
        <FlowTranches programId={program.id} rows={reports} listingHref={(listingId) => `/seller/listings/${listingId}`} removable />
      </section>

      {program.status !== "CLOSED" && (
        <form action={closeFlowProgram} className="mt-10">
          <input type="hidden" name="programId" value={program.id} />
          <ConfirmSubmit
            title={`Close ${program.name}?`}
            consequence="Tranches still in their first look open to the market at once, and later listings are ordinary listings. Committed buyers are told. This can't be undone."
            confirmLabel="Close the programme"
            pendingLabel="Closing…"
            tone="danger"
            variant="outline"
            className="h-10 px-4 text-[13px] font-medium"
          >
            Close the programme
          </ConfirmSubmit>
        </form>
      )}
    </div>
  );
}
