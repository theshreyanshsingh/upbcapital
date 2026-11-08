import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { answerable, raiseDiscrepancy } from "@/lib/discrepancies";
import { duplicateKeys } from "@/lib/duplicates";
import { canonical, deskHolds, exactValue, fieldSpec, sameReading, verifiedMap, type FieldOrigin, type Outcome, type VerifiedEntry } from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { readTapeDraft } from "@/lib/tape-draft";
import { parseDate, parseMoney, parseRate, parseTapeBuffer, readServicing, tapePayWidth, type TapeMatrix } from "@/lib/tape";
import { suggestMapping, TAPE_FIELDS, type TapeFieldKey } from "@/lib/tape-fields";

// The inbound servicer import. The seller or the desk uploads a servicer's export against a listing already on
// file. Rows match the listing's loans by loan number, then by street and ZIP. Blank tape fields are filled, fields
// that agree are badged with the report, and a field that disagrees opens a question the seller answers. The tape
// itself is never overwritten here.

// A third-party servicer keeps the record for the holder. Terra Notes and NoteSmith are software the holder runs
// itself (Terra's terms make the user the servicer of record), so their exports read as the holder's own word.
export const SERVICER_SOURCES = [
  { value: "FCI", name: "FCI", label: "FCI", kind: "servicer" },
  { value: "BSI", name: "BSI", label: "BSI", kind: "servicer" },
  { value: "MADISON", name: "Madison", label: "Madison", kind: "servicer" },
  { value: "ALLIED", name: "Allied", label: "Allied", kind: "servicer" },
  { value: "OTHER", name: "", label: "Another servicer, named below", kind: "servicer" },
  { value: "TERRA", name: "Terra Notes", label: "Terra Notes", kind: "holder" },
  { value: "NOTESMITH", name: "NoteSmith", label: "NoteSmith", kind: "holder" },
  { value: "HOLDER_OTHER", name: "", label: "Other software the holder runs, named below", kind: "holder" },
] as const satisfies readonly { value: string; name: string; label: string; kind: FieldOrigin }[];

export type ServicerSource = { value: string; name: string; kind: FieldOrigin };

// Short enough that "Holder's servicing software (name)" fits the 60 characters a difference's source keeps.
const NAME_MAX = 28;

const squeeze = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

export function servicerSource(value: string, typedName = ""): ServicerSource | null {
  const option = SERVICER_SOURCES.find((row) => row.value === value);
  if (!option) return null;
  const name = option.name || squeeze(typedName.replace(/[~()]/g, " "), NAME_MAX);
  if (name.length < 2) return null;
  return { value: option.value, name, kind: option.kind };
}

// The source a difference is filed under. It reads inline in the buyer's log: "differs from the servicer report (FCI)".
export function discrepancySource(source: ServicerSource) {
  return source.kind === "servicer" ? `Servicer report (${source.name})` : `Holder's servicing software (${source.name})`;
}

// The seller of record imports for their own listing, and the desk for any.
export function canImport(user: { id: string; role: string }, listing: { sellerId: string }) {
  return user.role === "ADMIN" || (Boolean(user.id) && listing.sellerId === user.id);
}

export const MAX_REPORT_BYTES = 10 * 1024 * 1024;

export const NO_MATCH = "No row matched a loan on this listing by loan number, or by street and ZIP. Check that the file is the servicer's export for these loans.";

