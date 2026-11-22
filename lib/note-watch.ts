import type { BuyBox, TrackedNote, User } from "@prisma/client";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { appOrigin } from "@/lib/billing";
import { seasoningMonths } from "@/lib/buy-box";
import { loadClosedTrades, type ClosedTrade } from "@/lib/comps";
import { keptWithinLimit, OLDEST_FIRST, unset } from "@/lib/db-filters";
import { MIN_FIRMS } from "@/lib/demand-board";
import { notify } from "@/lib/email";
import { chargeFees, feeTerms } from "@/lib/fee-schedule";
import { isoDate, money, prettyDate } from "@/lib/format";
import { marketRate, type MarketRate } from "@/lib/indicative";
import type { Tally } from "@/lib/jobs";
import { LIEN_POSITIONS } from "@/lib/labels";
import { scoreMatch, type ProgramNote } from "@/lib/matching";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { remainingTerm, type StandingNote } from "@/lib/standing-bids";
import { firstZodError, noteSchema } from "@/lib/validators";
import { listingFromValuation, sameEmail, storedLoans, valuationRange, type ValuationLoan } from "@/lib/valuations";

// Note watch: a holder who isn't ready to sell saves a note and hears once a month what it would read at and how
// many buyer firms' boxes fit it, with one tap to list it. Most seller-financed notes are their holder's only one, so
// they sell rarely and on a trigger; a watched note is a listing UPB already knows about.
//
// A tracked note is the holder's own and private until it is listed. The desk sees counts only (noteWatchCounts),
// never a holder's note, label or reading. A reading is valued as a single-loan quote from Value my loans is, and its
// demand is a count of distinct buyer firms, never a buyer's name or price, and never exact under three.

export const MAX_WATCHED = 25;
export const MAX_LABEL = 80;
// A reading this old is due again. The job runs daily, so each note is read about once a month.
export const READING_DAYS = 30;
export const WATCH_ROLES = ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"] as const;
export const FEWER_LINE = `Fewer than ${MIN_FIRMS} buyers`;
export const LIMIT_TEXT = `You can watch up to ${MAX_WATCHED} notes. Delete one you no longer hold to add another.`;
export const WATCH_DISCLAIMER =
  "An estimate from the desk's model and UPB's closed trades, not an appraisal, an offer or advice. A buyer count is the number of buyer firms whose buy boxes fit the note. No buyer is named and no buyer's price is shown.";

const DAY = 24 * 60 * 60 * 1000;
const ROW_ID = /^[\w-]{1,64}$/;

type Holder = { id: string; role: string };

export function canWatch(user: { role: string }) {
  return (WATCH_ROLES as readonly string[]).includes(user.role);
}

// ---------------------------------------------------------------------------------------------------------------
// The form: the wizard's own fields and checks (lib/validators.ts), for the few a reading needs, plus a label.

const blank = (value: unknown) => (value == null || (typeof value === "string" && value.trim() === "") ? undefined : value);
const shape = noteSchema.shape;

export const watchSchema = z.object({
  // One line, since it heads the email and can be its subject.
  label: z
    .string({ error: "Give the note a label. Only you see it." })
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "Give the note a label. Only you see it.").max(MAX_LABEL, `Keep the label under ${MAX_LABEL} characters.`)),
  state: shape.state,
  propertyType: shape.propertyType,
  lienPosition: shape.lienPosition,
  paymentStatus: shape.paymentStatus,
  upb: shape.upb,
  interestRate: shape.interestRate,
  // A blank payment isn't $0, as the wizard says.
  monthlyPi: z.preprocess(blank, z.coerce.number({ error: "Enter monthly principal and interest." }).min(0, "Enter monthly principal and interest.")),
  estimatedValue: shape.estimatedValue,
  originationDate: shape.originationDate,
  maturityDate: shape.maturityDate,
  // Optional here, though the wizard asks each: a reading prices without them, and a listing asks again.
  occupancy: z.preprocess(blank, shape.occupancy.optional()).transform((value) => value ?? null),
  seniorLienBalance: shape.seniorLienBalance,
  loanProgram: shape.loanProgram,
});

export type WatchInput = z.infer<typeof watchSchema>;
export const WATCH_FIELDS = Object.keys(watchSchema.shape) as (keyof WatchInput)[];

