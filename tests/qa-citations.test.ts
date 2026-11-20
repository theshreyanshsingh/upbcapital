import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { draftAnswer, draftSources, rulesReader, textKeyFor } from "../lib/ai-reading";
import { prisma } from "../lib/prisma";
import { checkCitation, citableDocuments, citeAnswer, draftCitation, QUOTE_MAX, quoteInText, sourceLine, uncited } from "../lib/qa-citations";
import { answerQuestion, publishedQuestions } from "../lib/questions";
import { putBytes, uploadDir } from "../lib/storage";

// Files go to local disk, mail to the log and rate limits to memory, whatever the shared .env says.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "LLM_API_KEY", "OPENAI_API_KEY"]) process.env[key] = "";
process.env.RATE_LIMIT_STORE = "memory";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

const NOTE = {
  streetAddress: "418 Candela Avenue", city: "Coral Gables", state: "FL", zip: "33134", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 312400, interestRate: 5.875, monthlyPi: 2070.38, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 250000, estimatedValue: 640000, borrowerName: "Fictional Borrower Q",
};

// Two pages, broken by a form feed, as the reader counts them.
const PAY_HISTORY = "Servicer: Sample Servicing\nLoan number: 55501\n\fUnpaid Principal Balance: $312,400.00\nInterest Rate: 5.875%\n";

async function textPdf(lines: string[]) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, index) => page.drawText(line, { x: 72, y: 720 - index * 18, size: 11, font }));
  return Buffer.from(await pdf.save());
}

