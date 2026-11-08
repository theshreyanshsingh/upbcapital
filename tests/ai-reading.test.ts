import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ACCURACY_FLOOR, evaluateReader, FIXTURE_DIR, onBlock, runEval, setReadingMode } from "../lib/ai-eval";
import {
  activeReader,
  checkModelFindings,
  compareWithTape,
  confirmFinding,
  draftAnswer,
  draftSources,
  draftVisible,
  extractFindings,
  fieldsAsked,
  modelDraft,
  modelReader,
  NEEDS_MODEL,
  pdfText,
  readDocument,
  READER_ID,
  READER_WAIVE_REASON,
  readingModeOf,
  readValue,
  rejectFinding,
  rulesReader,
  sameRead,
  skipReason,
  textKeyFor,
} from "../lib/ai-reading";
import { approvalHold } from "../lib/discrepancies";
import { fieldState, verifiedMap } from "../lib/loan-file";
import { prisma } from "../lib/prisma";
import { clearSettingsCache } from "../lib/settings";
import { getBytes, putBytes, uploadDir } from "../lib/storage";

// Files go to local disk, mail to the log and rate limits to memory, and no model key is set, whatever the shared
// .env says. Prisma loads that file on import, so these are set after it.
for (const key of [
  "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL",
  "LLM_API_KEY", "OPENAI_API_KEY", "LLM_BASE_URL", "LLM_MODEL",
]) process.env[key] = "";
process.env.RATE_LIMIT_STORE = "memory";

// No test reaches a real model. A test that expects a call stubs fetch for itself; anything else fails loudly.
const realFetch = globalThis.fetch;
const noNetwork = (async () => {
  throw new Error("The reader tests made a network call they didn't stub.");
}) as typeof fetch;
globalThis.fetch = noNetwork;

test.after(async () => {
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
});

const MODEL_ENV = { LLM_API_KEY: "test-key", LLM_MODEL: "test-model", LLM_BASE_URL: "https://llm.invalid/v1" };

type Call = { url: string; init: { headers: Record<string, string>; body: string } };

// Answers every chat call with this JSON as the model's message, and keeps what was sent.
function stubModel(answer: unknown) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: Call["init"]) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

async function fixture(name: string) {
  return fs.readFile(path.join(FIXTURE_DIR, name));
}

async function textPdf(lines: string[]) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, index) => page.drawText(line, { x: 72, y: 720 - index * 18, size: 11, font }));
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------------------------------------------
// The rules reader

test("the rules reader reads the labelled fixtures at or above the bar, and misses rather than guesses", async () => {
  const result = await evaluateReader(rulesReader());
  assert.equal(result.source, "rules");
  assert.ok(result.fields >= 50, `only ${result.fields} labelled fields`);
  assert.ok(result.accuracy >= ACCURACY_FLOOR, `rules reader scored ${result.accuracy}`);
  // Nothing was read that a file doesn't state.
  assert.deepEqual(result.lines.filter((line) => line.expected == null), []);

  const pay = Object.fromEntries(extractFindings((await fixture("02-pay-history.txt")).toString("utf8")).map((finding) => [finding.field, finding]));
  assert.equal(pay.upb.value, "312400");
  assert.equal(pay.upb.quote, "Unpaid Principal Balance as of 10/01/2026: $312,400.00");
  assert.equal(pay.upb.page, 1);
  // The escrowed total isn't principal and interest, and the table's balances aren't read as the UPB.
  assert.equal(pay.monthlyPi.value, "2070.38");
  assert.equal(pay.lastPaidDate.value, "2026-10-01");
  assert.equal(pay.streetAddress.value, "418 Candela Ave");

  // "Original principal amount" is the original balance, never the UPB.
  const note = extractFindings((await fixture("01-promissory-note.txt")).toString("utf8"));
  assert.equal(note.find((finding) => finding.field === "originalBalance")?.value, "350000");
  assert.equal(note.some((finding) => finding.field === "upb"), false);

  // The seeded demo note reads as the tape has it.
  const seed = await rulesReader().read({ name: "coral-note.txt", mime: "text/plain", bytes: await fixture("11-seed-coral-note.txt") });
  assert.equal(seed.status, "READ");
  assert.deepEqual(seed.findings.map((finding) => [finding.field, finding.value]), [["borrowerName", "FICTIONAL BORROWER A"]]);

  // Two values for one field are both kept, at low confidence, for the desk to settle.
  const twice = extractFindings("Interest rate: 5.875%\nInterest rate: 6.125%\nMaturity date: June 15, 2049\nMaturity Date: 06/15/2049");
  assert.deepEqual(twice.filter((finding) => finding.field === "interestRate").map((finding) => finding.confidence), [0.5, 0.5]);
  assert.deepEqual(twice.filter((finding) => finding.field === "maturityDate").map((finding) => [finding.value, finding.confidence]), [["2049-06-15", 0.9]]);
  // A page break moves the page on.
  assert.equal(extractFindings("Cover sheet\fUnpaid balance: $12,000.00")[0].page, 2);
});

