import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoanFacts } from "../components/loan-file-view";
import { TapeRisks, PoolRisks, riskLines } from "../components/tape-risk";
import { answerDiscrepancy, noteValue, raiseDiscrepancy } from "../lib/discrepancies";
import { US_STATES } from "../lib/labels";
import { fieldSpec, fieldState, LOAN_FIELDS } from "../lib/loan-file";
import { mismoFor, mismoLoan, mismoTape, STANDARD_GROUPS, TAPE_STANDARD, WITHHELD_UNTIL_OPEN } from "../lib/mismo";
import { prisma } from "../lib/prisma";
import { applyServicerReport, MOVING_FIELDS, previewImport, readServicerReport, REPORT_FIELDS, servicerSource } from "../lib/servicer-import";
import { uploadDir } from "../lib/storage";
import { SOL_HEADLINE, SOL_TABLE, solExposure, statesWithoutFigures } from "../lib/statute-limits";
import { normalizeTapeRows, parseTapeBuffer } from "../lib/tape";
import {
  RISK_KEYS,
  SAMPLE_TAPE_ROWS,
  SERVICING_KEYS,
  TAPE_FIELDS,
  TAPE_HEADERS,
  parsePaymentType,
  riskExportColumns,
  suggestMapping,
} from "../lib/tape-fields";
import { combinedLtv, reviewTape } from "../lib/tape-quality";
import { currentLtv } from "../lib/underwriting";
import { noteSchema, servicingDraft } from "../lib/validators";

// The app compiles JSX with Next. Under tsx a component's JSX reads React from the global scope.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-11-05T12:00:00Z");
const day = (date: Date | null | undefined) => date?.toISOString().slice(0, 10);

