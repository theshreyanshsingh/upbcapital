import assert from "node:assert/strict";
import test from "node:test";
import { finalizeClosing, openClosing } from "../lib/closing-service";
import { prisma } from "../lib/prisma";
import { trackLine, trackRecordsFor } from "../lib/seller-decisions";
import {
  RECORD_MIN_CLOSES,
  accountRecord,
  bidderFacts,
  buildBuyerRecord,
  buildSellerRecord,
  buyerRecordLines,
  buyerTrackRecords,
  collateralReceipts,
  median,
  sellerRecordLines,
  sellerTrackRecord,
  shareText,
  type RecordClosing,
} from "../lib/track-record";

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const plus = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The record from fixtures, without the database.

const closed = (id: string, days: number, extra: Partial<RecordClosing> = {}): RecordClosing => ({ id, status: "COMPLETE", openedAt: at("2026-03-01"), closedAt: plus(at("2026-03-01"), days), ...extra });
const failed = (id: string, fault: string | null): RecordClosing => ({ id, status: "CANCELED", openedAt: at("2026-03-01"), closedAt: null, canceledAt: at("2026-03-20"), cancelFault: fault });

test("a seller's record counts closes, days to close, failures by fault, kick-outs, notes, claims and buyers' answers", () => {
  const record = buildSellerRecord({
    closings: [closed("a", 20), closed("b", 30), closed("c", 41), failed("d", "SELLER"), failed("e", "BUYER"), failed("f", null), { id: "g", status: "OPEN", openedAt: at("2026-03-01"), closedAt: null }],
    kickouts: 2,
    noteReceipts: [{ closedAt: at("2026-04-01"), receivedAt: at("2026-04-05") }, { closedAt: at("2026-04-01"), receivedAt: at("2026-04-13") }],
    claims: [{ status: "UPHELD" }, { status: "DENIED" }, { status: "UNDER_REVIEW" }, { status: "WITHDRAWN" }],
    attestations: [
      { fileAsDescribed: true, collateralComplete: true },
      { fileAsDescribed: false, collateralComplete: null },
      { fileAsDescribed: true, collateralComplete: true },
    ],
  });
  assert.equal(record.closes, 3);
  assert.equal(record.medianDaysToClose, 30);
  assert.deepEqual(record.failed, { buyer: 1, seller: 1, neither: 0, unrecorded: 1 });
  assert.deepEqual(record.collateral, { medianDays: 8, count: 2 });
  assert.deepEqual(record.claimsAgainst, { filed: 4, open: 1, upheld: 1, partlyUpheld: 0, denied: 1, cured: 0, settled: 0, withdrawn: 1 });
  assert.deepEqual(record.fileAsDescribed, { yes: 2, of: 3 });
  assert.deepEqual(record.collateralComplete, { yes: 2, of: 2 });
  // The other side reads only what was decided. Open and withdrawn claims stay with the seller and the desk.
  assert.deepEqual(sellerRecordLines(record, "public"), [
    "3 closings on UPB",
    "Median 30 days from award to close",
    "3 failed closings: 1 on the seller, 1 on the buyer, 1 not recorded",
    "2 loans kicked out before close",
    "Collateral delivered a median 8 days after close (2 loans)",
    "Repurchase claims decided: 1 upheld, 1 denied",
    "2 of 3 buyers said the file matched what was described",
    "2 of 2 buyers said the collateral arrived complete",
  ]);
  assert.ok(sellerRecordLines(record, "self").includes("4 repurchase claims filed against the seller: 1 open, 1 upheld, 1 denied, 1 withdrawn"));
  assert.ok(sellerRecordLines(record, "public").every((line) => !line.includes("%")));
});

