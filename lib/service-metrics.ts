import { CLOSING_STEPS } from "@/lib/closing";
import { DUPLICATE_COMMENT } from "@/lib/duplicates";
import { prisma } from "@/lib/prisma";
import { reviewKey } from "@/lib/screening";

// How fast the desk works, for a bank's vendor review and UPB's own board: listing review, bidder questions, closings,
// payout accounts and the holds the desk clears. Every figure comes from timestamps and audit events already on file,
// counted in the period its event ended, and none is shown from fewer than SERVICE_MIN_EVENTS events. The risk queue
// shows the last 90 days (app/(desk)/admin/risk), and the board pack each month (lib/board-pack.ts).

export const SERVICE_MIN_EVENTS = 5;
export const SERVICE_WINDOW_DAYS = 90;
export const NOT_ENOUGH_DATA = `Not enough data (n < ${SERVICE_MIN_EVENTS})`;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type ServiceKey = "listingReview" | "questions" | "closing" | "payoutAccounts" | "duplicateHolds" | "sanctionsReviews";
export type ServiceUnit = "hours" | "days";

export const SERVICE_METRICS: { key: ServiceKey; label: string; unit: ServiceUnit; p90?: boolean; definition: string }[] = [
  { key: "listingReview", label: "Listing review", unit: "hours", p90: true, definition: "From a listing's submission to the desk's first decision on it: approve, changes requested or decline." },
  { key: "questions", label: "Bidder questions", unit: "hours", definition: "From a bidder's question to its published answer, or to the desk closing it without one." },
  { key: "closing", label: "Closing", unit: "days", definition: "From the award, when the closing opens, to the closing completed." },
  { key: "payoutAccounts", label: "Payout accounts", unit: "hours", definition: "From a seller or broker adding a payout account to a second desk member verifying it after the call-back." },
  { key: "duplicateHolds", label: "Duplicate holds cleared", unit: "hours", definition: "From the duplicate check flagging a listing to the desk clearing the match with a note." },
  { key: "sanctionsReviews", label: "Sanctions reviews cleared", unit: "hours", definition: "From the screen that opened a review to the desk clearing it as a false match, once per party, name and list entry." },
];

export const STEP_DEFINITION = "From the award to each step marked complete, for steps completed in the period.";

export type ServiceRange = { start: Date; end: Date };
export type ServiceFigure = { count: number; median: number | null; p90: number | null };
export type ServiceFigures = Record<ServiceKey, ServiceFigure> & { closingSteps: Record<string, ServiceFigure> };

// An event: when it ended, and how long it took in its metric's unit.
export type ServiceEvent = { at: Date; value: number };
export type ServiceEvents = Record<ServiceKey, ServiceEvent[]> & { closingSteps: Record<string, ServiceEvent[]> };

// Linear between the two nearest values, so the median of an even count is the mean of the middle two.
export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

export function serviceFigure(values: number[]): ServiceFigure {
  if (values.length < SERVICE_MIN_EVENTS) return { count: values.length, median: null, p90: null };
  return { count: values.length, median: percentile(values, 0.5), p90: percentile(values, 0.9) };
}

const hours = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / HOUR);
const days = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / DAY);
const inRange = (at: Date, range: ServiceRange) => at.getTime() >= range.start.getTime() && at.getTime() < range.end.getTime();

// The figures for one period, from events loaded over it or over a wider window.
export function serviceFigures(events: ServiceEvents, range: ServiceRange): ServiceFigures {
  const pick = (list: ServiceEvent[]) => serviceFigure(list.filter((event) => inRange(event.at, range)).map((event) => event.value));
  return {
    listingReview: pick(events.listingReview),
    questions: pick(events.questions),
    closing: pick(events.closing),
    payoutAccounts: pick(events.payoutAccounts),
    duplicateHolds: pick(events.duplicateHolds),
    sanctionsReviews: pick(events.sanctionsReviews),
    closingSteps: Object.fromEntries(CLOSING_STEPS.map((step) => [step.key, pick(events.closingSteps[step.key] ?? [])])),
  };
}

const DECISIONS = ["APPROVE", "REQUEST_CHANGES", "REJECT"] as const;