const csv = (rows: string[][]) => Buffer.from(rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n"));

const CORE = ["City", "State", "Property Type", "Lien", "Payment Status", "UPB", "Value", "Rate", "Asking Price"];
const core = (lien = "First", upb = "100000", value = "150000") => ["Tampa", "FL", "SFR", lien, "Non-performing", upb, value, "6.5", "60000"];

test("payment types read from an allow-list, with the payment shape before the rate", () => {
  assert.equal(parsePaymentType("30-year fixed"), "FIXED");
  assert.equal(parsePaymentType("FRM"), "FIXED");
  assert.equal(parsePaymentType("5/1 ARM"), "ARM");
  assert.equal(parsePaymentType("Adjustable"), "ARM");
  assert.equal(parsePaymentType("IO"), "INTEREST_ONLY");
  assert.equal(parsePaymentType("Interest Only ARM"), "INTEREST_ONLY");
  assert.equal(parsePaymentType("Fixed IO"), "INTEREST_ONLY");
  assert.equal(parsePaymentType("Fixed balloon"), "BALLOON");
  assert.equal(parsePaymentType("Other"), "OTHER");
  // A word that only ends in io isn't interest-only.
  assert.equal(parsePaymentType("Portfolio"), null);
  assert.equal(parsePaymentType("Conventional"), null);
  assert.equal(parsePaymentType(""), null);
});

test("a CSV tape carries the v3 fields through common servicer headers, and leaves off what it can't read", () => {
  const headers = [
    ...CORE, "Original Loan Amount", "Escrow Balance", "Total Past Due", "Payoff", "Payoff Good Through", "Balloon Date", "Amortization Type",
    "1st Lien Balance", "SCRA", "Deceased", "Litigation", "Litigation Notes",
  ];
  const mapping = suggestMapping(headers);
  assert.equal(mapping.originalBalance, "Original Loan Amount");
  assert.equal(mapping.arrearsAmount, "Total Past Due");
  assert.equal(mapping.payoffAsOf, "Payoff Good Through");
  assert.equal(mapping.paymentType, "Amortization Type");
  assert.equal(mapping.seniorLienBalance, "1st Lien Balance");
  assert.equal(mapping.scraFlag, "SCRA");
  assert.equal(mapping.borrowerDeceased, "Deceased");
  assert.equal(mapping.litigationNote, "Litigation Notes");
  const matrix = parseTapeBuffer(
    csv([
      headers,
      [...core("Second", "60000", "300000"), "$75,000", "(1,240.50)", "8,410", "64,210.33", "2026-10-31", "2031-06-01", "Fixed balloon", "180,000", "Y", "No", "", "Quiet title suit, Hillsborough County"],
      // A payoff without its date, a type that isn't one, and flags that aren't yes or no.
      [...core(), "0", "", "-5", "90000", "", "", "Conventional", "", "Maybe", "N/A", "Yes", ""],
      // A balloon column holding a yes, and a payoff date without an amount.
      [...core(), "", "", "", "", "2026-10-01", "Yes", "", "", "", "", "", ""],
    ]),
    "tape.csv",
  );
  const { loans, errors } = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: "COLUMN" });
  assert.deepEqual(errors, []);
  const [first, second, third] = loans;
  assert.equal(first.originalBalance, 75000);
  // An escrow account the servicer advanced runs negative.
  assert.equal(first.escrowBalance, -1240.5);
  assert.equal(first.arrearsAmount, 8410);
  assert.equal(first.payoffAmount, 64210.33);
  assert.equal(day(first.payoffAsOf), "2026-10-31");
  assert.equal(day(first.balloonDate), "2031-06-01");
  assert.equal(first.paymentType, "BALLOON");
  assert.equal(first.seniorLienBalance, 180000);
  assert.equal(first.scraFlag, true);
  assert.equal(first.borrowerDeceased, false);
  // A litigation note answers the flag when the flag is blank.
  assert.equal(first.litigationFlag, true);
  assert.equal(first.litigationNote, "Quiet title suit, Hillsborough County");

  assert.equal(second.originalBalance, undefined);
  assert.equal(second.arrearsAmount, undefined);
  // A payoff is only a figure with its good-through date.
  assert.equal(second.payoffAmount, undefined);
  assert.equal(second.paymentType, undefined);
  assert.equal(second.scraFlag, undefined);
  assert.equal(second.borrowerDeceased, undefined);
  assert.equal(second.litigationFlag, true);

  assert.equal(third.payoffAsOf, undefined);
  assert.equal(third.balloonDate, undefined);
  assert.equal(third.paymentType, "BALLOON");

  const flags = reviewTape(matrix.rows, mapping, NOW);
  const at = (row: number, field: string) => flags.filter((flag) => flag.row === row && flag.field === field);
  assert.match(at(3, "payoffAmount")[0]?.message ?? "", /no good-through date/);
  assert.match(at(3, "originalBalance")[0]?.message ?? "", /isn.t above zero/);
  assert.match(at(3, "arrearsAmount")[0]?.message ?? "", /below zero/);
  assert.match(at(3, "paymentType")[0]?.message ?? "", /isn't fixed, ARM/);
  assert.match(at(3, "scraFlag")[0]?.message ?? "", /yes or no/);
  assert.match(at(4, "payoffAsOf")[0]?.message ?? "", /no payoff amount/);
  assert.equal(at(4, "balloonDate")[0]?.level, "fix");
});

test("the preview flags a low payoff, a stale quote, a balloon without its date, a past balloon and mismatched rate terms", () => {
  const headers = [...CORE, "Maturity", "Payoff", "Payoff Date", "Balloon Date", "Payment Type", "Index", "Margin", "Senior Lien Balance"];
  const mapping = suggestMapping(headers);
  const rows = [
    // 2: a payoff under the UPB, quoted more than 90 days ago.
    [...core(), "", "90000", "2026-06-01", "", "", "", "", ""],
    // 3: a balloon with no date.
    [...core(), "", "", "", "", "Balloon", "", "", ""],
    // 4: a balloon already past, and after the maturity date.
    [...core(), "2026-01-01", "", "", "2026-03-01", "", "", "", ""],
    // 5: an ARM with no terms.
    [...core(), "", "", "", "", "ARM", "", "", ""],
    // 6: a fixed rate with ARM terms, and a senior balance on a first lien.
    [...core(), "", "", "", "", "Fixed", "30-day average SOFR", "2.75", "50000"],
    // 7: a second lien whose combined LTV is over 100%.
    [...core("Second", "60000", "200000"), "", "", "", "", "", "", "", "150000"],
    // 8: a clean second lien raises nothing.
    [...core("2nd", "60000", "300000"), "", "101000", "2026-10-15", "", "Fixed", "", "", "150000"],
  ].map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
  const flags = reviewTape(rows, mapping, NOW).filter((flag) => flag.level === "warn");
  const at = (row: number, field: string) => flags.filter((flag) => flag.row === row && flag.field === field).map((flag) => flag.message).join(" | ");
  assert.match(at(2, "payoffAmount"), /less than the UPB/);
  assert.match(at(2, "payoffAsOf"), /more than 90 days ago/);
  assert.match(at(3, "balloonDate"), /balloon date is missing/);
  assert.match(at(4, "balloonDate"), /after the maturity date/);
  assert.match(at(4, "balloonDate"), /has passed/);
  assert.match(at(5, "paymentType"), /index and the margin are missing/);
  assert.match(at(6, "paymentType"), /carries ARM terms/);
  assert.match(at(6, "seniorLienBalance"), /first lien has nothing ahead/);
  assert.match(at(7, "ltv"), /Combined LTV is 105%/);
  assert.deepEqual(flags.filter((flag) => flag.row === 8), []);
});

