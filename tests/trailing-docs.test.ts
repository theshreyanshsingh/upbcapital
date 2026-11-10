import assert from "node:assert/strict";
import test from "node:test";
import { noticeClocks, otherPurchasesOnUpb } from "../lib/borrower-notices";
import { finalizeClosing, openClosing } from "../lib/closing-service";
import { DESK_DENIED } from "../lib/desk-roles";
import { prisma } from "../lib/prisma";
import {
  addBusinessDays,
  assignmentDays,
  backfillTrailingDocs,
  completeIfDone,
  confirmReceived,
  deliveringSide,
  kindLabel,
  needsEscalation,
  needsReminder,
  planTrailingDocs,
  readProof,
  receivingSide,
  recordOnly,
  recordSent,
  recordTransferee,
  reminderSlot,
  remindTrailingDocs,
  runTrailingDocs,
  SALE_NOTICE,
  scheduleTrailingDocs,
  syncTrailingDocs,
  trackingUrl,
  trailingActions,
  waiveTrailingDoc,
} from "../lib/trailing-docs";

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

test("a paper loan owes its note, allonge and recorded assignment, and an eNote its two eRegistry transfers", () => {
  const plan = planTrailingDocs({
    closedAt: noon("2026-11-06"),
    loans: [{ id: "paper", servicerName: "Sample Servicing" }, { id: "enote", eNote: true }],
    titlePolicies: new Set(["paper"]),
    assignmentDays: 90,
  });
  const of = (noteId: string | null) => plan.filter((doc) => doc.noteId === noteId).map((doc) => `${doc.kind}/${doc.owner}/${iso(doc.dueAt)}`);
  assert.deepEqual(of("paper"), [
    "ORIGINAL_NOTE/SELLER/2026-11-16",
    "ALLONGE/SELLER/2026-11-16",
    "RECORDED_ASSIGNMENT/SELLER/2027-02-04",
    "TITLE_ENDORSEMENT/SELLER/2026-12-06",
  ]);
  // Friday's close: two business days is Tuesday. No note, allonge or courier, and no title policy, no endorsement.
  assert.deepEqual(of("enote"), ["ENOTE_CONTROL/SELLER/2026-11-10", "ENOTE_LOCATION/SELLER/2026-11-10", "RECORDED_ASSIGNMENT/SELLER/2027-02-04"]);
  // The tape names a servicer, so the goodbye comes from it. With no transfer date on file the close stands in: the
  // goodbye 15 days before, the welcome 15 days after, and the owner's sale notice 30 days after.
  assert.deepEqual(of(null), [
    "GOODBYE_LETTER/SERVICER/2026-10-22",
    "HELLO_LETTER/BUYER/2026-12-06",
    "SERVICER_WELCOME/SERVICER/2026-11-21",
    "SERVICER_BOARDED/SERVICER/2026-12-06",
  ]);

  // No servicer on the tape: the seller writes the goodbye. A recorded transfer date moves all three letters.
  const plain = planTrailingDocs({ closedAt: noon("2026-11-06"), transferAt: day("2026-11-20"), loans: [{ id: "a" }], titlePolicies: new Set(), assignmentDays: 120 });
  assert.equal(plain.find((doc) => doc.kind === "GOODBYE_LETTER")?.owner, "SELLER");
  assert.equal(iso(plain.find((doc) => doc.kind === "HELLO_LETTER")?.dueAt), "2026-12-20");
  assert.equal(iso(plain.find((doc) => doc.kind === "GOODBYE_LETTER")?.dueAt), "2026-11-05");
  assert.equal(iso(plain.find((doc) => doc.kind === "SERVICER_WELCOME")?.dueAt), "2026-12-05");
  assert.equal(iso(plain.find((doc) => doc.kind === "RECORDED_ASSIGNMENT")?.dueAt), "2027-03-06");
  assert.ok(!plain.some((doc) => doc.kind === "TITLE_ENDORSEMENT"));

  assert.equal(assignmentDays(null), 90);
  assert.equal(assignmentDays(5), 90);
  assert.equal(assignmentDays(120), 120);
  assert.equal(iso(addBusinessDays(noon("2026-11-12"), 2)), "2026-11-16");
});

