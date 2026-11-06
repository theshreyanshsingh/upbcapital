import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoanFacts } from "../components/loan-file-view";
import { figureVisible } from "../lib/discrepancies";
import { fieldSpec, LOAN_FIELDS } from "../lib/loan-file";
import { normalizeTapeRows } from "../lib/tape";
import {
  IDENTITY_TERMS,
  SAMPLE_TAPE_ROWS,
  SERVICING_KEYS,
  TAPE_HEADERS,
  parseCreditScore,
  parseCreditScoreType,
  parseLossMitStage,
  parseMersMin,
  suggestMapping,
  termsExportColumns,
} from "../lib/tape-fields";
import { reviewTape } from "../lib/tape-quality";
import { noteSchema, servicingDraft } from "../lib/validators";

// The app compiles JSX with Next. Under tsx a component's JSX reads React from the global scope.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-11-05T12:00:00Z");
const MIN = "100012300000123456";

test("score models, loss mitigation stages and MERS MINs read from an allow-list", () => {
  assert.equal(parseCreditScoreType("FICO 8"), "FICO");
  assert.equal(parseCreditScoreType("Beacon 5.0"), "FICO");
  assert.equal(parseCreditScoreType("VantageScore 4.0"), "VANTAGE");
  assert.equal(parseCreditScoreType("VS4"), "VANTAGE");
  assert.equal(parseCreditScoreType("Other"), "OTHER");
  assert.equal(parseCreditScoreType("Experian"), null);
  assert.equal(parseCreditScoreType(""), null);

  assert.equal(parseLossMitStage("Request received"), "REQUESTED");
  assert.equal(parseLossMitStage("Application received"), "REQUESTED");
  assert.equal(parseLossMitStage("Options Offered"), "OPTIONS_OFFERED");
  assert.equal(parseLossMitStage("Trial plan"), "OPTIONS_OFFERED");
  assert.equal(parseLossMitStage("Decided"), "DECIDED");
  assert.equal(parseLossMitStage("Denied"), "DECIDED");
  // An outcome isn't a stage.
  assert.equal(parseLossMitStage("Forbearance"), null);
  assert.equal(parseLossMitStage("Not requested"), null);

  assert.equal(parseMersMin("1000123-0000012345-6"), MIN);
  assert.equal(parseMersMin(" 1000123 0000012345 6 "), MIN);
  assert.equal(parseMersMin("10001230000012345"), null);
  assert.equal(parseMersMin("1000123000001234567"), null);
  assert.equal(parseMersMin("MIN100012300000123"), null);

  assert.equal(parseCreditScore("712"), 712);
  assert.equal(parseCreditScore("712.0"), 712);
  assert.equal(parseCreditScore("712.5"), null);
  assert.equal(parseCreditScore("n/a"), null);
});

test("common servicer headers map to the v2.1 fields, and loss mit status is the stage", () => {
  const mapping = suggestMapping([
    "Loan #", "Index", "Margin", "Next Rate Change", "FICO", "Score Date", "Score Type", "MIN", "eNote", "Loss Mit Status", "Loss Mit",
    "Originating Platform", "Inherited Covenants", "NMLS ID",
  ]);
  assert.equal(mapping.loanNumber, "Loan #");
  assert.equal(mapping.armIndex, "Index");
  assert.equal(mapping.armMargin, "Margin");
  assert.equal(mapping.armNextReset, "Next Rate Change");
  assert.equal(mapping.creditScore, "FICO");
  assert.equal(mapping.creditScoreDate, "Score Date");
  assert.equal(mapping.creditScoreType, "Score Type");
  assert.equal(mapping.mersMin, "MIN");
  assert.equal(mapping.eNoteId, "eNote");
  assert.equal(mapping.lossMitStage, "Loss Mit Status");
  assert.equal(mapping.lossMitigation, "Loss Mit");
  assert.equal(mapping.originatingPlatform, "Originating Platform");
  assert.equal(mapping.inheritedCovenants, "Inherited Covenants");
  assert.equal(mapping.originatorLicense, "NMLS ID");
  // Every template header still maps to exactly one field, and every servicing key has a column.
  const template = suggestMapping(TAPE_HEADERS);
  assert.equal(Object.keys(template).length, TAPE_HEADERS.length);
  for (const key of SERVICING_KEYS) assert.ok(template[key], key);
  for (const row of SAMPLE_TAPE_ROWS) assert.equal(row.length, TAPE_HEADERS.length);
});

