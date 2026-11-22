// MongoDB keeps an optional field off a document until something writes it, and Prisma's `field: null` then
// matches only an explicit null, never the missing field. This matches both, so "not yet read", "not yet
// reminded" and the like find the records they mean to.
export function unset<K extends string>(field: K) {
  return { OR: [{ [field]: null }, { [field]: { isSet: false } }] } as { OR: Record<K, null | { isSet: false }>[] };
}

// Prisma's case-insensitive `contains` on MongoDB becomes a regex without escaping, so "[" crashes the query
// and ".*" or a nested quantifier becomes a pattern the database runs. Escaping makes it a plain-text match.
export function literal(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Oldest first, the order keptWithinLimit reads rivals in.
export const OLDEST_FIRST = [{ createdAt: "asc" as const }, { id: "asc" as const }];

// MongoDB has no count constraint, so rows written at the same moment can each pass a limit's count before any of
// them is in, and an older row can even land after a newer one has counted. So a row just written is counted again
// with its rivals, oldest first: it stays when they are within the limit, and goes when older rows fill the limit. In
// between it waits a moment for the newer ones to go, and goes if they don't, so the limit holds however they land.
// The wait doubles from 25ms to about 3s in all, and only rows that collide wait at all. A shorter wait let the
// older rows give up too on a loaded server, leaving a firm two of its five open requests (stress test, November
// 2026). A row already gone, taken out by its own caller, goes at once.
export async function keptWithinLimit(id: string, limit: number, rivals: () => Promise<{ id: string }[]>) {
  for (let tries = 0; ; tries += 1) {
    const rows = await rivals();
    const rank = rows.findIndex((row) => row.id === id);
    if (rank < 0) return false;
    if (rows.length <= limit) return true;
    if (tries === LIMIT_TRIES || rank >= limit) return false;
    await new Promise((resolve) => setTimeout(resolve, 25 << tries));
  }
}

const LIMIT_TRIES = 7;