test("a second lien's combined LTV uses the senior lien balance", () => {
  // 60,000 behind 150,000 on a 250,000 house.
  assert.equal(combinedLtv({ lien: "SECOND", upb: 60000, value: 250000, seniorLienBalance: 150000 }), 84);
  assert.equal(combinedLtv({ lien: "FIRST", upb: 60000, value: 250000, seniorLienBalance: 150000 }), null);
  assert.equal(combinedLtv({ lien: "Second", upb: 60000, value: 250000, seniorLienBalance: null }), null);
  // The pricing model reads the stored balance in place of its assumption.
  const stored = { upb: 60000, lienPosition: "SECOND", seniorLienBalance: 150000 };
  const known = currentLtv({ upb: stored.upb, lienPosition: stored.lienPosition, seniorBalance: stored.seniorLienBalance }, 250000);
  assert.deepEqual(known, { pct: 84, combined: true, seniorAssumed: false });
  const assumed = currentLtv({ upb: stored.upb, lienPosition: stored.lienPosition, seniorBalance: null }, 250000);
  assert.equal(assumed?.seniorAssumed, true);
  assert.notEqual(assumed?.pct, 84);
  // A first lien never adds a senior balance.
  assert.equal(currentLtv({ upb: 100000, lienPosition: "FIRST", seniorBalance: 50000 }, 200000)?.pct, 50);
});

