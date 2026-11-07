import { closingLoans } from "@/lib/closing";
import { COMP_WINDOW_MONTHS, compsFor, loadClosedTrades, type ClosedTrade } from "@/lib/comps";
import { showableAvm } from "@/lib/enrichment";
import { compSubjectOf, indicativeRange, type IndicativeNote } from "@/lib/indicative";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

// A check of the book's indicative price against what buyers actually paid. UPB doesn't keep the range a listing
// showed, so each award's range is recomputed as of the award date: the desk model at today's target yield on the
// loans as they are on file now, and the closed-trade comps from before the award. Standing buy-box bids are left
// out, since which ones were still unanswered on the day can't be read back. Errors are in points of UPB: the
// award's price over UPB less the middle of the range, so a positive error means buyers paid more than it said.

export const MIN_AWARDS = 10;

export type BacktestRow = {
  closingId: string;
  listingId: string;
  title: string;
  awardedAt: Date;
  loans: number;
  upb: number;
  price: number;
  lien: string;
  performance: string;
  // Percent of UPB.
  awardOfUpb: number;
  low: number;
  high: number;
  mid: number;
  error: number;
  inRange: boolean;
};

export type BacktestStats = { count: number; medianError: number | null; meanAbsError: number | null; bias: number | null; inRange: number | null };

export type BacktestGroup = BacktestStats & { key: string; label: string };

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

// Median error and bias are signed; mean absolute error is not. inRange is the share of awards inside the range.
export function backtestStats(rows: Pick<BacktestRow, "error" | "inRange">[]): BacktestStats {
  const errors = rows.map((row) => row.error);
  return {
    count: rows.length,
    medianError: median(errors),
    meanAbsError: mean(errors.map(Math.abs)),
    bias: mean(errors),
    inRange: rows.length ? rows.filter((row) => row.inRange).length / rows.length : null,
  };
}

export function backtestGroups(rows: BacktestRow[], by: "lien" | "performance"): BacktestGroup[] {
  const groups = new Map<string, BacktestRow[]>();
  for (const row of rows) {
    const key = by === "lien" ? row.lien : row.performance;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([key, members]) => ({ key, label: labelOf(by === "lien" ? "lien" : "payment", key), ...backtestStats(members) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// One award against its range. Null when the range can't be priced, which the page counts but doesn't score.
export function scoreAward(input: { price: number; upb: number; low: number; high: number }) {
  if (!(input.upb > 0) || !(input.price > 0)) return null;
  const awardOfUpb = (input.price / input.upb) * 100;
  const mid = (input.low + input.high) / 2;
  return { awardOfUpb, mid, error: awardOfUpb - mid, inRange: awardOfUpb >= input.low - 1e-9 && awardOfUpb <= input.high + 1e-9 };
}

export type Backtest = { rows: BacktestRow[]; unpriced: number; overall: BacktestStats; byLien: BacktestGroup[]; byPerformance: BacktestGroup[]; enough: boolean; targetYield: number | null };

// Every buyer award that hasn't been canceled. A desk purchase is left out: the desk's own bid often comes from the
// same model, so it would grade the model against itself.
export async function loadBacktest(now = new Date(), limit = 500): Promise<Backtest> {
  const [settings, closings] = await Promise.all([
    getSettings(),
    prisma.closing.findMany({
      where: { status: { not: "CANCELED" }, inquiryId: { not: null } },
      select: { id: true, listingId: true, noteId: true, noteIds: true, salePrice: true, openedAt: true, listing: { select: { title: true, notes: true } } },
      orderBy: { openedAt: "desc" },
      take: limit,
    }),
  ]);
  const earliest = closings.reduce((first, closing) => (closing.openedAt < first ? closing.openedAt : first), now);
  const months = Math.ceil((now.getTime() - earliest.getTime()) / (30 * 24 * 60 * 60 * 1000)) + COMP_WINDOW_MONTHS + 1;
  const trades = await loadClosedTrades(now, months).catch(() => [] as ClosedTrade[]);
  const rows: BacktestRow[] = [];
  let unpriced = 0;
  for (const closing of closings) {
    const at = closing.openedAt;
    const since = new Date(at);
    since.setMonth(since.getMonth() - COMP_WINDOW_MONTHS);
    const before = trades.filter((trade) => trade.closedAt < at && trade.closedAt >= since);
    const loans = closingLoans(closing, closing.listing.notes);
    const notes: IndicativeNote[] = loans.map((note) => ({
      upb: note.upb,
      interestRate: note.interestRate,
      monthlyPi: note.monthlyPi,
      estimatedValue: note.estimatedValue,
      state: note.state,
      paymentStatus: note.paymentStatus,
      occupancy: note.occupancy,
      lienPosition: note.lienPosition,
      monthsDelinquent: note.monthsDelinquent,
      maturityDate: note.maturityDate,
      foreclosureFiledAt: note.foreclosureFiledAt ?? null,
      avm: { value: showableAvm({ avmValue: note.avmValue, avmProvider: note.avmProvider }), provider: note.avmProvider, asOf: note.avmAsOf },
      valueType: note.valueType ?? null,
      valueAsOf: note.valueAsOf ?? null,
    }));
    const subject = notes.length ? compSubjectOf(notes) : null;
    const range = subject
      ? indicativeRange({ notes, targetYield: settings.indicativeTargetYield, comps: compsFor(subject, before), compsWindowMonths: COMP_WINDOW_MONTHS, standing: [], premiumBps: settings.buyerPremiumBps, now: at })
      : null;
    const upb = notes.reduce((sum, note) => sum + note.upb, 0);
    const score = range ? scoreAward({ price: Number(closing.salePrice), upb, low: range.low, high: range.high }) : null;
    if (!range || !score || !subject) {
      unpriced += 1;
      continue;
    }
    rows.push({
      closingId: closing.id,
      listingId: closing.listingId,
      title: closing.listing.title,
      awardedAt: at,
      loans: loans.length,
      upb,
      price: Number(closing.salePrice),
      lien: subject.lienPosition,
      performance: subject.paymentStatus,
      awardOfUpb: score.awardOfUpb,
      low: range.low,
      high: range.high,
      mid: score.mid,
      error: score.error,
      inRange: score.inRange,
    });
  }
  return {
    rows,
    unpriced,
    overall: backtestStats(rows),
    byLien: backtestGroups(rows, "lien"),
    byPerformance: backtestGroups(rows, "performance"),
    enough: rows.length >= MIN_AWARDS,
    targetYield: settings.indicativeTargetYield,
  };
}
