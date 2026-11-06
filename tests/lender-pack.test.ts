import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  ADVANCE_CAVEAT,
  PACK_HEADINGS,
  advanceEstimate,
  advanceLine,
  buildLenderPackPdf,
  lenderPackRole,
  lenderPackSections,
  openLenderPack,
  type PackInput,
} from "../lib/lender-pack";
import { chainDetail } from "../lib/loan-file";
import { prisma } from "../lib/prisma";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

test("the advance estimate is a band by performance, labelled indicative, with the lender deciding", () => {
  assert.deepEqual(advanceEstimate([{ upb: 100000, paymentStatus: "PERFORMING" }], 100000), { lowPct: 65, highPct: 80, low: 65000, high: 80000, basis: "performing" });
  assert.deepEqual(advanceEstimate([{ upb: 100000, paymentStatus: "SUB_PERFORMING" }], 100000), { lowPct: 55, highPct: 70, low: 55000, high: 70000, basis: "sub-performing" });
  assert.deepEqual(advanceEstimate([{ upb: 100000, paymentStatus: "NON_PERFORMING" }], 50000), { lowPct: 40, highPct: 60, low: 20000, high: 30000, basis: "non-performing" });
  // A pool weights each loan's band by its UPB.
  const mixed = advanceEstimate([{ upb: 75000, paymentStatus: "PERFORMING" }, { upb: 25000, paymentStatus: "NON_PERFORMING" }], 100000);
  assert.deepEqual(mixed, { lowPct: 58.8, highPct: 75, low: 58800, high: 75000, basis: "mixed-performance" });
  assert.equal(advanceEstimate([], 100000), null);
  assert.equal(advanceEstimate([{ upb: 100000, paymentStatus: "PERFORMING" }], 0), null);
  assert.equal(ADVANCE_CAVEAT, "Indicative, lender decides.");
  assert.equal(
    advanceLine(advanceEstimate([{ upb: 100000, paymentStatus: "PERFORMING" }], 100000), 100000),
    "Advance estimate: 65–80% of the $100,000 balance at purchase, about $65,000 to $80,000, for performing paper. Indicative, lender decides.",
  );
  assert.match(advanceLine(null, 100000), /none.*Indicative, lender decides\./);
});

test("only the holder and the desk may open a holding's pack", () => {
  const holder = { id: "u1", role: "BUYER" };
  assert.equal(lenderPackRole(holder, { kind: "buyer", userId: "u1" }), "holder");
  assert.equal(lenderPackRole({ id: "u2", role: "BUYER" }, { kind: "buyer", userId: "u1" }), null);
  assert.equal(lenderPackRole({ id: "u3", role: "INDIVIDUAL_SELLER" }, { kind: "buyer", userId: "u1" }), null);
  assert.equal(lenderPackRole({ id: "u4", role: "BROKER" }, { kind: "buyer", userId: "u1" }), null);
  assert.equal(lenderPackRole({ id: "d1", role: "ADMIN" }, { kind: "buyer", userId: "u1" }), "desk");
  assert.equal(lenderPackRole(holder, { kind: "desk" }), null);
  assert.equal(lenderPackRole({ id: "d1", role: "ADMIN" }, { kind: "desk" }), "desk");
});

const at = (text: string) => new Date(`${text}T00:00:00.000Z`);

function samplePack(over: Partial<PackInput> = {}): PackInput {
  return {
    kind: "buyer",
    title: "Tampa first lien",
    heldBy: "Gulf Notes LLC",
    acquiredAt: at("2026-10-15"),
    costBasis: 82000,
    balance: 100000,
    sharePercent: 100,
    status: "CURRENT",
    sellerOnFile: "Coastal Capital",
    listedAt: at("2026-09-01"),
    loans: [
      {
        note: {
          id: "n1",
          city: "Tampa",
          state: "FL",
          lienPosition: "FIRST",
          paymentStatus: "NON_PERFORMING",
          upb: 100000,
          streetAddress: "1 Bay St",
          borrowerName: "A. Borrower",
          propertyType: "SFR",
          occupancy: "VACANT",
          interestRate: 7,
          monthlyPi: 700,
          estimatedValue: 160000,
          monthsDelinquent: 9,
          foreclosureStatus: "NONE",
          verifiedFields: { upb: { at: "2026-09-10T00:00:00.000Z", by: "desk", source: "Pay history", value: "100000" } },
        } as PackInput["loans"][number]["note"],
        collateral: [
          { id: "c1", kind: "ORIGINAL_NOTE", status: "PRESENT", sequence: 0 },
          { id: "c2", kind: "ALLONGE", status: "PRESENT", sequence: 1, detail: chainDetail("First Bank", "Coastal Capital"), endorsement: "SPECIAL", attachedAt: at("2026-08-20") },
          { id: "c3", kind: "ASSIGNMENT", status: "MISSING", sequence: 1, detail: chainDetail("First Bank", "Coastal Capital"), cureBy: at("2026-12-01"), cureOwner: "Seller" },
        ],
        risks: [{ id: "r1", kind: "BANKRUPTCY", result: "CLEAR", source: "PACER", checkedAt: at("2026-09-12") }],
      },
    ],
    payments: [{ paidOn: at("2026-11-01"), amount: 700, memo: "November → servicer" }],
    closing: { closedAt: at("2026-10-15"), files: [{ name: "assignment-signed.pdf", step: "ASSIGNMENT", at: at("2026-10-14") }] },
    generatedAt: at("2026-11-06"),
    demo: false,
    ...over,
  };
}

