import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { ACCRETION_NOTE, accretedBetween, accretionSchedule, type Accretion } from "@/lib/accretion";
import { appOrigin } from "@/lib/billing";
import { closingLoans } from "@/lib/closing";
import { toCsv } from "@/lib/csv";
import { sendAlert } from "@/lib/email";
import { money } from "@/lib/format";
import { holdingLoanTerms } from "@/lib/portfolio";
import { prisma } from "@/lib/prisma";

// The buyer's year-end statement: what each holding paid in a tax year, split into interest, principal, fees and
// escrow, beside its cost and any resale. Servicer receipts often arrive as one total, so a missing split is
// estimated from the loan's own amortisation and says so. The statement is a record for the buyer's adviser, never
// a tax form: the servicer issues those.

export const STATEMENT_NOTE = "This statement is not a tax form. Your servicer issues Form 1098 and 1099 forms. Check with your tax adviser.";
export const ESTIMATED = "Estimated split";

const DAY = 24 * 60 * 60 * 1000;
const MONTH_DAYS = 365.25 / 12;

export type Split = { principal: number; interest: number; fees: number; escrow: number };
export type Receipt = {
  id?: string;
  amount: number;
  paidOn: Date;
  memo?: string;
  principal?: number | null;
  interest?: number | null;
  fees?: number | null;
  escrow?: number | null;
};
// A receipt with its split: the one the holder logged, an estimate, or none when the loan's rate isn't known.
export type SplitReceipt = Receipt & { split: Split | null; estimated: boolean };
export type Proceeds = { amount: number; on: Date; listingId: string };

const cents = (value: number) => Math.round(value * 100) / 100;

export function loggedSplit(receipt: Receipt): Split | null {
  const parts = [receipt.principal, receipt.interest, receipt.fees, receipt.escrow];
  if (parts.every((part) => part == null)) return null;
  return { principal: receipt.principal ?? 0, interest: receipt.interest ?? 0, fees: receipt.fees ?? 0, escrow: receipt.escrow ?? 0 };
}

// Oldest first, from the balance at acquisition. Each receipt pays the interest accrued at the note rate since the one
// before, at least a month's, and the rest goes to principal. A payment beyond the payoff counts as fees. A logged split
// is kept as logged and moves the balance by its principal, so later estimates start from the right place.
export function splitReceipts(receipts: Receipt[], loan: { upb: number; annualRate: number | null; acquiredAt: Date }): SplitReceipt[] {
  let balance = Math.max(0, loan.upb);
  let last = loan.acquiredAt;
  const rate = loan.annualRate != null && Number.isFinite(loan.annualRate) && loan.annualRate >= 0 ? loan.annualRate / 100 / 12 : null;
  return [...receipts]
    .sort((a, b) => a.paidOn.getTime() - b.paidOn.getTime())
    .map((receipt) => {
      const logged = loggedSplit(receipt);
      const months = Math.max(1, Math.round((receipt.paidOn.getTime() - last.getTime()) / DAY / MONTH_DAYS));
      last = receipt.paidOn;
      if (logged) {
        balance = Math.max(0, balance - logged.principal);
        return { ...receipt, split: logged, estimated: false };
      }
      if (rate == null || !(receipt.amount > 0)) return { ...receipt, split: null, estimated: false };
      const interest = cents(Math.min(receipt.amount, balance * rate * months));
      const principal = cents(Math.min(balance, receipt.amount - interest));
      const fees = cents(Math.max(0, receipt.amount - interest - principal));
      balance = Math.max(0, balance - principal);
      return { ...receipt, split: { principal, interest, fees, escrow: 0 }, estimated: true };
    });
}

