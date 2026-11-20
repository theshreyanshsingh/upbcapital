import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Prisma } from "@prisma/client";
import { GET as getListing } from "../app/api/v1/listings/[id]/route";
import { GET as getListings } from "../app/api/v1/listings/route";
import { LoanFacts } from "../components/loan-file-view";
import { CraBadge, CraFacts } from "../components/tape-risk";
import { BUYER_SCOPES, hashKey, mintKey } from "../lib/api-keys";
import { loanFacts } from "../lib/buyer-api";
import {
  CENSUS_TRACT_MESSAGE,
  CRA_CAVEAT,
  craBadgeText,
  craCount,
  craEligible,
  FFIEC_GEOCODER_URL,
  ffiecGeocoderLink,
  parseCensusTract,
  parseLmiBorrower,
  parseTractIncomeLevel,
} from "../lib/cra";
import {
  appliedChips,
  bookMatches,
  fileFiltersActive,
  filtersFromSaved,
  filtersQuery,
  listingMatches,
  parseFilters,
  type MatchNote,
} from "../lib/filters";
import { canonical, fieldSpec, sameReading, VERIFY_SOURCES } from "../lib/loan-file";
import { craFit, criteriaFrom, rescoreListing, scoreBox, scoreMatch, type ProgramNote } from "../lib/matching";
import { mismoLoan, STANDARD_GROUPS, TAPE_STANDARD, WITHHELD_UNTIL_OPEN } from "../lib/mismo";
import { prisma } from "../lib/prisma";
import { sendSearchRoundup } from "../lib/search-alerts";
import { readServicerReport, REPORT_FIELDS } from "../lib/servicer-import";
import { normalizeTapeRows, parseTapeBuffer, readServicing } from "../lib/tape";
import { RISK_KEYS, riskExportColumns, SERVICING_KEYS, suggestMapping, TAPE_HEADERS } from "../lib/tape-fields";
import { reviewTape } from "../lib/tape-quality";
import { noteSchema, servicingDraft } from "../lib/validators";

// The app compiles JSX with Next. Under tsx a component's JSX reads React from the global scope.
(globalThis as { React?: typeof React }).React = React;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-20T12:00:00Z");
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], listings: [] as string[], tokens: [] as string[], boxes: [] as string[], searches: [] as string[] };
// A city and a two-letter code nobody else's fixtures use, so the API, the roundup and the box see only this file's paper.
const CITY = `Craville ${tag}`;
const STATE = "ZC";

