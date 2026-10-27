export function digestSince(frequency: string, last: Date | null, now = new Date()) {
  if (frequency === "OFF") return null;
  const days = frequency === "DAILY" ? 1 : 7;
  if (last && now.getTime() - last.getTime() < days * 86400000) return null;
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - days);
  return last && last > since ? last : since;
}

export function digestBody(matches: { title: string; score: number }[]) {
  if (!matches.length) return "";
  const lines = matches.slice(0, 12).map((match) => `${match.title} · score ${match.score}`);
  return `New paper fits a buy box.\n\n${lines.join("\n")}`;
}