const wizard = { streetAddress: "1 Main St", city: "Tampa", state: "FL", zip: "33602", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", estimatedValue: "250000", lienPosition: "SECOND", upb: "60000", interestRate: "8", monthlyPi: "500", paymentStatus: "NON_PERFORMING", monthsDelinquent: "6", askingPrice: "20000", foreclosureStatus: "NONE" };

test("the note wizard checks the v3 fields and round-trips them for an edit", () => {
  for (const key of RISK_KEYS) assert.ok((SERVICING_KEYS as readonly string[]).includes(key), key);
  assert.equal(RISK_KEYS.length, 12);
  const bare = noteSchema.parse(wizard);
  for (const key of RISK_KEYS) assert.equal(bare[key], null, key);
  const full = noteSchema.parse({
    ...wizard,
    originalBalance: "75000",
    escrowBalance: "-120.5",
    arrearsAmount: "4200",
    payoffAmount: "65000",
    payoffAsOf: "2026-11-30",
    balloonDate: "2031-06-01",
    paymentType: "BALLOON",
    seniorLienBalance: "150000",
    scraFlag: "true",
    borrowerDeceased: "false",
    litigationFlag: "true",
    litigationNote: "Contested foreclosure",
  });
  assert.equal(full.originalBalance, 75000);
  assert.equal(full.escrowBalance, -120.5);
  assert.equal(full.paymentType, "BALLOON");
  assert.equal(full.scraFlag, true);
  assert.equal(full.borrowerDeceased, false);
  assert.equal(day(full.payoffAsOf), "2026-11-30");
  const error = (patch: Record<string, string>) => noteSchema.safeParse({ ...wizard, ...patch }).error?.issues[0].message ?? "";
  assert.equal(error({ payoffAmount: "65000" }), "Give the date the payoff is good through.");
  assert.equal(error({ payoffAsOf: "2026-11-30" }), "Enter the payoff amount for that date.");
  assert.equal(error({ arrearsAmount: "-1" }), "Arrears can't be below zero.");
  assert.equal(error({ originalBalance: "0" }), "The original balance must be greater than zero.");
  assert.equal(error({ seniorLienBalance: "lots" }), "Enter the senior lien balance as an amount.");
  assert.equal(noteSchema.safeParse({ ...wizard, paymentType: "NEGAM" }).success, false);
  assert.equal(noteSchema.safeParse({ ...wizard, scraFlag: "maybe" }).success, false);

  const empty = Object.fromEntries(SERVICING_KEYS.map((key) => [key, null]));
  const draft = servicingDraft({ ...empty, ...full } as Parameters<typeof servicingDraft>[0]);
  assert.equal(draft.originalBalance, "75000");
  assert.equal(draft.escrowBalance, "-120.5");
  assert.equal(draft.payoffAsOf, "2026-11-30");
  assert.equal(draft.paymentType, "BALLOON");
  assert.equal(draft.scraFlag, "true");
  assert.equal(draft.borrowerDeceased, "false");
  assert.equal(draft.litigationNote, "Contested foreclosure");
  assert.equal(noteSchema.parse({ ...wizard, ...draft }).seniorLienBalance, 150000);
});

test("the statute of limitations flag counts from the first missed payment and the maturity date", () => {
  // Every state and DC has a row, and every figure carries its statute.
  assert.deepEqual(Object.keys(SOL_TABLE).sort(), [...US_STATES].sort());
  for (const [code, row] of Object.entries(SOL_TABLE)) {
    for (const rule of [row.note, ...(row.foreclosure ?? [])].filter((value) => value != null)) {
      assert.ok(rule.years > 0 && rule.years <= 20, code);
      assert.ok(rule.law.length > 8, code);
    }
  }

  // Florida: five years on a written instrument, from the first missed payment after the last one on 1 Jan 2020.
  const florida = solExposure({ state: "fl", lastPaidDate: "2020-01-01", maturityDate: "2049-01-01", now: NOW });
  assert.equal(florida.status, "PAST");
  assert.equal(florida.headline, SOL_HEADLINE);
  assert.equal(day(florida.defaultFrom), "2020-02-01");
  assert.equal(day(florida.date), "2025-02-01");
  assert.ok(florida.lines.some((line) => line.kind === "note" && line.law.includes("95.11(2)(b)")));
  assert.ok(florida.lines.some((line) => line.kind === "foreclosure" && line.from === "maturity" && day(line.date) === "2054-01-01"));
  assert.match(florida.summary, /may have run out about Feb 1, 2025/);
  assert.match(florida.caveat, /Not legal advice/);

  // Texas: four years, and inside the last twelve months. The next due date wins over the last paid date.
  const texas = solExposure({ state: "TX", lastPaidDate: "2022-06-01", nextDueDate: "2023-01-01", now: NOW });
  assert.equal(texas.status, "RUNNING_OUT");
  assert.equal(day(texas.date), "2027-01-01");

  // New Jersey: the earliest of six years from maturity and twenty from the default, and six on the contract.
  const jersey = solExposure({ state: "NJ", lastPaidDate: "2024-01-01", maturityDate: "2026-06-01", now: NOW });
  assert.equal(day(jersey.date), "2030-02-01");
  assert.equal(jersey.status, "OPEN");
  assert.equal(jersey.lines.find((line) => line.law.includes("(a)(1)"))?.date?.toISOString().slice(0, 10), "2032-06-01");

  // A state with no figure on file says to check with counsel, and invents nothing.
  assert.ok(statesWithoutFigures().includes("KY"));
  const kentucky = solExposure({ state: "KY", lastPaidDate: "2015-01-01", now: NOW });
  assert.equal(kentucky.status, "UNKNOWN");
  assert.equal(kentucky.date, null);
  assert.equal(kentucky.lines.length, 0);
  assert.match(kentucky.summary, /no limitation period on file for Kentucky/);
  assert.equal(kentucky.headline, "SOL exposure: check with counsel");

  // No dates to count from.
  const undated = solExposure({ state: "FL", now: NOW });
  assert.equal(undated.status, "UNKNOWN");
  assert.match(undated.summary, /no last paid date or maturity date/);
});

test("risk lines show SCRA, deceased and litigation flags, and the SOL line on a non-performing loan", () => {
  const npl = {
    state: "FL",
    paymentStatus: "NON_PERFORMING",
    lastPaidDate: new Date("2020-01-01T00:00:00Z"),
    maturityDate: new Date("2049-01-01T00:00:00Z"),
    scraFlag: true,
    borrowerDeceased: true,
    litigationFlag: true,
    litigationNote: "Ruiz v. Lender, Hillsborough County",
  };
  assert.deepEqual(riskLines(npl, false).map((line) => line.key), ["scra", "deceased", "litigation"]);
  const closed = renderToStaticMarkup(createElement(TapeRisks, { note: npl, open: false, now: NOW }));
  assert.match(closed, /SCRA protection/);
  assert.match(closed, /Borrower deceased/);
  assert.match(closed, /The details open with confidentiality/);
  assert.ok(!closed.includes("Ruiz v. Lender"));
  assert.match(closed, /SOL exposure: check with counsel/);
  assert.match(closed, /Feb 1, 2025/);
  assert.match(closed, /95\.11\(2\)\(b\)/);
  assert.match(closed, /Not legal advice/);
  const open = renderToStaticMarkup(createElement(TapeRisks, { note: npl, open: true, now: NOW }));
  assert.ok(open.includes("Ruiz v. Lender"));
  // A performing loan has no SOL line, and a clean one shows nothing.
  const performing = renderToStaticMarkup(createElement(TapeRisks, { note: { ...npl, paymentStatus: "PERFORMING" }, open: true, now: NOW }));
  assert.ok(!performing.includes("SOL exposure"));
  assert.match(performing, /SCRA protection/);
  assert.equal(renderToStaticMarkup(createElement(TapeRisks, { note: { state: "FL", paymentStatus: "PERFORMING" }, open: true, now: NOW })), "");
  const pool = renderToStaticMarkup(createElement(PoolRisks, { notes: [npl, { state: "KY", paymentStatus: "NON_PERFORMING" }, { state: "FL", paymentStatus: "PERFORMING" }], now: NOW }));
  assert.match(pool, /1 of 3 loans carry SCRA protection/);
  assert.match(pool, /2 non-performing loans, 1 where the time to sue may be running out or past/);
});

test("the loan facts badge the v3 fields: balances behind Pro, the litigation note behind confidentiality", () => {
  for (const key of RISK_KEYS) {
    const spec = fieldSpec(key);
    assert.ok(spec, key);
    assert.equal(spec.optional, true, key);
  }
  for (const key of ["originalBalance", "escrowBalance", "arrearsAmount", "payoffAmount", "seniorLienBalance"]) assert.equal(fieldSpec(key)?.pro, true, key);
  assert.equal(fieldSpec("litigationNote")?.identity, true);
  assert.equal(fieldSpec("scraFlag")?.identity, undefined);
  const note = {
    id: "n1", state: "FL", propertyType: "SFR", lienPosition: "SECOND", verifiedFields: null,
    seniorLienBalance: 183456, payoffAmount: 64210, payoffAsOf: new Date("2026-10-31T00:00:00Z"), paymentType: "BALLOON",
    scraFlag: true, litigationFlag: true, litigationNote: "Quiet title suit",
  };
  const free = renderToStaticMarkup(createElement(LoanFacts, { note, open: false, pro: false, withAddress: false }));
  assert.match(free, /Senior lien balance/);
  assert.ok(!free.includes("183,456"));
  assert.ok(!free.includes("Quiet title suit"));
  assert.match(free, /Balloon/);
  assert.match(free, /SCRA protection/);
  const pro = renderToStaticMarkup(createElement(LoanFacts, { note, open: true, pro: true, withAddress: false }));
  assert.ok(pro.includes("183,456"));
  assert.ok(pro.includes("Quiet title suit"));

  const columns = riskExportColumns({ ...note, borrowerDeceased: null }, false);
  assert.equal(columns.litigationNote, "");
  assert.equal(columns.seniorLienBalance, 183456);
  assert.equal(columns.payoffAsOf, "2026-10-31");
  assert.equal(columns.scra, "yes");
  assert.equal(columns.borrowerDeceased, "");
  assert.equal(riskExportColumns(note, true).litigationNote, "Quiet title suit");
});

test("every tape field has a MISMO mapping, and approximate ones say why", () => {
  const keys = TAPE_FIELDS.map((field) => field.key);
  for (const key of keys) {
    const entry = mismoFor(key);
    assert.ok(entry, `${key} has no MISMO mapping`);
    assert.ok(entry.name && entry.path.endsWith(entry.name), key);
    assert.ok(entry.path.startsWith("DEAL/"), key);
    if (entry.match !== "exact") assert.ok(entry.note && entry.note.length > 10, `${key} needs a note`);
  }
  assert.equal(TAPE_STANDARD.length, keys.length);
  // One path per field, so the JSON export's keys never collide.
  assert.equal(new Set(TAPE_STANDARD.map((field) => field.mismo.path)).size, TAPE_STANDARD.length);
  // The standard's headers are the template's, in order, and each maps back to its own field.
  assert.deepEqual(TAPE_STANDARD.map((field) => field.header), TAPE_HEADERS);
  const mapped = suggestMapping(TAPE_HEADERS);
  for (const field of TAPE_STANDARD) assert.equal(mapped[field.key], field.header, field.key);
  for (const field of TAPE_STANDARD) assert.ok(STANDARD_GROUPS.some((group) => group.group === field.group), field.key);
  // Anything the loan file keeps behind confidentiality stays out of a closed JSON export.
  for (const spec of LOAN_FIELDS.filter((row) => row.identity && keys.includes(row.field as never))) {
    assert.ok(WITHHELD_UNTIL_OPEN.has(spec.field as never), spec.field);
  }
  const loan = { streetAddress: "1 Main St", zip: "33602", city: "Tampa", upb: 60000, lienPosition: "SECOND", mersMin: "100012300000123456", litigationNote: "Suit", scraFlag: false, payoffAsOf: new Date("2026-10-31T00:00:00Z"), memo: "", avmValue: 1 };
  const closed = mismoLoan(loan, false);
  assert.equal(closed["DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/ADDRESS/CityName"], "Tampa");
  assert.equal(closed["DEAL/LOANS/LOAN/PAYMENT/PAYMENT_SUMMARY/UPBAmount"], 60000);
  assert.equal(closed["DEAL/LOANS/LOAN/TERMS_OF_LOAN/LienPriorityType"], "SECOND");
  assert.equal(closed["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/SCRAProtectionIndicator"], false);
  assert.equal(closed["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/PayoffGoodThroughDate"], "2026-10-31");
  for (const value of Object.values(closed)) assert.ok(!["1 Main St", "33602", "100012300000123456", "Suit"].includes(String(value)));
  // Fields that aren't on the tape, and blanks, stay out.
  assert.ok(!Object.keys(closed).some((key) => key.includes("avm") || key.endsWith("LoanNoteText")));
  const open = mismoLoan(loan, true);
  assert.equal(open["DEAL/LOANS/LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=MERS_MIN]/LoanIdentifier"], "100012300000123456");
  assert.equal(open["DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/ADDRESS/AddressLineText"], "1 Main St");
  const tape = mismoTape({ listingId: "l1", notes: [{ note: loan, open: false }], now: NOW });
  assert.match(tape.mapping, /Not MISMO-certified/);
  assert.equal(tape.loans.length, 1);
});

test("the template's headers are the standard's, and its fictional loans import clean", async () => {
  const { GET } = await import("../app/api/tapes/template/route");
  const body = await (await GET(new Request("http://localhost/api/tapes/template?format=csv"))).text();
  const [head, ...rows] = body.split("\n");
  assert.deepEqual(head.split(",").map((cell) => cell.replace(/^"|"$/g, "")), TAPE_HEADERS);
  assert.equal(rows.length, SAMPLE_TAPE_ROWS.length);
  for (const row of SAMPLE_TAPE_ROWS) assert.equal(row.length, TAPE_HEADERS.length);
  const matrix = parseTapeBuffer(Buffer.from(body), "template.csv");
  const mapping = suggestMapping(matrix.headers);
  const { loans, errors } = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: "COLUMN" });
  assert.deepEqual(errors, []);
  assert.equal(loans[1].seniorLienBalance, 212000);
  assert.equal(loans[1].litigationFlag, true);
  assert.equal(loans[2].paymentType, "ARM");
  assert.deepEqual(reviewTape(matrix.rows, mapping, NOW).filter((flag) => flag.level !== "fix"), []);
});

