import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoanFacts } from "../components/loan-file-view";
import { PoolRisks, TapeRisks, riskLines } from "../components/tape-risk";
import { loanFacts } from "../lib/buyer-api";
import {
  addTranche,
  approvalStart,
  createProgram,
  decideProgram,
  inviteToProgram,
  monthlyRange,
  readProgram,
  startLabel,
  startsLater,
  tapeProgram,
  volumeLine,
  volumeSentence,
  type ProgramInput,
} from "../lib/flow-programs";
import { fieldSpec } from "../lib/loan-file";
import { mismoLoan, TAPE_STANDARD } from "../lib/mismo";
import { prisma } from "../lib/prisma";
import { readServicerReport, REPORT_FIELDS } from "../lib/servicer-import";
import { normalizeTapeRows, parseTapeBuffer, readServicing } from "../lib/tape";
import {
  asksForPartialClaim,
  PARTIAL_CLAIM_ASK,
  parseLoanProgram,
  partialClaimLine,
  riskExportColumns,
  SERVICING_KEYS,
  suggestMapping,
  TAPE_HEADERS,
} from "../lib/tape-fields";
import { combinedLtv, reviewTape } from "../lib/tape-quality";
import { noteSchema, servicingDraft } from "../lib/validators";

// The app compiles JSX with Next. Under tsx a component's JSX reads React from the global scope.
(globalThis as { React?: typeof React }).React = React;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-15T12:00:00Z");
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], emails: [] as string[], listings: [] as string[] };