test("values read the same in any spelling, and compare with the tape the way the discrepancy gate does", () => {
  assert.equal(readValue("upb", "$312,400.00"), "312400");
  assert.equal(readValue("upb", "312400"), "312400");
  assert.equal(readValue("interestRate", "5.875% per annum"), "5.875");
  assert.equal(readValue("interestRate", "0.05875"), "5.875");
  assert.equal(readValue("maturityDate", "June 15, 2049"), "2049-06-15");
  assert.equal(readValue("maturityDate", "the 1st day of July, 2049"), "2049-07-01");
  assert.equal(readValue("maturityDate", "02/30/2049"), null);
  assert.equal(readValue("lienPosition", "2nd"), "SECOND");
  assert.equal(readValue("upb", "lots"), null);
  assert.equal(readValue("notAField", "1"), null);
  // Money within a dollar, a rate within a thousandth of a point, dates to the day.
  assert.equal(sameRead("upb", "312400", "312400.90"), true);
  assert.equal(sameRead("upb", "312400", "312402"), false);
  assert.equal(sameRead("interestRate", "5.875", "5.8755"), true);
  assert.equal(sameRead("interestRate", "5.875", "5.877"), false);
  assert.equal(sameRead("streetAddress", "418 Candela Ave.", "418 CANDELA AVENUE"), true);
  assert.equal(sameRead("borrowerName", "Dana R. Whitfield", "dana r whitfield"), true);
  const tape = { upb: 312400, interestRate: 5.875, maturityDate: new Date("2049-07-01T00:00:00Z"), lienPosition: "FIRST", borrowerName: "", streetAddress: "418 Candela Avenue" };
  assert.equal(compareWithTape("upb", "312400.4", tape), "match");
  assert.equal(compareWithTape("upb", "310000", tape), "mismatch");
  assert.equal(compareWithTape("maturityDate", "2049-07-01", tape), "match");
  assert.equal(compareWithTape("lienPosition", "SECOND", tape), "mismatch");
  assert.equal(compareWithTape("borrowerName", "Dana Whitfield", tape), "blank");
  // Tape v3 gave the original balance a column, so it compares like any field; one the tape leaves empty reads blank.
  assert.equal(compareWithTape("originalBalance", "350000", tape), "blank");
  assert.equal(compareWithTape("memo", "anything", tape), "none");
  assert.equal(readingModeOf(undefined), "SHADOW");
  assert.equal(readingModeOf("ON"), "ON");
  assert.equal(readingModeOf("on"), "SHADOW");
});

test("a PDF is skipped without a model key, with the reason, and an image is skipped too", async () => {
  assert.equal(activeReader({}).source, "rules");
  // A key alone keeps the offline rules: files go to a model only once the desk opts in.
  assert.equal(activeReader(MODEL_ENV).source, "rules");
  assert.equal(activeReader({ ...MODEL_ENV, AI_READING_MODEL: "1" }).source, "model:test-model");
  const pdf = await textPdf(["Unpaid principal balance: $312,400.00"]);
  const read = await rulesReader().read({ name: "pay-history.pdf", mime: "application/pdf", bytes: pdf });
  assert.deepEqual({ status: read.status, reason: read.reason, findings: read.findings.length }, { status: "SKIPPED", reason: NEEDS_MODEL, findings: 0 });
  assert.equal(skipReason({ mime: "application/pdf", originalName: "x.pdf", size: 1000 }), "Needs the model reader.");
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.equal((await rulesReader().read({ name: "front.png", mime: "image/png", bytes: png })).status, "SKIPPED");
});