// What a servicer's report can speak to. The balance terms come first, then the servicing record and tape v2.1.
export const REPORT_FIELDS = [
  "loanNumber",
  "upb",
  "interestRate",
  "monthlyPi",
  "lastPaidDate",
  "nextDueDate",
  "payString",
  "originationDate",
  "maturityDate",
  "servicerName",
  "modified",
  "modificationDate",
  "lossMitigation",
  "lossMitStage",
  "bankruptcyChapter",
  "bankruptcyFiledAt",
  "foreclosureFiledAt",
  "loanPurpose",
  "armIndex",
  "armMargin",
  "armNextReset",
  "creditScore",
  "creditScoreType",
  "creditScoreDate",
  "mersMin",
  "eNoteId",
  "originatingPlatform",
  // Tape v3: what a servicer's export carries. The senior lien and the litigation note come from title and counsel.
  "originalBalance",
  "escrowBalance",
  "arrearsAmount",
  "payoffAmount",
  "payoffAsOf",
  "balloonDate",
  "paymentType",
  "scraFlag",
  "borrowerDeceased",
  "litigationFlag",
] as const satisfies readonly TapeFieldKey[];

export type ReportField = (typeof REPORT_FIELDS)[number];

const BALANCE_FIELDS = new Set<ReportField>(["upb", "interestRate", "monthlyPi", "lastPaidDate", "originationDate", "maturityDate"]);

export type ReportRow = {
  row: number;
  loanNumber: string;
  street: string;
  zip: string;
  // Typed for the note's own columns: numbers, dates, booleans and text.
  values: Partial<Record<ReportField, unknown>>;
  notes: { field: string; message: string }[];
};

export type ServicerReport = {
  rows: ReportRow[];
  columns: { field: ReportField; label: string; header: string }[];
  unused: string[];
};

// Reads the export with the tape's own header aliases and parsers, so a servicer's "Loan #" or "Next Due" reads
// here as it would on a tape.
export function readServicerReport(matrix: TapeMatrix): ServicerReport {
  const mapping = suggestMapping(matrix.headers);
  const payWidth = tapePayWidth(matrix.rows, mapping);
  const cell = (row: Record<string, string>, key: TapeFieldKey) => {
    const header = mapping[key];
    return header ? (row[header] ?? "").trim() : "";
  };
  const rows: ReportRow[] = [];
  matrix.rows.forEach((row, index) => {
    if (!Object.values(row).some((value) => String(value).trim())) return;
    const { record, notes } = readServicing(row, mapping, payWidth);
    const values: Partial<Record<ReportField, unknown>> = {};
    for (const field of REPORT_FIELDS) {
      if (BALANCE_FIELDS.has(field)) continue;
      const value = (record as Record<string, unknown>)[field];
      if (value != null) values[field] = value;
    }
    const upb = parseMoney(cell(row, "upb"));
    if (upb != null && upb > 0) values.upb = upb;
    const rate = parseRate(cell(row, "interestRate"));
    if (rate != null && rate >= 0 && rate <= 40) values.interestRate = Math.round(rate * 10000) / 10000;
    const payment = parseMoney(cell(row, "monthlyPi"));
    if (payment != null && payment >= 0) values.monthlyPi = payment;
    for (const field of ["lastPaidDate", "originationDate", "maturityDate"] as const) {
      const date = parseDate(cell(row, field));
      if (date) values[field] = date;
    }
    rows.push({
      row: index + 2,
      loanNumber: record.loanNumber ?? "",
      street: cell(row, "streetAddress"),
      zip: cell(row, "zip"),
      values,
      notes: notes.filter((note) => note.level === "warn").map((note) => ({ field: note.field, message: note.message })),
    });
  });
  const labels = new Map<string, string>(TAPE_FIELDS.map((field) => [field.key, field.label]));
  const columns = REPORT_FIELDS.filter((field) => mapping[field]).map((field) => ({ field, label: fieldSpec(field)?.label ?? labels.get(field) ?? field, header: mapping[field]! }));
  const used = new Set([...columns.map((column) => column.header), mapping.streetAddress, mapping.zip].filter(Boolean));
  return { rows, columns, unused: matrix.headers.filter((header) => !used.has(header)) };
}

// ---------------------------------------------------------------------------------------------------------
// Matching

export type MatchLoan = { id: string; streetAddress: string; zip?: string | null; loanNumber?: string | null };

