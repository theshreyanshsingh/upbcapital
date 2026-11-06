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

// Settlement days: the weekdays the desk batches wires on, as "TUE,THU". Dates are UTC, as everywhere on the desk.
export const SETTLEMENT_WEEKDAYS = [
  { key: "MON", day: 1, label: "Monday" },
  { key: "TUE", day: 2, label: "Tuesday" },
  { key: "WED", day: 3, label: "Wednesday" },
  { key: "THU", day: 4, label: "Thursday" },
  { key: "FRI", day: 5, label: "Friday" },
] as const;
const BUSINESS_DAYS = SETTLEMENT_WEEKDAYS.map((weekday) => weekday.day);

// The desk's settlement weekdays. Missing, empty or unreadable means any business day.
export function settlementWeekdays(setting: string | null | undefined): number[] {
  const keys = String(setting ?? "").toUpperCase().split(",").map((part) => part.trim());
  const days = SETTLEMENT_WEEKDAYS.filter((weekday) => keys.includes(weekday.key)).map((weekday) => weekday.day);
  return days.length ? days : BUSINESS_DAYS;
}

// What the settings form saves: the chosen weekdays in week order, or null for any business day.
export function settlementSetting(chosen: string[]) {
  const keys = SETTLEMENT_WEEKDAYS.filter((weekday) => chosen.includes(weekday.key)).map((weekday) => weekday.key);
  return keys.length && keys.length < SETTLEMENT_WEEKDAYS.length ? keys.join(",") : null;
}

export function settlementLabel(setting: string | null | undefined) {
  const days = settlementWeekdays(setting);
  if (days.length === BUSINESS_DAYS.length) return "any business day";
  const names = SETTLEMENT_WEEKDAYS.filter((weekday) => days.includes(weekday.day)).map((weekday) => `${weekday.label}s`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// The first settlement day on or after this date, at the same time of day.
export function nextSettlementDay(date: Date, weekdays: number[]) {
  const days = weekdays.length ? weekdays : BUSINESS_DAYS;
  for (let ahead = 0; ahead < 7; ahead += 1) {
    const candidate = new Date(date.getTime() + ahead * DAY);
    if (days.includes(candidate.getUTCDay())) return candidate;
  }
  return date;
}

// "Tuesday, Nov 18".
export function settlesOn(date: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

// The money lands and the file closes on a settlement day, so those two steps move to the next one. The rest of the
// run keeps its spacing. Without weekdays the schedule is the plain spread, which is how older closings read theirs.
export function closingSchedule(openedAt: Date, days: number, settlement?: number[]) {
  const due = Object.fromEntries(CLOSING_STEPS.map((step) => [step.key, new Date(openedAt.getTime() + Math.round(SHARE[step.key] * days) * DAY)])) as Record<string, Date>;
  if (!settlement) return { targetCloseAt: new Date(openedAt.getTime() + days * DAY), due };
  due.PAYMENT_RECEIVED = nextSettlementDay(due.PAYMENT_RECEIVED, settlement);
  due.CLOSED = nextSettlementDay(due.CLOSED, settlement);
  return { targetCloseAt: due.CLOSED, due };
}

type ClockClosing = { openedAt: Date; targetCloseAt: Date | null };
type ClockStep = { key: string; status: string; dueAt: Date | null };

// A step's own date wins. Older closings, and steps the desk never dated, fall on the schedule to the target. That
// schedule is never snapped to settlement days, so an existing closing keeps the dates it always showed.
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
