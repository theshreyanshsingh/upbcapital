export function taskNeedsReminder(task: { dueOn: Date; doneAt: Date | null; remindedAt: Date | null }, now = new Date()) {
  if (task.doneAt) return false;
  if (task.dueOn.getTime() - now.getTime() > 48 * 60 * 60 * 1000) return false;
  if (!task.remindedAt) return true;
  return now.getTime() - task.remindedAt.getTime() >= 24 * 60 * 60 * 1000;
}

export function bidNeedsReminder(listing: { bidMode: string; bidDeadline: Date | null; bidReminderAt: Date | null }, now = new Date()) {
  if (listing.bidMode === "NONE" || !listing.bidDeadline || listing.bidReminderAt) return false;
  const remaining = listing.bidDeadline.getTime() - now.getTime();
  return remaining > 0 && remaining <= 24 * 60 * 60 * 1000;
}
