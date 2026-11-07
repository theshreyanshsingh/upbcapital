import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { DEPOSIT_OUTCOME_LABELS } from "@/lib/settlement";

// What becomes of the buyer's deposit when a deal ends. A completed sale applies it to the price. A cancel that wasn't
// the buyer's doing owes it back, and so does a buyer's failure inside the diligence window, where walking away was
// their right. A buyer who fails to close after diligence forfeits it. A refund or a forfeit moves money, so one desk
// member who approves wires proposes it with a note and a different one approves it, as with a wire change
// (lib/wire-changes.ts). Until then the deposit stands as it is.

// Counsel: who keeps a forfeited deposit, and whether a refund is owed in full on a seller's failure, are for the
// deposit language in the purchase agreement. The desk records the outcome; the wire goes outside the app.

export const DEPOSIT_STATUSES = ["HELD", "APPLIED", "REFUND_DUE", "REFUNDED", "FORFEITED"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

// What the desk can propose for a canceled deal's deposit.
export const DEPOSIT_PROPOSALS = ["REFUNDED", "FORFEITED"] as const;
export type DepositProposal = (typeof DEPOSIT_PROPOSALS)[number];

export function isDepositProposal(value: unknown): value is DepositProposal {
  return typeof value === "string" && (DEPOSIT_PROPOSALS as readonly string[]).includes(value);
}

export function depositStatusLabel(status: string | null | undefined) {
  return (status && DEPOSIT_OUTCOME_LABELS[status]) || "No deposit recorded";
}

type DepositClosing = {
  status: string;
  cancelFault?: string | null;
  cancelReason?: string | null;
  canceledAt?: Date | null;
  diligenceEndsAt?: Date | null;
  depositReceivedCents?: number | null;
};

// lib/closing-service.ts walkAwayFromClosing writes this at the start of the cancel reason.
const WALK_AWAY = "The buyer walked away in diligence";

// A cancel inside the diligence window: the buyer's walk-away, or a desk cancel that landed before the window closed.
export function withinDiligence(closing: Pick<DepositClosing, "cancelReason" | "canceledAt" | "diligenceEndsAt">) {
  if (closing.cancelReason?.startsWith(WALK_AWAY)) return true;
  return Boolean(closing.canceledAt && closing.diligenceEndsAt && closing.canceledAt.getTime() < closing.diligenceEndsAt.getTime());
}

// The outcome the rules give. Null when no deposit was received, since there is nothing to apply, return or keep. An
// open deal holds it. A cancel recorded before faults were kept is read as owing it back, since a forfeit needs the
// buyer's failure on record.
export function depositOutcome(closing: DepositClosing): "HELD" | "APPLIED" | "REFUND_DUE" | "FORFEITED" | null {
  if (closing.depositReceivedCents == null || closing.depositReceivedCents <= 0) return null;
  if (closing.status === "COMPLETE") return "APPLIED";
  if (closing.status !== "CANCELED") return "HELD";
  if (closing.cancelFault === "BUYER" && !withinDiligence(closing)) return "FORFEITED";
  return "REFUND_DUE";
}

// What is stored when the deal ends. A forfeit is only proposed by the rules, so the deposit stays held until two
// desk members agree to it.
export function endingStatus(outcome: ReturnType<typeof depositOutcome>): DepositStatus | null {
  if (!outcome) return null;
  return outcome === "FORFEITED" ? "HELD" : outcome;
}

// The status a closing shows: the one stored, or the rules' reading for a deal that ended before it was kept.
export function depositState(closing: DepositClosing & { depositStatus?: string | null }) {
  const outcome = depositOutcome(closing);
  return { status: (closing.depositStatus as DepositStatus | null | undefined) ?? endingStatus(outcome), suggested: outcome };
}

// Written when a closing completes or cancels. A refund or forfeit already decided is never overwritten. It runs after
// the close or cancel has landed, so a failure here is logged and leaves the deal as it is; the page reads the
// outcome from the rules until it is stored.
export async function recordDepositOutcome(closingId: string) {
  try {
    return await writeDepositOutcome(closingId);
  } catch (error) {
    console.error(`[upb-deposits] the deposit outcome for closing ${closingId} was not saved:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function writeDepositOutcome(closingId: string) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId } });
  if (!closing) return null;
  const outcome = depositOutcome(closing);
  const status = endingStatus(outcome);
  if (!status) return null;
  const wrote = await prisma.closing.updateMany({
    where: { id: closingId, OR: [...unset("depositStatus").OR, { depositStatus: "HELD" }] },
    data: { depositStatus: status },
  });
  if (wrote.count !== 1) return null;
  const amount = money((closing.depositReceivedCents ?? 0) / 100, 2);
  await audit(null, "DEPOSIT_STATUS", "closing", closingId, `${depositStatusLabel(status)}: ${amount}${outcome === "FORFEITED" ? ". The rules suggest a forfeit, which two desk members decide." : ""}`);
  return status;
}

// One sentence for the buyer's cancel notice about their deposit, or "" when none was received.
export function depositNoticeLine(closing: DepositClosing) {
  const outcome = depositOutcome(closing);
  const amount = money((closing.depositReceivedCents ?? 0) / 100, 2);
  if (outcome === "REFUND_DUE") return ` Your deposit of ${amount} is due back to you. You'll hear when the refund is sent.`;
  if (outcome === "FORFEITED") return ` The closing failed on the buyer's side after the diligence window, so your deposit of ${amount} may be kept under the purchase terms. Two desk members decide it, and you'll hear what they decide.`;
  return "";
}

// The deposit's audit events as the deal timeline reads them (lib/closing-service.ts dealTimeline). The recorded wire
// is DEPOSIT_RECEIVED, which the timeline already shows. The desk's reason and who proposed stay on the desk's copy.
export const DEPOSIT_TIMELINE_ACTIONS = ["DEPOSIT_STATUS", "DEPOSIT_PROPOSED", "DEPOSIT_APPROVED", "DEPOSIT_REJECTED"];

const AMOUNT = /\$[\d,]+\.\d{2}/;

export function depositTimelineEntry(event: { action: string; detail: string }, desk: boolean): { title: string; detail: string; owner: "desk" } | null {
  const amount = AMOUNT.exec(event.detail)?.[0] ?? "";
  const forfeit = /^forfeit\b|\bthe forfeit\b/.test(event.detail);
  if (event.action === "DEPOSIT_STATUS") {
    const label = /^(.+?): \$/.exec(event.detail)?.[1] ?? "Deposit";
    const detail = label === DEPOSIT_OUTCOME_LABELS.APPLIED
      ? `${amount} went toward the price.`
      : label === DEPOSIT_OUTCOME_LABELS.REFUND_DUE
        ? `${amount} is owed back to the buyer.`
        : label === DEPOSIT_OUTCOME_LABELS.HELD
          ? `${amount} is held while two desk members decide whether it is kept under the purchase terms.`
          : amount;
    return { title: label, detail, owner: "desk" };
  }
  if (event.action === "DEPOSIT_PROPOSED") {
    const note = /^\w+ of \$[\d,]+\.\d{2}\. (.*)$/.exec(event.detail)?.[1] ?? "";
    return {
      title: forfeit ? "Deposit forfeit proposed" : "Deposit refund proposed",
      detail: `${forfeit ? `Keep ${amount}` : `Refund ${amount}`}. A second desk member approves it before it takes effect.${desk && note ? ` Reason: ${note}` : ""}`,
      owner: "desk",
    };
  }
  if (event.action === "DEPOSIT_APPROVED") {
    const reference = / · (.+)$/.exec(event.detail)?.[1];
    return forfeit
      ? { title: "Deposit forfeit approved", detail: `${amount} kept under the purchase terms, approved by a second desk member.`, owner: "desk" }
      : { title: "Deposit refunded", detail: `${amount} sent back to the buyer${reference ? ` · reference ${reference}` : ""}, approved by a second desk member.`, owner: "desk" };
  }
  if (event.action === "DEPOSIT_REJECTED") {
    const withdrew = event.detail.startsWith("Withdrew");
    return { title: desk && !withdrew ? "Deposit proposal rejected" : "Deposit proposal withdrawn", detail: `The proposed ${forfeit ? "forfeit" : "refund"} of ${amount} won't go ahead. The deposit stands as it was.`, owner: "desk" };
  }
  return null;
}

type Actor = Staff & { id: string; name?: string };

const DECIDED = ["REFUNDED", "FORFEITED"];

async function loadDeposit(closingId: string) {
  return prisma.closing.findUnique({ where: { id: closingId }, include: { listing: { select: { title: true } } } });
}

function proposalWord(proposal: string) {
  return proposal === "FORFEITED" ? "forfeit" : "refund";
}

async function tellBuyer(closingId: string, subject: string, body: string) {
  const { buyerSideEmails } = await import("@/lib/closing-service");
  for (const email of await buyerSideEmails(closingId)) await notify(email, subject, body);
}

// A desk member who approves wires proposes a refund, or a forfeit where the rules allow one, with a note saying why.
export async function proposeDepositOutcome(actor: Actor, input: { closingId: string; outcome: string; note: string }, now = new Date()) {
  if (!deskCan(actor, "approveWires")) return { error: DESK_DENIED } as const;
  if (!isDepositProposal(input.outcome)) return { error: "Choose a refund or a forfeit." } as const;
  const note = input.note.replace(/\s+/g, " ").trim().slice(0, 500);
  if (note.length < 10) return { error: "Say why, in a sentence. The second desk member reads it." } as const;
  const closing = await loadDeposit(input.closingId);
  if (!closing) return { error: "Closing not found." } as const;
  if (closing.status !== "CANCELED") return { error: "A deposit is refunded or kept only once the closing is canceled." } as const;
  const { status, suggested } = depositState(closing);
  if (!status) return { error: "No deposit was received on this closing." } as const;
  if (DECIDED.includes(status)) return { error: "This deposit is already decided." } as const;
  if (closing.depositProposal && !closing.depositResolvedAt) return { error: "A decision on this deposit is already waiting for approval. Approve or reject it first." } as const;
  if (input.outcome === "FORFEITED" && suggested !== "FORFEITED") {
    return { error: "A deposit is kept only when the buyer failed to close after the diligence window. This one is owed back." } as const;
  }
  const claimed = await prisma.closing.updateMany({
    where: { id: closing.id, status: "CANCELED", ...(closing.depositProposedAt ? { depositProposedAt: closing.depositProposedAt } : unset("depositProposedAt")) },
    data: { depositStatus: status, depositProposal: input.outcome, depositProposedById: actor.id, depositProposedAt: now, depositNote: note, depositResolvedById: null, depositResolvedAt: null },
  });
  if (claimed.count !== 1) return { error: "This deposit changed a moment ago. Reload the page." } as const;
  const amount = money((closing.depositReceivedCents ?? 0) / 100, 2);
  const title = closing.listing.title;
  const word = proposalWord(input.outcome);
  await audit(actor.id, "DEPOSIT_PROPOSED", "closing", closing.id, `${word} of ${amount}. ${note}`);
  await notifyDesk(
    `Deposit ${word} to approve · ${title}`,
    `${actor.name ?? "A desk member"} proposed to ${word === "refund" ? "refund" : "keep"} the buyer's deposit of ${amount} on ${title}. Reason: ${note} It takes effect only when another desk member who approves wires approves it on the closing page.`,
    { capability: "approveWires" },
  );
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closing.id}`;
  await tellBuyer(
    closing.id,
    `Your deposit · ${title}`,
    input.outcome === "REFUNDED"
      ? `The desk is refunding your deposit of ${amount}. A second desk member approves it before it is sent, and you'll hear when it goes out.`
      : `The desk proposed keeping your deposit of ${amount} under the purchase terms, since the closing failed on the buyer's side after the diligence window. A second desk member reviews it before it's final. If you disagree, write the desk on the closing thread: ${link}`,
  );
  return { error: null } as const;
}

// A different desk member who approves wires approves the proposal, with the refund's wire reference, or rejects it.
// The proposer can withdraw their own by rejecting it, but never approve it.
export async function decideDepositOutcome(actor: Actor, input: { closingId: string; decision: string; reference?: string }, now = new Date()) {
  if (!deskCan(actor, "approveWires")) return { error: DESK_DENIED } as const;
  if (input.decision !== "APPROVED" && input.decision !== "REJECTED") return { error: "Choose approve or reject." } as const;
  const closing = await loadDeposit(input.closingId);
  if (!closing) return { error: "Closing not found." } as const;
  const proposal = closing.depositProposal;
  if (!proposal || !isDepositProposal(proposal) || closing.depositResolvedAt || !closing.depositProposedAt) return { error: "Nothing on this deposit is waiting for approval." } as const;
  if (input.decision === "APPROVED" && closing.depositProposedById === actor.id) {
    return { error: "You proposed this, so another desk member approves it." } as const;
  }
  const reference = (input.reference ?? "").trim().slice(0, 120);
  if (input.decision === "APPROVED" && proposal === "REFUNDED" && reference.length < 3) return { error: "Enter the refund wire's reference." } as const;
  const same = { id: closing.id, depositProposal: proposal, depositProposedAt: closing.depositProposedAt, ...unset("depositResolvedAt") };
  const amount = money((closing.depositReceivedCents ?? 0) / 100, 2);
  const title = closing.listing.title;
  const word = proposalWord(proposal);
  if (input.decision === "REJECTED") {
    const cleared = await prisma.closing.updateMany({
      where: same,
      data: { depositProposal: null, depositProposedById: null, depositProposedAt: null, depositNote: null },
    });
    if (cleared.count !== 1) return { error: "This deposit was decided a moment ago." } as const;
    const withdrawn = closing.depositProposedById === actor.id;
    await audit(actor.id, "DEPOSIT_REJECTED", "closing", closing.id, `${withdrawn ? "Withdrew" : "Rejected"} the ${word} of ${amount}`);
    const proposer = closing.depositProposedById && !withdrawn ? await prisma.user.findUnique({ where: { id: closing.depositProposedById }, select: { email: true } }) : null;
    if (proposer) await notify(proposer.email, `Deposit ${word} rejected · ${title}`, `${actor.name ?? "A desk member"} rejected the ${word} you proposed on ${title}. The deposit stands as it was.`);
    await tellBuyer(closing.id, `Your deposit · ${title}`, `The desk withdrew its proposed ${word} of your deposit of ${amount}. ${closing.depositStatus === "REFUND_DUE" ? "It is still due back to you." : "It stays held until the desk decides."}`);
    return { error: null, applied: false, withdrawn } as const;
  }
  const decided = await prisma.closing.updateMany({
    where: same,
    data: { depositStatus: proposal, depositResolvedById: actor.id, depositResolvedAt: now, ...(proposal === "REFUNDED" ? { depositRefundReference: reference } : {}) },
  });
  if (decided.count !== 1) return { error: "This deposit was decided a moment ago." } as const;
  await audit(actor.id, "DEPOSIT_APPROVED", "closing", closing.id, `${word} of ${amount}, proposed by ${closing.depositProposedById}${reference ? ` · ${reference}` : ""}`);
  await tellBuyer(
    closing.id,
    `Your deposit · ${title}`,
    proposal === "REFUNDED"
      ? `The desk sent your deposit refund of ${amount}${reference ? ` (reference ${reference})` : ""}. If it doesn't arrive, reply on the closing thread.`
      : `Your deposit of ${amount} is kept under the purchase terms, since the closing failed on the buyer's side after the diligence window. Two desk members agreed to it.`,
  );
  return { error: null, applied: true } as const;
}
