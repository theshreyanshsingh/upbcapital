import assert from "node:assert/strict";
import test from "node:test";
import { canReadDocument, isPrivateDocument, loanFileAccess } from "../lib/acl";
import { docLabel } from "../lib/labels";
import {
  chainDetail,
  chainOfTitle,
  chainParties,
  clearFieldVerified,
  completeness,
  completenessLine,
  fieldState,
  KEY_FIELDS,
  logRiskCheck,
  markFieldVerified,
  moveChainLink,
  partyKey,
  removeCollateralItem,
  saveCollateralItem,
  standardChecklist,
  superLien,
} from "../lib/loan-file";
import { prisma } from "../lib/prisma";

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const item = (kind: string, status: string, extra: Record<string, unknown> = {}) => ({ id: `c${(seq += 1)}`, kind, status, sequence: 0, detail: "", ...extra });
const link = (kind: string, sequence: number, from: string, to: string, status = "PRESENT") => item(kind, status, { sequence, detail: chainDetail(from, to) });
const check = (kind: string, result: string, daysAgo: number) => ({ id: `r${(seq += 1)}`, kind, result, source: "PACER", detail: "", checkedAt: new Date(Date.now() - daysAgo * DAY) });

test("the checklist asks a junior lien for an O&E, not a lender's title policy", () => {
  const first = standardChecklist("FIRST");
  const second = standardChecklist("SECOND");
  assert.deepEqual(first.map((line) => line.kind), ["ORIGINAL_NOTE", "ALLONGE", "MORTGAGE", "ASSIGNMENT", "TITLE_POLICY", "OE_REPORT", "PAY_HISTORY", "BPO"]);
  assert.equal(first.find((line) => line.kind === "TITLE_POLICY")?.required, true);
  assert.equal(second.find((line) => line.kind === "TITLE_POLICY")?.required, false);
  assert.ok(second.find((line) => line.kind === "OE_REPORT")?.required);
  assert.deepEqual(first.filter((line) => line.chain).map((line) => line.kind), ["ALLONGE", "ASSIGNMENT"]);
});

test("an untouched file reads as unreviewed, with every line still owed", () => {
  const empty = completeness({ lienPosition: "FIRST" }, [], []);
  assert.deepEqual(empty.collateral, { present: 0, required: 8, missing: 0, defective: 0, unreviewed: 8 });
  assert.deepEqual(empty.checks, { run: 0, total: 5, flagged: 0, unknown: 0 });
  assert.equal(empty.fields.total, KEY_FIELDS.length);
  assert.equal(empty.reviewed, false);
  assert.equal(completenessLine(empty), "Not yet reviewed by the desk");
  assert.equal(completeness({ lienPosition: "SECOND" }, [], []).collateral.required, 7);
});

test("completeness counts what is on file, what is owed and what is open, and grades nothing", () => {
  const collateral = [
    item("ORIGINAL_NOTE", "PRESENT"),
    item("ALLONGE", "NOT_REQUIRED", { detail: "Endorsed on the face of the note" }),
    item("MORTGAGE", "DEFECTIVE", { cureOwner: "Seller", cureBy: new Date("2026-12-01") }),
    link("ASSIGNMENT", 1, "First Bank, N.A.", "Coastal Capital LLC"),
    link("ASSIGNMENT", 2, "Coastal Capital", "Harbor Notes"),
    item("PAY_HISTORY", "MISSING"),
    item("BPO", "PRESENT"),
  ];
  const risks = [check("BANKRUPTCY", "CLEAR", 30), check("BANKRUPTCY", "FLAG", 1), check("TAX", "CLEAR", 2), check("OCCUPANCY", "UNKNOWN", 2)];
  const note = {
    lienPosition: "FIRST",
    upb: 98000,
    paymentStatus: "PERFORMING",
    verifiedFields: {
      upb: { at: "2026-10-02T15:00:00.000Z", by: "desk", source: "Pay history", value: "98000" },
      paymentStatus: { at: "2026-10-02T15:00:00.000Z", by: "desk", source: "Pay history", value: "PERFORMING", document: "SUB_PERFORMING" },
    },
  };
  const file = completeness(note, collateral, risks, { holder: "Harbor Notes Fund" });
  // Note, mortgage, two assignments, pay history and BPO, plus the title policy and O&E nobody has looked at.
  assert.deepEqual(file.collateral, { present: 4, required: 8, missing: 1, defective: 1, unreviewed: 2 });
  assert.deepEqual(file.checks, { run: 3, total: 5, flagged: 1, unknown: 1 });
  assert.deepEqual(file.fields, { verified: 1, total: KEY_FIELDS.length, disputed: 1 });
  assert.deepEqual(file.defects.map((defect) => [defect.kind, defect.status, defect.cureOwner]), [["MORTGAGE", "DEFECTIVE", "Seller"], ["PAY_HISTORY", "MISSING", ""]]);
  assert.equal(file.chainBreaks, 0);
  assert.equal(file.reviewed, true);
  assert.equal(completenessLine(file), `4 of 8 on file · 3 of 5 checks · 1 of ${KEY_FIELDS.length} fields verified · 2 open defects`);
  for (const key of ["score", "grade", "rating"]) assert.ok(!(key in file));
});

