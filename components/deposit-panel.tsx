import { decideDeposit, proposeDeposit } from "@/actions/deposits";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { depositState, depositStatusLabel } from "@/lib/deposits";
import { deskCan, type Staff } from "@/lib/desk-roles";
import { money, prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

type DepositClosing = {
  id: string;
  status: string;
  cancelFault: string | null;
  cancelReason: string | null;
  canceledAt: Date | null;
  diligenceEndsAt: Date | null;
  depositCents: number | null;
  depositReceivedCents: number | null;
  depositStatus: string | null;
  depositProposal: string | null;
  depositProposedById: string | null;
  depositProposedAt: Date | null;
  depositResolvedById: string | null;
  depositResolvedAt: Date | null;
  depositNote: string | null;
  depositRefundReference: string | null;
};

// The deposit on the closing page, for the desk and the buyer side: what it is, what the rules say becomes of it,
// and, on a canceled deal, the refund or forfeit one desk member proposes and a different one approves.
export async function DepositPanel({ closing, viewer }: { closing: DepositClosing; viewer: Staff & { id: string } }) {
  if (closing.depositCents == null && closing.depositReceivedCents == null) return null;
  const desk = viewer.role === "ADMIN";
  const approves = deskCan(viewer, "approveWires");
  const { status, suggested } = depositState(closing);
  const received = closing.depositReceivedCents ?? 0;
  const amount = money(received / 100, 2);
  const pending = closing.depositProposal && !closing.depositResolvedAt ? closing.depositProposal : null;
  const decided = status === "REFUNDED" || status === "FORFEITED";
  const names = desk
    ? new Map(
        (await prisma.user.findMany({ where: { id: { in: [closing.depositProposedById, closing.depositResolvedById].filter((id): id is string => Boolean(id)) } }, select: { id: true, name: true } })).map((person) => [person.id, person.name]),
      )
    : new Map<string, string>();
  const proposer = closing.depositProposedById ? names.get(closing.depositProposedById) ?? "A desk member" : "A desk member";
  const word = pending === "FORFEITED" ? "keep the deposit" : "refund the deposit";
  return (
    <section id="deposit" aria-labelledby="deposit-heading" className="glass scroll-mt-6 p-6">
      <p id="deposit-heading" className="eyebrow">Deposit</p>
      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Received</dt>
          <dd className="text-foreground">{closing.depositReceivedCents == null ? "Not recorded" : amount}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Outcome</dt>
          <dd className="text-right text-foreground">{status ? depositStatusLabel(status) : "Nothing received yet"}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {closing.status === "OPEN"
          ? "It goes toward the price at close. If the deal fails on the seller, on neither side or inside diligence, it comes back. If the buyer fails to close after diligence, it may be kept."
          : status === "APPLIED"
            ? "It went toward the price."
            : status === "REFUND_DUE"
              ? "The deal didn't fail on the buyer's side after diligence, so the deposit is owed back."
              : status === "HELD" && suggested === "FORFEITED"
                ? "The buyer failed to close after the diligence window, so the purchase terms allow keeping it. Two desk members decide."
                : status === "REFUNDED"
                  ? `Refunded ${prettyDate(closing.depositResolvedAt)}${closing.depositRefundReference ? ` · reference ${closing.depositRefundReference}` : ""}.`
                  : status === "FORFEITED"
                    ? `Kept under the purchase terms ${prettyDate(closing.depositResolvedAt)}.`
                    : "No deposit was received, so there is nothing to return or keep."}
      </p>
      {desk && decided && closing.depositResolvedById && (
        <p className="mt-2 text-xs text-muted-foreground">
          Proposed by {proposer}, approved by {names.get(closing.depositResolvedById) ?? "a desk member"}.{closing.depositNote ? ` ${closing.depositNote}` : ""}
        </p>
      )}
      {desk && pending && (
        <div className="mt-4 space-y-3 rounded-lg border border-warn/40 bg-warn/5 p-3">
          <p className="text-[13px] font-medium text-foreground">Waiting for a second desk member</p>
          <p className="text-xs text-muted-foreground">
            {proposer} proposed to {word} of {amount} on {prettyDate(closing.depositProposedAt)}. {closing.depositNote}
          </p>
          {approves ? (
            <div className="space-y-2">
              {closing.depositProposedById !== viewer.id && (
                <form action={decideDeposit} className="space-y-2">
                  <input type="hidden" name="closingId" value={closing.id} />
                  <input type="hidden" name="decision" value="APPROVED" />
                  {pending === "REFUNDED" && <input name="reference" required minLength={3} maxLength={120} placeholder="Refund wire reference" aria-label="Refund wire reference" className="desk-input" />}
                  <ConfirmSubmit
                    title={pending === "REFUNDED" ? `Approve the ${amount} refund?` : `Keep the ${amount} deposit?`}
                    consequence={pending === "REFUNDED" ? "It records the refund as sent, with this reference. The buyer is told. Send the wire outside the app first." : "It records the deposit as kept under the purchase terms. The buyer is told. It can't be undone here."}
                    typed={pending === "REFUNDED" ? [["Refund wire reference", "reference", "text"]] : undefined}
                    confirmLabel={pending === "REFUNDED" ? "Approve the refund" : "Approve the forfeit"}
                    pendingLabel="Approving…"
                    className="h-9 text-[13px] font-medium"
                  >
                    Approve
                  </ConfirmSubmit>
                </form>
              )}
              <form action={decideDeposit}>
                <input type="hidden" name="closingId" value={closing.id} />
                <input type="hidden" name="decision" value="REJECTED" />
                <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">{closing.depositProposedById === viewer.id ? "Withdraw" : "Reject"}</SubmitButton>
              </form>
              {closing.depositProposedById === viewer.id && <p className="text-xs text-muted-foreground">You proposed this, so someone else approves it.</p>}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">A desk member who approves wires decides it.</p>
          )}
        </div>
      )}
      {desk && approves && closing.status === "CANCELED" && !pending && !decided && received > 0 && (
        <form action={proposeDeposit} className="mt-4 space-y-3 border-t border-border pt-4">
          <input type="hidden" name="closingId" value={closing.id} />
          <fieldset className="space-y-2">
            <legend className="text-[13px] text-muted-foreground">Propose</legend>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="radio" name="outcome" value="REFUNDED" required defaultChecked={suggested !== "FORFEITED"} className="mt-1" />
              <span>Refund it to the buyer</span>
            </label>
            {suggested === "FORFEITED" && (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="radio" name="outcome" value="FORFEITED" required defaultChecked className="mt-1" />
                <span>Keep it under the purchase terms<span className="block text-xs text-muted-foreground">The buyer failed to close after diligence.</span></span>
              </label>
            )}
          </fieldset>
          <label className="block text-[13px] text-muted-foreground">
            Why, in a sentence. The second desk member reads it.
            <Textarea name="note" className="mt-1 min-h-20 bg-card" required minLength={10} maxLength={500} />
          </label>
          <ConfirmSubmit
            title={`Propose a decision on the ${amount} deposit?`}
            consequence="Nothing moves yet. Another desk member who approves wires has to approve it. The buyer is told it's proposed."
            confirmLabel="Send for approval"
            pendingLabel="Saving…"
            className="h-9 text-[13px] font-medium"
          >
            Propose
          </ConfirmSubmit>
        </form>
      )}
    </section>
  );
}
