import { randomUUID } from "node:crypto";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { audit } from "@/lib/audit";
import { closingLoans } from "@/lib/closing";
import { toCsv } from "@/lib/csv";
import { duplicateKeys } from "@/lib/duplicates";
import { prisma } from "@/lib/prisma";
import { parseMoney, parseRate } from "@/lib/tape";
import { normalizeHeader, suggestMapping } from "@/lib/tape-fields";

// A buyer's whole book from a spreadsheet: the notes a fund already owns, brought in at once instead of one by one on
// the portfolio page. Each row is checked the way a note added by hand is (addOwnedNote), the buyer sees what would
// come in before anything is written, and a whole upload can be taken back while its notes are untouched. The holder's
// own records stay theirs: UPB tracks the notes, the payments the buyer logs, and the year-end statement.

// ---------------------------------------------------------------------------------------------------------------
// The checks a note on the book passes, by hand or from an upload

export const OWNED_NOTE_REQUIRED = "Title, cost, UPB, and a date are required.";
export const OWNED_NOTE_YIELD = "Keep the underwritten yield between 0 and 80.";
export const MAX_YIELD = 80;
export const MIN_TITLE = 3;
const MAX_TITLE = 200;

export type OwnedNoteInput = { title: string; cost: number; upb: number; underwrittenYield: number | null; acquiredAt: Date | null };
export type OwnedNoteProblem = { field: "title" | "cost" | "upb" | "acquiredAt" | "underwrittenYield"; reason: string };

// What is wrong with a note for the book, in short reasons a row can carry. Empty means it is good.
export function ownedNoteProblems(input: OwnedNoteInput): OwnedNoteProblem[] {
  const problems: OwnedNoteProblem[] = [];
  if (input.title.length < MIN_TITLE) problems.push({ field: "title", reason: `no title of ${MIN_TITLE} characters or more` });
  if (!(input.cost > 0)) problems.push({ field: "cost", reason: "no cost above zero" });
  if (!(input.upb > 0)) problems.push({ field: "upb", reason: "no UPB above zero" });
  if (!input.acquiredAt) problems.push({ field: "acquiredAt", reason: "no acquired date" });
  const rate = input.underwrittenYield;
  if (rate != null && (!Number.isFinite(rate) || rate < 0 || rate > MAX_YIELD)) problems.push({ field: "underwrittenYield", reason: `underwritten yield outside 0 to ${MAX_YIELD}` });
  return problems;
}

const DAY = 24 * 60 * 60 * 1000;

// A real calendar day, as UTC midnight: 2024-03-15, 3/15/2024, 3/15/24 (a spreadsheet's short form) or an Excel
// serial. Anything else, or a day that doesn't exist, is null.
export function readAcquired(raw: string, now = new Date()): Date | null {
  const text = raw.trim();
  let parts: [number, number, number] | null = null;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+Z?)?$/);
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (iso) parts = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) {
    let year = Number(us[3]);
    // A two-digit year is this century unless that would put it in the future.
    if (us[3].length === 2) year += year + 2000 > now.getUTCFullYear() ? 1900 : 2000;
    parts = [year, Number(us[1]), Number(us[2])];
  } else if (/^\d{5}(?:\.\d+)?$/.test(text)) {
    // A workbook's date cell reads as its serial day, with any time of day as a fraction.
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(text)) * DAY);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (!parts) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1900) return null;
  return date;
}

// ---------------------------------------------------------------------------------------------------------------
// The template and its columns

export const IMPORT_FIELDS = [
  { key: "title", header: "title", label: "Title" },
  { key: "costBasis", header: "cost", label: "Cost" },
  { key: "upb", header: "upb", label: "UPB" },
  { key: "underwrittenYield", header: "underwritten_yield", label: "Underwritten yield %" },
  { key: "acquiredAt", header: "acquired_date", label: "Acquired" },
  // Optional. They name a row with no title, and loan number with state finds a note already on the book.
  { key: "loanNumber", header: "loan_number", label: "Loan number" },
  { key: "streetAddress", header: "street_address", label: "Street address" },
  { key: "city", header: "city", label: "City" },
  { key: "state", header: "state", label: "State" },
] as const;

export type ImportKey = (typeof IMPORT_FIELDS)[number]["key"];
export type ImportMapping = Partial<Record<ImportKey, string>>;

export const IMPORT_HEADERS = IMPORT_FIELDS.map((field) => field.header);