const base = { City: "Tampa", State: "FL", Type: "SFR", Lien: "First", Status: "Performing", UPB: "100000", Value: "150000", Rate: "6.5", Ask: "80000" };
const core = {
  city: "City",
  state: "State",
  propertyType: "Type",
  lienPosition: "Lien",
  paymentStatus: "Status",
  upb: "UPB",
  estimatedValue: "Value",
  interestRate: "Rate",
  askingPrice: "Ask",
} as const;
const mapping = {
  ...core,
  ...suggestMapping(["Index", "Margin", "Next Rate Change", "FICO", "Score Date", "MIN", "eNote", "Loss Mit Status", "Loss Mit", "Originating Platform", "Inherited Covenants", "NMLS ID"]),
};

test("the import stores the v2.1 terms and leaves off what it can't read", () => {
  const { loans, errors } = normalizeTapeRows({
    rows: [
      {
        ...base,
        Index: "30-day average SOFR",
        Margin: "2.750%",
        "Next Rate Change": "2027-03-01",
        FICO: "701",
        "Score Date": "2026-07-01",
        MIN: "1000123-0000012345-6",
        eNote: "EN-778-1",
        "Loss Mit Status": "Options offered",
        "Loss Mit": "Trial modification",
        "Originating Platform": "Sample Lending Platform",
        "Inherited Covenants": "Agency NPL sale terms: offer a loss mitigation waterfall before foreclosure.",
        "NMLS ID": "Jane Roe, NMLS 123456",
      },
      // A fraction margin, and values that can't be read.
      { ...base, Index: "3", Margin: "0.0325", FICO: "912", MIN: "12345", eNote: "Y", "Loss Mit Status": "Forbearance" },
      { ...base, MIN: "1.00012E+17", "Loss Mit Status": "Maybe", "Loss Mit": "Repayment plan" },
    ],
    mapping,
    priceMode: "COLUMN",
  });
  assert.deepEqual(errors, []);
  const [first, second, third] = loans;
  assert.equal(first.armIndex, "30-day average SOFR");
  assert.equal(first.armMargin, 2.75);
  assert.equal(first.armNextReset?.toISOString().slice(0, 10), "2027-03-01");
  assert.equal(first.creditScore, 701);
  // A column headed "FICO" names its own model.
  assert.equal(first.creditScoreType, "FICO");
  assert.equal(first.creditScoreDate?.toISOString().slice(0, 10), "2026-07-01");
  assert.equal(first.mersMin, MIN);
  assert.equal(first.eNoteId, "EN-778-1");
  assert.equal(first.lossMitStage, "OPTIONS_OFFERED");
  assert.equal(first.lossMitigation, "Trial modification");
  assert.equal(first.originatingPlatform, "Sample Lending Platform");
  assert.match(first.inheritedCovenants ?? "", /waterfall/);
  assert.equal(first.originatorLicense, "Jane Roe, NMLS 123456");

  assert.equal(second.armIndex, undefined);
  assert.equal(second.armMargin, 3.25);
  assert.equal(second.creditScore, undefined);
  assert.equal(second.creditScoreType, undefined);
  assert.equal(second.mersMin, undefined);
  assert.equal(second.eNoteId, undefined);
  // A status column's outcome is kept as the outcome when the tape has none.
  assert.equal(second.lossMitStage, undefined);
  assert.equal(second.lossMitigation, "Forbearance");

  assert.equal(third.mersMin, undefined);
  assert.equal(third.lossMitStage, undefined);
  assert.equal(third.lossMitigation, "Repayment plan");
});

