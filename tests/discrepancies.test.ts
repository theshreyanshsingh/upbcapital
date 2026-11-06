import assert from "node:assert/strict";
import test from "node:test";
import {
  answerDiscrepancy,
  approvalHold,
  canAnswer,
  changeLog,
  deskResolveDiscrepancy,
  gateMessage,
  noteValue,
  raiseDiscrepancy,
  settleByEdit,
  type DiscrepancyRow,
} from "../lib/discrepancies";
import { chainDetail, chainOfTitle, cureCountdown, daysToCure, fieldSpec, fieldState, markFieldVerified, verifiedMap } from "../lib/loan-file";
import { prisma } from "../lib/prisma";

const NOV_5 = new Date("2026-11-05T15:00:00.000Z");

test("the gate message counts what is open and says who answers", () => {
  assert.equal(gateMessage(0), null);
  assert.match(gateMessage(1) ?? "", /^One tape difference is open\. The seller fixes or explains each one/);
  assert.match(gateMessage(3) ?? "", /^3 tape differences are open\./);
  assert.equal(canAnswer("u1", { sellerId: "u1", brokerId: null }), true);
  assert.equal(canAnswer("b1", { sellerId: "u1", brokerId: "b1" }), true);
  assert.equal(canAnswer("u2", { sellerId: "u1", brokerId: "b1" }), false);
  assert.equal(canAnswer("", { sellerId: "", brokerId: null }), false);
});

test("a document's value is typed for the tape's own column, or refused in words", () => {
  const value = (field: string, text: string) => noteValue(fieldSpec(field)!, text);
  assert.deepEqual(value("upb", "97500"), { ok: true, value: 97500 });
  assert.deepEqual(value("interestRate", "7.375"), { ok: true, value: 7.375 });
  assert.deepEqual(value("monthsDelinquent", "3"), { ok: true, value: 3 });
  assert.deepEqual(value("occupancy", "VACANT"), { ok: true, value: "VACANT" });
  assert.deepEqual(value("hoaLien", "yes"), { ok: true, value: true });
  const date = value("maturityDate", "2056-01-01");
  assert.ok(date.ok && date.value instanceof Date && date.value.toISOString() === "2056-01-01T00:00:00.000Z");
  assert.equal(value("occupancy", "Squatters").ok, false);
  assert.equal(value("upb", "").ok, false);
  assert.equal(value("upb", "lots").ok, false);
});