// The holder's own columns, normalised as lib/tape-fields.ts normalises a tape's: "Purchase Price" and "Date
// Acquired" read without renaming. Balance, loan number, address and state take the tape's own aliases, so a
// servicer's "Current Principal Balance" or "Loan #" maps here as it does on a tape.
const OWN_SYNONYMS: Record<"title" | "costBasis" | "underwrittenYield" | "acquiredAt", string[]> = {
  title: ["title", "holdingtitle", "notetitle", "holding", "holdingname", "notename", "loanname", "assetname", "asset", "description", "nickname", "label"],
  costBasis: [
    "cost", "costbasis", "basis", "purchaseprice", "pricepaid", "purchasecost", "purchaseamount", "acquisitioncost", "acquisitionprice",
    "amountpaid", "cashpaid", "totalcost", "allincost", "investment", "investedamount", "amountinvested", "boughtfor",
  ],
  underwrittenYield: [
    "underwrittenyield", "underwritingyield", "uwyield", "yield", "targetyield", "expectedyield", "yieldpct", "yieldpercent", "underwrittenirr",
    "targetirr", "expectedirr",
  ],
  acquiredAt: [
    "acquireddate", "acquired", "acquiredon", "dateacquired", "acquisitiondate", "purchasedate", "purchased", "datepurchased", "purchasedon",
    "boughton", "datebought", "closingdate", "closedate", "closedon", "settlementdate", "settledate", "tradedate",
  ],
};
const TAPE_KEYS = ["upb", "loanNumber", "streetAddress", "city", "state"] as const;

export function mapImportHeaders(headers: string[]): ImportMapping {
  const used = new Set<string>();
  const mapping: ImportMapping = {};
  for (const key of Object.keys(OWN_SYNONYMS) as (keyof typeof OWN_SYNONYMS)[]) {
    const match = headers.find((header) => !used.has(header) && OWN_SYNONYMS[key].includes(normalizeHeader(header)));
    if (match) {
      mapping[key] = match;
      used.add(match);
    }
  }
  const tape = suggestMapping(headers.filter((header) => !used.has(header)));
  for (const key of TAPE_KEYS) if (tape[key]) mapping[key] = tape[key];
  return mapping;
}

// One fictional row, so the template shows what each column takes. An upload refuses it, so it never lands on a book.
export const SAMPLE_LOAN_NUMBER = "SAMPLE-0001";
const SAMPLE_ROW = ["SAMPLE note, delete this row", "41250.00", "58900.00", "11.5", "2024-03-15", SAMPLE_LOAN_NUMBER, "100 Sample Street", "Columbus", "OH"];

export function importTemplateCsv() {
  return toCsv([Object.fromEntries(IMPORT_HEADERS.map((header, index) => [header, SAMPLE_ROW[index]]))]);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading an upload

export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const IMPORT_COOKIE = "upb-portfolio-import";

export type ImportRow = {
  row: number;
  title: string;
  costBasis: number;
  upb: number;
  underwrittenYield: number | null;
  acquiredAt: Date;
  loanNumber: string;
  state: string;
};
export type RowError = { row: number; label: string; reasons: string[] };
export type RowSkipped = { row: number; label: string; reason: string };

export type ImportPreview = {
  rows: ImportRow[];
  errors: RowError[];
  duplicates: RowSkipped[];
  totals: { count: number; upb: number; costBasis: number };
  columns: { label: string; header: string }[];
  unused: string[];
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();

// A row with no title is named from its address and loan number, the way a servicer's export identifies it.
function nameOf(input: { street: string; city: string; state: string; loanNumber: string }) {
  // A state alone doesn't place a note, so it goes with the loan number instead.
  const place = input.street || input.city ? [input.street, input.city, input.state].filter(Boolean).join(", ") : "";
  if (place && input.loanNumber) return `${place} · loan ${input.loanNumber}`;
  if (place) return place;
  return input.loanNumber ? `Loan ${input.loanNumber}${input.state ? `, ${input.state}` : ""}` : "";
}

// The duplicate keys: the title as a person would read it (case, spacing and punctuation don't count), and the loan
// number with the state, spelled as the tape's duplicate check spells it ("00012-345" is 12345).
export function titleKey(title: string) {
  const key = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return key || null;
}

export function loanStateKey(loanNumber: string | null | undefined, state: string | null | undefined) {
  const loan = duplicateKeys({ streetAddress: "", city: "", state: "", upb: 0, loanNumber: loanNumber ?? "", servicerName: "book" }).loan;
  const where = (state ?? "").trim().toUpperCase();
  return loan && where ? `${loan}|${where}` : null;
}

type Candidate = ImportRow & { keys: string[] };

// The file as rows of text, index 0 being the sheet's row 1, blank rows kept, so a problem names the row the buyer
// sees (as lib/bid-tape.ts reads a bid tape). A workbook is read from its first sheet.
export function bookMatrix(bytes: Buffer, filename: string): string[][] {
  if (/\.(csv|txt)$/i.test(filename)) {
    const parsed = Papa.parse<string[]>(bytes.toString("utf8").replace(/^\uFEFF/, ""), { skipEmptyLines: false });
    return parsed.data.map((row) => row.map((cell) => String(cell ?? "")));
  }
  const book = XLSX.read(bytes, { type: "buffer" });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) return [];
  const start = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s.r : 0;
  const body = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: true });
  return [...Array.from({ length: start }, () => [] as string[]), ...body.map((row) => row.map((cell) => (cell == null ? "" : String(cell))))];
}