test("the chain of title shows gaps, a wrong last holder and missing links in words", () => {
  const items = [
    link("ASSIGNMENT", 1, "First Bank NA", "Coastal Capital"),
    link("ASSIGNMENT", 2, "Bayview Loan Servicing", "Harbor Notes LLC"),
    link("ALLONGE", 1, "First Bank", "In blank"),
    link("ALLONGE", 2, "Anyone holding it", "Harbor Notes", "MISSING"),
  ];
  const chain = chainOfTitle(items, "Harbor Notes");
  assert.equal(chain.assignments.links[1].gap, true);
  assert.match(chain.assignments.breaks[0].message, /Nothing on file moves it from Coastal Capital to Bayview Loan Servicing/);
  // A blank endorsement is bearer paper, so the next holder may endorse it on.
  assert.equal(chain.endorsements.links[1].gap, false);
  assert.match(chain.endorsements.breaks[0].message, /step 2 is missing/);
  // The missing link is a collateral defect already, so only the gap counts as a break.
  assert.equal(chain.breaks, 1);

  const wrongHolder = chainOfTitle([link("ASSIGNMENT", 1, "First Bank", "Coastal Capital")], "Harbor Notes");
  assert.match(wrongHolder.assignments.breaks[0].message, /ends with Coastal Capital, not the seller on file, Harbor Notes/);
  const waived = chainOfTitle([item("ASSIGNMENT", "NOT_REQUIRED", { detail: chainDetail("", "", "Seller originated the loan") })], "Harbor Notes");
  assert.equal(waived.assignments.waived, "Seller originated the loan");
  assert.equal(waived.breaks, 0);
  assert.equal(chainOfTitle([link("ALLONGE", 1, "First Bank", "")], null).endorsements.breaks.length, 1);
});

test("chain parties round-trip through the line's detail, and legal forms don't split a party", () => {
  assert.deepEqual(chainParties(chainDetail("First Bank → Trust", "Coastal  Capital", "recorded late")), { from: "First Bank - Trust", to: "Coastal Capital", note: "recorded late" });
  assert.deepEqual(chainParties("Lost note affidavit on file"), { from: "", to: "", note: "Lost note affidavit on file" });
  assert.equal(partyKey("First Bank, N.A."), partyKey("First Bank NA"));
  assert.equal(partyKey("The Coastal Capital Co."), "coastal capital");
});