// The duplicate check's own spellings: "00012-345" is loan 12345, and "123 Main Street" is "123 MAIN ST".
const loanKeyOf = (loanNumber: string | null | undefined) =>
  duplicateKeys({ streetAddress: "", city: "", state: "", upb: 0, loanNumber: loanNumber ?? "", servicerName: "report" }).loan;
const streetKeyOf = (street: string | null | undefined, zip: string | null | undefined) =>
  duplicateKeys({ streetAddress: street ?? "", city: "", state: "", zip: zip ?? "", upb: 0 }).streetZip;

export function sameLoanNumber(a: string | null | undefined, b: string | null | undefined) {
  const left = loanKeyOf(a);
  return left != null && left === loanKeyOf(b);
}

export type RowMatch = { row: ReportRow; noteId: string; by: "loanNumber" | "street" };
export type RowMiss = { row: ReportRow; reason: string };

export function matchReport(loans: MatchLoan[], rows: ReportRow[]) {
  const index = (key: (loan: MatchLoan) => string | null) => {
    const map = new Map<string, string[]>();
    for (const loan of loans) {
      const value = key(loan);
      if (value) map.set(value, [...(map.get(value) ?? []), loan.id]);
    }
    return map;
  };
  const byNumber = index((loan) => loanKeyOf(loan.loanNumber));
  const byStreet = index((loan) => streetKeyOf(loan.streetAddress, loan.zip));
  const matches: RowMatch[] = [];
  const misses: RowMiss[] = [];
  const taken = new Map<string, number>();
  for (const row of rows) {
    const numberKey = loanKeyOf(row.loanNumber);
    const streetKey = streetKeyOf(row.street, row.zip);
    const numbered = numberKey ? byNumber.get(numberKey) ?? [] : [];
    const addressed = streetKey ? byStreet.get(streetKey) ?? [] : [];
    let found: { noteId: string; by: RowMatch["by"] } | null = null;
    if (numbered.length === 1) found = { noteId: numbered[0], by: "loanNumber" };
    // Street and ZIP is the fallback: for a row without a loan number, or one the tape doesn't carry.
    else if (addressed.length === 1) found = { noteId: addressed[0], by: "street" };
    if (!found) {
      const reason =
        numbered.length > 1 ? "Two loans on this listing carry that loan number."
        : addressed.length > 1 ? "Two loans on this listing share that street and ZIP."
        : numberKey || streetKey ? "No loan on this listing has that loan number, or that street and ZIP."
        : "The row has no loan number, and no street and ZIP to match on.";
      misses.push({ row, reason });
      continue;
    }
    const first = taken.get(found.noteId);
    if (first != null) {
      misses.push({ row, reason: `Row ${first} already matched this loan.` });
      continue;
    }
    taken.set(found.noteId, row.row);
    matches.push({ row, ...found });
  }
  return { matches, misses, missing: loans.filter((loan) => !taken.has(loan.id)).map((loan) => loan.id) };
}

// ---------------------------------------------------------------------------------------------------------
// Preview

export type PreviewLoan = MatchLoan & { city: string; state: string; verifiedFields?: unknown };
export type PriorDifference = { noteId: string; field: string; status: string; tapeValue: string; documentValue: string };

// fill: the tape is blank and takes the report's value. confirm: they agree, and the field is badged with the
// report. differ: a question opens for the seller. held: a question on it is open, or this same difference was
// already answered.
export type LineAction = "fill" | "confirm" | "differ" | "held" | "update";

// Balances that move every month. A report's figure is newer than the tape's, so it replaces it as a servicer-sourced
// value instead of opening a question. The one exception is a payoff quoted for the same good-through date: two
// figures for one date is a real difference.
export const MOVING_FIELDS = new Set<ReportField>(["payoffAmount", "payoffAsOf", "escrowBalance", "arrearsAmount"]);

