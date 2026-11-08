import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { CollateralKind, CollateralStatus } from "@prisma/client";
import { literal } from "../lib/db-filters";
import {
  askTapeChanges,
  bandLabel,
  clearSellerConfirmation,
  confirmDeskTape,
  deskIntakeHold,
  fileDeskIntake,
  intakeCookieValue,
  parseBands,
  readIntakeCookie,
  readIntakeTape,
  RECONFIRM_LINE,
  reopenDeskTape,
  SELLER_CONFIRM_HOLD,
  splitIntoPools,
} from "../lib/desk-intake";
import { listingChanges, sellerEditNotice } from "../lib/desk-edits";
import { buyerDiligence, clearDiligenceWaiver, diligenceChecklist, diligenceHold, loadDiligence, readWaivers, waiveDiligence } from "../lib/diligence-checklist";
import { prisma } from "../lib/prisma";
import { launchReadiness } from "../lib/readiness";
import { DESK_DENIED } from "../lib/staff";
import { uploadDir } from "../lib/storage";
import { parseTapeBuffer } from "../lib/tape";
import { compareTieOut, readClosingTape, readTieOut, runTieOut, tieOutUpbChange, type TieOutNote } from "../lib/tie-out";

// Files go to local disk, mail to the log, and screens to the short local list, whatever the shared .env says.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "VERCEL", "RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY", "UPB_RELEASE"]) {
  process.env[key] = "";
}

test.after(async () => {
  await prisma.$disconnect();
});