test("the desk's reading raises a difference, each answer settles it, and approval waits on all of them", async () => {
  const tag = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const make = (name: string, role: "INDIVIDUAL_SELLER" | "ADMIN" | "BROKER") =>
    prisma.user.create({ data: { email: `disc-${name}-${tag}@example.org`, name: `${name} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const [seller, broker, desk, stranger] = await Promise.all([make("seller", "INDIVIDUAL_SELLER"), make("broker", "BROKER"), make("desk", "ADMIN"), make("stranger", "INDIVIDUAL_SELLER")]);
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      brokerId: broker.id,
      brokerRole: "AFFILIATE",
      status: "UNDER_REVIEW",
      title: `Discrepancy ${tag}`,
      notes: {
        create: [{
          streetAddress: "9 Gate St", city: "Reno", state: "NV", zip: "89501", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST", upb: 100000, interestRate: 7.125, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 80000, estimatedValue: 150000, borrowerName: "Ana Ruiz",
          lastPaidDate: new Date("2026-10-01T00:00:00Z"), maturityDate: new Date("2055-01-01T00:00:00Z"),
        }],
      },
    },
    include: { notes: true },
  });
  const noteId = listing.notes[0].id;
  const rowsFor = (field: string) => prisma.fieldDiscrepancy.findMany({ where: { noteId, field }, orderBy: { createdAt: "asc" } });
  try {
    // Raising on a mismatch: the document's value sits beside the tape's, and the rate keeps its third decimal.
    const upb = await markFieldVerified(desk.id, { noteId, field: "upb", source: "Pay history", document: "$97,500" });
    assert.ok(upb.ok && upb.value.raised && upb.value.document === "97500");
    let [row] = await rowsFor("upb");
    assert.deepEqual(
      { field: row.field, tape: row.tapeValue, document: row.documentValue, source: row.source, status: row.status, by: row.raisedById, listing: row.listingId },
      { field: "upb", tape: "100000", document: "97500", source: "Pay history", status: "OPEN", by: desk.id, listing: listing.id },
    );
    // Reading the same document again updates the open question rather than asking twice.
    assert.ok((await markFieldVerified(desk.id, { noteId, field: "upb", source: "Pay history", document: "97500" })).ok);
    assert.equal((await rowsFor("upb")).length, 1);
    assert.ok((await markFieldVerified(desk.id, { noteId, field: "interestRate", source: "Original note", document: "7.375" })).ok);
    assert.deepEqual((await rowsFor("interestRate")).map((item) => [item.tapeValue, item.documentValue]), [["7.125", "7.375"]]);
    // A reading that matches raises nothing.
    const pi = await markFieldVerified(desk.id, { noteId, field: "monthlyPi", source: "Original note", document: "700" });
    assert.ok(pi.ok && !pi.value.raised);
    assert.equal((await rowsFor("monthlyPi")).length, 0);

    // By hand: refused when the document agrees, and the field stays seller-stated when it doesn't.
    assert.deepEqual(await raiseDiscrepancy(desk.id, { noteId, field: "occupancy", document: "Owner occupied", source: "BPO" }), { ok: false, error: "The document matches the tape. Verify the field instead." });
    assert.equal((await raiseDiscrepancy(desk.id, { noteId, field: "occupancy", document: "", source: "BPO" })).ok, false);
    const occupancy = await raiseDiscrepancy(desk.id, { noteId, field: "occupancy", document: "Vacant", source: "BPO" });
    assert.ok(occupancy.ok && occupancy.value.documentValue === "VACANT" && occupancy.value.status === "OPEN");
    const months = await raiseDiscrepancy(desk.id, { noteId, field: "monthsDelinquent", document: "2", source: "Servicer statement" });
    assert.ok(months.ok);
    let note = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
    assert.equal(fieldState(note, "occupancy").state, "seller-stated");
    assert.equal(fieldState(note, "upb").state, "disputed");

    // The gate holds while any is open.
    assert.match((await approvalHold(listing.id)) ?? "", /^4 tape differences are open/);

    // Only the seller on file or the filing broker answers, and an explanation needs a sentence.
    [row] = await rowsFor("upb");
    assert.deepEqual(await answerDiscrepancy(stranger.id, { id: row.id, answer: "FIX" }), { ok: false, error: "That difference isn't on your listing." });
    assert.equal((await answerDiscrepancy(desk.id, { id: row.id, answer: "FIX" })).ok, false);
    const [rate] = await rowsFor("interestRate");
    assert.equal((await answerDiscrepancy(broker.id, { id: rate.id, answer: "EXPLAIN", note: "ok" })).ok, false);

    // Fixed: the tape takes the document's value, and the desk's check now holds for it.
    const fixed = await answerDiscrepancy(seller.id, { id: row.id, answer: "FIX" });
    assert.ok(fixed.ok && fixed.value.status === "FIXED" && fixed.value.tapeChanged && fixed.value.remaining === 3);
    note = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
    assert.equal(Number(note.upb), 97500);
    assert.equal(fieldState(note, "upb").state, "verified");
    assert.deepEqual(await answerDiscrepancy(seller.id, { id: row.id, answer: "EXPLAIN", note: "Changed my mind about this one." }), { ok: false, error: "That difference is already answered." });

    // Explained, by the filing broker: the tape stands and the note is kept.
    const explained = await answerDiscrepancy(broker.id, { id: rate.id, answer: "EXPLAIN", note: "The 2024 modification set the rate. It is in the data room." });
    assert.ok(explained.ok && explained.value.status === "EXPLAINED" && !explained.value.tapeChanged);
    const rateRow = await prisma.fieldDiscrepancy.findUniqueOrThrow({ where: { id: rate.id } });
    assert.equal(rateRow.sellerNote, "The 2024 modification set the rate. It is in the data room.");
    assert.equal(rateRow.resolvedById, broker.id);
    assert.equal(Number((await prisma.note.findUniqueOrThrow({ where: { id: noteId } })).interestRate), 7.125);
    // The same reading again doesn't reopen an explained difference.
    const again = await markFieldVerified(desk.id, { noteId, field: "interestRate", source: "Original note", document: "7.375" });
    assert.ok(again.ok && !again.value.raised);
    assert.equal((await rowsFor("interestRate")).length, 1);

    // Accepted by the desk: the tape takes the value and the desk signs the field.
    assert.equal((await deskResolveDiscrepancy(desk.id, { id: occupancy.value.id, answer: "ACCEPT", reason: "" })).ok, false);
    const accepted = await deskResolveDiscrepancy(desk.id, { id: occupancy.value.id, answer: "ACCEPT", reason: "The BPO and the drive-by both show it empty." });
    assert.ok(accepted.ok && accepted.value.status === "ACCEPTED");
    note = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
    assert.equal(note.occupancy, "VACANT");
    const signed = fieldState(note, "occupancy");
    assert.ok(signed.state === "verified" && signed.source === "BPO" && signed.by === desk.id);
    assert.equal(verifiedMap(note.verifiedFields).occupancy?.value, "VACANT");

    // Waived by the desk while the listing is in contract: the tape doesn't move, and a fix is refused there.
    await prisma.listing.update({ where: { id: listing.id }, data: { status: "PENDING" } });
    const frozen = await answerDiscrepancy(seller.id, { id: months.value.id, answer: "FIX" });
    assert.ok(!frozen.ok && /in contract or closed/.test(frozen.error));
    assert.equal((await deskResolveDiscrepancy(desk.id, { id: months.value.id, answer: "ACCEPT", reason: "Servicer statement governs." })).ok, false);
    const waived = await deskResolveDiscrepancy(desk.id, { id: months.value.id, answer: "WAIVE", reason: "The statement predates the cure." });
    assert.ok(waived.ok && waived.value.status === "WAIVED" && waived.value.remaining === 0);
    assert.equal((await prisma.note.findUniqueOrThrow({ where: { id: noteId } })).monthsDelinquent, 0);
    await prisma.listing.update({ where: { id: listing.id }, data: { status: "UNDER_REVIEW" } });

    // Every one answered, so approval is clear.
    assert.equal(await approvalHold(listing.id), null);

    // A matching reading after the tape moved settles an open question as accepted.
    assert.ok((await markFieldVerified(desk.id, { noteId, field: "estimatedValue", source: "BPO", document: "140000" })).ok);
    await prisma.note.update({ where: { id: noteId }, data: { estimatedValue: 140000 } });
    assert.ok((await markFieldVerified(desk.id, { noteId, field: "estimatedValue", source: "BPO", document: "140000" })).ok);
    assert.deepEqual((await rowsFor("estimatedValue")).map((item) => item.status), ["ACCEPTED"]);

    // Auto-resolve on edit: a seller's edit to the document's value fixes that question and leaves the rest open.
    assert.ok((await markFieldVerified(desk.id, { noteId, field: "maturityDate", source: "Original note", document: "2056-01-01" })).ok);
    assert.ok((await markFieldVerified(desk.id, { noteId, field: "lastPaidDate", source: "Pay history", document: "2026-09-01" })).ok);
    await prisma.note.update({ where: { id: noteId }, data: { maturityDate: new Date("2056-01-01T00:00:00Z"), lastPaidDate: new Date("2026-10-15T00:00:00Z") } });
    assert.equal(await settleByEdit(seller.id, noteId), 1);
    const [maturity] = await rowsFor("maturityDate");
    assert.equal(maturity.status, "FIXED");
    assert.equal(maturity.resolvedById, seller.id);
    assert.equal((await rowsFor("lastPaidDate"))[0].status, "OPEN");
    assert.equal(fieldState(await prisma.note.findUniqueOrThrow({ where: { id: noteId } }), "maturityDate").state, "verified");
    assert.match((await approvalHold(listing.id)) ?? "", /^One tape difference is open/);

    // Audit lines name the field and the document, never a value.
    const events = await prisma.auditEvent.findMany({ where: { entityType: "note", entityId: noteId }, select: { action: true, detail: true } });
    for (const action of ["DISCREPANCY_RAISED", "DISCREPANCY_FIXED", "DISCREPANCY_EXPLAINED", "DISCREPANCY_ACCEPTED", "DISCREPANCY_WAIVED"]) {
      assert.ok(events.some((event) => event.action === action), action);
    }
    assert.ok(!events.some((event) => /97500|7\.375|VACANT|Ana Ruiz/.test(event.detail)));
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: noteId } });
    await prisma.fieldDiscrepancy.deleteMany({ where: { listingId: listing.id } });
    await prisma.listingMatch.deleteMany({ where: { listingId: listing.id } });
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.user.deleteMany({ where: { id: { in: [seller.id, broker.id, desk.id, stranger.id] } } });
  }
});

test("the change log shows a figure only where the listing already shows it", () => {
  const base = { noteId: "n1", listingId: "l1", raisedById: "d1", resolvedById: "s1", createdAt: new Date("2026-11-01T12:00:00Z") };
  const rows: DiscrepancyRow[] = [
    { ...base, id: "a", field: "upb", status: "FIXED", tapeValue: "100000", documentValue: "97500", source: "Pay history", sellerNote: "", resolvedAt: NOV_5 },
    { ...base, id: "b", field: "interestRate", status: "EXPLAINED", tapeValue: "7.125", documentValue: "7.375", source: "Original note", sellerNote: "The 2024 modification set the rate.", resolvedAt: new Date("2026-11-04T12:00:00Z") },
    { ...base, id: "c", field: "borrowerName", status: "WAIVED", tapeValue: "Ana Ruiz", documentValue: "Ana Ruiz-Lopez", source: "Original note", sellerNote: "Same person, married name.", resolvedAt: new Date("2026-11-03T12:00:00Z") },
    { ...base, id: "d", field: "occupancy", status: "OPEN", tapeValue: "OWNER_OCCUPIED", documentValue: "VACANT", source: "BPO", sellerNote: "", resolvedAt: null },
    { ...base, id: "e", field: "monthlyPi", status: "ACCEPTED", tapeValue: "700", documentValue: "712.5", source: "Other", sellerNote: "Escrow excluded.", resolvedAt: new Date("2026-11-02T12:00:00Z") },
  ];
  const text = (viewer: { open: boolean; pro: boolean }) => Object.fromEntries(changeLog(rows, viewer).map((entry) => [entry.id, entry]));

  const free = text({ open: false, pro: false });
  assert.deepEqual(changeLog(rows, { open: false, pro: false }).map((entry) => entry.id), ["a", "b", "c", "e", "d"]);
  assert.equal(free.a.text, "UPB changed on Nov 5, 2026 to match the pay history.");
  assert.equal(free.b.text, "Note rate differs from the original note. The seller explained it on Nov 4, 2026.");
  assert.equal(free.b.note, null);
  assert.equal(free.b.noteGate, "The note opens with the loan's street and borrower.");
  assert.equal(free.c.text, "Borrower differs from the original note. The desk waived it on Nov 3, 2026.");
  // Occupancy is neither a balance nor an identity field, so its values show to everyone.
  assert.equal(free.d.text, "Occupancy differs from the BPO, which shows Vacant against the tape's Owner occupied. Raised on Nov 1, 2026. The seller hasn't answered yet.");
  assert.equal(free.e.text, "Monthly P&I changed on Nov 2, 2026 to match the document. The desk made the change.");
  for (const entry of Object.values(free)) assert.ok(!/\$|%|Ana/.test(entry.text), entry.text);

  const pro = text({ open: false, pro: true });
  assert.equal(pro.a.text, "UPB changed from $100,000 to $97,500 on Nov 5, 2026 to match the pay history.");
  assert.equal(pro.b.text, "Note rate differs from the original note, which shows 7.375% against the tape's 7.125%. The seller explained it on Nov 4, 2026.");
  assert.equal(pro.b.note, null);
  assert.ok(!pro.c.text.includes("Ana"));

  const openFree = text({ open: true, pro: false });
  assert.ok(!openFree.a.text.includes("$"));
  assert.equal(openFree.b.noteGate, "The note shows with Pro.");
  assert.equal(openFree.c.text, "Borrower differs from the original note, which shows Ana Ruiz-Lopez against the tape's Ana Ruiz. The desk waived it on Nov 3, 2026.");
  assert.deepEqual(openFree.c.note, { by: "Desk", text: "Same person, married name." });

  const full = text({ open: true, pro: true });
  assert.deepEqual(full.b.note, { by: "Seller", text: "The 2024 modification set the rate." });
  assert.equal(full.b.noteGate, null);
  assert.equal(full.e.text, "Monthly P&I changed from $700 to $713 on Nov 2, 2026 to match the document. The desk made the change.");
});

test("an endorsement's kind, loan number and attachment date raise their own cautions, with no party named", () => {
  const listedAt = new Date("2026-10-20T14:00:00Z");
  const allonge = (id: string, sequence: number, from: string, to: string, extra: Record<string, unknown> = {}) => ({
    id, kind: "ALLONGE", status: "PRESENT", sequence, detail: chainDetail(from, to),
    datedOn: new Date("2019-03-01T00:00:00Z"), attachedAt: new Date("2019-03-04T00:00:00Z"), ...extra,
  });
  const chain = chainOfTitle([
    allonge("a1", 1, "First Bank", "", { endorsement: "BLANK" }),
    allonge("a2", 2, "Coastal Capital", "Harbor Notes", { endorsement: "SPECIAL", loanNumberMatch: false, attachedAt: new Date("2026-10-21T00:00:00Z") }),
    allonge("a3", 3, "Harbor Notes", "Bayview", { endorsement: "NONE", attachedAt: new Date("2026-10-20T00:00:00Z") }),
  ], "Bayview", { listedAt });
  const links = chain.endorsements.links;
  // A blank endorsement needs no endorsee, and whoever holds bearer paper may endorse it on.
  assert.equal(links[0].to, "In blank");
  assert.equal(links[0].blank, true);
  assert.equal(links[1].gap, false);
  assert.equal(links[1].endorsement, "SPECIAL");
  assert.equal(links[1].loanNumberMatch, false);
  assert.deepEqual(chain.endorsements.cautions, [
    "The endorsement at step 2 was fixed to the note after the listing was filed.",
    "The loan number on the endorsement at step 2 doesn't match the note.",
  ]);
  // An allonge that endorses nothing breaks the chain, and counts as an open defect.
  assert.deepEqual(chain.endorsements.breaks.map((item) => item.message), ["The allonge at step 3 carries no endorsement."]);
  assert.equal(chain.breaks, 1);
  for (const caution of [...chain.cautions, ...chain.endorsements.cautions]) assert.ok(!/First Bank|Coastal|Harbor|Bayview/.test(caution), caution);

  // Fixed the same day the listing was filed reads as fixed before it; without a filing date nothing is compared.
  assert.deepEqual(chainOfTitle([allonge("b1", 1, "First Bank", "Bayview", { attachedAt: new Date("2026-10-20T00:00:00Z") })], "Bayview", { listedAt }).endorsements.cautions, []);
  assert.deepEqual(chainOfTitle([allonge("b1", 1, "First Bank", "Bayview", { attachedAt: new Date("2026-12-01T00:00:00Z") })], "Bayview").endorsements.cautions, []);
  const ending = chainOfTitle([allonge("c1", 1, "First Bank", "", { endorsement: "BLANK" })], "Bayview");
  assert.equal(ending.endorsements.endsInBlank, true);
  assert.equal(ending.endorsements.breaks.length, 0);
});

test("days to cure count whole days from today, and an overdue cure says so", () => {
  const now = new Date("2026-11-05T22:30:00Z");
  assert.equal(daysToCure(null, now), null);
  assert.equal(daysToCure(new Date("2026-12-01T00:00:00Z"), now), 26);
  assert.deepEqual(cureCountdown(new Date("2026-12-01T00:00:00Z"), now), { days: 26, overdue: false, text: "26 days to cure" });
  assert.deepEqual(cureCountdown(new Date("2026-11-06T00:00:00Z"), now), { days: 1, overdue: false, text: "1 day to cure" });
  assert.deepEqual(cureCountdown(new Date("2026-11-05T00:00:00Z"), now), { days: 0, overdue: false, text: "Due today" });
  assert.deepEqual(cureCountdown(new Date("2026-11-04T00:00:00Z"), now), { days: -1, overdue: true, text: "1 day overdue" });
  assert.deepEqual(cureCountdown(new Date("2026-10-01T00:00:00Z"), now), { days: -35, overdue: true, text: "35 days overdue" });
});

test.after(async () => {
  await prisma.$disconnect();
});
