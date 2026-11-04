import { CLOSING_STEPS } from "@/lib/closing";
import { periodPassed } from "@/lib/schedule";

export const DEFAULT_CLOSING_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

// Where each step falls in the run to the target close. At 30 days: 3, 6, 15, 21, 27, 30.
const SHARE: Record<string, number> = {
  PURCHASE_AGREEMENT: 0.1,
  BUYER_DEPOSIT: 0.2,
  COLLATERAL_TRANSFER: 0.5,
  ASSIGNMENT: 0.7,
  PAYMENT_RECEIVED: 0.9,
  CLOSED: 1,
};

// Who has to move for a step, so a reminder reaches them and not only the desk.
export const STEP_OWNER: Record<string, "both" | "buyer" | "seller" | "desk"> = {
  PURCHASE_AGREEMENT: "both",
  BUYER_DEPOSIT: "buyer",
  COLLATERAL_TRANSFER: "seller",
  ASSIGNMENT: "seller",
  PAYMENT_RECEIVED: "buyer",
  CLOSED: "desk",
};

// The buyer's deposit at award: a share of the price, due within a few days. Agency loan sales ask for one within
// two business days of the win; three calendar days covers a Friday award.
export const DEFAULT_DEPOSIT_BPS = 1000;
export const DEFAULT_DEPOSIT_DAYS = 3;

export function depositTerms(settings: { depositBps?: number | null; depositDays?: number | null }) {
  const bps = settings.depositBps != null && settings.depositBps >= 0 && settings.depositBps <= 5000 ? Math.round(settings.depositBps) : DEFAULT_DEPOSIT_BPS;
  const days = settings.depositDays != null && settings.depositDays >= 1 && settings.depositDays <= 30 ? Math.round(settings.depositDays) : DEFAULT_DEPOSIT_DAYS;
  return { bps, days };
}

export function depositCents(salePrice: number, bps: number) {
  return Math.round((salePrice * bps) / 100);
}

export function targetDays(setting: number | null | undefined) {
  return setting && setting >= 5 && setting <= 180 ? Math.round(setting) : DEFAULT_CLOSING_DAYS;
}

export function closingSchedule(openedAt: Date, days: number) {
  const due = Object.fromEntries(CLOSING_STEPS.map((step) => [step.key, new Date(openedAt.getTime() + Math.round(SHARE[step.key] * days) * DAY)]));
  return { targetCloseAt: new Date(openedAt.getTime() + days * DAY), due: due as Record<string, Date> };
}

type ClockClosing = { openedAt: Date; targetCloseAt: Date | null };
type ClockStep = { key: string; status: string; dueAt: Date | null };

// A step's own date wins. Older closings, and steps the desk never dated, fall on the schedule to the target.
export function effectiveDue(step: ClockStep, closing: ClockClosing, days: number) {
  if (step.dueAt) return step.dueAt;
  const span = closing.targetCloseAt ? Math.max(1, Math.round((closing.targetCloseAt.getTime() - closing.openedAt.getTime()) / DAY)) : days;
  return closingSchedule(closing.openedAt, span).due[step.key] ?? null;
}

export function effectiveTarget(closing: ClockClosing, days: number) {
  return closing.targetCloseAt ?? new Date(closing.openedAt.getTime() + days * DAY);
}

export type StepClock = "done" | "overdue" | "due_soon" | "on_track";

export function stepClock(status: string, due: Date | null, now = new Date()): StepClock {
  if (status === "COMPLETE") return "done";
  if (!due) return "on_track";
  const left = due.getTime() - now.getTime();
  if (left < 0) return "overdue";
  return left <= 2 * DAY ? "due_soon" : "on_track";
}

export function stepNeedsReminder(step: { status: string; remindedAt: Date | null }, due: Date | null, now = new Date()) {
  const clock = stepClock(step.status, due, now);
  if (clock !== "overdue" && clock !== "due_soon") return false;
  return !step.remindedAt || periodPassed(step.remindedAt, DAY, now);
}

export function closingClock(closing: ClockClosing & { status: string; closedAt: Date | null }, steps: ClockStep[], days: number, now = new Date()) {
  const dated = steps.map((step) => ({ ...step, due: effectiveDue(step, closing, days) }));
  const open = dated.filter((step) => step.status !== "COMPLETE");
  const overdue = open.filter((step) => stepClock(step.status, step.due, now) === "overdue");
  const next = [...open].sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity))[0] ?? null;
  const target = effectiveTarget(closing, days);
  const end = closing.closedAt ?? now;
  return {
    target,
    overdue: closing.status === "OPEN" ? overdue.length : 0,
    next: closing.status === "OPEN" ? next : null,
    daysOpen: Math.max(0, Math.floor((end.getTime() - closing.openedAt.getTime()) / DAY)),
    late: closing.status === "OPEN" && target.getTime() < now.getTime(),
  };
}

export function daysBetween(from: Date, to: Date) {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY));
}

// Close rate counts only files that finished one way or the other.
export function closingStats(closings: { status: string; openedAt: Date; closedAt: Date | null }[]) {
  const complete = closings.filter((closing) => closing.status === "COMPLETE" && closing.closedAt);
  const canceled = closings.filter((closing) => closing.status === "CANCELED").length;
  const days = complete.map((closing) => daysBetween(closing.openedAt, closing.closedAt!));
  return {
    complete: complete.length,
    canceled,
    closeRate: complete.length + canceled ? complete.length / (complete.length + canceled) : null,
    averageDays: days.length ? days.reduce((sum, value) => sum + value, 0) / days.length : null,
  };
}