test("super-lien states flag condos, and houses only where the rule reaches an HOA", () => {
  assert.equal(superLien({ state: "NV", propertyType: "CONDO" })?.label, "HOA super-lien state");
  assert.equal(superLien({ state: "nv", propertyType: "SFR", hoaLien: true })?.label, "Open HOA lien · super-lien state");
  const maybe = superLien({ state: "CO", propertyType: "SFR" });
  assert.equal(maybe?.certain, false);
  assert.equal(maybe?.label, "Super-lien state if in an HOA");
  assert.equal(superLien({ state: "CO", propertyType: "SFR", hoaLien: false }), null);
  assert.equal(superLien({ state: "FL", propertyType: "CONDO" })?.certain, true);
  assert.equal(superLien({ state: "FL", propertyType: "SFR", hoaLien: true }), null);
  assert.equal(superLien({ state: "DC", propertyType: "TOWNHOUSE" }), null);
  assert.equal(superLien({ state: "TX", propertyType: "CONDO", hoaLien: true }), null);
  assert.equal(superLien({ state: "NV", propertyType: "LAND" }), null);
  assert.match(superLien({ state: "NV", propertyType: "CONDO" })?.cite ?? "", /NRS 116\.3116/);
});

test("a field is verified only for the value the desk checked", () => {
  const at = "2026-10-02T15:00:00.000Z";
  const note = (upb: number, verifiedFields: unknown) => ({ upb, lastPaidDate: new Date("2026-09-01T00:00:00Z"), borrowerName: "Ana Ruiz", verifiedFields });
  assert.deepEqual(fieldState(note(98000, null), "upb"), { state: "seller-stated" });
  const verified = fieldState(note(98000, { upb: { at, by: "u1", source: "Pay history", value: "98000" } }), "upb");
  assert.equal(verified.state, "verified");
  assert.ok(verified.state === "verified" && verified.source === "Pay history" && verified.by === "u1" && verified.at.toISOString() === at);
  // The tape moved after the check, so it reads as the seller's again.
  const stale = fieldState(note(99000, { upb: { at, by: "u1", source: "Pay history", value: "98000" } }), "upb");
  assert.equal(stale.state, "seller-stated");
  assert.ok(stale.state === "seller-stated" && stale.changed?.source === "Pay history");
  const disputed = fieldState(note(98000, { upb: { at, by: "u1", source: "Pay history", value: "98000", document: "97500" } }), "upb");
  assert.ok(disputed.state === "disputed" && disputed.document === "97500");
  // Dates and names compare by value, not by spelling.
  assert.equal(fieldState(note(1, { lastPaidDate: { at, by: "u1", source: "Pay history", value: "2026-09-01" } }), "lastPaidDate").state, "verified");
  assert.equal(fieldState(note(1, { borrowerName: { at, by: "u1", source: "Original note", value: "ANA RUIZ" } }), "borrowerName").state, "verified");
  assert.equal(fieldState(note(1, { upb: { at: "not a date", source: "Pay history" } }), "upb").state, "seller-stated");
  assert.equal(fieldState(note(1, { upb: "yes" }), "upb").state, "seller-stated");
  assert.equal(fieldState(note(1, { madeUp: { at, by: "u1", source: "Other" } }), "madeUp").state, "seller-stated");
});

