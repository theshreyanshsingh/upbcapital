import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { audit } from "@/lib/audit";
import { COMP_WINDOW_MONTHS, MIN_TRADES, cellFacts, compsFor, loadClosedTrades, type ClosedTrade } from "@/lib/comps";
import { unset } from "@/lib/db-filters";
import { secureCookies } from "@/lib/deploy";
import { MAX_INTAKE_BYTES, readIntakeTape, type PriceMode, type SplitRule, type StagedIntake } from "@/lib/desk-intake";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { chargeFees, feeTerms } from "@/lib/fee-schedule";
import { money, prettyDate } from "@/lib/format";
import { compSubjectOf, indicativeRange, type IndicativeNote } from "@/lib/indicative";
import { LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { typedNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { indicativeQuote } from "@/lib/quote";
import { consumeRateLimit } from "@/lib/rate-limit";
import { screenAndRecord, screenInBackground } from "@/lib/screening";
import { getSettings } from "@/lib/settings";
import { extensionOf, getBytes, putBytes, safeBasename } from "@/lib/storage";
import { saveTapeDraft } from "@/lib/tape-draft";
import { uploadProblem } from "@/lib/uploads";

// "Value my loans": a seller, with or without an account, sends a tape or up to ten loans and sees an indicative
// range from the desk's own model and UPB's closed trades at once. The desk then works the request: it sends its own
// range with a note, invites the seller to list, or closes it.

export const MAX_TYPED_LOANS = 10;
export const MAX_TAPE_ROWS = 2000;
export const MAX_TAPE_BYTES = 20 * 1024 * 1024;
// Each request prices the loans against the model and the trades, so a network and an address each get a few.
export const IP_LIMIT = 6;
export const IP_WINDOW_MS = 60 * 60 * 1000;
export const EMAIL_LIMIT = 3;
export const EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

export const VALUATION_STATUSES = ["NEW", "QUOTED", "LISTED", "CLOSED"] as const;
export type ValuationStatus = (typeof VALUATION_STATUSES)[number];

export const RATE_LIMITED = "That is a lot of valuations in a short time. Wait a while and try again, or write to the desk.";

// A loan as the request keeps it: the facts the model prices, and nothing that names the borrower.
export type ValuationLoan = {
  state: string;
  city: string;
  lienPosition: string;
  paymentStatus: string;
  occupancy: string;
  upb: number;
  interestRate: number;
  monthlyPi: number;
  estimatedValue: number;
  monthsDelinquent: number;
  maturityDate: string | null;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function figure(raw: unknown) {
  const text = String(raw ?? "").trim();
  return text ? typedNumber(text) : Number.NaN;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the loans.

export type TypedLoan = Partial<Record<"state" | "lienPosition" | "paymentStatus" | "upb" | "interestRate" | "monthlyPi" | "estimatedValue" | "monthsDelinquent", string>>;

type Read = { error: string; loans?: undefined; skipped?: undefined } | { error: null; loans: ValuationLoan[]; skipped: number };

// Loans typed into the form. A row with no balance, rate, payment or value is a spare row and is skipped.
export function readTypedLoans(rows: TypedLoan[]): Read {
  // Numbered as the form numbers them, so "Loan 3" is the third row whichever rows were left blank.
  const filled = rows
    .map((row, index) => ({ row, n: index + 1 }))
    .filter(({ row }) => ["upb", "interestRate", "monthlyPi", "estimatedValue"].some((key) => String(row[key as keyof TypedLoan] ?? "").trim()));
  if (!filled.length) return { error: "Enter at least one loan, or upload a tape." };
  if (filled.length > MAX_TYPED_LOANS) return { error: `Type up to ${MAX_TYPED_LOANS} loans. For more, upload a tape.` };
  const loans: ValuationLoan[] = [];
  for (const { row, n } of filled) {
    const which = filled.length === 1 ? "The loan" : `Loan ${n}`;
    const state = String(row.state ?? "").trim().toUpperCase();
    const lien = String(row.lienPosition ?? "");
    const status = String(row.paymentStatus ?? "");
    if (!(US_STATES as readonly string[]).includes(state)) return { error: `${which} needs a US state.` };
    if (!LIEN_POSITIONS.some((item) => item.value === lien) || !PAYMENT_STATUSES.some((item) => item.value === status)) return { error: `${which} needs a lien and a payment status.` };
    const upb = figure(row.upb);
    const value = figure(row.estimatedValue);
    const rate = figure(row.interestRate);
    const pi = figure(row.monthlyPi);
    const behind = String(row.monthsDelinquent ?? "").trim() ? figure(row.monthsDelinquent) : 0;
    if (!(upb > 0) || !(value > 0)) return { error: `${which} needs an unpaid balance and a value above zero.` };
    if (!(rate >= 0 && rate <= 40)) return { error: `${which} needs a note rate from 0% to 40%.` };
    if (!(pi >= 0)) return { error: `${which} needs a monthly payment, or 0.` };
    if (!(behind >= 0 && behind <= 600)) return { error: `${which} has a months-behind figure that can't be right.` };
    loans.push({ state, city: "", lienPosition: lien, paymentStatus: status, occupancy: "UNKNOWN", upb, interestRate: rate, monthlyPi: pi, estimatedValue: value, monthsDelinquent: Math.round(behind), maturityDate: null });
  }
  return { error: null, loans, skipped: 0 };
}

// A tape, through the same parser and column guesses as a seller's upload. The ask isn't needed to value it, so
// every loan is read at par. Rows the parser refuses are counted and left out.
export async function readValuationTape(filename: string, bytes: Buffer): Promise<Read> {
  const ext = extensionOf(filename);
  if (ext !== "csv" && ext !== "xlsx" && ext !== "xls") return { error: "Upload the tape as a CSV or Excel file." };
  if (bytes.length > MAX_TAPE_BYTES) return { error: "Keep the tape under 20 MB." };
  const [{ normalizeTapeRows, parseTapeBuffer }, { suggestMapping }] = await Promise.all([import("@/lib/tape"), import("@/lib/tape-fields")]);
  let matrix;
  try {
    matrix = parseTapeBuffer(bytes, filename);
  } catch {
    return { error: "That file could not be read. Save it as CSV or XLSX and try again." };
  }
  if (!matrix.headers.length || !matrix.rows.length) return { error: "The tape has no loan rows under its header row." };
  if (matrix.rows.length > MAX_TAPE_ROWS) return { error: `Tapes over ${MAX_TAPE_ROWS.toLocaleString("en-US")} rows go to the desk directly. Write to the desk.` };
  const mapping = suggestMapping(matrix.headers);
  const { loans, errors } = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: "PERCENT", pricePercent: 100 });
  if (!loans.length) {
    const first = errors.find((row) => row.row > 0);
    return { error: first ? `No loan could be read. Row ${first.row}: ${first.message}.` : "No loan could be read. Check the tape has balance, rate, value, state, lien and status columns." };
  }
  return {
    error: null,
    skipped: errors.filter((row) => row.row > 0).length,
    loans: loans.map((loan) => ({
      state: loan.state,
      city: loan.city,
      lienPosition: loan.lienPosition,
      paymentStatus: loan.paymentStatus,
      occupancy: loan.occupancy,
      upb: loan.upb,
      interestRate: loan.interestRate,
      monthlyPi: loan.monthlyPi,
      estimatedValue: loan.estimatedValue,
      monthsDelinquent: loan.monthsDelinquent,
      maturityDate: loan.maturityDate ? loan.maturityDate.toISOString().slice(0, 10) : null,
    })),
  };
}

// The loans kept on a request, as stored.
export function storedLoans(rows: unknown): ValuationLoan[] {
  return Array.isArray(rows) ? (rows.filter((row) => row && typeof row === "object" && Number((row as ValuationLoan).upb) > 0) as ValuationLoan[]) : [];
}

// ---------------------------------------------------------------------------------------------------------------
// The range.

export type ValuationRange = { lowPrice: number; highPrice: number; low: number | null; high: number | null; basis: string };

function indicativeNote(loan: ValuationLoan): IndicativeNote {
  return {
    upb: loan.upb,
    interestRate: loan.interestRate,
    monthlyPi: loan.monthlyPi,
    estimatedValue: loan.estimatedValue,
    state: loan.state,
    paymentStatus: loan.paymentStatus,
    occupancy: OCCUPANCIES.some((item) => item.value === loan.occupancy) ? loan.occupancy : "UNKNOWN",
    lienPosition: loan.lienPosition,
    monthsDelinquent: loan.monthsDelinquent,
    maturityDate: loan.maturityDate,
    avm: null,
    valueType: null,
    valueAsOf: null,
  };
}

// The desk model at its target yield and the closed-trade comps for loans like these, as the book's indicative
// price is built, without the buy-box standing bids, which stay with signed-in buyers. When neither can price the
// loans, the desk's bands by performance from the single-note quote stand in. The public demand board shows how many
// buyers there are, never what they would pay (lib/demand-board.ts).
export function valuationRange(loans: ValuationLoan[], context: { targetYield: number | null | undefined; premiumBps: number; trades: ClosedTrade[]; now: Date }): ValuationRange {
  const notes = loans.map(indicativeNote);
  const comps = notes.length ? compsFor(compSubjectOf(notes), context.trades, MIN_TRADES, context.now) : null;
  const range = indicativeRange({
    notes,
    targetYield: context.targetYield,
    comps,
    compsWindowMonths: COMP_WINDOW_MONTHS,
    standing: [],
    premiumBps: context.premiumBps,
    now: context.now,
  });
  const scope = `Priced on ${plural(loans.length, "loan")} as you entered ${loans.length === 1 ? "it" : "them"}, before the desk reads any file.`;
  if (range) {
    const value = range.valueBasis ? ` ${range.valueBasis}` : "";
    // How many trades the comps rest on and how recent the latest is (lib/comps.ts).
    const traded = comps && range.sources.some((row) => row.key === "comps") ? ` Closed-trade comps: ${cellFacts(comps)}.` : "";
    return { lowPrice: range.lowPrice, highPrice: range.highPrice, low: range.low, high: range.high, basis: `${range.basis}${value}${traded} ${scope}` };
  }
  let low = 0;
  let high = 0;
  for (const loan of loans) {
    const quote = indicativeQuote({ state: loan.state, paymentStatus: loan.paymentStatus, upb: loan.upb, estimatedValue: loan.estimatedValue, interestRate: loan.interestRate, monthlyPi: loan.monthlyPi });
    low += quote.low;
    high += quote.high;
  }
  return { lowPrice: low, highPrice: high, low: null, high: null, basis: `The desk's bands for each loan's performance, as of ${prettyDate(context.now)}. The model couldn't price every loan and there are too few closed trades like these. ${scope}` };
}

async function rangeNow(loans: ValuationLoan[], now: Date) {
  const [settings, trades] = await Promise.all([getSettings(), loadClosedTrades(now).catch(() => [] as ClosedTrade[])]);
  const upb = loans.reduce((sum, loan) => sum + loan.upb, 0);
  // The model holds its yield after the buyer premium; a graded schedule is read at the tier for the balance.
  const premiumBps = chargeFees(feeTerms(null, settings), upb).premiumBps;
  return valuationRange(loans, { targetYield: settings.indicativeTargetYield, premiumBps, trades, now });
}

// ---------------------------------------------------------------------------------------------------------------
// The request.

export type RequestInput = {
  name: string;
  email: string;
  company: string;
  phone?: string;
  terms: unknown;
  typed?: TypedLoan[];
  tape?: { name: string; bytes: Buffer } | null;
  ipAddress: string;
  userId?: string | null;
  now?: Date;
  // Where the tape is kept, and how the names are screened. Tests pass their own.
  store?: (key: string, bytes: Buffer) => Promise<void>;
  screen?: (work: () => Promise<unknown>) => void;
};

export type RequestResult = { error: string; id?: undefined } | { error: null; id: string; range: ValuationRange };

export async function requestValuation(input: RequestInput): Promise<RequestResult> {
  const now = input.now ?? new Date();
  if (!(await consumeRateLimit(`valuation-ip:${input.ipAddress}`, IP_LIMIT, IP_WINDOW_MS, now.getTime()))) return { error: RATE_LIMITED };
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 120);
  const email = input.email.trim().toLowerCase().slice(0, 200);
  const company = input.company.replace(/\s+/g, " ").trim().slice(0, 160);
  const phone = String(input.phone ?? "").trim().slice(0, 40);
  if (name.length < 2) return { error: "Enter your name." };
  if (!EMAIL.test(email)) return { error: "Enter an email the desk can answer." };
  if (company.length < 2) return { error: "Enter your company, or your own name if you hold the loans yourself." };
  if (input.terms !== "yes" && input.terms !== "on") return { error: "Tick the box to agree to the terms of use." };
  if (!(await consumeRateLimit(`valuation-email:${email}`, EMAIL_LIMIT, EMAIL_WINDOW_MS, now.getTime()))) return { error: RATE_LIMITED };
  const tape = input.tape && input.tape.bytes.length ? input.tape : null;
  const read = tape ? await readValuationTape(tape.name, tape.bytes) : readTypedLoans(input.typed ?? []);
  if (read.error !== null) return { error: read.error };
  const range = await rangeNow(read.loans, now);
  const skipped = read.skipped ? ` ${plural(read.skipped, "row")} of the tape couldn't be read and ${read.skipped === 1 ? "is" : "are"} left out.` : "";
  let tapeKey = "";
  if (tape) {
    tapeKey = `valuations/${crypto.randomUUID()}-${safeBasename(tape.name).slice(0, 120)}`;
    await (input.store ?? ((key, bytes) => putBytes(key, bytes)))(tapeKey, tape.bytes);
  }
  const upb = read.loans.reduce((sum, loan) => sum + loan.upb, 0);
  const created = await prisma.valuationRequest.create({
    data: {
      userId: input.userId ?? null,
      name,
      email,
      company,
      phone,
      loans: read.loans.length,
      upb,
      rows: read.loans,
      tapeKey,
      tapeName: tape ? safeBasename(tape.name).slice(0, 180) : "",
      lowPrice: range.lowPrice,
      highPrice: range.highPrice,
      basis: `${range.basis}${skipped}`,
    },
  });
  // The names are screened as any new party is; the request waits on nothing.
  (input.screen ?? screenInBackground)(async () => {
    for (const party of new Set([name, company])) await screenAndRecord(party, { context: `Valuation request from ${email}`, userId: input.userId ?? null });
  });
  await notifyDesk(
    `Valuation request · ${name}`,
    `${name}${company && company !== name ? ` at ${company}` : ""} asked for a valuation of ${plural(read.loans.length, "loan")}, ${money(upb)} UPB. The instant range was ${money(range.lowPrice)} to ${money(range.highPrice)}. Work it at /admin/valuations/${created.id}.`,
    { capability: "sales" },
  );
  await rememberValuation(created.id);
  return { error: null, id: created.id, range };
}

// ---------------------------------------------------------------------------------------------------------------
// From the result page to a seller account.

// The browser that sent a request keeps a signed cookie naming it, so signing up there fills in the name, email and
// company. The result page's link carries only the id, and the id alone shows nobody who asked: a forwarded link
// fills in nothing, as the quote page's lead link fills in no address (app/signup/page.tsx).
export const VALUATION_COOKIE = "upb-valuation";
const COOKIE_DAYS = 30;
const ROW_ID = /^[\w-]{1,64}$/;
const SELLER_ROLES = new Set(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);

function cookieSig(id: string, secret: string) {
  return createHmac("sha256", secret).update(`upb-valuation:${id}`).digest("base64url");
}

export function valuationCookieValue(id: string, secret = process.env.AUTH_SECRET || "") {
  return secret && ROW_ID.test(id) ? `${id}.${cookieSig(id, secret)}` : null;
}

export function readValuationCookie(value: string | null | undefined, secret = process.env.AUTH_SECRET || "") {
  const [id, given, extra] = (value ?? "").split(".");
  if (!secret || extra !== undefined || !id || !given || !ROW_ID.test(id)) return null;
  const expected = Buffer.from(cookieSig(id, secret));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? id : null;
}

async function rememberValuation(id: string) {
  const value = valuationCookieValue(id);
  if (!value) return;
  try {
    (await cookies()).set(VALUATION_COOKIE, value, { httpOnly: true, sameSite: "lax", secure: secureCookies(), path: "/", maxAge: COOKIE_DAYS * 24 * 60 * 60 });
  } catch {
    // Outside a request, as in a job or a test, there is no browser to remember it.
  }
}

// The same address however it was typed: case and spaces don't count.
export function sameEmail(a: string, b: string) {
  const norm = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  return norm(a).length > 0 && norm(a) === norm(b);
}

// One loan is a note seller's to list; several, or a tape, an institution's. The desk's invite picks the same way.
export function sellerRoleFor(request: { loans: number; tapeKey?: string | null }) {
  return request.loans === 1 && !request.tapeKey ? "INDIVIDUAL_SELLER" : "INSTITUTIONAL_SELLER";
}

export type SignupPrefill = { id: string; role: "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER"; name: string; email: string; company: string };

// What the signup form starts with for a request. The seller role always; the name, email and company only in the
// browser that sent it.
export async function signupPrefill(id: string, cookie: string | null | undefined): Promise<SignupPrefill | null> {
  const request = ROW_ID.test(id) ? await prisma.valuationRequest.findUnique({ where: { id }, select: { id: true, loans: true, tapeKey: true, name: true, email: true, company: true, userId: true } }) : null;
  if (!request || request.userId) return null;
  const own = readValuationCookie(cookie) === request.id;
  return { id: request.id, role: sellerRoleFor(request), name: own ? request.name : "", email: own ? request.email : "", company: own ? request.company : "" };
}

// At signup: the request joins the new seller account only when the account's email is the request's, and only when
// no account has it yet. The id from the form alone never attaches anyone's request.
export async function linkValuationAtSignup(input: { valuationId: string; userId: string; email: string; role: string }) {
  if (!SELLER_ROLES.has(input.role) || !input.valuationId) return false;
  const request = ROW_ID.test(input.valuationId) ? await prisma.valuationRequest.findUnique({ where: { id: input.valuationId }, select: { id: true, email: true, userId: true } }) : null;
  if (!request || request.userId || !sameEmail(request.email, input.email)) return false;
  const claim = await prisma.valuationRequest.updateMany({ where: { id: request.id, ...unset("userId") }, data: { userId: input.userId } });
  if (claim.count !== 1) return false;
  await audit(input.userId, "VALUATION_SIGNUP", "valuation", request.id, "Joined the account that signed up with its email");
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// From the request to a listing.

// A listing comes from a request when it is the same seller's, filed after the request, and at least half its loans
// are loans the request priced: the same state and the same balance to the dollar. That holds whether the seller
// filed it or the desk filed it for them in intake, and it can't take another seller's listing.
export function listingFromValuation(loans: { state: string; upb: number }[], notes: { state: string; upb: number }[]) {
  if (!loans.length || !notes.length) return false;
  const keyOf = (row: { state: string; upb: number }) => `${row.state.trim().toUpperCase()}:${Math.round(row.upb)}`;
  const left = new Map<string, number>();
  for (const loan of loans) left.set(keyOf(loan), (left.get(keyOf(loan)) ?? 0) + 1);
  let matched = 0;
  for (const note of notes) {
    const count = left.get(keyOf(note)) ?? 0;
    if (!count) continue;
    left.set(keyOf(note), count - 1);
    matched += 1;
  }
  return matched * 2 >= notes.length;
}

// Marks the request listed, once. The desk's own link and the match below both come here.
export async function markValuationListed(input: { id: string; listingId: string; actorId: string | null; how: string }) {
  const claim = await prisma.valuationRequest.updateMany({ where: { id: input.id, status: { in: ["NEW", "QUOTED"] }, ...unset("listingId") }, data: { listingId: input.listingId, status: "LISTED" } });
  if (claim.count !== 1) return false;
  await audit(input.actorId, "VALUATION_LISTED", "valuation", input.id, `${input.listingId} · ${input.how}`);
  return true;
}

// Open requests on a seller's account, checked against that seller's listings filed since. A listing ties to one
// request at most. Run when the seller's desk or the queue loads, so a listing from any path is found.
export async function linkValuationListings(scope: { userId?: string; ids?: string[]; since?: Date }) {
  const requests = await prisma.valuationRequest.findMany({
    where: {
      status: { in: ["NEW", "QUOTED"] },
      userId: scope.userId ?? { not: null },
      ...(scope.ids ? { id: { in: scope.ids } } : {}),
      ...(scope.since ? { createdAt: { gte: scope.since } } : {}),
      ...unset("listingId"),
    },
    select: { id: true, userId: true, rows: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  let linked = 0;
  for (const sellerId of new Set(requests.map((request) => request.userId).filter((id): id is string => Boolean(id)))) {
    const own = requests.filter((request) => request.userId === sellerId);
    const listings = await prisma.listing.findMany({
      where: { sellerId, createdAt: { gte: own[0].createdAt }, status: { notIn: ["REJECTED", "WITHDRAWN"] } },
      select: { id: true, createdAt: true, notes: { select: { state: true, upb: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!listings.length) continue;
    const taken = new Set(
      (await prisma.valuationRequest.findMany({ where: { listingId: { in: listings.map((listing) => listing.id) } }, select: { listingId: true } })).map((row) => row.listingId),
    );
    for (const request of own) {
      const loans = storedLoans(request.rows);
      const listing = listings.find((row) => !taken.has(row.id) && row.createdAt >= request.createdAt && listingFromValuation(loans, row.notes.map((note) => ({ state: note.state, upb: Number(note.upb) }))));
      if (!listing) continue;
      if (await markValuationListed({ id: request.id, listingId: listing.id, actorId: null, how: "its loans match the request" })) {
        taken.add(listing.id);
        linked += 1;
      }
    }
  }
  return linked;
}

export type SellerValuation = { id: string; loans: number; upb: number; lowPrice: number | null; highPrice: number | null; quoted: boolean; tape: boolean; askedDesk: boolean };

// The open requests on a seller's own account, for the seller's desk, newest first.
export async function sellerValuations(userId: string): Promise<SellerValuation[]> {
  await linkValuationListings({ userId });
  const rows = await prisma.valuationRequest.findMany({
    where: { userId, status: { in: ["NEW", "QUOTED"] }, ...unset("listingId") },
    select: { id: true, loans: true, upb: true, lowPrice: true, highPrice: true, status: true, tapeKey: true },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  const asked = rows.length
    ? new Set((await prisma.auditEvent.findMany({ where: { entityType: "valuation", entityId: { in: rows.map((row) => row.id) }, action: "VALUATION_FILE_ASKED" }, select: { entityId: true } })).map((row) => row.entityId))
    : new Set<string>();
  return rows.map((row) => ({ id: row.id, loans: row.loans, upb: row.upb, lowPrice: row.lowPrice, highPrice: row.highPrice, quoted: row.status === "QUOTED", tape: Boolean(row.tapeKey), askedDesk: asked.has(row.id) }));
}

// The seller asks the desk to file the tape they sent. The desk opens it in intake from the request; the seller then
// confirms each listing it files before buyers see anything (lib/desk-intake.ts).
export async function askDeskToFile(user: { id: string; name: string; companyName?: string | null }, id: string): Promise<DeskResult & { already?: boolean }> {
  const request = ROW_ID.test(id) ? await prisma.valuationRequest.findUnique({ where: { id } }) : null;
  if (!request || request.userId !== user.id) return { error: "That valuation isn't on your account." };
  if (request.listingId || request.status === "LISTED" || request.status === "CLOSED") return { error: "This valuation is already listed or closed." };
  if (!request.tapeKey) return { error: "The desk files from a tape. List these loans yourself, or send the tape from Value my loans." };
  if (await prisma.auditEvent.findFirst({ where: { entityType: "valuation", entityId: request.id, action: "VALUATION_FILE_ASKED" }, select: { id: true } })) return { error: null, already: true };
  const who = user.companyName || user.name;
  await notifyDesk(
    `File a tape · ${who}`,
    `${who} asked the desk to file the tape from their valuation: ${plural(request.loans, "loan")}, ${money(request.upb)} UPB. Open it in desk intake from /admin/valuations/${request.id}.`,
    { capability: "sales" },
  );
  await audit(user.id, "VALUATION_FILE_ASKED", "valuation", request.id, request.tapeName);
  return { error: null };
}

// The desk opens a request's tape in desk intake: the file is staged as the desk member's tape draft for the
// seller's account, with the desk's price and split, and the intake page shows the preview. Filing stays there.
export async function stageValuationIntake(
  actor: Staff & { id: string },
  input: { id: string; priceMode: PriceMode; percent: number | null; rules: SplitRule[]; bands: number[] },
): Promise<{ error: string; staged?: undefined } | { error: null; staged: StagedIntake }> {
  if (actor.role !== "ADMIN" || !deskCan(actor, "sales")) return { error: DESK_DENIED };
  const { request, error } = await openRequest(input.id);
  if (!request) return { error };
  if (request.listingId || request.status === "CLOSED") return { error: "This request is already listed or closed." };
  if (!request.tapeKey) return { error: "This request has no tape. Ask the seller for one." };
  const seller = request.userId ? await prisma.user.findUnique({ where: { id: request.userId }, select: { role: true, accountStatus: true, deletedAt: true } }) : null;
  if (!seller || !SELLER_ROLES.has(seller.role) || seller.deletedAt) return { error: "Tie the request to the seller's account first: invite them to list." };
  if (seller.accountStatus !== "APPROVED") return { error: "The seller's account isn't approved yet. Approve it in Accounts first." };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await getBytes(request.tapeKey));
  } catch {
    return { error: "The tape file is missing. Ask the seller to send it again." };
  }
  const filename = (request.tapeName || "tape.csv").slice(0, 180);
  // The same checks as a tape the desk uploads on the intake page, its 10 MB limit included.
  if (bytes.length > MAX_INTAKE_BYTES) return { error: "Tapes are limited to 10 MB in desk intake. Ask the seller to split it." };
  const problem = uploadProblem(filename, bytes.length, bytes, MAX_INTAKE_BYTES);
  if (problem) return { error: problem };
  const read = readIntakeTape({ filename, bytes, priceMode: input.priceMode, percent: input.percent ?? undefined });
  if (!read.ok) return { error: read.error };
  const token = crypto.randomUUID();
  await saveTapeDraft({ token, userId: actor.id, filename, bytes });
  await audit(actor.id, "VALUATION_INTAKE", "valuation", request.id, "Tape opened in desk intake");
  return { error: null, staged: { token, sellerId: request.userId!, priceMode: input.priceMode, percent: input.percent, rules: input.rules, bands: input.bands } };
}

// ---------------------------------------------------------------------------------------------------------------
// The conversion line: requests, those with an account, those listed, and those whose listing closed a sale.

export const FUNNEL_DAYS = 90;
export type ValuationFunnel = { requests: number; signedUp: number; listed: number; closed: number };
export type FunnelRow = { createdAt: Date; userId: string | null; listingId: string | null; sold: boolean };

export function funnelOf(rows: FunnelRow[]): ValuationFunnel {
  return {
    requests: rows.length,
    signedUp: rows.filter((row) => row.userId).length,
    listed: rows.filter((row) => row.listingId).length,
    closed: rows.filter((row) => row.listingId && row.sold).length,
  };
}

// Requests made in the range, each with whether its listing has a completed closing yet.
export async function funnelRows(range: { start: Date; end: Date }): Promise<FunnelRow[]> {
  const rows = await prisma.valuationRequest.findMany({ where: { createdAt: { gte: range.start, lt: range.end } }, select: { createdAt: true, userId: true, listingId: true } });
  const listingIds = [...new Set(rows.flatMap((row) => (row.listingId ? [row.listingId] : [])))];
  const sold = new Set(
    listingIds.length ? (await prisma.closing.findMany({ where: { listingId: { in: listingIds }, status: "COMPLETE" }, select: { listingId: true } })).map((row) => row.listingId) : [],
  );
  return rows.map((row) => ({ createdAt: row.createdAt, userId: row.userId ?? null, listingId: row.listingId ?? null, sold: Boolean(row.listingId && sold.has(row.listingId)) }));
}

// The queue's line over the last 90 days.
export async function valuationFunnel(now = new Date()) {
  const start = new Date(now.getTime() - FUNNEL_DAYS * 24 * 60 * 60 * 1000);
  await linkValuationListings({ since: start });
  return funnelOf(await funnelRows({ start, end: now }));
}

// ---------------------------------------------------------------------------------------------------------------
// The desk's queue.

type Actor = { id: string; name: string };
type DeskResult = { error: string } | { error: null };

async function openRequest(id: string) {
  const request = await prisma.valuationRequest.findUnique({ where: { id } });
  if (!request) return { request: null, error: "That request no longer exists." } as const;
  return { request, error: null } as const;
}

// The desk's own range, with a note the seller reads. It goes to the seller by email and marks the request quoted.
export async function quoteValuation(input: { id: string; low: unknown; high: unknown; note: string; actor: Actor }): Promise<DeskResult> {
  const { request, error } = await openRequest(input.id);
  if (!request) return { error };
  if (request.status === "CLOSED") return { error: "This request is closed." };
  const low = figure(input.low);
  const high = figure(input.high);
  if (!(low > 0) || !(high > 0)) return { error: "Enter the low and high of the range in dollars." };
  if (high < low) return { error: "The high end can't be below the low end." };
  if (high > request.upb * 2) return { error: "That range is over twice the balance. Check the figures." };
  const note = input.note.replace(/\r\n/g, "\n").trim().slice(0, 2000);
  if (note.length < 3) return { error: "Add a note that says what the range rests on. The seller reads it." };
  const before = `${money(request.lowPrice ?? 0)} to ${money(request.highPrice ?? 0)}`;
  await prisma.valuationRequest.update({ where: { id: request.id }, data: { lowPrice: Math.round(low), highPrice: Math.round(high), deskNote: note, status: request.status === "LISTED" ? "LISTED" : "QUOTED" } });
  await notify(
    request.email,
    `Your valuation · ${plural(request.loans, "loan")}`,
    `The UPB Capital desk looked at the ${plural(request.loans, "loan")} you sent, ${money(request.upb)} UPB.\n\nIndicative range: ${money(Math.round(low))} to ${money(Math.round(high))}.\n\n${note}\n\nThis is an estimate, not an offer to buy. A price is set only when buyers bid on a listing. To list the loans, reply to this email or create a seller account at /signup?valuation=${request.id}.`,
  );
  await audit(input.actor.id, "VALUATION_QUOTED", "valuation", request.id, `Range ${before} to ${money(Math.round(low))} to ${money(Math.round(high))}`);
  return { error: null };
}

// Asks the seller to list. A seller with no account gets an account invite; one with an account is told to sign in
// and list. The request then follows that account.
export async function inviteFromValuation(input: { id: string; role: string; actor: Actor }): Promise<DeskResult & { invited?: boolean }> {
  const { request, error } = await openRequest(input.id);
  if (!request) return { error };
  if (request.status === "CLOSED") return { error: "This request is closed." };
  if (input.role !== "INDIVIDUAL_SELLER" && input.role !== "INSTITUTIONAL_SELLER") return { error: "Choose an individual or institutional seller account." };
  const existing = await prisma.user.findUnique({ where: { email: request.email }, select: { id: true, role: true } });
  if (existing) {
    if (existing.role !== "INDIVIDUAL_SELLER" && existing.role !== "INSTITUTIONAL_SELLER") return { error: "That email belongs to an account that isn't a seller. Talk to the person first." };
    await prisma.valuationRequest.update({ where: { id: request.id }, data: { userId: existing.id } });
    await notify(
      request.email,
      "List your loans on UPB Capital",
      `The desk would like to list the ${plural(request.loans, "loan")} you asked about. Sign in and ${existing.role === "INSTITUTIONAL_SELLER" ? "upload the tape at /seller/pools/new" : "list each note at /seller/notes/new"}. The desk reviews the file before anything goes live.`,
    );
    await audit(input.actor.id, "VALUATION_INVITE", "valuation", request.id, "Asked an existing seller account to list");
    return { error: null, invited: false };
  }
  const { inviteUser } = await import("@/lib/invites");
  const invite = await inviteUser({ actor: input.actor, name: request.name, email: request.email, companyName: request.company, role: input.role, status: input.role === "INSTITUTIONAL_SELLER" ? "PENDING" : "APPROVED" });
  if (invite.error !== null) return { error: invite.error };
  await prisma.valuationRequest.update({ where: { id: request.id }, data: { userId: invite.userId } });
  await audit(input.actor.id, "VALUATION_INVITE", "valuation", request.id, `Invited ${request.email} as a seller`);
  return { error: null, invited: true };
}

// Ties the request to the listing the seller filed, which marks it listed.
export async function linkValuationListing(input: { id: string; listingId: string; actor: Actor }): Promise<DeskResult> {
  const { request, error } = await openRequest(input.id);
  if (!request) return { error };
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, sellerId: true } });
  if (!listing) return { error: "That listing doesn't exist." };
  if (request.userId && listing.sellerId !== request.userId) return { error: "That listing belongs to another seller." };
  await prisma.valuationRequest.update({ where: { id: request.id }, data: { listingId: listing.id, userId: listing.sellerId, status: "LISTED" } });
  await audit(input.actor.id, "VALUATION_LISTED", "valuation", request.id, listing.id);
  return { error: null };
}

// Closes a request the desk won't take further, with the reason kept for the desk.
export async function closeValuation(input: { id: string; note: string; actor: Actor }): Promise<DeskResult> {
  const { request, error } = await openRequest(input.id);
  if (!request) return { error };
  if (request.status === "CLOSED") return { error: "This request is already closed." };
  const note = input.note.replace(/\s+/g, " ").trim().slice(0, 500);
  if (note.length < 3) return { error: "Say why it's closing, in a few words. Only the desk sees it." };
  await prisma.valuationRequest.update({ where: { id: request.id }, data: { status: "CLOSED" } });
  await audit(input.actor.id, "VALUATION_CLOSED", "valuation", request.id, note);
  return { error: null };
}

export function statusLabel(status: string) {
  return status === "NEW" ? "New" : status === "QUOTED" ? "Quoted" : status === "LISTED" ? "Listed" : status === "CLOSED" ? "Closed" : status;
}
