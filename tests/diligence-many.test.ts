import assert from "node:assert/strict";
import test from "node:test";
import { DILIGENCE_ITEMS, loadDiligence, loadDiligenceMany } from "../lib/diligence-checklist";

const WAIVED = DILIGENCE_ITEMS[0].key;
import { prisma } from "../lib/prisma";

test.after(async () => {
  await prisma.$disconnect();
});

test("the checklist read for many listings at once matches each listing's own read, line for line", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const seller = await prisma.user.create({ data: { email: `dil-many-${tag}@example.org`, name: `Dil ${tag}`, companyName: `Dil Co ${tag}`, role: "INSTITUTIONAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const loan = (street: string) => ({
    streetAddress: street, city: `Dilville${tag}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
    lienPosition: "FIRST", upb: 90000, interestRate: 7, monthlyPi: 600, paymentStatus: "PERFORMING", monthsDelinquent: 0, askingPrice: 60000, estimatedValue: 150000,
  });
  const listingIds: string[] = [];
  try {
    const pool = await prisma.listing.create({
      data: { kind: "POOL", sellerId: seller.id, status: "APPROVED", title: `Dil pool ${tag}`, notes: { create: [loan("1 Chain St"), loan("2 Chain St")] as never } } as never,
      include: { notes: true },
    });
    const single = await prisma.listing.create({
      data: { kind: "SINGLE", sellerId: seller.id, status: "APPROVED", title: `Dil single ${tag}`, clientSellerName: `Client ${tag}`, notes: { create: [loan("3 Chain St")] as never } } as never,
      include: { notes: true },
    });
    listingIds.push(pool.id, single.id);
    const file = (listingId: string, type: string, noteId: string | null) =>
      prisma.document.create({ data: { listingId, type, noteId, originalName: `${type}.pdf`, storedName: `${tag}-${type}-${noteId ?? "listing"}`, mime: "application/pdf", size: 10 } as never });
    await file(pool.id, "PAY_HISTORY", pool.notes[0].id);
    await file(pool.id, "NOTE", null);
    await file(pool.id, "PHOTO", pool.notes[0].id);
    await file(single.id, "PAY_HISTORY", null);
    await prisma.collateralItem.create({ data: { noteId: pool.notes[0].id, kind: "ORIGINAL_NOTE", status: "PRESENT", sequence: 1 } as never });
    await prisma.collateralItem.create({ data: { noteId: pool.notes[0].id, kind: "ALLONGE", status: "MISSING", sequence: 0 } as never });
    await prisma.collateralItem.create({ data: { noteId: pool.notes[1].id, kind: "MORTGAGE", status: "PRESENT", sequence: 0 } as never });
    await prisma.listing.update({ where: { id: single.id }, data: { diligenceWaivers: { [`${WAIVED}`]: { reason: "Seasoned", by: "desk", at: "2026-11-01T00:00:00.000Z" } } as never } });

    const many = await loadDiligenceMany([...listingIds, "missing-listing"]);
    for (const id of listingIds) {
      const one = await loadDiligence(id);
      assert.ok(one);
      assert.deepEqual(many.get(id), one.diligence, id);
    }
    assert.equal(many.has("missing-listing"), false);
    assert.equal((await loadDiligenceMany([])).size, 0);
  } finally {
    const notes = (await prisma.note.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((note) => note.id);
    await prisma.collateralItem.deleteMany({ where: { noteId: { in: notes } } });
    await prisma.document.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.delete({ where: { id: seller.id } });
  }
});
