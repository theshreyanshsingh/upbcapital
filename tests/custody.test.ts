import assert from "node:assert/strict";
import test from "node:test";
import { removeStoredFile } from "../lib/account-deletion";
import { pdfText } from "../lib/ai-reading";
import {
  baileeLetter,
  baileeNotNeeded,
  clearExceptions,
  collateralShipped,
  custodianLabel,
  custodyExceptionOpen,
  custodyFiles,
  custodyPrefix,
  custodyRows,
  exceptionsLine,
  issueBaileeLetter,
  nameCustodian,
  noteReceipt,
  purchaseFunded,
  recordCustodianReceipt,
  recordExceptions,
  SELF_HELD,
  SHIPPED_CHANGE,
} from "../lib/custody";
import { DESK_DENIED } from "../lib/desk-roles";
import { prisma } from "../lib/prisma";
import { saleFile, saleFilePdf, sellerSaleFile } from "../lib/sale-file";
import { completeIfDone, confirmReceived, recordSent, scheduleTrailingDocs } from "../lib/trailing-docs";

// Uploads stay on local disk and mail stays in the log, whatever the local .env carries.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) process.env[key] = "";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);
const iso = (date: Date | null | undefined) => date?.toISOString().slice(0, 10) ?? null;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The rules, without the database.

test("the custodian reads as its name or the buyer itself, and the file has shipped once the collateral moves", () => {
  assert.equal(custodianLabel({ custodianName: null }), null);
  assert.equal(custodianLabel({ custodianName: "First Custody Bank" }), "First Custody Bank");
  assert.equal(custodianLabel({ custodianName: SELF_HELD }), "The buyer, holding the file itself");
  assert.equal(custodianLabel({ custodianName: SELF_HELD }, "UPB Capital"), "UPB Capital, holding the file itself");

  const steps = [{ key: "COLLATERAL_TRANSFER", status: "PENDING" }];
  assert.equal(collateralShipped({ steps, trailingDocs: [] }), false);
  assert.equal(collateralShipped({ steps: [{ key: "COLLATERAL_TRANSFER", status: "COMPLETE" }], trailingDocs: [] }), true);
  assert.equal(collateralShipped({ steps, trailingDocs: [{ kind: "ORIGINAL_NOTE", status: "DUE" }, { kind: "RECORDED_ASSIGNMENT", status: "SENT" }] }), false);
  assert.equal(collateralShipped({ steps, trailingDocs: [{ kind: "ORIGINAL_NOTE", status: "SENT" }] }), true);
  assert.equal(collateralShipped({ steps, trailingDocs: [{ kind: "ENOTE_CONTROL", status: "RECEIVED" }] }), true);
  assert.equal(collateralShipped({ custodianReceiptAt: day("2026-11-10"), steps, trailingDocs: [] }), true);

  // The price is on record when the buyer's balance is in, or, on a desk purchase, once the desk paid the seller.
  const owed = { deskBidId: null, buyerTotalCents: 10000000, fundsReceivedCents: null };
  assert.equal(purchaseFunded(owed, []), false);
  assert.equal(purchaseFunded({ ...owed, fundsReceivedCents: 9000000 }, []), false);
  assert.equal(purchaseFunded({ ...owed, fundsReceivedCents: 10000000 }, []), true);
  assert.equal(purchaseFunded({ ...owed, fundsReceivedCents: 10000000 }, [{ status: "FUNDED" }, { status: "PENDING" }]), false);
  assert.equal(purchaseFunded({ ...owed, deskBidId: "desk-bid" }, []), false);
  assert.equal(purchaseFunded({ ...owed, deskBidId: "desk-bid", proceedsSentAt: day("2026-11-12") }, []), true);
  assert.match(baileeNotNeeded({ deskBidId: null }), /isn't needed: the buyer's funds are recorded/);
  assert.match(baileeNotNeeded({ deskBidId: "desk-bid" }), /the desk's payment to the seller is recorded/);

  // The receipt form suggests the day the last original note was received on the trailing list.
  const docs = [
    { kind: "ORIGINAL_NOTE", status: "RECEIVED", sentAt: day("2026-11-08"), receivedAt: day("2026-11-12") },
    { kind: "ORIGINAL_NOTE", status: "SENT", sentAt: day("2026-11-09"), receivedAt: null },
    { kind: "ALLONGE", status: "RECEIVED", sentAt: day("2026-11-07"), receivedAt: day("2026-11-13") },
  ];
  assert.deepEqual(noteReceipt(docs), { notes: 2, received: 1, suggested: null, firstSentAt: day("2026-11-08") });
  docs[1] = { ...docs[1], status: "RECEIVED", receivedAt: day("2026-11-14") };
  assert.equal(iso(noteReceipt(docs).suggested), "2026-11-14");

  // Open exceptions keep the file open, and the list line reads them in one.
  assert.equal(custodyExceptionOpen({ custodianExceptions: "  " }), false);
  assert.equal(custodyExceptionOpen({ custodianExceptions: "Allonge missing" }), true);
  assert.equal(custodyExceptionOpen({ custodianExceptions: "Allonge missing", exceptionsClearedAt: day("2026-11-20") }), false);
  assert.equal(exceptionsLine({ custodianExceptions: "Allonge missing\nAssignment unsigned" }), "Allonge missing; Assignment unsigned");
  assert.equal(exceptionsLine({ custodianExceptions: "Allonge missing", exceptionsClearedAt: day("2026-11-20") }), null);
  assert.equal(exceptionsLine({ custodianExceptions: "x".repeat(300) })?.length, 160);
});

// ---------------------------------------------------------------------------------------------------------------
// The flow, on the database.

const loan = (street: string, extra: Record<string, unknown> = {}) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 120000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 100000, estimatedValue: 180000, ...extra,
});

