import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { closingLoans } from "@/lib/closing";
import { notify } from "@/lib/email";
import { money } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import type { Outcome } from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";
import { loanLabel, matchReport, readServicerReport, servicerSource, type MatchLoan, type ReportRow } from "@/lib/servicer-import";
import { deskCan, DESK_DENIED, type Staff } from "@/lib/staff";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { parseMoney, parsePaymentStatus, parseTapeBuffer, type TapeMatrix } from "@/lib/tape";
import { suggestMapping } from "@/lib/tape-fields";

// The tie-out: the tape the price was bid on, checked against the servicer's tape as of closing. Loans match by
// loan number, then by street and ZIP, as the servicer import does. Each loan's balance, next due date, status and
// rate are compared, and a loan paid off or missing from the closing tape is called out. The result is kept on the
// closing for both sides to read, and the per-loan balance change is what proration (lib/proration.ts) adjusts by.

export const TIE_OUT_FIELDS = [
  { field: "upb", label: "UPB" },
  { field: "nextDueDate", label: "Next due date" },
  { field: "paymentStatus", label: "Status" },
  { field: "interestRate", label: "Rate" },
] as const;

export type TieOutField = (typeof TIE_OUT_FIELDS)[number]["field"];
export type TieOutDifference = { noteId: string; field: TieOutField; bid: string | null; closing: string | null };
export type TieOutStatus = "AGREES" | "CHANGED" | "PAID_OFF" | "MISSING";
export type TieOutLoan = {
  noteId: string;
  label: string;
  status: TieOutStatus;
  by: "loanNumber" | "street" | null;
  row: number | null;
  bidUpb: number;
  closingUpb: number | null;
  differences: TieOutDifference[];
};
export type TieOutExtra = { row: number; label: string; reason: string };
export type TieOutTotals = { loans: number; agree: number; changed: number; paidOff: number; missing: number; extra: number; bidUpb: number; closingUpb: number; upbChange: number };
export type TieOut = {
  version: 1;
  source: string;
  filename: string;
  fileId: string | null;
  at: string;
  by: string;
  loans: TieOutLoan[];
  differences: TieOutDifference[];
  extra: TieOutExtra[];
  totals: TieOutTotals;
};

export const TIE_OUT_SELLER = "SELLER_TAPE";