const csv = (rows: string[][]) => Buffer.from(rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n"));

test.after(async () => {
  const userIds = made.users;
  const listingIds = made.listings;
  const programs = (await prisma.flowProgram.findMany({ where: { sellerId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.flowTranche.deleteMany({ where: { programId: { in: programs } } });
  await prisma.flowCommitment.deleteMany({ where: { programId: { in: programs } } });
  await prisma.flowProgram.deleteMany({ where: { id: { in: programs } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...userIds, ...programs] } }, { actorId: { in: userIds } }] } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.rateWindow.deleteMany({ where: { OR: userIds.map((id) => ({ key: { startsWith: `flow-invite:${id}` } })) } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.emails } }, { subject: { contains: tag } }, { body: { contains: tag } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER" | "ADMIN") {
  const user = await prisma.user.create({
    data: { email: `a-pcflow-${who}-${tag}@example.org`, name: `PC flow ${who} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" },
  });
  if (role === "BUYER") await prisma.buyerProfile.create({ data: { userId: user.id, status: "APPROVED" } });
  made.users.push(user.id);
  made.emails.push(user.email);
  return user;
}

// ---------------------------------------------------------------------------------------------------------------
// Feature 1: the loan program and the partial claim.

test("the program and partial claim read from common servicer headers, and the program's spellings normalise", () => {
  const mapped = suggestMapping(["Loan Type", "Partial Claim", "PC Amount"]);
  assert.equal(mapped.loanProgram, "Loan Type");
  assert.equal(mapped.partialClaim, "Partial Claim");
  assert.equal(mapped.partialClaimBalance, "PC Amount");
  // "Loan type" no longer means the payment type.
  assert.equal(mapped.paymentType, undefined);
  assert.equal(suggestMapping(["Program"]).loanProgram, "Program");
  assert.equal(suggestMapping(["FHA/VA"]).loanProgram, "FHA/VA");
  assert.equal(suggestMapping(["Partial Claim Balance"]).partialClaimBalance, "Partial Claim Balance");
  // The template's own headers map back to their fields.
  for (const header of ["loan_program", "partial_claim", "partial_claim_balance"]) assert.ok(TAPE_HEADERS.includes(header), header);

  for (const raw of ["VA", "V.A.", "Veterans Affairs", "va", "VA IRRRL", "VA Guaranteed", "Dept. of Veterans Affairs"]) assert.equal(parseLoanProgram(raw), "VA", raw);
  for (const raw of ["FHA", "F.H.A.", "FHA 203(b)", "HUD", "Federal Housing Administration"]) assert.equal(parseLoanProgram(raw), "FHA", raw);
  for (const raw of ["USDA", "USDA RD", "Rural Development", "RD"]) assert.equal(parseLoanProgram(raw), "USDA", raw);
  for (const raw of ["Conventional", "Conv", "Fannie Mae", "FNMA", "Non-conforming", "Jumbo"]) assert.equal(parseLoanProgram(raw), "CONVENTIONAL", raw);
  for (const raw of ["Seller financed", "Owner-financed", "Private money", "Private", "Hard money"]) assert.equal(parseLoanProgram(raw), "PRIVATE", raw);
  assert.equal(parseLoanProgram("Other"), "OTHER");
  // "Private" holds the letters "va", and a Ginnie Mae pool holds every government program.
  assert.notEqual(parseLoanProgram("Private"), "VA");
  assert.equal(parseLoanProgram("GNMA"), null);
  assert.equal(parseLoanProgram("Vacant"), null);
  assert.equal(parseLoanProgram(""), null);
});

const HEADERS = ["City", "State", "Property Type", "Lien", "Payment Status", "UPB", "Value", "Rate", "Asking Price", "Loan Type", "Partial Claim", "PC Amount", "Modified", "Pay String"];
const ROWS = [
  ["Tampa", "FL", "SFR", "First", "Performing", "180000", "260000", "3.25", "150000", "V.A.", "", "$12,400.50", "Yes", "000000000012"],
  ["Ocala", "FL", "SFR", "First", "Performing", "150000", "220000", "3.5", "120000", "Veterans Affairs", "No", "5000", "No", ""],
  ["Macon", "GA", "SFR", "First", "Performing", "120000", "180000", "4", "100000", "FHA", "$8,000", "", "No", ""],
  ["Akron", "OH", "SFR", "First", "Performing", "90000", "140000", "5", "80000", "Conventional", "N/A", "0", "No", ""],
  ["Tulsa", "OK", "SFR", "First", "Performing", "80000", "120000", "5", "70000", "GNMA", "", "", "No", ""],
];

test("a tape row with VA and a partial-claim balance lands on the note, and what can't be read is left off with a warning", async () => {
  const matrix = parseTapeBuffer(csv([HEADERS, ...ROWS]), "tape.csv");
  const mapping = suggestMapping(matrix.headers);
  const { loans, errors } = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: "COLUMN" });
  assert.deepEqual(errors, []);
  // A balance answers the partial-claim question when the flag is blank.
  assert.equal(loans[0].loanProgram, "VA");
  assert.equal(loans[0].partialClaim, true);
  assert.equal(loans[0].partialClaimBalance, 12400.5);
  // No, with a balance, contradicts itself: both are left off for the servicer.
  assert.equal(loans[1].loanProgram, "VA");
  assert.equal(loans[1].partialClaim, undefined);
  assert.equal(loans[1].partialClaimBalance, undefined);
  // An amount in the flag column is the balance.
  assert.equal(loans[2].partialClaim, true);
  assert.equal(loans[2].partialClaimBalance, 8000);
  // A zero balance is no partial claim.
  assert.equal(loans[3].loanProgram, "CONVENTIONAL");
  assert.equal(loans[3].partialClaim, false);
  assert.equal(loans[3].partialClaimBalance, undefined);
  assert.equal(loans[4].loanProgram, undefined);

  const flags = reviewTape(matrix.rows, mapping, NOW);
  assert.ok(flags.some((flag) => flag.row === 3 && flag.field === "partialClaimBalance" && flag.level === "warn" && /Ask the servicer/.test(flag.message)));
  assert.ok(flags.some((flag) => flag.row === 4 && flag.field === "partialClaim" && flag.level === "fix"));
  assert.ok(flags.some((flag) => flag.row === 6 && flag.field === "loanProgram" && flag.level === "warn"));
  assert.equal(readServicing(matrix.rows[0], mapping).notes.length, 0);

  // Stored as the tape upload and the seller API store a tape: the normalised loans, as the listing's notes.
  const seller = await person("tape", "INSTITUTIONAL_SELLER");
  const listing = await prisma.listing.create({
    data: { kind: "POOL", sellerId: seller.id, status: "SUBMITTED", title: `PC tape ${tag}`, summary: "", notes: { create: loans } },
    include: { notes: { orderBy: { upb: "desc" } } },
  });
  made.listings.push(listing.id);
  const stored = listing.notes.find((note) => note.city === "Tampa")!;
  assert.equal(stored.loanProgram, "VA");
  assert.equal(stored.partialClaim, true);
  assert.equal(stored.partialClaimBalance, 12400.5);
  assert.equal(listing.notes.find((note) => note.city === "Tulsa")!.partialClaim, null);

  // The export carries the fields: the tape's columns, the MISMO JSON, and the buyer API's loan facts.
  const columns = riskExportColumns(stored, false);
  assert.equal(columns.loanProgram, "VA");
  assert.equal(columns.partialClaim, "yes");
  assert.equal(columns.partialClaimBalance, 12400.5);
  assert.equal(riskExportColumns({ partialClaim: null }, false).partialClaim, "");
  // The export's own column names read back as the same fields.
  const back = suggestMapping(Object.keys(columns));
  assert.equal(back.loanProgram, "loanProgram");
  assert.equal(back.partialClaim, "partialClaim");
  assert.equal(back.partialClaimBalance, "partialClaimBalance");
  const json = mismoLoan(stored as unknown as Record<string, unknown>, false);
  assert.equal(json["DEAL/LOANS/LOAN/TERMS_OF_LOAN/MortgageType"], "VA");
  assert.equal(json["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/PartialClaimIndicator"], true);
  assert.equal(json["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/PartialClaimBalanceAmount"], 12400.5);
  for (const key of ["loanProgram", "partialClaim", "partialClaimBalance"]) {
    const field = TAPE_STANDARD.find((row) => row.key === key);
    assert.ok(field && field.group === "risk" && field.allowed, key);
  }
  const api = loanFacts(stored);
  assert.equal(api.loanProgram, "VA");
  assert.equal(api.partialClaim, true);
  assert.equal(api.partialClaimBalance, 12400.5);
});

test("a servicer's report fills the program and the partial claim", () => {
  for (const field of ["loanProgram", "partialClaim", "partialClaimBalance"]) assert.ok((REPORT_FIELDS as readonly string[]).includes(field), field);
  const headers = ["Loan #", "Program", "Partial Claim", "Partial Claim Balance"];
  const rows = [["LN-9", "VA", "Yes", "7,250"]].map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  const report = readServicerReport({ headers, rows });
  assert.deepEqual(report.rows[0].values, { loanNumber: "LN-9", loanProgram: "VA", partialClaim: true, partialClaimBalance: 7250 });
  assert.deepEqual(report.columns.map((column) => column.field).filter((field) => field !== "loanNumber"), ["loanProgram", "partialClaim", "partialClaimBalance"]);
});

test("the note wizard checks the program and the claim, and an edit round-trips them", () => {
  const wizard = { streetAddress: "1 Main St", city: "Tampa", state: "FL", zip: "33602", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", estimatedValue: "250000", lienPosition: "FIRST", upb: "160000", interestRate: "3", monthlyPi: "700", paymentStatus: "PERFORMING", monthsDelinquent: "0", askingPrice: "140000", foreclosureStatus: "NONE" };
  const bare = noteSchema.parse(wizard);
  assert.equal(bare.loanProgram, null);
  assert.equal(bare.partialClaim, null);
  assert.equal(bare.partialClaimBalance, null);
  const full = noteSchema.parse({ ...wizard, loanProgram: "VA", partialClaim: "true", partialClaimBalance: "12400" });
  assert.equal(full.loanProgram, "VA");
  assert.equal(full.partialClaim, true);
  assert.equal(full.partialClaimBalance, 12400);
  const error = (patch: Record<string, string>) => noteSchema.safeParse({ ...wizard, ...patch }).error?.issues[0].message ?? "";
  assert.equal(error({ partialClaim: "false", partialClaimBalance: "12400" }), "Answer yes to the partial claim to give its balance.");
  assert.equal(error({ partialClaimBalance: "12400" }), "Answer yes to the partial claim to give its balance.");
  assert.equal(error({ partialClaim: "true", partialClaimBalance: "0" }), "The partial claim balance must be greater than zero.");
  assert.equal(noteSchema.safeParse({ ...wizard, loanProgram: "GNMA" }).success, false);

  const empty = Object.fromEntries(SERVICING_KEYS.map((key) => [key, null]));
  const draft = servicingDraft({ ...empty, ...full } as Parameters<typeof servicingDraft>[0]);
  assert.equal(draft.loanProgram, "VA");
  assert.equal(draft.partialClaim, "true");
  assert.equal(draft.partialClaimBalance, "12400");
  assert.equal(noteSchema.parse({ ...wizard, ...draft }).partialClaimBalance, 12400);
});

test("the listing and the loan file say what a partial claim is, the caution asks for one, and LTV never counts it", () => {
  const va = { state: "FL", paymentStatus: "PERFORMING", loanProgram: "VA", partialClaim: true, partialClaimBalance: 12400 };
  const line = partialClaimLine(va, true);
  assert.match(line ?? "", /^VA holds a partial claim of \$12,400 for arrears the agency paid\./);
  assert.match(line ?? "", /subordinate lien, due at payoff, sale or refinance/);
  assert.match(line ?? "", /UPB reads it/);
  assert.match(partialClaimLine({ ...va, loanProgram: "FHA" }, true) ?? "", /^HUD holds an FHA partial claim of \$12,400/);
  // A balance follows Pro, and an unknown balance is said to be unknown.
  assert.ok(!(partialClaimLine(va, false) ?? "").includes("12,400"));
  assert.match(partialClaimLine({ ...va, partialClaimBalance: null }, true) ?? "", /doesn't give its balance/);
  assert.equal(partialClaimLine({ ...va, partialClaim: false }, true), null);

  // The caution: FHA or VA, the claim unanswered, and modified, a loss mitigation outcome, or re-performing.
  const plain = { state: "FL", paymentStatus: "PERFORMING", loanProgram: "VA" };
  assert.equal(asksForPartialClaim(plain), false, "nothing says it fell behind");
  assert.equal(asksForPartialClaim({ ...plain, modified: true }), true);
  assert.equal(asksForPartialClaim({ ...plain, lossMitigation: "Repayment plan" }), true);
  assert.equal(asksForPartialClaim({ ...plain, payString: "000000011000" }), true, "re-performing");
  assert.equal(asksForPartialClaim({ ...plain, payString: "100000000000" }), false, "behind this month isn't caught up");
  assert.equal(asksForPartialClaim({ ...plain, paymentStatus: "NON_PERFORMING", payString: "000000011000" }), false);
  assert.equal(asksForPartialClaim({ ...plain, loanProgram: "FHA", modified: true }), true);
  assert.equal(asksForPartialClaim({ ...plain, loanProgram: "CONVENTIONAL", modified: true }), false);
  assert.equal(asksForPartialClaim({ ...plain, modified: true, partialClaim: false }), false, "answered no");
  assert.equal(asksForPartialClaim({ ...plain, modified: true, partialClaim: true }), false, "answered yes");

  assert.deepEqual(riskLines({ ...plain, modified: true }, true).map((row) => row.key), ["partialClaimAsk"]);
  const asked = renderToStaticMarkup(createElement(TapeRisks, { note: { ...plain, modified: true }, open: true, now: NOW }));
  assert.ok(asked.includes(PARTIAL_CLAIM_ASK));
  assert.match(asked, /A VA loan that was modified/);
  const shown = renderToStaticMarkup(createElement(TapeRisks, { note: va, open: false, pro: true, now: NOW }));
  assert.match(shown, /Partial claim\./);
  assert.ok(shown.includes("12,400"));
  assert.ok(!renderToStaticMarkup(createElement(TapeRisks, { note: va, open: true, now: NOW })).includes("12,400"), "no balance without Pro");
  const pool = renderToStaticMarkup(createElement(PoolRisks, { notes: [va, { ...plain, modified: true }, { state: "FL", paymentStatus: "PERFORMING" }], now: NOW }));
  assert.match(pool, /1 of 3 loans carry an FHA or VA partial claim/);
  assert.match(pool, /1 FHA or VA loan was modified or caught up/);

  // The loan facts show the fields, the balance behind Pro.
  assert.equal(fieldSpec("partialClaimBalance")?.pro, true);
  const note = { id: "n1", propertyType: "SFR", lienPosition: "FIRST", verifiedFields: null, ...va };
  const free = renderToStaticMarkup(createElement(LoanFacts, { note, open: false, pro: false, withAddress: false }));
  assert.match(free, /Loan program/);
  assert.match(free, /Partial claim balance/);
  assert.ok(!free.includes("12,400"));
  assert.ok(renderToStaticMarkup(createElement(LoanFacts, { note, open: false, pro: true, withAddress: false })).includes("12,400"));

  // Combined LTV is for junior liens and reads the senior balance only: a partial claim is never ahead of the note.
  assert.equal(combinedLtv({ lien: "FIRST", upb: 160000, value: 250000, seniorLienBalance: null }), null);
  assert.equal(combinedLtv({ lien: "SECOND", upb: 50000, value: 250000, seniorLienBalance: 150000 }), 80);
});

// ---------------------------------------------------------------------------------------------------------------
// Feature 6: forward flow's monthly range and its start.

const TERMS = "Committed buyers see each tranche for the first-look hours before the market. Each bid is confirmed by the buyer.";

function input(extra: Partial<ProgramInput> = {}): ProgramInput {
  return {
    name: `Range flow ${tag}`,
    cadence: "MONTHLY",
    firstLookHours: "72",
    expectedVolume: "",
    terms: TERMS,
    lienPositions: [],
    paymentStatuses: [],
    states: "",
    maxUpb: "",
    minSeasoningMonths: "",
    ...extra,
  };
}

test("the monthly range is optional, positive, in order and capped, and the start is a day ahead within a year", () => {
  const range = readProgram(input({ monthlyMin: "5,000,000", monthlyMax: "$50,000,000" }), NOW);
  assert.equal(range.error, null);
  if (range.error === null) {
    assert.equal(range.data.monthlyMinCents, 500_000_000);
    assert.equal(range.data.monthlyMaxCents, 5_000_000_000);
    assert.equal(range.data.startsAt, null, "no day is an open start");
  }
  const none = readProgram(input(), NOW);
  assert.equal(none.error === null && none.data.monthlyMinCents, null);
  const one = readProgram(input({ monthlyMax: "20,000,000" }), NOW);
  assert.equal(one.error === null && one.data.monthlyMaxCents, 2_000_000_000, "one end alone");
  assert.equal(readProgram(input({ monthlyMin: "50,000,000", monthlyMax: "5,000,000" }), NOW).error, "The monthly minimum is above the maximum. Swap them, or change one.");
  assert.equal(readProgram(input({ monthlyMin: "0" }), NOW).error, "Enter the monthly minimum in dollars above zero, or leave it blank.");
  assert.equal(readProgram(input({ monthlyMax: "-5" }), NOW).error, "Enter the monthly maximum in dollars above zero, or leave it blank.");
  assert.equal(readProgram(input({ monthlyMax: "lots" }), NOW).error, "Enter the monthly maximum in dollars above zero, or leave it blank.");
  assert.equal(readProgram(input({ monthlyMax: "6,000,000,000" }), NOW).error, "Enter a monthly volume up to $5,000,000,000.");

  const dated = readProgram(input({ startsOn: "2026-12-01" }), NOW);
  assert.equal(dated.error === null && dated.data.startsAt?.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(readProgram(input({ startsOn: "2026-11-14" }), NOW).error, null, "yesterday, for a timezone behind the server");
  assert.equal(readProgram(input({ startsOn: "2026-11-01" }), NOW).error, "Choose a start from today on, or leave it blank for an open start.");
  assert.equal(readProgram(input({ startsOn: "2028-01-01" }), NOW).error, "Choose a start within a year, or leave it blank for an open start.");
  assert.equal(readProgram(input({ startsOn: "next month" }), NOW).error, "Enter the start as a date, or leave it blank for an open start.");

  const dec1 = new Date("2026-12-01T00:00:00Z");
  const both = { monthlyMinCents: 500_000_000, monthlyMaxCents: 5_000_000_000 };
  assert.equal(monthlyRange(both), "$5M–$50M a month");
  assert.equal(monthlyRange({ monthlyMinCents: 500_000_000, monthlyMaxCents: null }), "$5M or more a month");
  assert.equal(monthlyRange({ monthlyMinCents: null, monthlyMaxCents: 5_000_000_000 }), "Up to $50M a month");
  assert.equal(monthlyRange({ monthlyMinCents: null, monthlyMaxCents: null }), null);
  assert.equal(volumeLine({ ...both, status: "OPEN", startsAt: null }, NOW), "$5M–$50M a month · open start");
  assert.equal(volumeLine({ ...both, status: "OPEN", startsAt: dec1 }, NOW), "$5M–$50M a month · starts Dec 1");
  assert.equal(volumeLine({ monthlyMinCents: null, monthlyMaxCents: null, status: "OPEN", startsAt: null }, NOW), "Open start");
  assert.equal(startLabel({ status: "OPEN", startsAt: new Date("2026-11-10T09:00:00Z") }, NOW), "started Nov 10");
  assert.equal(startLabel({ status: "DRAFT", startsAt: new Date("2026-11-10T00:00:00Z") }, NOW), "starts on approval");
  assert.equal(startLabel({ status: "OPEN", startsAt: new Date("2027-01-05T00:00:00Z") }, NOW), "starts Jan 5, 2027");
  assert.equal(volumeSentence({ ...both, startsAt: null }, NOW), "The seller expects $5M–$50M a month, with an open start.");
  assert.equal(volumeSentence({ ...both, startsAt: dec1 }, NOW), "The seller expects $5M–$50M a month, from Dec 1.");
  assert.equal(volumeSentence({ monthlyMinCents: null, monthlyMaxCents: null, startsAt: dec1 }, NOW), "Tranches start Dec 1.");

  // Approval keeps a day still ahead, starts a passed one at approval, and leaves no day open.
  assert.equal(approvalStart(dec1, NOW), dec1);
  assert.equal(approvalStart(new Date("2026-11-15T00:00:00Z"), NOW), NOW);
  assert.equal(approvalStart(null, NOW), null);
  assert.equal(startsLater({ startsAt: null }, NOW), false);
  assert.equal(startsLater({ startsAt: dec1 }, NOW), true);
});

test("approval keeps a future start, null stays an open start, and an open start takes a tranche at once", async () => {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const buyer = await person("buyer", "BUYER");
  const ahead = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);

  const dated = await createProgram(seller, input({ name: `Dated flow ${tag}`, startsOn: ahead, monthlyMin: "5,000,000", monthlyMax: "50,000,000" }));
  assert.equal(dated.ok, true);
  if (!dated.ok) return;
  assert.equal((await prisma.flowProgram.findUniqueOrThrow({ where: { id: dated.value.id } })).startsAt?.toISOString(), `${ahead}T00:00:00.000Z`, "the draft holds the seller's day");
  assert.equal((await decideProgram(desk, { programId: dated.value.id, decision: "APPROVE", note: "" })).ok, true);
  const datedOpen = await prisma.flowProgram.findUniqueOrThrow({ where: { id: dated.value.id } });
  assert.equal(datedOpen.status, "OPEN");
  assert.equal(datedOpen.startsAt?.toISOString(), `${ahead}T00:00:00.000Z`, "a day still ahead stands");
  const approved = await prisma.notification.findFirst({ where: { toEmail: seller.email, subject: { contains: `Dated flow ${tag}` } }, orderBy: { createdAt: "desc" } });
  assert.match(approved?.body ?? "", /Tranches join from its start on/);

  const open = await createProgram(seller, input({ name: `Open flow ${tag}`, monthlyMin: "5,000,000", monthlyMax: "50,000,000" }));
  assert.equal(open.ok, true);
  if (!open.ok) return;
  assert.equal((await decideProgram(desk, { programId: open.value.id, decision: "APPROVE", note: "" })).ok, true);
  const openRow = await prisma.flowProgram.findUniqueOrThrow({ where: { id: open.value.id } });
  assert.equal(openRow.startsAt, null, "no day chosen is an open start");
  assert.ok(openRow.approvedAt);
  assert.equal(volumeLine(openRow), "$5M–$50M a month · open start");

  // A day that passed before approval starts the programme at approval.
  const today = await createProgram(seller, input({ name: `Today flow ${tag}`, startsOn: new Date().toISOString().slice(0, 10) }));
  assert.equal(today.ok, true);
  if (!today.ok) return;
  const at = new Date();
  assert.equal((await decideProgram(desk, { programId: today.value.id, decision: "APPROVE", note: "" }, at)).ok, true);
  assert.equal((await prisma.flowProgram.findUniqueOrThrow({ where: { id: today.value.id } })).startsAt?.getTime(), at.getTime());

  // Tranches: an open start takes one now; a start ahead takes none until its day.
  const pool = async (title: string) => {
    const row = await prisma.listing.create({
      data: {
        kind: "POOL",
        sellerId: seller.id,
        status: "SUBMITTED",
        standingBidsNotifiedAt: new Date(),
        title: `${title} ${tag}`,
        notes: { create: [{ streetAddress: "1 Range St", city: `Rangeton${tag}`, state: "TX", zip: "75001", propertyType: "SFR", occupancy: "TENANT", lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0, askingPrice: 80000, estimatedValue: 200000 }] },
      },
    });
    made.listings.push(row.id);
    return row;
  };
  const first = await pool("Open start tranche");
  const added = await addTranche(seller, { programId: open.value.id, listingId: first.id });
  assert.equal(added.ok, true, added.ok ? "" : added.error);
  assert.ok(await tapeProgram(seller.id, open.value.id), "a tape can file into an open start");
  const early = await pool("Early tranche");
  const refused = await addTranche(seller, { programId: dated.value.id, listingId: early.id });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /takes tranches from its start on/);
  assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: early.id } })).flowProgramId, null, "the listing isn't tagged");
  assert.equal(await tapeProgram(seller.id, dated.value.id), null, "nor can a tape file into it yet");

  // The invitation names the range and the start.
  const invited = await inviteToProgram(seller, { programId: open.value.id, emails: buyer.email });
  assert.equal(invited.ok && invited.value.invited.length, 1);
  const mail = await prisma.notification.findFirst({ where: { toEmail: buyer.email, subject: { contains: `Open flow ${tag}` } } });
  assert.match(mail?.body ?? "", /The seller expects \$5M–\$50M a month, with an open start\./);
});
