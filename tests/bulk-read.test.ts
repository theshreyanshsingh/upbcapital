import assert from "node:assert/strict";
import test from "node:test";
import { bookLoans, groupBy, readIn, resetBookLoans, revive, SHARED_LOANS_MS, withNotes } from "../lib/bulk-read";
import { prisma } from "../lib/prisma";

test.after(async () => {
  await prisma.$disconnect();
});

test("extended JSON comes back as the values Prisma returns", () => {
  assert.deepEqual(revive({ $date: "2026-11-01T00:00:00Z" }), new Date("2026-11-01T00:00:00Z"));
  assert.deepEqual(revive({ $date: { $numberLong: "1793491200000" } }), new Date(1793491200000));
  assert.equal(revive({ $oid: "64b7f0c2a1b2c3d4e5f60718" }), "64b7f0c2a1b2c3d4e5f60718");
  assert.equal(revive({ $numberLong: "12" }), 12);
  assert.equal(revive({ $numberDouble: "1.5" }), 1.5);
  assert.equal(revive(undefined), null);
  assert.deepEqual(revive({ a: { $date: "2026-01-01T00:00:00Z" } }), { a: new Date("2026-01-01T00:00:00Z") });
  // A Json field keeps its stored shape.
  assert.deepEqual(revive({ a: 1, b: [2] }, "Json"), { a: 1, b: [2] });
});

test("groupBy keeps each group's rows in read order", () => {
  const rows = [{ k: "a", n: 1 }, { k: "b", n: 2 }, { k: "a", n: 3 }];
  const grouped = groupBy(rows, "k");
  assert.deepEqual(grouped.get("a")?.map((row) => row.n), [1, 3]);
  assert.deepEqual(grouped.get("b")?.map((row) => row.n), [2]);
});