const csv = (rows: (string | number)[][]) => Buffer.from(rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n"));

// ---------------------------------------------------------------------------------------------------------------
// Tagged people and listings nothing seeded touches. Desk fixtures are never approved, so other tests' desk mail
// passes them by, and every row this file makes is removed by id.

type Role = "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BUYER" | "ADMIN";

async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string; email: string }[] = [];
  const listingIds: string[] = [];
  const closingIds: string[] = [];
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: {
        email: `c-intake-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        companyName: role === "ADMIN" ? "" : `${prefix} Notes ${tag}`,
        role,
        accountStatus: role === "ADMIN" ? "PENDING" : "APPROVED",
        passwordHash: "x",
        ...extra,
      },
    });
    users.push(user);
    return user;
  };
  return { tag, users, listingIds, closingIds, person };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const userIds = world.users.map((user) => user.id);
  const emails = world.users.map((user) => user.email);
  const listings = await prisma.listing.findMany({ where: { OR: [{ id: { in: world.listingIds } }, { sellerId: { in: userIds } }] }, select: { id: true } });
  const listingIds = listings.map((listing) => listing.id);
  const closings = await prisma.closing.findMany({ where: { OR: [{ id: { in: world.closingIds } }, { listingId: { in: listingIds } }] }, select: { id: true } });
  const closingIds = closings.map((closing) => closing.id);
  const steps = await prisma.closingStep.findMany({ where: { closingId: { in: closingIds } }, select: { id: true } });
  const files = await prisma.closingFile.findMany({ where: { stepId: { in: steps.map((step) => step.id) } }, select: { storageKey: true } });
  const documents = await prisma.document.findMany({ where: { listingId: { in: listingIds } }, select: { storedName: true } });
  const notes = await prisma.note.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
  await prisma.closingFile.deleteMany({ where: { stepId: { in: steps.map((step) => step.id) } } });
  await prisma.closingStep.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.closing.deleteMany({ where: { id: { in: closingIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.collateralItem.deleteMany({ where: { noteId: { in: notes.map((note) => note.id) } } });
  await prisma.document.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.reviewComment.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.ofacCheck.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { userId: { in: userIds } }, { name: { contains: literal(world.tag) } }] } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: emails } }, { subject: { contains: literal(world.tag) } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await Promise.all([...documents.map((row) => row.storedName), ...files.map((row) => row.storageKey)].map((key) => fs.rm(path.join(uploadDir(), key), { force: true })));
}

const HEADERS = ["Loan Number", "Street Address", "City", "State", "Zip", "Property Type", "Lien Position", "UPB", "Interest Rate", "Estimated Value", "Payment Status", "Asking Price", "Next Due Date"];

function tapeRows(tag: string) {
  return [
    HEADERS,
    [`LN-${tag}-1`, `11 Gulf Way ${tag}`, "Tampa", "FL", "33602", "SFR", "1st", "80000", "6.5", "150000", "Performing", "72000", "2026-12-01"],
    [`LN-${tag}-2`, `12 Gulf Way ${tag}`, "Orlando", "FL", "32801", "SFR", "2nd", "40000", "9.25", "210000", "Non-performing", "18000", "2026-03-01"],
    [`LN-${tag}-3`, `13 Pecan St ${tag}`, "Austin", "TX", "78701", "Condo", "1st", "260000", "5.75", "400000", "Performing", "240000", "2026-12-01"],
    [`LN-${tag}-4`, `14 Pecan St ${tag}`, "Dallas", "TX", "75201", "SFR", "1st", "120000", "7", "190000", "Sub-performing", "96000", "2026-10-01"],
  ];
}

// ---------------------------------------------------------------------------------------------------------------

test("a tape splits into pools by state, by lien and status together, and by balance band", () => {
  const read = readIntakeTape({ filename: "seller.csv", bytes: csv(tapeRows("p")), priceMode: "COLUMN" });
  assert.ok(read.ok);
  const tape = read.value;
  assert.equal(tape.loans.length, 4);
  assert.equal(tape.errors.length, 0);
  // Each loan keeps its source row, so a pool's data room gets only its own rows.
  assert.equal(tape.rows.length, 4);
  assert.equal(tape.rows[2]["Street Address"], "13 Pecan St p");

  const none = splitIntoPools(tape.loans, { rules: [], bands: [] });
  assert.equal(none.length, 1);
  assert.equal(none[0].label, "");
  assert.equal(none[0].upb, 500000);

  const byState = splitIntoPools(tape.loans, { rules: ["STATE"], bands: [] });
  assert.deepEqual(byState.map((pool) => [pool.label, pool.loans.length, pool.upb]), [["FL", 2, 120000], ["TX", 2, 380000]]);

  // Rules combine, in a fixed order: first liens before seconds, performing before non-performing.
  const byLienAndStatus = splitIntoPools(tape.loans, { rules: ["PERFORMANCE", "LIEN"], bands: [] });
  assert.deepEqual(byLienAndStatus.map((pool) => pool.label), ["First lien · Performing", "First lien · Sub-performing", "Second lien · Non-performing"]);
  assert.equal(byLienAndStatus[0].loans.length, 2);

  const bands = parseBands("250k, 100000");
  assert.deepEqual(bands, [100000, 250000]);
  assert.equal(parseBands("100k, lots"), null);
  assert.equal(bandLabel(0, bands!), "Under $100,000");
  assert.equal(bandLabel(1, bands!), "$100,000 to $250,000");
  assert.equal(bandLabel(2, bands!), "$250,000 and over");
  const byBand = splitIntoPools(tape.loans, { rules: ["BALANCE"], bands: bands! });
  assert.deepEqual(byBand.map((pool) => [pool.label, pool.loans.length]), [["Under $100,000", 2], ["$100,000 to $250,000", 1], ["$250,000 and over", 1]]);

  // A percent price reprices every loan, and a bad percent or a broken row is refused before anything is filed.
  const priced = readIntakeTape({ filename: "seller.csv", bytes: csv(tapeRows("p")), priceMode: "PERCENT", percent: 50 });
  assert.ok(priced.ok);
  assert.equal(priced.value.loans[0].askingPrice, 40000);
  assert.equal(readIntakeTape({ filename: "seller.csv", bytes: csv(tapeRows("p")), priceMode: "PERCENT", percent: 400 }).ok, false);
  const broken = readIntakeTape({ filename: "seller.csv", bytes: csv([...tapeRows("p"), ["", "", "Miami", "ZZ", "", "SFR", "1st", "1", "5", "1", "Performing", "1", ""]]), priceMode: "COLUMN" });
  assert.ok(broken.ok);
  assert.match(broken.value.errors[0].message, /state is not a US state/);
  assert.equal(broken.value.rows.length, 0);

  // The staged cookie round-trips, and a tampered one reads as nothing.
  const staged = { token: crypto.randomUUID(), sellerId: "c1234567890abcdef", priceMode: "PERCENT" as const, percent: 82.5, rules: ["STATE" as const], bands: [] };
  assert.deepEqual(readIntakeCookie(intakeCookieValue(staged)), staged);
  assert.equal(readIntakeCookie("not-json"), null);
  assert.equal(readIntakeCookie(intakeCookieValue({ ...staged, token: "x" })), null);
});

test("the desk files one listing per pool for the seller, and approval waits until the seller confirms", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INSTITUTIONAL_SELLER");
    const stranger = await world.person("stranger", "INSTITUTIONAL_SELLER");
    const desk = await world.person("desk", "ADMIN", { deskRole: "SALES" });
    const compliance = await world.person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    const pending = await world.person("pending", "INSTITUTIONAL_SELLER", { accountStatus: "PENDING" });
    const input = { sellerId: seller.id, filename: "bank tape.xlsx.csv", bytes: csv(tapeRows(world.tag)), priceMode: "COLUMN" as const, rules: ["STATE" as const], bands: [], title: `Gulf Bank ${world.tag}`, background: false };

    assert.deepEqual(await fileDeskIntake(compliance, input), { ok: false, error: DESK_DENIED });
    assert.deepEqual(await fileDeskIntake(desk, { ...input, sellerId: pending.id }), { ok: false, error: "That seller's account isn't approved yet." });
    assert.deepEqual(await fileDeskIntake(desk, { ...input, sellerId: desk.id }), { ok: false, error: "Choose the seller's account." });
    assert.deepEqual(await fileDeskIntake(desk, { ...input, rules: ["BALANCE"] }), { ok: false, error: "Enter the balance edges for the bands, such as 100k, 250k." });

    const filed = await fileDeskIntake(desk, input);
    assert.ok(filed.ok, filed.ok ? "" : filed.error);
    world.listingIds.push(...filed.value.map((pool) => pool.id));
    assert.deepEqual(filed.value.map((pool) => [pool.title, pool.loans]), [[`Gulf Bank ${world.tag} · FL`, 2], [`Gulf Bank ${world.tag} · TX`, 2]]);

    const listings = await prisma.listing.findMany({ where: { id: { in: world.listingIds } }, include: { notes: true, documents: true }, orderBy: { title: "asc" } });
    for (const listing of listings) {
      assert.equal(listing.sellerId, seller.id);
      assert.equal(listing.status, "SUBMITTED");
      assert.equal(listing.kind, "POOL");
      assert.equal(listing.filedByDeskId, desk.id);
      assert.equal(listing.sellerConfirmedAt ?? null, null);
      assert.equal(deskIntakeHold(listing), SELLER_CONFIRM_HOLD);
    }
    // Each pool's tape holds its own rows and never the other pool's.
    const [florida, texas] = listings;
    assert.deepEqual(florida.notes.map((note) => note.state).sort(), ["FL", "FL"]);
    assert.equal(florida.notes.find((note) => note.city === "Tampa")?.loanNumber, `LN-${world.tag}-1`);
    const floridaTape = await fs.readFile(path.join(uploadDir(), florida.documents.find((doc) => doc.type === "TAPE")!.storedName), "utf8");
    assert.match(floridaTape, /Gulf Way/);
    assert.doesNotMatch(floridaTape, /Pecan St/);
    assert.equal(texas.documents.filter((doc) => doc.type === "TAPE").length, 1);

    // The seller hears once, with a link to each listing.
    const notices = await prisma.notification.findMany({ where: { toEmail: seller.email } });
    assert.equal(notices.length, 1);
    assert.match(notices[0].subject, /^Tape filed for you/);
    assert.ok(notices[0].body.includes(`/seller/listings/${florida.id}`) && notices[0].body.includes(`/seller/listings/${texas.id}`));
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "DESK_INTAKE", entityId: florida.id, actorId: desk.id } }));

    // Only the seller of record answers.
    assert.deepEqual(await confirmDeskTape(stranger, florida.id), { ok: false, error: "That listing isn't yours." });
    assert.deepEqual(await confirmDeskTape(desk, florida.id), { ok: false, error: "That listing isn't yours." });
    assert.deepEqual(await askTapeChanges(seller, florida.id, "no"), { ok: false, error: "Say what should change." });
    assert.deepEqual(await askTapeChanges(seller, florida.id, "Loan 2's balance is 39,500 now."), { ok: true, value: { title: florida.title } });
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "DESK_INTAKE_CHANGES", entityId: florida.id } }));
    assert.equal(deskIntakeHold((await prisma.listing.findUniqueOrThrow({ where: { id: florida.id } }))), SELLER_CONFIRM_HOLD);

    assert.equal((await launchReadiness({}, {})).items.find((item) => item.label === "Desk-filed tapes")?.state, "live");

    const now = new Date("2026-11-08T12:00:00.000Z");
    assert.deepEqual(await confirmDeskTape(seller, florida.id, now), { ok: true, value: { title: florida.title } });
    const confirmed = await prisma.listing.findUniqueOrThrow({ where: { id: florida.id } });
    assert.equal(confirmed.sellerConfirmedAt?.toISOString(), now.toISOString());
    assert.equal(confirmed.sellerConfirmedById, seller.id);
    assert.equal(deskIntakeHold(confirmed), null);
    assert.deepEqual(await confirmDeskTape(seller, florida.id), { ok: false, error: "You already confirmed this tape." });
    // The other pool still waits.
    assert.equal(deskIntakeHold(await prisma.listing.findUniqueOrThrow({ where: { id: texas.id } })), SELLER_CONFIRM_HOLD);
    // A listing the seller filed themselves has nothing to confirm.
    const own = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, title: `Own ${world.tag}`, status: "SUBMITTED" } });
    world.listingIds.push(own.id);
    assert.equal(deskIntakeHold(own), null);
    assert.deepEqual(await confirmDeskTape(seller, own.id), { ok: false, error: "You filed this listing yourself, so there is nothing to confirm." });
  } finally {
    await cleanWorld(world);
  }
});

test("a desk edit after the seller confirms clears the confirmation, and approval waits until they confirm again", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("rseller", "INSTITUTIONAL_SELLER");
    const desk = await world.person("rdesk", "ADMIN", { deskRole: "SALES" });
    const filed = await fileDeskIntake(desk, { sellerId: seller.id, filename: "tape.csv", bytes: csv(tapeRows(world.tag)), priceMode: "COLUMN", rules: [], bands: [], title: `Reconfirm ${world.tag}`, background: false });
    assert.ok(filed.ok, filed.ok ? "" : filed.error);
    const listingId = filed.value[0].id;
    world.listingIds.push(listingId);
    assert.equal((await confirmDeskTape(seller, listingId)).ok, true);
    assert.equal(deskIntakeHold(await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })), null);

    // The desk's edit, as adminUpdateListing makes it: save, read F's field diff back, then clear the confirmation.
    const before = await prisma.listing.findUniqueOrThrow({ where: { id: listingId }, include: { notes: true } });
    const tampa = before.notes.find((note) => note.city === "Tampa")!;
    await prisma.note.update({ where: { id: tampa.id }, data: { upb: 79500 } });
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listingId }, include: { notes: true } });
    const changes = listingChanges(before, after);
    assert.deepEqual(changes.map((change) => change.label), ["Loan in Tampa, FL: UPB"]);
    assert.equal(await clearSellerConfirmation(desk.id, listingId, changes.map((change) => change.label).join(", ")), true);
    const cleared = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    assert.equal(cleared.sellerConfirmedAt, null);
    assert.equal(cleared.sellerConfirmedById, null);
    assert.equal(deskIntakeHold(cleared), SELLER_CONFIRM_HOLD);
    assert.match((await prisma.auditEvent.findFirst({ where: { action: "DESK_INTAKE_UNCONFIRMED", entityId: listingId } }))?.detail ?? "", /Loan in Tampa, FL: UPB/);
    assert.match(`${sellerEditNotice("Servicer's payoff", changes)} ${RECONFIRM_LINE}`, /changed Loan in Tampa, FL: UPB on your listing.*confirm the tape again/);
    // Nothing to clear a second time.
    assert.equal(await clearSellerConfirmation(desk.id, listingId, "UPB"), false);

    // The seller confirms again, and the desk's other tape paths (a document's value, a reprice, a servicer
    // report) clear it the same way and tell the seller what changed.
    assert.equal((await confirmDeskTape(seller, listingId)).ok, true);
    assert.equal(deskIntakeHold(await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })), null);
    assert.equal(await reopenDeskTape(desk.id, listingId, "the asking price on 4 loans to 80% of UPB"), true);
    assert.equal(deskIntakeHold(await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })), SELLER_CONFIRM_HOLD);
    const notice = await prisma.notification.findFirst({ where: { toEmail: seller.email, subject: { startsWith: "Confirm your tape again" } } });
    assert.match(notice?.body ?? "", /^The desk changed the asking price on 4 loans to 80% of UPB on the tape it filed for you\. You had confirmed this tape/);

    // An approved listing, or one the seller filed, keeps its state.
    await confirmDeskTape(seller, listingId);
    await prisma.listing.update({ where: { id: listingId }, data: { status: "APPROVED" } });
    assert.equal(await reopenDeskTape(desk.id, listingId, "UPB"), false);
    assert.ok((await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).sellerConfirmedAt);

    // Every desk path that writes a desk-filed tape before approval clears the confirmation.
    const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8");
    const admin = await read("actions/admin.ts");
    const update = admin.slice(admin.indexOf("export async function adminUpdateListing"), admin.indexOf("export async function decideInquiry"));
    assert.ok(update.indexOf("listingChanges(") < update.indexOf("clearSellerConfirmation(") && update.includes("RECONFIRM_LINE"));
    for (const file of ["actions/discrepancies.ts", "actions/desk.ts", "actions/servicer-import.ts"]) assert.match(await read(file), /reopenDeskTape\(/, file);
  } finally {
    await cleanWorld(world);
  }
});

test("the desk's approval checks the seller's confirmation and the diligence set after the existing gates", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "actions/admin.ts"), "utf8");
  const approve = source.slice(source.indexOf('if (action === "APPROVE")'), source.indexOf('if (action === "REJECT")'));
  const at = (needle: string) => approve.indexOf(needle);
  for (const needle of ["approvalHold(", "sellerIdentityHold(", "deskIntakeHold(", "diligenceHold(", "screenListing(", 'status: "APPROVED"']) assert.ok(at(needle) > 0, needle);
  assert.ok(at("approvalHold(") < at("deskIntakeHold(") && at("sellerIdentityHold(") < at("deskIntakeHold("));
  assert.ok(at("deskIntakeHold(") < at("diligenceHold(") && at("diligenceHold(") < at('status: "APPROVED"'));
});

// ---------------------------------------------------------------------------------------------------------------
// The diligence checklist

const loan = (id: string, extra: Record<string, unknown> = {}) => ({ id, streetAddress: `${id} Main`, city: "Tampa", state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING", ...extra });
const line = (noteId: string, kind: string, status = "PRESENT", extra: Record<string, unknown> = {}) => ({ id: `${noteId}-${kind}-${status}`, noteId, kind, status, sequence: 1, ...extra });
const fullFile = (noteId: string) => [
  line(noteId, "ORIGINAL_NOTE"),
  line(noteId, "MORTGAGE"),
  line(noteId, "PAY_HISTORY"),
  line(noteId, "OE_REPORT"),
  line(noteId, "BPO"),
  line(noteId, "ALLONGE", "PRESENT", { detail: "First Bank → Gulf Notes LLC", endorsement: "SPECIAL", datedOn: new Date("2020-01-01"), attachedAt: new Date("2020-01-01") }),
];

test("the checklist reads the loan file: a missing item, a waiver with a reason, and what the buyer sees", () => {
  const base = { kind: "POOL", holder: "Gulf Notes LLC", release: false, documents: [] as { type: string; noteId?: string | null; originalName: string }[] };
  // Loan a has everything. Loan b is non-performing, has no pay history (not asked) and its original note is lost.
  const notes = [loan("a", { servicerSourcedAt: new Date() }), loan("b", { paymentStatus: "NON_PERFORMING" }), loan("c")];
  const collateral = [...fullFile("a"), ...fullFile("b").filter((row) => row.kind !== "PAY_HISTORY" && row.kind !== "ORIGINAL_NOTE"), line("b", "ORIGINAL_NOTE", "MISSING", { detail: "Lost. Lost-note affidavit on file." }), ...fullFile("c").filter((row) => row.kind !== "PAY_HISTORY")];
  const first = diligenceChecklist({ ...base, notes, collateral });
  const by = (key: string) => first.lines.find((row) => row.key === key)!;
  assert.equal(by("NOTE").state, "complete");
  assert.equal(by("PAY_HISTORY").required, 2);
  assert.equal(by("PAY_HISTORY").state, "missing");
  assert.deepEqual(by("PAY_HISTORY").missing, [{ noteId: "c", label: "Loan 3 · Tampa, FL" }]);
  // The servicer import on loan a counts as the pool's servicer report.
  assert.equal(by("SERVICER_REPORT").state, "complete");
  assert.equal(first.complete, false);
  assert.equal(first.missing, 1);

  // A waiver on that one loan clears it, and the buyer reads the item and the reason, not the loan.
  const waivers = { "PAY_HISTORY:c": { by: "desk", at: "2026-11-08T00:00:00.000Z", reason: "Servicer transfer in progress; history follows at closing." }, BOGUS: { by: "x", at: "y", reason: "z" } };
  assert.deepEqual(Object.keys(readWaivers(waivers)), ["PAY_HISTORY:c"]);
  const waived = diligenceChecklist({ ...base, notes, collateral, waivers });
  assert.equal(waived.complete, true);
  assert.equal(waived.lines.find((row) => row.key === "PAY_HISTORY")!.state, "waived");
  assert.deepEqual(buyerDiligence(waived), { complete: false, waived: [{ key: "PAY_HISTORY", label: "Pay history", loans: 1, reasons: ["Servicer transfer in progress; history follows at closing."] }], missing: [] });

  // With everything on file the buyer reads "complete".
  const full = diligenceChecklist({ ...base, notes: notes.slice(0, 1), collateral: fullFile("a") });
  assert.equal(buyerDiligence(full).complete, true);

  // The desk's own review stands over an upload: a mortgage it marked missing stays missing beside a mortgage file.
  const marked = diligenceChecklist({ ...base, kind: "SINGLE", notes: [loan("d")], collateral: [line("d", "MORTGAGE", "MISSING")], documents: [{ type: "MORTGAGE", noteId: "d", originalName: "mortgage.pdf" }, { type: "NOTE", noteId: null, originalName: "note.pdf" }] });
  assert.equal(marked.lines.find((row) => row.key === "MORTGAGE")!.state, "missing");
  // A single note's listing-level files count for its one loan; a stand-in AVM with a date counts outside release mode.
  assert.equal(marked.lines.find((row) => row.key === "NOTE")!.state, "complete");
  assert.equal(marked.lines.find((row) => row.key === "SERVICER_REPORT")!.state, "not_required");
  const avm = { kind: "SINGLE", notes: [loan("e", { avmValue: 150000, avmProvider: "mock", avmAsOf: new Date() })], collateral: [], documents: [] };
  assert.equal(diligenceChecklist({ ...avm, release: false }).lines.find((row) => row.key === "VALUE")!.state, "complete");
  assert.equal(diligenceChecklist({ ...avm, release: true }).lines.find((row) => row.key === "VALUE")!.state, "missing");
  // A chain the desk recorded with a break isn't on file.
  const gap = diligenceChecklist({ ...avm, release: false, collateral: [line("e", "ALLONGE", "PRESENT", { detail: "First Bank → Other Fund" })], holder: "Gulf Notes LLC" });
  assert.equal(gap.lines.find((row) => row.key === "ENDORSEMENTS")!.state, "missing");
});

test("approval waits on a missing diligence item until compliance waives it with a reason", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("dseller", "INDIVIDUAL_SELLER", { companyName: "Gulf Notes LLC" });
    const sales = await world.person("dsales", "ADMIN", { deskRole: "SALES" });
    const compliance = await world.person("dcompliance", "ADMIN", { deskRole: "COMPLIANCE" });
    const listing = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId: seller.id,
        status: "UNDER_REVIEW",
        title: `Checklist ${world.tag}`,
        notes: { create: { streetAddress: `5 Bay Ct ${world.tag}`, city: "Tampa", state: "FL", propertyType: "SFR", lienPosition: "FIRST", upb: 90000, interestRate: 6, monthlyPi: 600, paymentStatus: "PERFORMING", estimatedValue: 160000, askingPrice: 80000 } },
      },
      include: { notes: true },
    });
    world.listingIds.push(listing.id);
    const noteId = listing.notes[0].id;
    for (const row of fullFile(noteId).filter((item) => item.kind !== "PAY_HISTORY")) {
      const extra = row as Record<string, unknown>;
      await prisma.collateralItem.create({
        data: {
          noteId,
          kind: row.kind as CollateralKind,
          status: row.status as CollateralStatus,
          sequence: row.sequence,
          detail: typeof extra.detail === "string" ? extra.detail : "",
          endorsement: typeof extra.endorsement === "string" ? extra.endorsement : null,
          datedOn: extra.datedOn instanceof Date ? extra.datedOn : null,
          attachedAt: extra.attachedAt instanceof Date ? extra.attachedAt : null,
        },
      });
    }
    assert.equal(await diligenceHold(listing.id), "The diligence set isn't complete: Pay history. Add each to the loan file, or compliance waives it with a reason, before the listing can go live.");

    assert.deepEqual(await waiveDiligence(sales, { listingId: listing.id, item: "PAY_HISTORY", reason: "Servicer transfer" }), { ok: false, error: DESK_DENIED });
    assert.deepEqual(await waiveDiligence(compliance, { listingId: listing.id, item: "PAY_HISTORY", reason: "no" }), { ok: false, error: "Say why the item is waived. Buyers read the reason." });
    assert.deepEqual(await waiveDiligence(compliance, { listingId: listing.id, item: "MORTGAGE", reason: "Recorded copy" }), { ok: false, error: "Nothing is missing under that item." });
    assert.deepEqual(await waiveDiligence(compliance, { listingId: listing.id, item: "NOPE", reason: "Recorded copy" }), { ok: false, error: "Choose an item to waive." });

    const at = new Date("2026-11-08T09:00:00.000Z");
    const waived = await waiveDiligence(compliance, { listingId: listing.id, item: "PAY_HISTORY", noteId, reason: "Servicer transfer in progress", now: at });
    assert.deepEqual(waived, { ok: true, value: { key: `PAY_HISTORY:${noteId}` } });
    const stored = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.deepEqual(stored.diligenceWaivers, { [`PAY_HISTORY:${noteId}`]: { by: compliance.id, at: at.toISOString(), reason: "Servicer transfer in progress" } });
    const event = await prisma.auditEvent.findFirst({ where: { action: "DILIGENCE_WAIVED", entityId: listing.id, actorId: compliance.id } });
    assert.match(event?.detail ?? "", /Pay history · loan .* · Servicer transfer in progress/);
    assert.equal(await diligenceHold(listing.id), null);
    const loaded = await loadDiligence(listing.id);
    assert.equal(buyerDiligence(loaded!.diligence).waived[0].reasons[0], "Servicer transfer in progress");

    // Withdrawing the waiver puts the hold back.
    assert.deepEqual(await clearDiligenceWaiver(sales, { listingId: listing.id, key: `PAY_HISTORY:${noteId}` }), { ok: false, error: DESK_DENIED });
    assert.deepEqual(await clearDiligenceWaiver(compliance, { listingId: listing.id, key: `PAY_HISTORY:${noteId}` }), { ok: true, value: null });
    assert.match((await diligenceHold(listing.id)) ?? "", /Pay history/);
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "DILIGENCE_WAIVER_CLEARED", entityId: listing.id } }));
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The tie-out

const TIE_HEADERS = ["Loan #", "Property Address", "Property Zip", "Principal Balance", "Note Rate", "Next Due Date", "Loan Status"];

const tieNotes = (tag: string): TieOutNote[] => [
  { id: "a", loanNumber: `00${tag}-1`, streetAddress: "10 Oak Street", city: "Tampa", state: "FL", zip: "33602", upb: 80000, interestRate: 6.5, paymentStatus: "PERFORMING", nextDueDate: new Date("2026-11-01T00:00:00.000Z") },
  { id: "b", loanNumber: null, streetAddress: "22 Pine Ave", city: "Tampa", state: "FL", zip: "33603", upb: 40000, interestRate: 9.25, paymentStatus: "PERFORMING", nextDueDate: new Date("2026-11-01T00:00:00.000Z") },
  { id: "c", loanNumber: `00${tag}-3`, streetAddress: "5 Elm Rd", city: "Tampa", state: "FL", zip: "33605", upb: 120000, interestRate: 7, paymentStatus: "PERFORMING", nextDueDate: null },
  { id: "d", loanNumber: `00${tag}-4`, streetAddress: "7 Bay Ct", city: "Tampa", state: "FL", zip: "33604", upb: 55000, interestRate: 8, paymentStatus: "NON_PERFORMING", nextDueDate: null },
];

const tieRows = (tag: string) => [
  TIE_HEADERS,
  // Matched by loan number, the spreadsheet's dropped zeros and all: paid down and a month on.
  [`${tag}-1`, "10 Oak St", "33602", "79,412.18", "6.5%", "2026-12-01", "Current"],
  // No loan number, so it falls back to street and ZIP: the balance holds, the status slipped.
  ["", "22 Pine Avenue", "33603", "40000", "9.25", "2026-11-01", "Non-performing"],
  // Paid off before closing.
  [`00${tag}-3`, "5 Elm Rd", "33605", "0", "7", "", "Paid in full"],
  // A loan outside this closing.
  ["LN-OTHER", "1 Far Rd", "99999", "10000", "5", "", "Current"],
];

test("the tie-out matches by loan number, falls back to address, and flags a paid-off and a missing loan", () => {
  const rows = readClosingTape(parseTapeBuffer(csv(tieRows("77")), "closing.csv"));
  const result = compareTieOut(tieNotes("77"), rows);
  const by = (id: string) => result.loans.find((row) => row.noteId === id)!;

  assert.equal(by("a").by, "loanNumber");
  assert.equal(by("a").status, "CHANGED");
  assert.deepEqual(by("a").differences.map((row) => [row.field, row.bid, row.closing]), [["upb", "80000", "79412.18"], ["nextDueDate", "2026-11-01", "2026-12-01"]]);

  assert.equal(by("b").by, "street");
  assert.equal(by("b").status, "CHANGED");
  assert.deepEqual(by("b").differences.map((row) => [row.field, row.bid, row.closing]), [["paymentStatus", "PERFORMING", "NON_PERFORMING"]]);

  assert.equal(by("c").status, "PAID_OFF");
  assert.equal(by("c").closingUpb, 0);
  assert.equal(by("d").status, "MISSING");
  assert.equal(by("d").closingUpb, null);
  assert.equal(result.extra.length, 1);
  assert.match(result.extra[0].reason, /No loan in this closing/);
  assert.deepEqual(
    { agree: result.totals.agree, changed: result.totals.changed, paidOff: result.totals.paidOff, missing: result.totals.missing, extra: result.totals.extra },
    { agree: 0, changed: 2, paidOff: 1, missing: 1, extra: 1 },
  );
  // The change counts only the loans the closing tape speaks to.
  assert.equal(result.totals.upbChange, -120587.82);

  // Proration reads each loan's UPB change in dollars, and nothing for a loan missing at closing.
  const stored = JSON.parse(JSON.stringify({ version: 1, source: "Servicer report (FCI)", filename: "closing.csv", fileId: null, at: "", by: "", ...result }));
  assert.deepEqual(tieOutUpbChange(stored), [
    { noteId: "a", bidUpb: 80000, closingUpb: 79412.18, change: -587.82 },
    { noteId: "b", bidUpb: 40000, closingUpb: 40000, change: 0 },
    { noteId: "c", bidUpb: 120000, closingUpb: 0, change: -120000 },
  ]);
  assert.deepEqual(tieOutUpbChange(null), []);
  assert.deepEqual(tieOutUpbChange({ version: 2 }), []);
  assert.equal(readTieOut(stored)?.differences.length, 4);
});

test("the closings desk runs the tie-out on an open closing, keeps the file and tells both sides", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("tseller", "INSTITUTIONAL_SELLER");
    const buyer = await world.person("tbuyer", "BUYER");
    const closer = await world.person("tcloser", "ADMIN", { deskRole: "CLOSINGS" });
    const sales = await world.person("tsales", "ADMIN", { deskRole: "SALES" });
    const notes = tieNotes(world.tag.slice(-6));
    const listing = await prisma.listing.create({
      data: {
        kind: "POOL",
        sellerId: seller.id,
        status: "PENDING",
        title: `Tie-out ${world.tag}`,
        notes: {
          create: notes.map((note) => ({
            loanNumber: note.loanNumber,
            streetAddress: note.streetAddress,
            city: note.city,
            state: note.state,
            zip: note.zip ?? "",
            propertyType: "SFR",
            lienPosition: "FIRST",
            upb: note.upb,
            interestRate: note.interestRate,
            monthlyPi: 500,
            paymentStatus: note.paymentStatus as "PERFORMING" | "NON_PERFORMING",
            nextDueDate: note.nextDueDate ?? null,
            estimatedValue: 200000,
            askingPrice: note.upb * 0.8,
          })),
        },
      },
      include: { notes: true },
    });
    world.listingIds.push(listing.id);
    const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 200000, message: `c-intake bid ${world.tag}` } });
    const closing = await prisma.closing.create({
      data: {
        listingId: listing.id,
        inquiryId: inquiry.id,
        salePrice: 200000,
        buyerPremiumCents: 0,
        sellerCommissionCents: 0,
        buyerTotalCents: 20000000,
        netToSellerCents: 20000000,
        steps: { create: [{ key: "PURCHASE_AGREEMENT" }, { key: "PAYMENT_RECEIVED" }] },
      },
    });
    world.closingIds.push(closing.id);
    const bytes = csv(tieRows(world.tag.slice(-6)));
    const input = { closingId: closing.id, source: "FCI", filename: "fci-closing.csv", bytes, now: new Date("2026-11-08T15:00:00.000Z") };

    assert.deepEqual(await runTieOut(sales, input), { ok: false, error: DESK_DENIED });
    assert.deepEqual(await runTieOut(closer, { ...input, source: "SHELLPOINT" }), { ok: false, error: "Choose who produced the tape, and name it if it isn't listed." });
    assert.equal((await runTieOut(closer, { ...input, bytes: csv([TIE_HEADERS, ["LN-NONE", "1 Nowhere", "00000", "1", "1", "", ""]]) })).ok, false);

    const ran = await runTieOut(closer, input);
    assert.ok(ran.ok, ran.ok ? "" : ran.error);
    assert.equal(ran.value.source, "Servicer report (FCI)");
    assert.deepEqual([ran.value.totals.changed, ran.value.totals.paidOff, ran.value.totals.missing], [2, 1, 1]);

    const stored = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id }, include: { steps: { include: { files: true } } } });
    assert.equal(stored.tieOutById, closer.id);
    assert.equal(stored.tieOutAt?.toISOString(), "2026-11-08T15:00:00.000Z");
    assert.equal(readTieOut(stored.tieOut)?.loans.length, 4);
    const change = tieOutUpbChange(stored.tieOut);
    assert.equal(change.length, 3);
    assert.equal(change.find((row) => row.closingUpb === 0)?.change, -120000);
    // The file goes with the payment step.
    const payment = stored.steps.find((step) => step.key === "PAYMENT_RECEIVED")!;
    assert.equal(payment.files.length, 1);
    assert.equal(payment.files[0].id, ran.value.fileId);

    // Both sides are told, in counts.
    for (const email of [seller.email, buyer.email]) {
      const notice = await prisma.notification.findFirst({ where: { toEmail: email, subject: `Tape tie-out · ${listing.title}` } });
      assert.ok(notice, email);
      assert.match(notice!.body, /4 loans checked: 0 agree, 2 changed, 1 paid off, 1 not on the closing tape/);
    }
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "TIE_OUT", entityId: closing.id, actorId: closer.id } }));

    // A finished closing takes no tie-out.
    await prisma.closing.update({ where: { id: closing.id }, data: { status: "COMPLETE" } });
    assert.deepEqual(await runTieOut(closer, input), { ok: false, error: "This closing is already finished." });
  } finally {
    await cleanWorld(world);
  }
});