export function readWatchForm(raw: Record<string, unknown>): { error: string; data?: undefined } | { error: null; data: WatchInput } {
  const parsed = watchSchema.safeParse(raw);
  if (!parsed.success) return { error: firstZodError(parsed.error) };
  // A first lien has nothing ahead of it, so a senior balance typed before the lien changed isn't kept, as on the wizard.
  return { error: null, data: parsed.data.lienPosition === "FIRST" ? { ...parsed.data, seniorLienBalance: null } : parsed.data };
}

// ---------------------------------------------------------------------------------------------------------------
// The reading.

export type WatchFacts = Pick<
  TrackedNote,
  "state" | "lienPosition" | "paymentStatus" | "occupancy" | "loanProgram" | "upb" | "interestRate" | "monthlyPi" | "estimatedValue" | "originationDate" | "maturityDate"
>;

export type Reading = { low: number; high: number; demand: number; valuedAt: Date };

type WatchBox = BuyBox & { user: User };

// What every reading in a run shares: the desk's settings, the closed trades, the 10-year rate, and the active boxes
// of approved buyers, each with its firm. A firm's seats act for the firm, so a firm counts once (lib/demand-board.ts).
export type WatchContext = {
  now: Date;
  settings: Awaited<ReturnType<typeof getSettings>>;
  trades: ClosedTrade[];
  rate: MarketRate | null;
  boxes: { box: WatchBox; firm: string }[];
};

// `buyerIds` narrows the boxes read, so a test counts its own buyers and nobody else's.
export async function watchContext(now = new Date(), options: { buyerIds?: string[] } = {}): Promise<WatchContext> {
  const [settings, trades, boxes] = await Promise.all([
    getSettings(),
    loadClosedTrades(now).catch(() => [] as ClosedTrade[]),
    prisma.buyBox.findMany({ where: { active: true, ...(options.buyerIds ? { userId: { in: options.buyerIds } } : {}) } }),
  ]);
  const owners = boxes.length
    ? await prisma.user.findMany({ where: { id: { in: [...new Set(boxes.map((box) => box.userId))] }, role: "BUYER", accountStatus: "APPROVED", ...unset("deletedAt") } })
    : [];
  const byId = new Map(owners.map((owner) => [owner.id, owner]));
  return {
    now,
    settings,
    trades,
    rate: marketRate(settings),
    boxes: boxes.flatMap((box) => {
      const user = byId.get(box.userId);
      return user ? [{ box: { ...box, user }, firm: user.principalId || user.id }] : [];
    }),
  };
}

// The note as the single-loan quote prices it (lib/valuations.ts). A watch keeps no months behind, so it reads as 0, as
// the quote form reads a blank.
export function watchLoan(note: WatchFacts): ValuationLoan {
  return {
    state: note.state,
    city: "",
    lienPosition: note.lienPosition,
    paymentStatus: note.paymentStatus,
    occupancy: note.occupancy ?? "UNKNOWN",
    upb: note.upb,
    interestRate: note.interestRate ?? Number.NaN,
    monthlyPi: note.monthlyPi ?? Number.NaN,
    estimatedValue: note.estimatedValue ?? 0,
    monthsDelinquent: 0,
    maturityDate: isoDate(note.maturityDate),
  };
}

// Distinct buyer firms with an active box that fits the note, scored as matching scores a new tape (lib/matching.ts
// scoreMatch, as standingDemand does for a seller's draft). A note on watch has no ask, so it is scored at the middle
// of its own range; a box with a standing price is scored at that price. Only the count leaves here.
export function demandFor(note: WatchFacts, ask: number, ctx: WatchContext) {
  const standing: StandingNote = {
    id: "watch",
    upb: note.upb,
    askingPrice: ask,
    interestRate: note.interestRate ?? 0,
    monthlyPi: note.monthlyPi ?? 0,
    paymentStatus: note.paymentStatus,
    maturityDate: note.maturityDate,
    tradeStatus: "AVAILABLE",
  };
  const scored: ProgramNote = {
    state: note.state,
    lienPosition: note.lienPosition,
    paymentStatus: note.paymentStatus,
    upb: note.upb,
    askingPrice: ask,
    monthlyPi: note.monthlyPi ?? 0,
    interestRate: note.interestRate ?? 0,
    termMonths: remainingTerm(note.maturityDate, ctx.now),
    estimatedValue: note.estimatedValue ?? undefined,
    seasoningMonths: seasoningMonths(note.originationDate, ctx.now),
    loanProgram: note.loanProgram ?? null,
    tractIncomeLevel: null,
    lmiBorrower: null,
  };
  const firms = new Set<string>();
  for (const { box, firm } of ctx.boxes) {
    if (firms.has(firm)) continue;
    const { result } = scoreMatch("SINGLE", [standing], box, [scored], ctx.now, ctx.settings.buyerPremiumBps, ctx.rate, { ignoreAsk: true });
    if (result) firms.add(firm);
  }
  return firms.size;
}