test("with no original note on record the collateral figure is null and the other side reads nothing about it", () => {
  const record = buildSellerRecord({ closings: [closed("a", 12)], kickouts: 0, noteReceipts: [], claims: [], attestations: [] });
  assert.deepEqual(record.collateral, { medianDays: null, count: 0 });
  const lines = sellerRecordLines(record, "public");
  assert.deepEqual(lines, ["1 closing on UPB", "12 days from award to close", "No failed closings", "No kick-outs", "No repurchase claims decided"]);
  assert.ok(sellerRecordLines(record, "self").includes("No collateral delivery recorded yet"));
  assert.deepEqual(sellerRecordLines(buildSellerRecord({ closings: [], kickouts: 0, noteReceipts: [], claims: [], attestations: [] }), "public"), ["No closings on UPB yet"]);
});

test("collateral counts the original note or an eNote's transfer of control, received, once per loan", () => {
  const closedAt = new Map([["c1", at("2026-04-01")], ["c2", at("2026-04-10")]]);
  const doc = (closingId: string, noteId: string | null, kind: string, status: string, received: string | null) => ({ closingId, noteId, kind, status, receivedAt: received ? at(received) : null });
  const receipts = collateralReceipts(
    [
      doc("c1", "paper", "ORIGINAL_NOTE", "RECEIVED", "2026-04-07"),
      // A second receipt for the same loan doesn't count twice; the first one stands.
      doc("c1", "paper", "ORIGINAL_NOTE", "RECEIVED", "2026-04-20"),
      doc("c1", "paper", "ALLONGE", "RECEIVED", "2026-04-02"),
      doc("c2", "enote", "ENOTE_CONTROL", "RECEIVED", "2026-04-12"),
      doc("c2", "enote", "ENOTE_LOCATION", "RECEIVED", "2026-04-11"),
      doc("c2", "late", "ORIGINAL_NOTE", "SENT", null),
      // A closing that hasn't closed has no close to count from.
      doc("c3", "open", "ORIGINAL_NOTE", "RECEIVED", "2026-04-15"),
    ],
    closedAt,
  );
  assert.deepEqual(receipts, [
    { closedAt: at("2026-04-01"), receivedAt: at("2026-04-07") },
    { closedAt: at("2026-04-10"), receivedAt: at("2026-04-12") },
  ]);
  const record = buildSellerRecord({ closings: [closed("c1", 31), closed("c2", 40)], kickouts: 0, noteReceipts: receipts, claims: [], attestations: [] });
  assert.deepEqual(record.collateral, { medianDays: 4, count: 2 });
  assert.ok(sellerRecordLines(record, "public").includes("Collateral delivered a median 4 days after close (2 loans)"));
});

test("a buyer's record counts deposits on time, failures by fault and sellers' answers", () => {
  const now = at("2026-11-01");
  const deposit = (due: string, received: string | null, cents = 1000000) => ({ depositCents: 1000000, depositDueAt: at(due), depositReceivedAt: received ? at(received) : null, depositReceivedCents: received ? cents : null });
  const record = buildBuyerRecord({
    closings: [
      closed("a", 18, deposit("2026-03-04", "2026-03-03")),
      closed("b", 22, deposit("2026-03-04", "2026-03-06")),
      closed("c", 26, deposit("2026-03-04", "2026-03-04", 500000)),
      // Canceled before its deposit was due, so the deposit never counts.
      { ...failed("d", "NEITHER"), ...deposit("2026-03-25", null) },
      { ...failed("e", "BUYER"), ...deposit("2026-03-10", null) },
    ],
    claims: [{ status: "SETTLED" }],
    attestations: [{ fundedOnTime: true }, { fundedOnTime: false }],
    now,
  });
  assert.equal(record.closes, 3);
  assert.equal(record.medianDaysToClose, 22);
  assert.deepEqual(record.deposits, { due: 4, onTime: 1 });
  assert.deepEqual(record.failed, { buyer: 1, seller: 0, neither: 1, unrecorded: 0 });
  assert.deepEqual(buyerRecordLines(record, "public", { skipCloses: true }), [
    "Median 22 days from award to close",
    "Deposits on time: 1 of 4",
    "2 failed closings: 1 on the buyer, 1 on neither side",
    "1 of 2 sellers said the buyer funded on time",
  ]);
  // The claims a buyer filed are for the buyer and the desk.
  assert.ok(buyerRecordLines(record, "desk").includes("1 repurchase claim filed: 1 settled"));
  assert.ok(!buyerRecordLines(record, "public").some((line) => line.includes("claim")));
});

