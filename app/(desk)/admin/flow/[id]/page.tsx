import Link from "next/link";
import { notFound } from "next/navigation";
import { decideFlowProgram, inviteFlowBuyers } from "@/actions/flow";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { FlowTranches } from "@/components/flow-tranches";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ANY,
  cadenceLabel,
  COMMITMENT_LABEL,
  criteriaLines,
  criteriaOf,
  deskCommitments,
  PROGRAM_LABEL,
  termsVersion,
  trancheReports,
  type GridRow,
} from "@/lib/flow-programs";
import { money, prettyDate, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { deskCan, requireDesk } from "@/lib/staff";

export const metadata = { title: "Forward-flow programme" };

function gridText(grid: GridRow[]) {
  if (!grid.length) return "No grid yet";
  return grid
    .map((row) => `${row.paymentStatus === ANY ? "Any status" : labelOf("payment", row.paymentStatus)}, ${row.lienPosition === ANY ? "any lien" : `${labelOf("lien", row.lienPosition).toLowerCase()} lien`}${row.maxLtv != null ? `, LTV to ${row.maxLtv}%` : ""}: ${row.pct}%`)
    .join(" · ");
}

export default async function AdminFlowProgramPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const user = await requireDesk("sales", "/admin/flow");
  const query = await searchParams;
  const program = await prisma.flowProgram.findUnique({ where: { id } });
  if (!program) notFound();
  const [seller, reports, commitments] = await Promise.all([
    prisma.user.findUnique({ where: { id: program.sellerId }, select: { name: true, companyName: true, email: true } }),
    trancheReports(program.id),
    deskCommitments(program.id),
  ]);
  // A grid is a standing price, so it stays behind the sealed-bid wall with the bids themselves.
  const grids = deskCan(user, "sealedBids");
  const criteria = criteriaOf(program.criteria);
  const decision = (value: string, label: string, variant: "default" | "outline" = "outline") => (
    <SubmitButton name="decision" value={value} variant={variant} pendingLabel="Saving…" className="h-10 px-4 text-[13px] font-medium">{label}</SubmitButton>
  );
  return (
    <div className="max-w-5xl">
      <PageIntro
        eyebrow={`Forward flow · ${PROGRAM_LABEL[program.status] ?? program.status}`}
        title={program.name}
        lede={`${seller?.companyName || seller?.name || "Seller"} · ${cadenceLabel(program.cadence)} tranches with a ${program.firstLookHours}-hour first look for committed buyers.`}
      />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />

      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Seller</dt>
          <dd className="text-foreground">{seller?.companyName || seller?.name} · {seller?.email}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expected volume per tranche</dt>
          <dd className="text-foreground tabular-nums">{program.expectedVolumeCents ? money(program.expectedVolumeCents / 100) : "Not given"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Loans it takes</dt>
          <dd className="text-foreground">{criteriaLines(criteria).join(" · ")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Submitted</dt>
          <dd className="text-foreground">{prettyDate(program.createdAt)}{program.approvedAt ? ` · approved ${prettyDate(program.approvedAt)}` : ""}{program.endsAt ? ` · closed ${prettyDate(program.endsAt)}` : ""}</dd>
        </div>
      </dl>
      <details className="mt-4 rounded-xl border border-border px-4 py-3" open={program.status === "DRAFT"}>
        <summary className="cursor-pointer text-[13px] font-medium text-foreground">Programme terms · version {termsVersion(program.terms)}</summary>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{program.terms}</p>
      </details>

      {program.status !== "CLOSED" && (
        <form action={decideFlowProgram} className="mt-6 max-w-2xl space-y-3 rounded-xl border border-border p-5">
          <input type="hidden" name="programId" value={program.id} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">A note to the seller{program.status === "DRAFT" ? " (needed to decline)" : " (optional)"}</span>
            <Input name="note" maxLength={500} className="mt-1 h-11 bg-card" />
          </label>
          <div className="flex flex-wrap gap-3">
            {program.status === "DRAFT" && decision("APPROVE", "Approve the programme", "default")}
            {program.status === "OPEN" && decision("PAUSE", "Pause")}
            {program.status === "PAUSED" && decision("RESUME", "Resume")}
            <ConfirmSubmit
              name="decision"
              value="CLOSE"
              title={program.status === "DRAFT" ? `Decline ${program.name}?` : `Close ${program.name}?`}
              consequence="Tranches still in their first look open to the market at once, and the seller and committed buyers are told. This can't be undone."
              confirmLabel={program.status === "DRAFT" ? "Decline it" : "Close it"}
              pendingLabel="Closing…"
              tone="danger"
              variant="outline"
              className="h-10 px-4 text-[13px] font-medium"
            >
              {program.status === "DRAFT" ? "Decline" : "Close"}
            </ConfirmSubmit>
          </div>
        </form>
      )}

      <section id="buyers" aria-labelledby="buyers-heading" className="mt-10 scroll-mt-6">
        <h2 id="buyers-heading" className="eyebrow">Committed buyers</h2>
        {commitments.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No buyer invited yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {commitments.map((row) => (
              <li key={row.id} className="px-5 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="min-w-0">
                    <Link href={`/admin/buyers/${row.buyerId}`} className="font-medium text-link">{row.buyer?.companyName || row.buyer?.name || "Buyer"}</Link>
                    <span className="text-muted-foreground"> · {row.buyer?.email}</span>
                  </span>
                  <span className="text-foreground">
                    {COMMITMENT_LABEL[row.status] ?? row.status}
                    {row.acceptedAt ? ` · terms ${row.termsVersion} on ${prettyDate(row.acceptedAt)}` : ""}
                  </span>
                </div>
                {grids && (
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {gridText(row.grid)}
                    {row.maxPerTrancheCents ? ` · cap ${money(row.maxPerTrancheCents / 100)} a tranche` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {program.status === "OPEN" && (
          <form action={inviteFlowBuyers} className="mt-4 max-w-xl space-y-3">
            <input type="hidden" name="programId" value={program.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Invite approved buyers by email</span>
              <Textarea name="emails" required rows={3} className="mt-1 bg-card" />
            </label>
            <SubmitButton pendingLabel="Inviting…" className="h-10 px-4 text-[13px] font-medium">Send invitations</SubmitButton>
          </form>
        )}
      </section>

      <section id="tranches" aria-labelledby="tranches-heading" className="mt-10 scroll-mt-6">
        <h2 id="tranches-heading" className="eyebrow">Tranches</h2>
        <FlowTranches programId={program.id} rows={reports} listingHref={(listingId) => `/admin/listings/${listingId}`} />
      </section>
    </div>
  );
}
