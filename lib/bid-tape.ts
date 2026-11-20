import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { Inquiry, Listing, NdaAcknowledgment, Note, User } from "@prisma/client";
import { loanOpenTo, ndaOpensRoom } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { placeInquiry, type InquiryOutcome } from "@/lib/bid-form";
import { toCsv } from "@/lib/csv";
import { dealAccess } from "@/lib/data-room";
import { money, prettyDate } from "@/lib/format";
import { inquiryBlock } from "@/lib/inquiry";
import { regulatedLineFor } from "@/lib/institutions";
import { labelOf } from "@/lib/labels";
import { readLoanPrices, sumPrices, type LoanPrices } from "@/lib/loan-prices";
import { prisma } from "@/lib/prisma";
import { pausedBidBlock } from "@/lib/provenance";
import type { ActingUser } from "@/lib/seats";
import { isPro } from "@/lib/settings";
import { parseMoney } from "@/lib/tape";
import { normalizeHeader } from "@/lib/tape-fields";
import { attachmentName } from "@/lib/uploads";

// A bid tape: a pool's loans in a spreadsheet, one row each, with a Bid price column the buyer fills in their own
// model and uploads. The upload becomes a whole-pool bid with a price for each loan, placed through the bid form's own
// path (lib/bid-form.ts), so every check a typed bid meets applies to it unchanged.
//
// Each row is matched by its Loan ref, which is the loan's id. Buyers already see it: the buyer API's loans carry it
// and the listing page's loan links name it. It says nothing about the borrower or the property.

export const BID_TAPE_COLUMNS = ["Loan ref", "Loan number", "City", "State", "Lien", "Payment status", "UPB", "Rate %", "Ask", "Bid price"] as const;
export type BidTapeRow = Record<(typeof BID_TAPE_COLUMNS)[number], string | number | null>;

// The ceiling the counter, buy-it-now and wire checks hold a price to, for one loan and for the bid.
export const BID_TAPE_PRICE_CAP = 1_000_000_000;
export const MAX_BID_TAPE_BYTES = 5 * 1024 * 1024;
// How many row problems one refusal lists. The rest are counted.
const PROBLEMS_SHOWN = 8;

// The audit action on a bid placed from a tape. The seller's bid summary reads it (lib/seller-decisions.ts).
export const BID_TAPE_ACTION = "BID_TAPE";

const CLOSED = "This listing is not taking new inquiries.";
const TRADED = "Some loans in this pool have traded, so it can't be bid whole. Bid the loans still for sale in the table.";
const NOT_POOL = "Bid tapes are for pools. Bid this loan on its own form.";
const NO_REF = "The file has no Loan ref column. Start from the bid template for this pool.";
const NO_PRICE = "The file has no Bid price column. Start from the bid template for this pool.";
const READ_AGAIN = "Read the tape again before you confirm.";

// UPB takes a pool bid on the whole pool. Part of a pool is bid loan by loan, or taken from a whole-pool bid whose
// buyer lets the seller take part at their loan prices.
const PART_POOL_LINE =
  "Price every loan. A blank leaves the loan out, and part-pool bids aren't taken on this listing, so a tape with a blank is refused. To let the seller take part of the pool at your loan prices, tick that box when you confirm.";

export function partPoolRefusal(blank: number, total: number) {
  return `${blank} of ${total} loan${total === 1 ? "" : "s"} ${blank === 1 ? "has" : "have"} no bid price. Part-pool bids aren't taken on this listing, so price every loan. To buy single loans, bid them from the loan tape. To let the seller take part of the pool at your prices, price every loan and tick that box when you confirm.`;
}

// One loan as the tape shows it to this viewer. The loan number follows the street; the figures follow Pro.
export type BidTapeLoan = {
  ref: string;
  label: string;
  loanNumber: string;
  city: string;
  state: string;
  lien: string;
  status: string;
  upb: number | null;
  rate: number | null;
  ask: number | null;
};

type TapeListing = Listing & { notes: Note[]; ndas: NdaAcknowledgment[] };
type Viewer = User;

const round2 = (amount: number) => Math.round(amount * 100) / 100;

function loadListing(listingId: string, userId: string) {
  return prisma.listing.findUnique({
    where: { id: listingId },
    include: { notes: { orderBy: { createdAt: "asc" } }, ndas: { where: { userId } } },
  });
}