const csv = (rows: string[][]) => Buffer.from(rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n"));

test.after(async () => {
  const ids = made.listings;
  await prisma.listingMatch.deleteMany({ where: { OR: [{ listingId: { in: ids } }, { buyBoxId: { in: made.boxes } }] } });
  await prisma.buyBox.deleteMany({ where: { id: { in: made.boxes } } });
  await prisma.savedSearch.deleteMany({ where: { id: { in: made.searches } } });
  await prisma.listingView.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.apiCall.deleteMany({ where: { userId: { in: made.users } } }).catch(() => null);
  if (made.tokens.length) await prisma.rateWindow.deleteMany({ where: { OR: made.tokens.map((token) => ({ key: { startsWith: `api:${hashKey(token).slice(0, 32)}` } })) } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...made.users] } }, { actorId: { in: made.users } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ subject: { contains: tag } }, { body: { contains: tag } }, { toEmail: { contains: tag } }] } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER") {
  const user = await prisma.user.create({
    data: {
      email: `cra-${who}-${tag}@example.org`,
      name: `CRA ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
    },
  });
  made.users.push(user.id);
  return user;
}

let street = 0;
function loan(data: Record<string, unknown> = {}) {
  street += 1;
  return {
    streetAddress: `${street} Tract Way ${tag}`, city: CITY, state: STATE, zip: "99878", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: 80000, estimatedValue: 200000, borrowerName: `Borrower ${tag}`, ...data,
  };
}

async function listing(sellerId: string, loans: Record<string, unknown>[], data: Partial<Prisma.ListingUncheckedCreateInput> = {}) {
  const row = await prisma.listing.create({
    data: {
      kind: loans.length > 1 ? "POOL" : "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 2 * HOUR),
      standingBidsNotifiedAt: new Date(),
      title: `CRA listing ${tag} ${made.listings.length}`,
      summary: "A test listing.",
      notes: { create: loans as never },
      ...data,
    },
  });
  made.listings.push(row.id);
  return row;
}

async function key(userId: string) {
  await prisma.buyerProfile.create({ data: { userId, status: "APPROVED" } });
  const minted = mintKey();
  await prisma.apiKey.create({ data: { userId, name: `Key ${tag}`, prefix: minted.prefix, hash: minted.hash, scopes: BUYER_SCOPES.join(",") } });
  made.tokens.push(minted.token);
  return minted.token;
}

function call(handler: (request: Request, context: never) => Promise<Response>, path: string, token: string, params?: Record<string, string>) {
  const request = new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
  return handler(request, (params ? { params: Promise.resolve(params) } : undefined) as never);
}

// ---------------------------------------------------------------------------------------------------------------
// The tape fields.

test("the CRA fields read from common headers, and the template's own headers map back", () => {
  const long = suggestMapping(["Census Tract", "Tract Income Level", "LMI Borrower"]);
  assert.equal(long.censusTract, "Census Tract");
  assert.equal(long.tractIncomeLevel, "Tract Income Level");
  assert.equal(long.lmiBorrower, "LMI Borrower");
  const short = suggestMapping(["Tract", "Income Level", "LMI"]);
  assert.equal(short.censusTract, "Tract");
  assert.equal(short.tractIncomeLevel, "Income Level");
  assert.equal(short.lmiBorrower, "LMI");
  const other = suggestMapping(["FIPS", "Low-Mod Borrower"]);
  assert.equal(other.censusTract, "FIPS");
  assert.equal(other.lmiBorrower, "Low-Mod Borrower");
  for (const header of ["census_tract", "tract_income_level", "lmi_borrower"]) assert.ok(TAPE_HEADERS.includes(header), header);
  // The aliases leave last batch's headers where they were.
  const mixed = suggestMapping(["Loan Type", "Partial Claim", "SCRA", "Census Tract"]);
  assert.equal(mixed.loanProgram, "Loan Type");
  assert.equal(mixed.partialClaim, "Partial Claim");
  assert.equal(mixed.scraFlag, "SCRA");
});

test("a census tract in any of the usual layouts becomes 11 digits", () => {
  for (const raw of ["12086.0105", "12-086-010500", "12086010500", " 12086010500 ", "12 086 010500", "12-086-0105.00", "12086.0105.00", "12086-010500"]) {
    assert.equal(parseCensusTract(raw), "12086010500", raw);
  }
  assert.equal(parseCensusTract("12086.010501"), "12086010501");
  assert.equal(parseCensusTract("12086.0105.01"), "12086010501");
  // A spreadsheet drops the leading zero of a state below 10.
  assert.equal(parseCensusTract("1073010500"), "01073010500");
  assert.equal(parseCensusTract("1073.0105"), "01073010500");
  assert.equal(parseCensusTract("1-73-105"), "01073010500");
  // What can't be a whole tract is refused.
  for (const raw of ["", "0105.00", "1234.56", "12086.01", "12086", "120860105001", "1.2086E+10", "ABC", "00086010500", "12000010500", "12086000000", "12086.01050"]) {
    assert.equal(parseCensusTract(raw), null, raw);
  }
});

test("income levels read as words and the FFIEC codes, and the LMI flag reads yes or no", () => {
  for (const raw of ["Low", "LOW", "low income", "1"]) assert.equal(parseTractIncomeLevel(raw), "LOW", raw);
  for (const raw of ["Moderate", "Mod", "Moderate income", "2"]) assert.equal(parseTractIncomeLevel(raw), "MODERATE", raw);
  for (const raw of ["Middle", "Mid", "Middle income", "3", "Distressed middle"]) assert.equal(parseTractIncomeLevel(raw), "MIDDLE", raw);
  for (const raw of ["Upper", "Upper income", "High", "4"]) assert.equal(parseTractIncomeLevel(raw), "UPPER", raw);
  for (const raw of ["Unknown", "Not known", "0"]) assert.equal(parseTractIncomeLevel(raw), "UNKNOWN", raw);
  // "LMI" or "low-mod" says low or moderate without saying which.
  for (const raw of ["LMI", "Low-Mod", "Low/Moderate", "", "5", "Rural"]) assert.equal(parseTractIncomeLevel(raw), null, raw);

  for (const raw of ["Y", "Yes", "true", "1", "LMI", "Low-mod"]) assert.equal(parseLmiBorrower(raw), true, raw);
  for (const raw of ["N", "No", "false", "0", "Non-LMI", "Middle"]) assert.equal(parseLmiBorrower(raw), false, raw);
  for (const raw of ["", "maybe", "80%"]) assert.equal(parseLmiBorrower(raw), null, raw);
});

test("craEligible gives its reasons, and only low or moderate tracts and LMI borrowers count", () => {
  assert.deepEqual(craEligible({ tractIncomeLevel: "LOW" }), { eligible: true, reasons: ["LMI tract"] });
  assert.deepEqual(craEligible({ tractIncomeLevel: "MODERATE", lmiBorrower: false }), { eligible: true, reasons: ["LMI tract"] });
  assert.deepEqual(craEligible({ tractIncomeLevel: "UPPER", lmiBorrower: true }), { eligible: true, reasons: ["LMI borrower"] });
  assert.deepEqual(craEligible({ tractIncomeLevel: "LOW", lmiBorrower: true }), { eligible: true, reasons: ["LMI tract", "LMI borrower"] });
  for (const note of [{}, { tractIncomeLevel: "MIDDLE" }, { tractIncomeLevel: "UNKNOWN", lmiBorrower: false }, { tractIncomeLevel: null, lmiBorrower: null }]) {
    assert.deepEqual(craEligible(note), { eligible: false, reasons: [] }, JSON.stringify(note));
  }
  assert.equal(craBadgeText("SINGLE", [{ tractIncomeLevel: "LOW", lmiBorrower: true }]), "LMI tract and LMI borrower");
  assert.equal(craBadgeText("SINGLE", [{ tractIncomeLevel: "MIDDLE" }]), null);
  const pool = [
    ...Array.from({ length: 4 }, () => ({ tractIncomeLevel: "MODERATE" })),
    { tractIncomeLevel: "UPPER", lmiBorrower: true },
    { tractIncomeLevel: "LOW", lmiBorrower: true },
    ...Array.from({ length: 10 }, () => ({ tractIncomeLevel: "MIDDLE" })),
  ];
  assert.equal(craBadgeText("POOL", pool), "6 of 16 loans CRA-eligible");
  assert.deepEqual(craCount(pool), { eligible: 6, total: 16, tract: 5, borrower: 2, reasons: [] });
  // The caution says whose call it is, including under the 2023 rule.
  assert.match(CRA_CAVEAT, /UPB's reading/);
  assert.match(CRA_CAVEAT, /CRA officer and your regulator decide/);
  assert.match(CRA_CAVEAT, /2023 CRA rule/);
});

const HEADERS = ["City", "State", "Property Type", "Lien", "Payment Status", "UPB", "Value", "Rate", "Asking Price", "Census Tract", "Income Level", "LMI"];
const ROWS = [
  ["Tampa", "FL", "SFR", "First", "Performing", "180000", "260000", "3.25", "150000", "12057.0105", "Moderate income", "No"],
  ["Ocala", "FL", "SFR", "First", "Performing", "150000", "220000", "3.5", "120000", "12-083-000200", "1", "Y"],
  ["Macon", "GA", "SFR", "First", "Performing", "120000", "180000", "4", "100000", "13021010800", "Upper", "Non-LMI"],
  ["Akron", "OH", "SFR", "First", "Performing", "90000", "140000", "5", "80000", "Akron", "Unknown", ""],
  ["Tulsa", "OK", "SFR", "First", "Performing", "80000", "120000", "5", "70000", "", "LMI", "maybe"],
];

test("a tape row's CRA facts land on the note, and what can't be read is left off with a warning", async () => {
  const matrix = parseTapeBuffer(csv([HEADERS, ...ROWS]), "tape.csv");
  const mapping = suggestMapping(matrix.headers);
  const { loans, errors } = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: "COLUMN" });
  assert.deepEqual(errors, []);
  assert.equal(loans[0].censusTract, "12057010500");
  assert.equal(loans[0].tractIncomeLevel, "MODERATE");
  assert.equal(loans[0].lmiBorrower, false);
  assert.equal(loans[1].censusTract, "12083000200");
  assert.equal(loans[1].tractIncomeLevel, "LOW");
  assert.equal(loans[1].lmiBorrower, true);
  assert.equal(loans[2].tractIncomeLevel, "UPPER");
  assert.equal(loans[2].lmiBorrower, false);
  // "Unknown" is the FFIEC file's own level, so it is kept; a tract that isn't one is left off.
  assert.equal(loans[3].censusTract, undefined);
  assert.equal(loans[3].tractIncomeLevel, "UNKNOWN");
  assert.equal(loans[3].lmiBorrower, undefined);
  assert.equal(loans[4].tractIncomeLevel, undefined);
  assert.equal(loans[4].lmiBorrower, undefined);

  const flags = reviewTape(matrix.rows, mapping, NOW);
  assert.ok(flags.some((flag) => flag.row === 2 && flag.field === "censusTract" && flag.level === "fix" && /stored as 12057010500/.test(flag.message)));
  assert.ok(flags.some((flag) => flag.row === 5 && flag.field === "censusTract" && flag.level === "warn"));
  assert.ok(flags.some((flag) => flag.row === 6 && flag.field === "tractIncomeLevel" && flag.level === "warn"));
  assert.ok(flags.some((flag) => flag.row === 6 && flag.field === "lmiBorrower" && flag.level === "warn"));
  assert.deepEqual(readServicing(matrix.rows[2], mapping).notes.map((note) => note.field), []);
  // A rounded tract can't be recovered.
  const rounded = readServicing({ "Census Tract": "1.20571E+10" }, { censusTract: "Census Tract" });
  assert.equal(rounded.record.censusTract, undefined);
  assert.match(rounded.notes[0].message, /rounded by a spreadsheet/);

  // Stored as the tape upload stores a tape: the normalised loans, as the listing's notes.
  const seller = await person("tape", "INSTITUTIONAL_SELLER");
  const row = await prisma.listing.create({
    data: { kind: "POOL", sellerId: seller.id, status: "SUBMITTED", title: `CRA tape ${tag}`, summary: "", notes: { create: loans } },
    include: { notes: true },
  });
  made.listings.push(row.id);
  const stored = row.notes.find((note) => note.city === "Ocala")!;
  assert.equal(stored.censusTract, "12083000200");
  assert.equal(stored.tractIncomeLevel, "LOW");
  assert.equal(stored.lmiBorrower, true);
  const tulsa = row.notes.find((note) => note.city === "Tulsa")!;
  assert.equal(tulsa.censusTract, null);
  assert.equal(tulsa.tractIncomeLevel, null);
  assert.equal(tulsa.lmiBorrower, null);

  // The tape export carries them, closed or open: a tract isn't an identity field.
  const columns = riskExportColumns(stored, false);
  assert.equal(columns.censusTract, "12083000200");
  assert.equal(columns.tractIncomeLevel, "LOW");
  assert.equal(columns.lmiBorrower, "yes");
  assert.equal(riskExportColumns(tulsa, false).lmiBorrower, "");
  const back = suggestMapping(Object.keys(columns));
  assert.equal(back.censusTract, "censusTract");
  assert.equal(back.tractIncomeLevel, "tractIncomeLevel");
  assert.equal(back.lmiBorrower, "lmiBorrower");

  // MISMO JSON: the tract at the closest MISMO name, the level and the flag as UPB extensions, all before confidentiality.
  const json = mismoLoan(stored as unknown as Record<string, unknown>, false);
  assert.equal(json["DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/LOCATION_IDENTIFIER/CENSUS_INFORMATION/CensusTractIdentifier"], "12083000200");
  assert.equal(json["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/CensusTractIncomeLevelType"], "LOW");
  assert.equal(json["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/LMIBorrowerIndicator"], true);
  for (const key of ["censusTract", "tractIncomeLevel", "lmiBorrower"] as const) {
    const field = TAPE_STANDARD.find((entry) => entry.key === key);
    assert.ok(field && field.group === "risk" && field.allowed, key);
    if (field.mismo.match !== "exact") assert.ok((field.mismo.note ?? "").length > 10, key);
    assert.equal(WITHHELD_UNTIL_OPEN.has(key), false, key);
  }
  assert.match(STANDARD_GROUPS.find((group) => group.group === "risk")?.lede ?? "", /CRA officer decides/);

  // The buyer API's loan facts carry them through LOAN_FIELDS.
  const api = loanFacts(stored);
  assert.equal(api.censusTract, "12083000200");
  assert.equal(api.tractIncomeLevel, "LOW");
  assert.equal(api.lmiBorrower, true);
  assert.equal(api.streetAddress, undefined);
});

test("a servicer's report fills the CRA facts it carries", () => {
  for (const field of ["censusTract", "tractIncomeLevel", "lmiBorrower"]) assert.ok((REPORT_FIELDS as readonly string[]).includes(field), field);
  const headers = ["Loan #", "Census Tract", "Tract Income Level", "LMI Borrower"];
  const rows = [["LN-7", "12086.0105", "Moderate", "Yes"]].map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  const report = readServicerReport({ headers, rows });
  assert.deepEqual(report.rows[0].values, { loanNumber: "LN-7", censusTract: "12086010500", tractIncomeLevel: "MODERATE", lmiBorrower: true });
});

test("the note wizard checks the CRA facts, and an edit round-trips them", () => {
  const wizard = { streetAddress: "1 Main St", city: "Tampa", state: "FL", zip: "33602", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", estimatedValue: "250000", lienPosition: "FIRST", upb: "160000", interestRate: "3", monthlyPi: "700", paymentStatus: "PERFORMING", monthsDelinquent: "0", askingPrice: "140000", foreclosureStatus: "NONE" };
  const bare = noteSchema.parse(wizard);
  assert.equal(bare.censusTract, null);
  assert.equal(bare.tractIncomeLevel, null);
  assert.equal(bare.lmiBorrower, null);
  const full = noteSchema.parse({ ...wizard, censusTract: "12-086-010500", tractIncomeLevel: "MODERATE", lmiBorrower: "true" });
  assert.equal(full.censusTract, "12086010500");
  assert.equal(full.tractIncomeLevel, "MODERATE");
  assert.equal(full.lmiBorrower, true);
  assert.equal(noteSchema.safeParse({ ...wizard, censusTract: "12086" }).error?.issues[0].message, CENSUS_TRACT_MESSAGE);
  assert.equal(noteSchema.safeParse({ ...wizard, tractIncomeLevel: "LMI" }).success, false);
  for (const key of ["censusTract", "tractIncomeLevel", "lmiBorrower"]) {
    assert.ok((SERVICING_KEYS as readonly string[]).includes(key), key);
    assert.ok((RISK_KEYS as readonly string[]).includes(key), key);
  }
  const empty = Object.fromEntries(SERVICING_KEYS.map((key) => [key, null]));
  const draft = servicingDraft({ ...empty, ...full } as Parameters<typeof servicingDraft>[0]);
  assert.equal(draft.censusTract, "12086010500");
  assert.equal(draft.tractIncomeLevel, "MODERATE");
  assert.equal(draft.lmiBorrower, "true");
  assert.equal(noteSchema.parse({ ...wizard, ...draft }).censusTract, "12086010500");
});

test("the loan file shows the CRA facts before confidentiality, and the desk can verify them", () => {
  for (const key of ["censusTract", "tractIncomeLevel", "lmiBorrower"]) {
    const spec = fieldSpec(key);
    assert.ok(spec, key);
    assert.equal(spec.optional, true, key);
    assert.equal(spec.identity, undefined, `${key} isn't an identity field`);
    assert.ok((VERIFY_SOURCES as readonly string[]).includes(spec.source), key);
  }
  assert.equal(fieldSpec("censusTract")?.source, "FFIEC geocoder");
  // A desk reading in another layout is the same tract.
  const tract = fieldSpec("censusTract")!;
  assert.equal(canonical(tract, "12-086-010500"), "12086010500");
  assert.ok(sameReading(tract, "12086.0105", "12086010500"));
  assert.ok(!sameReading(tract, "12086.0106", "12086010500"));
  assert.equal(canonical(fieldSpec("tractIncomeLevel")!, "Moderate"), "MODERATE");
  assert.equal(canonical(fieldSpec("lmiBorrower")!, true), "yes");

  const note = { id: "n1", state: "FL", propertyType: "SFR", lienPosition: "FIRST", verifiedFields: null, censusTract: "12086010500", tractIncomeLevel: "MODERATE", lmiBorrower: true };
  const closed = renderToStaticMarkup(createElement(LoanFacts, { note, open: false, pro: false, withAddress: false }));
  assert.match(closed, /Census tract/);
  assert.ok(closed.includes("12086010500"));
  assert.match(closed, /Tract income level/);
  assert.match(closed, /Moderate/);
  assert.match(closed, /LMI borrower/);
  // A desk check against the geocoder reads on the badge.
  const checked = { ...note, verifiedFields: { censusTract: { at: NOW.toISOString(), by: "desk", source: "FFIEC geocoder", value: "12086010500" } } };
  assert.match(renderToStaticMarkup(createElement(LoanFacts, { note: checked, open: false, pro: false, withAddress: false })), /Desk-verified against FFIEC geocoder/);
});