test("a servicer's export fills the v3 fields it carries", () => {
  const headers = ["Loan #", "Property Address", "Property Zip", "Original Balance", "Escrow Balance", "Payoff", "Payoff Date", "Payment Type", "SCRA", "Senior Lien Balance"];
  const rows = [["LN-1", "10 Oak St", "33602", "120000", "850.10", "99000", "2026-11-30", "Fixed", "No", "50000"]].map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  const report = readServicerReport({ headers, rows });
  const fields = report.columns.map((column) => column.field);
  for (const field of ["originalBalance", "escrowBalance", "payoffAmount", "payoffAsOf", "paymentType", "scraFlag"] as const) {
    assert.ok((REPORT_FIELDS as readonly string[]).includes(field), field);
    assert.ok(fields.includes(field), field);
  }
  // The senior lien comes from title work, not the servicer.
  assert.ok(!fields.includes("seniorLienBalance" as never));
  const preview = previewImport([{ id: "a", streetAddress: "10 Oak Street", city: "Tampa", state: "FL", zip: "33602", loanNumber: "LN-1" }], report, servicerSource("FCI")!);
  const lines = new Map(preview.loans[0].lines.map((line) => [line.field, line]));
  assert.equal(lines.get("originalBalance")?.action, "fill");
  assert.equal(lines.get("payoffAsOf")?.report, "2026-11-30");
  assert.equal(lines.get("paymentType")?.report, "FIXED");
  assert.equal(lines.get("scraFlag")?.report, "no");
});