const STEPS = ["PURCHASE_AGREEMENT", "BUYER_DEPOSIT", "COLLATERAL_TRANSFER", "ASSIGNMENT", "PAYMENT_RECEIVED", "CLOSED"];

async function makeWorld() {
  const tag = crypto.randomUUID().slice(0, 8);
  const email = (who: string) => `e-custody-${tag}-${who}@example.org`;
  const user = (who: string, data: Record<string, unknown>) =>
    prisma.user.create({ data: { email: email(who), name: `${who} ${tag}`, accountStatus: "APPROVED", passwordHash: "x", ...data } as never });
  const seller = await user("seller", { role: "INDIVIDUAL_SELLER", companyName: `Seller Bank ${tag}` });
  const buyer = await user("buyer", { role: "BUYER", companyName: `Buyer Fund ${tag}` });
  const stranger = await user("stranger", { role: "BUYER" });
  const closer = await user("closer", { role: "ADMIN", deskRole: "CLOSINGS" });
  const sales = await user("sales", { role: "ADMIN", deskRole: "SALES" });
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: "PENDING",
      approvedAt: new Date(),
      reservePrice: 1000,
      title: `E custody ${tag}`,
      notes: { create: [loan("1 Paper Row", { loanNumber: "TPA-4471" }), loan("2 Paper Row"), loan("3 Vault Lane", { eNote: true })] as never },
    },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
  return { tag, seller, buyer, stranger, closer, sales, listing, users: [seller, buyer, stranger, closer, sales] };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

// A closing on the whole pool with its checklist: open with nothing done, or closed with every step done.
async function closingFor(world: World, status: "OPEN" | "COMPLETE", extra: Record<string, unknown> = {}) {
  const inquiry = await prisma.inquiry.create({ data: { listingId: world.listing.id, buyerId: world.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 100000 } });
  return prisma.closing.create({
    data: {
      listingId: world.listing.id,
      inquiryId: inquiry.id,
      noteId: null,
      status,
      ...(status === "COMPLETE" ? { closedAt: noon("2026-11-06") } : {}),
      salePrice: 100000,
      buyerPremiumCents: 0,
      sellerCommissionCents: 0,
      buyerTotalCents: 10000000,
      netToSellerCents: 10000000,
      deskOwnerId: world.closer.id,
      steps: { create: STEPS.map((key) => ({ key, status: status === "COMPLETE" ? "COMPLETE" : "PENDING" })) as never },
      ...extra,
    },
  });
}

