import { loadClosedTrades, marketView, MIN_TRADES, type CompCell, type MarketView } from "@/lib/comps";
import { unset } from "@/lib/db-filters";
import { isReleaseBuild } from "@/lib/deploy";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/email";
import { moneyCompact, prettyDate } from "@/lib/format";
import { marketRate, rateStale } from "@/lib/indicative";
import { loansForSale } from "@/lib/metrics";
import { typedNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { publicListing } from "@/lib/private-listings";
import { clearSettingsCache, getSettings, isPro } from "@/lib/settings";
import { ruleHolder, ruleOf } from "@/lib/standing-bids";

// The monthly note-market dispatch: the agency and HUD calendar and results, UPB's anonymised closed trades, the
// book and the desk's 10-year rate. It is market data, not advice. Nothing in it names a UPB trade or bidder: UPB's
// own figures show only in groups of MIN_TRADES or more, and standing demand shows as counts.

// ---------------------------------------------------------------------------------------------------------------
// Agency and HUD sales

export const AGENCY_PROGRAMS = [
  { value: "FANNIE_MAE", label: "Fannie Mae" },
  { value: "FREDDIE_MAC", label: "Freddie Mac" },
  { value: "HUD", label: "HUD" },
  { value: "OTHER", label: "Other agency" },
] as const;

export function programLabel(program: string) {
  return AGENCY_PROGRAMS.find((row) => row.value === program)?.label ?? program;
}

// The GSEs and HUD publish the cover bid, the second-highest bid, and keep the winning price private. Every figure
// from them is labelled as a cover bid, never as a clearing price.
export const COVER_BID_HEADER = "Cover bid (second-highest)";
export const COVER_BID_NOTE =
  "Agencies and HUD publish the cover bid, the second-highest bid. The winning price is not published. Read each cover with its BPO LTV: a near-par cover on a low-LTV pool is a price on the equity, not on the distress.";

export type AgencySaleRow = {
  id: string;
  program: string;
  name: string;
  bidDate: Date | null;
  settleBy: Date | null;
  loans: number | null;
  upb: number | null;
  coverPctUpb: number | null;
  coverPctBpo: number | null;
  bpoLtv: number | null;
  winner: string;
  sourceUrl: string;
  createdAt?: Date;
};

export type AgencyLine = AgencySaleRow & {
  programLabel: string;
  // "Fannie Mae, 29th NPL sale".
  label: string;
  // "Cover bid 97.08% of UPB and 48.44% of BPO, at 50% BPO LTV", or what is still to come.
  cover: string;
  stage: "upcoming" | "awaiting" | "result";
};

// A whole percent stays whole; anything finer keeps up to two places, as the agencies print it.
export function pctText(value: number) {
  return `${Number(value.toFixed(2))}%`;
}

function hasCover(sale: Pick<AgencySaleRow, "coverPctUpb" | "coverPctBpo">) {
  return sale.coverPctUpb != null || sale.coverPctBpo != null;
}

export function coverBidLabel(sale: Pick<AgencySaleRow, "coverPctUpb" | "coverPctBpo" | "bpoLtv" | "bidDate">, now = new Date()) {
  const parts: string[] = [];
  if (sale.coverPctUpb != null) parts.push(`${pctText(sale.coverPctUpb)} of UPB`);
  if (sale.coverPctBpo != null) parts.push(`${pctText(sale.coverPctBpo)} of BPO`);
  if (!parts.length) {
    if (!sale.bidDate) return "Bid date not yet announced";
    return sale.bidDate.getTime() <= now.getTime() ? "Cover bid not yet published" : "Bids not yet due";
  }
  const ltv = sale.bpoLtv != null ? `, at ${pctText(sale.bpoLtv)} BPO LTV` : "";
  return `Cover bid ${parts.join(" and ")}${ltv}`;
}

export function saleLabel(sale: Pick<AgencySaleRow, "program" | "name">) {
  const program = programLabel(sale.program);
  const name = sale.name.trim();
  return name.toLowerCase().startsWith(program.toLowerCase()) ? name : `${program}, ${name}`;
}

const DAY = 24 * 60 * 60 * 1000;
// Results stay in the dispatch for six months; a sale whose bids are due within four months is on the calendar.
export const RESULTS_WINDOW_DAYS = 183;
export const CALENDAR_AHEAD_DAYS = 120;
// A sale past its bid date with no result yet stays on the calendar this long, as awaiting results.
const AWAITING_DAYS = 120;

export function agencyLines(sales: AgencySaleRow[], now = new Date()) {
  const calendar: AgencyLine[] = [];
  const results: AgencyLine[] = [];
  for (const sale of sales) {
    const at = sale.bidDate?.getTime() ?? null;
    const base = { ...sale, programLabel: programLabel(sale.program), label: saleLabel(sale), cover: coverBidLabel(sale, now) };
    if (hasCover(sale)) {
      // A result without a bid date counts from when the desk entered it.
      const when = at ?? sale.createdAt?.getTime() ?? now.getTime();
      if (when >= now.getTime() - RESULTS_WINDOW_DAYS * DAY) results.push({ ...base, stage: "result" });
      continue;
    }
    if (at == null) calendar.push({ ...base, stage: "upcoming" });
    else if (at > now.getTime()) {
      if (at <= now.getTime() + CALENDAR_AHEAD_DAYS * DAY) calendar.push({ ...base, stage: "upcoming" });
    } else if (at >= now.getTime() - AWAITING_DAYS * DAY) calendar.push({ ...base, stage: "awaiting" });
  }
  const time = (line: AgencyLine) => line.bidDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  calendar.sort((a, b) => time(a) - time(b));
  results.sort((a, b) => (b.bidDate?.getTime() ?? 0) - (a.bidDate?.getTime() ?? 0));
  return { calendar, results };
}

export type AgencySaleInput = Omit<AgencySaleRow, "id" | "createdAt">;
type Read<T> = { ok: true; value: T } | { ok: false; error: string };

function dayOf(text: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// The desk's form, read and checked. `field` returns the trimmed text of one input.
export function readAgencySale(field: (name: string) => string, now = new Date()): Read<AgencySaleInput> {
  const fail = (error: string): Read<never> => ({ ok: false, error });
  const program = field("program");
  if (!AGENCY_PROGRAMS.some((row) => row.value === program)) return fail("Pick the agency.");
  const name = field("name").replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120) return fail("Name the sale in 2 to 120 characters.");
  const dates: Record<"bidDate" | "settleBy", Date | null> = { bidDate: null, settleBy: null };
  for (const key of ["bidDate", "settleBy"] as const) {
    const text = field(key);
    if (!text) continue;
    const date = dayOf(text);
    if (!date) return fail(key === "bidDate" ? "Enter the bid date as a date." : "Enter the settlement date as a date.");
    dates[key] = date;
  }
  if (dates.bidDate && dates.settleBy && dates.settleBy < dates.bidDate) return fail("Settlement can't come before the bid date.");
  const figure = (key: string, label: string, min: number, max: number, whole = false): Read<number | null> => {
    const text = field(key);
    if (!text) return { ok: true, value: null };
    const value = typedNumber(text);
    if (!Number.isFinite(value) || value <= min || value > max || (whole && !Number.isInteger(value))) {
      return fail(`Enter ${label}${whole ? " as a whole number" : ""} above ${min.toLocaleString("en-US")} and up to ${max.toLocaleString("en-US")}, or leave it blank.`);
    }
    return { ok: true, value };
  };
  const loans = figure("loans", "the loan count", 0, 1_000_000, true);
  if (!loans.ok) return loans;
  const upb = figure("upb", "the UPB", 0, 1e12);
  if (!upb.ok) return upb;
  const coverPctUpb = figure("coverPctUpb", "the cover bid as a percent of UPB", 0, 150);
  if (!coverPctUpb.ok) return coverPctUpb;
  const coverPctBpo = figure("coverPctBpo", "the cover bid as a percent of BPO", 0, 150);
  if (!coverPctBpo.ok) return coverPctBpo;
  const bpoLtv = figure("bpoLtv", "the BPO LTV", 0, 300);
  if (!bpoLtv.ok) return bpoLtv;
  if (coverPctUpb.value != null || coverPctBpo.value != null) {
    if (!dates.bidDate) return fail("Enter the bid date for a result.");
    // A day of slack for a date picked ahead of the server's timezone.
    if (dates.bidDate.getTime() > now.getTime() + DAY) return fail("A cover bid is published after bids are due. Check the bid date.");
  }
  const winner = field("winner").replace(/\s+/g, " ");
  if (winner.length > 160) return fail("Keep the winner under 160 characters.");
  const sourceUrl = field("sourceUrl");
  if (sourceUrl && !safeSourceUrl(sourceUrl)) return fail("Enter the source as a full web address starting with https://, or leave it blank.");
  if (sourceUrl.length > 500) return fail("Keep the source address under 500 characters.");
  return {
    ok: true,
    value: {
      program,
      name,
      bidDate: dates.bidDate,
      settleBy: dates.settleBy,
      loans: loans.value,
      upb: upb.value,
      coverPctUpb: coverPctUpb.value,
      coverPctBpo: coverPctBpo.value,
      bpoLtv: bpoLtv.value,
      winner,
      sourceUrl,
    },
  };
}

// A source link renders as an anchor, so only a web address passes, at entry and again at render.
export function safeSourceUrl(text: string) {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The book

const STATUS_WORDS: Record<string, string> = { PERFORMING: "Performing", SUB_PERFORMING: "Sub-performing", NON_PERFORMING: "Non-performing" };
const STATUSES = Object.keys(STATUS_WORDS);

export type BookListing = {
  id: string;
  status: string;
  approvedAt: Date | null;
  notes: { upb: number; askingPrice: number; paymentStatus: string; tradeStatus: string }[];
};

// A live standing price rule: its holder and the performance it covers. Empty statuses cover every kind.
export type BookRule = { userId: string; statuses: string };

export type AskCell = { paymentStatus: string; label: string; listings: number; loans: number; median: number };

export type StandingDepth = {
  rules: number;
  // Distinct buyers with a rule, or null under MIN_TRADES, so a lone rule's holder can't be inferred.
  buyers: number | null;
  byStatus: { paymentStatus: string; label: string; rules: number }[];
};

export type BookStats = {
  live: number;
  loans: number;
  upb: number;
  newListings: number;
  newUpb: number;
  // Asking price over UPB on loans for sale, never trades. A cell shows only with MIN_TRADES listings in it.
  asks: AskCell[];
  suppressedAsks: number;
  standing: StandingDepth;
};

function medianOf(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function covers(statuses: string, status: string) {
  const list = statuses.split(/[,\s]+/).map((item) => item.trim().toUpperCase()).filter(Boolean);
  return list.length === 0 || list.includes(status);
}

export function bookStats(listings: BookListing[], rules: BookRule[], period: { start: Date; end: Date }, minListings = MIN_TRADES): BookStats {
  const live = listings.filter((listing) => listing.status === "APPROVED");
  const forSale = live.map((listing) => ({ listing, loans: loansForSale(listing.status, listing.notes).filter((note) => note.tradeStatus === "AVAILABLE") }));
  const fresh = listings.filter((listing) => listing.approvedAt && listing.approvedAt >= period.start && listing.approvedAt < period.end);
  const groups = new Map<string, { listings: Set<string>; ratios: number[] }>();
  for (const { listing, loans } of forSale) {
    for (const loan of loans) {
      if (!(loan.upb > 0) || !(loan.askingPrice > 0)) continue;
      const group = groups.get(loan.paymentStatus) ?? { listings: new Set<string>(), ratios: [] };
      group.listings.add(listing.id);
      group.ratios.push((loan.askingPrice / loan.upb) * 100);
      groups.set(loan.paymentStatus, group);
    }
  }
  const asks: AskCell[] = [];
  let suppressedAsks = 0;
  for (const status of STATUSES) {
    const group = groups.get(status);
    if (!group) continue;
    // Counted by listing, so three loans of one pool never make a cell that reads as that pool's ask.
    if (group.listings.size < Math.max(MIN_TRADES, minListings)) {
      suppressedAsks += group.ratios.length;
      continue;
    }
    asks.push({ paymentStatus: status, label: STATUS_WORDS[status], listings: group.listings.size, loans: group.ratios.length, median: Math.round(medianOf(group.ratios)) });
  }
  const buyers = new Set(rules.map((rule) => rule.userId)).size;
  return {
    live: live.length,
    loans: forSale.reduce((sum, row) => sum + row.loans.length, 0),
    upb: forSale.reduce((sum, row) => sum + row.loans.reduce((total, loan) => total + Math.max(0, loan.upb), 0), 0),
    newListings: fresh.length,
    newUpb: fresh.reduce((sum, listing) => sum + listing.notes.reduce((total, loan) => total + Math.max(0, loan.upb), 0), 0),
    asks,
    suppressedAsks,
    standing: {
      rules: rules.length,
      buyers: buyers >= MIN_TRADES ? buyers : null,
      byStatus: STATUSES.map((status) => ({ paymentStatus: status, label: STATUS_WORDS[status], rules: rules.filter((rule) => covers(rule.statuses, status)).length })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The issue

// Each issue is named for the month it goes out in, and its "new on the book" figures cover the month before.
export function dispatchMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

const MONTH_NAME = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function monthTitle(month: string) {
  const [year, index] = month.split("-").map(Number);
  return MONTH_NAME.format(new Date(Date.UTC(year, index - 1, 1)));
}

export function periodOf(month: string) {
  const [year, index] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, index - 2, 1));
  const end = new Date(Date.UTC(year, index - 1, 1));
  return { start, end, label: MONTH_NAME.format(start) };
}

export type DispatchRate = { rate: number; asOf: string; stale: boolean };

export type Dispatch = {
  month: string;
  title: string;
  asOf: string;
  period: { start: Date; end: Date; label: string };
  calendar: AgencyLine[];
  results: AgencyLine[];
  comps: MarketView;
  book: BookStats;
  rate: DispatchRate | null;
  demo: boolean;
};

export type DispatchInput = {
  now: Date;
  sales: AgencySaleRow[];
  comps: MarketView;
  listings: BookListing[];
  rules: BookRule[];
  rate: { rate: number; asOf: Date } | null;
  demo: boolean;
};

export function buildDispatch(input: DispatchInput): Dispatch {
  const month = dispatchMonth(input.now);
  const period = periodOf(month);
  const { calendar, results } = agencyLines(input.sales, input.now);
  return {
    month,
    title: monthTitle(month),
    asOf: input.now.toISOString().slice(0, 10),
    period,
    calendar,
    results,
    comps: input.comps,
    book: bookStats(input.listings, input.rules, period),
    rate: input.rate ? { rate: input.rate.rate, asOf: input.rate.asOf.toISOString().slice(0, 10), stale: rateStale(input.rate.asOf, input.now) } : null,
    demo: input.demo,
  };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// The aggregate story every signed-in member reads, and the email's body. Counts, totals and the agencies' own
// published figures only: no UPB median, ask or price shows here.
export function dispatchStory(dispatch: Dispatch): string[] {
  const lines: string[] = [];
  const latest = dispatch.results[0];
  if (latest) {
    const day = latest.bidDate ? `, bid date ${prettyDate(latest.bidDate)}` : "";
    lines.push(`Latest agency result: ${latest.label}${day}. ${latest.cover}. A cover bid is the second-highest bid; the winning price is not published.`);
    if (dispatch.results.length > 1) lines.push(`${plural(dispatch.results.length, "agency or HUD result")} in the last six months are in the full tables.`);
  }
  for (const line of dispatch.calendar.filter((row) => row.stage === "awaiting").slice(0, 2)) {
    lines.push(`${line.label}: bids were due ${prettyDate(line.bidDate)}. Results are not yet published.`);
  }
  const upcoming = dispatch.calendar.filter((row) => row.stage === "upcoming").slice(0, 3);
  for (const line of upcoming) {
    lines.push(line.bidDate ? `On the calendar: ${line.label}, bids due ${prettyDate(line.bidDate)}.` : `On the calendar: ${line.label}, bid date not yet announced.`);
  }
  if (!latest && !dispatch.calendar.length) lines.push("No agency or HUD sale is on the desk's calendar this month.");
  const comps = dispatch.comps;
  const groups = comps.national.length + comps.regional.length;
  lines.push(
    comps.total >= MIN_TRADES
      ? `${plural(comps.total, "trade")} closed on UPB in the ${comps.windowMonths} months to ${prettyDate(comps.asOf)}. ${groups ? `${plural(groups, "group")} have three or more trades and show in the full tables.` : "No group has three trades yet."}`
      : `Fewer than three trades have closed on UPB in the ${comps.windowMonths} months to ${prettyDate(comps.asOf)}, so the closed-trade comps are not out yet.`,
  );
  const book = dispatch.book;
  lines.push(`${plural(book.newListings, "listing")} went live in ${dispatch.period.label}${book.newListings ? `, with ${moneyCompact(book.newUpb)} UPB` : ""}.`);
  lines.push(book.live ? `${plural(book.live, "listing")} ${book.live === 1 ? "is" : "are"} on the book now, with ${moneyCompact(book.upb)} UPB across ${plural(book.loans, "loan")}.` : "Nothing is on the book right now.");
  lines.push(
    book.standing.rules
      ? `${plural(book.standing.rules, "standing price rule")} from Pro buyers ${book.standing.rules === 1 ? "is" : "are"} live, ready to bid on new paper that fits.`
      : "No standing price rules are live yet.",
  );
  lines.push(
    dispatch.rate
      ? `The desk's 10-year Treasury reading is ${dispatch.rate.rate}% as of ${prettyDate(dispatch.rate.asOf)}${dispatch.rate.stale ? ", which is over a week old" : ""}.`
      : "The desk has no 10-year Treasury reading on file.",
  );
  if (dispatch.demo) lines.push("Figures on this demo server are fictional.");
  return lines;
}

export type DispatchTables = {
  calendar: AgencyLine[];
  results: AgencyLine[];
  comps: { national: CompCell[]; regional: CompCell[]; total: number; suppressed: number; windowMonths: number; asOf: string };
  asks: AskCell[];
  suppressedAsks: number;
  standing: StandingDepth;
};

export type DispatchView = {
  month: string;
  title: string;
  asOf: string;
  periodLabel: string;
  rate: DispatchRate | null;
  demo: boolean;
  story: string[];
  // Null for a free member: the full tables are Pro, like the figures on the book.
  tables: DispatchTables | null;
};

// The desk and Pro buyers read the full tables, as on the book. Everyone else signed in reads the story.
export function seesFullDispatch(user: { role: string; accountStatus: string; subscriptionTier: string; subscriptionStatus: string; subscriptionCurrentPeriodEnd?: Date | null }, now = new Date()) {
  if (user.role === "ADMIN") return true;
  return user.role === "BUYER" && user.accountStatus === "APPROVED" && isPro(user, now);
}

export function dispatchView(dispatch: Dispatch, viewer: { full: boolean }): DispatchView {
  return {
    month: dispatch.month,
    title: dispatch.title,
    asOf: dispatch.asOf,
    periodLabel: dispatch.period.label,
    rate: dispatch.rate,
    demo: dispatch.demo,
    story: dispatchStory(dispatch),
    tables: viewer.full
      ? {
          calendar: dispatch.calendar,
          results: dispatch.results,
          comps: {
            national: dispatch.comps.national,
            regional: dispatch.comps.regional,
            total: dispatch.comps.total,
            suppressed: dispatch.comps.suppressed,
            windowMonths: dispatch.comps.windowMonths,
            asOf: dispatch.comps.asOf,
          },
          asks: dispatch.book.asks,
          suppressedAsks: dispatch.book.suppressedAsks,
          standing: dispatch.book.standing,
        }
      : null,
  };
}

export const DISPATCH_FOOTNOTE =
  "Market data, not investment advice. UPB's own figures show a group only with three or more trades or listings, and sizes show as bands, so no single trade, ask or bidder can be read from them.";

// The plain-text email: the story, a link to the full issue and a way out. The same for every reader, so it carries
// nothing a free member can't see.
export function dispatchEmail(dispatch: Dispatch, appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  const base = appUrl.replace(/\/+$/, "");
  const subject = `UPB note-market dispatch · ${dispatch.title}`;
  const body = [
    `UPB Capital note-market dispatch, ${dispatch.title}`,
    "",
    ...dispatchStory(dispatch).map((line) => `- ${line}`),
    "",
    `Read the full dispatch: ${base}/market`,
    "",
    COVER_BID_NOTE,
    DISPATCH_FOOTNOTE,
    "",
    `You get this because you turned on the monthly dispatch. Turn it off under Notices: ${base}/account/notifications`,
  ].join("\n");
  return { subject, body };
}

// ---------------------------------------------------------------------------------------------------------------
// Server only: reading the issue and sending it

export async function loadDispatch(now = new Date()): Promise<Dispatch> {
  const period = periodOf(dispatchMonth(now));
  const [sales, trades, listings, boxes, settings] = await Promise.all([
    prisma.agencySale.findMany({ orderBy: { bidDate: "desc" }, take: 300 }),
    loadClosedTrades(now).catch(() => []),
    prisma.listing.findMany({
      // The dispatch goes to the whole list, so a private listing never counts in its book figures.
      where: { OR: [{ status: "APPROVED" }, { status: { in: ["PENDING", "SOLD"] }, approvedAt: { gte: period.start, lt: period.end } }], AND: [publicListing()] },
      select: { id: true, status: true, approvedAt: true, notes: { select: { upb: true, askingPrice: true, paymentStatus: true, tradeStatus: true } } },
    }),
    prisma.buyBox.findMany({
      where: { active: true, standingBids: true, user: { role: "BUYER", accountStatus: "APPROVED" } },
      select: {
        userId: true,
        statuses: true,
        standingBids: true,
        bidBasis: true,
        bidPercent: true,
        bidCap: true,
        targetYield: true,
        bidSpread: true,
        user: { select: { role: true, accountStatus: true, subscriptionTier: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true, trialEndsAt: true } },
      },
    }),
    getSettings(),
  ]);
  const rate = marketRate(settings);
  return buildDispatch({
    now,
    sales: sales.map((sale) => ({
      id: sale.id,
      program: sale.program,
      name: sale.name,
      bidDate: sale.bidDate,
      settleBy: sale.settleBy,
      loans: sale.loans,
      upb: sale.upb,
      coverPctUpb: sale.coverPctUpb,
      coverPctBpo: sale.coverPctBpo,
      bpoLtv: sale.bpoLtv,
      winner: sale.winner,
      sourceUrl: sale.sourceUrl,
      createdAt: sale.createdAt,
    })),
    comps: marketView(trades, now),
    listings: listings.map((listing) => ({
      ...listing,
      notes: listing.notes.map((note) => ({ ...note, upb: Number(note.upb), askingPrice: Number(note.askingPrice) })),
    })),
    // A lapsed membership keeps its rule on file but prices nothing, so it isn't depth.
    rules: boxes.filter((box) => ruleOf(box) != null && ruleHolder(box.user)).map((box) => ({ userId: box.userId, statuses: box.statuses })),
    rate: rate ? { rate: rate.rate, asOf: rate.asOf } : null,
    demo: !isReleaseBuild(process.env),
  });
}

// Approved accounts that turned the dispatch on. A missing setting is off.
export async function dispatchRecipients(userIds?: string[]) {
  return prisma.user.findMany({
    where: { marketDispatch: true, accountStatus: "APPROVED", ...(userIds ? { id: { in: userIds } } : {}) },
    select: { id: true, email: true },
  });
}

// Takes the month with a conditional write, so an overlapping run or a second cron delivery finds it taken. A month
// at or before the one on file never goes out again.
export async function claimDispatchMonth(month: string, settingsId = "default") {
  const claim = await prisma.platformSettings.updateMany({
    where: { id: settingsId, OR: [...unset("lastDispatchMonth").OR, { lastDispatchMonth: { lt: month } }] },
    data: { lastDispatchMonth: month },
  });
  return claim.count === 1;
}

export type DispatchTally = { month: string; claimed: boolean; sent: number; failed: number; error: string };

// For a scoped run, such as a test: the settings row that holds the claim, and the only accounts that may hear. The
// monthly job passes neither.
export type DispatchScope = { settingsId?: string; userIds?: string[] };

export async function sendMarketDispatch(now = new Date(), scope: DispatchScope = {}): Promise<DispatchTally> {
  const month = dispatchMonth(now);
  const settingsId = scope.settingsId ?? "default";
  // Built before the claim, so a read that fails leaves the month for the next run.
  const dispatch = await loadDispatch(now);
  if (settingsId === "default") await getSettings();
  if (!(await claimDispatchMonth(month, settingsId))) return { month, claimed: false, sent: 0, failed: 0, error: "" };
  if (settingsId === "default") clearSettingsCache();
  const { subject, body } = dispatchEmail(dispatch);
  // Filed before anyone hears, so the archive holds the issue even if some sends fail. A failed write is logged and
  // the mail still goes, since the month is already claimed.
  await archiveIssue({ month, subject, body, settingsId, now }).catch((error) => {
    console.error(`[upb-jobs] market dispatch ${month} was not archived:`, error instanceof Error ? error.message : error);
  });
  const recipients = await dispatchRecipients(scope.userIds);
  const tally: DispatchTally = { month, claimed: true, sent: 0, failed: 0, error: "" };
  // A claimed month that fails for one reader is logged and not retried, so nobody gets it twice.
  for (const user of recipients) {
    try {
      await notify(user.email, subject, body, { category: "dispatch", userId: user.id });
      tally.sent += 1;
    } catch (error) {
      tally.failed += 1;
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
      tally.error ||= `user ${user.id}: ${reason}`;
      console.error(`[upb-jobs] market dispatch failed for user ${user.id}:`, reason);
    }
  }
  await audit(null, "MARKET_DISPATCH", "settings", settingsId, `${dispatch.title} to ${plural(tally.sent, "account")}${tally.failed ? `, ${tally.failed} failed` : ""}`);
  return tally;
}

// ---------------------------------------------------------------------------------------------------------------
// The archive: each issue as it was sent, for members to read back.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// A scoped run, such as a test's, files under its own settings row, so it never stands in for the real month.
export function issueKey(month: string, settingsId = "default") {
  return settingsId === "default" ? month : `${settingsId}:${month}`;
}

export async function archiveIssue(input: { month: string; subject: string; body: string; settingsId?: string; now?: Date }) {
  const key = issueKey(input.month, input.settingsId);
  const sentAt = input.now ?? new Date();
  return prisma.dispatchIssue.upsert({
    where: { month: key },
    create: { month: key, subject: input.subject, body: input.body, sentAt },
    update: { subject: input.subject, body: input.body, sentAt },
  });
}

// Back issues, newest first. Only real months list; a scoped run's rows carry a prefix.
export async function dispatchIssues(take = 60) {
  const rows = await prisma.dispatchIssue.findMany({
    where: { NOT: { month: { contains: ":" } } },
    orderBy: { month: "desc" },
    take,
    select: { month: true, subject: true, sentAt: true },
  });
  return rows.filter((row) => MONTH.test(row.month)).map((row) => ({ ...row, title: monthTitle(row.month) }));
}

export async function dispatchIssue(month: string) {
  if (!MONTH.test(month)) return null;
  const row = await prisma.dispatchIssue.findUnique({ where: { month } });
  return row ? { ...row, title: monthTitle(row.month) } : null;
}

export type IssueBlock = { kind: "list"; items: string[] } | { kind: "text"; lines: string[] };

// The plain-text issue as paragraphs and lists, the way the email reads.
export function issueBlocks(body: string): IssueBlock[] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").filter((line) => line.trim()))
    .filter((lines) => lines.length)
    .map((lines) =>
      lines.every((line) => line.startsWith("- ")) ? { kind: "list" as const, items: lines.map((line) => line.slice(2)) } : { kind: "text" as const, lines },
    );
}

// A line's web addresses as links, the rest as text.
export function linkParts(line: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let last = 0;
  for (const match of line.matchAll(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: line.slice(last, at) });
    const href = safeSourceUrl(match[0]);
    parts.push(href ? { text: match[0], href } : { text: match[0] });
    last = at + match[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts;
}