test("under five closes a share is its counts, never a percentage; from five it carries the percentage", () => {
  assert.equal(RECORD_MIN_CLOSES, 5);
  assert.equal(shareText({ yes: 3, of: 4 }, 4), "3 of 4");
  assert.equal(shareText({ yes: 9, of: 10 }, 5), "90% (9 of 10)");
  assert.equal(shareText({ yes: 0, of: 0 }, 9), null);
  const answers = (count: number) => Array.from({ length: count }, (_value, index) => ({ fileAsDescribed: index > 0, collateralComplete: true }));
  const four = buildSellerRecord({ closings: [1, 2, 3, 4].map((n) => closed(`c${n}`, 10 + n)), kickouts: 0, noteReceipts: [], claims: [], attestations: answers(4) });
  const five = buildSellerRecord({ closings: [1, 2, 3, 4, 5].map((n) => closed(`c${n}`, 10 + n)), kickouts: 0, noteReceipts: [], claims: [], attestations: answers(5) });
  assert.ok(sellerRecordLines(four, "public").includes("3 of 4 buyers said the file matched what was described"));
  assert.ok(sellerRecordLines(four, "self").every((line) => !line.includes("%")));
  assert.ok(sellerRecordLines(five, "public").includes("80% of buyers said the file matched what was described (4 of 5)"));
  const buyer = (closes: number) =>
    buildBuyerRecord({ closings: Array.from({ length: closes }, (_value, index) => closed(`b${index}`, 20, { depositCents: 100, depositDueAt: at("2026-03-03"), depositReceivedAt: at("2026-03-02"), depositReceivedCents: 100 })), claims: [], attestations: [], now: at("2026-11-01") });
  assert.ok(buyerRecordLines(buyer(4), "public").includes("Deposits on time: 4 of 4"));
  assert.ok(buyerRecordLines(buyer(5), "public").includes("Deposits on time: 100% (5 of 5)"));
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

// ---------------------------------------------------------------------------------------------------------------
// On the database.

test("closing a deal asks each side once for its answers, however often the close runs", async () => {
  const mk = (who: string, role: "BUYER" | "INDIVIDUAL_SELLER") =>
    prisma.user.create({ data: { email: `record-close-${who}-${stamp}@example.test`, name: `Record ${who}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const [seller, buyer] = await Promise.all([mk("seller", "INDIVIDUAL_SELLER"), mk("buyer", "BUYER")]);
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE", sellerId: seller.id, status: "APPROVED", title: `Record close ${stamp}`,
      notes: { create: { streetAddress: "9 Close Ct", city: "Dayton", state: "OH", propertyType: "SFR", estimatedValue: 150000, lienPosition: "FIRST", upb: 90000, interestRate: 6, monthlyPi: 700, paymentStatus: "PERFORMING", askingPrice: 60000 } },
    },
  });
  const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 55000, message: "Record bid" } });
  try {
    const closing = await openClosing({ listingId: listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 55000, title: listing.title });
    await prisma.closingStep.updateMany({ where: { closingId: closing.id }, data: { status: "COMPLETE", completedAt: new Date() } });
    await finalizeClosing(closing.id);
    await finalizeClosing(closing.id);
    assert.equal(await prisma.notification.count({ where: { toEmail: buyer.email, subject: `Two questions on ${listing.title}` } }), 1);
    assert.equal(await prisma.notification.count({ where: { toEmail: seller.email, subject: `One question on ${listing.title}` } }), 1);
  } finally {
    await prisma.revenueEvent.deleteMany({ where: { listingId: listing.id } });
    await prisma.invoice.deleteMany({ where: { userId: { in: [seller.id, buyer.id] } } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: [seller.email, buyer.email] } }, { subject: { contains: stamp } }] } });
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: [seller.id, buyer.id] } } });
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.user.deleteMany({ where: { id: { in: [seller.id, buyer.id] } } });
  }
});

// A seller with two closed deals and a failed one, and a buyer on all of them.

test("the record loads from closings, trailing documents, kick-outs, claims and answers, and bidders' lines carry no names", async () => {
  const mk = (who: string, role: "BUYER" | "INDIVIDUAL_SELLER") =>
    prisma.user.create({ data: { email: `record-${who}-${stamp}@example.test`, name: `Record ${who} ${stamp}`, companyName: `Record Co ${stamp}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const [seller, buyer, newcomer] = await Promise.all([mk("seller", "INDIVIDUAL_SELLER"), mk("buyer", "BUYER"), mk("newcomer", "BUYER")]);
  const note = (street: string) => ({
    streetAddress: street, city: "Mobile", state: "AL", propertyType: "SFR" as const, estimatedValue: 200000, lienPosition: "FIRST" as const,
    upb: 120000, interestRate: 7, monthlyPi: 900, paymentStatus: "PERFORMING" as const, askingPrice: 90000,
  });
  const listings = await Promise.all(
    ["one", "two", "three"].map((name) =>
      prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SOLD", title: `Record ${name} ${stamp}`, notes: { create: [note(`${name} Record Way`)] } }, include: { notes: true } }),
    ),
  );
  const ids = { users: [seller.id, buyer.id, newcomer.id], listings: listings.map((listing) => listing.id) };
  try {
    const opened = at("2026-06-01");
    const deal = async (index: number, data: Record<string, unknown>) => {
      const inquiry = await prisma.inquiry.create({ data: { listingId: listings[index].id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 80000, message: "Record bid" } });
      return prisma.closing.create({
        data: {
          listingId: listings[index].id, inquiryId: inquiry.id, noteId: listings[index].notes[0].id, salePrice: 80000, buyerPremiumCents: 160000, sellerCommissionCents: 0,
          buyerTotalCents: 8160000, netToSellerCents: 8000000, openedAt: opened, depositCents: 800000, depositDueAt: plus(opened, 3), ...data,
        },
      });
    };
    const first = await deal(0, { status: "COMPLETE", closedAt: plus(opened, 20), depositReceivedCents: 800000, depositReceivedAt: plus(opened, 2) });
    const second = await deal(1, { status: "COMPLETE", closedAt: plus(opened, 30), depositReceivedCents: 800000, depositReceivedAt: plus(opened, 5) });
    const third = await deal(2, { status: "CANCELED", canceledAt: plus(opened, 12), cancelFault: "SELLER", depositReceivedCents: 800000, depositReceivedAt: plus(opened, 1) });

    // No original note recorded yet: the figure is null, not zero.
    assert.deepEqual((await sellerTrackRecord(seller.id)).collateral, { medianDays: null, count: 0 });
    await prisma.trailingDoc.createMany({
      data: [
        { closingId: first.id, noteId: listings[0].notes[0].id, kind: "ORIGINAL_NOTE", owner: "SELLER", status: "RECEIVED", dueAt: plus(opened, 30), receivedAt: plus(opened, 26) },
        { closingId: first.id, noteId: listings[0].notes[0].id, kind: "ORIGINAL_NOTE", owner: "SELLER", status: "RECEIVED", dueAt: plus(opened, 30), receivedAt: plus(opened, 45) },
        { closingId: second.id, noteId: listings[1].notes[0].id, kind: "ORIGINAL_NOTE", owner: "SELLER", status: "SENT", dueAt: plus(opened, 40), sentAt: plus(opened, 33) },
        // The second deal's loan is an eNote: its collateral is the eRegistry transfer of control.
        { closingId: second.id, noteId: listings[1].notes[0].id, kind: "ENOTE_CONTROL", owner: "SELLER", status: "RECEIVED", dueAt: plus(opened, 40), receivedAt: plus(opened, 32) },
        { closingId: second.id, kind: "RECORDED_ASSIGNMENT", owner: "DESK", status: "RECEIVED", dueAt: plus(opened, 60), receivedAt: plus(opened, 31) },
      ],
    });
    await prisma.closingKickout.create({ data: { closingId: third.id, noteId: listings[2].notes[0].id, priceCents: 1000000, reason: "Paid off", actorId: seller.id } });
    await prisma.repurchaseClaim.create({ data: { closingId: first.id, noteId: listings[0].notes[0].id, filedById: buyer.id, sellerId: seller.id, rep: "BALANCE", description: "The balance was off.", remedy: "CURE", status: "CURED", respondBy: plus(opened, 40) } });
    await prisma.repurchaseClaim.create({ data: { closingId: second.id, noteId: listings[1].notes[0].id, filedById: buyer.id, sellerId: seller.id, rep: "TITLE", description: "A second lien.", remedy: "REPURCHASE", status: "FILED", respondBy: plus(opened, 50) } });
    await prisma.closeAttestation.createMany({
      data: [
        { closingId: first.id, byId: buyer.id, side: "BUYER", fileAsDescribed: true, collateralComplete: true },
        { closingId: second.id, byId: buyer.id, side: "BUYER", fileAsDescribed: false, collateralComplete: true },
        { closingId: first.id, byId: seller.id, side: "SELLER", fundedOnTime: true },
      ],
    });

    const sold = await sellerTrackRecord(seller.id);
    assert.equal(sold.closes, 2);
    assert.equal(sold.medianDaysToClose, 25);
    assert.deepEqual(sold.failed, { buyer: 0, seller: 1, neither: 0, unrecorded: 0 });
    assert.equal(sold.kickouts, 1);
    // One receipt per loan, the first, from its own closing's close: 6 days for the paper note, 2 for the eNote.
    assert.deepEqual(sold.collateral, { medianDays: 4, count: 2 });
    assert.equal(sold.claimsAgainst.filed, 2);
    assert.equal(sold.claimsAgainst.cured, 1);
    assert.deepEqual(sold.fileAsDescribed, { yes: 1, of: 2 });
    const publicLines = sellerRecordLines(sold, "public");
    assert.ok(publicLines.includes("Repurchase claims decided: 1 cured"));
    assert.ok(publicLines.includes("1 of 2 buyers said the file matched what was described"));
    assert.ok(publicLines.every((line) => !line.includes("%")));

    const bought = (await buyerTrackRecords([buyer.id, newcomer.id], at("2026-11-01"))).get(buyer.id)!;
    assert.equal(bought.closes, 2);
    assert.deepEqual(bought.deposits, { due: 3, onTime: 2 });
    assert.deepEqual(bought.fundedOnTime, { yes: 1, of: 1 });
    assert.equal(bought.claimsFiled.filed, 2);
    const own = await accountRecord(buyer.id, at("2026-11-01"));
    assert.equal(own.sells, false);
    assert.equal(own.buyer.closes, 2);

    // The seller's award decision: the existing line plus the facts, with no name, email or company in either.
    const facts = await bidderFacts([buyer.id, newcomer.id], at("2026-11-01"));
    assert.deepEqual(facts.get(buyer.id), ["Median 25 days from award to close", "Deposits on time: 2 of 3", "1 failed closing: 1 on the seller", "1 of 1 seller said the buyer funded on time"]);
    assert.deepEqual(facts.get(newcomer.id), []);
    const records = await trackRecordsFor([{ id: "bid-1", buyerId: buyer.id }, { id: "bid-2", buyerId: newcomer.id }]);
    const shown = JSON.stringify([...records.values()]) + [...records.values()].map(trackLine).join(" ");
    for (const secret of [buyer.name, buyer.email, `Record Co ${stamp}`, newcomer.name]) assert.ok(!shown.includes(secret));
    assert.ok(records.get("bid-1")?.facts?.includes("Deposits on time: 2 of 3"));
    assert.deepEqual(records.get("bid-2")?.facts, []);
  } finally {
    await prisma.listing.deleteMany({ where: { id: { in: ids.listings } } });
    await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  }
});