async function cleanWorld(world: World) {
  const listingId = world.listing.id;
  const userIds = world.users.map((row) => row.id);
  const closingIds = (await prisma.closing.findMany({ where: { listingId }, select: { id: true } })).map((row) => row.id);
  const inquiries = await prisma.inquiry.findMany({ where: { listingId }, select: { id: true } });
  for (const closingId of closingIds) {
    for (const file of await prisma.closingFile.findMany({ where: { storageKey: { startsWith: custodyPrefix(closingId) } }, select: { id: true, storageKey: true } })) {
      await removeStoredFile(file.storageKey).catch(() => undefined);
      await prisma.closingFile.delete({ where: { id: file.id } });
    }
  }
  await prisma.closingFile.deleteMany({ where: { step: { is: { closingId: { in: closingIds } } } } });
  await prisma.trailingDoc.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.closingStep.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [listingId, ...userIds, ...closingIds, ...inquiries.map((row) => row.id)] } } });
  await prisma.closing.deleteMany({ where: { id: { in: closingIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: world.users.map((row) => row.email) } }, { subject: { contains: world.listing.title } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const notices = (email: string, subject: string) =>
  prisma.notification.findMany({ where: { toEmail: email, subject: { contains: subject } }, orderBy: { createdAt: "asc" }, select: { subject: true, body: true } });
const audits = (closingId: string, action: string) => prisma.auditEvent.findMany({ where: { entityId: closingId, action }, orderBy: { createdAt: "asc" } });
const reload = (closingId: string) => prisma.closing.findUniqueOrThrow({ where: { id: closingId } });

test("the buyer names its custodian, the seller hears where the file goes, and after it ships only the desk changes it", async () => {
  const world = await makeWorld();
  try {
    const closing = await closingFor(world, "OPEN");
    const contact = "100 Vault Ave, Dallas TX 75201\nvault@example.org";
    const named = { closingId: closing.id, name: "First Custody Bank", contact };

    // The buyer side keeps it; the seller, a stranger and a desk role without closings don't.
    assert.deepEqual(await nameCustodian(world.seller, named), { ok: false, error: "The buyer names the custodian, or the desk." });
    assert.deepEqual(await nameCustodian(world.stranger, named), { ok: false, error: "Only the parties and the desk keep the custody record." });
    assert.deepEqual(await nameCustodian(world.sales, named), { ok: false, error: DESK_DENIED });
    assert.deepEqual(await nameCustodian(world.buyer, { ...named, contact: "" }), { ok: false, error: "Add how to reach the custodian: the address the file ships to, and an email or phone." });
    assert.deepEqual(await nameCustodian(world.buyer, { ...named, name: " " }), { ok: false, error: "Enter the custodian's name." });

    assert.deepEqual(await nameCustodian(world.buyer, named), { ok: true, value: { changed: true } });
    let row = await reload(closing.id);
    assert.equal(row.custodianName, "First Custody Bank");
    assert.equal(row.custodianContact, contact);
    const told = await notices(world.seller.email, "Custodian ·");
    assert.equal(told.length, 1);
    assert.match(told[0].body, /named First Custody Bank as the custodian/);
    assert.match(told[0].body, /Ship it to: 100 Vault Ave, Dallas TX 75201; vault@example\.org/);
    assert.equal((await audits(closing.id, "CUSTODIAN_NAMED")).length, 1);
    // Saving the same again changes nothing and tells no one.
    assert.deepEqual(await nameCustodian(world.buyer, named), { ok: true, value: { changed: false } });
    assert.equal((await notices(world.seller.email, "Custodian ·")).length, 1);

    // Before anything ships, the buyer can change it, or say it holds the file itself.
    assert.equal((await nameCustodian(world.buyer, { closingId: closing.id, selfHeld: true, contact: "Buyer Fund, 5 Main St, Austin TX" })).ok, true);
    row = await reload(closing.id);
    assert.equal(row.custodianName, SELF_HELD);
    assert.equal(custodianLabel(row), "The buyer, holding the file itself");
    assert.equal((await nameCustodian(world.buyer, named)).ok, true);
    const changes = await audits(closing.id, "CUSTODIAN_CHANGED");
    assert.equal(changes.length, 2);
    assert.match(changes[1].detail, /^The buyer, holding the file itself to First Custody Bank/);

    // Once the desk marks the collateral transferred, the buyer can't move it to someone else, though it can correct
    // the address. The desk can, and both sides hear.
    await prisma.closingStep.updateMany({ where: { closingId: closing.id, key: "COLLATERAL_TRANSFER" }, data: { status: "COMPLETE", completedAt: new Date() } });
    assert.deepEqual(await nameCustodian(world.buyer, { ...named, name: "Second Custody Trust" }), { ok: false, error: SHIPPED_CHANGE });
    assert.deepEqual(await nameCustodian(world.buyer, { closingId: closing.id, selfHeld: true }), { ok: false, error: SHIPPED_CHANGE });
    assert.equal((await nameCustodian(world.buyer, { ...named, contact: `${contact}\n+1 214 555 0100` })).ok, true);
    assert.equal((await reload(closing.id)).custodianName, "First Custody Bank");
    assert.equal((await nameCustodian(world.closer, { ...named, name: "Second Custody Trust" })).ok, true);
    assert.equal((await reload(closing.id)).custodianName, "Second Custody Trust");
    assert.equal((await audits(closing.id, "CUSTODIAN_CHANGED")).length, 4);
    assert.match((await notices(world.buyer.email, "Custodian ·"))[0].body, /The desk changed the custodian .* from First Custody Bank to Second Custody Trust/);

    // A canceled closing keeps its record as it was.
    await prisma.closing.update({ where: { id: closing.id }, data: { status: "CANCELED" } });
    assert.deepEqual(await nameCustodian(world.closer, named), { ok: false, error: "This closing was canceled." });
  } finally {
    await cleanWorld(world);
  }
});

test("the seller issues a bailee letter listing the paper loans, and none is needed once the buyer's funds are recorded", async () => {
  const world = await makeWorld();
  try {
    const closing = await closingFor(world, "OPEN");
    // No custodian, no one to address it to; the buyer side doesn't issue it.
    assert.deepEqual(await issueBaileeLetter(world.seller, { closingId: closing.id }), { ok: false, error: "The buyer hasn't named its custodian yet, so there is no one to address the letter to." });
    assert.equal((await baileeLetter(closing.id, world.seller)).status, 409);
    await nameCustodian(world.buyer, { closingId: closing.id, name: "First Custody Bank", contact: "100 Vault Ave, Dallas TX 75201" });
    assert.deepEqual(await issueBaileeLetter(world.buyer, { closingId: closing.id }), { ok: false, error: "The seller or the desk issues the bailee letter." });
    assert.deepEqual(await issueBaileeLetter(world.sales, { closingId: closing.id }), { ok: false, error: DESK_DENIED });
    // Exceptions come from the custodian's review, after its receipt.
    assert.deepEqual(await recordExceptions(world.buyer, { closingId: closing.id, text: "Allonge missing" }), { ok: false, error: "Record the custodian's receipt first. Exceptions come from its review of the file." });

    const issued = await issueBaileeLetter(world.seller, { closingId: closing.id }, noon("2026-11-12"));
    assert.equal(issued.ok, true);
    assert.equal((await reload(closing.id)).baileeLetterAt?.toISOString(), noon("2026-11-12").toISOString());
    const logged = await audits(closing.id, "BAILEE_LETTER");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].actorId, world.seller.id);
    assert.match(logged[0].detail, /Addressed to First Custody Bank, 2 loans/);
    assert.match((await notices(world.buyer.email, "Bailee letter ·"))[0].body, /addressed to First Custody Bank/);

    // The letter: to the custodian, in trust for the seller, each paper loan by city, state and loan number. The eNote
    // has no paper file, so it isn't on it.
    assert.equal((await baileeLetter(closing.id, world.stranger)).status, 403);
    const letter = await baileeLetter(closing.id, world.buyer);
    assert.equal(letter.status, 200);
    if (letter.status !== 200) return;
    const bytes = Buffer.from(letter.pdf);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const text = pdfText(bytes).replace(/\s+/g, " ");
    assert.match(text, /Bailee letter/);
    assert.match(text, /Date: 2026-11-12/);
    assert.match(text, /To: First Custody Bank/);
    assert.match(text, new RegExp(`in trust for Seller Bank ${world.tag}`));
    assert.match(text, /\$100,000\.00/);
    assert.match(text, /within 5 business days/);
    assert.match(text, /Loan 1 in Tampa, FL · loan number TPA-4471/);
    assert.match(text, /Loan 2 in Tampa, FL · loan number not on the tape/);
    assert.doesNotMatch(text, /Loan 3/);
    assert.doesNotMatch(text, /Paper Row|Vault Lane/);
    assert.match(text, /desk draft/i);

    // Issuing again dates a new one, logged with the one it replaces.
    assert.equal((await issueBaileeLetter(world.closer, { closingId: closing.id }, noon("2026-11-13"))).ok, true);
    assert.match((await audits(closing.id, "BAILEE_LETTER"))[1].detail, /replacing the letter of Nov 12, 2026/);

    // Once the buyer's balance is recorded, the collateral ships outright.
    const funded = await closingFor(world, "OPEN", { fundsReceivedCents: 10000000, fundsReceivedAt: noon("2026-11-12") });
    await nameCustodian(world.buyer, { closingId: funded.id, name: "First Custody Bank", contact: "100 Vault Ave, Dallas TX 75201" });
    assert.deepEqual(await issueBaileeLetter(world.seller, { closingId: funded.id }), { ok: false, error: baileeNotNeeded({ deskBidId: null }) });
    assert.equal((await reload(funded.id)).baileeLetterAt, null);
    const notNeeded = await baileeLetter(funded.id, world.seller);
    assert.equal(notNeeded.status, 409);
    assert.match(notNeeded.status === 409 ? notNeeded.error : "", /isn't needed: the buyer's funds are recorded/);
  } finally {
    await cleanWorld(world);
  }
});

test("the custodian's receipt is recorded against the trailing list, and its exceptions hold the file open until they clear", async () => {
  const world = await makeWorld();
  try {
    const closing = await closingFor(world, "COMPLETE");
    await scheduleTrailingDocs(closing.id);
    const notes = await prisma.trailingDoc.findMany({ where: { closingId: closing.id, kind: "ORIGINAL_NOTE" } });
    assert.equal(notes.length, 2);
    // Naming the custodian for the first time after the file shipped is no change, so the buyer may.
    assert.equal((await nameCustodian(world.buyer, { closingId: closing.id, name: "First Custody Bank", contact: "100 Vault Ave, Dallas TX 75201" })).ok, true);
    for (const note of notes) {
      assert.equal((await recordSent(world.seller, { docId: note.id, carrier: "FEDEX", trackingNumber: "771234567890" }, noon("2026-11-10"))).ok, true);
      assert.equal((await confirmReceived(world.buyer, { docId: note.id }, noon("2026-11-14"))).ok, true);
    }
    // The receipt form suggests the day the notes came in on the trailing list.
    const docs = await prisma.trailingDoc.findMany({ where: { closingId: closing.id } });
    assert.equal(iso(noteReceipt(docs).suggested), "2026-11-14");

    const pdf = { name: "trust-receipt.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4\n% custody test\n") };
    const now = noon("2026-11-19");
    assert.deepEqual(await recordCustodianReceipt(world.seller, { closingId: closing.id, receivedAt: day("2026-11-14") }, now), { ok: false, error: "The buyer records the custodian's receipt, or the desk." });
    assert.equal((await recordCustodianReceipt(world.buyer, { closingId: closing.id, receivedAt: undefined }, now)).ok, false);
    assert.equal((await recordCustodianReceipt(world.buyer, { closingId: closing.id, receivedAt: day("2026-11-25") }, now)).ok, false);
    // A receipt before the note went out would contradict the trailing list.
    const early = await recordCustodianReceipt(world.buyer, { closingId: closing.id, receivedAt: day("2026-11-09") }, now);
    assert.match(early.ok ? "" : early.error, /original note sent Nov 10, 2026/);

    assert.equal((await recordCustodianReceipt(world.buyer, { closingId: closing.id, receivedAt: day("2026-11-14"), file: pdf }, now)).ok, true);
    assert.equal(iso((await reload(closing.id)).custodianReceiptAt), "2026-11-14");
    const files = await custodyFiles(closing.id);
    assert.deepEqual(files.map((file) => file.originalName), ["trust-receipt.pdf"]);
    const filed = await prisma.closingFile.findUniqueOrThrow({ where: { id: files[0].id }, include: { step: true } });
    assert.equal(filed.step.key, "COLLATERAL_TRANSFER");
    assert.equal(filed.step.closingId, closing.id);
    assert.match((await notices(world.seller.email, "Collateral received ·"))[0].body, /First Custody Bank received the collateral file .* on Nov 14, 2026/);
    assert.equal((await audits(closing.id, "CUSTODIAN_RECEIPT")).length, 1);

    // Every trailing item in: the file completes.
    await prisma.trailingDoc.updateMany({ where: { closingId: closing.id }, data: { status: "RECEIVED", receivedAt: noon("2026-11-15") } });
    assert.equal(await completeIfDone(closing.id, noon("2026-11-15")), true);
    assert.ok((await reload(closing.id)).postCloseCompleteAt);

    // The custodian's exceptions reopen it, and the seller and the desk hear.
    assert.deepEqual(await recordExceptions(world.seller, { closingId: closing.id, text: "Allonge missing" }), { ok: false, error: "The buyer records the custodian's exceptions, or the desk." });
    assert.equal((await recordExceptions(world.buyer, { closingId: closing.id, text: "no" })).ok, false);
    assert.equal((await recordExceptions(world.buyer, { closingId: closing.id, text: "Loan 2: allonge missing\n  Loan 1:   assignment unsigned  " })).ok, true);
    let row = await reload(closing.id);
    assert.equal(row.custodianExceptions, "Loan 2: allonge missing\nLoan 1: assignment unsigned");
    assert.equal(row.postCloseCompleteAt, null);
    assert.equal((await audits(closing.id, "TRAILING_REOPENED")).length, 1);
    assert.match((await notices(world.seller.email, "Custodian exceptions ·"))[0].body, /Loan 2: allonge missing\nLoan 1: assignment unsigned/);
    assert.equal((await notices(world.closer.email, "Custodian exceptions ·")).length, 1);
    assert.equal(exceptionsLine(row), "Loan 2: allonge missing; Loan 1: assignment unsigned");

    // While they're open, every trailing item received isn't enough.
    assert.equal(await completeIfDone(closing.id, noon("2026-11-16")), false);
    assert.equal((await reload(closing.id)).postCloseCompleteAt, null);

    // Cleared, on a day after the receipt, by the buyer side: the file completes again.
    assert.equal((await clearExceptions(world.seller, { closingId: closing.id, clearedAt: day("2026-11-18") }, now)).ok, false);
    assert.equal((await clearExceptions(world.buyer, { closingId: closing.id, clearedAt: day("2026-11-13") }, now)).ok, false);
    assert.deepEqual(await clearExceptions(world.buyer, { closingId: closing.id, clearedAt: day("2026-11-18") }, now), { ok: true, value: { complete: true } });
    row = await reload(closing.id);
    assert.equal(iso(row.exceptionsClearedAt), "2026-11-18");
    assert.ok(row.postCloseCompleteAt);
    assert.equal(custodyExceptionOpen(row), false);
    assert.equal((await notices(world.seller.email, "Custodian exceptions cleared ·")).length, 1);
    assert.deepEqual(await clearExceptions(world.buyer, { closingId: closing.id, clearedAt: day("2026-11-18") }, now), { ok: false, error: "No custodian exceptions are open." });
  } finally {
    await cleanWorld(world);
  }
});