// The range as Value my loans prices one loan (lib/valuations.ts valuationRange), with the premium at the tier for the
// balance, and the demand count.
export function readNote(note: WatchFacts, ctx: WatchContext): Reading {
  const loan = watchLoan(note);
  const premiumBps = chargeFees(feeTerms(null, ctx.settings), loan.upb).premiumBps;
  const range = valuationRange([loan], { targetYield: ctx.settings.indicativeTargetYield, premiumBps, trades: ctx.trades, now: ctx.now });
  return { low: range.lowPrice, high: range.highPrice, demand: demandFor(note, (range.lowPrice + range.highPrice) / 2, ctx), valuedAt: ctx.now };
}

type Readable = WatchFacts & Pick<TrackedNote, "id" | "lastLow" | "lastHigh" | "lastDemand" | "lastValuedAt">;

// Writes a reading, keeping the one before it so the page and the email can say what moved. Claimed on the reading
// the caller saw, so two runs never both write one; false when another got there first.
export async function saveReading(note: Readable, reading: Reading) {
  const claim = await prisma.trackedNote.updateMany({
    where: { id: note.id, ...(note.lastValuedAt ? { lastValuedAt: note.lastValuedAt } : unset("lastValuedAt")) },
    data: {
      prevLow: note.lastLow,
      prevHigh: note.lastHigh,
      prevDemand: note.lastDemand,
      prevValuedAt: note.lastValuedAt,
      lastLow: reading.low,
      lastHigh: reading.high,
      lastDemand: reading.demand,
      lastValuedAt: reading.valuedAt,
    },
  });
  return claim.count === 1;
}

