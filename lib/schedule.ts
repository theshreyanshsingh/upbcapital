const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The cron runs once a day and its start time drifts. A marker set at yesterday's start has to count as a day old,
// or a run that starts a little earlier skips its turn.
export const RUN_SLACK = 2 * HOUR;

export function periodPassed(last: Date, period: number, now = new Date()) {
  return now.getTime() - last.getTime() >= period - RUN_SLACK;
}

export function taskNeedsReminder(task: { dueOn: Date; doneAt: Date | null; remindedAt: Date | null }, now = new Date()) {
  if (task.doneAt) return false;
  if (task.dueOn.getTime() - now.getTime() > 2 * DAY) return false;
  if (!task.remindedAt) return true;
  return periodPassed(task.remindedAt, DAY, now);
}

export function bidNeedsReminder(listing: { bidMode: string; bidDeadline: Date | null; bidReminderAt: Date | null }, now = new Date()) {
  if (listing.bidMode === "NONE" || !listing.bidDeadline || listing.bidReminderAt) return false;
  const remaining = listing.bidDeadline.getTime() - now.getTime();
  return remaining > 0 && remaining <= DAY;
}