test("the pack restates the loan record, collateral, chain, risk card, payments, closing files and the estimate", async () => {
  const sections = lenderPackSections(samplePack());
  assert.deepEqual(sections.map((section) => section.heading), [...PACK_HEADINGS]);
  const text = (heading: string) => sections.find((section) => section.heading === heading)!.lines.map((line) => line.text).join("\n");
  assert.match(text("Holding"), /Holder: Gulf Notes LLC/);
  assert.match(text("Holding"), /cost basis \$82,000 · balance at purchase \$100,000/);
  // Every figure says where it came from.
  assert.match(text("Loan record"), /UPB: \$100,000 · Desk-verified against the pay history, Sep 10, 2026/);
  assert.match(text("Loan record"), /Note rate: 7\.000% · Seller-stated/);
  assert.match(text("Loan record"), /Borrower: A\. Borrower · Seller-stated/);
  assert.match(text("Collateral checklist"), /Original note: on file/);
  assert.match(text("Collateral checklist"), /Assignment: missing · cure by Dec 1, 2026 · Seller/);
  assert.match(text("Collateral checklist"), /Title policy: not yet reviewed/);
  assert.match(text("Chain of title"), /1\. First Bank to Coastal Capital · On file · special, to a named holder · undated · fixed to the note, confirmed Aug 20, 2026/);
  assert.match(text("Chain of title"), /Caution: The endorsement at step 1 is undated\./);
  assert.match(text("Chain of title"), /1\. First Bank to Coastal Capital · Missing/);
  assert.match(text("Risk card"), /Bankruptcy: Clear · PACER · Sep 12, 2026/);
  assert.match(text("Risk card"), /Property tax: not checked/);
  assert.match(text("Payments logged"), /1 payment logged, \$700\.00 in all\./);
  assert.match(text("Closing documents on file"), /Closed on UPB on Oct 15, 2026\./);
  assert.match(text("Closing documents on file"), /Assignment and allonge: assignment-signed\.pdf, filed Oct 14, 2026/);
  assert.match(text("Advance estimate"), /40–60% of the \$100,000 balance at purchase, about \$40,000 to \$60,000, for non-performing paper\. Indicative, lender decides\./);

  // A note added by hand has no loan record, so its sections say so, and there is no estimate to give.
  const manual = lenderPackSections(samplePack({ loans: [], closing: null, payments: [] }));
  for (const heading of ["Loan record", "Collateral checklist", "Chain of title", "Risk card"]) {
    assert.match(manual.find((section) => section.heading === heading)!.lines[0].text, /added by hand/);
  }
  assert.match(manual.find((section) => section.heading === "Advance estimate")!.lines[0].text, /^Advance estimate: none/);
  assert.match(manual.find((section) => section.heading === "Closing documents on file")!.lines[0].text, /No UPB closing/);

  // Typed text the standard fonts can't draw becomes something they can, and a long file runs onto more pages.
  const long = samplePack({ payments: Array.from({ length: 120 }, (_, index) => ({ paidOn: new Date(at("2026-11-01").getTime() - index * 30 * DAY), amount: 700, memo: `Payment ${index} 🙂 ✓ → servicer` })) });
  const bytes = await buildLenderPackPdf(long);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 2, `expected more than one page, got ${pdf.getPageCount()}`);
  assert.equal(pdf.getTitle(), "Lender pack: Tampa first lien");
});