// A reading when the note is added or edited. A failure leaves the note saved and unread; the daily job reads it.
async function readNow(id: string, options: { now?: Date; buyerIds?: string[] }) {
  try {
    const note = await prisma.trackedNote.findUnique({ where: { id } });
    if (!note) return;
    await saveReading(note, readNote(note, await watchContext(options.now ?? new Date(), options)));
  } catch (error) {
    console.error(`[upb-watch] reading failed for ${id}:`, error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// What the page and the email say.

// The demand line: an exact count from three up, never under.
export function demandText(count: number | null | undefined) {
  if (count == null) return "Not read yet";
  if (count < MIN_FIRMS) return FEWER_LINE;
  return `${count} buyers`;
}

function shownCount(count: number) {
  return count >= MIN_FIRMS ? count : null;
}

export type ReadingRow = Pick<TrackedNote, "lastLow" | "lastHigh" | "lastDemand" | "lastValuedAt" | "prevLow" | "prevHigh" | "prevDemand" | "prevValuedAt">;

function demandMove(prev: number | null, last: number | null) {
  if (prev == null || last == null) return null;
  const before = shownCount(prev);
  const after = shownCount(last);
  // Two counts under three say only that, whichever way they moved.
  if (before == null && after == null) return `still fewer than ${MIN_FIRMS} buyers`;
  if (before === after) return `buyers unchanged at ${after}`;
  if (before == null) return `buyers up from fewer than ${MIN_FIRMS} to ${after}`;
  if (after == null) return `buyers down from ${before} to fewer than ${MIN_FIRMS}`;
  return `buyers ${after > before ? "up" : "down"} from ${before} to ${after}`;
}

// What moved between the reading before and the last one, or null on a first reading. The page and the email both
// show this sentence.
export function changeText(row: ReadingRow) {
  if (!row.prevValuedAt || row.prevLow == null || row.prevHigh == null || row.lastLow == null || row.lastHigh == null) return null;
  const before = (row.prevLow + row.prevHigh) / 2;
  const after = (row.lastLow + row.lastHigh) / 2;
  const was = `${money(row.prevLow)}–${money(row.prevHigh)}`;
  const range =
    row.prevLow === row.lastLow && row.prevHigh === row.lastHigh
      ? "the range is unchanged"
      : after > before
        ? `the range is up from ${was}`
        : after < before
          ? `the range is down from ${was}`
          : `the range moved from ${was}`;
  const demand = demandMove(row.prevDemand, row.lastDemand);
  return `Since ${prettyDate(row.prevValuedAt)}: ${range}${demand ? `; ${demand}` : ""}.`;
}

export function rangeText(row: Pick<TrackedNote, "lastLow" | "lastHigh" | "upb">) {
  if (row.lastLow == null || row.lastHigh == null) return null;
  const share = (price: number) => (row.upb > 0 ? Math.round((price / row.upb) * 100) : 0);
  return { money: `${money(row.lastLow)} to ${money(row.lastHigh)}`, share: `${share(row.lastLow)}–${share(row.lastHigh)}% of the ${money(row.upb)} balance` };
}

export type DigestNote = Pick<TrackedNote, "id" | "label" | "upb"> & ReadingRow;

// The monthly email: every note the holder watches with alerts on, each with its range, its demand, what moved, and a
// link to list it. One per holder, however many notes.
export function noteWatchEmail(notes: DigestNote[], origin: string, now = new Date()) {
  const sections = notes.map((note) => {
    const range = rangeText(note);
    return [
      note.label,
      range ? `Indicative range: ${range.money}, ${range.share}.` : "Indicative range: not read yet.",
      `Buyer demand: ${demandText(note.lastDemand)} whose boxes fit it.`,
      changeText(note) ?? "First reading. Next month says what moved.",
      `List it: ${origin}/seller/watch/${note.id}/list`,
    ].join("\n");
  });
  const subject = notes.length === 1 ? `Note watch · ${notes[0].label}` : `Note watch · ${notes.length} notes`;
  const body = `How your watched ${notes.length === 1 ? "note reads" : "notes read"} as of ${prettyDate(now)}.\n\n${sections.join("\n\n")}\n\n${WATCH_DISCLAIMER}\n\nAll your notes: ${origin}/seller/watch`;
  return { subject, body };
}

// ---------------------------------------------------------------------------------------------------------------
// The holder's own notes.

type Result = { error: string; id?: undefined } | { error: null; id: string };
type ReadOptions = { now?: Date; buyerIds?: string[] };

const OWN_NOTE = "That note isn't on your watch.";

async function createWatch(user: Holder, data: WatchInput | (Omit<WatchInput, "propertyType"> & { propertyType: string | null }), options: ReadOptions): Promise<Result> {
  if (!canWatch(user)) return { error: "Note watch is for seller accounts." };
  if ((await prisma.trackedNote.count({ where: { userId: user.id } })) >= MAX_WATCHED) return { error: LIMIT_TEXT };
  const created = await prisma.trackedNote.create({ data: { userId: user.id, ...data } });
  // Two forms sent at once can both pass the count. The later one goes, so a holder never keeps more than the limit,
  // even when the earlier one lands second (lib/db-filters.ts).
  if (!(await keptWithinLimit(created.id, MAX_WATCHED, () => prisma.trackedNote.findMany({ where: { userId: user.id }, select: { id: true }, orderBy: OLDEST_FIRST })))) {
    await prisma.trackedNote.deleteMany({ where: { id: created.id } });
    return { error: LIMIT_TEXT };
  }
  await readNow(created.id, options);
  // The label and figures stay out of the log: the desk doesn't see a holder's notes.
  await audit(user.id, "NOTE_WATCH_ADDED", "trackedNote", created.id);
  return { error: null, id: created.id };
}

export async function addWatchedNote(user: Holder, raw: Record<string, unknown>, options: ReadOptions = {}): Promise<Result> {
  if (!canWatch(user)) return { error: "Note watch is for seller accounts." };
  const read = readWatchForm(raw);
  if (read.error !== null) return { error: read.error };
  return createWatch(user, read.data, options);
}

async function ownNote(user: Holder, id: string) {
  if (!ROW_ID.test(id)) return null;
  const note = await prisma.trackedNote.findUnique({ where: { id } });
  return note && note.userId === user.id ? note : null;
}

function sameValue(a: unknown, b: unknown) {
  if (a instanceof Date || b instanceof Date) return (a instanceof Date ? a.getTime() : null) === (b instanceof Date ? b.getTime() : null);
  return (a ?? null) === (b ?? null);
}

// An edit to the figures reads the note again at once. A new label alone doesn't, so it keeps the month's change.
export async function editWatchedNote(user: Holder, id: string, raw: Record<string, unknown>, options: ReadOptions = {}): Promise<Result> {
  const note = await ownNote(user, id);
  if (!note) return { error: OWN_NOTE };
  if (note.listingId) return { error: "This note is listed. Change the listing instead." };
  const read = readWatchForm(raw);
  if (read.error !== null) return { error: read.error };
  const moved = WATCH_FIELDS.some((key) => key !== "label" && !sameValue(read.data[key], note[key]));
  await prisma.trackedNote.update({ where: { id: note.id }, data: read.data });
  if (moved || !note.lastValuedAt) await readNow(note.id, options);
  await audit(user.id, "NOTE_WATCH_EDITED", "trackedNote", note.id);
  return { error: null, id: note.id };
}

export async function setWatchAlerts(user: Holder, id: string, on: boolean): Promise<Result> {
  const note = await ownNote(user, id);
  if (!note) return { error: OWN_NOTE };
  await prisma.trackedNote.update({ where: { id: note.id }, data: { alertsOn: on } });
  await audit(user.id, on ? "NOTE_WATCH_ALERTS_ON" : "NOTE_WATCH_ALERTS_OFF", "trackedNote", note.id);
  return { error: null, id: note.id };
}

export async function deleteWatchedNote(user: Holder, id: string): Promise<Result> {
  const note = await ownNote(user, id);
  if (!note) return { error: OWN_NOTE };
  await prisma.trackedNote.deleteMany({ where: { id: note.id, userId: user.id } });
  await audit(user.id, "NOTE_WATCH_DELETED", "trackedNote", note.id);
  return { error: null, id: note.id };
}

export async function watchedNotes(userId: string) {
  await linkWatchedListings({ userIds: [userId] });
  return prisma.trackedNote.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

// The wizard's starting values for "List it" (components/note-wizard.tsx takes them on a new listing as on an edit).
// The ask stays blank: the holder sets it at the price step, against the market check.
export function wizardDraft(note: TrackedNote) {
  const amount = (value: number | null) => (value == null ? "" : String(value));
  return {
    state: note.state,
    ...(note.propertyType ? { propertyType: note.propertyType } : {}),
    ...(note.occupancy ? { occupancy: note.occupancy } : {}),
    lienPosition: note.lienPosition,
    paymentStatus: note.paymentStatus,
    upb: amount(note.upb),
    interestRate: amount(note.interestRate),
    monthlyPi: amount(note.monthlyPi),
    estimatedValue: amount(note.estimatedValue),
    originationDate: isoDate(note.originationDate) ?? "",
    maturityDate: isoDate(note.maturityDate) ?? "",
    seniorLienBalance: note.lienPosition === "FIRST" ? "" : amount(note.seniorLienBalance),
    loanProgram: note.loanProgram ?? "",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// From a Value my loans result: "Keep watching this note".

export function defaultLabel(loan: Pick<ValuationLoan, "lienPosition" | "state" | "upb">) {
  const lien = LIEN_POSITIONS.find((item) => item.value === loan.lienPosition)?.label ?? "Other";
  return `${lien} lien in ${loan.state}, ${money(loan.upb)}`;
}

// Whether this account may watch the request's loan, by the rule that joins a request to an account at signup
// (lib/valuations.ts linkValuationAtSignup): a seller account, the request's own email, and a request on no other
// account. Only a single typed loan can be watched; a tape or several loans go through the listing paths instead.
export async function watchableValuation(user: { id: string; role: string; email: string }, valuationId: string) {
  if (!canWatch(user) || !ROW_ID.test(valuationId)) return null;
  const request = await prisma.valuationRequest.findUnique({ where: { id: valuationId }, select: { id: true, email: true, userId: true, loans: true, tapeKey: true, rows: true } });
  if (!request || !sameEmail(request.email, user.email) || (request.userId && request.userId !== user.id)) return null;
  const loans = storedLoans(request.rows);
  if (request.loans !== 1 || request.tapeKey || loans.length !== 1) return null;
  return { id: request.id, loan: loans[0] };
}

export async function watchFromValuation(
  user: { id: string; role: string; email: string },
  input: { valuationId: string; label: string },
  options: ReadOptions = {},
): Promise<Result & { already?: boolean }> {
  if (!canWatch(user)) return { error: "Sign in with a seller account to watch a note." };
  const found = await watchableValuation(user, input.valuationId);
  if (!found) return { error: "This valuation can't join this account. Note watch takes a single-loan valuation sent from the account's own email." };
  const { loan } = found;
  const label = input.label.replace(/\s+/g, " ").trim() || defaultLabel(loan);
  if (label.length > MAX_LABEL) return { error: `Keep the label under ${MAX_LABEL} characters.` };
  // Pressed twice, or come back to later: the note already on watch.
  const existing = await prisma.trackedNote.findFirst({ where: { userId: user.id, state: loan.state, upb: loan.upb, ...unset("listingId") }, select: { id: true } });
  if (existing) return { error: null, id: existing.id, already: true };
  const maturity = loan.maturityDate ? new Date(`${loan.maturityDate}T00:00:00.000Z`) : null;
  return createWatch(
    user,
    {
      label,
      state: loan.state,
      // The quote doesn't ask the property type. The watch page's edit can add it.
      propertyType: null,
      lienPosition: loan.lienPosition as WatchInput["lienPosition"],
      paymentStatus: loan.paymentStatus as WatchInput["paymentStatus"],
      upb: loan.upb,
      interestRate: loan.interestRate,
      monthlyPi: loan.monthlyPi,
      estimatedValue: loan.estimatedValue,
      originationDate: null,
      maturityDate: maturity && !Number.isNaN(maturity.getTime()) ? maturity : null,
      occupancy: loan.occupancy && loan.occupancy !== "UNKNOWN" ? (loan.occupancy as WatchInput["occupancy"]) : null,
      seniorLienBalance: null,
      loanProgram: null,
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Listing it.

// "List it" opens the note wizard prefilled. The wizard files through the ordinary listing action, so the watch finds
// its listing afterwards by the rule that ties a valuation to its listing (lib/valuations.ts listingFromValuation): the
// holder's own listing, filed after the note went on watch, with a loan in the same state at the same balance to the
// dollar. A listing ties to one watched note at most. Run when the watch page, the job or the desk's count reads.
export async function linkWatchedListings(scope: { userIds?: string[] } = {}) {
  const notes = await prisma.trackedNote.findMany({
    where: { ...unset("listingId"), ...(scope.userIds ? { userId: { in: scope.userIds } } : {}) },
    select: { id: true, userId: true, state: true, upb: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  let linked = 0;
  for (const userId of new Set(notes.map((note) => note.userId))) {
    const own = notes.filter((note) => note.userId === userId);
    const listings = await prisma.listing.findMany({
      where: { sellerId: userId, createdAt: { gte: own[0].createdAt }, status: { notIn: ["REJECTED", "WITHDRAWN"] } },
      select: { id: true, createdAt: true, notes: { select: { state: true, upb: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!listings.length) continue;
    const taken = new Set((await prisma.trackedNote.findMany({ where: { listingId: { in: listings.map((listing) => listing.id) } }, select: { listingId: true } })).map((row) => row.listingId));
    for (const note of own) {
      const listing = listings.find(
        (row) => !taken.has(row.id) && row.createdAt >= note.createdAt && listingFromValuation([{ state: note.state, upb: note.upb }], row.notes.map((loan) => ({ state: loan.state, upb: Number(loan.upb) }))),
      );
      if (!listing) continue;
      const claim = await prisma.trackedNote.updateMany({ where: { id: note.id, ...unset("listingId") }, data: { listingId: listing.id } });
      if (claim.count !== 1) continue;
      taken.add(listing.id);
      linked += 1;
      await audit(userId, "NOTE_WATCH_LISTED", "trackedNote", note.id, listing.id);
    }
  }
  return linked;
}

// ---------------------------------------------------------------------------------------------------------------
// The monthly email.

// A suspended, declined or deleted account hears nothing, as the seller report decides (lib/seller-report.ts).
export function watchMailable(user: Pick<User, "role" | "accountStatus" | "deletedAt">) {
  return canWatch(user) && !user.deletedAt && user.accountStatus !== "SUSPENDED" && user.accountStatus !== "REJECTED";
}

function due(note: Pick<TrackedNote, "lastValuedAt">, now: Date) {
  return !note.lastValuedAt || note.lastValuedAt.getTime() <= now.getTime() - READING_DAYS * DAY;
}

// One holder's month: each due note read again, then one email covering every note they watch with alerts on. The
// readings are made before the claim, so one that fails leaves the month for the next run; each claim is on the
// reading the run saw, so an overlapping run reads and sends nothing twice.
export async function sendHolderWatch(user: Pick<User, "id" | "email">, ctx: WatchContext) {
  const notes = await prisma.trackedNote.findMany({ where: { userId: user.id, alertsOn: true, ...unset("listingId") }, orderBy: OLDEST_FIRST, take: MAX_WATCHED });
  // When any of the holder's notes is due, all of them are read together, so their dates line up and the holder gets
  // one email a month rather than one per note added on a different day.
  if (!notes.some((note) => due(note, ctx.now))) return false;
  const readings = notes.map((note) => ({ note, reading: readNote(note, ctx) }));
  const read = new Map<string, Reading>();
  // Every run claims the notes in the same order. One that finds a note already taken stops there and sends nothing,
  // since another run has this holder, so overlapping runs send one email between them rather than one each.
  for (const { note, reading } of readings) {
    if (!(await saveReading(note, reading))) return false;
    read.set(note.id, reading);
  }
  if (!read.size) return false;
  const rows: DigestNote[] = notes.map((note) => {
    const reading = read.get(note.id);
    if (!reading) return note;
    return {
      ...note,
      prevLow: note.lastLow,
      prevHigh: note.lastHigh,
      prevDemand: note.lastDemand,
      prevValuedAt: note.lastValuedAt,
      lastLow: reading.low,
      lastHigh: reading.high,
      lastDemand: reading.demand,
      lastValuedAt: reading.valuedAt,
    };
  });
  const { subject, body } = noteWatchEmail(rows, appOrigin(), ctx.now);
  await notify(user.email, subject, body, { category: "notewatch", userId: user.id });
  return true;
}

// The daily job: holders with a note on watch, alerts on, not listed, and last read 30 or more days ago. Each such holder
// gets all of their watched notes read again, in one email. `userIds`
// narrows a run and `buyerIds` the boxes counted, so a test reads its own and nobody else's.
export async function sendNoteWatch(now = new Date(), options: { userIds?: string[]; buyerIds?: string[] } = {}): Promise<Tally> {
  const { eachItem } = await import("@/lib/jobs");
  await linkWatchedListings({ userIds: options.userIds });
  const cutoff = new Date(now.getTime() - READING_DAYS * DAY);
  const stale = await prisma.trackedNote.findMany({
    where: {
      alertsOn: true,
      ...(options.userIds ? { userId: { in: options.userIds } } : {}),
      AND: [unset("listingId"), { OR: [{ lastValuedAt: { lte: cutoff } }, ...unset("lastValuedAt").OR] }],
    },
    select: { userId: true },
  });
  const holderIds = [...new Set(stale.map((note) => note.userId))];
  const holders = holderIds.length
    ? (await prisma.user.findMany({ where: { id: { in: holderIds } }, select: { id: true, email: true, role: true, accountStatus: true, deletedAt: true } })).filter(watchMailable)
    : [];
  if (!holders.length) return { sent: 0, failed: 0, error: "" };
  const ctx = await watchContext(now, { buyerIds: options.buyerIds });
  return eachItem("note watch", holders, (user) => `user ${user.id}`, (user) => sendHolderWatch(user, ctx));
}

// ---------------------------------------------------------------------------------------------------------------
// The desk's line on the valuations queue: how many notes are on watch and how many became listings. Counts only.

export async function noteWatchCounts() {
  await linkWatchedListings();
  const [watched, unlisted] = await Promise.all([prisma.trackedNote.count(), prisma.trackedNote.count({ where: unset("listingId") })]);
  return { watched, listed: watched - unlisted };
}
