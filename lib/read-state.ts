export function messageWasRead(createdAt: Date, otherReads: (Date | null)[]) {
  if (!otherReads.length) return false;
  return otherReads.every((read) => read != null && read.getTime() >= createdAt.getTime());
}
