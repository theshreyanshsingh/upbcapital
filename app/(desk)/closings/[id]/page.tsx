import { notFound, redirect } from "next/navigation";
import { markShareFunded } from "@/actions/group";
import { saveBoarding } from "@/actions/boarding";
import { cancelClosing, completeClosingStep, recordSettlement, saveWireInstructions, setClosingDates, uploadClosingFile } from "@/actions/closing";
import { ComplianceNote } from "@/components/compliance-note";
import { DeskNotes } from "@/components/desk-notes";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { closingAccess } from "@/lib/acl";
import { requireUser } from "@/lib/auth";
import { stepLabel } from "@/lib/closing";
import { STEP_OWNER, closingClock, effectiveDue, stepClock, targetDays } from "@/lib/closing-clock";
import { closingBrokerView } from "@/lib/broker-pay";
import { brokerRoleLabel } from "@/lib/broker-fees";
import { isoDate, money, num, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { variance, type Variance } from "@/lib/settlement";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Closing" };

export default async function ClosingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requireUser();
  const closing = await prisma.closing.findUnique({
    where: { id },
    include: { listing: { include: { seller: true, notes: true } }, steps: { include: { files: true }, orderBy: { key: "asc" } }, boarding: true, funders: { include: { user: true }, orderBy: { percent: "desc" } } },
  });
  if (!closing) notFound();
  const inquiry = closing.inquiryId
    ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true, note: true } })
    : null;
  const brokerView = await closingBrokerView(closing.id);
  const access = closingAccess({
    role: user.role,
    accountStatus: user.accountStatus,
    userId: user.id,
    sellerId: closing.listing.sellerId,
    buyerId: inquiry?.buyerId ?? null,
    funderIds: closing.funders.map((funder) => funder.userId),
    brokerId: closing.listing.brokerId,
    buyerReferrerId: inquiry?.buyer.referredById,
  });
  if (!access) redirect("/closings");
  const party = access === "party";
  const order = ["PURCHASE_AGREEMENT", "BUYER_DEPOSIT", "COLLATERAL_TRANSFER", "ASSIGNMENT", "PAYMENT_RECEIVED", "CLOSED"];
  const steps = [...closing.steps].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const days = targetDays((await getSettings()).closingTargetDays);
  const clock = closingClock(closing, steps, days);
  const isAdmin = user.role === "ADMIN";
  const isSeller = user.id === closing.listing.sellerId;
  const isBuyer = user.id === inquiry?.buyerId || closing.funders.some((funder) => funder.userId === user.id);
  const funds = variance(closing.buyerTotalCents, closing.fundsReceivedCents);
  const proceeds = variance(closing.netToSellerCents, closing.proceedsSentCents);
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
        <p className="eyebrow mt-4">Closing · {closing.deskBidId ? "Desk purchase" : closing.provider}</p>
        <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{closing.listing.title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {closing.deskBidId
            ? `UPB Capital buying from ${closing.listing.seller.companyName || closing.listing.seller.name}`
            : `${inquiry?.buyer.name ?? "Buyer"} buying from ${closing.listing.seller.companyName || closing.listing.seller.name}`}
          {inquiry?.note ? ` · ${inquiry.note.city}, ${inquiry.note.state}` : " · whole listing"}
        </p>
        {closing.status === "OPEN" && (
          <p className={`mt-4 text-sm ${clock.late || clock.overdue ? "text-bad" : "text-muted-foreground"}`}>
            Target close {prettyDate(clock.target)} · day {clock.daysOpen}
            {clock.overdue ? ` · ${clock.overdue} step${clock.overdue === 1 ? "" : "s"} late` : ""}
            {clock.late ? " · past the target" : ""}
            {clock.next ? ` · next: ${stepLabel(clock.next.key)} by ${prettyDate(clock.next.due)}` : ""}
          </p>
        )}
        {closing.status === "COMPLETE" && <p className="mt-4 text-sm text-muted-foreground">Closed in {clock.daysOpen} day{clock.daysOpen === 1 ? "" : "s"}.</p>}
        {closing.status === "CANCELED" && (
          <p role="status" className="mt-4 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-foreground rounded-xl">
            Canceled{closing.canceledAt ? ` ${prettyDate(closing.canceledAt)}` : ""}.{closing.cancelReason ? ` ${closing.cancelReason}` : ""} Nothing was posted to the ledger.
          </p>
        )}
        <ComplianceNote
          states={closing.listing.notes.map((note) => note.state)}
          sellerFinanced={closing.listing.sellerFinanced}
          sellerRole={closing.listing.seller.role}
        />
        {party && closing.funders.length > 0 && (
          <section className="mt-8 glass p-6">
            <p className="eyebrow">Buying group</p>
            <p className="mt-2 text-sm text-muted-foreground">Each buyer funds their share of the price. The premium is split on the same percentages and stays one ledger entry.</p>
            <ul className="mt-4 divide-y divide-border">
              {closing.funders.map((funder) => (
                <li key={funder.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-foreground">{funder.user.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {Number(funder.percent).toFixed(1)}% · price {money(Number(funder.amount))} · premium {money(funder.premiumCents / 100)} · {funder.slice === "PARI" ? "pro rata" : funder.slice.toLowerCase()}
                    </p>
                  </div>
                  {funder.status === "FUNDED" ? (
                    <p className="text-[13px] font-medium text-link">Funded</p>
                  ) : (user.role === "ADMIN" || user.id === funder.userId) && closing.status === "OPEN" ? (
                    <form action={markShareFunded}>
                      <input type="hidden" name="closingId" value={closing.id} />
                      <input type="hidden" name="userId" value={funder.userId} />
                      <SubmitButton className="h-10 text-[13px] font-medium">Mark funded</SubmitButton>
                    </form>
                  ) : (
                    <p className="text-[13px] font-medium text-muted-foreground">Waiting</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        <ol className="mt-8 space-y-4">
          {steps.map((step, index) => (
            <li key={step.id} className="glass p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="font-semibold tracking-tight text-3xl text-foreground">
                  <span className="mr-3 text-link">0{index + 1}</span>
                  {stepLabel(step.key)}
                </p>
                <p className="text-[13px] font-medium text-link">{step.status === "COMPLETE" ? "Complete" : "Open"}</p>
              </div>
              {closing.status === "OPEN" && step.status !== "COMPLETE" && <DueLine due={effectiveDue(step, closing, days)} owner={STEP_OWNER[step.key]} />}
              {step.note && <p className="mt-2 text-sm text-muted-foreground">{step.note}</p>}
              {step.completedAt && <p className="mt-1 text-xs text-muted-foreground">{prettyDate(step.completedAt)}</p>}
              {party ? (
                <ul className="mt-3 space-y-1">
                  {step.files.map((file) => (
                    <li key={file.id}>
                      <a className="text-sm text-link" href={`/api/closing-files/${file.id}`}>{file.originalName}</a>
                    </li>
                  ))}
                </ul>
              ) : (
                step.files.length > 0 && <p className="mt-3 text-xs text-muted-foreground">{step.files.length} file{step.files.length === 1 ? "" : "s"} with the parties.</p>
              )}
              {party && closing.status === "OPEN" && (
                <form action={uploadClosingFile} className="mt-4 flex flex-wrap items-center gap-3">
                  <input type="hidden" name="closingId" value={closing.id} />
                  <input type="hidden" name="stepKey" value={step.key} />
                  <input name="file" type="file" className="text-xs text-muted-foreground" />
                  <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Uploading…">
                    Add file
                  </SubmitButton>
                </form>
              )}
              {user.role === "ADMIN" && closing.status === "OPEN" && step.status === "PENDING" && (
                <form action={completeClosingStep} className="mt-3 space-y-2">
                  <input type="hidden" name="closingId" value={closing.id} />
                  <input type="hidden" name="stepKey" value={step.key} />
                  <input name="note" placeholder="Optional note" className="desk-input" />
                  <SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Saving…">
                    Mark complete
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ol>
        {isAdmin && (
          <div className="mt-10">
            <DeskNotes subjectType="closing" subjectId={closing.id} back={`/closings/${closing.id}`} viewerId={user.id} />
          </div>
        )}
        {party && (
          <section className="mt-10 glass p-6">
            <p className="eyebrow">Closing documents</p>
            <p className="mt-2 text-sm text-muted-foreground">Purchase agreement, assignment, and allonge, filled from this deal. The fields stay editable in the PDF.</p>
            <div className="mt-4 flex flex-wrap gap-4 text-[13px] font-medium">
              <a className="text-link" href={`/api/closings/${closing.id}/packet?kind=PSA`}>Purchase agreement</a>
              <a className="text-link" href={`/api/closings/${closing.id}/packet?kind=ASSIGNMENT`}>Assignment</a>
              <a className="text-link" href={`/api/closings/${closing.id}/packet?kind=ALLONGE`}>Allonge</a>
            </div>
          </section>
        )}
        {party && (closing.status === "COMPLETE" || user.role === "ADMIN") && (
          <section className="mt-6 glass p-6">
            <p className="eyebrow">Servicer boarding</p>
            <form action={saveBoarding} className="mt-4 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="closingId" value={closing.id} />
              <label className="block sm:col-span-2">
                <span className="text-[13px] text-muted-foreground">Servicer</span>
                <input name="servicerName" defaultValue={closing.boarding?.servicerName || ""} className="desk-input mt-2" aria-label="Servicer name" required />
              </label>
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Contact email</span>
                <input name="contactEmail" type="email" defaultValue={closing.boarding?.contactEmail || ""} className="desk-input mt-2" aria-label="Servicer email" />
              </label>
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Loan number</span>
                <input name="loanNumber" defaultValue={closing.boarding?.loanNumber || ""} className="desk-input mt-2" aria-label="Servicer loan number" />
              </label>
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Boarded on</span>
                <input name="boardedAt" type="date" defaultValue={closing.boarding?.boardedAt ? closing.boarding.boardedAt.toISOString().slice(0, 10) : ""} className="desk-input mt-2" aria-label="Boarding date" />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-[13px] text-muted-foreground">Notes</span>
                <textarea name="notes" defaultValue={closing.boarding?.notes || ""} className="desk-input mt-2 min-h-24" aria-label="Boarding notes" />
              </label>
              <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
                <SubmitButton className="h-11 text-[13px] font-medium">Save boarding</SubmitButton>
                <a className="text-[13px] font-medium text-link" href={`/api/closings/${closing.id}/boarding`}>Download package</a>
              </div>
            </form>
          </section>
        )}
      </div>
      <aside className="space-y-4 lg:sticky lg:top-8 lg:self-start">
        <div className="glass p-6">
          <p className="eyebrow">Economics</p>
          <dl className="mt-4 space-y-2 text-sm">
            <Row k="Sale price" v={money(num(closing.salePrice))} />
            <Row k="Buyer premium" v={money(closing.buyerPremiumCents / 100)} />
            <Row k="Buyer all-in" v={money(closing.buyerTotalCents / 100)} />
            <Row k="Seller commission" v={money(closing.sellerCommissionCents / 100)} />
            <Row k="Net to seller" v={money(closing.netToSellerCents / 100)} />
          </dl>
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-[13px] text-muted-foreground">Broker</p>
            {brokerView.attribution && (
              <p className="mt-2 text-sm text-foreground/85">
                {brokerRoleLabel(brokerView.attribution.role)} · {brokerView.attribution.name}
                {brokerView.attribution.client ? ` for ${brokerView.attribution.client}` : ""}
              </p>
            )}
            {brokerView.posted.map((fee) => (
              <p key={fee.id} className="mt-2 flex justify-between gap-4 text-sm">
                <span className="text-muted-foreground">{brokerRoleLabel(fee.role)} · {fee.status === "PAID" ? "Paid" : "Owed"}</span>
                <span className="text-foreground">{money(fee.amountCents / 100)}</span>
              </p>
            ))}
            {brokerView.preview.map((fee) => (
              <p key={`${fee.brokerId}-${fee.role}`} className="mt-2 flex justify-between gap-4 text-sm">
                <span className="text-muted-foreground">{brokerRoleLabel(fee.role)} · {brokerView.names.get(fee.brokerId) || "Broker"} · posts at close</span>
                <span className="text-foreground">{money(fee.amountCents / 100)}</span>
              </p>
            ))}
            {brokerView.posted.length === 0 && brokerView.preview.length === 0 && !brokerView.withheld.length && (
              <p className="mt-2 text-sm text-muted-foreground">No broker fee on this trade.</p>
            )}
            {brokerView.withheld.map((line) => (
              <p key={line} className="mt-2 text-xs leading-relaxed text-muted-foreground">{line}</p>
            ))}
          </div>
        </div>
        {party && (isAdmin || isSeller || isBuyer) && (
          <div className="glass p-6">
            <p className="eyebrow">Settlement</p>
            <dl className="mt-4 space-y-3 text-sm">
              {(isAdmin || isBuyer) && (
                <WireRow label="Buyer funds received" expected={closing.buyerTotalCents} recorded={closing.fundsReceivedCents} at={closing.fundsReceivedAt} reference={closing.fundsReference} check={funds} />
              )}
              {(isAdmin || isSeller) && (
                <WireRow label="Seller proceeds sent" expected={closing.netToSellerCents} recorded={closing.proceedsSentCents} at={closing.proceedsSentAt} reference={closing.proceedsReference} check={proceeds} />
              )}
            </dl>
            <a className="mt-4 inline-block text-[13px] font-medium text-link" href={`/api/closings/${closing.id}/statement`}>Settlement statement (PDF)</a>
            {isAdmin && closing.status !== "CANCELED" && (
              <div className="mt-5 space-y-5 border-t border-border pt-4">
                <SettlementForm closingId={closing.id} side="funds" title="Record buyer funds" amount={closing.fundsReceivedCents ?? closing.buyerTotalCents} at={closing.fundsReceivedAt} reference={closing.fundsReference} />
                <SettlementForm closingId={closing.id} side="proceeds" title="Record seller proceeds" amount={closing.proceedsSentCents ?? closing.netToSellerCents} at={closing.proceedsSentAt} reference={closing.proceedsReference} />
              </div>
            )}
          </div>
        )}
        {isAdmin && closing.status === "OPEN" && (
          <form action={setClosingDates} className="glass space-y-3 p-6">
            <input type="hidden" name="closingId" value={closing.id} />
            <p className="eyebrow">Dates</p>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Target close</span>
              <input name="targetCloseAt" type="date" defaultValue={isoDate(clock.target) ?? ""} className="desk-input mt-2" required />
            </label>
            {steps.filter((step) => step.status !== "COMPLETE").map((step) => (
              <label key={step.id} className="block">
                <span className="text-[13px] text-muted-foreground">{stepLabel(step.key)} due</span>
                <input name={`due_${step.key}`} type="date" defaultValue={isoDate(effectiveDue(step, closing, days)) ?? ""} className="desk-input mt-2" />
              </label>
            ))}
            <p className="text-xs text-muted-foreground">Parties get a reminder two days before a step is due and each day it runs late.</p>
            <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Save dates</SubmitButton>
          </form>
        )}
        <div className="glass p-6">
          <p className="eyebrow">Escrow · {closing.provider}</p>
          {closing.providerRef && <p className="mt-2 text-xs text-muted-foreground">Reference {closing.providerRef}</p>}
          {user.role === "ADMIN" && closing.status === "OPEN" ? (
            <form action={saveWireInstructions} className="mt-4 space-y-3">
              <input type="hidden" name="closingId" value={closing.id} />
              <Textarea name="wireInstructions" defaultValue={closing.wireInstructions} className="min-h-36 bg-card" />
              <input name="providerRef" defaultValue={closing.providerRef} placeholder="Provider reference, if any" className="desk-input" />
              <SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Save wires</SubmitButton>
            </form>
          ) : party ? (
            <pre className="mt-4 whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground/85">{closing.wireInstructions || "The desk has not issued wire instructions."}</pre>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Wire instructions go to the buyer and the seller only.</p>
          )}
        </div>
        {user.role === "ADMIN" && closing.status === "OPEN" && (
          <form action={cancelClosing} className="glass space-y-3 p-6">
            <input type="hidden" name="closingId" value={closing.id} />
            <p className="eyebrow">Cancel this closing</p>
            <p className="text-sm text-muted-foreground">The deal ends and the note goes back on the book. It cannot be reopened, and the buyer would need to send a new offer. Money already wired has to be returned outside the app.</p>
            <Textarea name="reason" aria-label="Why this closing is being canceled" placeholder="Why, in a sentence. Both sides see this." className="min-h-20 bg-card" required minLength={3} />
            <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Canceling…">Cancel closing</SubmitButton>
          </form>
        )}
      </aside>
    </div>
  );
}

function DueLine({ due, owner }: { due: Date | null; owner: string }) {
  if (!due) return null;
  const state = stepClock("PENDING", due);
  const who = owner === "both" ? "Buyer and seller" : owner === "desk" ? "The desk" : owner === "buyer" ? "Buyer" : "Seller";
  return (
    <p className={`mt-1 text-xs ${state === "overdue" ? "text-bad" : state === "due_soon" ? "text-foreground" : "text-muted-foreground"}`}>
      {state === "overdue" ? "Late · was due" : "Due"} {prettyDate(due)} · {who}
    </p>
  );
}

function WireRow({ label, expected, recorded, at, reference, check }: { label: string; expected: number; recorded: number | null; at: Date | null; reference: string | null; check: Variance }) {
  return (
    <div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="text-foreground">{recorded == null ? "Not recorded" : money(recorded / 100, 2)}</dd>
      </div>
      <p className={`text-xs ${check.state === "short" || check.state === "over" ? "text-bad" : "text-muted-foreground"}`}>
        Expected {money(expected / 100, 2)}
        {check.state === "match" ? " · matches" : check.state === "short" ? ` · short ${money(-check.diffCents / 100, 2)}` : check.state === "over" ? ` · over by ${money(check.diffCents / 100, 2)}` : ""}
        {at ? ` · ${prettyDate(at)}` : ""}
        {reference ? ` · ${reference}` : ""}
      </p>
    </div>
  );
}

function SettlementForm({ closingId, side, title, amount, at, reference }: { closingId: string; side: "funds" | "proceeds"; title: string; amount: number; at: Date | null; reference: string | null }) {
  return (
    <form action={recordSettlement} className="space-y-2">
      <input type="hidden" name="closingId" value={closingId} />
      <input type="hidden" name="side" value={side} />
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <div className="grid grid-cols-2 gap-2">
        <input name="amount" inputMode="decimal" defaultValue={(amount / 100).toFixed(2)} aria-label={`${title} amount`} className="desk-input" required />
        <input name="at" type="date" defaultValue={isoDate(at) ?? ""} aria-label={`${title} date`} className="desk-input" required />
      </div>
      <input name="reference" defaultValue={reference ?? ""} placeholder="Wire reference" aria-label={`${title} reference`} className="desk-input" />
      <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Save</SubmitButton>
    </form>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </div>
  );
}