test("a loan's own file follows the loan's street and borrower, not the listing's room", () => {
  const listing = { authorizationKey: "" };
  assert.equal(isPrivateDocument({ type: "OE_REPORT", storedName: "oe.pdf", noteId: "n1" }, listing), true);
  assert.equal(isPrivateDocument({ type: "OE_REPORT", storedName: "oe.pdf", noteId: null }, listing), false);
  const base = { owner: false, admin: false, ownNda: false, privateFile: true, proBuyer: true, signedNda: true, listingStatus: "APPROVED", closingParty: false };
  const access = (tradeStatus: string, extra: { signedNda?: boolean; wholeParty?: boolean; loanIds?: string[]; listingStatus?: string; listingId?: string } = {}) =>
    loanFileAccess({
      note: { id: "n1", listingId: "l1", tradeStatus },
      listingId: extra.listingId ?? "l1",
      listingStatus: extra.listingStatus ?? "APPROVED",
      signedNda: extra.signedNda ?? true,
      wholeParty: extra.wholeParty ?? false,
      loanIds: extra.loanIds ?? [],
    });
  // A Pro buyer with the NDA opens a loan still for sale. Without the NDA, or without Pro, it stays shut.
  assert.equal(canReadDocument({ ...base, loan: access("AVAILABLE") }), true);
  assert.equal(canReadDocument({ ...base, signedNda: false, loan: access("AVAILABLE", { signedNda: false }) }), false);
  assert.equal(canReadDocument({ ...base, proBuyer: false, loan: access("AVAILABLE") }), false);
  // Sold out of a pool still on the book: only that loan's buyer, Pro or not.
  assert.equal(canReadDocument({ ...base, closingParty: true, loan: access("SOLD", { loanIds: ["n2"] }) }), false);
  assert.equal(canReadDocument({ ...base, proBuyer: false, closingParty: true, loan: access("SOLD", { loanIds: ["n1"] }) }), true);
  assert.equal(canReadDocument({ ...base, loan: access("IN_CONTRACT") }), false);
  // Once the listing is in contract, the room closes to everyone but the deal.
  assert.equal(canReadDocument({ ...base, loan: access("AVAILABLE", { listingStatus: "PENDING" }) }), false);
  assert.equal(canReadDocument({ ...base, closingParty: true, loan: access("AVAILABLE", { listingStatus: "PENDING", wholeParty: true }) }), true);
  // The desk and the seller always open it. A file pointed at another listing's loan opens to no buyer.
  assert.equal(canReadDocument({ ...base, admin: true, loan: access("SOLD") }), true);
  assert.equal(canReadDocument({ ...base, owner: true, loan: access("SOLD") }), true);
  assert.equal(canReadDocument({ ...base, loan: access("AVAILABLE", { listingId: "l2" }) }), false);
  assert.equal(canReadDocument({ ...base, loan: loanFileAccess({ note: null, listingId: "l1", listingStatus: "APPROVED", signedNda: true, wholeParty: true, loanIds: [] }) }), false);
  // A loan file that reaches the route without its loan rule stays shut, as a private file.
  assert.equal(canReadDocument({ ...base, loan: null }), false);
});

test("the new document types have labels", () => {
  assert.equal(docLabel("OE_REPORT"), "O&E report");
  assert.equal(docLabel("RISK_SEARCH"), "Risk search");
  assert.equal(docLabel("ALLONGE"), "Allonge");
  assert.equal(docLabel("ASSIGNMENT"), "Assignment");
  assert.equal(docLabel("TAPE"), "Loan tape");
  assert.equal(docLabel("NOTE"), "Note");
});

