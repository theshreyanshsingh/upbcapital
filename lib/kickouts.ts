import { audit } from "@/lib/audit";
import { closingIsWhole, closingLoans, closingTotals } from "@/lib/closing";
import { buyerSideEmails } from "@/lib/closing-service";
import { notify, notifyDesk } from "@/lib/email";
import { money } from "@/lib/format";
import { pricesFor } from "@/lib/loan-prices";
import { prisma } from "@/lib/prisma";

// A kick-out takes one loan out of an open closing before settlement, as HUD's sale rules let a seller withdraw a
// loan with the price and deposit adjusted (24 CFR 291.609). The rest of the closing goes on.

export type KickoutBasis = "loanPrice" | "askShare" | "equalShare";

export const BASIS_TEXT: Record<KickoutBasis, string> = {
  loanPrice: "by the buyer's own price for that loan",
  askShare: "by the loan's share of the asking prices",
  equalShare: "by an equal share of the price, since the loans have no asking prices",
};

// The fee rates the closing charges, read off its own figures. Rates are whole basis points across the desk, so
// rounding recovers the rate the closing opened with.
export function closingRates(closing: { salePrice: number; buyerPremiumCents: number; sellerCommissionCents: number }) {
  const saleCents = Math.round(closing.salePrice * 100);
  if (saleCents <= 0) return { premiumBps: 0, commissionBps: 0 };
  return {
    premiumBps: Math.round((closing.buyerPremiumCents * 10000) / saleCents),
    commissionBps: Math.round((closing.sellerCommissionCents * 10000) / saleCents),
  };
}

type TermsClosing = {
  salePrice: number;
  buyerPremiumCents: number;
  sellerCommissionCents: number;
  depositCents: number | null;
  depositReceivedCents: number | null;
  fundsReceivedCents: number | null;
};

// What taking this loan out does to the closing. The price comes down by the buyer's price for the loan when the
// bid priced every loan on the closing and those prices still add up to it; otherwise by the loan's share of the
// asking prices. Fees follow at the closing's own rates, and the deposit comes down in proportion to the price.
export function kickoutTerms(input: { closing: TermsClosing; loans: { id: string; ask: number }[]; noteId: string; loanPrices: unknown }) {
  const { closing, loans, noteId } = input;
  const oldCents = Math.round(closing.salePrice * 100);
  const prices = pricesFor(input.loanPrices, loans.map((loan) => loan.id), closing.salePrice);
  const priced = prices != null;
  const asks = loans.reduce((sum, loan) => sum + Math.max(0, loan.ask), 0);
  const ask = Math.max(0, loans.find((loan) => loan.id === noteId)?.ask ?? 0);
  const basis: KickoutBasis = priced ? "loanPrice" : asks > 0 ? "askShare" : "equalShare";
  const dropCents =
    prices ? Math.round(prices[noteId] * 100) : basis === "askShare" ? Math.round((oldCents * ask) / asks) : Math.round(oldCents / loans.length);
  const priceCents = oldCents - dropCents;
  const rates = closingRates(closing);
  const fees = closingTotals(priceCents / 100, rates.premiumBps, rates.commissionBps);
  const deposit = closing.depositCents == null ? null : oldCents > 0 ? Math.round((closing.depositCents * priceCents) / oldCents) : 0;
  // Buyer money already on record past the new total has to go back. The deposit counts toward the total.
  const recorded = (closing.depositReceivedCents ?? 0) + (closing.fundsReceivedCents ?? 0);
  const excessCents = Math.max(0, recorded - fees.buyerTotalCents);
  return {
    basis,
    dropCents,
    salePrice: priceCents / 100,
    premiumCents: fees.premiumCents,
    commissionCents: fees.commissionCents,
    buyerTotalCents: fees.buyerTotalCents,
    netToSellerCents: fees.netToSellerCents,
    depositCents: deposit,
    depositDropCents: closing.depositCents == null || deposit == null ? 0 : closing.depositCents - deposit,
    fundsRecorded: closing.depositReceivedCents != null || closing.fundsReceivedCents != null,
    excessCents,
  };
}

export type KickoutTerms = ReturnType<typeof kickoutTerms>;

function loanLabel(note: { streetAddress: string; city: string; state: string }) {
  return `${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}`;
}

// The money line both sides read after a kick-out on a closing where buyer money is already on record.
export function excessLine(terms: Pick<KickoutTerms, "fundsRecorded" | "excessCents">) {
  if (!terms.fundsRecorded) return "";
  return terms.excessCents > 100
    ? `Buyer money already recorded is ${money(terms.excessCents / 100, 2)} over the new total, and the excess has to be returned outside the app.`
    : "Buyer money is already recorded on this closing. Anything over the new total has to be returned outside the app.";
}