test("the seller's sale file and the desk's carry the custody lines", async () => {
  const world = await makeWorld();
  try {
    const closing = await closingFor(world, "COMPLETE", {
      custodianName: "First Custody Bank",
      custodianContact: "100 Vault Ave, Dallas TX 75201\nvault@example.org",
      baileeLetterAt: noon("2026-11-04"),
      custodianReceiptAt: day("2026-11-12"),
      custodianExceptions: "Loan 2: allonge missing",
    });
    const result = await sellerSaleFile(world.listing.id, world.seller);
    assert.equal(result.status, 200);
    if (result.status !== 200) return;
    const custody = result.file.rows.filter((row) => row.section === "Custody");
    assert.deepEqual(
      custody.map((row) => [row.status, iso(row.at), row.party]),
      [
        ["Custodian named", null, "First Custody Bank"],
        ["Bailee letter issued", "2026-11-04", "First Custody Bank"],
        ["Custodian receipt", "2026-11-12", "First Custody Bank"],
        ["Exceptions open", null, "First Custody Bank"],
      ],
    );
    assert.equal(custody[0].detail, "100 Vault Ave, Dallas TX 75201; vault@example.org");
    assert.equal(custody[3].detail, "Loan 2: allonge missing");
    assert.match(pdfText(Buffer.from(await saleFilePdf(result.file))), /Collateral custody/);

    // Cleared, the line says when.
    await prisma.closing.update({ where: { id: closing.id }, data: { exceptionsClearedAt: day("2026-11-18") } });
    const desk = await saleFile(world.listing.id, world.closer);
    const lines = desk?.rows.filter((row) => row.section === "Custody") ?? [];
    assert.equal(lines.length, 4);
    assert.deepEqual([lines[3].status, iso(lines[3].at), lines[3].detail], ["Exceptions cleared", "2026-11-18", "Loan 2: allonge missing · cleared 2026-11-18"]);

    // A closing with nothing on record adds no lines.
    assert.deepEqual(custodyRows({}, "The buyer"), []);
    assert.deepEqual(custodyRows({ custodianName: SELF_HELD }, "UPB Capital desk book").map((row) => [row.status, row.party, row.detail]), [["Custodian named", "UPB Capital desk book, holding the file itself", ""]]);
  } finally {
    await cleanWorld(world);
  }
});
