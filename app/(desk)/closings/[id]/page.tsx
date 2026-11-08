import { notFound, redirect } from "next/navigation";
import { Check } from "lucide-react";
import { markShareFunded } from "@/actions/group";
import { BoardingForm } from "@/components/boarding-form";
import { cancelClosing, completeClosingStep, recordSettlement, saveWireInstructions, setClosingDates, uploadClosingFile, walkAway } from "@/actions/closing";
import { BorrowerNotices } from "@/components/borrower-notices";
import { ClosingMasters } from "@/components/closing-masters";
import { ClaimsPanel } from "@/components/claims-panel";
import { BackupPanel } from "@/components/backup-panel";
import { DepositPanel } from "@/components/deposit-panel";
import { InvoicePanel, PayoutPanel, ProrationPanel, verifiedPayoutChoices } from "@/components/finance-panels";
import { DealTimeline } from "@/components/deal-timeline";
import { KickoutForm } from "@/components/kickout-form";
import { ComplianceNote } from "@/components/compliance-note";
import { DeskNotes } from "@/components/desk-notes";
import { SignaturePanel } from "@/components/signature-panel";
import { TieOutPanel } from "@/components/tie-out";
import { TrailingDocsPanel } from "@/components/trailing-docs";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { closingAccess } from "@/lib/acl";
import { requireUser } from "@/lib/auth";
import { closingLoans, stepLabel } from "@/lib/closing";
import { isENote } from "@/lib/enotes";
import { STEP_OWNER, closingClock, effectiveDue, nextSettlementDay, settlementWeekdays, settlesOn, stepClock, targetDays } from "@/lib/closing-clock";
import { closingBrokerView } from "@/lib/broker-pay";
import { diligenceOpen, loadDealTimeline, timelineView } from "@/lib/closing-service";
import { brokerRoleLabel } from "@/lib/broker-fees";
import { isoDate, money, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { balanceDueCents, buyerDueCents, buyerFundsCheck, economicsRows, moneyGate, proceedsGate, sellerNetCents, statementSide, variance, varianceNote, type Variance } from "@/lib/settlement";
import { getSettings } from "@/lib/settings";
import { boardingChoices } from "@/lib/servicers";
import { cn } from "@/lib/utils";
import { dealOwners, deskCan, deskContact } from "@/lib/staff";
import { pendingWireChanges } from "@/lib/wire-changes";
import { CUSTODIAN_FUNDS, fundingParty } from "@/lib/vesting";
import { saveDealOwner } from "@/actions/staff";
import { decideWires } from "@/actions/wires";
import { faultLabel, strikeLimitOf } from "@/lib/strikes";

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
  const settings = await getSettings();
  const days = targetDays(settings.closingTargetDays);
  const clock = closingClock(closing, steps, days);
  const closedStep = steps.find((step) => step.key === "CLOSED");
  // Money moves only on a settlement day. An older closing's close date can fall on a weekend, so the line reads the
  // next settlement day on or after it rather than claiming a Saturday wire.
  const closeDue = closedStep && closing.status === "OPEN" ? effectiveDue(closedStep, closing, days) : null;
  const settles = closeDue ? nextSettlementDay(closeDue, settlementWeekdays(settings.settlementDays)) : null;
  const isAdmin = user.role === "ADMIN";
  // The desk's forms here are for the closings side. Any other desk role reads the file.
  const runs = isAdmin && deskCan(user, "closings");
  const isSeller = user.id === closing.listing.sellerId;
  const isBuyer = user.id === inquiry?.buyerId || closing.funders.some((funder) => funder.userId === user.id);
  // Each side sees its own figures, the same ones its statement shows. A broker who isn't a party sees only their fee.
  const side = access === "observer" ? "observer" : statementSide({ role: user.role, userId: user.id, sellerId: closing.listing.sellerId, buyerId: inquiry?.buyerId ?? null, funderIds: closing.funders.map((funder) => funder.userId) });
  const mine = side === "buyer" ? closing.funders.find((funder) => funder.userId === user.id) : undefined;
  const economics = economicsRows(
    { ...closing, salePrice: Number(closing.salePrice) },
    side,
    mine ? { amount: Number(mine.amount), premiumCents: mine.premiumCents, status: mine.status, fundedAt: mine.fundedAt } : null,
  );
  const ownFees = isAdmin ? brokerView.posted : brokerView.posted.filter((fee) => fee.brokerId === user.id);
  const ownPreview = isAdmin ? brokerView.preview : brokerView.preview.filter((fee) => fee.brokerId === user.id);
  const balanceDue = balanceDueCents(closing);
  const funds = buyerFundsCheck(closing);
  // The proration moves what the seller nets, so proceeds are checked against the net with it. lib/proration.ts.
  const sellerNet = sellerNetCents(closing);
  const proceeds = variance(sellerNet, closing.proceedsSentCents);
  const deposit = closing.depositCents != null ? variance(closing.depositCents, closing.depositReceivedCents) : null;
  const depositLate = Boolean(closing.depositDueAt && closing.depositReceivedCents == null && closing.status === "OPEN" && closing.depositDueAt.getTime() < Date.now());
  const inDiligence = diligenceOpen(closing);
  // The shared log, cut to what this viewer's side sees on this page.
  const loaded = await loadDealTimeline(closing.id, side);
  const timeline = loaded ? timelineView(loaded) : { entries: [], upcoming: [] };
  // A group's closing is the seats' money, so the desk ends it on their word rather than one seat walking away.
  const canWalkAway = inDiligence && !isAdmin && closing.funders.length <= 1 && (user.id === inquiry?.buyerId || closing.funders.some((funder) => funder.userId === user.id));
  // The named desk contact, and wire changes waiting for a second desk member's approval.
  const [owner, owners, pendingWires, funding] = await Promise.all([
    deskContact(closing.deskOwnerId),
    runs ? dealOwners() : Promise.resolve([]),
    isAdmin ? pendingWireChanges(closing.id) : Promise.resolve([]),
    // A buyer through a self-directed IRA: its custodian signs and wires, so both sides know who the money is from.
    fundingParty(closing),
  ]);
  // The seller's payout accounts verified by call-back, the only ones proceeds can be recorded to.
  const payoutChoices = runs && closing.status !== "CANCELED" ? await verifiedPayoutChoices(closing.listing.sellerId) : [];
  // The servicer directory for the boarding form, each servicer with the loan states it doesn't list.
  const servicerChoices = party ? await boardingChoices(closingLoans(closing, closing.listing.notes).map((note) => note.state), closing.boarding?.servicerId) : [];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
        <p className="eyebrow mt-4">Closing · {closing.deskBidId ? "Desk purchase" : closing.provider}</p>
        <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{closing.listing.title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {closing.deskBidId
            ? `UPB Capital buying from ${closing.listing.seller.companyName || closing.listing.seller.name}`
            : `${inquiry?.buyer.name ?? "Buyer"} buying from ${closing.listing.seller.companyName || closing.listing.seller.name}`}
          {closing.noteIds.length
            ? ` · ${closing.noteIds.length} of ${closing.listing.notes.length} loans`
            : inquiry?.note ? ` · ${inquiry.note.city}, ${inquiry.note.state}` : " · whole listing"}
        </p>
        {(party || isAdmin) && closing.buyerEntity && !closing.deskBidId && closing.funders.length <= 1 && (
          <p className="mt-2 text-sm text-foreground">Takes title as {closing.buyerEntity}</p>
        )}
        {(party || isAdmin) && funding && (
          <p className="mt-2 border border-link/30 bg-link/5 px-3 py-2 text-sm text-foreground rounded-lg">
            Funding party: {funding.custodian}, the IRA custodian. {CUSTODIAN_FUNDS}
          </p>
        )}
        {(owner || runs) && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="text-sm text-foreground">
              {isAdmin ? "Deal owner" : "Your desk contact"}: {owner ? `${owner.name} · ${owner.email}` : "no one named yet"}
            </p>
            {runs && (
              <form action={saveDealOwner} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="kind" value="closing" />
                <input type="hidden" name="id" value={closing.id} />
                <select name="ownerId" defaultValue={closing.deskOwnerId ?? ""} aria-label="Deal owner" className="desk-input h-9 w-48">
                  <option value="">No owner</option>
                  {owners.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
                <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Save owner</SubmitButton>
              </form>
            )}
          </div>
        )}
        {closing.status === "OPEN" && (
          <p className={`mt-4 text-sm ${clock.late || clock.overdue ? "text-bad" : "text-muted-foreground"}`}>
            Target close {prettyDate(clock.target)} · day {clock.daysOpen}
            {clock.overdue ? ` · ${clock.overdue} step${clock.overdue === 1 ? "" : "s"} late` : ""}
            {clock.late ? " · past the target" : ""}
            {clock.next ? ` · next: ${stepLabel(clock.next.key)} by ${prettyDate(clock.next.due)}` : ""}
          </p>
        )}
        {settles && <p className="mt-2 text-sm font-medium text-foreground">Settles on {settlesOn(settles)}</p>}
        {closing.status === "OPEN" && closing.diligenceEndsAt && (
          <p className="mt-2 text-sm text-muted-foreground">
            {inDiligence
              ? `Diligence until ${prettyDate(closing.diligenceEndsAt)}. Until then the buyer can walk away for a finding.`
              : `The diligence window ended ${prettyDate(closing.diligenceEndsAt)}.`}
          </p>
        )}
        {closing.status === "COMPLETE" && <p className="mt-4 text-sm text-muted-foreground">Closed in {clock.daysOpen} day{clock.daysOpen === 1 ? "" : "s"}.</p>}
        {closing.status === "CANCELED" && (
          <p role="status" className="mt-4 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-foreground rounded-xl">
            Canceled{closing.canceledAt ? ` ${prettyDate(closing.canceledAt)}` : ""}.{closing.cancelReason ? ` ${closing.cancelReason}` : ""} Nothing was posted to the ledger.
            {isAdmin && closing.cancelFault ? ` Fault: ${faultLabel(closing.cancelFault).toLowerCase()}.` : ""}
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
            <p className="mt-2 text-sm text-muted-foreground">Each buyer funds their share of the price. The premium is split on the same percentages and stays one ledger entry. The desk marks a share funded when its wire lands.</p>
            <ul className="mt-4 divide-y divide-border">
              {closing.funders.map((funder) => (
                <li key={funder.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-foreground">{funder.user.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {Number(funder.percent).toFixed(1)}% · price {money(Number(funder.amount))}
                      {side === "buyer" || side === "desk" ? ` · premium ${money(funder.premiumCents / 100)}` : ""} · {funder.slice === "PARI" ? "pro rata" : funder.slice.toLowerCase()}
                    </p>
                  </div>
                  {funder.status === "FUNDED" ? (
                    <p className="text-[13px] font-medium text-link">Funded</p>
                  ) : runs && closing.status === "OPEN" ? (
                    <form action={markShareFunded} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="closingId" value={closing.id} />
                      <input type="hidden" name="userId" value={funder.userId} />
                      <input name="reference" placeholder="Wire reference" aria-label={`Wire reference for ${funder.user.name}`} className="desk-input w-40" />
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
        {/* A stepper: finished steps stay short, the step due next is marked and open, and later steps keep their
            forms one tap away, so the page reads as where the file stands rather than six forms in a row. */}
        <ol className="mt-8 space-y-3">
          {steps.map((step, index) => {
            const done = step.status === "COMPLETE";
            const next = !done && clock.next?.key === step.key;
            const forms = (party || user.role === "ADMIN") && closing.status === "OPEN" && (!isAdmin || runs);
            return (
              <li key={step.id} className={cn("glass p-4 sm:p-5", next && "border-link/45")}>
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "figure grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold",
                      done ? "bg-good/12 text-good" : next ? "bg-link text-background" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {done ? <Check className="size-4" strokeWidth={2.5} /> : index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pt-1">
                      <p className="type-title font-semibold text-foreground">
                        <span className="sr-only">Step {index + 1}: </span>
                        {stepLabel(step.key)}
                      </p>
                      <p className={cn("text-[13px] font-medium", done ? "text-good" : next ? "text-link" : "text-muted-foreground")}>{done ? "Complete" : next ? "Next" : "Open"}</p>
                    </div>
                    {closing.status === "OPEN" && step.status !== "COMPLETE" && <DueLine due={effectiveDue(step, closing, days)} owner={STEP_OWNER[step.key]} />}
                    {step.note && <p className="mt-2 text-sm text-muted-foreground">{step.note}</p>}
                    {step.completedAt && <p className="mt-1 text-xs text-muted-foreground">{prettyDate(step.completedAt)}</p>}
                    {party ? (
                      step.files.length > 0 && <ul className="mt-3 space-y-1">
                        {step.files.map((file) => (
                          <li key={file.id}>
                            <a className="text-sm text-link" href={`/api/closing-files/${file.id}`}>{file.originalName}</a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      step.files.length > 0 && <p className="mt-3 text-xs text-muted-foreground">{step.files.length} file{step.files.length === 1 ? "" : "s"} with the parties.</p>
                    )}
                    {forms && (
                      <StepForms open={next} label={done || !isAdmin ? "Add a file" : "Add a file or sign off"}>
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
                            <label className="block text-[13px] text-muted-foreground">
                              Note on this step (optional)
                              <input name="note" className="desk-input mt-1" />
                            </label>
                            <StepGate gate={moneyGate(step.key, closing, closing.funders)} label={stepLabel(step.key)} />
                            {step.key === "CLOSED" ? (
                              // Closing finishes the sale: the loans are sold, the fees post and the buyer's holding is made.
                              <ConfirmSubmit
                                title={`Close ${closing.listing.title}?`}
                                consequence="This finishes the sale. The loans are marked sold, the premium and commission post as revenue, broker fees fall due and the buyer gets the holding. It can't be reopened."
                                details={
                                  <ConfirmRows
                                    rows={[
                                      ["Sale price", money(closing.salePrice)],
                                      ["Buyer all-in", money(buyerDueCents(closing) / 100)],
                                      ["Net to seller", money(sellerNet / 100)],
                                    ]}
                                  />
                                }
                                confirmLabel="Close the deal"
                                pendingLabel="Closing…"
                                className="h-9 text-[13px] font-medium"
                              >
                                Mark complete
                              </ConfirmSubmit>
                            ) : (
                              <SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Saving…">
                                Mark complete
                              </SubmitButton>
                            )}
                          </form>
                        )}
                      </StepForms>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <DealTimeline entries={timeline.entries} upcoming={timeline.upcoming} csvHref={party ? `/api/closings/${closing.id}/timeline` : null} live={closing.status === "OPEN"} />
        {isAdmin && (
          <div className="mt-10">
            <DeskNotes subjectType="closing" subjectId={closing.id} back={`/closings/${closing.id}`} viewerId={user.id} />
          </div>
        )}
        {party && (
          <section className="mt-10 glass p-6">
            <p className="eyebrow">Closing documents</p>
            <p className="mt-2 text-sm text-muted-foreground">Filled from this deal. The lost note affidavit is for a loan whose original note is missing. The fields stay editable in the PDF.</p>
            <div className="mt-4 flex flex-wrap gap-4 text-[13px] font-medium">
              <a className="text-link" href={`/api/closings/${closing.id}/packet?kind=PSA`}>Purchase agreement</a>
              <a className="text-link" href={`/api/closings/${closing.id}/packet?kind=ASSIGNMENT`}>Assignment</a>
              {/* An eNote has no allonge and can't be a lost note. lib/enotes.ts. */}
              {closingLoans(closing, closing.listing.notes).some((note) => !isENote(note)) && (
                <>
                  <a className="text-link" href={`/api/closings/${closing.id}/packet?kind=ALLONGE`}>Allonge</a>
                  <a className="text-link" href={`/api/closings/${closing.id}/packet?kind=LOST_NOTE_AFFIDAVIT`}>Lost note affidavit</a>
                </>
              )}
              {closing.depositCents != null && <a className="text-link" href={`/api/closings/${closing.id}/packet?kind=DEPOSIT_AGREEMENT`}>Deposit agreement</a>}
            </div>
            <ClosingMasters closingId={closing.id} viewerId={user.id} />
          </section>
        )}
        {party && <SignaturePanel closingId={closing.id} open={closing.status === "OPEN"} viewer={user} />}
        {/* The bid tape checked against the tape as of closing. components/tie-out.tsx. */}
        {party && <TieOutPanel closing={closing} canRun={runs} />}
        {party && (
          <BorrowerNotices
            closing={closing}
            boarding={closing.boarding}
            notes={closingLoans(closing, closing.listing.notes)}
            canEdit={runs || isBuyer}
            owner={
              closing.deskBidId
                ? { kind: "desk", buyerId: null, label: "UPB Capital" }
                : closing.funders.length > 1
                  ? { kind: "group", buyerId: null, label: "The buying group" }
                  : { kind: "buyer", buyerId: inquiry?.buyerId ?? null, label: inquiry?.buyer.companyName || inquiry?.buyer.name || "The buyer" }
            }
          />
        )}
        {party && (!isAdmin || runs) && (closing.status === "COMPLETE" || user.role === "ADMIN") && (
          <section className="mt-6 glass p-6">
            <p className="eyebrow">Servicer boarding</p>
            {/* Pick from the desk's servicer directory, or type one. components/boarding-form.tsx. */}
            <BoardingForm
              closingId={closing.id}
              choices={servicerChoices}
              saved={{
                servicerId: closing.boarding?.servicerId ?? null,
                servicerName: closing.boarding?.servicerName || "",
                contactEmail: closing.boarding?.contactEmail || "",
                loanNumber: closing.boarding?.loanNumber || "",
                boardedAt: closing.boarding?.boardedAt ? closing.boarding.boardedAt.toISOString().slice(0, 10) : "",
                goodbyeSentAt: closing.boarding?.goodbyeSentAt ? closing.boarding.goodbyeSentAt.toISOString().slice(0, 10) : "",
                helloSentAt: closing.boarding?.helloSentAt ? closing.boarding.helloSentAt.toISOString().slice(0, 10) : "",
                notes: closing.boarding?.notes || "",
              }}
            />
          </section>
        )}
        {/* What arrives after the close, for each side's own part. components/trailing-docs.tsx. */}
        {party && <TrailingDocsPanel closing={closing} buyerId={inquiry?.buyerId ?? null} viewer={user} />}
        {/* Each side's answers after close, and repurchase claims on the seller's representations. components/claims-panel.tsx. */}
        {party && <ClaimsPanel closing={closing} viewer={user} leadBuyerId={inquiry?.buyerId ?? null} loanPrices={inquiry?.loanPrices} />}
      </div>
      <aside className="space-y-4 lg:sticky lg:top-8 lg:self-start">
        <div className="glass p-6">
          <p className="eyebrow">Economics</p>
          {economics.length > 0 && (
            <dl className="mt-4 space-y-2 text-sm">
              {economics.map((row) => (
                <Row key={row.label} k={row.label} v={money(row.cents / 100)} />
              ))}
            </dl>
          )}
          {(isAdmin || ownFees.length > 0 || ownPreview.length > 0 || side === "observer") && (
            <div className={economics.length > 0 ? "mt-5 border-t border-border pt-4" : "mt-4"}>
              <p className="text-[13px] text-muted-foreground">{isAdmin ? "Broker" : "Your fee"}</p>
              {isAdmin && brokerView.attribution && (
                <p className="mt-2 text-sm text-foreground/85">
                  {brokerRoleLabel(brokerView.attribution.role)} · {brokerView.attribution.name}
                  {brokerView.attribution.client ? ` for ${brokerView.attribution.client}` : ""}
                </p>
              )}
              {ownFees.map((fee) => (
                <p key={fee.id} className="mt-2 flex justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">{brokerRoleLabel(fee.role)} · {fee.status === "PAID" ? "Paid" : "Owed"}</span>
                  <span className="text-foreground">{money(fee.amountCents / 100)}</span>
                </p>
              ))}
              {ownPreview.map((fee) => (
                <p key={`${fee.brokerId}-${fee.role}`} className="mt-2 flex justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">{brokerRoleLabel(fee.role)} · {brokerView.names.get(fee.brokerId) || "Broker"} · posts at close</span>
                  <span className="text-foreground">{money(fee.amountCents / 100)}</span>
                </p>
              ))}
              {isAdmin && brokerView.posted.length === 0 && brokerView.preview.length === 0 && !brokerView.withheld.length && (
                <p className="mt-2 text-sm text-muted-foreground">No broker fee on this trade.</p>
              )}
              {!isAdmin && ownFees.length === 0 && ownPreview.length === 0 && (
                <p className="mt-2 text-sm text-muted-foreground">No fee to you on this trade.</p>
              )}
              {isAdmin && brokerView.withheld.map((line) => (
                <p key={line} className="mt-2 text-xs leading-relaxed text-muted-foreground">{line}</p>
              ))}
            </div>
          )}
        </div>
        {party && (isAdmin || isSeller || isBuyer) && (
          <div className="glass p-6">
            <p className="eyebrow">Settlement</p>
            <dl className="mt-4 space-y-3 text-sm">
              {(isAdmin || isBuyer) && deposit && closing.depositCents != null && (
                <div>
                  <WireRow label="Buyer deposit received" expected={closing.depositCents} recorded={closing.depositReceivedCents ?? null} at={closing.depositReceivedAt} reference={closing.depositReference} check={deposit} />
                  {closing.depositDueAt && closing.depositReceivedCents == null && (
                    <p className={`text-xs ${depositLate ? "text-bad" : "text-muted-foreground"}`}>Due {prettyDate(closing.depositDueAt)}{depositLate ? " · late" : ""}</p>
                  )}
                </div>
              )}
              {(isAdmin || isBuyer) && (
                <WireRow label="Buyer funds received" expected={balanceDue} expectedLabel={closing.depositReceivedCents != null ? "Balance after deposit" : "Expected"} recorded={closing.fundsReceivedCents} at={closing.fundsReceivedAt} reference={closing.fundsReference} check={funds} />
              )}
              {(isAdmin || isSeller) && (
                <WireRow label="Seller proceeds sent" expected={sellerNet} recorded={closing.proceedsSentCents} at={closing.proceedsSentAt} reference={closing.proceedsReference} check={proceeds} />
              )}
            </dl>
            <a className="mt-4 inline-block text-[13px] font-medium text-link" href={`/api/closings/${closing.id}/statement`}>Settlement statement (PDF)</a>
            {runs && closing.status !== "CANCELED" && (
              <div className="mt-5 space-y-5 border-t border-border pt-4">
                {closing.depositCents != null && (
                  <SettlementForm closingId={closing.id} side="deposit" title="Record buyer deposit" amount={closing.depositReceivedCents ?? closing.depositCents} at={closing.depositReceivedAt} reference={closing.depositReference} />
                )}
                <SettlementForm closingId={closing.id} side="funds" title="Record buyer funds" amount={closing.fundsReceivedCents ?? balanceDue} at={closing.fundsReceivedAt} reference={closing.fundsReference} />
                <SettlementForm closingId={closing.id} side="proceeds" title="Record seller proceeds" amount={closing.proceedsSentCents ?? sellerNet} at={closing.proceedsSentAt} reference={closing.proceedsReference} gate={proceedsGate(closing, closing.funders, closing.steps)} payout={{ accounts: payoutChoices, chosen: closing.payoutAccountId }} />
              </div>
            )}
          </div>
        )}
        {/* The proration, the seller's payout account checked by call-back, and the fee invoices. components/finance-panels.tsx. */}
        {party && (isAdmin || isSeller || isBuyer) && <ProrationPanel closing={closing} loans={closingLoans(closing, closing.listing.notes).map((note) => ({ ...note, upb: Number(note.upb), interestRate: Number(note.interestRate) }))} runs={runs} />}
        {party && <PayoutPanel closing={closing} sellerId={closing.listing.sellerId} viewer={user} isSeller={isSeller} />}
        {party && (isAdmin || isSeller || isBuyer) && <InvoicePanel closing={closing} viewer={user} sellerId={closing.listing.sellerId} buyerId={inquiry?.buyerId ?? null} />}
        {/* The deposit's outcome and its four-eyes decision, and the backup bids behind the winner. */}
        {(isAdmin || (party && isBuyer)) && <DepositPanel closing={closing} viewer={user} />}
        {isAdmin && <BackupPanel closing={closing} viewer={user} />}
        {runs && closing.status === "OPEN" && (
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
          {isAdmin && pendingWires.length > 0 && (
            <div id="wires" className="mt-4 scroll-mt-6 space-y-3 rounded-lg border border-warn/40 bg-warn/5 p-3">
              <p className="text-[13px] font-medium text-foreground">Wire change waiting for approval</p>
              {pendingWires.map((change) => (
                <div key={change.id} className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Proposed by {change.proposedBy} on {prettyDate(change.createdAt)}{change.reason ? ` · ${change.reason.replace(/[.\s]+$/, "")}` : ""}. The instructions on file stand until a second desk member approves.
                  </p>
                  <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground/85">{change.instructions || "No instructions. Approving clears them."}</pre>
                  {deskCan(user, "approveWires") ? (
                    <div className="flex flex-wrap gap-2">
                      {change.proposedById !== user.id && (
                        <form action={decideWires}>
                          <input type="hidden" name="closingId" value={closing.id} />
                          <input type="hidden" name="changeId" value={change.id} />
                          <input type="hidden" name="decision" value="APPROVED" />
                          <ConfirmSubmit
                            title="Approve these wire instructions?"
                            consequence="They replace the instructions on file now. The buyer, every group funder and the seller are emailed that the instructions changed and told to confirm them by phone before sending money."
                            confirmLabel="Approve and notify both sides"
                            pendingLabel="Approving…"
                            className="h-9 text-[13px] font-medium"
                          >
                            Approve
                          </ConfirmSubmit>
                        </form>
                      )}
                      <form action={decideWires}>
                        <input type="hidden" name="closingId" value={closing.id} />
                        <input type="hidden" name="changeId" value={change.id} />
                        <input type="hidden" name="decision" value="REJECTED" />
                        <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">{change.proposedById === user.id ? "Withdraw" : "Reject"}</SubmitButton>
                      </form>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">A desk member who approves wires decides it.</p>
                  )}
                  {change.proposedById === user.id && <p className="text-xs text-muted-foreground">You proposed this, so someone else approves it.</p>}
                </div>
              ))}
            </div>
          )}
          {runs && closing.status === "OPEN" ? (
            <form action={saveWireInstructions} className="mt-4 space-y-3">
              <input type="hidden" name="closingId" value={closing.id} />
              <label className="block text-[13px] text-muted-foreground">
                Wire instructions both sides will see
                <Textarea name="wireInstructions" defaultValue={closing.wireInstructions} className="mt-1 min-h-36 bg-card" />
              </label>
              <label className="block text-[13px] text-muted-foreground">
                Why they are changing (optional)
                <input name="reason" maxLength={300} className="desk-input mt-1" />
              </label>
              <label className="block text-[13px] text-muted-foreground">
                Provider reference (optional)
                <input name="providerRef" defaultValue={closing.providerRef} className="desk-input mt-1" />
              </label>
              {/* Changed wire instructions are how wire fraud starts, so a change waits for a second desk member. */}
              <ConfirmSubmit
                title="Propose these wire instructions?"
                consequence="Nothing changes yet. Another desk member who approves wires has to approve them. Then the buyer, every group funder and the seller are emailed that the instructions changed and told to confirm them by phone before sending money."
                confirmLabel="Send for approval"
                pendingLabel="Saving…"
                className="h-9 text-[13px] font-medium"
              >
                Save wires
              </ConfirmSubmit>
            </form>
          ) : party ? (
            <pre className="mt-4 whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground/85">{closing.wireInstructions || "The desk has not issued wire instructions."}</pre>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Wire instructions go to the buyer and the seller only.</p>
          )}
        </div>
        {canWalkAway && closing.diligenceEndsAt && (
          <form action={walkAway} className="glass space-y-3 p-6">
            <input type="hidden" name="closingId" value={closing.id} />
            <p className="eyebrow">Walk away in diligence</p>
            {/* Counsel: confirm "returned per the purchase terms" matches the deposit and refund language in the purchase agreement. */}
            <p className="text-sm text-muted-foreground">
              Until {prettyDate(closing.diligenceEndsAt)} you can walk away for something you found in the file. The closing is canceled, the note goes back on the book, and the seller and the desk are told. Money already wired is returned per the purchase terms.
            </p>
            <label className="block text-[13px] text-muted-foreground">
              What you found, in a sentence. The seller reads this.
              <Textarea name="reason" className="mt-1 min-h-20 bg-card" required minLength={10} />
            </label>
            <ConfirmSubmit
              title={`Walk away from ${money(closing.salePrice)} on ${closing.listing.title}?`}
              consequence="The closing is canceled for both sides and the note goes back on the book. It can't be reopened, and you'd need to bid again to buy it. Money already wired is returned per the purchase terms."
              typed={[["Reason the seller will read", "reason", "text"]]}
              confirmLabel="Walk away"
              pendingLabel="Canceling…"
              tone="danger"
              className="h-9 text-[13px] font-medium"
            >
              Walk away
            </ConfirmSubmit>
          </form>
        )}
        {inDiligence && !isAdmin && isBuyer && closing.funders.length > 1 && (
          <p className="glass p-6 text-sm text-muted-foreground">The diligence window runs until {prettyDate(closing.diligenceEndsAt)}. A group closing is ended by the desk, so every seat is heard. Write the desk on the closing thread.</p>
        )}
        {runs && closing.status === "OPEN" && (
          <KickoutForm
            closing={{ ...closing, salePrice: Number(closing.salePrice) }}
            loans={closingLoans(closing, closing.listing.notes).map((note) => ({ ...note, askingPrice: Number(note.askingPrice) }))}
            loanPrices={inquiry?.loanPrices ?? null}
            grouped={closing.funders.length > 0}
          />
        )}
        {runs && closing.status === "OPEN" && (
          <form action={cancelClosing} className="glass space-y-3 p-6">
            <input type="hidden" name="closingId" value={closing.id} />
            <p className="eyebrow">Cancel this closing</p>
            <p className="text-sm text-muted-foreground">The deal ends and the note goes back on the book. It cannot be reopened, and the buyer would need to send a new offer. Money already wired has to be returned outside the app.</p>
            <label className="block text-[13px] text-muted-foreground">
              Why, in a sentence. Both sides see this.
              <Textarea name="reason" className="mt-1 min-h-20 bg-card" required minLength={3} />
            </label>
            {/* The values read as words, since the confirmation repeats them. */}
            <fieldset className="space-y-2">
              <legend className="text-[13px] text-muted-foreground">Whose failure ended it</legend>
              {!closing.deskBidId && inquiry && (
                <label className="flex items-start gap-2 text-sm text-foreground">
                  <input type="radio" name="fault" value="Buyer" required className="mt-1" />
                  <span>The buyer didn&apos;t close<span className="block text-xs text-muted-foreground">Records a strike on the buyer file.</span></span>
                </label>
              )}
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="radio" name="fault" value="Seller" required className="mt-1" />
                <span>The seller didn&apos;t deliver</span>
              </label>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="radio" name="fault" value="Neither" required className="mt-1" />
                <span>Neither side<span className="block text-xs text-muted-foreground">Such as a title defect or both sides agreeing to part.</span></span>
              </label>
            </fieldset>
            <ConfirmSubmit
              title={`Cancel the closing on ${closing.listing.title}?`}
              consequence={`The deal ends for both sides and the note goes back on the book. It can't be reopened, and any money already wired has to be returned outside the app. If the buyer is at fault, a strike goes on their buyer file, and at ${strikeLimitOf(settings.strikeLimit)} strikes their new bids pause until the desk clears one.`}
              typed={[["Reason both sides will see", "reason", "text"], ["Whose failure", "fault", "text"]]}
              confirmLabel="Cancel the closing"
              pendingLabel="Canceling…"
              tone="danger"
              className="h-9 text-[13px] font-medium"
            >
              Cancel closing
            </ConfirmSubmit>
          </form>
        )}
      </aside>
    </div>
  );
}

// The step due next shows its forms; any other step keeps them behind one tap.
function StepForms({ open, label, children }: { open: boolean; label: string; children: React.ReactNode }) {
  if (open) return <>{children}</>;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[13px] font-medium text-link">{label}</summary>
      {children}
    </details>
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

function WireRow({ label, expected, expectedLabel = "Expected", recorded, at, reference, check }: { label: string; expected: number; expectedLabel?: string; recorded: number | null; at: Date | null; reference: string | null; check: Variance }) {
  const note = varianceNote(check);
  return (
    <div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="text-foreground">{recorded == null ? "Not recorded" : money(recorded / 100, 2)}</dd>
      </div>
      <p className={`text-xs ${check.state === "short" || check.state === "over" ? "text-bad" : "text-muted-foreground"}`}>
        {expectedLabel} {money(expected / 100, 2)}
        {note ? ` · ${note}` : ""}
        {at ? ` · ${prettyDate(at)}` : ""}
        {reference ? ` · ${reference}` : ""}
      </p>
    </div>
  );
}

// A money step whose wire isn't on record takes a typed reason before the desk can mark it. The reason is audited.
function StepGate({ gate, label }: { gate: string | null; label: string }) {
  if (!gate) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-bad">{gate} Record the wire first, or say why the desk is going ahead without it.</p>
      <input name="override" placeholder="Reason to go ahead anyway" aria-label={`Reason to mark ${label.toLowerCase()} complete without the wire`} className="desk-input" minLength={3} />
    </div>
  );
}

// The seller's proceeds wait on the buyer's money and the note. Paying early takes a typed reason, which is audited.
// Proceeds name the seller's verified payout account; with none there is nothing to pay to.
function SettlementForm({ closingId, side, title, amount, at, reference, gate = null, payout }: { closingId: string; side: "funds" | "proceeds" | "deposit"; title: string; amount: number; at: Date | null; reference: string | null; gate?: string | null; payout?: { accounts: { id: string; label: string }[]; chosen: string | null } }) {
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
      {payout && (payout.accounts.length ? (
        <select name="payoutAccountId" required defaultValue={payout.accounts.some((account) => account.id === payout.chosen) ? payout.chosen ?? "" : payout.accounts[0].id} aria-label="Seller payout account" className="desk-input">
          {payout.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
        </select>
      ) : (
        <p className="text-xs text-bad">The seller has no payout account verified by call-back, so proceeds can&apos;t be recorded yet. See Payout account.</p>
      ))}
      {gate && (
        <div className="space-y-2">
          <p className="text-xs text-bad">{gate} Record those before paying the seller, or say why the desk is going ahead without them.</p>
          <input name="override" placeholder="Reason to pay the seller now" aria-label="Reason to record seller proceeds before the buyer's funds and the collateral" className="desk-input" minLength={3} />
        </div>
      )}
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
