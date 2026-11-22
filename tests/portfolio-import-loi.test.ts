import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { pdfText } from "../lib/ai-reading";
import { allInFor, feeTerms } from "../lib/fee-schedule";
import { money } from "../lib/format";
import { LOI_CLOSED, LOI_NON_BINDING, LOI_SEALED, buildLoiPdf, loiReady, openLoi } from "../lib/loi";
import {
  IMPORT_HEADERS,
  MAX_IMPORT_ROWS,
  bookMatrix,
  importBatches,
  importBook,
  importTemplateCsv,
  mapImportHeaders,
  ownedNoteProblems,
  previewBook,
  previewImport,
  readAcquired,
  readBook,
  undoImport,
} from "../lib/portfolio-import";
import { prisma } from "../lib/prisma";
import { INDICATIVE_LABEL, INDICATIVE_REFUSED } from "../lib/sale-rounds";
import { getSettings } from "../lib/settings";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
// A state nothing seeded uses, so no buy box or standing bid reaches these listings.
const STATE = "QJ";
const made = { users: [] as { id: string; email: string }[], listings: [] as string[], batches: [] as string[] };

type Role = "BUYER" | "ADMIN" | "INSTITUTIONAL_SELLER";

async function person(who: string, role: Role, data: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `book-${who}-${tag}@example.org`,
      name: `Book ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const, companyName: `${who} Capital ${tag}` } : {}),
      ...data,
    } as never,
  });
  made.users.push(user);
  return user;
}

async function buyer(who: string) {
  const user = await person(who, "BUYER");
  await prisma.buyerProfile.create({
    data: { userId: user.id, status: "APPROVED", entityType: "LLC", entityName: `${who} Notes LLC ${tag}`, jurisdiction: "Delaware", homesControlled: 0, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY) },
  });
  return user;
}

const loan = (street: string, loanNumber: string): Prisma.NoteCreateWithoutListingInput => ({
  streetAddress: `${street} ${tag}`,
  city: "Lakewood",
  state: STATE,
  zip: "99721",
  propertyType: "SFR",
  occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST",
  upb: 120000,
  interestRate: 7,
  monthlyPi: 900,
  paymentStatus: "PERFORMING",
  monthsDelinquent: 0,
  askingPrice: 60000,
  estimatedValue: 200000,
  borrowerName: "Odile Fenwick",
  loanNumber,
});

async function listing(sellerId: string, data: Record<string, unknown> = {}, loanNumber = `LN-${tag}-${made.listings.length + 1}`) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      standingBidsNotifiedAt: new Date(),
      title: `Book test ${tag} ${made.listings.length + 1}`,
      summary: "A test listing.",
      bidMode: "NONE",
      notes: { create: [loan(`${made.listings.length + 1} Ledger Lane`, loanNumber)] },
      ...data,
    } as never,
  });
  made.listings.push(row.id);
  return row;
}

const offer = (listingId: string, buyerId: string, amount: number, data: Record<string, unknown> = {}) =>
  prisma.inquiry.create({ data: { listingId, buyerId, type: "OFFER", amount, status: "OPEN", ...data } as never });

const csv = (rows: string[][]) => Buffer.from(rows.map((row) => row.map((cell) => (/[",]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(",")).join("\n"));
const matrixOf = (rows: string[][]) => bookMatrix(csv(rows), "book.csv");
const text = async (content: Parameters<typeof buildLoiPdf>[0]) => pdfText(await buildLoiPdf(content)).replace(/\s+/g, " ");

test.after(async () => {
  const userIds = made.users.map((user) => user.id);
  const ids = made.listings;
  const inquiries = (await prisma.inquiry.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((row) => row.id);
  const holdings = (await prisma.buyerHolding.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.cashReceipt.deleteMany({ where: { buyerHoldingId: { in: holdings } } });
  await prisma.buyerHolding.deleteMany({ where: { id: { in: holdings } } });
  await prisma.tapeDraft.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.groupBuy.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiries } } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiries } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...inquiries, ...holdings, ...made.batches, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The portfolio import

test("the template carries the hand form's fields, and a servicer's headers map without renaming", () => {
  const template = importTemplateCsv();
  assert.equal(template.split("\n")[0], IMPORT_HEADERS.join(","));
  for (const header of ["title", "cost", "upb", "underwritten_yield", "acquired_date", "loan_number", "state"]) assert.ok(IMPORT_HEADERS.includes(header as never), header);
  // The template's own headers map to themselves.
  const own = mapImportHeaders([...IMPORT_HEADERS]);
  assert.deepEqual(own, { title: "title", costBasis: "cost", upb: "upb", underwrittenYield: "underwritten_yield", acquiredAt: "acquired_date", loanNumber: "loan_number", streetAddress: "street_address", city: "city", state: "state" });
  // A servicer's export and a fund's own book, as they come.
  const servicer = mapImportHeaders(["Loan #", "Property Address", "Property City", "Property State", "Current Principal Balance", "Purchase Price", "Purchase Date", "Yield"]);
  assert.deepEqual(servicer, {
    loanNumber: "Loan #",
    streetAddress: "Property Address",
    city: "Property City",
    state: "Property State",
    upb: "Current Principal Balance",
    costBasis: "Purchase Price",
    acquiredAt: "Purchase Date",
    underwrittenYield: "Yield",
  });
  // The template's sample row never lands on a book.
  const sample = readBook(bookMatrix(Buffer.from(template), "template.csv"));
  assert.ok(sample.ok);
  assert.equal(sample.value.rows.length, 0);
  assert.match(sample.value.errors[0].reasons[0], /sample row/);
});

test("rows are checked as a note added by hand is, and the preview gives row numbers, reasons and totals", () => {
  assert.deepEqual(ownedNoteProblems({ title: "Ok note", cost: 1, upb: 1, underwrittenYield: null, acquiredAt: new Date() }), []);
  assert.deepEqual(ownedNoteProblems({ title: "ab", cost: 0, upb: -1, underwrittenYield: 90, acquiredAt: null }).map((problem) => problem.field), ["title", "cost", "upb", "acquiredAt", "underwrittenYield"]);
  assert.equal(readAcquired("2024-02-29")?.toISOString(), "2024-02-29T00:00:00.000Z");
  assert.equal(readAcquired("3/15/2024")?.toISOString(), "2024-03-15T00:00:00.000Z");
  assert.equal(readAcquired("3/15/24", new Date("2026-11-22T00:00:00Z"))?.toISOString(), "2024-03-15T00:00:00.000Z");
  assert.equal(readAcquired("2023-02-29"), null);
  assert.equal(readAcquired("soon"), null);

  const preview = previewBook(
    matrixOf([
      ["Loan #", "Property Address", "City", "State", "Current Balance", "Purchase Price", "Purchase Date", "Yield"],
      ["1001", "12 Elm St", "Dayton", "OH", "$85,000.00", "$41,250.00", "2024-03-15", "11.5%"],
      ["1002", "9 Oak Ave", "Toledo", "OH", "62,500", "30000", "4/2/2024", "0.12"],
      ["1003", "4 Pine Rd", "Akron", "OH", "70000", "", "2024-05-01", ""],
      ["1004", "", "", "", "0", "20000", "someday", "95"],
      ["", "", "", "", "", "", "", ""],
      ["1005", "2 Birch Ct", "Parma", "OH", "50000", "25000", "2024-06-30", ""],
    ]),
    new Map(),
  );
  assert.ok(preview.ok);
  const { rows, errors, totals } = preview.value;
  assert.deepEqual(rows.map((row) => row.row), [2, 3, 7]);
  // A row with no title is named from its address and loan number.
  assert.equal(rows[0].title, "12 Elm St, Dayton, OH · loan 1001");
  assert.equal(rows[0].underwrittenYield, 11.5);
  assert.equal(rows[1].underwrittenYield, 12);
  assert.equal(rows[1].acquiredAt.toISOString().slice(0, 10), "2024-04-02");
  assert.deepEqual(errors.map((row) => row.row), [4, 5]);
  assert.deepEqual(errors[0].reasons, ["no cost above zero"]);
  assert.deepEqual(errors[1].reasons, ["no UPB above zero", "no acquired date", "underwritten yield outside 0 to 80"]);
  assert.equal(errors[1].label, "Loan 1004");
  assert.deepEqual(totals, { count: 3, upb: 197500, costBasis: 96250 });

  // An export's title rows above the header are passed over, and rows keep the numbers the sheet shows.
  const titled = previewBook(
    matrixOf([["Servicer export, November 2026"], [""], ["Loan Number", "State", "Principal Balance", "Price Paid", "Purchased"], ["2001", "OH", "40000", "21000", "2025-01-15"]]),
    new Map(),
  );
  assert.ok(titled.ok);
  assert.deepEqual(titled.value.rows.map((row) => [row.row, row.title]), [[4, "Loan 2001, OH"]]);

  // A workbook reads the same, its date cells as serial days and its figures as numbers.
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Asset Name", "Cost Basis", "UPB", "Underwritten Yield", "Date Acquired"],
    // 45366 is March 15, 2024, formatted as a date the way a workbook keeps one, so no time zone moves it.
    ["Workbook note", 41250, 85000, 0.115, { t: "n", v: 45366, z: "m/d/yy" }],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Book");
  const fromExcel = previewBook(bookMatrix(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer, "book.xlsx"), new Map());
  assert.ok(fromExcel.ok);
  assert.deepEqual(
    fromExcel.value.rows.map((row) => [row.title, row.costBasis, row.upb, row.underwrittenYield, row.acquiredAt.toISOString().slice(0, 10)]),
    [["Workbook note", 41250, 85000, 11.5, "2024-03-15"]],
  );

  // A file without a column for a required field is refused whole.
  const missing = readBook(matrixOf([["title", "upb"], ["Note one", "1000"]]));
  assert.ok(!missing.ok);
  assert.match(missing.error, /No column for the cost/);
});

test("an upload is capped at 1,000 rows", () => {
  const header = ["title", "cost", "upb", "acquired_date"];
  const body = (count: number) => Array.from({ length: count }, (_, index) => [`Capped note ${index + 1}`, "100", "200", "2024-01-02"]);
  const full = readBook(matrixOf([header, ...body(MAX_IMPORT_ROWS)]));
  assert.ok(full.ok);
  assert.equal(full.value.rows.length, MAX_IMPORT_ROWS);
  const over = readBook(matrixOf([header, ...body(MAX_IMPORT_ROWS + 1)]));
  assert.ok(!over.ok);
  assert.match(over.error, /1,001 rows/);
  assert.match(over.error, /up to 1,000/);
});

test("duplicates of the book, by title or by loan number and state, and repeats within the file are skipped", async () => {
  const fund = await buyer("dupes");
  const seller = await person("dupes-seller", "INSTITUTIONAL_SELLER");
  const bought = await listing(seller.id, {}, "00778-899");
  // A note bought on UPB, and one added by hand.
  await prisma.buyerHolding.create({ data: { userId: fund.id, listingId: bought.id, title: "Bought on UPB", costBasis: 50000, upb: 120000, acquiredAt: new Date("2025-01-10T00:00:00Z") } });
  await prisma.buyerHolding.create({ data: { userId: fund.id, title: "Maple Avenue Note", costBasis: 30000, upb: 60000, acquiredAt: new Date("2024-01-10T00:00:00Z") } });
  const bytes = csv([
    ["title", "cost", "upb", "acquired_date", "loan_number", "state"],
    ["maple avenue note.", "30000", "60000", "2024-01-10", "", ""],
    ["Renamed by the servicer", "50000", "120000", "2025-01-10", "778899", STATE.toLowerCase()],
    ["Fresh note", "10000", "20000", "2024-02-01", "5551", "OH"],
    ["Fresh note again", "10000", "20000", "2024-02-01", "5551", "OH"],
  ]);
  const preview = await previewImport(fund.id, "book.csv", bytes);
  assert.ok(preview.ok);
  assert.deepEqual(preview.value.rows.map((row) => row.title), ["Fresh note"]);
  assert.deepEqual(preview.value.duplicates.map((row) => [row.row, row.reason]), [
    [2, 'already in your portfolio as "Maple Avenue Note"'],
    [3, 'already in your portfolio as "Bought on UPB"'],
    [5, "the same note as row 4"],
  ]);
});

test("the import writes the good rows under one batch id, logs counts only, and an undo keeps any note worked on since", async () => {
  const fund = await buyer("import");
  const file = {
    filename: "book.csv",
    bytes: csv([
      ["title", "cost", "upb", "underwritten_yield", "acquired_date"],
      ["Import note one", "41250", "85000", "11.5", "2024-03-15"],
      ["Import note two", "30000", "62500", "", "2024-04-02"],
      ["Import note three", "25000", "50000", "9", "2024-06-30"],
      ["Bad row", "", "50000", "", "2024-06-30"],
    ]),
  };
  const result = await importBook(fund, file);
  assert.ok(result.ok);
  const { batchId } = result.value;
  made.batches.push(batchId);
  assert.deepEqual({ imported: result.value.imported, skipped: result.value.skipped, errors: result.value.errors }, { imported: 3, skipped: 0, errors: 1 });
  const holdings = await prisma.buyerHolding.findMany({ where: { userId: fund.id }, orderBy: { title: "asc" } });
  assert.equal(holdings.length, 3);
  assert.ok(holdings.every((holding) => holding.importBatchId === batchId));
  const one = holdings.find((holding) => holding.title === "Import note one")!;
  assert.deepEqual([one.costBasis, one.upb, one.underwrittenYield, one.acquiredAt.toISOString().slice(0, 10)], [41250, 85000, 11.5, "2024-03-15"]);
  const logged = await prisma.auditEvent.findFirstOrThrow({ where: { action: "PORTFOLIO_IMPORT", entityId: batchId } });
  assert.equal(logged.actorId, fund.id);
  // Counts only: no figure, no title.
  assert.equal(logged.detail, "3 imported · 0 duplicates skipped · 1 with errors");

  // The same file again brings nothing in.
  const again = await importBook(fund, file);
  assert.ok(!again.ok);
  assert.match(again.error, /already in your portfolio/);

  // A payment logged on one note and a relist of another since the import: both stay.
  const two = holdings.find((holding) => holding.title === "Import note two")!;
  const three = holdings.find((holding) => holding.title === "Import note three")!;
  await prisma.cashReceipt.create({ data: { buyerHoldingId: two.id, amount: 650, paidOn: new Date("2024-05-01T00:00:00Z"), source: "MANUAL" } });
  await prisma.auditEvent.create({ data: { actorId: fund.id, action: "RELIST", entityType: "holding", entityId: three.id, detail: "relisted" } });
  assert.deepEqual((await importBatches(fund.id)).map((batch) => [batch.id, batch.imported, batch.left, batch.removable]), [[batchId, 3, 3, 1]]);

  const stranger = await buyer("import-stranger");
  const refused = await undoImport(stranger, batchId);
  assert.ok(!refused.ok);
  assert.equal(await prisma.buyerHolding.count({ where: { importBatchId: batchId } }), 3);

  const undone = await undoImport(fund, batchId);
  assert.ok(undone.ok);
  assert.deepEqual(undone.value, { removed: 1, kept: 2 });
  assert.deepEqual((await prisma.buyerHolding.findMany({ where: { userId: fund.id }, select: { id: true } })).map((row) => row.id).sort(), [two.id, three.id].sort());
  const undoLog = await prisma.auditEvent.findFirstOrThrow({ where: { action: "PORTFOLIO_IMPORT_UNDO", entityId: batchId } });
  assert.equal(undoLog.detail, "1 removed · 2 kept");
  // What stays is shown, with nothing left for an undo to take.
  assert.deepEqual((await importBatches(fund.id)).map((batch) => [batch.left, batch.removable]), [[2, 0]]);
});

// ---------------------------------------------------------------------------------------------------------------
// The letter of intent

test("the letter states the price, the all-in, the entity and the non-binding wording, and is logged per download", async () => {
  const fund = await buyer("loi");
  const seller = await person("loi-seller", "INSTITUTIONAL_SELLER");
  const row = await listing(seller.id);
  const goodUntil = new Date(Date.now() + 20 * DAY);
  const bid = await offer(row.id, fund.id, 52000, { expiresAt: goodUntil });
  assert.ok((await loiReady([bid])).has(bid.id));

  const opened = await openLoi(bid.id, fund);
  assert.ok(opened.ok);
  assert.equal(opened.side, "buyer");
  const words = await text(opened.content);
  const allIn = allInFor(feeTerms(row, await getSettings()), 52000);
  assert.match(words, /\$52,000\.00/);
  assert.ok(words.includes(`All-in: ${money(allIn, 2)}`), words);
  // No buying entity on the bid, so the main file's entity name.
  assert.ok(words.includes(`Buyer: loi Notes LLC ${tag}`), words);
  assert.ok(words.includes(LOI_NON_BINDING), words);
  assert.match(words, /not a contract/);
  assert.match(words, /Desk draft for counsel to confirm/);
  assert.match(words, /Subject to the purchase agreement/);
  assert.match(words, /data room/);
  assert.match(words, /Good until: /);
  // Nothing of a round on a one-round sale.
  assert.doesNotMatch(words, /Indicative/);

  // A seat signs in as its firm's account, so it opens the firm's letter.
  const seated = await openLoi(bid.id, { ...fund, actor: { id: "seat", name: "Seat", email: "seat@example.org", seatRole: "VIEW", bidLimitCents: null } } as never);
  assert.ok(seated.ok);
  const downloads = await prisma.auditEvent.findMany({ where: { action: "LOI_DOWNLOAD", entityId: bid.id } });
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every((event) => event.actorId === fund.id && !/\$|52,000/.test(event.detail)));

  // A bid that no longer stands has no letter.
  await prisma.inquiry.update({ where: { id: bid.id }, data: { status: "WITHDRAWN" } });
  const closed = await openLoi(bid.id, fund);
  assert.ok(!closed.ok);
  assert.equal(closed.error, LOI_CLOSED);
  assert.equal((await loiReady([{ ...bid, status: "WITHDRAWN" }])).size, 0);
});

test("a round-one bid on a two-round sale reads as indicative", async () => {
  const fund = await buyer("loi-rounds");
  const seller = await person("loi-rounds-seller", "INSTITUTIONAL_SELLER");
  const row = await listing(seller.id, { bidMode: "SEALED", roundOneEndsAt: new Date(Date.now() + 3 * DAY), bidDeadline: new Date(Date.now() + 10 * DAY) });
  const bid = await offer(row.id, fund.id, 47000, { round: 1 });
  const opened = await openLoi(bid.id, fund);
  assert.ok(opened.ok);
  const words = await text(opened.content);
  assert.ok(words.includes(INDICATIVE_LABEL), words);
  assert.ok(words.includes(INDICATIVE_REFUSED), words);
  assert.match(words, /Indicative price: \$47,000\.00/);
  assert.match(words, /apply to a final bid that is awarded, not to this indicative bid/);
  // The seller reads round one's amounts once it closes, not before.
  const early = await openLoi(bid.id, seller);
  assert.ok(!early.ok);
  assert.equal(early.status, 403);
});

test("another buyer is refused, and the seller and a walled desk role are refused while the bid is sealed", async () => {
  const fund = await buyer("loi-sealed");
  const other = await buyer("loi-other");
  const seller = await person("loi-sealed-seller", "INSTITUTIONAL_SELLER");
  const trader = await person("loi-trader", "ADMIN", { deskRole: "TRADER" });
  const owner = await person("loi-owner", "ADMIN", { deskRole: "OWNER" });
  const row = await listing(seller.id, { bidMode: "SEALED", bidDeadline: new Date(Date.now() + 5 * DAY) });
  const bid = await offer(row.id, fund.id, 61000);

  const stranger = await openLoi(bid.id, other);
  assert.deepEqual([stranger.ok, !stranger.ok && stranger.status], [false, 404]);
  const sealed = await openLoi(bid.id, seller);
  assert.ok(!sealed.ok);
  assert.deepEqual([sealed.status, sealed.error], [403, LOI_SEALED]);
  const walled = await openLoi(bid.id, trader);
  assert.ok(!walled.ok);
  assert.equal(walled.status, 403);
  // The desk's sealed-bid readers, and the buyer itself, read it during the round.
  assert.ok((await openLoi(bid.id, owner)).ok);
  assert.ok((await openLoi(bid.id, fund)).ok);
  // Refusals aren't logged as downloads.
  assert.deepEqual((await prisma.auditEvent.findMany({ where: { action: "LOI_DOWNLOAD", entityId: bid.id } })).map((event) => event.actorId).sort(), [owner.id, fund.id].sort());

  // Once the deadline passes the seller reads it, with the bidder by letter until an award.
  await prisma.listing.update({ where: { id: row.id }, data: { bidDeadline: new Date(Date.now() - 60 * 1000) } });
  const open = await openLoi(bid.id, seller);
  assert.ok(open.ok);
  assert.equal(open.side, "seller");
  const words = await text(open.content);
  assert.match(words, /Buyer: Bidder A/);
  assert.ok(!words.includes(`loi-sealed Notes LLC ${tag}`));
  assert.match(words, /\$61,000\.00/);
  assert.ok(await prisma.auditEvent.findFirst({ where: { action: "LOI_DOWNLOAD", entityId: bid.id, actorId: seller.id } }));
});