test("the preview flags an ARM without its terms, a past reset, a stale or impossible score and a short MIN", () => {
  const rows = [
    // 2: a reset date alone says ARM, with neither index nor margin.
    { ...base, "Next Rate Change": "2027-06-01" },
    // 3: a margin without an index.
    { ...base, Margin: "2.5" },
    // 4: an index without a margin, and a reset already past.
    { ...base, Index: "1-year CMT", "Next Rate Change": "2026-01-01" },
    // 5: a score outside the range, and a MIN that isn't 18 digits.
    { ...base, FICO: "912", MIN: "1000123-00000123" },
    // 6: a score over a year old.
    { ...base, FICO: "640", "Score Date": "2025-06-01" },
    // 7: a clean ARM, score and MIN raise nothing.
    { ...base, Index: "30-day average SOFR", Margin: "2.75", "Next Rate Change": "2027-06-01", FICO: "700", "Score Date": "2026-09-01", MIN },
    // 8: a numeric "Index" is a row counter, and an eNote flag isn't an ID.
    { ...base, Index: "8", eNote: "Yes" },
  ];
  const flags = reviewTape(rows, mapping, NOW);
  const at = (row: number, field: string) => flags.filter((flag) => flag.row === row && flag.field === field && flag.level === "warn");
  assert.match(at(2, "armIndex")[0]?.message ?? "", /index and the margin are missing/);
  assert.match(at(3, "armIndex")[0]?.message ?? "", /the index is missing/);
  assert.match(at(4, "armMargin")[0]?.message ?? "", /the margin is missing/);
  assert.match(at(4, "armNextReset")[0]?.message ?? "", /2026-01-01, is in the past/);
  assert.match(at(5, "creditScore")[0]?.message ?? "", /outside 300–850/);
  assert.match(at(5, "mersMin")[0]?.message ?? "", /isn't 18 digits/);
  assert.match(at(6, "creditScoreDate")[0]?.message ?? "", /more than 12 months ago/);
  assert.deepEqual(flags.filter((flag) => flag.row === 7), []);
  assert.match(at(8, "armIndex")[0]?.message ?? "", /is a number/);
  assert.match(at(8, "eNoteId")[0]?.message ?? "", /yes or no/);

  // A score under a header that doesn't name its model asks for the model.
  const plain = reviewTape([{ ...base, "Credit Score": "700", "Score Date": "2026-09-01" }], { ...core, ...suggestMapping(["Credit Score", "Score Date"]) }, NOW);
  assert.ok(plain.some((flag) => flag.field === "creditScoreType" && flag.level === "warn"));
  // The template's own sample loans stay clean.
  const sample = SAMPLE_TAPE_ROWS.map((row) => Object.fromEntries(TAPE_HEADERS.map((header, index) => [header, row[index] ?? ""])));
  assert.deepEqual(reviewTape(sample, suggestMapping(TAPE_HEADERS), NOW).filter((flag) => flag.level !== "fix"), []);
});

test("the note wizard checks the v2.1 fields and round-trips them for an edit", () => {
  const note = { streetAddress: "1 Main St", city: "Tampa", state: "FL", zip: "33602", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", estimatedValue: "150000", lienPosition: "FIRST", upb: "100000", interestRate: "6", monthlyPi: "0", paymentStatus: "PERFORMING", monthsDelinquent: "0", askingPrice: "80000", foreclosureStatus: "NONE" };
  const bare = noteSchema.parse(note);
  for (const key of ["armIndex", "armMargin", "armNextReset", "creditScore", "creditScoreType", "creditScoreDate", "mersMin", "eNoteId", "lossMitStage", "originatorLicense"] as const) {
    assert.equal(bare[key], null, key);
  }
  const full = noteSchema.parse({
    ...note,
    armIndex: "30-day average SOFR",
    armMargin: "2.75",
    armNextReset: "2027-06-01",
    creditScore: "701",
    creditScoreType: "VANTAGE",
    creditScoreDate: "2026-09-01",
    mersMin: "1000123-0000012345-6",
    eNoteId: "EN-1",
    originatingPlatform: "Sample Lending Platform",
    lossMitStage: "DECIDED",
    inheritedCovenants: "None known beyond the note.",
    originatorLicense: "Licensed MLO, NMLS 123456",
  });
  assert.equal(full.armMargin, 2.75);
  assert.equal(full.creditScore, 701);
  assert.equal(full.creditScoreType, "VANTAGE");
  assert.equal(full.mersMin, MIN);
  assert.equal(full.lossMitStage, "DECIDED");
  const error = (patch: Record<string, string>) => noteSchema.safeParse({ ...note, ...patch }).error?.issues[0].message ?? "";
  assert.equal(error({ creditScore: "900" }), "Credit scores run from 300 to 850.");
  assert.equal(error({ creditScore: "701.5" }), "Credit scores run from 300 to 850.");
  assert.equal(error({ mersMin: "12345" }), "A MERS MIN is 18 digits.");
  assert.equal(error({ creditScoreDate: "2099-01-01" }), "The score date can't be in the future.");
  assert.equal(error({ armMargin: "lots" }), "Enter the margin as a percent, such as 2.75.");
  assert.equal(noteSchema.safeParse({ ...note, lossMitStage: "MAYBE" }).success, false);
  assert.equal(noteSchema.safeParse({ ...note, creditScoreType: "EXPERIAN" }).success, false);

  const draft = servicingDraft({ ...full, nextDueDate: null, modificationDate: null, lossMitigation: null, servicerName: null, bankruptcyFiledAt: null, foreclosureFiledAt: null, taxDelinquent: null });
  assert.equal(draft.armMargin, "2.75");
  assert.equal(draft.armNextReset, "2027-06-01");
  assert.equal(draft.creditScore, "701");
  assert.equal(draft.creditScoreType, "VANTAGE");
  assert.equal(draft.mersMin, MIN);
  assert.equal(draft.lossMitStage, "DECIDED");
  assert.equal(draft.originatorLicense, "Licensed MLO, NMLS 123456");
  // The draft parses back to the same record.
  assert.equal(noteSchema.parse({ ...note, ...draft }).mersMin, MIN);
});

test("the loan file badges the v2.1 fields, and registry IDs follow the street address", () => {
  for (const field of ["armIndex", "armMargin", "armNextReset", "creditScore", "creditScoreType", "creditScoreDate", "mersMin", "eNoteId", "originatingPlatform", "lossMitStage", "inheritedCovenants", "originatorLicense"]) {
    const spec = fieldSpec(field);
    assert.ok(spec, field);
    assert.equal(spec.optional, true, field);
  }
  for (const field of IDENTITY_TERMS) assert.equal(fieldSpec(field)?.identity, true, field);
  assert.equal(fieldSpec("creditScore")?.identity, undefined);
  assert.equal(fieldSpec("armMargin")?.pro, true);
  assert.equal(LOAN_FIELDS.filter((spec) => spec.field === "mersMin").length, 1);
  const mers = fieldSpec("mersMin")!;
  assert.equal(figureVisible(mers, { open: false, pro: true }), false);
  assert.equal(figureVisible(mers, { open: true, pro: false }), true);
});

const stored = {
  armIndex: "30-day average SOFR",
  armMargin: 2.75,
  armNextReset: new Date("2027-06-01T00:00:00Z"),
  creditScore: 701,
  creditScoreType: "FICO",
  creditScoreDate: new Date("2026-09-01T00:00:00Z"),
  mersMin: MIN,
  eNoteId: "EN-778-1",
  originatingPlatform: "Sample Lending Platform",
  lossMitStage: "DECIDED",
  inheritedCovenants: "",
  originatorLicense: "Jane Roe, NMLS 123456",
  servicerSource: "FCI",
  servicerSourcedAt: new Date("2026-11-04T00:00:00Z"),
};

test("the tape export withholds the MIN, eNote ID and license until the street is open", () => {
  const closed = termsExportColumns(stored, false);
  assert.equal(closed.mersMin, "");
  assert.equal(closed.eNoteId, "");
  assert.equal(closed.originatorLicense, "");
  // The terms that don't identify the loan export either way.
  assert.equal(closed.armIndex, "30-day average SOFR");
  assert.equal(closed.armMargin, 2.75);
  assert.equal(closed.armNextReset, "2027-06-01");
  assert.equal(closed.creditScore, 701);
  assert.equal(closed.lossMitStage, "DECIDED");
  assert.equal(closed.servicerReport, "FCI");
  assert.equal(closed.servicerReportDate, "2026-11-04");
  const open = termsExportColumns(stored, true);
  assert.equal(open.mersMin, MIN);
  assert.equal(open.eNoteId, "EN-778-1");
  assert.equal(open.originatorLicense, "Jane Roe, NMLS 123456");
  assert.deepEqual(termsExportColumns({}, true).mersMin, "");
});

test("the loan facts show the MIN only to a viewer who can open the loan", () => {
  const note = { id: "n1", state: "FL", propertyType: "SFR", lienPosition: "FIRST", verifiedFields: null, ...stored };
  const closed = renderToStaticMarkup(createElement(LoanFacts, { note, open: false, pro: true, withAddress: false }));
  assert.match(closed, /MERS MIN/);
  assert.match(closed, /eNote ID/);
  assert.match(closed, /Withheld until confidentiality/);
  assert.ok(!closed.includes(MIN));
  assert.ok(!closed.includes("EN-778-1"));
  assert.ok(!closed.includes("NMLS 123456"));
  assert.match(closed, /30-day average SOFR/);
  const open = renderToStaticMarkup(createElement(LoanFacts, { note, open: true, pro: true, withAddress: false }));
  assert.ok(open.includes(MIN));
  assert.ok(open.includes("EN-778-1"));
  // Without Pro, the margin is veiled like the note rate.
  const free = renderToStaticMarkup(createElement(LoanFacts, { note, open: true, pro: false, withAddress: false }));
  assert.ok(!free.includes("2.750%"));
  assert.ok(open.includes("2.750%"));
});