test("the borrower letters run on the rules' clocks, and the stored HELLO_LETTER key reads as the owner's sale notice", () => {
  // The boarding form's servicing transfer date times the servicers' letters; the sale notice keeps the date of transfer.
  const plan = planTrailingDocs({
    closedAt: noon("2026-11-06"),
    transferAt: day("2026-11-10"),
    servicingAt: day("2026-12-01"),
    loans: [{ id: "a", servicerName: "Old Servicing" }],
    titlePolicies: new Set(),
    assignmentDays: 90,
  });
  const item = (kind: string) => plan.find((doc) => doc.kind === kind)!;
  assert.equal(iso(item("GOODBYE_LETTER").dueAt), "2026-11-16");
  assert.equal(iso(item("SERVICER_WELCOME").dueAt), "2026-12-16");
  assert.equal(iso(item(SALE_NOTICE).dueAt), "2026-12-10");
  // The old servicer is the seller's side, the new servicer the buyer's, and the sale notice the new owner's.
  assert.equal(deliveringSide(item("GOODBYE_LETTER")), "seller");
  assert.equal(deliveringSide(item("SERVICER_WELCOME")), "buyer");
  assert.equal(receivingSide(item("SERVICER_WELCOME")), "desk");
  assert.equal(deliveringSide(item(SALE_NOTICE)), "buyer");
  // The key is still the one old rows carry; only what it says changed.
  assert.equal(SALE_NOTICE, "HELLO_LETTER");
  assert.equal(kindLabel("HELLO_LETTER"), "Owner's sale notice to the borrower");
  assert.equal(kindLabel("SERVICER_WELCOME"), "New servicer's welcome letter");
  // The sale notice is recorded under Borrower notices with its proof, not from the list.
  assert.equal(trailingActions({ kind: SALE_NOTICE, owner: "BUYER", status: "DUE" }, "buyer", false).send, false);
  assert.equal(trailingActions({ kind: SALE_NOTICE, owner: "BUYER", status: "DUE" }, "desk", true).send, false);
  // A letter listed after its date asks for a record of when it went; one on its own date doesn't.
  const clocks = noticeClocks({ status: "COMPLETE", closedAt: noon("2026-11-06") }, null);
  assert.equal(iso(recordOnly({ kind: "GOODBYE_LETTER", status: "DUE", dueAt: day("2026-11-13") }, clocks)), "2026-10-22");
  assert.equal(recordOnly({ kind: "SERVICER_WELCOME", status: "DUE", dueAt: day("2026-11-21") }, clocks), null);
  assert.equal(recordOnly({ kind: "GOODBYE_LETTER", status: "RECEIVED", dueAt: day("2026-11-13") }, clocks), null);
  assert.equal(recordOnly({ kind: "ORIGINAL_NOTE", status: "DUE", dueAt: day("2026-11-13") }, clocks), null);
});

test("each side may do only its own part", () => {
  const note = { kind: "ORIGINAL_NOTE", owner: "SELLER", status: "DUE" };
  assert.deepEqual(trailingActions(note, "seller", false), { send: true, confirm: false, waive: false, transferee: false });
  assert.deepEqual(trailingActions(note, "buyer", false), { send: false, confirm: true, waive: false, transferee: false });
  assert.deepEqual(trailingActions(note, "desk", true), { send: true, confirm: true, waive: true, transferee: false });
  // A desk role outside closings reads the list and does nothing on it.
  assert.deepEqual(trailingActions(note, "desk", false), { send: false, confirm: false, waive: false, transferee: false });
  assert.equal(trailingActions({ ...note, status: "RECEIVED" }, "buyer", false).confirm, false);
  assert.equal(trailingActions({ ...note, status: "RECEIVED" }, "desk", true).waive, true);
  assert.equal(trailingActions({ ...note, status: "WAIVED" }, "desk", true).waive, false);
  // The buyer names where an eNote goes; the seller makes the transfer.
  const control = { kind: "ENOTE_CONTROL", owner: "SELLER", status: "DUE" };
  assert.equal(trailingActions(control, "buyer", false).transferee, true);
  assert.equal(trailingActions(control, "seller", false).transferee, false);
  // The buyer's servicer boards the loan, and the desk confirms what the buyer side does.
  assert.equal(deliveringSide({ kind: "SERVICER_BOARDED", owner: "SERVICER" }), "buyer");
  assert.equal(receivingSide({ kind: "SERVICER_BOARDED", owner: "SERVICER" }), "desk");
  assert.equal(deliveringSide({ kind: "GOODBYE_LETTER", owner: "SERVICER" }), "seller");
  assert.equal(receivingSide({ kind: "HELLO_LETTER", owner: "BUYER" }), "desk");
});