test("a read by many ids returns the rows Prisma's own read and include return, field for field", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const seller = await prisma.user.create({ data: { email: `bulk-${tag}@example.org`, name: `Bulk ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const loan = (index: number, extra: Record<string, unknown> = {}) => ({
    streetAddress: `${index} Bulk St`, city: `Bulkville${tag}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
    lienPosition: "FIRST", upb: 50000 + index, interestRate: 7.25, monthlyPi: 450, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: 30000, estimatedValue: 250000, ...extra,
  });
  try {
    const listings = [];
    for (let index = 0; index < 3; index += 1) {
      listings.push(
        await prisma.listing.create({
          data: {
            kind: index === 2 ? "POOL" : "SINGLE",
            sellerId: seller.id,
            status: "APPROVED",
            title: `Bulk ${index} ${tag}`,
            approvedAt: new Date(Date.now() - index * 1000),
            // Optional fields set on some loans and missing on others, and a date, so both paths are compared.
            notes: { create: [loan(index, index === 0 ? { loanProgram: "FHA", lastPaidDate: new Date("2026-10-01T00:00:00Z") } : {}), loan(index + 10)] as never },
          } as never,
        }),
      );
    }
    const ids = listings.map((listing) => listing.id);
    const prismaNotes = await prisma.note.findMany({ where: { listingId: { in: ids } } });
    const ours = await readIn("Note", "listingId", ids);
    const byId = (rows: { id: string }[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(ours.length, 6);
    assert.deepEqual(byId(ours), byId(prismaNotes));

    // Only the picked fields, still under Prisma's names.
    const picked = await readIn("Note", "listingId", ids, { pick: ["id", "listingId", "upb", "loanProgram", "lastPaidDate"] });
    assert.deepEqual(Object.keys(picked[0]).sort(), ["id", "lastPaidDate", "listingId", "loanProgram", "upb"]);
    assert.deepEqual(byId(picked), byId(prismaNotes.map(({ id, listingId, upb, loanProgram, lastPaidDate }) => ({ id, listingId, upb, loanProgram, lastPaidDate }))));

    // Listing rows, a model whose schema has many optional fields this fixture leaves unset.
    const prismaListings = await prisma.listing.findMany({ where: { id: { in: ids } } });
    assert.deepEqual(byId(await readIn("Listing", "id", ids)), byId(prismaListings));

    // A further condition in the database's own names narrows the read.
    const pools = await readIn("Note", "listingId", ids, { where: { upb: { $gte: 50012 } } });
    assert.deepEqual(pools.map((note) => note.upb).sort(), [50012]);

    // withNotes gives each listing the loans an include gives it.
    const included = await prisma.listing.findMany({ where: { id: { in: ids } }, include: { notes: true } });
    const attached = await withNotes(prismaListings);
    for (const listing of included) {
      const ourListing = attached.find((entry) => entry.id === listing.id);
      assert.ok(ourListing);
      assert.deepEqual(byId(ourListing.notes), byId(listing.notes));
    }

    assert.deepEqual(await readIn("Note", "listingId", []), []);
    await assert.rejects(readIn("Note", "nope" as never, ids), /no field/);
  } finally {
    await prisma.note.deleteMany({ where: { listing: { sellerId: seller.id } } });
    await prisma.listing.deleteMany({ where: { sellerId: seller.id } });
    await prisma.user.delete({ where: { id: seller.id } });
  }
});

test("a link to one offer opens the offer book on the page that holds it", async () => {
  const { OFFER_BOOK_PAGE, offerBookHref, offerBookPage } = await import("../lib/offers");
  assert.equal(offerBookHref("abc"), "/admin/offers?offer=abc#offer-abc");
  assert.equal(offerBookPage(0), 1);
  assert.equal(offerBookPage(OFFER_BOOK_PAGE - 1), 1);
  assert.equal(offerBookPage(OFFER_BOOK_PAGE), 2);
  assert.equal(offerBookPage(-3), 1);
});

test("the book's shared loan read serves its window, reads a listing it didn't cover fresh, and refreshes after", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const seller = await prisma.user.create({ data: { email: `bulk-shared-${tag}@example.org`, name: `Shared ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const loan = (street: string) => ({
    streetAddress: street, city: `Sharedville${tag}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
    lienPosition: "FIRST", upb: 50000, interestRate: 7, monthlyPi: 450, paymentStatus: "PERFORMING", monthsDelinquent: 0, askingPrice: 30000, estimatedValue: 250000,
  });
  const make = (title: string, status: string) =>
    prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status, title: `${title} ${tag}`, notes: { create: [loan(`1 ${title} St`)] as never } } as never });
  try {
    resetBookLoans();
    const live = await make("Live", "APPROVED");
    const at = Date.now();
    const first = await bookLoans([live.id], at);
    assert.deepEqual(first.get(live.id)?.map((note) => note.streetAddress), ["1 Live St"]);

    // A loan added inside the window isn't on the shared read yet.
    await prisma.note.create({ data: { ...loan("2 Live St"), listingId: live.id } as never });
    assert.equal((await bookLoans([live.id], at + 1000)).get(live.id)?.length, 1);

    // A listing that wasn't on the book at the read is read fresh, as is one in a status the book doesn't show.
    const later = await make("Later", "APPROVED");
    const draft = await make("Draft", "SUBMITTED");
    const mixed = await bookLoans([live.id, later.id, draft.id], at + 1000);
    assert.equal(mixed.get(later.id)?.length, 1);
    assert.equal(mixed.get(draft.id)?.length, 1);

    // After the window the read is fresh.
    assert.equal((await bookLoans([live.id], at + SHARED_LOANS_MS + 1)).get(live.id)?.length, 2);

    // Outside production, withNotes reads fresh even when asked to share.
    assert.equal(process.env.NODE_ENV === "production", false);
    const [fresh] = await withNotes([{ id: live.id }], { shared: true, oldestFirst: true });
    assert.deepEqual(fresh.notes.map((note) => note.streetAddress), ["1 Live St", "2 Live St"]);
  } finally {
    resetBookLoans();
    await prisma.note.deleteMany({ where: { listing: { sellerId: seller.id } } });
    await prisma.listing.deleteMany({ where: { sellerId: seller.id } });
    await prisma.user.delete({ where: { id: seller.id } });
  }
});
