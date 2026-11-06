import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldBadge } from "../components/loan-file-view";
import { answerDiscrepancy, changeLog } from "../lib/discrepancies";
import { completeness, completenessLine, fieldState, markFieldVerified, verifiedMap } from "../lib/loan-file";
import { prisma } from "../lib/prisma";
import {
  applyServicerReport,
  canImport,
  discrepancySource,
  matchReport,
  NO_MATCH,
  previewCookieValue,
  previewImport,
  readPreviewCookie,
  readServicerReport,
  servicerSource,
  type PreviewLoan,
} from "../lib/servicer-import";
import { uploadDir } from "../lib/storage";
import { parseTapeBuffer } from "../lib/tape";

// Files go to local disk and mail to the log, whatever the shared .env says.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "RESEND_API_KEY", "SMTP_HOST"]) process.env[key] = "";
process.env.RATE_LIMIT_STORE = "memory";
// The app compiles JSX with Next. Under tsx a component's JSX reads React from the global scope.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-11-06T15:00:00.000Z");
const FCI = servicerSource("FCI")!;
const TERRA = servicerSource("TERRA")!;

const csv = (rows: string[][]) => Buffer.from(rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n"));
const report = (rows: string[][]) => readServicerReport(parseTapeBuffer(csv(rows), "report.csv"));
const badge = (field: string, note: { verifiedFields?: unknown } & object, showValue = true) =>
  renderToStaticMarkup(createElement(FieldBadge, { field, state: fieldState(note, field), showValue }));

test("the source names a servicer or the holder's own software, and the staged preview cookie round-trips", () => {
  assert.deepEqual(FCI, { value: "FCI", name: "FCI", kind: "servicer" });
  assert.deepEqual(TERRA, { value: "TERRA", name: "Terra Notes", kind: "holder" });
  assert.equal(servicerSource("NOTESMITH")?.kind, "holder");
  assert.deepEqual(servicerSource("OTHER", "  Coastal   Loan Servicing "), { value: "OTHER", name: "Coastal Loan Servicing", kind: "servicer" });
  // A source the form doesn't offer, or "other" without a name, isn't a source.
  assert.equal(servicerSource("OTHER", ""), null);
  assert.equal(servicerSource("SHELLPOINT"), null);
  assert.equal(discrepancySource(FCI), "Servicer report (FCI)");
  assert.equal(discrepancySource(TERRA), "Holder's servicing software (Terra Notes)");
  assert.ok(discrepancySource(servicerSource("HOLDER_OTHER", "x".repeat(80))!).length <= 60);

  assert.equal(canImport({ id: "s1", role: "INSTITUTIONAL_SELLER" }, { sellerId: "s1" }), true);
  assert.equal(canImport({ id: "s2", role: "INSTITUTIONAL_SELLER" }, { sellerId: "s1" }), false);
  assert.equal(canImport({ id: "b1", role: "BUYER" }, { sellerId: "s1" }), false);
  assert.equal(canImport({ id: "d1", role: "ADMIN" }, { sellerId: "s1" }), true);
  assert.equal(canImport({ id: "", role: "INDIVIDUAL_SELLER" }, { sellerId: "" }), false);

  const token = crypto.randomUUID();
  const other = servicerSource("OTHER", "Coastal ~ Servicing")!;
  assert.deepEqual(readPreviewCookie(previewCookieValue({ listingId: "l1", token, source: other })), { listingId: "l1", token, source: other });
  assert.equal(readPreviewCookie("l1~not-a-token~FCI~FCI"), null);
  assert.equal(readPreviewCookie(`l1~${token}~NOPE~x`), null);
  assert.equal(readPreviewCookie(undefined), null);
});

const HEADERS = ["Loan #", "Property Address", "Property Zip", "Principal Balance", "Note Rate", "P&I", "Next Due Date", "Pay History", "FICO", "Score Date", "MIN", "Borrower"];

const loans: PreviewLoan[] = [
  { id: "a", streetAddress: "10 Oak Street", city: "Tampa", state: "FL", zip: "33602", loanNumber: "00012-345" },
  { id: "b", streetAddress: "22 Pine Ave", city: "Tampa", state: "FL", zip: "33603", loanNumber: null },
  { id: "c", streetAddress: "5 Elm Rd", city: "Tampa", state: "FL", zip: "33605", loanNumber: "LN-999" },
  { id: "d", streetAddress: "7 Bay Ct", city: "Tampa", state: "FL", zip: "33604", loanNumber: null },
  { id: "e", streetAddress: "7 Bay Court", city: "Tampa", state: "FL", zip: "33604", loanNumber: null },
];

test("rows match by loan number, fall back to street and ZIP, and say why the rest didn't", () => {
  const read = report([
    HEADERS,
    ["12345", "10 Oak St", "33602", "98,500.00", "6.500%", "700", "2026-12-01", "000000", "701", "2026-09-01", "1000123-0000012345-6", "Ana Ruiz"],
    ["", "22 Pine Avenue", "33603-1234", "50000", "7", "400", "2026-12-01", "", "", "", "", ""],
    ["77777", "1 Nowhere Ln", "33699", "1", "1", "1", "", "", "", "", "", ""],
    ["", "7 Bay Ct", "33604", "1", "1", "1", "", "", "", "", "", ""],
    ["0012345", "", "", "1", "1", "1", "", "", "", "", "", ""],
    ["", "", "", "1", "1", "1", "", "", "", "", "", ""],
  ]);
  // The borrower column isn't a servicing field, so it isn't read.
  assert.deepEqual(read.unused, ["Borrower"]);
  assert.deepEqual(read.columns.map((column) => column.field), ["loanNumber", "upb", "interestRate", "monthlyPi", "nextDueDate", "payString", "creditScore", "creditScoreDate", "mersMin"]);
  const { matches, misses, missing } = matchReport(loans, read.rows);
  // "12345" is the tape's "00012-345", and "22 Pine Avenue" with a ZIP+4 is "22 Pine Ave" in 33603.
  assert.deepEqual(matches.map((match) => [match.row.row, match.noteId, match.by]), [[2, "a", "loanNumber"], [3, "b", "street"]]);
  assert.deepEqual(misses.map((miss) => [miss.row.row, miss.reason]), [
    [4, "No loan on this listing has that loan number, or that street and ZIP."],
    [5, "Two loans on this listing share that street and ZIP."],
    [6, "Row 2 already matched this loan."],
    [7, "The row has no loan number, and no street and ZIP to match on."],
  ]);
  assert.deepEqual(missing, ["c", "d", "e"]);
});

test("the preview sorts each field into fill, agree, differ or held before anything is written", () => {
  const read = report([
    HEADERS,
    ["12345", "10 Oak St", "33602", "98500", "6.5%", "700", "2026-12-01", "000000", "701", "2026-09-01", "1000123-0000012345-6", ""],
    ["", "22 Pine Avenue", "33603", "50000", "7", "425", "", "", "", "", "", ""],
  ]);
  const tape: PreviewLoan[] = [
    { ...loans[0], upb: 100000, interestRate: 6.5, monthlyPi: 650, servicerName: "FCI Lender Services" } as PreviewLoan,
    { ...loans[1], upb: 50000, interestRate: 7, monthlyPi: 400 } as PreviewLoan,
  ];
  const prior = [
    { noteId: "a", field: "monthlyPi", status: "OPEN", tapeValue: "650", documentValue: "690" },
    { noteId: "b", field: "monthlyPi", status: "EXPLAINED", tapeValue: "400", documentValue: "425" },
  ];
  const preview = previewImport(tape, read, FCI, prior);
  const lines = (id: string) => Object.fromEntries(preview.loans.find((loan) => loan.noteId === id)!.lines.map((line) => [line.field, line.action]));
  assert.deepEqual(lines("a"), {
    loanNumber: "confirm",
    upb: "differ",
    interestRate: "confirm",
    monthlyPi: "held",
    nextDueDate: "fill",
    payString: "fill",
    creditScore: "fill",
    // A column headed "FICO" names the model.
    creditScoreType: "fill",
    creditScoreDate: "fill",
    mersMin: "fill",
  });
  // "FCI" from the chosen source fills a blank servicer, but never argues with "FCI Lender Services".
  assert.deepEqual(lines("b"), { upb: "confirm", interestRate: "confirm", monthlyPi: "held", servicerName: "fill" });
  const held = preview.loans.find((loan) => loan.noteId === "b")!.lines.find((line) => line.field === "monthlyPi")!;
  assert.equal(held.note, "The seller already explained this difference.");
  const upb = preview.loans[0].lines.find((line) => line.field === "upb")!;
  assert.deepEqual({ tape: upb.tape, report: upb.report }, { tape: "100000", report: "98500" });
  assert.deepEqual(preview.totals, { rows: 2, matched: 2, fill: 7, confirm: 4, differ: 1, held: 2 });
  assert.deepEqual(preview.missing, []);
  // A holder's software never fills the servicer's name: the holder services the loan itself.
  assert.equal(previewImport(tape, read, TERRA).loans[1].lines.some((line) => line.field === "servicerName"), false);
});

test("a servicer report reads stronger than seller-stated, and the holder's own software doesn't", () => {
  const at = "2026-11-06T15:00:00.000Z";
  const entry = (origin: string | undefined, source: string, value: string, document?: string) => ({ at, by: "u1", source, value, ...(document ? { document } : {}), ...(origin ? { origin } : {}) });
  const note = (upb: number, map: Record<string, unknown>) => ({ upb, lienPosition: "FIRST", verifiedFields: map });

  const servicer = note(98500, { upb: entry("servicer", "FCI", "98500") });
  assert.deepEqual(fieldState(servicer, "upb"), { state: "sourced", origin: "servicer", at: new Date(at), by: "u1", source: "FCI" });
  assert.match(badge("upb", servicer), /Servicer report · FCI · Nov 6, 2026/);
  assert.match(badge("upb", servicer), /text-link/);

  const holder = note(98500, { upb: entry("holder", "Terra Notes", "98500") });
  assert.match(badge("upb", holder), /Holder&#x27;s servicing software · Terra Notes · Nov 6, 2026/);
  // Same colour as seller-stated.
  assert.match(badge("upb", holder), /bg-muted text-muted-foreground/);

  const differs = note(100000, { upb: entry("servicer", "FCI", "100000", "98500") });
  assert.equal(fieldState(differs, "upb").state, "disputed");
  assert.match(badge("upb", differs), /Servicer report · FCI shows \$98,500 · read Nov 6, 2026/);
  assert.match(badge("upb", differs, false), /Differs from the servicer report · FCI/);
  // The seller takes the report's value, and the field reads as the report's.
  assert.equal(fieldState(note(98500, { upb: entry("servicer", "FCI", "100000", "98500") }), "upb").state, "sourced");
  // An edit after the import reads as the seller's again.
  assert.match(badge("upb", note(97000, { upb: entry("servicer", "FCI", "98500") })), /Seller-stated · changed after the servicer report of Nov 6, 2026/);
  // An origin that isn't one of the two is dropped, so the entry reads as the desk's.
  assert.equal(verifiedMap({ upb: entry("guess", "FCI", "98500") }).upb.origin, undefined);

  // A servicer report alone isn't a desk review, and it counts apart from desk-verified fields.
  const file = completeness(servicer, [], []);
  assert.equal(file.reviewed, false);
  assert.equal(file.sourced, 1);
  assert.equal(file.fields.verified, 0);
  assert.equal(completenessLine(file), "Not yet reviewed by the desk · 1 from a servicer report");
  assert.equal(completeness(holder, [], []).sourced, 0);
});

test("applying a report fills blanks, badges agreement, opens a question on each difference and keeps the file", async () => {
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const make = (name: string, role: "INSTITUTIONAL_SELLER" | "ADMIN") =>
    prisma.user.create({ data: { email: `servicer-${name}-${tag}@example.org`, name: `${name} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const [seller, desk] = await Promise.all([make("seller", "INSTITUTIONAL_SELLER"), make("desk", "ADMIN")]);
  const loan = (street: string, extra: Record<string, unknown>) => ({
    streetAddress: street, city: `Servicerville ${tag}`, state: "FL", zip: "33602", propertyType: "SFR" as const, occupancy: "OWNER_OCCUPIED" as const,
    lienPosition: "FIRST" as const, upb: 100000, interestRate: 6.5, monthlyPi: 650, paymentStatus: "PERFORMING" as const, monthsDelinquent: 0,
    askingPrice: 80000, estimatedValue: 150000, borrowerName: "Ana Ruiz", ...extra,
  });
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: "UNDER_REVIEW",
      title: `Servicer import ${tag}`,
      notes: {
        create: [
          loan(`10 ${tag} Oak Street`, { loanNumber: `00${tag.slice(-5)}-1` }),
          loan(`22 ${tag} Pine Ave`, { zip: "33603", upb: 50000, interestRate: 7, monthlyPi: 400 }),
          loan(`5 ${tag} Elm Rd`, { zip: "33605", loanNumber: `LN-${tag}` }),
        ],
      },
    },
    include: { notes: { orderBy: { streetAddress: "asc" } } },
  });
  const byStreet = (word: string) => listing.notes.find((note) => note.streetAddress.includes(word))!;
  const [oak, pine, elm] = [byStreet("Oak"), byStreet("Pine"), byStreet("Elm")];
  const noteIds = listing.notes.map((note) => note.id);
  const fciFile = csv([
    HEADERS,
    [`${tag.slice(-5)}-1`, `10 ${tag} Oak St`, "33602", "98500", "6.5", "650", "2026-12-01", "000000", "701", "2026-09-01", "1000123-0000012345-6", "Ana Ruiz"],
    ["", `22 ${tag} Pine Avenue`, "33603", "50000", "7", "400", "2026-12-01", "", "", "", "", ""],
    ["NO-SUCH-LOAN", "", "", "1", "1", "1", "", "", "", "", "", ""],
  ]);
  const storedFiles: string[] = [];
  try {
    // The desk checked Oak's rate against the note before the import. Its check stands over the report's badge.
    assert.ok((await markFieldVerified(desk.id, { noteId: oak.id, field: "interestRate", source: "Original note" })).ok);

    const applied = await applyServicerReport(seller.id, { listingId: listing.id, source: FCI, filename: "fci-export.csv", bytes: fciFile, now: NOW });
    assert.ok(applied.ok, applied.ok ? "" : applied.error);
    const result = applied.value;
    assert.deepEqual(
      { matched: result.matched, rows: result.rows, raised: result.raised, identified: result.identified },
      { matched: 2, rows: 3, raised: 1, identified: true },
    );

    const after = await prisma.note.findMany({ where: { id: { in: noteIds } } });
    const got = (id: string) => after.find((note) => note.id === id)!;
    const oakNow = got(oak.id);
    assert.equal(oakNow.servicerSource, "FCI");
    assert.equal(oakNow.servicerSourcedAt?.toISOString(), NOW.toISOString());
    assert.equal(oakNow.nextDueDate?.toISOString().slice(0, 10), "2026-12-01");
    assert.equal(oakNow.payString, "000000");
    assert.equal(oakNow.creditScore, 701);
    assert.equal(oakNow.creditScoreType, "FICO");
    assert.equal(oakNow.mersMin, "100012300000123456");
    assert.equal(oakNow.servicerName, "FCI");
    // The tape's UPB isn't overwritten: the difference is the seller's to answer.
    assert.equal(oakNow.upb, 100000);
    assert.deepEqual(fieldState(oakNow, "nextDueDate"), { state: "sourced", origin: "servicer", at: NOW, by: seller.id, source: "FCI" });
    assert.equal(fieldState(oakNow, "monthlyPi").state, "sourced");
    assert.equal(fieldState(oakNow, "interestRate").state, "verified");
    assert.equal(verifiedMap(oakNow.verifiedFields).interestRate.origin, undefined);
    const upbState = fieldState(oakNow, "upb");
    assert.ok(upbState.state === "disputed" && upbState.origin === "servicer" && upbState.document === "98500");
    // Pine matched by street, and its blank next due date is filled. Elm has no row, so it's untouched.
    assert.equal(got(pine.id).nextDueDate?.toISOString().slice(0, 10), "2026-12-01");
    assert.equal(got(pine.id).servicerSource, "FCI");
    assert.equal(fieldState(got(pine.id), "upb").state, "sourced");
    assert.equal(got(elm.id).servicerSource, null);
    assert.equal(got(elm.id).verifiedFields, null);

    // One question, on the field that differs, filed under the servicer's report.
    const opened = await prisma.fieldDiscrepancy.findMany({ where: { listingId: listing.id } });
    assert.deepEqual(
      opened.map((row) => ({ note: row.noteId, field: row.field, tape: row.tapeValue, document: row.documentValue, source: row.source, status: row.status })),
      [{ note: oak.id, field: "upb", tape: "100000", document: "98500", source: "Servicer report (FCI)", status: "OPEN" }],
    );
    const entries = changeLog(opened, { open: true, pro: true });
    assert.match(entries[0].text, /^UPB differs from the servicer report \(FCI\), which shows \$98,500 against the tape's \$100,000\./);

    // The file is kept with the listing's tapes, and the import is logged without its figures.
    const document = await prisma.document.findUniqueOrThrow({ where: { id: result.documentId } });
    storedFiles.push(document.storedName);
    assert.equal(document.type, "TAPE");
    assert.equal(document.originalName, "servicer-report-fci-export.csv");
    assert.equal(document.noteId, null);
    assert.ok((await fs.stat(path.join(uploadDir(), document.storedName))).size > 0);
    const [log] = await prisma.auditEvent.findMany({ where: { entityId: listing.id, action: "SERVICER_IMPORT" } });
    assert.ok(log && log.actorId === seller.id);
    assert.match(log.detail, /^FCI \(servicer\) · 2 of 3 rows matched · \d+ filled · \d+ confirmed · 1 differences raised/);
    assert.ok(!log.detail.includes("98500") && !log.detail.includes("Ana"));

    // The seller takes the servicer's value, and UPB reads as the report's.
    assert.ok((await answerDiscrepancy(seller.id, { id: opened[0].id, answer: "FIX" })).ok);
    const fixed = await prisma.note.findUniqueOrThrow({ where: { id: oak.id } });
    assert.equal(fixed.upb, 98500);
    assert.equal(fieldState(fixed, "upb").state, "sourced");

    // The same report again opens nothing new: the tape now agrees.
    const again = await applyServicerReport(seller.id, { listingId: listing.id, source: FCI, filename: "fci-export.csv", bytes: fciFile, now: NOW });
    assert.ok(again.ok && again.value.raised === 0 && again.value.filled === 0);
    storedFiles.push((await prisma.document.findUniqueOrThrow({ where: { id: again.value.documentId } })).storedName);
    assert.equal(await prisma.fieldDiscrepancy.count({ where: { listingId: listing.id } }), 1);

    // An explained difference isn't asked twice.
    const terraFile = csv([["Loan #", "Principal Balance", "FICO"], [`LN-${tag}`, "99000", "655"]]);
    const terra = await applyServicerReport(seller.id, { listingId: listing.id, source: TERRA, filename: "terra.csv", bytes: terraFile, now: NOW });
    assert.ok(terra.ok && terra.value.raised === 1);
    storedFiles.push((await prisma.document.findUniqueOrThrow({ where: { id: terra.value.documentId } })).storedName);
    const elmQuestion = await prisma.fieldDiscrepancy.findFirstOrThrow({ where: { noteId: elm.id, field: "upb" } });
    assert.equal(elmQuestion.source, "Holder's servicing software (Terra Notes)");
    // The holder's own software fills the score, badged as the holder's word.
    const elmNow = await prisma.note.findUniqueOrThrow({ where: { id: elm.id } });
    assert.equal(elmNow.creditScore, 655);
    assert.equal(elmNow.servicerSource, "Terra Notes");
    const scoreState = fieldState(elmNow, "creditScore");
    assert.ok(scoreState.state === "sourced" && scoreState.origin === "holder");
    assert.ok((await answerDiscrepancy(seller.id, { id: elmQuestion.id, answer: "EXPLAIN", note: "The holder's ledger is a month behind the tape." })).ok);
    const terraAgain = await applyServicerReport(seller.id, { listingId: listing.id, source: TERRA, filename: "terra.csv", bytes: terraFile, now: NOW });
    assert.ok(terraAgain.ok && terraAgain.value.raised === 0 && terraAgain.value.held === 1);
    storedFiles.push((await prisma.document.findUniqueOrThrow({ where: { id: terraAgain.value.documentId } })).storedName);

    // A file that matches nothing stores nothing, and a listing in contract can't be changed this way.
    const documents = await prisma.document.count({ where: { listingId: listing.id } });
    const stray = await applyServicerReport(seller.id, { listingId: listing.id, source: FCI, filename: "other.csv", bytes: csv([["Loan #"], ["NOPE-1"]]) });
    assert.deepEqual(stray, { ok: false, error: NO_MATCH });
    assert.equal(await prisma.document.count({ where: { listingId: listing.id } }), documents);
    await prisma.listing.update({ where: { id: listing.id }, data: { status: "PENDING" } });
    const closed = await applyServicerReport(desk.id, { listingId: listing.id, source: FCI, filename: "fci-export.csv", bytes: fciFile });
    assert.ok(!closed.ok && /in contract or closed/.test(closed.error));
  } finally {
    for (const name of storedFiles) await fs.unlink(path.join(uploadDir(), name)).catch(() => undefined);
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [listing.id, ...noteIds] } } });
    await prisma.notification.deleteMany({ where: { toEmail: { in: [seller.email, desk.email] } } });
    await prisma.fieldDiscrepancy.deleteMany({ where: { listingId: listing.id } });
    await prisma.document.deleteMany({ where: { listingId: listing.id } });
    await prisma.listingMatch.deleteMany({ where: { listingId: listing.id } });
    await prisma.note.deleteMany({ where: { listingId: listing.id } });
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.user.deleteMany({ where: { id: { in: [seller.id, desk.id] } } });
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
