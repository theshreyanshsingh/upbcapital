import { audit } from "@/lib/audit";
import { COMP_WINDOW_MONTHS, compsFor, loadClosedTrades, type ClosedTrade } from "@/lib/comps";
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
import { extensionOf, putBytes, safeBasename } from "@/lib/storage";

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
// loans, the desk's bands by performance from the single-note quote stand in.
export function valuationRange(loans: ValuationLoan[], context: { targetYield: number | null | undefined; premiumBps: number; trades: ClosedTrade[]; now: Date }): ValuationRange {
  const notes = loans.map(indicativeNote);
  const range = indicativeRange({
    notes,
    targetYield: context.targetYield,
    comps: notes.length ? compsFor(compSubjectOf(notes), context.trades) : null,
    compsWindowMonths: COMP_WINDOW_MONTHS,
    standing: [],
    premiumBps: context.premiumBps,
    now: context.now,
  });
  const scope = `Priced on ${plural(loans.length, "loan")} as you entered ${loans.length === 1 ? "it" : "them"}, before the desk reads any file.`;
  if (range) {
    const value = range.valueBasis ? ` ${range.valueBasis}` : "";
    return { lowPrice: range.lowPrice, highPrice: range.highPrice, low: range.low, high: range.high, basis: `${range.basis}${value} ${scope}` };
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
  return { error: null, id: created.id, range };
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
    `The UPB Capital desk looked at the ${plural(request.loans, "loan")} you sent, ${money(request.upb)} UPB.\n\nIndicative range: ${money(Math.round(low))} to ${money(Math.round(high))}.\n\n${note}\n\nThis is an estimate, not an offer to buy. A price is set only when buyers bid on a listing. To list the loans, reply to this email or create a seller account at /signup.`,
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
