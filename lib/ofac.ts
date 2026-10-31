import { SDN_NAMES, bestHit, indexNames, parseSanctionNames, parseTreasuryLists, type SanctionEntry } from "@/lib/sdn";

export type ScreenProvider = "local" | "live" | "treasury";
// unavailable means a real list is configured but could not be read. That is not a clear result, so approvals stop on it.
export type Screen = { provider: ScreenProvider; result: "CLEAR" | "REVIEW"; detail: string; matched?: string; unavailable?: boolean };
export type SanctionSource = { provider: ScreenProvider; index: SanctionEntry[]; count: number; fetchedAt: Date | null; note: string; unavailable: boolean };

type Env = Record<string, string | undefined>;

const LIST_LABEL: Record<ScreenProvider, string> = { local: "local stand-in", live: "parsed vendor", treasury: "OFAC SDN" };
const LOCAL_INDEX = indexNames(SDN_NAMES);
const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

function screenIndex(name: string, index: SanctionEntry[], provider: ScreenProvider): Screen {
  const cleaned = name.trim();
  if (!cleaned) return { provider, result: "CLEAR", detail: "No name to screen." };
  const hit = bestHit(cleaned, index);
  if (!hit) return { provider, result: "CLEAR", detail: `No fuzzy match on the ${LIST_LABEL[provider]} list.` };
  return {
    provider,
    result: "REVIEW",
    matched: hit.entry,
    detail: `Matched “${hit.entry}” at ${Math.round(hit.score * 100)}% on the ${LIST_LABEL[provider]} list. A person has to clear it.`,
  };
}

export function screenOfac(name: string, names: string[] = SDN_NAMES, provider: ScreenProvider = "local"): Screen {
  return screenIndex(name, names === SDN_NAMES ? LOCAL_INDEX : indexNames(names), provider);
}

export function ofacMode(env: Env = process.env) {
  if (env.OFAC_API_URL && env.OFAC_API_KEY) return "configured";
  if (env.OFAC_SDN_URL) return "treasury";
  return "mock";
}

function localSource(note = ""): SanctionSource {
  return { provider: "local", index: LOCAL_INDEX, count: SDN_NAMES.length, fetchedAt: null, note, unavailable: Boolean(note) };
}

async function readList(url: string, headers: Record<string, string> = {}) {
  // no-store: Next would otherwise try to keep this multi-megabyte body in its fetch cache.
  const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`The list returned ${response.status}.`);
  return response.text();
}

async function fetchSource(env: Env): Promise<SanctionSource> {
  if (ofacMode(env) === "configured") {
    const body = await readList(env.OFAC_API_URL!, { Authorization: `Bearer ${env.OFAC_API_KEY}`, Accept: "application/json, text/csv, text/plain" });
    const remote = parseSanctionNames(body);
    if (!remote.length) throw new Error("The vendor body had no names to parse.");
    return { provider: "live", index: indexNames([...SDN_NAMES, ...remote]), count: remote.length, fetchedAt: new Date(), note: "", unavailable: false };
  }
  const sdnUrl = env.OFAC_SDN_URL!;
  const [sdn, alt] = await Promise.all([readList(sdnUrl), readList(sdnUrl.replace(/SDN\.CSV$/i, "ALT.CSV")).catch(() => "")]);
  const remote = parseTreasuryLists(sdn, alt);
  if (remote.length < 1000) throw new Error("The SDN file looked too short to trust.");
  return { provider: "treasury", index: indexNames([...SDN_NAMES, ...remote]), count: remote.length, fetchedAt: new Date(), note: "", unavailable: false };
}

type ListState = { key: string; source: SanctionSource | null; at: number; failedAt: number; loading: Promise<void> | null };

// Kept on globalThis because Next can load this module more than once in a process, and one copy of a
// 37,000-name list is enough. Concurrent callers wait on the same download.
const store = globalThis as unknown as { upbSanctionList?: ListState };

function stateFor(key: string) {
  if (store.upbSanctionList?.key !== key) store.upbSanctionList = { key, source: null, at: 0, failedAt: 0, loading: null };
  return store.upbSanctionList;
}

// The list is a few megabytes, so one process downloads it at most every six hours. If a refresh fails it
// keeps the last good copy and says so. With no good copy the result is marked unavailable, never clear.
export async function sanctionSource(env: Env = process.env): Promise<SanctionSource> {
  if (ofacMode(env) === "mock") return localSource();
  const state = stateFor(`${env.OFAC_API_URL ?? ""}|${env.OFAC_SDN_URL ?? ""}`);
  if (state.source && Date.now() - state.at < FRESH_MS) return state.source;
  if (Date.now() - state.failedAt > RETRY_MS) {
    state.loading ??= fetchSource(env)
      .then((source) => {
        state.source = source;
        state.at = Date.now();
        state.failedAt = 0;
      })
      .catch((error) => {
        state.failedAt = Date.now();
        console.error("[upb-ofac] list refresh failed:", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        state.loading = null;
      });
    await state.loading;
    if (state.source && state.failedAt === 0) return state.source;
  }
  if (state.source) return { ...state.source, note: `The last refresh failed, so this used the copy from ${state.source.fetchedAt?.toISOString() ?? "earlier"}.` };
  return localSource("The sanctions list could not be read, so this is not a real screen. Try again in a few minutes.");
}

export async function screenParty(name: string, env: Env = process.env): Promise<Screen> {
  const source = await sanctionSource(env);
  const screen = screenIndex(name, source.index, source.provider);
  return source.note ? { ...screen, detail: `${screen.detail} ${source.note}`, unavailable: source.unavailable } : screen;
}

export async function screenParties(names: string[], env: Env = process.env) {
  const source = await sanctionSource(env);
  return { source, screens: names.map((name) => ({ name, screen: screenIndex(name, source.index, source.provider) })) };
}

// A REVIEW row needs a person's decision. Rows from before decisions existed have no status and count as open.
export function ofacOpen(row: { result: string; status?: string | null }) {
  return row.result === "REVIEW" && row.status !== "CLEARED" && row.status !== "CONFIRMED";
}

export function ofacBlocks(row: { result: string; status?: string | null }) {
  return row.result === "REVIEW" && row.status !== "CLEARED";
}