// The pool's loans as this viewer reads them. A loan's number opens with its street, by the listing page's rule, and
// UPB, rate and ask show on Pro, as in the loan tape.
async function tapeLoans(user: Viewer, listing: TapeListing) {
  const deal = await dealAccess(listing.id, user.id);
  const signedNda = ndaOpensRoom(listing.ndas[0]);
  const pro = isPro(user);
  let withheld = false;
  const loans: BidTapeLoan[] = listing.notes.map((note, index) => {
    const open = loanOpenTo({ tradeStatus: note.tradeStatus, listingStatus: listing.status, signedNda, wholeParty: deal.whole, loanParty: deal.loans.has(note.id) });
    if (!open) withheld = true;
    return {
      ref: note.id,
      label: `Loan ${index + 1} · ${note.city}, ${note.state}`,
      loanNumber: open ? note.loanNumber ?? "" : "",
      city: note.city,
      state: note.state,
      lien: labelOf("lien", note.lienPosition),
      status: labelOf("payment", note.paymentStatus),
      upb: pro ? Number(note.upb) : null,
      rate: pro ? Number(note.interestRate) : null,
      ask: pro ? Number(note.askingPrice) : null,
    };
  });
  return { loans, pro, withheld };
}

// Whether this buyer may bid this pool by tape: the listing's own gates, in the order the bid form meets them. The
// buyer's file, funds and covenants are checked when the bid is placed, as for a typed bid.
export async function bidTapeView(user: Viewer, listingId: string) {
  if (user.role !== "BUYER" || user.accountStatus !== "APPROVED") return { error: "Bid tapes are for approved buyers.", status: 403 } as const;
  const listing = await loadListing(listingId, user.id);
  // Hidden reads as closed, never as hidden (lib/inquiry.ts).
  const blocked = await inquiryBlock(user, listing);
  if (blocked || !listing) return { error: blocked ?? CLOSED, status: 404 } as const;
  if (listing.kind !== "POOL") return { error: NOT_POOL, status: 400 } as const;
  const paused = await pausedBidBlock(listing);
  if (paused) return { error: paused, status: 409 } as const;
  const limited = await regulatedLineFor(listing, user);
  if (limited) return { error: limited, status: 403 } as const;
  // Every loan is still for sale from here on, since a pool with a traded loan can't be bid whole.
  if (listing.notes.some((note) => note.tradeStatus !== "AVAILABLE")) return { error: TRADED, status: 409 } as const;
  return { error: null, listing, ...(await tapeLoans(user, listing)) } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// The file: rows, the note that goes with them, and the CSV and Excel copies.

export function bidTapeRows(loans: BidTapeLoan[], prices?: LoanPrices | null): BidTapeRow[] {
  return loans.map((loan) => ({
    "Loan ref": loan.ref,
    "Loan number": loan.loanNumber,
    City: loan.city,
    State: loan.state,
    Lien: loan.lien,
    "Payment status": loan.status,
    UPB: loan.upb,
    "Rate %": loan.rate,
    Ask: loan.ask,
    "Bid price": prices?.[loan.ref] ?? null,
  }));
}

export function bidTapeNote(input: { title: string; pro: boolean; withheld: boolean; placed?: { at: Date; count: number; total: number } | null }) {
  const lines = input.placed
    ? [`Your bid on ${input.title} as placed ${prettyDate(input.placed.at)}: ${input.placed.count} loans, ${money(input.placed.total, 2)} in all. This copy isn't a bid. To bid again, upload it on the listing's bid form.`]
    : [`Bid tape for ${input.title}, one row per loan still for sale.`];
  lines.push(
    "Enter your price for each loan in the Bid price column, in dollars. A $ sign and commas are fine.",
    PART_POOL_LINE,
    "Rows are matched by Loan ref, so leave that column as it is. Add columns of your own if you like; the rest are ignored.",
    "Upload the file on the listing's bid form. You see the total before you confirm, and nothing is placed until you do.",
  );
  if (!input.pro) lines.push("UPB, rate and ask show on Pro, like the loan tape's other figures.");
  if (input.withheld) lines.push("Loan numbers show once the data room opens to you.");
  return lines;
}

// The note sits above the table as a short block, and the reader finds the table by its Loan ref header.
export function bidTapeCsv(file: { lines: string[]; rows: BidTapeRow[] }) {
  const note = toCsv(file.lines.map((line) => ({ "UPB Capital bid tape": line })));
  const table = file.rows.length ? toCsv(file.rows) : BID_TAPE_COLUMNS.join(",");
  return `${note}\n\n${table}\n`;
}

// The table on the first sheet, header in row 1, and the note on its own sheet.
export function bidTapeXlsx(file: { lines: string[]; rows: BidTapeRow[] }) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(file.rows, { header: [...BID_TAPE_COLUMNS] });
  sheet["!cols"] = BID_TAPE_COLUMNS.map((column) => ({ wch: column === "Loan ref" ? 28 : column === "Payment status" ? 18 : 14 }));
  XLSX.utils.book_append_sheet(book, sheet, "Bid tape");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Instructions"], ...file.lines.map((line) => [line])]), "Instructions");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export type BidTapeFile = { error: null; title: string; lines: string[]; rows: BidTapeRow[] } | { error: string; status: number };

// The template for a pool this buyer may bid, with the Bid price column empty.
export async function bidTapeTemplate(user: Viewer, listingId: string): Promise<BidTapeFile> {
  const view = await bidTapeView(user, listingId);
  if (view.error !== null) return view;
  return { error: null, title: view.listing.title, lines: bidTapeNote({ title: view.listing.title, pro: view.pro, withheld: view.withheld }), rows: bidTapeRows(view.loans) };
}

// The buyer's own whole-pool bid as a filled tape, by the same rules for what shows. Nobody else's.
export async function submittedBidTape(user: Viewer, listingId: string, inquiryId: string): Promise<BidTapeFile> {
  const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId } });
  if (user.role !== "BUYER" || !inquiry || inquiry.buyerId !== user.id || inquiry.listingId !== listingId || inquiry.type !== "OFFER" || inquiry.noteId) {
    return { error: "Not found.", status: 404 };
  }
  const prices = readLoanPrices(inquiry.loanPrices);
  if (!prices) return { error: "This bid has no loan prices to put on a tape.", status: 404 };
  const listing = await loadListing(listingId, user.id);
  if (!listing) return { error: "Not found.", status: 404 };
  const { loans, pro, withheld } = await tapeLoans(user, listing);
  const priced = loans.filter((loan) => prices[loan.ref] != null);
  return {
    error: null,
    title: listing.title,
    lines: bidTapeNote({ title: listing.title, pro, withheld, placed: { at: inquiry.createdAt, count: priced.length, total: round2(sumPrices(prices)) } }),
    rows: bidTapeRows(priced, prices),
  };
}

