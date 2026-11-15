import { closingLoans } from "@/lib/closing";
import { duplicateKeys } from "@/lib/duplicates";
import { money } from "@/lib/format";
import { pricesFor } from "@/lib/loan-prices";
import { prisma } from "@/lib/prisma";

// Retrade controls. A buyer who wins may walk away inside the diligence window, for one finding from a fixed list,
// and the seller and the desk read which. A buyer who walked away can't come back to the same loans lower, on that
// listing or a relist of them. Each buyer's record counts their walk-aways and the findings, as facts, never as a
// grade. A walk-away stays nobody's fault, so it is never a strike (lib/closing-service.ts).

// ---------------------------------------------------------------------------------------------------------------
// The findings a buyer may walk away for.

export const WALK_AWAY_REASONS = ["TITLE", "COLLATERAL", "PAY_HISTORY", "VALUE", "DATA_MISMATCH", "OCCUPANCY", "LITIGATION", "OTHER"] as const;
export type WalkAwayReason = (typeof WALK_AWAY_REASONS)[number];

// Counsel: confirm this list matches the diligence outs the purchase agreement allows before launch.
export const WALK_AWAY_LABELS: Record<WalkAwayReason, string> = {
  TITLE: "Title",
  COLLATERAL: "Collateral file",
  PAY_HISTORY: "Pay history",
  VALUE: "Property value",
  DATA_MISMATCH: "Data mismatch",
  OCCUPANCY: "Occupancy",
  LITIGATION: "Litigation",
  OTHER: "Other",
};

export const WALK_AWAY_HINTS: Record<WalkAwayReason, string> = {
  TITLE: "A lien ahead of this one, a break in the chain of title, or another title defect.",
  COLLATERAL: "The note, an allonge or an assignment is missing or doesn't match.",
  PAY_HISTORY: "The payments on file differ from the pay history described.",
  VALUE: "The property is worth materially less than described.",
  DATA_MISMATCH: "The balance, rate or dates on the tape differ from the documents.",
  OCCUPANCY: "Who lives in the property differs from what was described.",
  LITIGATION: "A lawsuit, bankruptcy or foreclosure matter that wasn't disclosed.",
  OTHER: "Something else. Say what in your own words.",
};

export function isWalkAwayReason(value: unknown): value is WalkAwayReason {
  return typeof value === "string" && (WALK_AWAY_REASONS as readonly string[]).includes(value);
}

export function walkAwayLabel(reason: string | null | undefined) {
  return isWalkAwayReason(reason) ? WALK_AWAY_LABELS[reason] : null;
}

// lib/closing-service.ts starts a walk-away's cancel reason with this, and lib/deposits.ts reads it.
export const WALK_AWAY_PREFIX = "The buyer walked away in diligence";

// A walk-away: the code from the list, or for one made before the list, the cancel reason it wrote.
export function isWalkAway(closing: { status: string; walkAwayReason?: string | null; cancelReason?: string | null }) {
  return closing.status === "CANCELED" && (Boolean(closing.walkAwayReason) || Boolean(closing.cancelReason?.startsWith(WALK_AWAY_PREFIX)));
}

// "Title. Title search shows a second lien." The finding, then the buyer's own words when they gave any.
export function walkAwayText(reason: WalkAwayReason, words: string) {
  const said = words && !/[.!?]$/.test(words) ? `${words}.` : words;
  return `${WALK_AWAY_LABELS[reason]}.${said ? ` ${said}` : ""}`;
}