// ---------------------------------------------------------------------------------------------------------------
// The model reader, with fetch stubbed

test("the model reader keeps a finding only when its quote is in the file and says the value", async () => {
  const bytes = await fixture("02-pay-history.txt");
  const calls = stubModel({
    findings: [
      { field: "upb", value: "312400.00", quote: "Unpaid Principal Balance as of 10/01/2026: $312,400.00", page: 1 },
      // A figure the file never states, with a quote to match.
      { field: "estimatedValue", value: "455000", quote: "As-is value: $455,000", page: 1 },
      // A real line, claimed to say something else.
      { field: "interestRate", value: "6.5", quote: "Interest Rate: 5.875%", page: 1 },
      { field: "prepaymentPenalty", value: "none", quote: "Escrow: $612.44", page: 1 },
      { field: "lastPaidDate", value: "2026-10-01", quote: "Last Payment Received:   10/01/2026", page: 1 },
    ],
  });
  try {
    const read = await modelReader(MODEL_ENV).read({ name: "pay-history.txt", mime: "text/plain", bytes });
    assert.equal(read.status, "READ");
    assert.deepEqual(read.findings.map((finding) => [finding.field, finding.value]), [["upb", "312400"], ["lastPaidDate", "2026-10-01"]]);
    assert.equal(read.rejected, 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://llm.invalid/v1/chat/completions");
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "test-model");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.match(body.messages[1].content, /Unpaid Principal Balance as of 10\/01\/2026/);
  } finally {
    globalThis.fetch = noNetwork;
  }
  // The check alone: no findings list, or a value that isn't the field's kind, keeps nothing.
  assert.deepEqual(checkModelFindings({ nope: true }, "text"), { findings: [], rejected: 0 });
  assert.equal(checkModelFindings({ findings: [{ field: "upb", value: "a lot", quote: "Unpaid balance: a lot" }] }, "Unpaid balance: a lot").rejected, 1);
});