function sameAsOf(loan: Record<string, unknown>, values: Partial<Record<ReportField, unknown>>) {
  const spec = fieldSpec("payoffAsOf")!;
  const tape = exactValue(spec, loan.payoffAsOf);
  const report = exactValue(spec, values.payoffAsOf);
  return tape != null && report != null && sameReading(spec, tape, report);
}
export type PreviewLine = { field: ReportField; label: string; tape: string | null; report: string; action: LineAction; note?: string };
export type LoanPreview = {
  noteId: string;
  label: string;
  row: number;
  by: "loanNumber" | "street";
  lines: PreviewLine[];
  values: Partial<Record<ReportField, unknown>>;
};

export type ImportPreview = {
  loans: LoanPreview[];
  unmatched: { row: number; reason: string; label: string }[];
  missing: { noteId: string; label: string }[];
  totals: { rows: number; matched: number; fill: number; confirm: number; differ: number; held: number; update: number };
  columns: ServicerReport["columns"];
  unused: string[];
  notes: { row: number; message: string }[];
};

export function loanLabel(loan: { streetAddress: string; city: string; state: string }) {
  return `${loan.streetAddress || "No street"}, ${loan.city}, ${loan.state}`;
}

function rowLabel(row: ReportRow) {
  return [row.loanNumber && `Loan ${row.loanNumber}`, [row.street, row.zip].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "No loan number or street";
}

export function previewImport(loans: PreviewLoan[], report: ServicerReport, source: ServicerSource, prior: PriorDifference[] = []): ImportPreview {
  const { matches, misses, missing } = matchReport(loans, report.rows);
  const byId = new Map(loans.map((loan) => [loan.id, loan]));
  const previews: LoanPreview[] = [];
  const totals = { rows: report.rows.length, matched: matches.length, fill: 0, confirm: 0, differ: 0, held: 0, update: 0 };
  for (const match of matches) {
    const loan = byId.get(match.noteId)!;
    const values = { ...match.row.values };
    // A report with no servicer column still says who services the loan, but only to fill a blank: "FCI" against a
    // tape's "FCI Lender Services" isn't a difference worth a question.
    const named = source.kind === "servicer" && values.servicerName == null;
    if (named) values.servicerName = source.name;
    const lines: PreviewLine[] = [];
    for (const field of REPORT_FIELDS) {
      const spec = fieldSpec(field);
      const report = spec && values[field] != null ? exactValue(spec, values[field]) : null;
      if (!spec || report == null) continue;
      const tape = exactValue(spec, (loan as Record<string, unknown>)[field]);
      const line = { field, label: spec.label, tape, report };
      if (tape == null) {
        lines.push({ ...line, action: "fill" });
        continue;
      }
      if (field === "loanNumber" ? sameLoanNumber(tape, report) || sameReading(spec, tape, report) : sameReading(spec, tape, report)) {
        lines.push({ ...line, action: "confirm" });
        continue;
      }
      if (field === "servicerName" && named) continue;
      if (MOVING_FIELDS.has(field) && !(field === "payoffAmount" && sameAsOf(loan as Record<string, unknown>, values))) {
        lines.push({ ...line, action: "update", note: "A newer figure from the servicer. It replaces the tape's." });
        continue;
      }
      const earlier = prior.filter((row) => row.noteId === loan.id && row.field === field);
      if (earlier.some((row) => row.status === "OPEN")) {
        lines.push({ ...line, action: "held", note: "A question is already open on this field." });
        continue;
      }
      const answered = earlier.find((row) => (row.status === "EXPLAINED" || row.status === "WAIVED") && sameReading(spec, row.tapeValue, tape) && sameReading(spec, row.documentValue, report));
      if (answered) {
        lines.push({ ...line, action: "held", note: answered.status === "EXPLAINED" ? "The seller already explained this difference." : "The desk already waived this difference." });
        continue;
      }
      lines.push({ ...line, action: "differ" });
    }
    for (const line of lines) totals[line.action] += 1;
    previews.push({ noteId: loan.id, label: loanLabel(loan), row: match.row.row, by: match.by, lines, values });
  }
  return {
    loans: previews,
    unmatched: misses.map((miss) => ({ row: miss.row.row, reason: miss.reason, label: rowLabel(miss.row) })),
    missing: missing.map((id) => ({ noteId: id, label: loanLabel(byId.get(id)!) })),
    totals,
    columns: report.columns,
    unused: report.unused,
    notes: report.rows.flatMap((row) => row.notes.map((note) => ({ row: row.row, message: note.message }))),
  };
}

const fail = (error: string): Outcome<never> => ({ ok: false, error });

function readFile(filename: string, bytes: Buffer): Outcome<ServicerReport> {
  try {
    const matrix = parseTapeBuffer(bytes, filename);
    if (!matrix.headers.length) return fail("The report has no header row.");
    return { ok: true, value: readServicerReport(matrix) };
  } catch {
    return fail("That file could not be read.");
  }
}

async function listingRecord(listingId: string) {
  return prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, status: true, notes: true } });
}