test("what counts as sent depends on the item, and a tracking number becomes a link", () => {
  assert.match((readProof("ORIGINAL_NOTE", {}) as { error: string }).error, /tracking number/);
  assert.match((readProof("ORIGINAL_NOTE", { carrier: "PIGEON", trackingNumber: "123456789" }) as { error: string }).error, /carrier/);
  assert.deepEqual(readProof("ORIGINAL_NOTE", { carrier: "fedex", trackingNumber: "7712 3456 7890" }), { error: null, carrier: "FEDEX", trackingNumber: "771234567890", reference: "" });
  assert.equal((readProof("RECORDED_ASSIGNMENT", { instrument: "2026-0012345" }) as { reference: string }).reference, "Instrument 2026-0012345");
  assert.equal((readProof("RECORDED_ASSIGNMENT", { book: "1234", page: "56" }) as { reference: string }).reference, "Book 1234, page 56");
  assert.match((readProof("RECORDED_ASSIGNMENT", { book: "1234" }) as { error: string }).error, /instrument number/);
  assert.equal((readProof("ENOTE_CONTROL", { transferId: "TR-0098812" }) as { reference: string }).reference, "eRegistry transfer TR-0098812");
  assert.match((readProof("ENOTE_LOCATION", { transferId: "x" }) as { error: string }).error, /transfer ID/);
  assert.match((readProof("TITLE_ENDORSEMENT", {}) as { error: string }).error, /tracking number, a reference or a file/);
  assert.equal(readProof("TITLE_ENDORSEMENT", {}, true).error, null);
  assert.equal(trackingUrl("FEDEX", "7712 3456 7890"), "https://www.fedex.com/fedextrack/?trknbr=771234567890");
  assert.equal(trackingUrl("UPS", "1Z999AA10123456784"), "https://www.ups.com/track?tracknum=1Z999AA10123456784");
  assert.match(trackingUrl("USPS", "9400111899223817361234") ?? "", /^https:\/\/tools\.usps\.com\//);
  assert.match(trackingUrl("DHL", "1234567890") ?? "", /tracking-id=1234567890$/);
  assert.equal(trackingUrl("OTHER", "1234567890"), null);
  assert.equal(trackingUrl("FEDEX", "<script>"), null);
});

test("an owner hears three days out, on the day, then weekly while late, and the desk once at 14 days", () => {
  const dueAt = day("2026-12-10");
  assert.equal(reminderSlot(dueAt, noon("2026-12-06")), null);
  assert.equal(iso(reminderSlot(dueAt, noon("2026-12-07"))), "2026-12-07");
  assert.equal(iso(reminderSlot(dueAt, noon("2026-12-10"))), "2026-12-10");
  assert.equal(iso(reminderSlot(dueAt, noon("2026-12-16"))), "2026-12-10");
  assert.equal(iso(reminderSlot(dueAt, noon("2026-12-17"))), "2026-12-17");
  const doc = { status: "DUE", dueAt, remindedAt: null as Date | null, escalatedAt: null as Date | null };
  assert.equal(needsReminder(doc, noon("2026-12-07")), true);
  assert.equal(needsReminder({ ...doc, remindedAt: noon("2026-12-07") }, noon("2026-12-09")), false);
  assert.equal(needsReminder({ ...doc, remindedAt: noon("2026-12-07") }, noon("2026-12-10")), true);
  assert.equal(needsReminder({ ...doc, remindedAt: noon("2026-12-10") }, noon("2026-12-16")), false);
  assert.equal(needsReminder({ ...doc, remindedAt: noon("2026-12-10") }, noon("2026-12-17")), true);
  assert.equal(needsReminder({ ...doc, status: "SENT" }, noon("2026-12-17")), false);
  assert.equal(needsEscalation(doc, noon("2026-12-23")), false);
  assert.equal(needsEscalation(doc, noon("2026-12-24")), true);
  assert.equal(needsEscalation({ ...doc, escalatedAt: noon("2026-12-24") }, noon("2027-01-30")), false);
});

// ---------------------------------------------------------------------------------------------------------------
// The flow, on the database.

const loan = (street: string, extra: Record<string, unknown> = {}) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 120000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 100000, estimatedValue: 180000, ...extra,
});

async function makeWorld() {
  const tag = crypto.randomUUID().slice(0, 8);
  const email = (who: string) => `e-trailing-${tag}-${who}@example.org`;
  const user = (who: string, data: Record<string, unknown>) =>
    prisma.user.create({ data: { email: email(who), name: `${who} ${tag}`, accountStatus: "APPROVED", passwordHash: "x", ...data } as never });
  const seller = await user("seller", { role: "INDIVIDUAL_SELLER" });
  const buyer = await user("buyer", { role: "BUYER" });
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
      title: `E trailing ${tag}`,
      notes: { create: [loan("1 Paper Row", { servicerName: "Sample Servicing" }), loan("2 Vault Lane", { eNote: true, eRegistryController: "1000123", eRegistryLocation: "1000456" })] as never },
    },
    include: { notes: { orderBy: { streetAddress: "asc" } } },
  });
  const [paper, enote] = listing.notes;
  await prisma.collateralItem.create({ data: { noteId: paper.id, kind: "TITLE_POLICY", status: "PRESENT" } });
  return { tag, seller, buyer, stranger, closer, sales, listing, paper, enote, users: [seller, buyer, stranger, closer, sales] };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

// A closed closing with its checklist, as finalizeClosing leaves one, without the ledger and holdings.
async function closedClosing(world: World, extra: Record<string, unknown> = {}) {
  const inquiry = await prisma.inquiry.create({ data: { listingId: world.listing.id, buyerId: world.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 100000 } });
  return prisma.closing.create({
    data: {
      listingId: world.listing.id,
      inquiryId: inquiry.id,
      noteId: null,
      status: "COMPLETE",
      closedAt: noon("2026-11-06"),
      salePrice: 100000,
      buyerPremiumCents: 0,
      sellerCommissionCents: 0,
      buyerTotalCents: 10000000,
      netToSellerCents: 10000000,
      deskOwnerId: world.closer.id,
      steps: { create: ["PURCHASE_AGREEMENT", "BUYER_DEPOSIT", "COLLATERAL_TRANSFER", "ASSIGNMENT", "PAYMENT_RECEIVED", "CLOSED"].map((key) => ({ key, status: "COMPLETE" })) as never },
      ...extra,
    },
  });
}