// The buyer's own whole-pool bids here that carry loan prices, for a link to each as a tape.
export function tapeDownloads(inquiries: Pick<Inquiry, "id" | "type" | "noteId" | "loanPrices">[]) {
  return inquiries.flatMap((inquiry) => {
    const prices = inquiry.type === "OFFER" && !inquiry.noteId ? readLoanPrices(inquiry.loanPrices) : null;
    return prices ? [{ id: inquiry.id, label: `Your ${money(sumPrices(prices))} bid as a tape` }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Reading an upload.

// The file as rows of text, index 0 being the sheet's row 1, so a problem names the row the buyer sees. An Excel
// workbook is read from the first sheet with a Loan ref header, whatever order the buyer left the sheets in.
export function bidTapeMatrix(bytes: Buffer, filename: string): string[][] {
  if (/\.(csv|txt)$/i.test(filename)) {
    const parsed = Papa.parse<string[]>(bytes.toString("utf8"), { skipEmptyLines: false });
    return parsed.data.map((row) => row.map((cell) => String(cell ?? "")));
  }
  const book = XLSX.read(bytes, { type: "buffer" });
  let first: string[][] | null = null;
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    const start = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s.r : 0;
    const body = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: true });
    const matrix = [...Array.from({ length: start }, () => [] as string[]), ...body.map((row) => row.map((cell) => (cell == null ? "" : String(cell))))];
    if (headerAt(matrix) >= 0) return matrix;
    first ??= matrix;
  }
  return first ?? [];
}

function headerAt(matrix: string[][]) {
  return matrix.findIndex((row) => row.some((cell) => normalizeHeader(cell) === "loanref"));
}

// Why one loan's price can't stand, or null. A dollar is the least a loan price can be (lib/loan-prices.ts).
function priceProblem(amount: number | null) {
  if (amount == null || !Number.isFinite(amount)) return "doesn't read as dollars";
  if (amount <= 0) return "must be more than zero";
  if (amount < 1) return "must be at least $1";
  if (amount > BID_TAPE_PRICE_CAP) return `is over ${money(BID_TAPE_PRICE_CAP)}. Check the figure`;
  return null;
}

// What the whole set of prices must be: every loan priced, and a total a bid can be.
function pricesProblem(prices: LoanPrices, loans: Pick<BidTapeLoan, "ref">[]) {
  const blank = loans.filter((loan) => prices[loan.ref] == null).length;
  if (blank) return partPoolRefusal(blank, loans.length);
  const total = sumPrices(prices);
  if (total > BID_TAPE_PRICE_CAP) return `The prices add up to ${money(total)}, over the ${money(BID_TAPE_PRICE_CAP)} a bid can be.`;
  return null;
}

export type TapeRead = { error: null; prices: LoanPrices } | { error: string; problems: string[] };

const refused = (error: string, problems: string[] = []): TapeRead => ({ error, problems });

// The prices on a tape, matched to the pool's loans by Loan ref. Other columns are the buyer's own and are ignored.
// A row with no ref is a note or a total of theirs, so it is skipped; the loan it might have priced shows as blank.
export function readBidTape(matrix: string[][], loans: Pick<BidTapeLoan, "ref">[]): TapeRead {
  const at = headerAt(matrix);
  if (at < 0) return refused(NO_REF);
  const header = matrix[at].map(normalizeHeader);
  const refColumn = header.indexOf("loanref");
  const priceColumn = header.indexOf("bidprice");
  if (priceColumn < 0) return refused(NO_PRICE);
  const known = new Set(loans.map((loan) => loan.ref));
  const seen = new Map<string, number>();
  const prices: LoanPrices = {};
  const problems: string[] = [];
  for (let index = at + 1; index < matrix.length; index += 1) {
    const row = matrix[index];
    const line = index + 1;
    const ref = String(row[refColumn] ?? "").trim();
    const raw = String(row[priceColumn] ?? "").trim();
    if (!ref || normalizeHeader(ref) === "loanref") continue;
    const earlier = seen.get(ref);
    if (earlier) {
      problems.push(`Row ${line}: loan ref ${ref} is also on row ${earlier}. Each loan goes on one row.`);
      continue;
    }
    seen.set(ref, line);
    if (!known.has(ref)) {
      problems.push(`Row ${line}: ${ref} isn't a loan ref in this pool.`);
      continue;
    }
    if (!raw) continue;
    const amount = parseMoney(raw);
    const problem = priceProblem(amount);
    if (problem || amount == null) {
      problems.push(`Row ${line}: the bid price ${problem === "doesn't read as dollars" ? `"${raw.slice(0, 40)}" ` : ""}${problem}.`);
      continue;
    }
    prices[ref] = round2(amount);
  }
  if (problems.length) {
    const more = problems.length - PROBLEMS_SHOWN;
    return refused(
      problems.length === 1 ? "The tape has a problem. Fix it and upload the tape again." : `The tape has ${problems.length} problems. Fix them and upload the tape again.`,
      more > 0 ? [...problems.slice(0, PROBLEMS_SHOWN), `And ${more} more.`] : problems,
    );
  }
  if (!Object.keys(prices).length) return refused("The tape has no bid prices. Enter a price for each loan in the Bid price column.");
  const problem = pricesProblem(prices, loans);
  return problem ? refused(problem) : { error: null, prices };
}

// The prices the preview read, as the confirm step sends them back, held to the same rules against the loans as they
// stand now. The bid's own checks follow when it is placed.
export function pricesFromPreview(raw: string, loans: Pick<BidTapeLoan, "ref">[]): { error: string } | { error: null; prices: LoanPrices } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: READ_AGAIN };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: READ_AGAIN };
  const known = new Set(loans.map((loan) => loan.ref));
  const prices: LoanPrices = {};
  for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(ref) || typeof value !== "number") return { error: READ_AGAIN };
    const problem = priceProblem(value);
    if (problem) return { error: `A bid price ${problem}. ${READ_AGAIN}` };
    prices[ref] = round2(value);
  }
  const problem = pricesProblem(prices, loans);
  return problem ? { error: problem } : { error: null, prices };
}

