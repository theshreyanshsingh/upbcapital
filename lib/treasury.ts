import { audit } from "@/lib/audit";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache } from "@/lib/settings";

// The 10-year Treasury rate from Treasury's daily par yield curve, read once a day by the jobs run. The feed is an
// Atom document of OData entries, one per business day, each with d:NEW_DATE ("2025-10-01T00:00:00") and
// d:BC_10YEAR ("4.12"), as Treasury documents at home.treasury.gov/treasury-daily-interest-rate-xml-feed.
//
// A rate the desk types in still wins until the next business day, so the desk can override a bad read. A failed
// read leaves the rate on file alone and is logged.

export const TREASURY_FEED = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";
export const TREASURY_SOURCE = "TREASURY";
export const MANUAL_SOURCE = "MANUAL";
const TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ParYield = { date: string; rate: number };

// The month's feed: ?data=daily_treasury_yield_curve&field_tdr_date_value_month=YYYYMM. TREASURY_FEED_URL points
// it elsewhere, and "off" stops the read, for a desk run without the internet.
export function treasuryUrl(month: string, base = process.env.TREASURY_FEED_URL || TREASURY_FEED) {
  return `${base}?data=daily_treasury_yield_curve&field_tdr_date_value_month=${month}`;
}

// A day as New York reads it, "2026-11-06". Treasury dates its curve in Eastern time.
export function easternDay(at: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// The weekday after this day, "2026-11-06" (a Friday) to "2026-11-09". Federal holidays aren't counted out; a
// manual rate entered before one simply gives way a day sooner.
export function nextBusinessDay(day: string) {
  const date = new Date(`${day}T12:00:00.000Z`);
  do {
    date.setTime(date.getTime() + DAY_MS);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}

function monthOf(day: string) {
  return day.slice(0, 7).replace("-", "");
}

function monthBefore(month: string) {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(4)) - 1;
  return index === 0 ? `${year - 1}12` : `${year}${String(index).padStart(2, "0")}`;
}

// Every day in the feed with a 10-year yield, oldest first. A day with no 10-year, or a figure outside 0 to 20%,
// is left out rather than read as a rate.
export function parseParYields(xml: string): ParYield[] {
  const rows: ParYield[] = [];
  for (const entry of xml.split(/<entry\b/).slice(1)) {
    const date = /<d:NEW_DATE\b[^>]*>\s*(\d{4}-\d{2}-\d{2})/.exec(entry)?.[1];
    const text = /<d:BC_10YEAR\b[^>]*>([^<]*)<\/d:BC_10YEAR>/.exec(entry)?.[1]?.trim();
    if (!date || !text || !/^\d+(\.\d+)?$/.test(text)) continue;
    const rate = Number(text);
    if (rate > 0 && rate <= 20) rows.push({ date, rate });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export function latestParYield(xml: string): ParYield | null {
  const rows = parseParYields(xml);
  return rows.length ? rows[rows.length - 1] : null;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

// The latest 10-year in this month's feed, or last month's when this month has none yet.
export async function readTenYear(now = new Date(), fetcher: Fetcher = fetch): Promise<ParYield> {
  const month = monthOf(easternDay(now));
  for (const target of [month, monthBefore(month)]) {
    const response = await fetcher(treasuryUrl(target), { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/xml" } });
    if (!response.ok) throw new Error(`Treasury answered ${response.status}`);
    const latest = latestParYield(await response.text());
    if (latest) return latest;
  }
  throw new Error("Treasury's feed had no 10-year rate for this month or last");
}

export type RateOnFile = { rate: number | null; asOf: Date | null; source: string | null };

// Whether a read replaces the rate on file. A desk entry holds until the business day after it was entered, and
// even then gives way only to a newer day's curve, so the bad read it overrode can't come back. A Treasury rate
// gives way to a newer day, or to a correction of the same day.
export function treasuryDecision(input: { current: RateOnFile; enteredAt: Date | null; read: ParYield; now: Date }): { apply: boolean; reason: string } {
  const { current, read } = input;
  if (current.rate == null || !current.asOf) return { apply: true, reason: "no rate on file" };
  const onFile = current.asOf.toISOString().slice(0, 10);
  if (current.source !== TREASURY_SOURCE) {
    const holdsUntil = nextBusinessDay(easternDay(input.enteredAt ?? current.asOf));
    if (easternDay(input.now) < holdsUntil) return { apply: false, reason: `the desk's entry holds until ${prettyDate(new Date(`${holdsUntil}T12:00:00.000Z`))}` };
    if (read.date <= onFile) return { apply: false, reason: "the desk's entry is as recent as Treasury's latest" };
    return { apply: true, reason: "a newer curve than the desk's entry" };
  }
  if (read.date < onFile) return { apply: false, reason: "the rate on file is newer" };
  if (read.date === onFile && read.rate === current.rate) return { apply: false, reason: "unchanged" };
  return { apply: true, reason: read.date === onFile ? "a correction" : "a newer curve" };
}

export type TreasuryResult = { ok: boolean; applied: boolean; line: string; read: ParYield | null };

// The job: read the curve and store the 10-year when it wins. Nothing is written when the read fails.
export async function refreshTenYear(now = new Date(), options: { fetcher?: Fetcher; rescore?: boolean } = {}): Promise<TreasuryResult> {
  if (!options.fetcher && process.env.TREASURY_FEED_URL === "off") return { ok: true, applied: false, line: "Treasury read is off", read: null };
  let read: ParYield;
  try {
    read = await readTenYear(now, options.fetcher ?? fetch);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
    console.error("[upb-jobs] the Treasury 10-year read failed, so the rate on file stays:", reason);
    return { ok: false, applied: false, line: `Treasury read failed (${reason}); the rate on file stays`, read: null };
  }
  const settings = await prisma.platformSettings.findUnique({ where: { id: "default" } });
  const current: RateOnFile = { rate: settings?.tenYearRate ?? null, asOf: settings?.tenYearAsOf ?? null, source: settings?.tenYearSource ?? null };
  const entered = current.source === TREASURY_SOURCE ? null : await prisma.auditEvent.findFirst({ where: { action: "MARKET_RATES", entityType: "settings" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const decision = treasuryDecision({ current, enteredAt: entered?.createdAt ?? null, read, now });
  const label = `10-year ${read.rate}% as of ${read.date}`;
  if (!decision.apply) return { ok: true, applied: false, line: `Treasury ${label} not applied: ${decision.reason}`, read };
  const data = { tenYearRate: read.rate, tenYearAsOf: new Date(`${read.date}T00:00:00.000Z`), tenYearSource: TREASURY_SOURCE };
  // Written only if the settings are as they were read, so a desk entry saved a moment ago isn't overwritten.
  const wrote = settings
    ? await prisma.platformSettings.updateMany({ where: { id: "default", updatedAt: settings.updatedAt }, data })
    : await prisma.platformSettings.create({ data: { id: "default", ...data } }).then(() => ({ count: 1 }));
  if (wrote.count !== 1) return { ok: true, applied: false, line: `Treasury ${label} not applied: the settings changed during the read`, read };
  clearSettingsCache();
  await audit(null, "TREASURY_RATE", "settings", "default", `${label} from Treasury's daily par yield curve (${decision.reason})`);
  // A new rate reprices every spread rule's open matches, as a desk entry does.
  let repriced = 0;
  if (options.rescore !== false) repriced = await import("@/lib/matching").then((matching) => matching.rescoreSpreadBoxes());
  return { ok: true, applied: true, line: `Treasury ${label} stored${repriced ? `, ${repriced} spread rule${repriced === 1 ? "" : "s"} repriced` : ""}`, read };
}

// For runJobs: a failed read shows as a failed job in the run record, with the rate left alone.
export async function treasuryJob(now = new Date()) {
  const result = await refreshTenYear(now);
  if (!result.ok) throw new Error(result.line);
  return result.line;
}
