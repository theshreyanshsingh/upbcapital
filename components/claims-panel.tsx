import { saveCloseAttestation } from "@/actions/attestations";
import {
  acceptClaimCure,
  addRepurchaseClaimFiles,
  answerRepurchaseClaim,
  confirmClaimSettled,
  decideRepurchaseClaim,
  fileRepurchaseClaim,
  sendClaimToDesk,
  saveClaimSettings,
  withdrawRepurchaseClaim,
} from "@/actions/claims";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  ANSWER_LABELS,
  CLAIM_REMEDIES,
  CLAIM_REPS,
  MAX_CLAIM_FILES,
  OPEN_STATUSES,
  REMEDY_LABELS,
  REP_TEXT,
  answerProblem,
  claimWindowEnd,
  claimsOnClosing,
  decisionStatement,
  filingProblem,
  isDecision,
  isRemedy,
  isRep,
  loanLabel,
  loanPriceCents,
  responseDaysOf,
  statusLabel,
  survivalDaysOf,
  DESK_PARTY_TEXT,
  DEFAULT_RESPONSE_DAYS,
  DEFAULT_SURVIVAL_DAYS,
  RESPONSE_DAY_BOUNDS,
  SURVIVAL_DAY_BOUNDS,
  deskPartyOn,
  type ClosingClaim,
} from "@/lib/claims";
import { closingLoans } from "@/lib/closing";
import { deskCan, type Staff } from "@/lib/desk-roles";
import { money, prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { ATTESTATION_QUESTIONS, attestationEditableUntil, attestationSide, type AttestationSide } from "@/lib/track-record";

// After a confirmed close: each side's short factual answers, and repurchase claims against the seller's
// representations with the seller's answer, the desk's decision, the files and the timeline. lib/claims.ts and
// lib/track-record.ts hold the rules. Only the closing's parties and the desk reach this panel.

type PanelClosing = {
  id: string;
  status: string;
  closedAt: Date | null;
  deskBidId: string | null;
  noteId: string | null;
  noteIds: string[];
  salePrice: number;
  buyerPremiumCents: number;
  listing: { title: string; sellerId: string; notes: { id: string; streetAddress: string; city: string; state: string; upb: number }[] };
  funders: { userId: string }[];
};

type Viewer = Staff & { id: string };

const OPEN: readonly string[] = OPEN_STATUSES;
const SETTLEABLE = ["ANSWERED", "UNDER_REVIEW", "UPHELD", "PARTLY_UPHELD"];
const DECISION_WORDS = ["Upheld", "Partly upheld", "Denied", "Cured", "Settled"];

export async function ClaimsPanel({ closing, viewer, leadBuyerId, loanPrices }: { closing: PanelClosing; viewer: Viewer; leadBuyerId: string | null; loanPrices?: unknown }) {
  const buyerIds = [...new Set([leadBuyerId, ...closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id)))];
  const sellerId = closing.listing.sellerId;
  const claims = await claimsOnClosing(closing.id, viewer, { sellerId, buyerIds });
  if (closing.status !== "COMPLETE" && !claims.length) return null;
  const settings = await getSettings();
  const survivalDays = survivalDaysOf(settings.repSurvivalDays);
  const now = new Date();
  const canFile = !filingProblem({ closing, userId: viewer.id, buyerIds, survivalDays, now, deskBook: viewer.role === "ADMIN" && deskCan(viewer, "deskBook") });
  const partyIds = [...buyerIds, sellerId];
  // Where UPB is a party, no desk member decides; the panel says where a dispute goes instead.
  const deskParty = await deskPartyOn(closing, partyIds);
  const decides = deskCan(viewer, "compliance") && !partyIds.includes(viewer.id) && !deskParty;
  const loans = closingLoans(closing, closing.listing.notes);
  const loanOf = new Map(loans.map((note) => [note.id, note]));
  const side = attestationSide({ deskBidId: closing.deskBidId, sellerId, leadBuyerId }, viewer.id);
  const desk = viewer.role === "ADMIN";
  const attestations = side || desk ? await prisma.closeAttestation.findMany({ where: { closingId: closing.id } }) : [];
  const windowEnd = closing.closedAt ? claimWindowEnd(closing.closedAt, survivalDays) : null;
  const priceOf = (noteId: string) =>
    loanPriceCents({ salePrice: Number(closing.salePrice), buyerPremiumCents: closing.buyerPremiumCents, loans: loans.map((note) => ({ id: note.id, upb: Number(note.upb) })), loanPrices, noteId });
  return (
    <section id="after-closing" aria-labelledby="after-closing-heading" className="mt-6 scroll-mt-6 glass p-6">
      <p id="after-closing-heading" className="eyebrow">After closing</p>
      <p className="mt-2 text-sm text-muted-foreground">Short factual answers from each side, and any claim that a seller representation proved untrue. UPB moves no money on a claim.</p>
      {closing.status === "COMPLETE" && !closing.deskBidId && (side || desk) && (
        <Attestations closingId={closing.id} side={side} rows={attestations} viewerId={viewer.id} now={now} />
      )}
      <div id="claims" className="mt-6 scroll-mt-6 border-t border-border pt-5">
        <p className="text-[13px] font-semibold text-foreground">Repurchase claims</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {windowEnd
            ? `The buyer can file a claim on the seller's representations until ${prettyDate(windowEnd)}, ${survivalDays} days after closing. The seller has ${responseDaysOf(settings.claimResponseDays)} days to answer. Other bidders never see a claim.`
            : "Claims open once the closing has closed."}
        </p>
        {deskParty && <p className="mt-2 border border-link/30 bg-link/5 px-3 py-2 text-sm text-foreground rounded-lg">{DESK_PARTY_TEXT}</p>}
        {claims.length > 0 && (
          <ul className="mt-4 divide-y divide-border">
            {claims.map((claim) => (
              <ClaimItem key={claim.id} claim={claim} viewer={viewer} decides={decides} deskParty={deskParty} loan={claim.noteId ? loanOf.get(claim.noteId) : undefined} now={now} />
            ))}
          </ul>
        )}
        {canFile && <FileClaimForm closing={closing} loans={loans} priceOf={priceOf} deskParty={deskParty} />}
      </div>
    </section>
  );
}