test("the model reader sends a PDF as a base64 file part and checks its quotes against the PDF's own text", async () => {
  const pdf = await textPdf(["PAY HISTORY", "Unpaid principal balance: $312,400.00", "Interest rate: 5.875%"]);
  assert.match(pdfText(pdf), /Unpaid principal balance: \$312,400\.00/);
  const calls = stubModel({
    findings: [
      { field: "upb", value: 312400, quote: "Unpaid principal balance: $312,400.00", page: 1 },
      { field: "maturityDate", value: "2049-06-15", quote: "Maturity date: June 15, 2049", page: 2 },
    ],
  });
  try {
    const read = await modelReader(MODEL_ENV).read({ name: "pay-history.pdf", mime: "application/pdf", bytes: pdf });
    assert.deepEqual(read.findings.map((finding) => [finding.field, finding.value, finding.confidence]), [["upb", "312400", 0.8]]);
    assert.equal(read.rejected, 1);
    const content = JSON.parse(calls[0].init.body).messages[1].content;
    assert.ok(Array.isArray(content));
    const file = content.find((part: { type: string }) => part.type === "file");
    assert.equal(file.file.filename, "pay-history.pdf");
    assert.ok(file.file.file_data.startsWith("data:application/pdf;base64,"));
    assert.equal(Buffer.from(file.file.file_data.split(",")[1], "base64").equals(pdf), true);

    // A PDF with no words in it (a scan) can't check quotes, so what the model reads is kept at low confidence.
    const blank = await PDFDocument.create();
    blank.addPage();
    stubModel({ findings: [{ field: "upb", value: "98000", quote: "Principal balance $98,000.00", page: 1 }] });
    const scan = await modelReader(MODEL_ENV).read({ name: "scan.pdf", mime: "application/pdf", bytes: Buffer.from(await blank.save()) });
    assert.deepEqual(scan.findings.map((finding) => [finding.value, finding.confidence]), [["98000", 0.5]]);
    assert.equal(scan.text, "");

    // An error from the provider marks the read failed, in words.
    globalThis.fetch = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    const failed = await modelReader(MODEL_ENV).read({ name: "pay-history.pdf", mime: "application/pdf", bytes: pdf });
    assert.equal(failed.status, "FAILED");
    assert.match(failed.reason, /503/);
  } finally {
    globalThis.fetch = noNetwork;
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Recording, the mode, and the desk's decisions

async function makeRoom(tag: string, status: "UNDER_REVIEW" | "APPROVED") {
  const make = (name: string, role: "INDIVIDUAL_SELLER" | "ADMIN" | "BUYER") =>
    prisma.user.create({ data: { email: `reader-${name}-${tag}@example.org`, name: `${name} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const [seller, desk, buyer] = await Promise.all([make("seller", "INDIVIDUAL_SELLER"), make("desk", "ADMIN"), make("buyer", "BUYER")]);
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status,
      title: `Reader ${tag}`,
      notes: {
        create: [{
          streetAddress: "418 Candela Avenue", city: "Coral Gables", state: "FL", zip: "33134", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST", upb: 312400, interestRate: 5.875, monthlyPi: 2070.38, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 250000, estimatedValue: 640000, borrowerName: "Dana R. Whitfield",
          lastPaidDate: new Date("2026-10-01T00:00:00Z"), originationDate: new Date("2019-06-15T00:00:00Z"), maturityDate: new Date("2049-07-01T00:00:00Z"),
        }],
      },
    },
    include: { notes: true },
  });
  const keys: string[] = [];
  const file = async (name: string, type: "NOTE" | "PAY_HISTORY" | "BPO" | "PHOTO", body: Buffer, mime: string) => {
    const storedName = `reader-test-${tag}-${name}`;
    await putBytes(storedName, body, mime);
    keys.push(storedName);
    return prisma.document.create({ data: { listingId: listing.id, type, originalName: name, storedName, mime, size: body.length } });
  };
  const cleanup = async () => {
    const documents = await prisma.document.findMany({ where: { listingId: listing.id }, select: { id: true } });
    for (const key of [...keys, ...documents.map((document) => textKeyFor(document.id))]) await fs.rm(path.join(uploadDir(), key), { force: true });
    await prisma.aiFinding.deleteMany({ where: { listingId: listing.id } });
    await prisma.fieldDiscrepancy.deleteMany({ where: { listingId: listing.id } });
    await prisma.listingQuestion.deleteMany({ where: { listingId: listing.id } });
    await prisma.document.deleteMany({ where: { listingId: listing.id } });
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [listing.id, listing.notes[0].id] } } });
    await prisma.notification.deleteMany({ where: { toEmail: { in: [seller.email, desk.email, buyer.email] } } });
    await prisma.listingMatch.deleteMany({ where: { listingId: listing.id } });
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.user.deleteMany({ where: { id: { in: [seller.id, desk.id, buyer.id] } } });
  };
  return { seller, desk, buyer, listing, note: listing.notes[0], file, cleanup };
}

test("in shadow mode a mismatch is only a finding; in ON it opens a difference that holds approval, once", async () => {
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const room = await makeRoom(tag, "UNDER_REVIEW");
  try {
    const paid = await room.file("pay-history.txt", "PAY_HISTORY", Buffer.from("PAY HISTORY\nUnpaid principal balance: $310,000.00\nInterest rate: 5.875%\n"), "text/plain");
    const photo = await room.file("front.jpg", "PHOTO", Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg");
    const shadow = await readDocument(paid.id, { reader: rulesReader(), mode: "SHADOW" });
    assert.ok(shadow.ok && shadow.value.status === "READ" && shadow.value.findings === 2 && shadow.value.raised === 0);
    assert.equal(await prisma.fieldDiscrepancy.count({ where: { listingId: room.listing.id } }), 0);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: paid.id } });
    assert.equal(stored.readStatus, "READ");
    assert.ok(stored.readAt);
    assert.equal(stored.textKey, textKeyFor(paid.id));
    assert.match((await getBytes(stored.textKey!)).toString("utf8"), /\$310,000\.00/);
    const findings = await prisma.aiFinding.findMany({ where: { documentId: paid.id } });
    assert.deepEqual(findings.map((row) => [row.field, row.value, row.status, row.source, row.noteId]).sort(), [
      ["interestRate", "5.875", "PROPOSED", "rules", room.note.id],
      ["upb", "310000", "PROPOSED", "rules", room.note.id],
    ]);
    // Photos aren't loan paper, and the reader is off when the desk says so.
    assert.equal((await readDocument(photo.id, { reader: rulesReader(), mode: "SHADOW" })).ok, false);
    assert.match((await readDocument(paid.id, { reader: rulesReader(), mode: "OFF" }) as { error: string }).error, /off/);

    const on = await readDocument(paid.id, { reader: rulesReader(), mode: "ON" });
    assert.ok(on.ok && on.value.raised === 1);
    const [difference] = await prisma.fieldDiscrepancy.findMany({ where: { listingId: room.listing.id } });
    assert.deepEqual(
      { field: difference.field, tape: difference.tapeValue, document: difference.documentValue, source: difference.source, status: difference.status, by: difference.raisedById },
      { field: "upb", tape: "312400", document: "310000", source: "Pay history", status: "OPEN", by: READER_ID },
    );
    assert.match((await approvalHold(room.listing.id)) ?? "", /One tape difference is open/);
    // A second read neither duplicates the finding nor asks the seller twice.
    assert.ok((await readDocument(paid.id, { reader: rulesReader(), mode: "ON" })).ok);
    assert.equal(await prisma.fieldDiscrepancy.count({ where: { listingId: room.listing.id } }), 1);
    assert.equal(await prisma.aiFinding.count({ where: { documentId: paid.id, field: "upb" } }), 1);

    // The desk rejects the misreading, and the difference it opened is waived with a reason buyers read.
    const upb = await prisma.aiFinding.findFirstOrThrow({ where: { documentId: paid.id, field: "upb" } });
    const rejected = await rejectFinding(room.desk.id, upb.id);
    assert.ok(rejected.ok && rejected.value.waived);
    assert.equal((await prisma.aiFinding.findUniqueOrThrow({ where: { id: upb.id } })).status, "REJECTED");
    const waived = await prisma.fieldDiscrepancy.findUniqueOrThrow({ where: { id: difference.id } });
    assert.deepEqual([waived.status, waived.sellerNote, waived.resolvedById], ["WAIVED", READER_WAIVE_REASON, room.desk.id]);
    assert.equal(await approvalHold(room.listing.id), null);
    assert.equal((await rejectFinding(room.desk.id, upb.id)).ok, false);
    // A rejected reading isn't proposed again, so it can't open the difference a second time.
    assert.ok((await readDocument(paid.id, { reader: rulesReader(), mode: "ON" })).ok);
    assert.equal(await prisma.aiFinding.count({ where: { documentId: paid.id, field: "upb" } }), 1);
    assert.equal(await prisma.fieldDiscrepancy.count({ where: { listingId: room.listing.id, status: "OPEN" } }), 0);
  } finally {
    await room.cleanup();
  }
});

test("a match never verifies a field until the desk confirms it, and confirming marks it verified against the file", async () => {
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const room = await makeRoom(tag, "UNDER_REVIEW");
  try {
    const note = await room.file("note.txt", "NOTE", await fixture("01-promissory-note.txt"), "text/plain");
    const read = await readDocument(note.id, { reader: rulesReader(), mode: "ON" });
    assert.ok(read.ok && read.value.findings === 7 && read.value.raised === 0);
    let loan = await prisma.note.findUniqueOrThrow({ where: { id: room.note.id } });
    assert.deepEqual(verifiedMap(loan.verifiedFields), {});
    const rate = await prisma.aiFinding.findFirstOrThrow({ where: { documentId: note.id, field: "interestRate" } });
    assert.equal(compareWithTape(rate.field, rate.value, loan), "match");
    const confirmed = await confirmFinding(room.desk.id, rate.id);
    assert.ok(confirmed.ok && confirmed.value.verified && !confirmed.value.raised);
    loan = await prisma.note.findUniqueOrThrow({ where: { id: room.note.id } });
    const entry = verifiedMap(loan.verifiedFields).interestRate;
    assert.equal(entry.source, "Original note");
    assert.equal(entry.by, room.desk.id);
    assert.equal(fieldState(loan, "interestRate").state, "verified");
    const decided = await prisma.aiFinding.findUniqueOrThrow({ where: { id: rate.id } });
    assert.deepEqual([decided.status, decided.decidedById], ["CONFIRMED", room.desk.id]);
    assert.equal((await confirmFinding(room.desk.id, rate.id)).ok, false);

    // "418 Candela Avenue" against the tape's own spelling verifies the tape as it stands, without a difference.
    const street = await prisma.aiFinding.findFirstOrThrow({ where: { documentId: note.id, field: "streetAddress" } });
    assert.ok((await confirmFinding(room.desk.id, street.id)).ok);
    // The original balance is a tape column since tape v3, and this tape leaves it empty. Confirming the note's figure
    // verifies the field and asks the seller to fill it in, as the gate does for any blank field.
    const original = await prisma.aiFinding.findFirstOrThrow({ where: { documentId: note.id, field: "originalBalance" } });
    const noted = await confirmFinding(room.desk.id, original.id);
    assert.ok(noted.ok && noted.value.verified && noted.value.raised);
    assert.equal(await prisma.fieldDiscrepancy.count({ where: { listingId: room.listing.id } }), 1);

    // Reading the file again keeps what the desk decided and doesn't propose it again.
    assert.ok((await readDocument(note.id, { reader: rulesReader(), mode: "SHADOW" })).ok);
    const after = await prisma.aiFinding.findMany({ where: { documentId: note.id } });
    assert.equal(after.length, 7);
    assert.equal(after.filter((row) => row.status === "CONFIRMED").length, 3);
  } finally {
    await room.cleanup();
  }
});

test("a PDF in the room is marked skipped when no model key is set", async () => {
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const room = await makeRoom(tag, "UNDER_REVIEW");
  try {
    const pdf = await room.file("bpo.pdf", "BPO", await textPdf(["As-is value: $640,000"]), "application/pdf");
    const read = await readDocument(pdf.id, { mode: "SHADOW" });
    assert.ok(read.ok);
    assert.deepEqual({ status: read.value.status, reason: read.value.reason, source: read.value.source }, { status: "SKIPPED", reason: NEEDS_MODEL, source: "rules" });
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: pdf.id } });
    assert.deepEqual([stored.readStatus, stored.textKey], ["SKIPPED", null]);
    assert.equal(skipReason(stored), NEEDS_MODEL);
    assert.equal(await prisma.aiFinding.count({ where: { documentId: pdf.id } }), 0);
  } finally {
    await room.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Draft answers

test("a question that names a field gets a draft from the room's files, and any other question gets none", async () => {
  assert.deepEqual(fieldsAsked("What is the interest rate?"), ["interestRate"]);
  assert.deepEqual(fieldsAsked("What's the original balance and the current UPB?"), ["originalBalance", "upb"]);
  assert.deepEqual(fieldsAsked("Is there a default rate?"), []);
  assert.deepEqual(fieldsAsked("When does it mature, and what's the rate?"), ["maturityDate", "interestRate"]);
  assert.deepEqual(fieldsAsked("Can I drive by the property?"), []);
  assert.equal(draftVisible("SHADOW", "admin"), true);
  assert.equal(draftVisible("SHADOW", "seller"), false);
  assert.equal(draftVisible("ON", "broker"), true);
  assert.equal(draftVisible("OFF", "admin"), false);

  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const room = await makeRoom(tag, "APPROVED");
  try {
    const note = await room.file("note.txt", "NOTE", await fixture("01-promissory-note.txt"), "text/plain");
    const ask = (question: string) => prisma.listingQuestion.create({ data: { listingId: room.listing.id, askerId: room.buyer.id, question } });
    const rate = await ask("What is the interest rate on this note?");
    // The file hasn't been read yet; drafting reads it first.
    const drafted = await draftAnswer(rate.id, { reader: rulesReader(), mode: "SHADOW" });
    assert.ok(drafted.ok && drafted.value.drafted);
    const row = await prisma.listingQuestion.findUniqueOrThrow({ where: { id: rate.id } });
    assert.equal(row.aiDraft, "note.txt shows a note rate of 5.875%.");
    assert.ok(row.aiDraftedAt);
    assert.deepEqual(draftSources(row.aiSources), [{ documentId: note.id, name: "note.txt", quote: "Interest Rate: 5.875% per annum, fixed" }]);
    assert.equal(row.status, "OPEN");
    assert.equal(row.answer, "");

    for (const question of ["Can I drive by the property this week?", "Who is the borrower?"]) {
      const other = await ask(question);
      const none = await draftAnswer(other.id, { reader: rulesReader(), mode: "SHADOW" });
      assert.ok(none.ok && !none.value.drafted, question);
      assert.equal((await prisma.listingQuestion.findUniqueOrThrow({ where: { id: other.id } })).aiDraft, null);
    }
    // Off means no draft at all.
    const off = await ask("When does the loan mature?");
    assert.ok((await draftAnswer(off.id, { reader: rulesReader(), mode: "OFF" })).ok);
    assert.equal((await prisma.listingQuestion.findUniqueOrThrow({ where: { id: off.id } })).aiDraft, null);
  } finally {
    await room.cleanup();
  }
});

test("a model draft stands only on quotes found in the room's files", async () => {
  const files = [{ documentId: "doc-1", name: "note.txt", text: (await fixture("01-promissory-note.txt")).toString("utf8") }];
  try {
    stubModel({ answer: "The note rate is 5.875%, fixed.", sources: [{ documentId: "doc-1", quote: "Interest Rate: 5.875% per annum, fixed" }] });
    const draft = await modelDraft("What is the rate?", files, MODEL_ENV);
    assert.deepEqual(draft, { answer: "The note rate is 5.875%, fixed.", sources: [{ documentId: "doc-1", name: "note.txt", quote: "Interest Rate: 5.875% per annum, fixed" }] });
    stubModel({ answer: "The servicer is Sample Servicing.", sources: [{ documentId: "doc-1", quote: "Servicer: Sample Servicing" }, { documentId: "doc-9", quote: "Interest Rate" }] });
    assert.equal(await modelDraft("Who services it?", files, MODEL_ENV), null);
    stubModel({ answer: "", sources: [] });
    assert.equal(await modelDraft("Is it assumable?", files, MODEL_ENV), null);
  } finally {
    globalThis.fetch = noNetwork;
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The accuracy test and the gate

test("the accuracy run is recorded, and the reader goes ON only at 95% or better for the source that runs", async () => {
  assert.equal(onBlock(null)?.includes("hasn't been tested"), true);
  assert.match(onBlock({ accuracy: 0.949, correct: 949, fields: 1000 }) ?? "", /under the 95\.0%/);
  assert.equal(onBlock({ accuracy: 0.95, correct: 95, fields: 100 }), null);

  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const desk = await prisma.user.create({ data: { email: `reader-gate-${tag}@example.org`, name: `Gate ${tag}`, role: "ADMIN", accountStatus: "APPROVED", passwordHash: "x" } });
  const before = await prisma.platformSettings.findUnique({ where: { id: "default" }, select: { aiReading: true } });
  const source = `gate-test-${tag}`;
  let runId: string | null = null;
  try {
    const { run, result } = await runEval({ reader: rulesReader() });
    runId = run.id;
    assert.deepEqual({ source: run.source, fields: run.fields, correct: run.correct }, { source: "rules", fields: result.fields, correct: result.correct });
    assert.ok(run.accuracy >= ACCURACY_FLOOR);
    assert.ok(Array.isArray(JSON.parse(run.detail)));

    assert.match((await setReadingMode(desk.id, "ON", { source }) as { error: string }).error, /hasn't been tested/);
    await prisma.aiEvalRun.create({ data: { source, fields: 100, correct: 94, accuracy: 0.94, createdAt: new Date(Date.now() - 60_000) } });
    assert.match((await setReadingMode(desk.id, "ON", { source }) as { error: string }).error, /94\.0%/);
    assert.equal((await setReadingMode(desk.id, "LOUD", { source })).ok, false);
    // Shadow and off need no test.
    assert.ok((await setReadingMode(desk.id, "SHADOW", { source })).ok);
    await prisma.aiEvalRun.create({ data: { source, fields: 100, correct: 96, accuracy: 0.96 } });
    const on = await setReadingMode(desk.id, "ON", { source });
    assert.ok(on.ok && on.value === "ON");
    assert.equal((await prisma.platformSettings.findUniqueOrThrow({ where: { id: "default" } })).aiReading, "ON");
  } finally {
    await prisma.platformSettings.updateMany({ where: { id: "default" }, data: { aiReading: before?.aiReading ?? null } });
    clearSettingsCache();
    await prisma.aiEvalRun.deleteMany({ where: { OR: [{ source }, ...(runId ? [{ id: runId }] : [])] } });
    await prisma.auditEvent.deleteMany({ where: { actorId: desk.id } });
    await prisma.user.deleteMany({ where: { id: desk.id } });
  }
});