// The holder's optional split on the log form. Blank parts count as nothing once any part is given, and the parts
// must add up to the payment. A blank amount takes the parts' total.
export function readReceiptSplit(raw: { amount: string; principal: string; interest: string; fees: string; escrow: string }) {
  const read = (text: string) => {
    const value = text.replace(/[$,\s]/g, "");
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? cents(parsed) : NaN;
  };
  const parts = { principal: read(raw.principal), interest: read(raw.interest), fees: read(raw.fees), escrow: read(raw.escrow) };
  if (Object.values(parts).some((part) => Number.isNaN(part))) return { error: "Enter the split in dollars, or leave it blank." } as const;
  const given = Object.values(parts).some((part) => part != null);
  const typed = read(raw.amount);
  if (Number.isNaN(typed)) return { error: "Enter the amount in dollars." } as const;
  if (!given) {
    if (!(typed != null && typed > 0)) return { error: "Amount and date are required." } as const;
    return { error: null, amount: typed, split: null } as const;
  }
  const split: Split = { principal: parts.principal ?? 0, interest: parts.interest ?? 0, fees: parts.fees ?? 0, escrow: parts.escrow ?? 0 };
  const total = cents(split.principal + split.interest + split.fees + split.escrow);
  const amount = typed ?? total;
  if (!(amount > 0)) return { error: "Amount and date are required." } as const;
  if (Math.abs(total - amount) > 0.01) {
    return { error: `The split adds up to ${money(total, 2)}, but the payment is ${money(amount, 2)}. Make them match, or leave the split blank.` } as const;
  }
  return { error: null, amount, split } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Loading a buyer's book.

export type StatementHolding = {
  id: string;
  title: string;
  costBasis: number;
  upb: number;
  acquiredAt: Date;
  status: string;
  sharePercent: number | null;
  underwrittenYield: number | null;
  annualRate: number | null;
  receipts: SplitReceipt[];
  proceeds: Proceeds[];
  // Discount accretion from lib/accretion.ts, when the holding was bought below its balance. Kept apart from the split.
  accretion?: Accretion | null;
};

type HoldingRow = {
  id: string;
  title: string;
  costBasis: number;
  upb: number;
  acquiredAt: Date;
  status: string;
  sharePercent: number | null;
  underwrittenYield: number | null;
  closingId: string | null;
  listingId: string | null;
  payments: Receipt[];
};

// The note rate behind each holding, from the loans its closing bought. A pool's is weighted by balance. A note added
// by hand has no loan on file, so its receipts stay unsplit unless the holder splits them.
export async function holdingRates(holdings: Pick<HoldingRow, "id" | "closingId" | "listingId">[]) {
  const listingIds = [...new Set(holdings.map((holding) => holding.listingId).filter((id): id is string => Boolean(id)))];
  const closingIds = [...new Set(holdings.map((holding) => holding.closingId).filter((id): id is string => Boolean(id)))];
  const [notes, closings] = await Promise.all([
    listingIds.length ? prisma.note.findMany({ where: { listingId: { in: listingIds } }, select: { id: true, listingId: true, upb: true, interestRate: true } }) : [],
    closingIds.length ? prisma.closing.findMany({ where: { id: { in: closingIds } }, select: { id: true, noteId: true, noteIds: true } }) : [],
  ]);
  const closingOf = new Map(closings.map((closing) => [closing.id, closing]));
  const rates = new Map<string, number | null>();
  for (const holding of holdings) {
    const onListing = notes.filter((note) => note.listingId === holding.listingId);
    const closing = holding.closingId ? closingOf.get(holding.closingId) : null;
    const loans = closing ? closingLoans({ noteId: closing.noteId, noteIds: closing.noteIds ?? [] }, onListing) : onListing;
    const weight = loans.reduce((sum, note) => sum + Number(note.upb), 0);
    rates.set(holding.id, loans.length && weight > 0 ? loans.reduce((sum, note) => sum + Number(note.interestRate) * Number(note.upb), 0) / weight : null);
  }
  return rates;
}

// What the holder took from reselling each holding: net of the desk's commission, dated at the close. A relist is
// tied to its holding by the RELIST entry the relist action writes.
export async function resaleProceeds(holdingIds: string[]) {
  const proceeds = new Map<string, Proceeds[]>();
  if (!holdingIds.length) return proceeds;
  const relists = await prisma.auditEvent.findMany({ where: { action: "RELIST", entityType: "holding", entityId: { in: holdingIds } }, select: { entityId: true, detail: true } });
  if (!relists.length) return proceeds;
  const listingIds = [...new Set(relists.map((row) => row.detail))];
  const [closings, listings] = await Promise.all([
    prisma.closing.findMany({ where: { listingId: { in: listingIds }, status: "COMPLETE" }, select: { listingId: true, netToSellerCents: true, closedAt: true, openedAt: true } }),
    prisma.listing.findMany({ where: { id: { in: listingIds }, status: "SOLD" }, select: { id: true, netToSellerCents: true, soldAt: true } }),
  ]);
  for (const row of relists) {
    const closed = closings.filter((closing) => closing.listingId === row.detail);
    const sold = listings.find((listing) => listing.id === row.detail);
    // A sale the desk marked by hand has no closing, so the listing's own figures stand in.
    const rows: Proceeds[] = closed.length
      ? closed.map((closing) => ({ amount: closing.netToSellerCents / 100, on: closing.closedAt ?? closing.openedAt, listingId: row.detail }))
      : sold?.netToSellerCents != null && sold.soldAt
        ? [{ amount: sold.netToSellerCents / 100, on: sold.soldAt, listingId: row.detail }]
        : [];
    if (rows.length) proceeds.set(row.entityId, [...(proceeds.get(row.entityId) ?? []), ...rows]);
  }
  return proceeds;
}

export async function loadStatementHoldings(userId: string): Promise<StatementHolding[]> {
  const holdings: HoldingRow[] = await prisma.buyerHolding.findMany({
    where: { userId },
    include: { payments: { orderBy: { paidOn: "asc" } } },
    orderBy: { acquiredAt: "desc" },
  });
  const [rates, proceeds, terms] = await Promise.all([holdingRates(holdings), resaleProceeds(holdings.map((holding) => holding.id)), holdingLoanTerms(holdings)]);
  return holdings.map((holding) => {
    const annualRate = rates.get(holding.id) ?? null;
    const accretion = accretionSchedule({ costBasis: Number(holding.costBasis), upb: Number(holding.upb), acquiredAt: holding.acquiredAt, loans: terms.get(holding.id) ?? [] });
    return {
      id: holding.id,
      title: holding.title,
      costBasis: Number(holding.costBasis),
      upb: Number(holding.upb),
      acquiredAt: holding.acquiredAt,
      status: holding.status,
      sharePercent: holding.sharePercent == null ? null : Number(holding.sharePercent),
      underwrittenYield: holding.underwrittenYield == null ? null : Number(holding.underwrittenYield),
      annualRate,
      receipts: splitReceipts(holding.payments.map((payment) => ({ ...payment, amount: Number(payment.amount) })), { upb: Number(holding.upb), annualRate, acquiredAt: holding.acquiredAt }),
      proceeds: proceeds.get(holding.id) ?? [],
      accretion,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The statement for one tax year.

export type StatementRow = {
  id: string;
  title: string;
  acquiredAt: Date;
  costBasis: number;
  interest: number;
  principal: number;
  fees: number;
  escrow: number;
  // Receipts whose split isn't known, because the loan's rate isn't on file and the holder logged a total.
  unsplit: number;
  received: number;
  saleProceeds: number;
  soldOn: Date | null;
  basis: string;
  // Discount accreted in the year, through a sale, for the holder's tax adviser. Null when bought at or above the
  // balance. Not a receipt, so it stays out of the received total.
  accreted: number | null;
  accretionBasis: string;
};

// The accretion total is there only when some holding accretes, and so are its CSV columns.
export type Statement = {
  year: number;
  rows: StatementRow[];
  totals: Omit<StatementRow, "id" | "title" | "acquiredAt" | "soldOn" | "basis" | "accreted" | "accretionBasis"> & { accreted?: number };
};

const inYear = (date: Date, year: number) => date.getUTCFullYear() === year;

// Every holding held at some point in the year: bought by its end, and not sold before it began.
export function taxYearStatement(holdings: StatementHolding[], year: number): Statement {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const rows = holdings
    .filter((holding) => holding.acquiredAt.getTime() < end && !holding.proceeds.some((sale) => sale.on.getTime() < start))
    .map((holding) => {
      const receipts = holding.receipts.filter((receipt) => inYear(receipt.paidOn, year));
      const sales = holding.proceeds.filter((sale) => inYear(sale.on, year));
      const sum = (pick: (split: Split) => number) => cents(receipts.reduce((total, receipt) => total + (receipt.split ? pick(receipt.split) : 0), 0));
      const estimated = receipts.filter((receipt) => receipt.estimated).length;
      const unknown = receipts.filter((receipt) => !receipt.split).length;
      const logged = receipts.length - estimated - unknown;
      const basis = !receipts.length
        ? "No receipts"
        : unknown === receipts.length
          ? "Not split"
          : estimated === receipts.length
            ? ESTIMATED
            : logged === receipts.length
              ? "As logged"
              : `Part ${ESTIMATED.toLowerCase()}`;
      // Accretion stops at the first sale. Months ending before it count.
      const sold = holding.proceeds.reduce((first, sale) => Math.min(first, sale.on.getTime()), end);
      const accreted = holding.accretion ? accretedBetween(holding.accretion, new Date(start), new Date(Math.min(end, sold))) : null;
      return {
        id: holding.id,
        title: holding.title,
        acquiredAt: holding.acquiredAt,
        costBasis: holding.costBasis,
        interest: sum((split) => split.interest),
        principal: sum((split) => split.principal),
        fees: sum((split) => split.fees),
        escrow: sum((split) => split.escrow),
        unsplit: cents(receipts.filter((receipt) => !receipt.split).reduce((total, receipt) => total + receipt.amount, 0)),
        received: cents(receipts.reduce((total, receipt) => total + receipt.amount, 0)),
        saleProceeds: cents(sales.reduce((total, sale) => total + sale.amount, 0)),
        soldOn: sales.length ? sales[sales.length - 1].on : null,
        basis,
        accreted,
        accretionBasis: holding.accretion?.basis ?? "",
      };
    });
  const total = (pick: (row: StatementRow) => number) => cents(rows.reduce((sum, row) => sum + pick(row), 0));
  const accretes = rows.some((row) => row.accreted != null);
  return {
    year,
    rows,
    totals: {
      costBasis: total((row) => row.costBasis),
      interest: total((row) => row.interest),
      principal: total((row) => row.principal),
      fees: total((row) => row.fees),
      escrow: total((row) => row.escrow),
      unsplit: total((row) => row.unsplit),
      received: total((row) => row.received),
      saleProceeds: total((row) => row.saleProceeds),
      ...(accretes ? { accreted: total((row) => row.accreted ?? 0) } : {}),
    },
  };
}

// The tax years a book has something in, newest first, for the page's picker.
export function statementYears(holdings: { acquiredAt: Date }[], now = new Date()) {
  const current = now.getUTCFullYear();
  const first = holdings.reduce((year, holding) => Math.min(year, holding.acquiredAt.getUTCFullYear()), current);
  return Array.from({ length: Math.min(current - first, 30) + 1 }, (_, index) => current - index);
}

// The year a statement defaults to: last year from January to April, when returns are prepared, else this year.
export function statementSeason(now = new Date()) {
  const season = now.getUTCMonth() <= 3;
  return { season, year: season ? now.getUTCFullYear() - 1 : now.getUTCFullYear() };
}

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : "");

const CSV_HEADERS = ["Holding", "Acquired", "Cost basis", "Interest", "Principal", "Fees", "Escrow", "Not split", "Total received", "Sale proceeds", "Sale date", "Split"];

// One row per holding, a total, and the note last, so the file says what it is wherever it is opened.
export function statementCsv(statement: Statement) {
  // A book with a holding bought below its balance adds the accretion after the split, with its own note.
  const accretes = statement.totals.accreted != null;
  const headers = accretes ? [...CSV_HEADERS, "Discount accreted", "Accretion method"] : CSV_HEADERS;
  const line = (values: (string | number)[]) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  const figures = (row: Omit<Statement["totals"], "accreted">) => [row.costBasis, row.interest, row.principal, row.fees, row.escrow, row.unsplit, row.received, row.saleProceeds];
  return toCsv([
    ...statement.rows.map((row) => line([row.title, day(row.acquiredAt), ...figures(row), day(row.soldOn), row.basis, ...(accretes ? [row.accreted ?? "", row.accretionBasis] : [])])),
    line([`Total ${statement.year}`, "", ...figures(statement.totals), ...(accretes ? ["", "", statement.totals.accreted ?? ""] : [])]),
    ...(accretes ? [line([ACCRETION_NOTE])] : []),
    line([STATEMENT_NOTE]),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// The PDF, in the settlement statement's style, with as many pages as the book needs.

function dollars(value: number) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function buildYearStatementPdf(statement: Statement, holder: string) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const quiet = rgb(0.42, 0.42, 0.46);
  const clean = (text: string) => text.replace(/[^\x20-\x7E]/g, "-");
  const footer = (page: PDFPage) => {
    page.drawText(clean(STATEMENT_NOTE), { x: 48, y: 72, size: 8, font, color: quiet });
    page.drawText("Prepared from the receipts you logged. An estimated split applies the note rate to the balance; check it against your servicer's statement.", { x: 48, y: 60, size: 7, font, color: quiet });
    if (statement.totals.accreted != null) page.drawText(clean(`${ACCRETION_NOTE} It is not a receipt, so it is not in the totals received.`), { x: 48, y: 48, size: 7, font, color: quiet });
  };
  let page = pdf.addPage([612, 792]);
  page.drawText("UPB CAPITAL  -  YEAR-END STATEMENT", { x: 48, y: 744, size: 10, font: bold, color: quiet });
  page.drawText(`Tax year ${statement.year}`, { x: 48, y: 712, size: 18, font: bold, color: ink });
  page.drawText(clean(holder).slice(0, 100), { x: 48, y: 692, size: 10, font, color: quiet });
  page.drawText(`Notes held during ${statement.year}: ${statement.rows.length}  -  prepared ${new Date().toISOString().slice(0, 10)}`, { x: 48, y: 676, size: 9, font, color: quiet });
  footer(page);
  let y = 640;
  const room = (needed: number) => {
    if (y - needed >= 96) return;
    page = pdf.addPage([612, 792]);
    page.drawText(`UPB CAPITAL  -  YEAR-END STATEMENT ${statement.year}  -  CONTINUED`, { x: 48, y: 744, size: 10, font: bold, color: quiet });
    footer(page);
    y = 712;
  };
  const amountLine = (label: string, value: number, face: PDFFont = font) => {
    page.drawText(clean(label), { x: 60, y, size: 10, font: face, color: ink });
    const text = dollars(value);
    page.drawText(text, { x: 548 - face.widthOfTextAtSize(text, 10), y, size: 10, font: face, color: ink });
    y -= 16;
  };
  const section = (heading: string, detail: string, lines: [string, number][], face: PDFFont = font) => {
    room(34 + lines.length * 16);
    page.drawText(clean(heading).slice(0, 80), { x: 48, y, size: 12, font: bold, color: ink });
    y -= 14;
    if (detail) {
      page.drawText(clean(detail).slice(0, 110), { x: 48, y, size: 8, font, color: quiet });
      y -= 14;
    }
    for (const [label, value] of lines) amountLine(label, value, face);
    y -= 12;
  };
  // The accretion line shows only for a holding that accretes, and in the totals of a book that has one.
  const linesOf = (row: Omit<Statement["totals"], "accreted">, accreted?: number | null, method = ""): [string, number][] => [
    ["Interest received", row.interest],
    ["Principal received", row.principal],
    ["Fees received", row.fees],
    ["Escrow received", row.escrow],
    ...(row.unsplit > 0 ? [["Received, not split", row.unsplit] as [string, number]] : []),
    ["Cost basis", row.costBasis],
    ["Sale proceeds, net of commission", row.saleProceeds],
    ...(accreted != null ? [[`Discount accreted, for your tax adviser${method ? ` (${method})` : ""}`, accreted] as [string, number]] : []),
  ];
  for (const row of statement.rows) {
    const sold = row.soldOn ? `  -  sold ${day(row.soldOn)}` : "";
    section(row.title, `Acquired ${day(row.acquiredAt)}  -  split: ${row.basis}${sold}`, linesOf(row, row.accreted, row.accretionBasis));
  }
  if (!statement.rows.length) section("No notes held", `Nothing on your book was held during ${statement.year}.`, []);
  section(`Totals for ${statement.year}`, "", linesOf(statement.totals, statement.totals.accreted), bold);
  return pdf.save();
}

// ---------------------------------------------------------------------------------------------------------------
// The statement by email, when the buyer asks for it: the PDF attached, and the link to download it signed in.

type StatementOwner = { id: string; email: string; name: string; companyName: string };

// Who the statement is made out to: the buyer's entity, else their company or name, with their email.
export async function statementHolder(user: StatementOwner) {
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { entityName: true } });
  return [profile?.entityName || user.companyName || user.name, user.email].filter(Boolean).join("  -  ");
}

export function statementYearProblem(year: number, now = new Date()) {
  return Number.isInteger(year) && year >= 1990 && year <= now.getUTCFullYear() ? null : "Choose a tax year up to this one.";
}

// It reaches the inbox whatever the email notice setting says, because the buyer asked for it just now.
export async function emailYearStatement(user: StatementOwner, year: number, now = new Date()) {
  const problem = statementYearProblem(year, now);
  if (problem) return { error: problem } as const;
  const statement = taxYearStatement(await loadStatementHoldings(user.id), year);
  const pdf = await buildYearStatementPdf(statement, await statementHolder(user));
  const link = `${appOrigin()}/api/portfolio/statement?year=${year}&format=pdf`;
  await sendAlert(
    user.email,
    `Year-end statement · ${year}`,
    `Your ${year} year-end statement from UPB Capital is attached as a PDF. You can also download it signed in: ${link}\n\n${STATEMENT_NOTE}`,
    { attachments: [{ filename: `upb-statement-${year}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }] },
  );
  return { error: null } as const;
}