type AttestationRow = { side: string; byId: string; createdAt: Date; fundedOnTime: boolean | null; fileAsDescribed: boolean | null; collateralComplete: boolean | null; note: string };

const word = (value: boolean | null | undefined) => (value == null ? "not answered" : value ? "yes" : "no");

function Attestations({ closingId, side, rows, viewerId, now }: { closingId: string; side: AttestationSide | null; rows: AttestationRow[]; viewerId: string; now: Date }) {
  // Each side sees its own answers. The desk sees both, and the record counts them.
  if (!side) {
    return (
      <div className="mt-5 space-y-3">
        {(["BUYER", "SELLER"] as const).map((key) => {
          const row = rows.find((item) => item.side === key);
          return (
            <div key={key} className="text-sm">
              <p className="text-[13px] font-medium text-foreground">{key === "BUYER" ? "The buyer's answers" : "The seller's answer"}</p>
              {row ? (
                <p className="text-muted-foreground">
                  {ATTESTATION_QUESTIONS[key].map((question) => `${question.text}: ${word(row[question.field])}`).join(" · ")}
                  {row.note ? ` · ${row.note}` : ""} · {prettyDate(row.createdAt)}
                </p>
              ) : (
                <p className="text-muted-foreground">Not answered yet.</p>
              )}
            </div>
          );
        })}
      </div>
    );
  }
  const row = rows.find((item) => item.side === side);
  const until = row ? attestationEditableUntil(row.createdAt) : null;
  const locked = Boolean(row && (row.byId !== viewerId || (until && until.getTime() < now.getTime())));
  const questions = ATTESTATION_QUESTIONS[side];
  if (row && locked) {
    return (
      <div className="mt-5 text-sm">
        <p className="text-[13px] font-medium text-foreground">Your answers</p>
        <p className="mt-1 text-muted-foreground">
          {questions.map((question) => `${question.text}: ${word(row[question.field])}`).join(" · ")}
          {row.note ? ` · ${row.note}` : ""}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Given {prettyDate(row.createdAt)}. They count in the factual record on UPB.</p>
      </div>
    );
  }
  return (
    <form action={saveCloseAttestation} className="mt-5 space-y-4">
      <input type="hidden" name="closingId" value={closingId} />
      <div>
        <p className="text-[13px] font-medium text-foreground">{questions.length === 1 ? "One question" : "Two questions"} on how it went</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Yes or no, with a note if you like. The answers count in the factual record on UPB, never as a rating.{" "}
          {row && until ? `You can change them until ${prettyDate(until)}.` : `You can change them for 30 days after you answer.`}
        </p>
      </div>
      {questions.map((question) => {
        const current = row?.[question.field];
        return (
          <fieldset key={question.field} className="space-y-2">
            <legend className="text-sm text-foreground">{question.text}</legend>
            <div className="flex gap-5">
              {(["yes", "no"] as const).map((answer) => (
                <label key={answer} className="flex items-center gap-2 text-sm text-foreground">
                  <input type="radio" name={question.field} value={answer} required defaultChecked={current != null && current === (answer === "yes")} />
                  {answer === "yes" ? "Yes" : "No"}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
      <label className="block text-[13px] text-muted-foreground">
        A note, if you like
        <input name="note" maxLength={500} defaultValue={row?.note ?? ""} className="desk-input mt-1 w-full" />
      </label>
      <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">
        {row ? "Update your answers" : "Save your answers"}
      </SubmitButton>
    </form>
  );
}

function ClaimItem({ claim, viewer, decides, deskParty, loan, now }: { claim: ClosingClaim; viewer: Viewer; decides: boolean; deskParty: boolean; loan?: { streetAddress: string; city: string; state: string }; now: Date }) {
  const isClaimant = viewer.id === claim.filedById;
  const isSeller = viewer.id === claim.sellerId;
  const party = isClaimant || isSeller;
  const rep = isRep(claim.rep) ? REP_TEXT[claim.rep].label : claim.rep;
  const remedy = isRemedy(claim.remedy) ? REMEDY_LABELS[claim.remedy] : claim.remedy;
  const open = OPEN.includes(claim.status);
  const waitingOnDesk = claim.status === "ANSWERED" || claim.status === "UNDER_REVIEW" || (claim.status === "FILED" && claim.respondBy.getTime() <= now.getTime());
  const ownConfirm = isClaimant ? claim.confirmedBy.buyer : isSeller ? claim.confirmedBy.seller : false;
  const otherConfirm = isClaimant ? claim.confirmedBy.seller : claim.confirmedBy.buyer;
  return (
    <li id={`claim-${claim.id}`} className="scroll-mt-6 py-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-foreground">{rep} · {loanLabel(loan)}</p>
        <p className="text-[13px] font-medium text-link">{statusLabel(claim.status, deskParty)}</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        Filed {prettyDate(claim.createdAt)} · asks for {remedy.toLowerCase()}
        {claim.amountCents != null && claim.remedy !== "CURE" ? ` · ${money(claim.amountCents / 100, 2)}` : ""}
        {claim.status === "FILED" ? ` · the seller answers by ${prettyDate(claim.respondBy)}` : ""}
      </p>
      {claim.remedy === "REPURCHASE" && (
        <p className="mt-1 text-xs text-muted-foreground">That figure is the loan&apos;s price and its share of the buyer premium. The agreement adds the buyer&apos;s documented costs and takes off principal collected since closing.</p>
      )}
      <p className="mt-2 whitespace-pre-line text-foreground">{claim.description}</p>
      {claim.answer && (
        <div className="mt-3">
          <p className="text-[13px] font-medium text-foreground">The seller: {ANSWER_LABELS[claim.answer.kind].toLowerCase()}{claim.sellerRespondedAt ? `, ${prettyDate(claim.sellerRespondedAt)}` : ""}</p>
          {claim.answer.text && <p className="mt-1 whitespace-pre-line text-muted-foreground">{claim.answer.text}</p>}
        </div>
      )}
      {claim.decidedAt && isDecision(claim.status) && (
        <div className="mt-3">
          <p className="text-[13px] font-medium text-foreground">The desk&apos;s decision, {prettyDate(claim.decidedAt)}</p>
          <p className="mt-1 text-foreground">{decisionStatement(claim.status, claim.outcomeCents, claim.remedy)}</p>
          {claim.decision && <p className="mt-1 whitespace-pre-line text-muted-foreground">{claim.decision}</p>}
        </div>
      )}
      {claim.status === "SETTLED" && claim.decidedAt == null && (
        <p className="mt-3 text-foreground">Both sides confirmed it is settled{claim.outcomeCents ? `, at ${money(claim.outcomeCents / 100, 2)} as asked` : ""}.</p>
      )}
      {claim.files.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] font-medium">
          {claim.files.map((file) => (
            <li key={file.id}>
              <a className="text-link" href={`/api/claim-files/${file.id}`}>{file.originalName}</a>
              <span className="ml-1 text-xs font-normal text-muted-foreground">{file.uploadedById === claim.filedById ? "buyer" : file.uploadedById === claim.sellerId ? "seller" : "desk"}</span>
            </li>
          ))}
        </ul>
      ) : claim.fileCount > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{claim.fileCount === 1 ? "One file" : `${claim.fileCount} files`}, open to the buyer who filed, the seller and the desk.</p>
      ) : null}
      {claim.timeline.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] font-medium text-link">Timeline</summary>
          <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
            {claim.timeline.map((event, index) => (
              <li key={index}>
                <span className="tabular-nums">{prettyDate(event.at)}</span> · {event.text}
              </li>
            ))}
          </ol>
        </details>
      )}
      {isSeller && !answerProblem(claim, viewer.id) && <AnswerForm claimId={claim.id} respondBy={claim.respondBy} deskParty={deskParty} />}
      {isClaimant && claim.status === "ANSWERED" && claim.answer?.kind === "CURE" && (
        <form action={acceptClaimCure} className="mt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <ConfirmSubmit
            title="Accept the seller's cure?"
            consequence="The claim closes as cured, and the seller owes nothing more under it. If the cure doesn't hold, send it to the desk instead."
            confirmLabel="Accept the cure"
            pendingLabel="Saving…"
            className="h-9 text-[13px] font-medium"
          >
            Accept the cure
          </ConfirmSubmit>
        </form>
      )}
      {party && claim.status === "ANSWERED" && !deskParty && (
        <form action={sendClaimToDesk} className="mt-4 space-y-2">
          <input type="hidden" name="claimId" value={claim.id} />
          <label className="block text-[13px] text-muted-foreground">
            Ask the desk to decide, and say why. Both sides read this.
            <Textarea name="reason" className="mt-1 min-h-16 bg-card" required minLength={10} maxLength={1000} />
          </label>
          <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Sending…">Send to the desk</SubmitButton>
        </form>
      )}
      {party && SETTLEABLE.includes(claim.status) && (
        <form action={confirmClaimSettled} className="mt-4 space-y-2">
          <input type="hidden" name="claimId" value={claim.id} />
          <p className="text-xs text-muted-foreground">
            {ownConfirm
              ? `You confirmed it is settled. ${otherConfirm ? "" : `Waiting on the ${isClaimant ? "seller" : "buyer"} to confirm.`}`
              : otherConfirm
                ? `The ${isClaimant ? "seller" : "buyer"} confirmed it is settled. Confirm once it is, and the claim closes as settled.`
                : "The parties settle between themselves. When both sides confirm here, the claim closes as settled."}
          </p>
          {!ownConfirm && (
            <ConfirmSubmit
              title="Confirm the claim is settled?"
              consequence="Confirm only once what is owed has been paid or done between you. When both sides confirm, the claim closes as settled and can't be reopened."
              confirmLabel="Confirm it is settled"
              pendingLabel="Saving…"
              variant="outline"
              className="h-9 text-[13px] font-medium"
            >
              It is settled
            </ConfirmSubmit>
          )}
        </form>
      )}
      {party && open && (
        <form action={addRepurchaseClaimFiles} className="mt-4 flex flex-wrap items-center gap-3">
          <input type="hidden" name="claimId" value={claim.id} />
          <input name="files" type="file" multiple aria-label="Files to add to the claim" className="text-xs text-muted-foreground" />
          <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Uploading…">Add files</SubmitButton>
        </form>
      )}
      {isClaimant && open && (
        <form action={withdrawRepurchaseClaim} className="mt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <ConfirmSubmit
            title="Withdraw this claim?"
            consequence="The claim closes as withdrawn, and the seller owes nothing under it. A new claim on the same representation can be filed while the window is open."
            confirmLabel="Withdraw the claim"
            pendingLabel="Withdrawing…"
            tone="danger"
            variant="ghost"
            className="h-9 px-0 text-[13px] font-medium"
          >
            Withdraw the claim
          </ConfirmSubmit>
        </form>
      )}
      {viewer.role === "ADMIN" && waitingOnDesk && (decides ? <DecisionForm claim={claim} /> : (
        <p className="mt-4 text-xs text-muted-foreground">
          {deskParty ? "UPB is a party to this deal, so no desk member decides this claim." : "A compliance desk member who isn't a party to this closing decides it."}
        </p>
      ))}
    </li>
  );
}

function AnswerForm({ claimId, respondBy, deskParty }: { claimId: string; respondBy: Date; deskParty: boolean }) {
  return (
    <form action={answerRepurchaseClaim} className="mt-4 space-y-3 border-t border-border pt-4">
      <input type="hidden" name="claimId" value={claimId} />
      <p className="text-[13px] font-medium text-foreground">Your answer, by {prettyDate(respondBy)}</p>
      {/* The values read as words, since the confirmation repeats them. */}
      <fieldset className="space-y-2">
        <legend className="sr-only">Your answer</legend>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="radio" name="kind" value="Accept" required className="mt-1" />
          <span>Accept it<span className="block text-xs text-muted-foreground">You agree the representation was untrue, and the claim goes to the remedy the buyer asked for.</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="radio" name="kind" value="Dispute" required className="mt-1" />
          <span>Dispute it<span className="block text-xs text-muted-foreground">{deskParty ? "Say why, with files. UPB is a party, so the desk doesn't decide it." : "Say why, with files. The desk reviews it and decides."}</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="radio" name="kind" value="Cure" required className="mt-1" />
          <span>Cure it<span className="block text-xs text-muted-foreground">Say how you fixed it. The buyer accepts the cure or sends it to the desk.</span></span>
        </label>
      </fieldset>
      <label className="block text-[13px] text-muted-foreground">
        Your explanation. The buyer and the desk read it.
        <Textarea name="text" className="mt-1 min-h-24 bg-card" maxLength={4000} />
      </label>
      <input name="files" type="file" multiple aria-label="Files for your answer" className="text-xs text-muted-foreground" />
      <ConfirmSubmit
        title="Send your answer?"
        consequence={`The buyer and the desk read it. Accepting agrees you owe the remedy the buyer asked for under the agreement. ${deskParty ? "Disputing records that the two of you don't agree. UPB is a party, so a dispute goes under the master agreements' governing law terms." : "Disputing sends the claim to the desk to decide."} You answer once.`}
        typed={[["Your answer", "kind", "text"]]}
        confirmLabel="Send the answer"
        pendingLabel="Sending…"
        className="h-9 text-[13px] font-medium"
      >
        Send the answer
      </ConfirmSubmit>
    </form>
  );
}

function DecisionForm({ claim }: { claim: ClosingClaim }) {
  return (
    <form action={decideRepurchaseClaim} className="mt-4 space-y-3 border-t border-border pt-4">
      <input type="hidden" name="claimId" value={claim.id} />
      <p className="text-[13px] font-medium text-foreground">The desk&apos;s decision</p>
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
        <legend className="sr-only">Outcome</legend>
        {DECISION_WORDS.map((outcome) => (
          <label key={outcome} className="flex items-center gap-2 text-sm text-foreground">
            <input type="radio" name="outcome" value={outcome} required />
            {outcome}
          </label>
        ))}
      </fieldset>
      <label className="block text-[13px] text-muted-foreground">
        What the seller owes under the agreement, for upheld, partly upheld or settled. 0 where it owes a cure.
        <input
          name="amount"
          inputMode="decimal"
          defaultValue={claim.amountCents != null && claim.remedy !== "CURE" ? (claim.amountCents / 100).toFixed(2) : ""}
          className="desk-input mt-1 w-40 tabular-nums"
        />
      </label>
      <label className="block text-[13px] text-muted-foreground">
        The reason. Both sides read it.
        <Textarea name="reason" className="mt-1 min-h-20 bg-card" required minLength={10} maxLength={2000} />
      </label>
      <ConfirmSubmit
        title="Record the decision?"
        consequence="Both sides are told. The decision says what the seller owes under the agreement, and the parties settle it between themselves. UPB moves no money. It can't be changed once recorded."
        typed={[["Outcome", "outcome", "text"], ["The seller owes", "amount", "money"]]}
        confirmLabel="Record the decision"
        pendingLabel="Saving…"
        className="h-9 text-[13px] font-medium"
      >
        Record the decision
      </ConfirmSubmit>
    </form>
  );
}

function FileClaimForm({ closing, loans, priceOf, deskParty }: { closing: PanelClosing; loans: PanelClosing["listing"]["notes"]; priceOf: (noteId: string) => { priceCents: number; premiumCents: number }; deskParty: boolean }) {
  const single = loans.length === 1 ? loans[0] : null;
  const price = single ? priceOf(single.id) : null;
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-[13px] font-medium text-link">File a repurchase claim</summary>
      <form action={fileRepurchaseClaim} className="mt-4 space-y-4">
        <input type="hidden" name="closingId" value={closing.id} />
        {single ? (
          <input type="hidden" name="noteId" value={single.id} />
        ) : (
          <label className="block text-[13px] text-muted-foreground">
            Which loan
            <select name="noteId" required defaultValue="" className="desk-input mt-1 w-full">
              <option value="" disabled>Choose the loan</option>
              {loans.map((note) => {
                const cents = priceOf(note.id);
                return <option key={note.id} value={note.id}>{loanLabel(note)} · paid {money(cents.priceCents / 100)}</option>;
              })}
            </select>
          </label>
        )}
        <fieldset className="space-y-2">
          <legend className="text-[13px] text-muted-foreground">Which representation proved untrue</legend>
          {CLAIM_REPS.map((rep) => (
            <label key={rep} className="flex items-start gap-2 text-sm text-foreground">
              <input type="radio" name="rep" value={rep} required className="mt-1" />
              <span>{REP_TEXT[rep].label}<span className="block text-xs text-muted-foreground">{REP_TEXT[rep].text}</span></span>
            </label>
          ))}
        </fieldset>
        <label className="block text-[13px] text-muted-foreground">
          What is wrong, and what shows it. The seller and the desk read this.
          <Textarea name="description" className="mt-1 min-h-28 bg-card" required minLength={20} maxLength={4000} />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-[13px] text-muted-foreground">The remedy you ask for</legend>
          {CLAIM_REMEDIES.map((remedy) => (
            <label key={remedy} className="flex items-start gap-2 text-sm text-foreground">
              <input type="radio" name="remedy" value={remedy} required className="mt-1" />
              <span>
                {REMEDY_LABELS[remedy]}
                <span className="block text-xs text-muted-foreground">
                  {remedy === "REPURCHASE"
                    ? price
                      ? `From the closing: ${money(price.priceCents / 100, 2)} for the loan and ${money(price.premiumCents / 100, 2)} of buyer premium. The agreement adds your documented costs and takes off principal collected since closing.`
                      : "The loan's price on the closing and its share of the buyer premium. The agreement adds your documented costs and takes off principal collected since closing."
                    : remedy === "PRICE_ADJUSTMENT"
                      ? "Part of the price back, in the amount below."
                      : "The seller fixes it, such as delivering a missing document, within 30 days."}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="block text-[13px] text-muted-foreground">
          Price adjustment asked for, in dollars
          <input name="amount" inputMode="decimal" className="desk-input mt-1 w-40 tabular-nums" />
        </label>
        <label className="block text-[13px] text-muted-foreground">
          Evidence, up to {MAX_CLAIM_FILES} files. Only you, the seller and the desk can open them.
          <input name="files" type="file" multiple className="mt-1 block text-xs text-muted-foreground" />
        </label>
        <ConfirmSubmit
          title={`File a repurchase claim on ${closing.listing.title}?`}
          consequence={
            deskParty
              ? "The seller and the desk read it and its files. The seller answers by accepting, disputing or curing it. UPB is a party, so the desk doesn't decide it: settle it with the seller, or take a dispute under the master agreements' governing law terms."
              : "The seller and the desk read it and its files. The seller answers by accepting, disputing or curing it, and the desk decides when the two of you don't agree. You can withdraw it until the desk decides."
          }
          typed={[["What is wrong", "description", "text"]]}
          confirmLabel="File the claim"
          pendingLabel="Filing…"
          className="h-9 text-[13px] font-medium"
        >
          File the claim
        </ConfirmSubmit>
      </form>
    </details>
  );
}

// The claim window and the seller's answer time on the fee schedule page. Only an owner changes them.
export function ClaimSettings({ owns, survivalDays, responseDays }: { owns: boolean; survivalDays: number | null; responseDays: number | null }) {
  return (
    <form id="claim-settings" action={saveClaimSettings} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="claim-settings-heading">
      <div>
        <p id="claim-settings-heading" className="eyebrow">Claims</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          How long after closing a buyer may file a repurchase claim on the seller&apos;s representations, and how long the seller has to answer one. The master agreements give {DEFAULT_SURVIVAL_DAYS} days, so keep the window matched to them.
        </p>
        <p className="mt-2 text-sm text-foreground">Now: {survivalDaysOf(survivalDays)} days to file, {responseDaysOf(responseDays)} days to answer.</p>
      </div>
      {/* With no save button for other roles, a lone text field would still submit on Enter, so they read only. */}
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Days after closing to file a claim</span>
        <input name="repSurvivalDays" inputMode="numeric" disabled={!owns} defaultValue={survivalDays ?? ""} placeholder={`${DEFAULT_SURVIVAL_DAYS}, the default`} className="desk-input mt-2 tabular-nums" />
        <span className="mt-1 block text-xs text-muted-foreground">From {SURVIVAL_DAY_BOUNDS[0]} to {SURVIVAL_DAY_BOUNDS[1]}. It counts from each deal&apos;s close, so a change moves the window on deals already closed too. Blank keeps the default.</span>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Days the seller has to answer</span>
        <input name="claimResponseDays" inputMode="numeric" disabled={!owns} defaultValue={responseDays ?? ""} placeholder={`${DEFAULT_RESPONSE_DAYS}, the default`} className="desk-input mt-2 tabular-nums" />
        <span className="mt-1 block text-xs text-muted-foreground">From {RESPONSE_DAY_BOUNDS[0]} to {RESPONSE_DAY_BOUNDS[1]}. A claim already filed keeps its answer date. Blank keeps the default.</span>
      </label>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save claims</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the claim window.</p>}
    </form>
  );
}
