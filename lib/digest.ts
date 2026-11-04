import { periodPassed } from "@/lib/schedule";

const DAY = 24 * 60 * 60 * 1000;

// The window always starts at the last digest, so a late or skipped run never drops the matches in between.
export function digestSince(frequency: string, last: Date | null, now = new Date()) {
  if (frequency === "OFF") return null;
  const period = (frequency === "DAILY" ? 1 : 7) * DAY;
  if (last && !periodPassed(last, period, now)) return null;
  // A digest switched back on after a long break reaches back 30 days at most.
  const floor = new Date(now.getTime() - 30 * DAY);
  if (!last) return new Date(now.getTime() - period);
  return last > floor ? last : floor;
}

export function digestBody(matches: { title: string; score: number }[]) {
  if (!matches.length) return "";
  const lines = matches.slice(0, 12).map((match) => `${match.title} · score ${match.score}`);
  return `New paper fits a buy box.\n\n${lines.join("\n")}`;
}