// What the buyer checks before confirming: the loans priced, the total and its share of UPB, and each loan priced
// above its own UPB, which is allowed and flagged. UPB is left out off Pro, as in the loan tape.
export type BidTapePreview = {
  fileName: string;
  count: number;
  total: number;
  upb: number | null;
  pctOfUpb: number | null;
  over: number;
  rows: { ref: string; label: string; price: number; upb: number | null; over: boolean }[];
  // The prices as the confirm step sends them back, { loan ref: dollars }.
  prices: string;
};

export function tapePreview(prices: LoanPrices, loans: BidTapeLoan[], fileName: string): BidTapePreview {
  const rows = loans
    .filter((loan) => prices[loan.ref] != null)
    .map((loan) => ({ ref: loan.ref, label: loan.label, price: prices[loan.ref], upb: loan.upb, over: loan.upb != null && prices[loan.ref] > loan.upb }));
  const total = round2(sumPrices(prices));
  const upb = rows.length && rows.every((row) => row.upb != null) ? rows.reduce((sum, row) => sum + (row.upb ?? 0), 0) : null;
  return {
    fileName,
    count: rows.length,
    total,
    upb,
    pctOfUpb: upb ? round2((total / upb) * 100) : null,
    over: rows.filter((row) => row.over).length,
    rows,
    prices: JSON.stringify(prices),
  };
}