const MOVING_HEADERS = ["Loan #", "Property Address", "Property Zip", "Payoff", "Payoff Date", "Escrow Balance", "Arrears"];
const movingReport = (loanNumber: string, street: string, payoff: string, payoffDate: string, escrow: string, arrears: string) =>
  readServicerReport({ headers: MOVING_HEADERS, rows: [Object.fromEntries(MOVING_HEADERS.map((header, index) => [header, [loanNumber, street, "33602", payoff, payoffDate, escrow, arrears][index]]))] });

test("a servicer's newer payoff, escrow and arrears replace the tape's without a question, unless the payoff date is the same", () => {
  assert.deepEqual([...MOVING_FIELDS].sort(), ["arrearsAmount", "escrowBalance", "payoffAmount", "payoffAsOf"]);
  const loan = {
    id: "a", streetAddress: "10 Oak Street", city: "Tampa", state: "FL", zip: "33602", loanNumber: "LN-1",
    payoffAmount: 64000, payoffAsOf: new Date("2026-10-01T00:00:00Z"), escrowBalance: 500, arrearsAmount: 3000,
  };
  const newer = previewImport([loan], movingReport("LN-1", "10 Oak St", "64500", "2026-11-01", "(120.50)", "3400"), servicerSource("FCI")!);
  const moving = (lines: { field: string; action: string }[]) => Object.fromEntries(lines.filter((line) => MOVING_FIELDS.has(line.field as never)).map((line) => [line.field, line.action]));
  const actions = moving(newer.loans[0].lines);
  assert.deepEqual(actions, { payoffAmount: "update", payoffAsOf: "update", escrowBalance: "update", arrearsAmount: "update" });
  assert.equal(newer.totals.update, 4);
  assert.equal(newer.totals.differ, 0);
  assert.equal(newer.loans[0].lines.find((line) => line.field === "escrowBalance")?.report, "-120.5");
  // Two payoffs for the same good-through date are a real difference.
  const sameDate = { ...loan, payoffAsOf: new Date("2026-11-01T00:00:00Z") };
  const same = previewImport([sameDate], movingReport("LN-1", "10 Oak St", "64500", "2026-11-01", "500", "3000"), servicerSource("FCI")!);
  const sameActions = moving(same.loans[0].lines);
  assert.deepEqual(sameActions, { payoffAmount: "differ", payoffAsOf: "confirm", escrowBalance: "confirm", arrearsAmount: "confirm" });
});