async function cleanWorld(world: World) {
  const listingId = world.listing.id;
  const userIds = world.users.map((row) => row.id);
  const closings = await prisma.closing.findMany({ where: { listingId }, select: { id: true } });
  const closingIds = closings.map((row) => row.id);
  const inquiries = await prisma.inquiry.findMany({ where: { listingId }, select: { id: true } });
  await prisma.trailingDoc.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.servicerBoarding.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [listingId, ...userIds, ...closingIds, ...inquiries.map((row) => row.id)] } } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId } });
  await prisma.invoice.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.buyerHolding.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.collateralItem.deleteMany({ where: { noteId: { in: world.listing.notes.map((note) => note.id) } } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: world.users.map((row) => row.email) } }, { subject: { contains: world.listing.title } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const docsOf = (closingId: string) => prisma.trailingDoc.findMany({ where: { closingId }, orderBy: [{ kind: "asc" }, { noteId: "asc" }] });
const notices = (email: string, subject: string) =>
  prisma.notification.findMany({ where: { toEmail: email, subject: { contains: subject } }, orderBy: { createdAt: "asc" }, select: { subject: true, body: true } });

test("closing a deal lists its trailing documents once, and a second close adds nothing", async () => {
  const world = await makeWorld();
  try {
    const inquiry = await prisma.inquiry.create({ data: { listingId: world.listing.id, buyerId: world.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 100000 } });
    const opened = await openClosing({ listingId: world.listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 100000, title: world.listing.title });
    await prisma.closingStep.updateMany({ where: { closingId: opened.id }, data: { status: "COMPLETE", completedAt: new Date() } });
    await finalizeClosing(opened.id);
    const listed = await docsOf(opened.id);
    const kinds = (noteId: string | null) => listed.filter((doc) => doc.noteId === noteId).map((doc) => doc.kind).sort();
    assert.deepEqual(kinds(world.paper.id), ["ALLONGE", "ORIGINAL_NOTE", "RECORDED_ASSIGNMENT", "TITLE_ENDORSEMENT"]);
    assert.deepEqual(kinds(world.enote.id), ["ENOTE_CONTROL", "ENOTE_LOCATION", "RECORDED_ASSIGNMENT"]);
    assert.deepEqual(kinds(null), ["GOODBYE_LETTER", "HELLO_LETTER", "SERVICER_BOARDED", "SERVICER_WELCOME"]);
    assert.ok(listed.every((doc) => doc.status === "DUE"));
    // The goodbye's date fell before the close, so it's due a week on as a record of when it went, not late.
    const listedGoodbye = listed.find((doc) => doc.kind === "GOODBYE_LETTER")!;
    assert.ok(listedGoodbye.dueAt.getTime() > Date.now());

    await finalizeClosing(opened.id);
    assert.equal((await docsOf(opened.id)).length, listed.length);
    assert.deepEqual(await scheduleTrailingDocs(opened.id), { created: 0 });

    // A lost row comes back, and a twin made by two calls at once goes, leaving one of each.
    const hello = listed.find((doc) => doc.kind === "HELLO_LETTER")!;
    await prisma.trailingDoc.delete({ where: { id: hello.id } });
    const goodbye = listed.find((doc) => doc.kind === "GOODBYE_LETTER")!;
    await prisma.trailingDoc.create({ data: { closingId: opened.id, kind: goodbye.kind, owner: goodbye.owner, noteId: null, dueAt: goodbye.dueAt } });
    assert.deepEqual(await scheduleTrailingDocs(opened.id), { created: 1 });
    const again = await docsOf(opened.id);
    assert.equal(again.length, listed.length);
    assert.equal(new Set(again.map((doc) => `${doc.kind}:${doc.noteId}`)).size, listed.length);
  } finally {
    await cleanWorld(world);
  }
});

test("the owner records it sent, the other side confirms it, and the desk alone waives", async () => {
  const world = await makeWorld();
  try {
    const closing = await closedClosing(world);
    await scheduleTrailingDocs(closing.id);
    const find = async (kind: string, noteId: string | null) => (await docsOf(closing.id)).find((doc) => doc.kind === kind && doc.noteId === noteId)!;
    const note = await find("ORIGINAL_NOTE", world.paper.id);

    // Only the seller side or the desk records the note as sent, and only with its tracking.
    assert.deepEqual(await recordSent(world.buyer, { docId: note.id, carrier: "FEDEX", trackingNumber: "771234567890" }), { ok: false, error: "The seller records this one." });
    assert.deepEqual(await recordSent(world.stranger, { docId: note.id, carrier: "FEDEX", trackingNumber: "771234567890" }), { ok: false, error: "Only the parties and the desk keep this list." });
    assert.deepEqual(await recordSent(world.sales, { docId: note.id, carrier: "FEDEX", trackingNumber: "771234567890" }), { ok: false, error: DESK_DENIED });
    assert.equal((await recordSent(world.seller, { docId: note.id, carrier: "FEDEX" })).ok, false);
    assert.equal((await recordSent(world.seller, { docId: note.id, carrier: "FEDEX", trackingNumber: "7712 3456 7890", withAllonge: true })).ok, true);
    const sent = await find("ORIGINAL_NOTE", world.paper.id);
    assert.equal(sent.status, "SENT");
    assert.equal(sent.trackingNumber, "771234567890");
    assert.ok(sent.sentAt);
    // The allonge went with it, under the same tracking.
    const allonge = await find("ALLONGE", world.paper.id);
    assert.equal(allonge.status, "SENT");
    assert.equal(allonge.trackingNumber, "771234567890");
    const told = await notices(world.buyer.email, "Sent ·");
    assert.equal(told.length, 1);
    assert.match(told[0].body, /fedex\.com\/fedextrack\/\?trknbr=771234567890/);

    // The receiving side confirms; the sender can't.
    assert.deepEqual(await confirmReceived(world.seller, { docId: note.id }), { ok: false, error: "The buyer confirms this one." });
    const received = await confirmReceived(world.buyer, { docId: note.id }, noon("2026-11-14"));
    assert.equal(received.ok, true);
    const got = await find("ORIGINAL_NOTE", world.paper.id);
    assert.equal(got.status, "RECEIVED");
    assert.equal(got.confirmedById, world.buyer.id);
    assert.equal(iso(got.receivedAt), "2026-11-14");
    assert.equal((await confirmReceived(world.buyer, { docId: note.id })).ok, false);
    // The desk can confirm too.
    assert.equal((await confirmReceived(world.closer, { docId: allonge.id })).ok, true);

    // The recording, with a copy filed under the closing's own files.
    const assignment = await find("RECORDED_ASSIGNMENT", world.paper.id);
    const pdf = Buffer.from("%PDF-1.4\n% trailing test\n");
    assert.equal((await recordSent(world.seller, { docId: assignment.id, instrument: "2026-0012345", file: { name: "assignment.pdf", type: "application/pdf", bytes: pdf } })).ok, true);
    const recorded = await find("RECORDED_ASSIGNMENT", world.paper.id);
    assert.equal(recorded.reference, "Instrument 2026-0012345");
    const file = await prisma.closingFile.findUnique({ where: { id: recorded.documentId ?? "" }, include: { step: true } });
    assert.equal(file?.step.closingId, closing.id);
    assert.equal(file?.step.key, "ASSIGNMENT");

    // Waiving is the closings desk's, with a reason.
    const title = await find("TITLE_ENDORSEMENT", world.paper.id);
    assert.deepEqual(await waiveTrailingDoc(world.buyer, { docId: title.id, reason: "Not needed here" }), { ok: false, error: "Only the desk waives an item." });
    assert.deepEqual(await waiveTrailingDoc(world.sales, { docId: title.id, reason: "Not needed here" }), { ok: false, error: DESK_DENIED });
    assert.equal((await waiveTrailingDoc(world.closer, { docId: title.id, reason: "no" })).ok, false);
    assert.equal((await waiveTrailingDoc(world.closer, { docId: title.id, reason: "The buyer's own title company endorses it." })).ok, true);
    const waived = await find("TITLE_ENDORSEMENT", world.paper.id);
    assert.equal(waived.status, "WAIVED");
    assert.equal(waived.waivedById, world.closer.id);
    assert.equal((await waiveTrailingDoc(world.closer, { docId: title.id, reason: "Again, for the record" })).ok, false);

    // An eNote: the buyer names the Org ID, the seller hears and records the eRegistry transfer.
    const control = await find("ENOTE_CONTROL", world.enote.id);
    assert.deepEqual(await recordTransferee(world.buyer, { docId: control.id, orgId: "12345" }), { ok: false, error: "A MERS Org ID is 7 digits." });
    assert.equal((await recordTransferee(world.seller, { docId: control.id, orgId: "1000789" })).ok, false);
    assert.equal((await recordTransferee(world.buyer, { docId: control.id, orgId: "100-0789" })).ok, true);
    assert.equal((await find("ENOTE_CONTROL", world.enote.id)).note, "Transfer to MERS Org ID 1000789");
    assert.equal((await notices(world.seller.email, "MERS Org ID")).length, 1);
    assert.equal((await recordSent(world.seller, { docId: control.id })).ok, false);
    assert.equal((await recordSent(world.seller, { docId: control.id, transferId: "TR-0098812" })).ok, true);
    assert.equal((await find("ENOTE_CONTROL", world.enote.id)).reference, "eRegistry transfer TR-0098812");

    // Nothing moves before the file closes.
    await prisma.closing.update({ where: { id: closing.id }, data: { status: "OPEN" } });
    const location = await find("ENOTE_LOCATION", world.enote.id);
    assert.deepEqual(await recordSent(world.seller, { docId: location.id, transferId: "TR-0098813" }), { ok: false, error: "Trailing documents start once the file is closed." });
  } finally {
    await cleanWorld(world);
  }
});

test("the sale notice, the boarding date and the old servicer's letter receive their items, and the last one completes the file once", async () => {
  const world = await makeWorld();
  try {
    const closing = await closedClosing(world);
    await scheduleTrailingDocs(closing.id);
    const status = async (kind: string) => (await docsOf(closing.id)).find((doc) => doc.kind === kind)!;

    // A boarding date still ahead isn't boarded yet.
    await prisma.servicerBoarding.create({ data: { closingId: closing.id, servicerName: "New Servicer", boardedAt: day("2026-11-20") } });
    assert.equal(await syncTrailingDocs(closing.id, noon("2026-11-12")), 0);
    assert.equal((await status("SERVICER_BOARDED")).status, "DUE");
    await prisma.servicerBoarding.update({ where: { closingId: closing.id }, data: { goodbyeSentAt: day("2026-11-05") } });
    await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeSentAt: day("2026-11-18") } });
    assert.equal(await syncTrailingDocs(closing.id, noon("2026-11-25")), 3);
    const boarded = await status("SERVICER_BOARDED");
    assert.equal(boarded.status, "RECEIVED");
    assert.equal(iso(boarded.receivedAt), "2026-11-20");
    assert.equal(iso((await status("HELLO_LETTER")).receivedAt), "2026-11-18");
    assert.equal((await status("GOODBYE_LETTER")).status, "RECEIVED");
    assert.equal(await syncTrailingDocs(closing.id, noon("2026-11-25")), 0);

    // Everything else is received or waived, and the file is complete. Both sides hear once.
    const rest = (await docsOf(closing.id)).filter((doc) => doc.status === "DUE");
    for (const doc of rest.slice(1)) assert.equal((await waiveTrailingDoc(world.closer, { docId: doc.id, reason: "Handled outside the app for this test." })).ok, true);
    assert.equal((await prisma.closing.findUnique({ where: { id: closing.id } }))?.postCloseCompleteAt ?? null, null);
    const last = await confirmReceived(world.closer, { docId: rest[0].id });
    assert.deepEqual(last, { ok: true, value: { id: rest[0].id, complete: true } });
    assert.ok((await prisma.closing.findUnique({ where: { id: closing.id } }))?.postCloseCompleteAt);
    assert.equal(await completeIfDone(closing.id), false);
    assert.equal((await notices(world.seller.email, "File complete")).length, 1);
    assert.equal((await notices(world.buyer.email, "File complete")).length, 1);
  } finally {
    await cleanWorld(world);
  }
});