// Every event that ended in the range.
export async function loadServiceEvents(range: ServiceRange): Promise<ServiceEvents> {
  const between = { gte: range.start, lt: range.end };
  const [decided, questions, closings, steps, accounts, cleared, reviews] = await Promise.all([
    prisma.reviewComment.findMany({ where: { action: { in: [...DECISIONS] }, createdAt: between }, select: { listingId: true } }),
    prisma.listingQuestion.findMany({ where: { status: { in: ["ANSWERED", "DECLINED"] }, answeredAt: between }, select: { createdAt: true, answeredAt: true } }),
    prisma.closing.findMany({ where: { status: "COMPLETE", closedAt: between }, select: { openedAt: true, closedAt: true } }),
    prisma.closingStep.findMany({ where: { status: "COMPLETE", completedAt: between }, select: { key: true, completedAt: true, closing: { select: { openedAt: true } } } }),
    prisma.payoutAccount.findMany({ where: { verifiedAt: between }, select: { createdAt: true, verifiedAt: true } }),
    prisma.auditEvent.findMany({ where: { action: "DUPLICATE_CLEARED", entityType: "listing", createdAt: between }, select: { entityId: true, createdAt: true } }),
    prisma.ofacCheck.findMany({
      where: { result: "REVIEW", status: "CLEARED", reviewedAt: between },
      select: { id: true, name: true, matched: true, userId: true, listingId: true, createdAt: true, reviewedAt: true },
    }),
  ]);

  // A listing's first decision after its submission, when that fell in the range. Decisions before the range are read
  // too, so a later decision on the same listing isn't taken for its first.
  const listingIds = [...new Set(decided.map((row) => row.listingId))];
  const [listings, history] = listingIds.length
    ? await Promise.all([
        prisma.listing.findMany({ where: { id: { in: listingIds } }, select: { id: true, submittedAt: true } }),
        prisma.reviewComment.findMany({ where: { listingId: { in: listingIds }, action: { in: [...DECISIONS] }, createdAt: { lt: range.end } }, select: { listingId: true, createdAt: true } }),
      ])
    : [[], []];
  const listingReview = listings.flatMap((listing) => {
    const first = history
      .filter((row) => row.listingId === listing.id && row.createdAt.getTime() >= listing.submittedAt.getTime())
      .reduce<Date | null>((at, row) => (!at || row.createdAt < at ? row.createdAt : at), null);
    return first && inRange(first, range) ? [{ at: first, value: hours(listing.submittedAt, first) }] : [];
  });

  // A clearance pairs with the latest flag before it.
  const clearedIds = [...new Set(cleared.map((row) => row.entityId))];
  const flags = clearedIds.length
    ? await prisma.reviewComment.findMany({ where: { listingId: { in: clearedIds }, comment: { startsWith: DUPLICATE_COMMENT }, createdAt: { lt: range.end } }, select: { listingId: true, createdAt: true } })
    : [];
  const duplicateHolds = cleared.flatMap((event) => {
    const flagged = flags
      .filter((flag) => flag.listingId === event.entityId && flag.createdAt.getTime() <= event.createdAt.getTime())
      .reduce<Date | null>((at, flag) => (!at || flag.createdAt > at ? flag.createdAt : at), null);
    return flagged ? [{ at: event.createdAt, value: hours(flagged, event.createdAt) }] : [];
  });

  // One decision covers every open screen of the same party, name and list entry (lib/screening.ts), so it counts
  // once, from the earliest. A screen that took over an earlier decision was cleared before it was made, and isn't one.
  const decisions = new Map<string, { opened: Date; at: Date }>();
  for (const row of reviews) {
    if (!row.reviewedAt || row.reviewedAt.getTime() < row.createdAt.getTime()) continue;
    const key = `${reviewKey(row)}|${row.reviewedAt.getTime()}`;
    const known = decisions.get(key);
    if (!known || row.createdAt < known.opened) decisions.set(key, { opened: row.createdAt, at: row.reviewedAt });
  }

  const closingSteps: Record<string, ServiceEvent[]> = {};
  for (const step of steps) {
    if (!step.completedAt) continue;
    (closingSteps[step.key] ??= []).push({ at: step.completedAt, value: days(step.closing.openedAt, step.completedAt) });
  }

  return {
    listingReview,
    questions: questions.flatMap((row) => (row.answeredAt ? [{ at: row.answeredAt, value: hours(row.createdAt, row.answeredAt) }] : [])),
    closing: closings.flatMap((row) => (row.closedAt ? [{ at: row.closedAt, value: days(row.openedAt, row.closedAt) }] : [])),
    payoutAccounts: accounts.flatMap((row) => (row.verifiedAt ? [{ at: row.verifiedAt, value: hours(row.createdAt, row.verifiedAt) }] : [])),
    duplicateHolds,
    sanctionsReviews: [...decisions.values()].map((row) => ({ at: row.at, value: hours(row.opened, row.at) })),
    closingSteps,
  };
}

// The last 90 days to now, as the risk queue shows them.
export async function serviceMetrics(now = new Date(), windowDays = SERVICE_WINDOW_DAYS) {
  const range = { start: new Date(now.getTime() - windowDays * DAY), end: now };
  return { range, figures: serviceFigures(await loadServiceEvents(range), range) };
}

export function formatService(value: number | null, unit: ServiceUnit) {
  if (value == null) return NOT_ENOUGH_DATA;
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
}