// The preview the seller or the desk sees before anything is written.
export async function previewForListing(listingId: string, source: ServicerSource, filename: string, bytes: Buffer): Promise<Outcome<ImportPreview>> {
  const listing = await listingRecord(listingId);
  if (!listing) return fail("That listing isn't on file.");
  const report = readFile(filename, bytes);
  if (!report.ok) return report;
  const prior = await prisma.fieldDiscrepancy.findMany({ where: { listingId } });
  const preview = previewImport(listing.notes, report.value, source, prior);
  return preview.totals.matched ? { ok: true, value: preview } : fail(NO_MATCH);
}

// ---------------------------------------------------------------------------------------------------------
// The staged preview: the file waits as a tape draft, and a cookie names it, so the page can show the preview
// on its next render without a client component.

export const SERVICER_COOKIE = "upb-servicer-report";

export function previewCookieValue(input: { listingId: string; token: string; source: ServicerSource }) {
  return [input.listingId, input.token, input.source.value, encodeURIComponent(input.source.name)].join("~");
}

export function readPreviewCookie(value: string | null | undefined) {
  const [listingId, token, sourceValue, name] = (value ?? "").split("~");
  if (!listingId || !/^[0-9a-f-]{36}$/i.test(token ?? "")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(name ?? "");
  } catch {
    return null;
  }
  const source = servicerSource(sourceValue ?? "", decoded);
  return source ? { listingId, token, source } : null;
}

export type StagedReport = { token: string; filename: string; source: ServicerSource; preview: ImportPreview };

export async function stagedReport(viewerId: string, staged: { listingId: string; token: string; source: ServicerSource }): Promise<StagedReport | null> {
  const draft = viewerId ? await readTapeDraft(viewerId, staged.token) : null;
  if (!draft) return null;
  const preview = await previewForListing(staged.listingId, staged.source, draft.filename, draft.bytes);
  return preview.ok ? { token: staged.token, filename: draft.filename, source: staged.source, preview: preview.value } : null;
}

// ---------------------------------------------------------------------------------------------------------
// Apply

export type ImportResult = {
  matched: number;
  rows: number;
  filled: number;
  confirmed: number;
  raised: number;
  held: number;
  // Moving balances the report replaced with its newer figure.
  updated: number;
  documentId: string;
  // A loan number or MERS MIN arrived, so the duplicate check has something new to compare.
  identified: boolean;
};

async function storeReport(listingId: string, filename: string, bytes: Buffer) {
  const name = `servicer-report-${filename}`;
  const storedName = `${crypto.randomUUID()}-${safeBasename(name)}`;
  const mime = mimeFor(extensionOf(filename) ?? "", "text/csv");
  await putBytes(storedName, bytes, mime);
  return prisma.document.create({ data: { listingId, type: "TAPE", originalName: name.slice(0, 180), storedName, mime, size: bytes.length } });
}

