import { audit } from "@/lib/audit";
import { closingLoans } from "@/lib/closing";
import { buyerSideEmails } from "@/lib/closing-service";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify } from "@/lib/email";
import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { loanPriceShares, prorate, prorationDirection, prorationProblem, prorationSummary, readProration, type ProrationLoanInput } from "@/lib/proration";
import { buyerDueCents, sellerNetCents } from "@/lib/settlement";
import { tieOutUpbChange } from "@/lib/tie-out";

// The desk's side of proration: it sets the cut-off date and the balances at closing, and both parties hear what the
// adjustment does to their figures. The maths is lib/proration.ts.

type Actor = Staff & { id: string; name?: string };

export type ProrationEntry = {
  closingId: string;
  cutoffDate: string;
  closingDate: string;
  // By loan: the unpaid principal at closing in dollars as typed, and the interest paid-to date or blank.
  loans: Record<string, { upb: string; paidTo: string }>;
};

function day(raw: string) {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cents(raw: string | undefined) {
  const value = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!value) return Number.NaN;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : Number.NaN;
}

function place(note: { streetAddress: string; city: string; state: string }) {
  return `${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}`;
}

async function loadForProration(closingId: string) {
  return prisma.closing.findUnique({
    where: { id: closingId },
    include: { listing: { include: { notes: { orderBy: { createdAt: "asc" } }, seller: { select: { email: true } } } }, funders: { select: { id: true } } },
  });
}

type LoadedClosing = NonNullable<Awaited<ReturnType<typeof loadForProration>>>;

function editProblem(closing: LoadedClosing | null) {
  if (!closing) return "Closing not found.";
  if (closing.status !== "OPEN") return "This closing is already finished.";
  // Each seat agreed its own share of one price, so a group closing's figures change by the seats' word.
  if (closing.funders.length) return "A group closing's shares are fixed seat by seat, so it can't be prorated here. Settle any difference with the seats outside the app.";
  if (closing.proceedsSentCents != null) return "The seller's proceeds are already recorded as sent, so the proration can't change now.";
  return null;
}

// Each loan's balance on the bid tape and on the closing tape, from the tie-out when the desk ran one
// (lib/tie-out.ts). A loan the tie-out couldn't find takes the desk's entry instead.
export function tiedBalances(tieOut: unknown) {
  return new Map(tieOutUpbChange(tieOut).map((row) => [row.noteId, { bidUpbCents: Math.round(row.bidUpb * 100), closingUpbCents: Math.round(row.closingUpb * 100) }]));
}

// The proration from the desk's entry, without writing it, so the form and the save read the same figures.
export function prorationFromEntry(closing: LoadedClosing, entry: ProrationEntry, loanPrices: unknown) {
  const cutoffDate = day(entry.cutoffDate);
  const closingDate = day(entry.closingDate);
  const notes = closingLoans(closing, closing.listing.notes);
  const { basis, shares } = loanPriceShares({
    priceCents: Math.round(Number(closing.salePrice) * 100),
    loans: notes.map((note) => ({ id: note.id, upbCents: Math.round(Number(note.upb) * 100) })),
    loanPrices,
  });
  const tied = tiedBalances(closing.tieOut);
  const loans: ProrationLoanInput[] = notes.map((note) => {
    const typed = entry.loans[note.id];
    const tie = tied.get(note.id);
    const tapeUpbCents = tie ? tie.bidUpbCents : Math.round(Number(note.upb) * 100);
    // A blank balance is the closing tape's from the tie-out, or else the bid tape's: nothing paid down.
    const closingUpbCents = typed?.upb?.trim() ? cents(typed.upb) : tie ? tie.closingUpbCents : tapeUpbCents;
    return {
      noteId: note.id,
      label: place(note),
      priceCents: shares[note.id] ?? 0,
      tapeUpbCents,
      closingUpbCents,
      ratePercent: Number(note.interestRate),
      interestPaidTo: typed?.paidTo ? day(typed.paidTo) : null,
    };
  });
  const badDate = notes.find((note) => entry.loans[note.id]?.paidTo?.trim() && !day(entry.loans[note.id].paidTo));
  if (badDate) return { error: `Enter the interest paid-to date for ${place(badDate)} as a date, or leave it blank.` } as const;
  const problem = prorationProblem({ cutoffDate, closingDate, loans });
  if (problem || !cutoffDate || !closingDate) return { error: problem ?? "Enter the dates." } as const;
  return { error: null, cutoffDate, proration: prorate({ cutoffDate, closingDate, basis, loans }) } as const;
}