const blank = (row: string[]) => !row.some((cell) => String(cell).trim());

// The file's rows, checked. Whole-file problems (no rows, too many, a column nobody can find) refuse the upload.
export function readBook(sheet: string[][], now = new Date()): Outcome<{ rows: Candidate[]; errors: RowError[]; columns: ImportPreview["columns"]; unused: string[] }> {
  // The header is the first row that names the cost, the UPB and the date, so an export's title rows above it are
  // passed over. Failing that, the first row with anything in it. Every row below the header is a note.
  const reads = (row: string[]) => {
    const found = mapImportHeaders(row.map((cell) => squeeze(String(cell))).filter(Boolean));
    return Boolean(found.costBasis && found.upb && found.acquiredAt);
  };
  const named = sheet.slice(0, 20).findIndex((row) => !blank(row) && reads(row));
  const at = named >= 0 ? named : sheet.findIndex((row) => !blank(row));
  const headers = at < 0 ? [] : sheet[at].map((cell, index) => squeeze(String(cell)) || `Column ${index + 1}`);
  const body = at < 0 ? [] : sheet.slice(at + 1).map((cells, index) => ({ at: at + index + 2, cells }));
  const filled = body.filter((row) => !blank(row.cells));
  if (!headers.length || !filled.length) return { ok: false, error: "That file has no rows to import. Use the template, one note to a row." };
  if (filled.length > MAX_IMPORT_ROWS) {
    return { ok: false, error: `That file has ${filled.length.toLocaleString("en-US")} rows. Upload up to ${MAX_IMPORT_ROWS.toLocaleString("en-US")} at a time, and split a bigger book into several files.` };
  }
  const mapping = mapImportHeaders(headers);
  const missing = (["costBasis", "upb", "acquiredAt"] as const).filter((key) => !mapping[key]);
  if (missing.length) {
    const names = { costBasis: "the cost (cost or purchase price)", upb: "the UPB (upb or current balance)", acquiredAt: "the acquired date (acquired_date or purchase date)" };
    return { ok: false, error: `No column for ${missing.map((key) => names[key]).join(", ")}. Use the template's headers.` };
  }
  if (!mapping.title && !mapping.streetAddress && !mapping.loanNumber) {
    return { ok: false, error: "No column names the notes. Add a title column, or the loan number or street address." };
  }
  const column = new Map(Object.entries(mapping).map(([key, header]) => [key, headers.indexOf(header)]));
  const cell = (row: string[], key: ImportKey) => {
    const index = column.get(key);
    return index == null || index < 0 ? "" : squeeze(String(row[index] ?? ""));
  };
  const rows: Candidate[] = [];
  const errors: RowError[] = [];
  for (const { at, cells: row } of filled) {
    const loanNumber = cell(row, "loanNumber").slice(0, 60);
    const state = cell(row, "state").slice(0, 30);
    const title = (cell(row, "title") || nameOf({ street: cell(row, "streetAddress"), city: cell(row, "city"), state, loanNumber })).slice(0, MAX_TITLE);
    const cost = parseMoney(cell(row, "costBasis")) ?? NaN;
    const upb = parseMoney(cell(row, "upb")) ?? NaN;
    const yieldRaw = cell(row, "underwrittenYield");
    const underwrittenYield = yieldRaw ? (parseRate(yieldRaw) ?? NaN) : null;
    const acquiredAt = readAcquired(cell(row, "acquiredAt"), now);
    const label = title || `Row ${at}`;
    if (loanNumber.toUpperCase() === SAMPLE_LOAN_NUMBER) {
      errors.push({ row: at, label, reasons: ["the template's sample row, which isn't a note of yours"] });
      continue;
    }
    const problems = ownedNoteProblems({ title, cost, upb, underwrittenYield, acquiredAt });
    if (problems.length || !acquiredAt) {
      errors.push({ row: at, label, reasons: problems.map((problem) => problem.reason) });
      continue;
    }
    const keys = [titleKey(title), loanStateKey(loanNumber, state)].filter((key): key is string => Boolean(key));
    rows.push({ row: at, title, costBasis: cost, upb, underwrittenYield: underwrittenYield == null ? null : Math.round(underwrittenYield * 100) / 100, acquiredAt, loanNumber, state, keys });
  }
  const columns = IMPORT_FIELDS.filter((field) => mapping[field.key]).map((field) => ({ label: field.label, header: mapping[field.key]! }));
  const used = new Set(Object.values(mapping));
  return { ok: true, value: { rows, errors, columns, unused: headers.filter((header) => !used.has(header)) } };
}