test("reminders and the escalation each go once, to the side that owes the item and then to the deal owner", async () => {
  const world = await makeWorld();
  try {
    const closing = await closedClosing(world);
    const dueAt = day("2026-12-10");
    await prisma.trailingDoc.createMany({
      data: [
        { closingId: closing.id, noteId: world.paper.id, kind: "ORIGINAL_NOTE", owner: "SELLER", dueAt },
        { closingId: closing.id, noteId: null, kind: "HELLO_LETTER", owner: "BUYER", dueAt },
        { closingId: closing.id, noteId: null, kind: "SERVICER_BOARDED", owner: "SERVICER", dueAt: day("2027-03-01") },
      ],
    });
    const run = (at: string) => remindTrailingDocs(noon(at), { closingIds: [closing.id] });
    const count = async (email: string, subject = "Trailing documents ·") => (await notices(email, subject)).length;

    assert.equal((await run("2026-12-06")).sent, 0);
    assert.equal((await run("2026-12-07")).sent, 1);
    assert.equal(await count(world.seller.email), 1);
    assert.equal(await count(world.buyer.email), 1);
    assert.match((await notices(world.seller.email, "Trailing documents ·"))[0].body, /Original note · 1 Paper Row, Tampa, FL: due Dec 10, 2026/);
    // An overlapping run, and the days after, send nothing more until the due day.
    assert.equal((await run("2026-12-07")).sent, 0);
    assert.equal((await run("2026-12-09")).sent, 0);
    assert.equal((await run("2026-12-10")).sent, 1);
    assert.equal((await run("2026-12-12")).sent, 0);
    assert.equal((await run("2026-12-17")).sent, 1);
    assert.equal(await count(world.seller.email), 3);
    assert.match((await notices(world.seller.email, "Trailing documents ·")).at(-1)!.body, /late, was due Dec 10, 2026/);
    assert.equal(await count(world.closer.email, "Trailing documents late"), 0);
    // Fourteen days late: the weekly reminder and, once, the deal owner.
    assert.equal((await run("2026-12-24")).sent, 1);
    assert.equal(await count(world.closer.email, "Trailing documents late"), 1);
    assert.equal((await run("2026-12-25")).sent, 0);
    assert.equal((await run("2026-12-31")).sent, 1);
    assert.equal(await count(world.closer.email, "Trailing documents late"), 1);
    assert.equal(await count(world.seller.email), 5);
    // An item sent stops its reminders.
    const note = (await docsOf(closing.id)).find((doc) => doc.kind === "ORIGINAL_NOTE")!;
    assert.equal((await recordSent(world.seller, { docId: note.id, carrier: "UPS", trackingNumber: "1Z999AA10123456784" })).ok, true);
    assert.equal((await run("2027-01-07")).sent, 1);
    assert.equal(await count(world.seller.email), 5);
  } finally {
    await cleanWorld(world);
  }
});