test("the desk's collateral, chain, risk and field writes keep order and refuse what doesn't belong", async () => {
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const seller = await prisma.user.create({ data: { email: `lf-seller-${tag}@example.org`, name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const desk = await prisma.user.create({ data: { email: `lf-desk-${tag}@upbcapital.test`, name: `Desk ${tag}`, role: "ADMIN", accountStatus: "APPROVED", passwordHash: "x" } });
  const loan = {
    streetAddress: "1 First St", city: "Reno", state: "NV", zip: "89501", propertyType: "CONDO", occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: 80000, estimatedValue: 150000, lastPaidDate: new Date("2026-10-01T00:00:00Z"),
  } as const;
  const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "APPROVED", title: `Loan file ${tag}`, notes: { create: [loan] } }, include: { notes: true } });
  const other = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "APPROVED", title: `Loan file other ${tag}`, notes: { create: [loan] } }, include: { notes: true } });
  const noteId = listing.notes[0].id;
  try {
    const first = await saveCollateralItem(desk.id, { noteId, kind: "ASSIGNMENT", status: "PRESENT", detail: chainDetail("First Bank", "Coastal Capital"), recording: "2019-004512", recordedAt: "2019-03-04" });
    const second = await saveCollateralItem(desk.id, { noteId, kind: "ASSIGNMENT", status: "PRESENT", detail: chainDetail("Coastal Capital", `Seller ${tag}`) });
    const third = await saveCollateralItem(desk.id, { noteId, kind: "ASSIGNMENT", status: "MISSING", detail: chainDetail("Bayview", "Coastal Capital"), cureOwner: "Seller", cureBy: "2026-12-01" });
    assert.ok(first.ok && second.ok && third.ok);
    assert.deepEqual([first.value.sequence, second.value.sequence, third.value.sequence], [1, 2, 3]);
    assert.equal(first.value.recordedAt?.toISOString().slice(0, 10), "2019-03-04");
    assert.equal(first.value.updatedById, desk.id);

    // The missing link belongs first, then one is dropped and the chain closes up without a hole.
    assert.ok((await moveChainLink(desk.id, { noteId, id: third.value.id, direction: "up" })).ok);
    assert.ok((await moveChainLink(desk.id, { noteId, id: third.value.id, direction: "up" })).ok);
    const order = async () => (await prisma.collateralItem.findMany({ where: { noteId, kind: "ASSIGNMENT" }, orderBy: { sequence: "asc" } })).map((row) => [row.id, row.sequence]);
    assert.deepEqual(await order(), [[third.value.id, 1], [first.value.id, 2], [second.value.id, 3]]);
    assert.ok((await removeCollateralItem(desk.id, { noteId, id: first.value.id })).ok);
    assert.deepEqual(await order(), [[third.value.id, 1], [second.value.id, 2]]);

    // An edit keeps the line's kind and place, and a line or file from another loan is refused.
    const fixed = await saveCollateralItem(desk.id, { id: third.value.id, noteId, kind: "ORIGINAL_NOTE", status: "PRESENT", detail: chainDetail("First Bank", "Coastal Capital") });
    assert.ok(fixed.ok && fixed.value.kind === "ASSIGNMENT" && fixed.value.sequence === 1 && fixed.value.status === "PRESENT");
    const stranger = await prisma.document.create({ data: { listingId: other.id, type: "OE_REPORT", originalName: "oe.pdf", storedName: `lf-${tag}.pdf`, mime: "application/pdf", size: 1 } });
    const refused = await saveCollateralItem(desk.id, { noteId, kind: "OE_REPORT", status: "PRESENT", documentId: stranger.id });
    assert.deepEqual(refused, { ok: false, error: "That file isn't on this loan." });
    assert.equal((await saveCollateralItem(desk.id, { id: third.value.id, noteId: other.notes[0].id, kind: "ASSIGNMENT", status: "MISSING" })).ok, false);
    assert.equal((await saveCollateralItem(desk.id, { noteId, kind: "ASSIGNMENT", status: "LOST" })).ok, false);
    assert.equal((await saveCollateralItem(desk.id, { noteId, kind: "BPO", status: "PRESENT", cureBy: "soon" })).ok, false);
    assert.equal((await removeCollateralItem(desk.id, { noteId: other.notes[0].id, id: second.value.id })).ok, false);

    const loanFile = chainOfTitle(await prisma.collateralItem.findMany({ where: { noteId } }), `Seller ${tag}`);
    assert.equal(loanFile.assignments.breaks.length, 0);

    // Risk checks are a log: the newest of each kind stands.
    assert.equal((await logRiskCheck(desk.id, { noteId, kind: "BANKRUPTCY", result: "CLEAR", source: " " })).ok, false);
    assert.equal((await logRiskCheck(desk.id, { noteId, kind: "BANKRUPTCY", result: "CLEAR", source: "PACER", checkedAt: new Date(Date.now() + 3 * DAY).toISOString() })).ok, false);
    assert.equal((await logRiskCheck(desk.id, { noteId, kind: "WEATHER", result: "CLEAR", source: "PACER" })).ok, false);
    const older = await logRiskCheck(desk.id, { noteId, kind: "BANKRUPTCY", result: "CLEAR", source: "PACER", checkedAt: "2026-09-01" });
    const newer = await logRiskCheck(desk.id, { noteId, kind: "BANKRUPTCY", result: "FLAG", source: "PACER", detail: "Chapter 13 filed" });
    assert.ok(older.ok && newer.ok && newer.value.checkedById === desk.id);
    const risks = await prisma.riskCheck.findMany({ where: { noteId } });
    const file = completeness(listing.notes[0], await prisma.collateralItem.findMany({ where: { noteId } }), risks);
    assert.deepEqual(file.checks, { run: 1, total: 5, flagged: 1, unknown: 0 });

    // Fields: confirmed as the tape reads, recorded as different, refused when unreadable, then cleared.
    assert.ok((await markFieldVerified(desk.id, { noteId, field: "upb", source: "Pay history", document: "$100,000" })).ok);
    assert.ok((await markFieldVerified(desk.id, { noteId, field: "lastPaidDate", source: "Pay history", document: "2026-09-01" })).ok);
    assert.equal((await markFieldVerified(desk.id, { noteId, field: "upb", source: "Pay history", document: "a lot" })).ok, false);
    assert.equal((await markFieldVerified(desk.id, { noteId, field: "nextDueDate", source: "Pay history" })).ok, false);
    assert.equal((await markFieldVerified(desk.id, { noteId, field: "notAField", source: "Other" })).ok, false);
    let saved = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
    assert.equal(fieldState(saved, "upb").state, "verified");
    const differs = fieldState(saved, "lastPaidDate");
    assert.ok(differs.state === "disputed" && differs.document === "2026-09-01");
    assert.ok((await clearFieldVerified(desk.id, { noteId, field: "upb" })).ok);
    saved = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
    assert.equal(fieldState(saved, "upb").state, "seller-stated");
    assert.equal(fieldState(saved, "lastPaidDate").state, "disputed");

    const events = await prisma.auditEvent.findMany({ where: { entityType: "note", entityId: noteId }, select: { action: true, detail: true } });
    for (const action of ["COLLATERAL_ADD", "COLLATERAL_UPDATE", "COLLATERAL_REORDER", "COLLATERAL_REMOVE", "RISK_CHECK", "FIELD_VERIFY", "FIELD_UNVERIFY"]) {
      assert.ok(events.some((event) => event.action === action), action);
    }
    // Values stay out of the audit trail.
    assert.ok(!events.some((event) => event.detail.includes("100000") || event.detail.includes("1 First St")));
  } finally {
    const noteIds = [...listing.notes, ...other.notes].map((note) => note.id);
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: noteIds } } });
    await prisma.collateralItem.deleteMany({ where: { noteId: { in: noteIds } } });
    await prisma.riskCheck.deleteMany({ where: { noteId: { in: noteIds } } });
    await prisma.document.deleteMany({ where: { listingId: { in: [listing.id, other.id] } } });
    await prisma.listing.deleteMany({ where: { id: { in: [listing.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [seller.id, desk.id] } } });
  }
});