// The form's answer. One finding from the list is required; the buyer's own words are required for Other and
// optional for the rest.
export function readWalkAway(input: { reason: unknown; words: unknown }) {
  const reason = String(input.reason ?? "").trim().toUpperCase();
  if (!isWalkAwayReason(reason)) return { error: "Choose what you found from the list. The seller reads it." } as const;
  const words = String(input.words ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (reason === "OTHER" && words.length < 10) return { error: "Say what you found, in a sentence. The seller reads it." } as const;
  return { error: null, reason, words, text: walkAwayText(reason, words) } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// The record: how often a buyer walked away and for what. A count with the findings, never a score.

const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

// "Walked away twice in diligence: title, pay history". A walk-away from before the list has no finding to name.
export function walkAwayLine(reasons: (string | null | undefined)[]) {
  if (!reasons.length) return null;
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    const key = isWalkAwayReason(reason) ? reason : "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order = (key: string) => (key ? WALK_AWAY_REASONS.indexOf(key as WalkAwayReason) : WALK_AWAY_REASONS.length);
  const parts = [...counts]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([key, count]) => {
      const label = key ? WALK_AWAY_LABELS[key as WalkAwayReason].toLowerCase() : "no finding recorded";
      return count > 1 ? `${label} (${count})` : label;
    });
  return `Walked away ${times(reasons.length)} in diligence: ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// No lower rebid. A buyer who walked away from loans may bid on them again, on the same listing or on a relist of
// them in any listing, only at the price they walked away from or more. The price is the closing's as it stood when
// they walked, so after a desk kick-out it is the price for the loans that were left. Where the new bid and the
// walk-away cover different loans, each side is spread across its loans as a kick-out is (lib/kickouts.ts): by the
// buyer's own loan prices, else by asking prices, else equally, and the loans both cover are compared.

const LOAN_FIELDS = {
  id: true,
  askingPrice: true,
  upb: true,
  streetAddress: true,
  city: true,
  state: true,
  zip: true,
  loanNumber: true,
  servicerName: true,
  mersMin: true,
} as const;

type Loan = { id: string; askingPrice: number; upb: number; streetAddress: string; city: string; state: string; zip: string; loanNumber: string | null; servicerName: string | null; mersMin: string | null };

export type ShareBasis = "loanPrice" | "askShare" | "equalShare";

// Each loan's part of a price, in dollars.
export function loanShares(price: number, loans: { id: string; ask: number }[], loanPrices?: unknown): { basis: ShareBasis; shares: Map<string, number> } {
  const prices = pricesFor(loanPrices, loans.map((loan) => loan.id), price);
  if (prices) return { basis: "loanPrice", shares: new Map(loans.map((loan) => [loan.id, prices[loan.id]])) };
  const asks = loans.reduce((sum, loan) => sum + Math.max(0, loan.ask), 0);
  if (asks > 0) return { basis: "askShare", shares: new Map(loans.map((loan) => [loan.id, (price * Math.max(0, loan.ask)) / asks])) };
  return { basis: "equalShare", shares: new Map(loans.map((loan) => [loan.id, loans.length ? price / loans.length : 0])) };
}

// The same loan: the same row, or a relist of it, known by the keys the duplicate check reads (lib/duplicates.ts).
// A borrower's name and ZIP alone can be two rentals, so they don't count here.
export function sameLoan(a: Loan, b: Loan) {
  if (a.id === b.id) return true;
  const x = duplicateKeys(a);
  const y = duplicateKeys(b);
  const close = x.upb > 0 && y.upb > 0 && Math.abs(x.upb - y.upb) <= 0.01 * Math.max(x.upb, y.upb);
  return Boolean((x.min && x.min === y.min) || (x.loan && x.loan === y.loan) || (x.streetZip && x.streetZip === y.streetZip && close) || (x.streetCity && x.streetCity === y.streetCity));
}

// The firm each account bids for: its principal and every seat on it (lib/seats.ts). A signed-in seat acts as its
// firm, so its bids are already the firm's; the seats are here for anything recorded under a seat's own id.
export async function firmIds(userIds: string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, principalId: true } });
  const principals = [...new Set([...ids, ...users.map((user) => user.principalId ?? user.id)])];
  const seats = await prisma.user.findMany({ where: { principalId: { in: principals } }, select: { id: true } });
  return [...new Set([...principals, ...seats.map((seat) => seat.id)])];
}

export type WalkAway = { closingId: string; buyerIds: string[]; price: number; loans: Loan[]; shares: Map<string, number> };

// The closings these accounts' firms walked away from, as the bidder or as a group seat, at the price as kicked out.
export async function walkAwaysBy(userIds: string[]): Promise<WalkAway[]> {
  const firm = await firmIds(userIds);
  if (!firm.length) return [];
  // A walk-away withdraws the winning bid (lib/closing-service.ts cancelOpenClosing).
  const [bids, seats] = await Promise.all([
    prisma.inquiry.findMany({ where: { buyerId: { in: firm }, type: "OFFER", status: "WITHDRAWN" }, select: { id: true, buyerId: true, loanPrices: true } }),
    prisma.closingFunder.findMany({ where: { userId: { in: firm } }, select: { closingId: true, userId: true } }),
  ]);
  if (!bids.length && !seats.length) return [];
  const closings = await prisma.closing.findMany({
    where: {
      status: "CANCELED",
      OR: [...(bids.length ? [{ inquiryId: { in: bids.map((bid) => bid.id) } }] : []), ...(seats.length ? [{ id: { in: [...new Set(seats.map((seat) => seat.closingId))] } }] : [])],
    },
    select: {
      id: true,
      status: true,
      inquiryId: true,
      noteId: true,
      noteIds: true,
      salePrice: true,
      walkAwayReason: true,
      cancelReason: true,
      listing: { select: { notes: { select: LOAN_FIELDS } } },
    },
  });
  const bidOf = new Map(bids.map((bid) => [bid.id, bid]));
  const walked: WalkAway[] = [];
  for (const closing of closings) {
    if (!isWalkAway(closing)) continue;
    const loans = closingLoans(closing, closing.listing.notes).map((note) => ({ ...note, askingPrice: Number(note.askingPrice), upb: Number(note.upb) }));
    if (!loans.length) continue;
    const bid = closing.inquiryId ? bidOf.get(closing.inquiryId) : undefined;
    const price = Number(closing.salePrice);
    walked.push({
      closingId: closing.id,
      buyerIds: [...new Set([bid?.buyerId, ...seats.filter((seat) => seat.closingId === closing.id).map((seat) => seat.userId)].filter((id): id is string => Boolean(id)))],
      price,
      loans,
      shares: loanShares(price, loans.map((loan) => ({ id: loan.id, ask: loan.askingPrice })), bid?.loanPrices).shares,
    });
  }
  return walked;
}

const BASIS_WORDS: Record<ShareBasis, string> = {
  loanPrice: "by your loan prices",
  askShare: "by their share of the asking prices",
  equalShare: "split equally across the loans",
};

// Whole dollars when the figure is whole, else to the cent, rounded up so the figure named clears the floor.
function floorText(dollars: number) {
  const cents = Math.ceil(Math.round(dollars * 10000) / 100);
  return cents % 100 === 0 ? money(cents / 100) : money(cents / 100, 2);
}

// Why this bid would put less on loans than its bidder walked away from, or null. userIds are whoever stands behind
// the bid: the bidder, or every seat of a group. A refusal names the figure only to the firm that walked away; a
// group's other seats hear that a seat walked away at a higher price, never what it was.
export async function rebidBlock(input: { userIds: string[]; actorId?: string; listingId: string; noteId: string | null; amount: number; loanPrices?: unknown; group?: boolean }) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return null;
  const walked = await walkAwaysBy(input.userIds);
  if (!walked.length) return null;
  const notes = await prisma.note.findMany({ where: { listingId: input.listingId, ...(input.noteId ? { id: input.noteId } : {}) }, select: LOAN_FIELDS });
  const loans = notes.map((note) => ({ ...note, askingPrice: Number(note.askingPrice), upb: Number(note.upb) }));
  if (!loans.length) return null;
  const bid = loanShares(input.amount, loans.map((loan) => ({ id: loan.id, ask: loan.askingPrice })), input.loanPrices);
  const actorFirm = input.actorId ? new Set(await firmIds([input.actorId])) : null;
  for (const walk of walked) {
    const mine = loans.filter((loan) => walk.loans.some((gone) => sameLoan(gone, loan)));
    if (!mine.length) continue;
    const theirs = walk.loans.filter((gone) => mine.some((loan) => sameLoan(gone, loan)));
    const floor = theirs.reduce((sum, gone) => sum + (walk.shares.get(gone.id) ?? 0), 0);
    const offer = mine.reduce((sum, loan) => sum + (bid.shares.get(loan.id) ?? 0), 0);
    if (offer + 0.005 >= floor) continue;
    const them = mine.length === 1 ? "this loan" : "these loans";
    const own = !actorFirm || walk.buyerIds.some((id) => actorFirm.has(id));
    if (input.group) {
      return own
        ? `You walked away from ${them} in diligence at ${floorText(floor)}, so you can't join a group bid of less for ${mine.length === 1 ? "it" : "them"}.`
        : `A seat in this group walked away from ${them} in diligence at a higher price, so the group can't bid this low for ${mine.length === 1 ? "it" : "them"}.`;
    }
    // The whole of both: one price against the other.
    if (mine.length === loans.length && theirs.length === walk.loans.length) {
      return `You walked away from ${them} in diligence at ${floorText(floor)}. A new bid on ${mine.length === 1 ? "it" : "them"} can't be lower, so bid ${floorText(floor)} or more.`;
    }
    const some = mine.length === 1 ? "a loan" : `${mine.length} of the loans`;
    return `You walked away in diligence from ${some} in this bid, at ${floorText(floor)} for ${mine.length === 1 ? "it" : "them"}. This bid puts ${money(offer)} on ${mine.length === 1 ? "it" : "them"}, ${BASIS_WORDS[bid.basis]}. Raise the bid, or price each loan so ${mine.length === 1 ? "it carries" : "they carry"} at least ${floorText(floor)}.`;
  }
  return null;
}