// The desk takes one loan out of an open closing that covers more than one, with a reason both sides read. The
// write is conditional on the figures as they were read, so two kick-outs at once can't both apply to the same
// price. The loan goes back to available on its listing.
export async function kickOutLoan(input: { closingId: string; noteId: string; reason: string; actorId: string }) {
  const closing = await prisma.closing.findUnique({ where: { id: input.closingId }, include: { listing: { include: { notes: { orderBy: { createdAt: "asc" } }, seller: true } }, funders: true } });
  if (!closing) return { error: "That closing no longer exists." } as const;
  if (closing.status !== "OPEN") return { error: "This closing is already finished." } as const;
  // Each seat agreed its share of one price, so a group closing changes by the seats' word, not the desk's.
  if (closing.funders.length) return { error: "A group closing's shares are fixed seat by seat, so a loan can't come out of it. Cancel the closing instead." } as const;
  if (closing.proceedsSentCents != null) return { error: "The seller's proceeds are already recorded as sent, so a loan can't come out now." } as const;
  const why = input.reason.replace(/\s+/g, " ").trim().slice(0, 500);
  if (why.length < 3) return { error: "Say why the loan is coming out, in a sentence. Both sides see it." } as const;
  const loans = closingLoans(closing, closing.listing.notes);
  const note = loans.find((item) => item.id === input.noteId);
  if (!note) return { error: "That loan isn't on this closing." } as const;
  if (loans.length <= 1) return { error: "This is the closing's last loan. Cancel the closing instead." } as const;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { loanPrices: true } }) : null;
  const salePrice = Number(closing.salePrice);
  const terms = kickoutTerms({
    closing: { ...closing, salePrice },
    loans: loans.map((loan) => ({ id: loan.id, ask: Number(loan.askingPrice) })),
    noteId: note.id,
    loanPrices: inquiry?.loanPrices ?? null,
  });
  const remaining = loans.filter((loan) => loan.id !== note.id).map((loan) => loan.id);
  const wrote = await prisma.closing.updateMany({
    where: { id: closing.id, status: "OPEN", salePrice: closing.salePrice, buyerTotalCents: closing.buyerTotalCents, noteIds: { equals: closing.noteIds } },
    data: {
      noteIds: remaining,
      salePrice: terms.salePrice,
      buyerPremiumCents: terms.premiumCents,
      sellerCommissionCents: terms.commissionCents,
      buyerTotalCents: terms.buyerTotalCents,
      netToSellerCents: terms.netToSellerCents,
      ...(terms.depositCents != null ? { depositCents: terms.depositCents } : {}),
    },
  });
  if (wrote.count !== 1) return { error: "This closing changed a moment ago. Reload it and try again." } as const;
  // A whole-listing closing held the listing, not its loans. Naming the loans it keeps takes them into contract, and
  // the listing goes back on the book so the loan that came out can trade again.
  if (closingIsWhole(closing)) {
    await prisma.note.updateMany({ where: { id: { in: remaining } }, data: { tradeStatus: "IN_CONTRACT" } });
    if (closing.listing.status === "PENDING") {
      await prisma.listing.updateMany({
        where: { id: closing.listingId, status: "PENDING" },
        data: { status: closing.listing.approvedAt ? "APPROVED" : "UNDER_REVIEW", ...(closing.listing.acceptedInquiryId === closing.inquiryId ? { acceptedInquiryId: null } : {}) },
      });
    }
  }
  await prisma.note.update({ where: { id: note.id }, data: { tradeStatus: "AVAILABLE" } });
  await prisma.closingKickout.create({
    data: { closingId: closing.id, noteId: note.id, priceCents: terms.dropCents, depositCents: terms.depositDropCents, reason: why, actorId: input.actorId },
  });
  const label = loanLabel(note);
  const drop = money(terms.dropCents / 100, 2);
  await audit(
    input.actorId,
    "CLOSING_KICKOUT",
    "closing",
    closing.id,
    `${label} · ${why} · down ${drop} ${BASIS_TEXT[terms.basis]} · price ${money(salePrice, 2)} to ${money(terms.salePrice, 2)}${terms.depositDropCents ? ` · deposit down ${money(terms.depositDropCents / 100, 2)}` : ""}`,
  );
  const title = closing.listing.title;
  const subject = `Loan taken out · ${title}`;
  const shared = `The desk took ${label} out of this closing. Reason: ${why} The price comes down ${drop}, ${BASIS_TEXT[terms.basis]}, to ${money(terms.salePrice, 2)}. The loan is back on the listing, and the closing papers now list the loans that remain.`;
  const excess = excessLine(terms);
  const buyerLine = `${shared} You now owe ${money(terms.buyerTotalCents / 100, 2)} all-in${terms.depositCents != null ? `, with a deposit of ${money(terms.depositCents / 100, 2)}` : ""}.${excess ? ` ${excess}` : ""}`;
  const sellerLine = `${shared} Your net is now ${money(terms.netToSellerCents / 100, 2)}.`;
  await notify(closing.listing.seller.email, subject, sellerLine);
  for (const email of await buyerSideEmails(closing.id)) await notify(email, subject, buyerLine);
  await notifyDesk(subject, `${label} came out of the closing: ${why} Price ${money(salePrice, 2)} to ${money(terms.salePrice, 2)}, ${BASIS_TEXT[terms.basis]}.${excess ? ` ${excess}` : ""}`);
  const thread = await prisma.deskThread.findUnique({ where: { closingId: closing.id } });
  // Both sides read the thread, so it says only that money over the new total goes back, not whose or how much.
  const back = terms.fundsRecorded ? " Money already wired over the new total has to be returned outside the app." : "";
  if (thread) await prisma.threadPost.create({ data: { threadId: thread.id, authorId: input.actorId, body: `${shared}${back}` } });
  return { error: null, ...terms, label, remaining } as const;
}