test.after(async () => {
  await prisma.$disconnect();
});

test("an undated or unconfirmed allonge is flagged, and a mortgage held apart from the note is too", async () => {
  const { chainOfTitle, chainDetail } = await import("../lib/loan-file");
  const at = new Date("2026-10-01T00:00:00Z");
  const row = (id: string, kind: string, sequence: number, from: string, to: string, extra: Record<string, unknown> = {}) => ({
    id, kind, status: "PRESENT", sequence, detail: chainDetail(from, to), ...extra,
  });
  const loose = chainOfTitle([
    row("a1", "ALLONGE", 1, "First Bank", "Coastal Capital"),
    row("m1", "ASSIGNMENT", 1, "First Bank", "Harbor Trust"),
  ], "Coastal Capital");
  assert.deepEqual(loose.endorsements.cautions, [
    "The endorsement at step 1 is undated.",
    "The desk hasn't confirmed the endorsement at step 1 is fixed to the note.",
  ]);
  assert.equal(loose.cautions.length, 1);
  assert.match(loose.cautions[0], /different party than the note/);
  // Party names never appear in a caution, so closed viewers can read them.
  assert.ok(![...loose.cautions, ...loose.endorsements.cautions].some((text) => /Coastal|Harbor|First Bank/.test(text)));

  const clean = chainOfTitle([
    row("a1", "ALLONGE", 1, "First Bank", "Coastal Capital", { datedOn: at, attachedAt: at }),
    row("m1", "ASSIGNMENT", 1, "First Bank", "Coastal Capital, LLC"),
  ], "Coastal Capital");
  assert.deepEqual(clean.endorsements.cautions, []);
  assert.deepEqual(clean.cautions, []);
});