test("the listing shows the CRA badge and block, with UPB's caution, and the desk gets the geocoder", () => {
  assert.equal(renderToStaticMarkup(createElement(CraBadge, { text: null })), "");
  const badge = renderToStaticMarkup(createElement(CraBadge, { text: "LMI tract" }));
  assert.match(badge, />CRA</);
  assert.match(badge, /LMI tract/);

  const single = renderToStaticMarkup(createElement(CraFacts, { kind: "SINGLE", notes: [{ censusTract: "12086010500", tractIncomeLevel: "MODERATE", lmiBorrower: true }] }));
  assert.match(single, /moderate-income census tract, 12086010500/);
  assert.match(single, /at or under 80% of the area median/);
  assert.ok(single.includes("Your CRA officer and your regulator decide what counts"));
  assert.ok(!single.includes("FFIEC geocoder"), "the geocoder is for the desk");
  const pool = renderToStaticMarkup(createElement(CraFacts, {
    kind: "POOL",
    notes: [{ tractIncomeLevel: "LOW" }, { tractIncomeLevel: "UPPER", lmiBorrower: true }, { tractIncomeLevel: "MIDDLE" }],
  }));
  assert.match(pool, /2 of 3 loans CRA-eligible: 1 in a low- or moderate-income tract, 1 to an LMI borrower/);
  assert.equal(renderToStaticMarkup(createElement(CraFacts, { kind: "SINGLE", notes: [{ tractIncomeLevel: "MIDDLE" }] })), "");

  // The link opens the FFIEC's geocoder and never carries the address; the desk searches the one shown beside it.
  const link = ffiecGeocoderLink({ streetAddress: "100 Main St", city: "Tampa", state: "FL", zip: "33602" });
  assert.deepEqual(link, { href: FFIEC_GEOCODER_URL, address: "100 Main St, Tampa, FL 33602" });
  assert.ok(FFIEC_GEOCODER_URL.startsWith("https://geomap.ffiec.gov/"));
  assert.equal(ffiecGeocoderLink({ streetAddress: "Not provided on tape", city: "Tampa", state: "FL" }), null);
  const desk = renderToStaticMarkup(createElement(CraFacts, { kind: "SINGLE", notes: [{ censusTract: "12086010500", tractIncomeLevel: "MIDDLE" }], geocode: link }));
  assert.ok(desk.includes(`href="${FFIEC_GEOCODER_URL}"`));
  assert.ok(desk.includes("100 Main St, Tampa, FL 33602"));
  assert.ok(!desk.includes("UPB&#x27;s reading"), "no caution on a loan that doesn't read as eligible");
});