// The desk sets the cut-off and the balances at closing. The write holds only while the closing's price and loans are
// as they were read, so a kick-out landing at the same moment can't leave a proration for the old pool.
export async function saveProration(actor: Actor, entry: ProrationEntry, now = new Date()) {
  if (!deskCan(actor, "closings")) return { error: DESK_DENIED } as const;
  const closing = await loadForProration(entry.closingId);
  const problem = editProblem(closing);
  if (problem || !closing) return { error: problem ?? "Closing not found." } as const;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { loanPrices: true } }) : null;
  const built = prorationFromEntry(closing, entry, inquiry?.loanPrices ?? null);
  if (built.error !== null) return { error: built.error } as const;
  const { proration, cutoffDate } = built;
  const wrote = await prisma.closing.updateMany({
    where: { id: closing.id, status: "OPEN", salePrice: closing.salePrice, noteIds: { equals: closing.noteIds }, ...unset("proceedsSentCents") },
    data: { cutoffDate, prorationCents: proration.totalCents, prorationDetail: { ...proration, setById: actor.id, setAt: now.toISOString() } },
  });
  if (wrote.count !== 1) return { error: "This closing changed a moment ago. Reload the page and set the proration again." } as const;
  const before = closing.cutoffDate ? closing.cutoffDate.toISOString().slice(0, 10) : "none";
  if (before !== proration.cutoffDate) await audit(actor.id, "PRORATION_CUTOFF", "closing", closing.id, `Cut-off ${before} to ${proration.cutoffDate}`);
  const loans = proration.loans.map((loan) => `${loan.label}: UPB ${money(loan.tapeUpbCents / 100, 2)} to ${money(loan.closingUpbCents / 100, 2)}, principal ${money(loan.principalCents / 100, 2)}, ${loan.interestDays} days interest ${money(loan.interestCents / 100, 2)}`).join("; ");
  const was = closing.prorationCents == null ? "none" : money(closing.prorationCents / 100, 2);
  await audit(actor.id, "PRORATION_SET", "closing", closing.id, `${was} to ${money(proration.totalCents / 100, 2)}. ${prorationSummary(proration)} ${loans}`);
  await tellParties(closing, proration.totalCents, `${prorationSummary(proration)}`);
  return { error: null, proration } as const;
}

// The desk takes the proration off, and the figures go back to the price and fees alone.
export async function clearProration(actor: Actor, closingId: string) {
  if (!deskCan(actor, "closings")) return { error: DESK_DENIED } as const;
  const closing = await loadForProration(closingId);
  const problem = editProblem(closing);
  if (problem || !closing) return { error: problem ?? "Closing not found." } as const;
  if (closing.prorationCents == null) return { error: "There is no proration on this closing." } as const;
  const wrote = await prisma.closing.updateMany({
    where: { id: closing.id, status: "OPEN", prorationCents: closing.prorationCents, ...unset("proceedsSentCents") },
    data: { prorationCents: null, prorationDetail: null },
  });
  if (wrote.count !== 1) return { error: "This closing changed a moment ago. Reload the page." } as const;
  await audit(actor.id, "PRORATION_CLEARED", "closing", closing.id, `${money(closing.prorationCents / 100, 2)} to none`);
  await tellParties(closing, 0, "The desk took the proration off this closing, so the figures are the price and fees alone.");
  return { error: null } as const;
}

// Each side hears the adjustment with its own new figure: what the buyer wires, what the seller nets.
async function tellParties(closing: LoadedClosing, prorationCents: number, said: string) {
  const subject = `Proration · ${closing.listing.title}`;
  const after = { ...closing, prorationCents };
  const check = "Your settlement statement shows it line by line. If it doesn't match your records, reply on the closing thread.";
  if (!closing.deskBidId) {
    for (const email of await buyerSideEmails(closing.id)) {
      await notify(email, subject, `${said} You now owe ${money(buyerDueCents(after) / 100, 2)} in all, before any deposit. ${check}`);
    }
  }
  await notify(closing.listing.seller.email, subject, `${said} Your net is now ${money(sellerNetCents(after) / 100, 2)}. ${check}`);
}

// The stored proration on a closing page, with whether it still covers the closing's loans.
export function prorationView(closing: { prorationCents: number | null; prorationDetail: unknown }) {
  const detail = readProration(closing.prorationDetail);
  return { detail, cents: closing.prorationCents, direction: closing.prorationCents == null ? null : prorationDirection(closing.prorationCents) };
}