// Splits the good rows into what comes in and what is already there: a note on the book under the same title, or
// the same loan number in the same state, and a row that repeats an earlier one in the file.
export function sortOutDuplicates(rows: Candidate[], book: Map<string, string>) {
  const seen = new Map<string, number>();
  const fresh: ImportRow[] = [];
  const duplicates: RowSkipped[] = [];
  for (const candidate of rows) {
    const { keys, ...row } = candidate;
    const onBook = keys.find((key) => book.has(key));
    const earlier = keys.map((key) => seen.get(key)).find((at) => at != null);
    if (onBook) duplicates.push({ row: row.row, label: row.title, reason: `already in your portfolio as ${book.get(onBook)}` });
    else if (earlier != null) duplicates.push({ row: row.row, label: row.title, reason: `the same note as row ${earlier}` });
    else fresh.push(row);
    for (const key of keys) if (!seen.has(key)) seen.set(key, row.row);
  }
  return { rows: fresh, duplicates };
}

export function previewBook(sheet: string[][], book: Map<string, string>, now = new Date()): Outcome<ImportPreview> {
  const read = readBook(sheet, now);
  if (!read.ok) return read;
  const { rows, duplicates } = sortOutDuplicates(read.value.rows, book);
  const totals = rows.reduce((sum, row) => ({ count: sum.count + 1, upb: sum.upb + row.upb, costBasis: sum.costBasis + row.costBasis }), { count: 0, upb: 0, costBasis: 0 });
  return { ok: true, value: { rows, errors: read.value.errors, duplicates, totals, columns: read.value.columns, unused: read.value.unused } };
}

// The buyer's book as duplicate keys, each naming the holding it belongs to. A note bought on UPB also answers to its
// loans' loan numbers and states.
export async function bookKeys(userId: string) {
  const holdings = await prisma.buyerHolding.findMany({ where: { userId }, select: { id: true, title: true, listingId: true, closingId: true } });
  const keys = new Map<string, string>();
  for (const holding of holdings) {
    const key = titleKey(holding.title);
    if (key && !keys.has(key)) keys.set(key, `"${holding.title}"`);
  }
  const listingIds = [...new Set(holdings.map((holding) => holding.listingId).filter((id): id is string => Boolean(id)))];
  if (!listingIds.length) return keys;
  const closingIds = holdings.map((holding) => holding.closingId).filter((id): id is string => Boolean(id));
  const [notes, closings] = await Promise.all([
    prisma.note.findMany({ where: { listingId: { in: listingIds } }, select: { id: true, listingId: true, loanNumber: true, state: true } }),
    closingIds.length ? prisma.closing.findMany({ where: { id: { in: closingIds } }, select: { id: true, noteId: true, noteIds: true } }) : [],
  ]);
  const closingOf = new Map(closings.map((closing) => [closing.id, closing]));
  for (const holding of holdings) {
    if (!holding.listingId) continue;
    const onListing = notes.filter((note) => note.listingId === holding.listingId);
    const closing = holding.closingId ? closingOf.get(holding.closingId) : null;
    const loans = closing ? closingLoans({ noteId: closing.noteId, noteIds: closing.noteIds ?? [] }, onListing) : onListing;
    for (const loan of loans) {
      const key = loanStateKey(loan.loanNumber, loan.state);
      if (key && !keys.has(key)) keys.set(key, `"${holding.title}"`);
    }
  }
  return keys;
}

export async function previewImport(userId: string, filename: string, bytes: Buffer, now = new Date()): Promise<Outcome<ImportPreview>> {
  let sheet: string[][];
  try {
    sheet = bookMatrix(bytes, filename);
  } catch {
    return { ok: false, error: "That file couldn't be read. Save it as CSV or Excel and upload it again." };
  }
  return previewBook(sheet, await bookKeys(userId), now);
}