// ---------------------------------------------------------------------------------------------------------------
// The book's filter, saved searches and alerts.

const note = (over: Partial<MatchNote> = {}): MatchNote => ({
  city: "Tampa", state: "FL", paymentStatus: "PERFORMING", lienPosition: "FIRST", propertyType: "SFR", upb: 100000, askingPrice: 80000, ...over,
});

test("the CRA filter matches eligible singles, and a pool when any loan for sale is eligible", () => {
  const tract = { kind: "SINGLE", notes: [note({ tractIncomeLevel: "LOW", lmiBorrower: null })] };
  const borrower = { kind: "SINGLE", notes: [note({ tractIncomeLevel: "UPPER", lmiBorrower: true })] };
  const middle = { kind: "SINGLE", notes: [note({ tractIncomeLevel: "MIDDLE", lmiBorrower: false })] };
  const unstated = { kind: "SINGLE", notes: [note({ tractIncomeLevel: null, lmiBorrower: null })] };
  const leftOut = { kind: "SINGLE", notes: [note()] };
  assert.equal(listingMatches(tract, { cra: true }), true);
  assert.equal(listingMatches(borrower, { cra: true }), true);
  for (const row of [middle, unstated, leftOut]) {
    assert.equal(listingMatches(row, { cra: true }), false);
    assert.equal(listingMatches(row, {}), true);
  }
  const pool = (levels: (string | null)[], traded: number[] = []) => ({
    kind: "POOL",
    notes: levels.map((level, index) => note({ tractIncomeLevel: level, lienPosition: index === 0 ? "SECOND" : "FIRST", tradeStatus: traded.includes(index) ? "SOLD" : "AVAILABLE" })),
  });
  assert.equal(listingMatches(pool(["MIDDLE", "MODERATE"]), { cra: true }), true);
  assert.equal(listingMatches(pool(["MIDDLE", null]), { cra: true }), false);
  // A loan that already traded out of the pool no longer counts.
  assert.equal(listingMatches(pool(["MIDDLE", "MODERATE"], [1]), { cra: true }), false);
  // With other filters, one loan meets them all, as the book's other loan facts do.
  assert.equal(listingMatches(pool(["MODERATE", "MIDDLE"]), { cra: true, lienPosition: ["FIRST"] }), false);
  assert.equal(listingMatches(pool(["MIDDLE", "MODERATE"]), { cra: true, lienPosition: ["FIRST"] }), true);
});