// Timestamp-tagged people, a listing, a completed closing, a buyer holding and a desk holding nothing seeded touches.
async function makeBook() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN") =>
    prisma.user.create({ data: { email: `lp-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const holder = await person("holder", "BUYER");
  const stranger = await person("stranger", "BUYER");
  const desk = await person("desk", "ADMIN");
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "SOLD",
      approvedAt: new Date(Date.now() - 40 * DAY),
      title: `Lender pack ${tag}`,
      notes: {
        create: [{
          streetAddress: "1 First St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST", upb: 120000, interestRate: 6.5, monthlyPi: 900, paymentStatus: "PERFORMING", askingPrice: 100000, estimatedValue: 200000,
          tradeStatus: "SOLD", verifiedFields: { upb: { at: new Date(Date.now() - 30 * DAY).toISOString(), by: desk.id, source: "Pay history", value: "120000" } },
        }] as never,
      },
    },
    include: { notes: true },
  });
  const note = listing.notes[0];
  await prisma.collateralItem.create({ data: { noteId: note.id, kind: "ORIGINAL_NOTE", status: "PRESENT" } });
  await prisma.collateralItem.create({ data: { noteId: note.id, kind: "ALLONGE", status: "PRESENT", sequence: 1, detail: chainDetail("Origin Bank", seller.name), endorsement: "BLANK", datedOn: new Date(Date.now() - 900 * DAY), attachedAt: new Date(Date.now() - 60 * DAY) } });
  await prisma.riskCheck.create({ data: { noteId: note.id, kind: "BANKRUPTCY", result: "CLEAR", source: "PACER" } });
  const closing = await prisma.closing.create({
    data: {
      listingId: listing.id,
      status: "COMPLETE",
      salePrice: 100000,
      buyerPremiumCents: 250000,
      sellerCommissionCents: 300000,
      buyerTotalCents: 10250000,
      netToSellerCents: 9700000,
      closedAt: new Date(Date.now() - 20 * DAY),
      steps: { create: [{ key: "ASSIGNMENT", status: "COMPLETE", files: { create: [{ originalName: `assignment-${tag}.pdf`, storageKey: `test/${tag}`, mime: "application/pdf", size: 12 }] } }] },
    },
  });
  const holding = await prisma.buyerHolding.create({
    data: { userId: holder.id, closingId: closing.id, listingId: listing.id, title: listing.title, costBasis: 102500, upb: 120000, sharePercent: 100, acquiredAt: new Date(Date.now() - 20 * DAY) },
  });
  await prisma.cashReceipt.create({ data: { buyerHoldingId: holding.id, amount: 900, paidOn: new Date(Date.now() - 5 * DAY), memo: `servicer remit ${tag}` } });
  const book = await prisma.deskHolding.create({ data: { listingId: listing.id, noteId: note.id, title: `Desk ${listing.title}`, costBasis: 95000, upb: 120000 } });
  return { tag, seller, holder, stranger, desk, listing, closing, holding, book, users: [seller, holder, stranger, desk] };
}

type Book = Awaited<ReturnType<typeof makeBook>>;

async function cleanBook(book: Book) {
  const userIds = book.users.map((user) => user.id);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [book.holding.id, book.book.id, book.listing.id, book.closing.id] } }, { actorId: { in: userIds } }] } });
  await prisma.cashReceipt.deleteMany({ where: { OR: [{ buyerHoldingId: book.holding.id }, { deskHoldingId: book.book.id }] } });
  await prisma.buyerHolding.deleteMany({ where: { id: book.holding.id } });
  await prisma.deskHolding.deleteMany({ where: { id: book.book.id } });
  await prisma.closing.deleteMany({ where: { id: book.closing.id } });
  await prisma.listing.deleteMany({ where: { id: book.listing.id } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test("a holding's pack opens for its holder and the desk only, and every download is audited", async () => {
  const book = await makeBook();
  try {
    const downloads = () => prisma.auditEvent.count({ where: { action: "LENDER_PACK_DOWNLOAD", entityId: { in: [book.holding.id, book.book.id] } } });

    const mine = await openLenderPack(book.holding.id, book.holder);
    assert.ok(mine.ok);
    assert.equal(mine.role, "holder");
    assert.equal(mine.pack.kind, "buyer");
    assert.equal(mine.pack.loans.length, 1);
    assert.equal(mine.pack.sellerOnFile, book.seller.name);
    assert.deepEqual(mine.pack.closing?.files.map((file) => file.name), [`assignment-${book.tag}.pdf`]);
    assert.equal(mine.pack.payments[0].memo, `servicer remit ${book.tag}`);
    const text = lenderPackSections(mine.pack).flatMap((section) => section.lines.map((line) => line.text)).join("\n");
    assert.match(text, /UPB: \$120,000 · Desk-verified against the pay history/);
    assert.match(text, /Ends in blank: the note is bearer paper\./);
    assert.match(text, /65–80% of the \$120,000 balance at purchase/);
    assert.equal(await downloads(), 1);
    const entry = await prisma.auditEvent.findFirstOrThrow({ where: { action: "LENDER_PACK_DOWNLOAD", entityId: book.holding.id } });
    assert.equal(entry.actorId, book.holder.id);
    assert.equal(entry.entityType, "buyerHolding");

    // Another buyer, the seller, and the holder on the desk's own holding all get the same not-found.
    for (const [viewer, id] of [[book.stranger, book.holding.id], [book.seller, book.holding.id], [book.holder, book.book.id], [book.holder, `missing-${book.tag}`]] as const) {
      assert.deepEqual(await openLenderPack(id, viewer), { ok: false, status: 404 });
    }
    assert.equal(await downloads(), 1);

    const desk = await openLenderPack(book.holding.id, book.desk);
    assert.ok(desk.ok);
    assert.equal(desk.role, "desk");
    const own = await openLenderPack(book.book.id, book.desk);
    assert.ok(own.ok);
    assert.equal(own.pack.kind, "desk");
    assert.equal(own.pack.heldBy, "UPB Capital desk book");
    assert.equal(own.pack.loans.length, 1);
    assert.equal(own.pack.closing, null);
    assert.equal(await downloads(), 3);

    const pdf = await PDFDocument.load(await buildLenderPackPdf(mine.pack));
    assert.ok(pdf.getPageCount() >= 1);
  } finally {
    await cleanBook(book);
  }
});