// Writes what the preview showed, recomputed against the tape as it stands now. The desk's own checks stand over
// the report's badges.
export async function applyServicerReport(
  actorId: string,
  input: { listingId: string; source: ServicerSource; filename: string; bytes: Buffer; now?: Date },
): Promise<Outcome<ImportResult>> {
  const listing = await listingRecord(input.listingId);
  if (!listing) return fail("That listing isn't on file.");
  if (!answerable(listing.status)) return fail("This listing is in contract or closed, so a servicer report can't change its tape here. Write to the desk.");
  const report = readFile(input.filename, input.bytes);
  if (!report.ok) return report;
  const prior = await prisma.fieldDiscrepancy.findMany({ where: { listingId: listing.id } });
  const preview = previewImport(listing.notes, report.value, input.source, prior);
  if (!preview.totals.matched) return fail(NO_MATCH);
  const now = input.now ?? new Date();
  const document = await storeReport(listing.id, input.filename, input.bytes);
  const notes = new Map(listing.notes.map((note) => [note.id, note]));
  const result: ImportResult = { matched: preview.totals.matched, rows: preview.totals.rows, filled: 0, confirmed: 0, raised: 0, held: preview.totals.held, updated: 0, documentId: document.id, identified: false };
  for (const loan of preview.loans) {
    const note = notes.get(loan.noteId)!;
    const record = note as unknown as Record<string, unknown>;
    const map = verifiedMap(note.verifiedFields);
    const data: Record<string, unknown> = { servicerSourcedAt: now, servicerSource: input.source.name };
    const stamp = (value: string | null, document?: string | null): VerifiedEntry => ({
      at: now.toISOString(),
      by: actorId,
      source: input.source.name,
      value,
      ...(document != null ? { document } : {}),
      origin: input.source.kind,
    });
    for (const line of loan.lines) {
      const spec = fieldSpec(line.field)!;
      const keep = deskHolds(note, line.field);
      if (line.action === "fill") {
        data[line.field] = loan.values[line.field];
        if (!keep) map[line.field] = stamp(canonical(spec, loan.values[line.field]));
        result.filled += 1;
        if (line.field === "loanNumber" || line.field === "mersMin") result.identified = true;
      } else if (line.action === "update") {
        // The figure changed, so a check made against the old one no longer holds. The report's badge replaces it.
        data[line.field] = loan.values[line.field];
        map[line.field] = stamp(canonical(spec, loan.values[line.field]));
        result.updated += 1;
      } else if (line.action === "confirm") {
        if (!keep) map[line.field] = stamp(canonical(spec, record[line.field]));
        result.confirmed += 1;
      } else if (line.action === "differ" && !keep) {
        // The report's value sits beside the tape's, as a desk reading does, so a fix to it reads as sourced.
        map[line.field] = stamp(canonical(spec, record[line.field]), canonical(spec, line.report));
      }
    }
    data.verifiedFields = map;
    await prisma.note.update({ where: { id: note.id }, data: data as Prisma.NoteUpdateInput });
    for (const line of loan.lines) {
      if (line.action !== "differ") continue;
      const raised = await raiseDiscrepancy(actorId, { noteId: note.id, field: line.field, document: line.report, source: discrepancySource(input.source), via: "servicer" });
      if (raised.ok) result.raised += 1;
    }
  }
  // Counts only: a loan number or a balance doesn't belong in the audit trail.
  await audit(
    actorId,
    "SERVICER_IMPORT",
    "listing",
    listing.id,
    `${input.source.name} (${input.source.kind}) · ${result.matched} of ${result.rows} rows matched · ${result.filled} filled · ${result.confirmed} confirmed · ${result.raised} differences raised · ${result.held} held · ${result.updated} updated · document ${document.id}`,
  );
  return { ok: true, value: result };
}