test("cra=1 reads from the address bar, round-trips, shows as a chip, and skips held listings", () => {
  assert.deepEqual(parseFilters({ cra: "1", state: "fl" }), { state: "FL", cra: true });
  assert.deepEqual(parseFilters({ cra: "true" }), { cra: true });
  assert.deepEqual(parseFilters({ cra: "0" }), {});
  assert.deepEqual(parseFilters({ cra: "maybe" }), {});
  assert.equal(filtersQuery({ state: "FL", loanProgram: ["VA"], cra: true }).toString(), "state=FL&loanProgram=VA&cra=1");
  assert.equal(filtersQuery({ cra: false }).toString(), "");
  assert.deepEqual(appliedChips({ cra: true }).map((chip) => chip.label), ["CRA-eligible only"]);
  assert.deepEqual(appliedChips({ cra: true, state: "FL" }).find((chip) => chip.label === "CRA-eligible only")?.without, { state: "FL" });
  // The CRA facts are in the loan file, so a listing the viewer can't open yet drops out rather than tell.
  assert.equal(fileFiltersActive({ cra: true }), true);
  const low = { kind: "SINGLE", notes: [note({ tractIncomeLevel: "LOW" })] };
  assert.equal(bookMatches(low, { cra: true }, true), false);
  assert.equal(bookMatches(low, { cra: true }, false), true);
});