test("a negative escrow balance can be written back through a fix", () => {
  assert.deepEqual(noteValue(fieldSpec("escrowBalance")!, "-250.75"), { ok: true, value: -250.75 });
  assert.equal(noteValue(fieldSpec("arrearsAmount")!, "-1").ok, false);
  assert.equal(noteValue(fieldSpec("upb")!, "-1").ok, false);
});

test("applying a report updates the moving balances as servicer-sourced, and a seller's fix writes a negative escrow", async () => {
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const make = (name: string, role: "INDIVIDUAL_SELLER" | "ADMIN") =>
    prisma.user.create({ data: { email: `d-tape-${name}-${tag}@example.org`, name: `${name} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const [seller, desk] = await Promise.all([make("seller", "INDIVIDUAL_SELLER"), make("desk", "ADMIN")]);
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "UNDER_REVIEW",
      title: `Tape v3 import ${tag}`,
      notes: {
        create: [{
          streetAddress: `10 ${tag} Oak Street`, city: `Tapeville ${tag}`, state: "FL", zip: "33602", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST", upb: 60000, interestRate: 7, monthlyPi: 500, paymentStatus: "NON_PERFORMING", monthsDelinquent: 6, askingPrice: 30000,
          estimatedValue: 150000, loanNumber: `LN-${tag}`, payoffAmount: 64000, payoffAsOf: new Date("2026-10-01T00:00:00Z"), escrowBalance: 500, arrearsAmount: 3000,
        }],
      },
    },
    include: { notes: true },
  });
  const note = listing.notes[0];
  const NOVEMBER = new Date("2026-11-06T15:00:00.000Z");
  const file = (payoff: string, date: string, escrow: string, arrears: string) =>
    csv([MOVING_HEADERS, [`LN-${tag}`, `10 ${tag} Oak St`, "33602", payoff, date, escrow, arrears]]);
  try {
    const applied = await applyServicerReport(seller.id, { listingId: listing.id, source: servicerSource("FCI")!, filename: "fci.csv", bytes: file("64500", "2026-11-01", "(120.50)", "3400"), now: NOVEMBER });
    assert.ok(applied.ok, applied.ok ? "" : applied.error);
    assert.deepEqual({ updated: applied.value.updated, raised: applied.value.raised }, { updated: 4, raised: 0 });
    const after = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
    assert.equal(after.payoffAmount, 64500);
    assert.equal(day(after.payoffAsOf), "2026-11-01");
    assert.equal(after.escrowBalance, -120.5);
    assert.equal(after.arrearsAmount, 3400);
    for (const field of MOVING_FIELDS) {
      assert.deepEqual(fieldState(after, field), { state: "sourced", origin: "servicer", at: NOVEMBER, by: seller.id, source: "FCI" }, field);
    }
    assert.equal(await prisma.fieldDiscrepancy.count({ where: { listingId: listing.id } }), 0);

    // A second report for the same good-through date with another payoff opens one question, on the payoff only.
    const again = await applyServicerReport(seller.id, { listingId: listing.id, source: servicerSource("FCI")!, filename: "fci-2.csv", bytes: file("64900", "2026-11-01", "(120.50)", "3400"), now: NOVEMBER });
    assert.ok(again.ok, again.ok ? "" : again.error);
    assert.equal(again.value.raised, 1);
    const questions = await prisma.fieldDiscrepancy.findMany({ where: { listingId: listing.id } });
    assert.deepEqual(questions.map((row) => row.field), ["payoffAmount"]);
    assert.equal((await prisma.note.findUniqueOrThrow({ where: { id: note.id } })).payoffAmount, 64500);

    // The escrow analysis shows a deeper advance, and the seller's fix writes it back below zero.
    const raised = await raiseDiscrepancy(desk.id, { noteId: note.id, field: "escrowBalance", document: "-250.75", source: "Escrow analysis" });
    assert.ok(raised.ok, raised.ok ? "" : raised.error);
    const fixed = await answerDiscrepancy(seller.id, { id: raised.value.id, answer: "FIX" });
    assert.ok(fixed.ok, fixed.ok ? "" : fixed.error);
    assert.equal((await prisma.note.findUniqueOrThrow({ where: { id: note.id } })).escrowBalance, -250.75);
  } finally {
    const documents = await prisma.document.findMany({ where: { listingId: listing.id }, select: { storedName: true } });
    for (const row of documents) await fs.unlink(path.join(uploadDir(), row.storedName)).catch(() => undefined);
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [listing.id, note.id] } } });
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