// Who produced the closing tape: a servicer or the holder's software, as in the servicer import, or the seller's own.
export function tieOutSource(value: string, typedName = "") {
  if (value === TIE_OUT_SELLER) return "Seller's tape";
  const source = servicerSource(value, typedName);
  return source ? (source.kind === "servicer" ? `Servicer report (${source.name})` : `Holder's servicing software (${source.name})`) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the closing tape

export type TieOutRow = ReportRow & { upbAtClose: number | null; status: string | null; paidOff: boolean };

const PAID_OFF = /\b(paid\s*(in\s*full|off)|pif|payoff|paid-off|liquidated|satisfied|released)\b/i;

// The servicer import's reader, plus the two things it leaves out: a zero balance and the status column.
export function readClosingTape(matrix: TapeMatrix): TieOutRow[] {
  const report = readServicerReport(matrix);
  const mapping = suggestMapping(matrix.headers);
  const cell = (row: Record<string, string> | undefined, header: string | undefined) => (row && header ? (row[header] ?? "").trim() : "");
  return report.rows.map((row) => {
    const source = matrix.rows[row.row - 2];
    const upb = parseMoney(cell(source, mapping.upb));
    const rawStatus = cell(source, mapping.paymentStatus);
    const paidOff = PAID_OFF.test(rawStatus) || upb === 0;
    return { ...row, upbAtClose: upb != null && upb >= 0 ? upb : null, status: paidOff ? null : parsePaymentStatus(rawStatus), paidOff };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing

export type TieOutNote = MatchLoan & {
  city: string;
  state: string;
  upb: number;
  interestRate: number;
  paymentStatus: string;
  nextDueDate?: Date | null;
};

const dayOf = (value: unknown) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : null);
const cents = (value: number) => Math.round(value * 100) / 100;

function differencesFor(note: TieOutNote, row: TieOutRow): TieOutDifference[] {
  const out: TieOutDifference[] = [];
  const push = (field: TieOutField, bid: string | null, closing: string | null) => out.push({ noteId: note.id, field, bid, closing });
  if (row.upbAtClose != null && Math.abs(cents(row.upbAtClose) - cents(note.upb)) >= 0.01) push("upb", String(cents(note.upb)), String(cents(row.upbAtClose)));
  const due = dayOf(row.values.nextDueDate);
  if (due && due !== dayOf(note.nextDueDate)) push("nextDueDate", dayOf(note.nextDueDate), due);
  if (row.status && row.status !== note.paymentStatus) push("paymentStatus", note.paymentStatus, row.status);
  const rate = typeof row.values.interestRate === "number" ? row.values.interestRate : null;
  if (rate != null && Math.abs(rate - note.interestRate) >= 0.001) push("interestRate", String(note.interestRate), String(rate));
  return out;
}

export function compareTieOut(notes: TieOutNote[], rows: TieOutRow[]) {
  const { matches, misses } = matchReport(notes, rows);
  const matched = new Map(matches.map((match) => [match.noteId, match]));
  const loans: TieOutLoan[] = notes.map((note) => {
    const base = { noteId: note.id, label: loanLabel(note), bidUpb: cents(note.upb) };
    const match = matched.get(note.id);
    if (!match) return { ...base, status: "MISSING", by: null, row: null, closingUpb: null, differences: [] };
    const row = match.row as TieOutRow;
    if (row.paidOff) {
      return { ...base, status: "PAID_OFF", by: match.by, row: row.row, closingUpb: 0, differences: [{ noteId: note.id, field: "upb", bid: String(base.bidUpb), closing: "0" }] };
    }
    const differences = differencesFor(note, row);
    // A tape with no balance for the loan says nothing about principal paid down, so the change stays unknown.
    const closingUpb = row.upbAtClose != null ? cents(row.upbAtClose) : null;
    return { ...base, status: differences.length ? "CHANGED" : "AGREES", by: match.by, row: row.row, closingUpb, differences };
  });
  // A row for a loan outside this closing, or one the tape names twice, is listed so the desk can see it.
  const extra: TieOutExtra[] = misses.map((miss) => ({
    row: miss.row.row,
    label: [miss.row.loanNumber && `Loan ${miss.row.loanNumber}`, [miss.row.street, miss.row.zip].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "No loan number or street",
    reason: miss.reason.replace("No loan on this listing", "No loan in this closing").replace("on this listing", "in this closing"),
  }));
  const known = loans.filter((loan) => loan.closingUpb != null);
  const bidUpb = cents(loans.reduce((sum, loan) => sum + loan.bidUpb, 0));
  const closingUpb = cents(known.reduce((sum, loan) => sum + (loan.closingUpb ?? 0), 0));
  const totals: TieOutTotals = {
    loans: loans.length,
    agree: loans.filter((loan) => loan.status === "AGREES").length,
    changed: loans.filter((loan) => loan.status === "CHANGED").length,
    paidOff: loans.filter((loan) => loan.status === "PAID_OFF").length,
    missing: loans.filter((loan) => loan.status === "MISSING").length,
    extra: extra.length,
    bidUpb,
    closingUpb,
    // Over the loans the closing tape speaks to, so a missing loan doesn't read as paid down.
    upbChange: cents(closingUpb - known.reduce((sum, loan) => sum + loan.bidUpb, 0)),
  };
  return { loans, extra, differences: loans.flatMap((loan) => loan.differences), totals };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading what was stored

const TIE_OUT_STATUSES = new Set<TieOutStatus>(["AGREES", "CHANGED", "PAID_OFF", "MISSING"]);

// Reads Closing.tieOut defensively. Anything malformed reads as no tie-out.
export function readTieOut(json: unknown): TieOut | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const raw = json as Partial<TieOut>;
  if (raw.version !== 1 || !Array.isArray(raw.loans) || !raw.totals || typeof raw.totals !== "object") return null;
  const loans = raw.loans.filter(
    (loan): loan is TieOutLoan => Boolean(loan) && typeof loan.noteId === "string" && TIE_OUT_STATUSES.has(loan.status) && typeof loan.bidUpb === "number" && Array.isArray(loan.differences),
  );
  return {
    version: 1,
    source: typeof raw.source === "string" ? raw.source : "",
    filename: typeof raw.filename === "string" ? raw.filename : "",
    fileId: typeof raw.fileId === "string" ? raw.fileId : null,
    at: typeof raw.at === "string" ? raw.at : "",
    by: typeof raw.by === "string" ? raw.by : "",
    loans,
    differences: loans.flatMap((loan) => loan.differences),
    extra: Array.isArray(raw.extra) ? raw.extra.filter((row): row is TieOutExtra => Boolean(row) && typeof row.row === "number" && typeof row.reason === "string") : [],
    totals: raw.totals as TieOutTotals,
  };
}

// For proration: each loan's UPB change in dollars, closing tape less bid tape. Negative is principal paid down, and
// a loan paid off changes by its whole bid balance. A loan missing from the closing tape has no known balance at
// closing and is left out, so the caller decides what a dropped loan does to the price.
export function tieOutUpbChange(tieOut: unknown): { noteId: string; bidUpb: number; closingUpb: number; change: number }[] {
  const read = readTieOut(tieOut);
  if (!read) return [];
  return read.loans
    .filter((loan) => loan.status !== "MISSING" && typeof loan.closingUpb === "number")
    .map((loan) => ({ noteId: loan.noteId, bidUpb: loan.bidUpb, closingUpb: loan.closingUpb as number, change: cents((loan.closingUpb as number) - loan.bidUpb) }));
}

export function tieOutFieldLabel(field: string) {
  return TIE_OUT_FIELDS.find((row) => row.field === field)?.label ?? field;
}

// A stored value as it reads in the table.
export function tieOutValue(field: string, value: string | null) {
  if (value == null || value === "") return "—";
  if (field === "upb") return money(Number(value), 2);
  if (field === "interestRate") return `${Number(value)}%`;
  if (field === "paymentStatus") return labelOf("payment", value);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Running it on a closing

export const MAX_TIE_OUT_BYTES = 10 * 1024 * 1024;
export const TIE_OUT_NO_MATCH = "No row matched a loan in this closing by loan number, or by street and ZIP. Check that the file is the tape for these loans.";

const fail = (error: string): Outcome<never> => ({ ok: false, error });

export async function runTieOut(
  actor: Staff & { id: string },
  input: { closingId: string; source: string; sourceName?: string; filename: string; bytes: Buffer; now?: Date },
): Promise<Outcome<TieOut>> {
  if (actor.role !== "ADMIN" || !deskCan(actor, "closings")) return fail(DESK_DENIED);
  const closing = await prisma.closing.findUnique({
    where: { id: input.closingId },
    include: { listing: { include: { seller: true, notes: true } }, steps: true, funders: { include: { user: { select: { email: true } } } } },
  });
  if (!closing) return fail("That closing isn't on file.");
  if (closing.status !== "OPEN") return fail("This closing is already finished.");
  const source = tieOutSource(input.source, input.sourceName ?? "");
  if (!source) return fail("Choose who produced the tape, and name it if it isn't listed.");
  let matrix: TapeMatrix;
  try {
    matrix = parseTapeBuffer(input.bytes, input.filename);
  } catch {
    return fail("That file could not be read.");
  }
  if (!matrix.headers.length) return fail("The tape has no header row.");
  const notes = closingLoans(closing, closing.listing.notes);
  const compared = compareTieOut(notes, readClosingTape(matrix));
  if (compared.totals.missing === compared.totals.loans) return fail(TIE_OUT_NO_MATCH);
  const now = input.now ?? new Date();

  // The file goes with the payment step, where both sides read the closing's money papers.
  const step = closing.steps.find((row) => row.key === "PAYMENT_RECEIVED") ?? closing.steps[0];
  let fileId: string | null = null;
  if (step) {
    const name = `tie-out-${input.filename}`.slice(0, 180);
    const storageKey = `closings/${closing.id}/${crypto.randomUUID()}-${safeBasename(name)}`;
    const mime = mimeFor(extensionOf(input.filename) ?? "", "text/csv");
    await putBytes(storageKey, input.bytes, mime);
    const file = await prisma.closingFile.create({ data: { stepId: step.id, originalName: name, storageKey, mime, size: input.bytes.length, uploadedById: actor.id } });
    fileId = file.id;
  }
  const tieOut: TieOut = { version: 1, source, filename: input.filename.slice(0, 180), fileId, at: now.toISOString(), by: actor.id, ...compared };
  const moved = await prisma.closing.updateMany({
    where: { id: closing.id, status: "OPEN" },
    data: { tieOut: tieOut as unknown as Prisma.InputJsonValue, tieOutAt: now, tieOutById: actor.id },
  });
  if (moved.count !== 1) return fail("This closing is already finished.");
  const totals = compared.totals;
  // Counts only: a loan number or a balance doesn't belong in the audit trail.
  await audit(
    actor.id,
    "TIE_OUT",
    "closing",
    closing.id,
    `${source} · ${totals.loans} loans · ${totals.agree} agree · ${totals.changed} changed · ${totals.paidOff} paid off · ${totals.missing} missing · ${totals.extra} other rows`,
  );

  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyer: { select: { email: true } } } }) : null;
  const parties = [...new Set([closing.listing.seller.email, inquiry?.buyer.email, ...closing.funders.map((funder) => funder.user.email)].filter((email): email is string => Boolean(email)))];
  const app = process.env.NEXT_PUBLIC_APP_URL || "";
  const lines = [
    `${totals.loans === 1 ? "1 loan" : `${totals.loans} loans`} checked: ${totals.agree} agree, ${totals.changed} changed, ${totals.paidOff} paid off, ${totals.missing} not on the closing tape.`,
    totals.paidOff || totals.missing ? "A loan paid off or missing at closing comes out of the sale or adjusts the price. The desk will confirm which with both sides." : "",
    `See each difference on the closing page: ${app}/closings/${closing.id}`,
  ].filter(Boolean);
  for (const email of parties) await notify(email, `Tape tie-out · ${closing.listing.title}`, `The desk checked the bid tape against the tape as of closing.\n\n${lines.join("\n\n")}`);
  return { ok: true, value: tieOut };
}
