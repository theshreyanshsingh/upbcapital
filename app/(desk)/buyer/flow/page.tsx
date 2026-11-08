import Link from "next/link";
import { acceptFlowTerms, moveFlowCommitment } from "@/actions/flow";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { FlowGridForm } from "@/components/flow-grid-form";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { buyerPrograms, cadenceLabel, COMMITMENT_LABEL, criteriaLines, GRID_BLANKS, PROGRAM_LABEL, timeLeft } from "@/lib/flow-programs";
import { money, prettyDate, q } from "@/lib/format";
import { launchTime } from "@/lib/launch-rules";

export const metadata = { title: "Programmes" };

export default async function BuyerFlowPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["BUYER"]);
  const params = await searchParams;
  const rows = await buyerPrograms(user.id);
  const current = rows.filter((row) => row.status !== "ENDED");
  const past = rows.filter((row) => row.status === "ENDED");
  const now = new Date();
  return (
    <div className="max-w-4xl">
      <PageIntro
        eyebrow="Forward flow"
        title="Programmes you are in."
        lede="A seller's programme brings you each tranche first, before the market. You accept its terms once and keep a price grid that pre-fills the bid form. Every bid is still yours to confirm."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {current.length === 0 && (
        <p className="text-sm text-muted-foreground">No invitations yet. A seller or the desk invites approved buyers to a programme, and it shows here.</p>
      )}
      <div className="space-y-6">
        {current.map((row) => {
          const closed = row.program.status === "CLOSED";
          return (
            <section key={row.id} id={`program-${row.id}`} aria-labelledby={`program-${row.id}-heading`} className="scroll-mt-6 rounded-xl border border-border p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id={`program-${row.id}-heading`} className="text-lg font-semibold tracking-tight text-foreground">{row.program.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {row.seller} · {cadenceLabel(row.program.cadence)} · {row.program.firstLookHours}-hour first look
                    {row.program.expectedVolumeCents ? ` · about ${money(row.program.expectedVolumeCents / 100)} a tranche` : ""}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{criteriaLines(row.criteria).join(" · ")}</p>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                  {closed ? PROGRAM_LABEL.CLOSED : COMMITMENT_LABEL[row.status] ?? row.status}
                </span>
              </div>

              {row.status === "INVITED" ? (
                <div className="mt-4 space-y-3">
                  <div className="max-h-72 overflow-y-auto rounded-lg border border-border px-4 py-3">
                    <p className="text-xs text-muted-foreground">Terms · version {row.version}</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{row.program.terms}</p>
                  </div>
                  {closed ? (
                    <p className="text-sm text-foreground">This programme closed before you answered.</p>
                  ) : (
                    <div className="flex flex-wrap items-end gap-4">
                      <form action={acceptFlowTerms} className="space-y-3">
                        <input type="hidden" name="commitmentId" value={row.id} />
                        <input type="hidden" name="version" value={row.version} />
                        <label className="flex items-start gap-2 text-sm text-foreground">
                          <input type="checkbox" name="accept" value="yes" required className="mt-1" />
                          I read these terms and accept them for this programme.
                        </label>
                        <SubmitButton pendingLabel="Joining…" className="h-10 px-4 text-[13px] font-medium">Accept and join</SubmitButton>
                      </form>
                      <form action={moveFlowCommitment}>
                        <input type="hidden" name="commitmentId" value={row.id} />
                        <SubmitButton name="move" value="DECLINE" variant="ghost" pendingLabel="Declining…" className="h-10 px-3 text-[13px] font-medium text-link">Decline</SubmitButton>
                      </form>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-4 space-y-5">
                  <p className="text-sm text-muted-foreground">
                    You accepted terms version {row.termsVersion ?? "—"} on {prettyDate(row.acceptedAt)}.{" "}
                    {row.status === "PAUSED" ? "Paused: tranches reach you with the market until you resume." : closed ? "" : "Each tranche comes to you first."}
                  </p>
                  <details className="rounded-lg border border-border px-4 py-3">
                    <summary className="cursor-pointer text-[13px] font-medium text-foreground">Programme terms</summary>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{row.program.terms}</p>
                  </details>
                  {row.open.length > 0 && (
                    <div>
                      <p className="eyebrow">In first look now</p>
                      <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                        {row.open.map((tranche) => (
                          <li key={tranche.listingId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                            <Link href={`/marketplace/${tranche.listingId}`} className="font-medium text-link">Tranche {tranche.sequence} · {tranche.title}</Link>
                            {tranche.endsAt && (
                              <span className="text-muted-foreground tabular-nums">Until {launchTime(tranche.endsAt)} · {timeLeft(tranche.endsAt, now)}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!closed && (
                    <div>
                      <p className="eyebrow">Your price grid</p>
                      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                        Percent of each loan&apos;s unpaid balance. The bid form on a tranche adds these up, held to your cap, and waits for you to confirm. The seller never sees it.
                      </p>
                      <div className="mt-3">
                        <FlowGridForm commitmentId={row.id} rows={row.grid} cap={row.maxPerTrancheCents == null ? null : row.maxPerTrancheCents / 100} blanks={GRID_BLANKS} />
                      </div>
                    </div>
                  )}
                  {!closed && (
                    <div className="flex flex-wrap gap-3 border-t border-border pt-4">
                      <form action={moveFlowCommitment}>
                        <input type="hidden" name="commitmentId" value={row.id} />
                        {row.status === "ACTIVE" ? (
                          <SubmitButton name="move" value="PAUSE" variant="outline" pendingLabel="Pausing…" className="h-10 px-4 text-[13px] font-medium">Pause</SubmitButton>
                        ) : (
                          <SubmitButton name="move" value="RESUME" variant="outline" pendingLabel="Resuming…" className="h-10 px-4 text-[13px] font-medium">Resume</SubmitButton>
                        )}
                      </form>
                      <form action={moveFlowCommitment}>
                        <input type="hidden" name="commitmentId" value={row.id} />
                        <input type="hidden" name="move" value="LEAVE" />
                        <ConfirmSubmit
                          title={`Leave ${row.program.name}?`}
                          consequence="Its tranches stop coming to you first, and you need a new invitation to come back. Bids you placed stand."
                          confirmLabel="Leave the programme"
                          pendingLabel="Leaving…"
                          tone="danger"
                          variant="ghost"
                          className="h-10 px-3 text-[13px] font-medium text-link"
                        >
                          Leave the programme
                        </ConfirmSubmit>
                      </form>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {past.length > 0 && (
        <section aria-labelledby="past-heading" className="mt-10">
          <h2 id="past-heading" className="eyebrow">Past programmes</h2>
          <ul className="mt-3 divide-y divide-border border-y border-border">
            {past.map((row) => (
              <li key={row.id} className="py-3 text-sm">
                <span className="text-foreground">{row.program.name}</span>
                <span className="text-muted-foreground"> · {row.seller} · {row.acceptedAt ? "left" : "declined"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