export type UploadRead = { error: null; preview: BidTapePreview } | { error: string; problems: string[] };

// An uploaded tape, read against the pool as it stands for this buyer.
export async function readUploadedTape(user: Viewer, listingId: string, file: { bytes: Buffer; filename: string }): Promise<UploadRead> {
  const view = await bidTapeView(user, listingId);
  if (view.error !== null) return { error: view.error, problems: [] };
  let matrix: string[][];
  try {
    matrix = bidTapeMatrix(file.bytes, file.filename);
  } catch {
    return { error: "That file could not be read. Save it as CSV or Excel and try again.", problems: [] };
  }
  const read = readBidTape(matrix, view.loans);
  if (read.error !== null) return read;
  return { error: null, preview: tapePreview(read.prices, view.loans, attachmentName(file.filename)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Placing it.

// The confirmed tape becomes a whole-pool bid with its loan prices, placed by placeInquiry, which runs checkOffer and
// writeInquiry as the typed bid form does: every gate, the covenants tick, the funds and the seat's limit included.
// The confirm step's own fields (good until, a note, the entity, part of the pool, the covenants) go with it as typed.
export async function placeBidTape(user: ActingUser, formData: FormData, options: { now?: Date } = {}): Promise<InquiryOutcome> {
  const listingId = String(formData.get("listingId") || "");
  const back = `/marketplace/${listingId}`;
  const refuse = (error: string) => ({ error, redirect: `${back}?error=${encodeURIComponent(error)}#offer` });
  const listing = await loadListing(listingId, user.id);
  // Closed or hidden says so before anything about the loans does, as the bid form would.
  const blocked = await inquiryBlock(user, listing);
  if (blocked || !listing) return refuse(blocked ?? CLOSED);
  if (listing.kind !== "POOL") return refuse(NOT_POOL);
  const read = pricesFromPreview(String(formData.get("tapePrices") || ""), listing.notes.map((note) => ({ ref: note.id })));
  if (read.error !== null) return refuse(read.error);
  const total = round2(sumPrices(read.prices));
  const bid = new FormData();
  bid.set("listingId", listingId);
  bid.set("type", "OFFER");
  bid.set("amount", String(total));
  for (const [ref, price] of Object.entries(read.prices)) bid.set(`loanPrice_${ref}`, String(price));
  for (const name of ["allowPartial", "goodUntil", "message", "buyerEntityId", "covenantsAck"]) {
    const value = formData.get(name);
    if (typeof value === "string") bid.set(name, value);
  }
  const result = await placeInquiry(user, bid, { now: options.now });
  if (result.error === null && result.inquiryId) {
    const count = Object.keys(read.prices).length;
    const name = String(formData.get("tapeName") || "").trim();
    await audit(user.id, BID_TAPE_ACTION, "inquiry", result.inquiryId, `Bid by tape, ${count} loan${count === 1 ? "" : "s"}${name ? ` · ${attachmentName(name)}` : ""}`);
  }
  return result;
}

// "Bid by tape, 12 loans" for each of these bids placed from a tape, for the seller's bid summary.
export async function tapeBidNotes(inquiryIds: string[]) {
  if (!inquiryIds.length) return new Map<string, string>();
  const rows = await prisma.auditEvent.findMany({ where: { action: BID_TAPE_ACTION, entityType: "inquiry", entityId: { in: inquiryIds } }, select: { entityId: true, detail: true } });
  return new Map(rows.map((row) => [row.entityId, row.detail.split(" · ")[0]]));
}