test("a tape corrected to the document's value reads as desk-verified", () => {
  const at = "2026-10-02T15:00:00.000Z";
  const note = (upb: number) => ({ upb, verifiedFields: { upb: { at, by: "u1", source: "Pay history", value: "98000", document: "97500" } } });
  assert.equal(fieldState(note(98000), "upb").state, "disputed");
  const corrected = fieldState(note(97500), "upb");
  assert.ok(corrected.state === "verified" && corrected.source === "Pay history" && corrected.at.toISOString() === at);
  // Any other value is the seller's again.
  assert.equal(fieldState(note(96000), "upb").state, "seller-stated");
});

test("an allonge records its endorsement, loan number match and intake photo, and other lines don't", async () => {
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const seller = await prisma.user.create({ data: { email: `lf2-seller-${tag}@example.org`, name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const loan = {
    streetAddress: "2 Second St", city: "Reno", state: "NV", zip: "89501", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: 80000, estimatedValue: 150000,
  } as const;
  const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "UNDER_REVIEW", title: `Allonge ${tag}`, notes: { create: [loan] } }, include: { notes: true } });
  const other = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "UNDER_REVIEW", title: `Allonge other ${tag}`, notes: { create: [loan] } }, include: { notes: true } });
  const noteId = listing.notes[0].id;
  try {
    const photo = await prisma.document.create({ data: { listingId: listing.id, noteId, type: "ALLONGE", originalName: "allonge.jpg", storedName: `lf2-${tag}.jpg`, mime: "image/jpeg", size: 1 } });
    const stranger = await prisma.document.create({ data: { listingId: other.id, type: "ALLONGE", originalName: "x.jpg", storedName: `lf2-x-${tag}.jpg`, mime: "image/jpeg", size: 1 } });
    const saved = await saveCollateralItem(seller.id, {
      noteId, kind: "ALLONGE", status: "PRESENT", detail: chainDetail("First Bank", ""), endorsement: "BLANK", loanNumberMatch: false,
      photoDocumentId: photo.id, datedOn: "2019-03-01", attachedAt: "2019-03-04",
    });
    assert.ok(saved.ok);
    assert.deepEqual([saved.value.endorsement, saved.value.loanNumberMatch, saved.value.photoDocumentId], ["BLANK", false, photo.id]);
    assert.deepEqual(await saveCollateralItem(seller.id, { noteId, kind: "ALLONGE", status: "PRESENT", endorsement: "STAMPED" }), { ok: false, error: "Pick how the allonge is endorsed." });
    assert.deepEqual(await saveCollateralItem(seller.id, { noteId, kind: "ALLONGE", status: "PRESENT", photoDocumentId: stranger.id }), { ok: false, error: "That file isn't on this loan." });
    // An endorsement belongs to an allonge only, so a note line drops it.
    const face = await saveCollateralItem(seller.id, { noteId, kind: "ORIGINAL_NOTE", status: "PRESENT", endorsement: "SPECIAL", loanNumberMatch: true, photoDocumentId: photo.id });
    assert.ok(face.ok && face.value.endorsement === null && face.value.loanNumberMatch === null && face.value.photoDocumentId === photo.id);
    const chain = chainOfTitle(await prisma.collateralItem.findMany({ where: { noteId } }), `Seller ${tag}`, { listedAt: listing.submittedAt });
    assert.equal(chain.endorsements.endsInBlank, true);
    assert.deepEqual(chain.endorsements.cautions, ["The loan number on the endorsement at step 1 doesn't match the note."]);
  } finally {
    const noteIds = [...listing.notes, ...other.notes].map((note) => note.id);
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: noteIds } } });
    await prisma.collateralItem.deleteMany({ where: { noteId: { in: noteIds } } });
    await prisma.document.deleteMany({ where: { listingId: { in: [listing.id, other.id] } } });
    await prisma.listing.deleteMany({ where: { id: { in: [listing.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: seller.id } });
  }
});