// ---------------------------------------------------------------------------------------------------------------
// Importing, and taking it back

export type ImportResult = { batchId: string; imported: number; skipped: number; errors: number };

// The rows that passed, as they stand against the book now, under one batch id. Logged with counts only.
export async function importBook(user: { id: string }, input: { filename: string; bytes: Buffer }, now = new Date()): Promise<Outcome<ImportResult>> {
  const preview = await previewImport(user.id, input.filename, input.bytes, now);
  if (!preview.ok) return preview;
  const { rows, duplicates, errors } = preview.value;
  if (!rows.length) return { ok: false, error: duplicates.length ? "Every good row is already in your portfolio, so nothing was imported." : "No row passed the checks, so nothing was imported. Fix the rows and upload again." };
  const batchId = randomUUID();
  await prisma.buyerHolding.createMany({
    data: rows.map((row) => ({
      userId: user.id,
      importBatchId: batchId,
      title: row.title,
      costBasis: row.costBasis,
      upb: row.upb,
      underwrittenYield: row.underwrittenYield,
      acquiredAt: row.acquiredAt,
    })),
  });
  await audit(user.id, "PORTFOLIO_IMPORT", "portfolioImport", batchId, `${rows.length} imported · ${duplicates.length} duplicates skipped · ${errors.length} with errors`);
  return { ok: true, value: { batchId, imported: rows.length, skipped: duplicates.length, errors: errors.length } };
}

// A holding someone has since worked on stays: a payment logged, a relist, or a slice sold.
async function touchedHoldings(ids: string[]) {
  if (!ids.length) return new Set<string>();
  const [relisted, held] = await Promise.all([
    prisma.auditEvent.findMany({ where: { action: "RELIST", entityType: "holding", entityId: { in: ids } }, select: { entityId: true } }),
    prisma.buyerHolding.findMany({ where: { id: { in: ids } }, select: { id: true, _count: { select: { payments: true, participations: true } } } }),
  ]);
  const touched = new Set(relisted.map((row) => row.entityId));
  for (const holding of held) if (holding._count.payments > 0 || holding._count.participations > 0) touched.add(holding.id);
  return touched;
}

export type UndoResult = { removed: number; kept: number };

export async function undoImport(user: { id: string }, batchId: string): Promise<Outcome<UndoResult>> {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return { ok: false, error: "That import isn't on your book." };
  const holdings = await prisma.buyerHolding.findMany({ where: { userId: user.id, importBatchId: batchId }, select: { id: true } });
  if (!holdings.length) return { ok: false, error: "That import has nothing left to undo." };
  const touched = await touchedHoldings(holdings.map((holding) => holding.id));
  const removable = holdings.filter((holding) => !touched.has(holding.id)).map((holding) => holding.id);
  const removed = removable.length ? (await prisma.buyerHolding.deleteMany({ where: { id: { in: removable }, userId: user.id } })).count : 0;
  const kept = holdings.length - removed;
  await audit(user.id, "PORTFOLIO_IMPORT_UNDO", "portfolioImport", batchId, `${removed} removed · ${kept} kept`);
  return { ok: true, value: { removed, kept } };
}

// How many of the upload's notes are still on the book, and how many of those an undo would take back.
export type ImportBatch = { id: string; at: Date; imported: number; left: number; removable: number };

// The buyer's recent uploads that still have notes on the book, newest first, for the undo cards.
export async function importBatches(userId: string, take = 5): Promise<ImportBatch[]> {
  const events = await prisma.auditEvent.findMany({
    where: { actorId: userId, action: "PORTFOLIO_IMPORT", entityType: "portfolioImport" },
    select: { entityId: true, createdAt: true, detail: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (!events.length) return [];
  const left = await prisma.buyerHolding.findMany({ where: { userId, importBatchId: { in: events.map((event) => event.entityId) } }, select: { id: true, importBatchId: true } });
  const touched = await touchedHoldings(left.map((row) => row.id));
  const counts = new Map<string, { left: number; removable: number }>();
  for (const row of left) {
    if (!row.importBatchId) continue;
    const count = counts.get(row.importBatchId) ?? { left: 0, removable: 0 };
    counts.set(row.importBatchId, { left: count.left + 1, removable: count.removable + (touched.has(row.id) ? 0 : 1) });
  }
  return events
    .filter((event) => counts.has(event.entityId))
    .slice(0, take)
    .map((event) => {
      const count = counts.get(event.entityId)!;
      return { id: event.entityId, at: event.createdAt, imported: Number(event.detail.match(/^(\d+) imported/)?.[1] ?? count.left), ...count };
    });
}