// A scan: three pages and no words drawn on them.
async function scanPdf() {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

async function makeRoom() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN", pro = false) =>
    prisma.user.create({
      data: {
        email: `cite-${prefix}-${tag}@example.org`,
        name: `Cite ${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(pro ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const pro = await person("pro", "BUYER", true);
  const free = await person("free", "BUYER");
  const listing = (title: string) =>
    prisma.listing.create({
      data: { kind: "SINGLE", sellerId: seller.id, status: "APPROVED", approvedAt: new Date(Date.now() - 10 * DAY), title: `${title} ${tag}`, notes: { create: [NOTE] as never } },
    });
  const mine = await listing("Cited");
  const other = await listing("Other");
  const keys: string[] = [];
  const file = async (listingId: string, name: string, type: "PAY_HISTORY" | "BPO" | "NOTE" | "NDA", body: Buffer, mime: string) => {
    const storedName = `cite-test-${tag}-${name}`;
    await putBytes(storedName, body, mime);
    keys.push(storedName);
    return prisma.document.create({ data: { listingId, type, originalName: name, storedName, mime, size: body.length } });
  };
  const docs = {
    payHistory: await file(mine.id, "pay-history.txt", "PAY_HISTORY", Buffer.from(PAY_HISTORY, "utf8"), "text/plain"),
    scan: await file(mine.id, "bpo-scan.pdf", "BPO", await scanPdf(), "application/pdf"),
    note: await file(mine.id, "note.pdf", "NOTE", await textPdf(["PROMISSORY NOTE", "Lien position: First lien on the property", "Interest Rate: 5.875% per annum, fixed"]), "application/pdf"),
    nda: await file(mine.id, "signed-nda.pdf", "NDA", await scanPdf(), "application/pdf"),
    elsewhere: await file(other.id, "other-pay-history.txt", "PAY_HISTORY", Buffer.from(PAY_HISTORY, "utf8"), "text/plain"),
  };
  // Both buyers signed the NDA, so both read published answers. Only the Pro one opens the room's files.
  for (const buyer of [pro, free]) {
    await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId: mine.id, acknowledgedAt: new Date(Date.now() - DAY), signerName: buyer.name } });
  }
  const ask = (question: string, by = pro) => prisma.listingQuestion.create({ data: { listingId: mine.id, askerId: by.id, question } });
  const users = [seller, desk, pro, free];
  const cleanup = async () => {
    const listingIds = [mine.id, other.id];
    const documents = await prisma.document.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
    for (const key of [...keys, ...documents.map((document) => textKeyFor(document.id))]) await fs.rm(path.join(uploadDir(), key), { force: true });
    await prisma.aiFinding.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listingQuestion.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.document.deleteMany({ where: { listingId: { in: listingIds } } });
    const noteIds = (await prisma.note.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...noteIds] } }, { actorId: { in: users.map((user) => user.id) } }] } });
    await prisma.notification.deleteMany({ where: { toEmail: { in: users.map((user) => user.email) } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  };
  return { tag, seller, desk, pro, free, listing: mine, other, docs, ask, cleanup };
}

// ---------------------------------------------------------------------------------------------------------------
// Checking a citation

test("a citation is refused for another listing's file, a file that never goes out with the room, or a page past the end", async () => {
  const room = await makeRoom();
  try {
    const refused = async (input: Parameters<typeof checkCitation>[1], pattern: RegExp) => {
      const outcome = await checkCitation(room.listing.id, input);
      assert.equal(outcome.ok, false, JSON.stringify(input));
      if (!outcome.ok) assert.match(outcome.error, pattern);
    };
    // Another listing's file, a signed NDA, and an id that isn't a file at all.
    await refused({ documentId: room.docs.elsewhere.id }, /isn't in this listing's data room/);
    await refused({ documentId: room.docs.nda.id }, /isn't in this listing's data room/);
    await refused({ documentId: "no-such-file" }, /isn't in this listing's data room/);
    // The scan has three pages and the text file two, by its form feed.
    await refused({ documentId: room.docs.scan.id, page: "4" }, /past the end of that file, which has 3 pages/);
    await refused({ documentId: room.docs.payHistory.id, page: "3" }, /which has 2 pages/);
    for (const page of ["0", "-1", "1.5", "two"]) await refused({ documentId: room.docs.payHistory.id, page }, /whole number/);
    await refused({ documentId: room.docs.payHistory.id, quote: "x".repeat(QUOTE_MAX + 1) }, /300 characters/);
    // A page or a quote needs its file.
    await refused({ page: "2" }, /Choose the file/);

    const lastPage = await checkCitation(room.listing.id, { documentId: room.docs.scan.id, page: "3" });
    assert.deepEqual(lastPage, { ok: true, value: { citation: { documentId: room.docs.scan.id, page: 3, quote: null }, check: "none" } });
    // No file, no citation.
    assert.deepEqual(await checkCitation(room.listing.id, { documentId: "", page: "", quote: "" }), { ok: true, value: { citation: null, check: "none" } });
    // The answer form offers this listing's files and leaves out the signed NDA.
    const offered = (await citableDocuments(room.listing.id)).map((document) => document.originalName);
    assert.deepEqual(offered, ["pay-history.txt", "bpo-scan.pdf", "note.pdf"]);
  } finally {
    await room.cleanup();
  }
});

test("a quote is checked against the file's words whatever the spacing and case, and one the file doesn't hold is flagged and left off", async () => {
  assert.equal(quoteInText("Unpaid Principal Balance:\n$312,400.00", "unpaid principal   balance: $312,400.00"), true);
  assert.equal(quoteInText("Unpaid Principal Balance: $312,400.00", "UNPAIDPRINCIPAL BALANCE"), true);
  assert.equal(quoteInText("Unpaid Principal Balance: $312,400.00", "$999,999.00"), false);

  const room = await makeRoom();
  try {
    const found = await checkCitation(room.listing.id, { documentId: room.docs.payHistory.id, page: "2", quote: "  unpaid principal\n balance: $312,400.00 " });
    assert.ok(found.ok);
    assert.equal(found.value.check, "found");
    assert.deepEqual(found.value.citation, { documentId: room.docs.payHistory.id, page: 2, quote: "unpaid principal balance: $312,400.00" });

    // A PDF that draws its words is read the way the reader reads it.
    const inPdf = await checkCitation(room.listing.id, { documentId: room.docs.note.id, page: "1", quote: "Interest Rate: 5.875% per annum" });
    assert.ok(inPdf.ok);
    assert.equal(inPdf.value.check, "found");

    // Words the file doesn't hold never reach a bidder: the file and page stand, and the answerer is told.
    const missing = await checkCitation(room.listing.id, { documentId: room.docs.payHistory.id, page: "2", quote: "Unpaid Principal Balance: $999,999.00" });
    assert.ok(missing.ok);
    assert.equal(missing.value.check, "missing");
    assert.deepEqual(missing.value.citation, { documentId: room.docs.payHistory.id, page: 2, quote: null });
    assert.match(sourceLine(true, "missing"), /without its quote: UPB couldn't find those words in the file/);
    assert.match(sourceLine(true, "found"), /its quote is in the file/);
    assert.equal(sourceLine(false, "none"), "");
  } finally {
    await room.cleanup();
  }
});

test("a quote from a scan with no words is stored as written and marked not checked, and never holds the answer back", async () => {
  const room = await makeRoom();
  try {
    const question = await room.ask("What is the as-is value?");
    const answered = await answerQuestion(room.seller, {
      questionId: question.id,
      answer: "The BPO puts the as-is value at $640,000.",
      source: { documentId: room.docs.scan.id, page: "2", quote: "As-is value: $640,000" },
    });
    assert.ok(answered.ok);
    assert.equal(answered.value.cited, true);
    assert.equal(answered.value.check, "unchecked");
    assert.match(sourceLine(answered.value.cited, answered.value.check), /^The source is attached\. Quote not checked:/);
    const row = await prisma.listingQuestion.findUniqueOrThrow({ where: { id: question.id } });
    assert.equal(row.status, "ANSWERED");
    assert.deepEqual([row.answerSourceDocId, row.answerSourcePage, row.answerSourceQuote], [room.docs.scan.id, 2, "As-is value: $640,000"]);
    const logged = await prisma.auditEvent.findMany({ where: { entityId: room.listing.id, action: "QUESTION_SOURCE" } });
    assert.deepEqual(logged.map((event) => event.detail), [`${question.id} · ${room.docs.scan.id} · unchecked`]);
  } finally {
    await room.cleanup();
  }
});

test("an answer with no source still publishes, a refused source publishes nothing, and a source can be added once later", async () => {
  const room = await makeRoom();
  try {
    const plain = await room.ask("Is the borrower in a bankruptcy plan?");
    const answered = await answerQuestion(room.seller, { questionId: plain.id, answer: "No." });
    assert.ok(answered.ok);
    assert.deepEqual([answered.value.cited, answered.value.check], [false, "none"]);
    const row = await prisma.listingQuestion.findUniqueOrThrow({ where: { id: plain.id } });
    assert.equal(row.status, "ANSWERED");
    assert.equal(row.answerSourceDocId ?? null, null);
    // Empty source fields from the form are no source too.
    const blank = await room.ask("Any escrow shortage?");
    assert.ok((await answerQuestion(room.desk, { questionId: blank.id, answer: "None on file.", source: { documentId: "", page: "", quote: "" } })).ok);

    // A source that fails its check stops the publish before anything goes out.
    const bad = await room.ask("Is there a second page to the pay history?");
    const refused = await answerQuestion(room.seller, { questionId: bad.id, answer: "Yes.", source: { documentId: room.docs.elsewhere.id } });
    assert.equal(refused.ok, false);
    assert.equal((await prisma.listingQuestion.findUniqueOrThrow({ where: { id: bad.id } })).status, "OPEN");

    // The desk's count: answers out without a source.
    const queue = await prisma.listingQuestion.findMany({ where: { listingId: room.listing.id } });
    assert.deepEqual(uncited(queue).map((item) => item.id).sort(), [plain.id, blank.id].sort());

    // A buyer can't add one; the seller or desk can, once.
    assert.equal((await citeAnswer(room.pro, { questionId: plain.id, source: { documentId: room.docs.payHistory.id } })).ok, false);
    assert.equal((await citeAnswer(room.desk, { questionId: plain.id, source: { documentId: "" } })).ok, false);
    assert.equal((await citeAnswer(room.desk, { questionId: bad.id, source: { documentId: room.docs.payHistory.id } })).ok, false, "an open question has no answer to cite");
    const added = await citeAnswer(room.desk, { questionId: plain.id, source: { documentId: room.docs.payHistory.id, page: "1", quote: "Servicer: Sample Servicing" } });
    assert.deepEqual(added, { ok: true, value: { check: "found" } });
    const again = await citeAnswer(room.seller, { questionId: plain.id, source: { documentId: room.docs.scan.id } });
    assert.equal(again.ok, false);
    if (!again.ok) assert.match(again.error, /already names its source/);
    const cited = await prisma.listingQuestion.findUniqueOrThrow({ where: { id: plain.id } });
    assert.deepEqual([cited.answerSourceDocId, cited.answerSourcePage, cited.answerSourceQuote, cited.answer], [room.docs.payHistory.id, 1, "Servicer: Sample Servicing", "No."]);
    assert.deepEqual(uncited(await prisma.listingQuestion.findMany({ where: { listingId: room.listing.id } })).map((item) => item.id), [blank.id]);
  } finally {
    await room.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The reader's draft

test("taking the reader's draft fills the source from it, with the page the reader found it on", async () => {
  // A draft source's page survives storage; a page that isn't a whole number from 1 is dropped, and old drafts have none.
  assert.deepEqual(
    draftSources(JSON.stringify([{ documentId: "d1", name: "a.txt", quote: "Rate: 5%", page: 3 }, { documentId: "d2", name: "b.txt", quote: "Rate: 5%", page: 0 }, { documentId: "d3", name: "c.txt", quote: "Rate: 5%" }])),
    [{ documentId: "d1", name: "a.txt", quote: "Rate: 5%", page: 3 }, { documentId: "d2", name: "b.txt", quote: "Rate: 5%" }, { documentId: "d3", name: "c.txt", quote: "Rate: 5%" }],
  );

  const room = await makeRoom();
  try {
    const question = await room.ask("What is the unpaid principal balance?");
    const drafted = await draftAnswer(question.id, { reader: rulesReader(), mode: "SHADOW" });
    assert.ok(drafted.ok && drafted.value.drafted);
    const row = await prisma.listingQuestion.findUniqueOrThrow({ where: { id: question.id } });
    // The balance is on the pay history's second page, after the form feed.
    assert.deepEqual(draftSources(row.aiSources), [{ documentId: room.docs.payHistory.id, name: "pay-history.txt", quote: "Unpaid Principal Balance: $312,400.00", page: 2 }]);

    const documents = await citableDocuments(room.listing.id);
    const prefill = draftCitation(row.aiSources, documents);
    assert.deepEqual(prefill, { documentId: room.docs.payHistory.id, page: 2, quote: "Unpaid Principal Balance: $312,400.00" });
    // A draft whose file has left the room fills nothing.
    assert.equal(draftCitation(row.aiSources, documents.filter((document) => document.id !== room.docs.payHistory.id)), null);
    assert.equal(draftCitation(null, documents), null);

    // The prefilled source passes its own check when published.
    const answered = await answerQuestion(room.seller, {
      questionId: question.id,
      answer: row.aiDraft ?? "",
      source: { documentId: prefill!.documentId, page: String(prefill!.page), quote: prefill!.quote },
    });
    assert.ok(answered.ok);
    assert.equal(answered.value.check, "found");
  } finally {
    await room.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// What a bidder reads

test("a bidder the room opens the file to reads its name, page, quote and link; one it doesn't reads the kind of file and the page", async () => {
  const room = await makeRoom();
  try {
    const question = await room.ask("What is the current balance?");
    const answered = await answerQuestion(room.seller, {
      questionId: question.id,
      answer: "$312,400.00 as of the last payment.",
      source: { documentId: room.docs.payHistory.id, page: "2", quote: "Unpaid Principal Balance: $312,400.00" },
    });
    assert.ok(answered.ok);

    // A Pro bidder with the NDA opens the room's files, so the source links through the download route.
    const [forPro] = await publishedQuestions(room.listing.id, room.pro);
    assert.deepEqual(forPro.source, { name: "pay-history.txt", page: 2, quote: "Unpaid Principal Balance: $312,400.00", href: `/api/documents/${room.docs.payHistory.id}` });
    // The seller and the desk open everything.
    assert.equal((await publishedQuestions(room.listing.id, room.seller))[0].source?.href, `/api/documents/${room.docs.payHistory.id}`);
    assert.equal((await publishedQuestions(room.listing.id, room.desk))[0].source?.quote, "Unpaid Principal Balance: $312,400.00");

    // A free bidder reads the answer but can't open the file: no link, no quote, and not the file's own name.
    const [forFree] = await publishedQuestions(room.listing.id, room.free);
    assert.equal(forFree.answer, "$312,400.00 as of the last payment.");
    assert.deepEqual(forFree.source, { name: "Pay history", page: 2, quote: null, href: null });
    // The stored source never rides along on the row.
    for (const key of ["answerSourceDocId", "answerSourcePage", "answerSourceQuote"]) assert.ok(!(key in forFree), key);
    // Without a viewer, no source at all.
    assert.equal((await publishedQuestions(room.listing.id))[0].source, null);

    // A source that points off this listing shows nothing.
    await prisma.listingQuestion.update({ where: { id: question.id }, data: { answerSourceDocId: room.docs.elsewhere.id } });
    assert.equal((await publishedQuestions(room.listing.id, room.pro))[0].source, null);
  } finally {
    await room.cleanup();
  }
});