test("a saved search from before the CRA filter still parses and matches as it did, and a new one keeps it", () => {
  const old = filtersFromSaved({ state: "FL", lienPosition: "FIRST", loanProgram: ["VA"], upbMin: 50000 });
  assert.deepEqual(old, { state: "FL", lienPosition: ["FIRST"], loanProgram: ["VA"], upbMin: 50000 });
  assert.equal("cra" in old, false);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [note({ loanProgram: "VA", tractIncomeLevel: null })] }, old), true);
  const saved = JSON.parse(JSON.stringify(parseFilters({ cra: "1", state: "FL" })));
  assert.deepEqual(saved, { state: "FL", cra: true });
  assert.deepEqual(filtersFromSaved(saved), { state: "FL", cra: true });
});

test("a roundup reads the CRA filter from the saved search", async () => {
  const seller = await person("seller-alert", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer-alert", "BUYER");
  const now = new Date();
  const eligible = await listing(seller.id, [loan({ tractIncomeLevel: "MODERATE" })], { approvedAt: new Date(now.getTime() - HOUR), title: `CRA roundup in ${tag}` });
  const middle = await listing(seller.id, [loan({ tractIncomeLevel: "MIDDLE", lmiBorrower: false })], { approvedAt: new Date(now.getTime() - HOUR), title: `CRA roundup out ${tag}` });
  const search = await prisma.savedSearch.create({
    data: { userId: buyer.id, name: `CRA ${tag}`, filters: { q: CITY, cra: true }, cadence: "DAILY", lastAlertAt: new Date(now.getTime() - 25 * HOUR), createdAt: new Date(now.getTime() - 3 * DAY) },
    include: { user: true },
  });
  made.searches.push(search.id);
  assert.equal(await sendSearchRoundup(search, now), true);
  const roundup = await prisma.notification.findFirstOrThrow({ where: { toEmail: buyer.email, subject: `Daily roundup · ${search.name}` } });
  assert.ok(roundup.body.includes(eligible.title));
  assert.ok(!roundup.body.includes(middle.title));
});

// ---------------------------------------------------------------------------------------------------------------
// Buy boxes.

const scored = (over: Partial<ProgramNote> = {}): ProgramNote => ({
  state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 100000, askingPrice: 80000, monthlyPi: 800, interestRate: 7,
  estimatedValue: 200000, seasoningMonths: 36, ...over,
});
const rules = (craOnly: boolean | null, states = "") => criteriaFrom({ states, liens: "", statuses: "", upbMin: null, upbMax: null, priceMin: null, priceMax: null, maxPriceToUpb: null, targetYield: null, craOnly });

test("a CRA-only box scores CRA-eligible paper on half its UPB and says why", () => {
  assert.equal(rules(true).craOnly, true);
  // A box saved before the switch takes any paper.
  assert.equal(rules(null).craOnly, false);
  assert.deepEqual(scoreBox([scored({ tractIncomeLevel: "MIDDLE" })], rules(null, "FL"))?.reasons, ["State fits"]);
  assert.deepEqual(scoreBox([scored({ tractIncomeLevel: "LOW" })], rules(true, "FL"))?.reasons, ["State fits", "CRA-eligible (LMI tract), as your box asks"]);
  assert.equal(scoreBox([scored({ tractIncomeLevel: "MIDDLE" })], rules(true, "FL")), null);
  assert.equal(scoreBox([scored()], rules(true, "FL")), null, "a loan whose tape states neither fact never counts");
  // A box whose only limit is the switch still scores.
  assert.deepEqual(scoreBox([scored({ lmiBorrower: true })], rules(true)), { score: 55, reasons: ["CRA-eligible (LMI borrower), as your box asks"] });
  assert.equal(scoreBox([scored({ lmiBorrower: true, askingPrice: 0 })], rules(true)), null);
  // A pool: 8 of 10 loans is 80% of the UPB.
  const pool = [...Array.from({ length: 8 }, () => scored({ tractIncomeLevel: "MODERATE" })), scored({ tractIncomeLevel: "UPPER" }), scored({ tractIncomeLevel: "MIDDLE" })];
  assert.deepEqual(scoreBox(pool, rules(true))?.reasons, ["8 of 10 loans CRA-eligible, as your box asks"]);
  // Half the UPB is enough; less is a miss, weighed by balance rather than count.
  assert.ok(craFit([scored({ lmiBorrower: true }), scored({ lmiBorrower: false })], true).fit);
  assert.equal(craFit([scored({ lmiBorrower: true }), scored({ lmiBorrower: false, upb: 150000 })], true).fit, false);
  assert.equal(craFit([scored({ lmiBorrower: true, upb: 300000 }), scored(), scored()], true).reason, "1 of 3 loans CRA-eligible, as your box asks");
  assert.deepEqual(craFit([scored()], false), { fit: true, reason: null });
});

test("a CRA-only box's standing price applies only to paper that is all CRA-eligible", () => {
  const user = { role: "BUYER", accountStatus: "APPROVED", subscriptionTier: "PRO", subscriptionStatus: "ACTIVE", subscriptionCurrentPeriodEnd: null };
  const box = {
    id: "box", userId: "u", name: "CRA box", states: "", liens: "", statuses: "", programs: "", craOnly: true, upbMin: null, upbMax: null, priceMin: null, priceMax: null,
    maxPriceToUpb: null, targetYield: null, maxLtv: null, minSeasoningMonths: null, standingBids: true, bidBasis: "UPB", bidPercent: 70, bidCap: null, bidSpread: null, active: true, user,
  } as never;
  const standing = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `n${index}`, upb: 100000, askingPrice: 90000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", maturityDate: null, tradeStatus: "AVAILABLE" }));

  const single = scoreMatch("SINGLE", standing(1), box, [scored({ askingPrice: 90000, tractIncomeLevel: "LOW" })], NOW, 0, null);
  assert.equal(single.price, 70000);
  assert.deepEqual(single.result?.reasons, ["CRA-eligible (LMI tract), as your box asks", "At the standing price"]);
  const miss = scoreMatch("SINGLE", standing(1), box, [scored({ askingPrice: 90000, tractIncomeLevel: "UPPER" })], NOW, 0, null);
  assert.equal(miss.result, null);
  assert.equal(miss.price, null);

  // A pool that fits on 8 of 10 loans is scored, but a standing price is a bid for the whole listing, so it waits.
  const mixed = [...Array.from({ length: 8 }, () => scored({ askingPrice: 90000, lmiBorrower: true })), scored({ askingPrice: 90000, lmiBorrower: false }), scored({ askingPrice: 90000 })];
  const partial = scoreMatch("POOL", standing(10), box, mixed, NOW, 0, null);
  assert.equal(partial.price, null);
  assert.deepEqual(partial.result?.reasons, ["8 of 10 loans CRA-eligible, as your box asks", "2 loans aren't CRA-eligible, so no standing price"]);
  const whole = scoreMatch("POOL", standing(3), box, Array.from({ length: 3 }, () => scored({ askingPrice: 90000, tractIncomeLevel: "MODERATE" })), NOW, 0, null);
  assert.equal(whole.price, 210000);
  assert.deepEqual(whole.result?.reasons, ["3 of 3 loans CRA-eligible, as your box asks", "At the standing price"]);
  // Without a rule there is no price to hold back, so nothing is said about one.
  const plain = scoreMatch("POOL", standing(10), { ...(box as object), standingBids: false } as never, mixed, NOW, 0, null);
  assert.deepEqual(plain.result?.reasons, ["8 of 10 loans CRA-eligible, as your box asks"]);
  // A box without the switch prices mixed paper as before.
  const any = scoreMatch("POOL", standing(10), { ...(box as object), craOnly: null, states: "FL" } as never, mixed, NOW, 0, null);
  assert.equal(any.price, 700000);
});

test("matching writes the CRA reason on a CRA-only box's match", async () => {
  const seller = await person("seller-box", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer-box", "BUYER");
  const box = await prisma.buyBox.create({ data: { userId: buyer.id, name: `CRA box ${tag}`, states: STATE, craOnly: true } });
  made.boxes.push(box.id);
  const eligible = await listing(seller.id, [loan({ tractIncomeLevel: "LOW", censusTract: "12086010500" })]);
  const middle = await listing(seller.id, [loan({ tractIncomeLevel: "MIDDLE" })]);
  await rescoreListing(eligible.id, false);
  await rescoreListing(middle.id, false);
  const hit = await prisma.listingMatch.findUniqueOrThrow({ where: { listingId_buyBoxId: { listingId: eligible.id, buyBoxId: box.id } } });
  assert.equal(hit.reasons, "State fits · CRA-eligible (LMI tract), as your box asks");
  assert.equal(await prisma.listingMatch.count({ where: { listingId: middle.id, buyBoxId: box.id } }), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The buyer API.

test("the buyer API filters on cra=1, refuses another value, and lists each loan's CRA facts", async () => {
  const seller = await person("seller-api", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer-api", "BUYER");
  const token = await key(buyer.id);
  const tract = await listing(seller.id, [loan({ censusTract: "12086010500", tractIncomeLevel: "MODERATE" })]);
  const borrower = await listing(seller.id, [loan({ tractIncomeLevel: "UPPER", lmiBorrower: true })]);
  const middle = await listing(seller.id, [loan({ tractIncomeLevel: "MIDDLE", lmiBorrower: false })]);
  const unstated = await listing(seller.id, [loan()]);
  const pool = await listing(seller.id, [loan({ tractIncomeLevel: "MIDDLE" }), loan({ tractIncomeLevel: "LOW" })]);
  const ids = async (query: string) => {
    const response = await call(getListings, `/api/v1/listings?state=${STATE}&limit=100${query}`, token);
    assert.equal(response.status, 200);
    return new Set(((await response.json()) as { listings: { id: string }[] }).listings.map((row) => row.id));
  };
  const cra = await ids("&cra=1");
  for (const row of [tract, borrower, pool]) assert.ok(cra.has(row.id));
  for (const row of [middle, unstated]) assert.ok(!cra.has(row.id));
  for (const query of ["", "&cra=0"]) {
    const all = await ids(query);
    for (const row of [tract, borrower, middle, unstated, pool]) assert.ok(all.has(row.id), query);
  }
  const bad = await call(getListings, "/api/v1/listings?cra=yes", token);
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /^cra is 1/);

  const detail = await call(getListing, `/api/v1/listings/${tract.id}`, token, { id: tract.id });
  assert.equal(detail.status, 200);
  const loans = ((await detail.json()) as { loans: Record<string, unknown>[] }).loans;
  assert.equal(loans[0].censusTract, "12086010500");
  assert.equal(loans[0].tractIncomeLevel, "MODERATE");
  assert.equal(loans[0].lmiBorrower, null);
});