test("a closing that closed before the list existed gets one, with a week's grace, and an old one doesn't", async () => {
  const world = await makeWorld();
  try {
    const now = noon("2026-11-09");
    const recent = await closedClosing(world, { closedAt: noon("2026-09-01") });
    const old = await closedClosing(world, { closedAt: noon("2025-06-01") });
    assert.equal(await backfillTrailingDocs(now, { closingIds: [recent.id, old.id] }), 1);
    const listed = await docsOf(recent.id);
    assert.ok(listed.length > 0);
    // Everything that would already be late is due a week from today instead; later dates stand.
    assert.equal(iso(listed.find((doc) => doc.kind === "ORIGINAL_NOTE")?.dueAt), "2026-11-16");
    assert.equal(iso(listed.find((doc) => doc.kind === "RECORDED_ASSIGNMENT")?.dueAt), "2026-11-30");
    assert.equal((await docsOf(old.id)).length, 0);
    // The job's own pass builds nothing twice and owes no reminder yet.
    const tally = await runTrailingDocs(now, { closingIds: [recent.id, old.id] });
    assert.equal(tally.sent, 0);
    assert.equal((await docsOf(recent.id)).length, listed.length);
  } finally {
    await cleanWorld(world);
  }
});

test("the goodbye listed after its date asks for a record, the letters follow a later servicing date, and the welcome is received", async () => {
  const world = await makeWorld();
  try {
    const closing = await closedClosing(world);
    await scheduleTrailingDocs(closing.id, { now: noon("2026-11-06") });
    const find = async (kind: string) => (await docsOf(closing.id)).find((doc) => doc.kind === kind && !doc.noteId)!;
    // 15 days before the close had passed when the list was built, so it's due a week on.
    assert.equal(iso((await find("GOODBYE_LETTER")).dueAt), "2026-11-13");
    assert.equal(iso((await find("SERVICER_WELCOME")).dueAt), "2026-11-21");
    assert.equal(iso((await find(SALE_NOTICE)).dueAt), "2026-12-06");
    await remindTrailingDocs(noon("2026-11-10"), { closingIds: [closing.id] });
    const told = (await notices(world.seller.email, "Trailing documents ·")).map((row) => row.body).join("\n");
    assert.match(told, /Old servicer's goodbye letter: record when it went by Nov 13, 2026 \(it was due Oct 22, 2026\)/);

    // The parties set the servicing transfer for 1 December: both servicer letters move, still ahead.
    await prisma.servicerBoarding.create({ data: { closingId: closing.id, servicerName: "New Servicer", boardedAt: day("2026-12-01") } });
    await syncTrailingDocs(closing.id, noon("2026-11-10"));
    assert.equal(iso((await find("GOODBYE_LETTER")).dueAt), "2026-11-16");
    assert.equal(iso((await find("SERVICER_WELCOME")).dueAt), "2026-12-16");
    // A date moved into the past leaves its item where it is rather than late at once.
    await prisma.closing.update({ where: { id: closing.id }, data: { transferAt: day("2026-10-01") } });
    await syncTrailingDocs(closing.id, noon("2026-11-10"));
    assert.equal(iso((await find(SALE_NOTICE)).dueAt), "2026-12-06");

    // The new servicer's letter date receives the welcome, and the boarding date the boarding.
    await prisma.servicerBoarding.update({ where: { closingId: closing.id }, data: { helloSentAt: day("2026-12-03") } });
    assert.equal(await syncTrailingDocs(closing.id, noon("2026-12-04")), 2);
    const welcome = await find("SERVICER_WELCOME");
    assert.equal(welcome.status, "RECEIVED");
    assert.equal(iso(welcome.receivedAt), "2026-12-03");
  } finally {
    await cleanWorld(world);
  }
});

test("an old HELLO_LETTER row still shows, counts and is received as the sale notice, with its proof", async () => {
  const world = await makeWorld();
  try {
    const closing = await closedClosing(world);
    // A closing listed before the welcome letter had an item: three letters, the sale notice stored as HELLO_LETTER.
    await prisma.trailingDoc.createMany({
      data: [
        { closingId: closing.id, noteId: null, kind: "GOODBYE_LETTER", owner: "SERVICER", dueAt: day("2026-11-21") },
        { closingId: closing.id, noteId: null, kind: "HELLO_LETTER", owner: "BUYER", dueAt: day("2026-12-06") },
        { closingId: closing.id, noteId: null, kind: "SERVICER_BOARDED", owner: "SERVICER", dueAt: day("2026-12-06") },
      ],
    });
    // Building again adds the welcome letter and the loans' items, and no second sale notice.
    await scheduleTrailingDocs(closing.id, { now: noon("2026-11-09") });
    const rows = await docsOf(closing.id);
    assert.equal(rows.filter((doc) => doc.kind === "HELLO_LETTER").length, 1);
    assert.deepEqual(rows.filter((doc) => !doc.noteId).map((doc) => doc.kind), ["GOODBYE_LETTER", "HELLO_LETTER", "SERVICER_BOARDED", "SERVICER_WELCOME"]);
    // Recording the notice sent, with its proof, receives the old row and puts the proof on it.
    await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeSentAt: day("2026-11-20"), ownerNoticeProof: "USPS certified 9407 1118 9876 5432 1012 34" } });
    assert.equal(await syncTrailingDocs(closing.id, noon("2026-11-21")), 1);
    const sale = (await docsOf(closing.id)).find((doc) => doc.kind === "HELLO_LETTER")!;
    assert.equal(sale.status, "RECEIVED");
    assert.equal(iso(sale.receivedAt), "2026-11-20");
    assert.equal(sale.reference, "USPS certified 9407 1118 9876 5432 1012 34");
    const audited = await prisma.auditEvent.findFirst({ where: { entityId: closing.id, action: "TRAILING_RECEIVED" }, orderBy: { createdAt: "desc" } });
    assert.match(audited?.detail ?? "", /^Owner's sale notice to the borrower: from the sale notice recorded/);
    // The list itself refuses to mark it sent, so the notice and its item can't disagree.
    await prisma.trailingDoc.update({ where: { id: sale.id }, data: { status: "DUE" } });
    assert.deepEqual(await recordSent(world.buyer, { docId: sale.id, reference: "Mailed" }), { ok: false, error: "Record the sale notice under Borrower notices, with its proof of mailing." });
  } finally {
    await cleanWorld(world);
  }
});

test("each exemption marks the sale notice not needed and stops its reminders; clearing one brings it back", async () => {
  const world = await makeWorld();
  try {
    const closing = await closedClosing(world);
    await scheduleTrailingDocs(closing.id, { now: noon("2026-11-06") });
    const sale = async () => (await docsOf(closing.id)).find((doc) => doc.kind === SALE_NOTICE)!;
    for (const exemption of ["ONE_LOAN", "RESOLD_30", "PARTIAL"]) {
      await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeExemption: exemption } });
      await syncTrailingDocs(closing.id, noon("2026-11-20"));
      const waived = await sale();
      assert.equal(waived.status, "WAIVED", exemption);
      assert.equal(waived.waivedById, null);
      assert.match(waived.waivedReason ?? "", /^Not needed: /);
      await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeExemption: null } });
      await syncTrailingDocs(closing.id, noon("2026-11-20"));
      assert.equal((await sale()).status, "DUE", exemption);
    }
    // With an exemption on file the list's reminder leaves the notice out; without one it's there.
    await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeExemption: "PARTIAL" } });
    await syncTrailingDocs(closing.id, noon("2026-11-20"));
    await remindTrailingDocs(noon("2026-12-03"), { closingIds: [closing.id] });
    assert.doesNotMatch((await notices(world.buyer.email, "Trailing documents ·")).map((row) => row.body).join("\n"), /sale notice/);
    await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeExemption: null } });
    await syncTrailingDocs(closing.id, noon("2026-11-20"));
    await remindTrailingDocs(noon("2026-12-06"), { closingIds: [closing.id] });
    assert.match((await notices(world.buyer.email, "Trailing documents ·")).at(-1)!.body, /Owner's sale notice to the borrower: due Dec 6, 2026/);
    // A waiver the desk made itself never comes back on its own.
    const item = await sale();
    assert.equal((await waiveTrailingDoc(world.closer, { docId: item.id, reason: "The buyer's counsel sent it outside the app." })).ok, true);
    await syncTrailingDocs(closing.id, noon("2026-12-07"));
    assert.equal((await sale()).status, "WAIVED");
  } finally {
    await cleanWorld(world);
  }
});

test("UPB's record of the owner's other purchases counts closings within 12 months of the transfer", async () => {
  const world = await makeWorld();
  try {
    const closing = await closedClosing(world);
    assert.equal(await otherPurchasesOnUpb(closing, world.buyer.id, day("2026-11-06")), 0);
    await closedClosing(world, { closedAt: noon("2026-03-01") });
    await closedClosing(world, { closedAt: noon("2025-06-01") });
    // March is within 12 months of the transfer; the year before last isn't, and an open closing isn't a purchase.
    await closedClosing(world, { status: "OPEN", closedAt: null });
    assert.equal(await otherPurchasesOnUpb(closing, world.buyer.id, day("2026-11-06")), 1);
    assert.equal(await otherPurchasesOnUpb(closing, world.stranger.id, day("2026-11-06")), 0);
  } finally {
    await cleanWorld(world);
  }
});
