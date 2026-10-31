import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { accountLocked, adminNeedsSecondFactor } from "../lib/access";
import { ensureInquiryThread } from "../lib/threads";
import { cancelOpenClosing, openClosing } from "../lib/closing-service";
import { ofacBlocks, ofacMode, ofacOpen, screenParty } from "../lib/ofac";
import { prisma } from "../lib/prisma";
import { ofacHold, screenAndRecord, screenListing } from "../lib/screening";
import { bestHit, indexNames, parseTreasuryLists } from "../lib/sdn";

test("a declined or suspended account is locked, a pending one is not", () => {
  assert.equal(accountLocked("REJECTED"), true);
  assert.equal(accountLocked("SUSPENDED"), true);
  assert.equal(accountLocked("PENDING"), false);
  assert.equal(accountLocked("APPROVED"), false);
});

test("real admins need an authenticator and the shared demo seats do not", () => {
  assert.equal(adminNeedsSecondFactor({ role: "ADMIN", email: "owner@upbcapital.com", totpEnabled: false }), true);
  assert.equal(adminNeedsSecondFactor({ role: "ADMIN", email: "owner@upbcapital.com", totpEnabled: true }), false);
  assert.equal(adminNeedsSecondFactor({ role: "ADMIN", email: "iris@upbcapital.test", totpEnabled: false }), false);
  assert.equal(adminNeedsSecondFactor({ role: "BUYER", email: "buyer@example.org", totpEnabled: false }), false);
});

test("an OFAC review stays open and blocking until a person decides it", () => {
  const legacy = { result: "REVIEW" };
  assert.equal(ofacOpen(legacy), true);
  assert.equal(ofacBlocks(legacy), true);
  assert.equal(ofacBlocks({ result: "REVIEW", status: "OPEN" }), true);
  assert.equal(ofacOpen({ result: "REVIEW", status: "CLEARED" }), false);
  assert.equal(ofacBlocks({ result: "REVIEW", status: "CLEARED" }), false);
  assert.equal(ofacOpen({ result: "REVIEW", status: "CONFIRMED" }), false);
  assert.equal(ofacBlocks({ result: "REVIEW", status: "CONFIRMED" }), true);
  assert.equal(ofacBlocks({ result: "CLEAR" }), false);
});

test("Treasury's files parse with quoted commas, aliases, and no vessels", () => {
  const sdn = [
    '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
    '173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
    '900,"HERNANDEZ, Jose","individual","SDNT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
    '901,"SEA STAR","vessel","IRAN",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  ].join("\r\n");
  const alt = ['36,12,"aka","AERO-CARIBBEAN",-0- ', '901,13,"aka","OCEAN STAR",-0- '].join("\n");
  assert.deepEqual(parseTreasuryLists(sdn, alt), ["AEROCARIBBEAN AIRLINES", "ANGLO-CARIBBEAN CO., LTD.", "HERNANDEZ, Jose", "AERO-CARIBBEAN"]);
});

test("the match handles word order and double surnames without flagging every common pair", () => {
  const index = indexNames(["PUTIN, Vladimir", "MADURO MOROS, Nicolas", "JAMES WILSON, Alejandro Antonio", "BANCO NACIONAL DE CUBA", "CIMEX", "blocked test"]);
  assert.equal(bestHit("Vladimir Putin", index)?.entry, "PUTIN, Vladimir");
  assert.equal(bestHit("Nicolas Maduro", index)?.entry, "MADURO MOROS, Nicolas");
  assert.equal(bestHit("Banco Nacional Cuba", index)?.entry, "BANCO NACIONAL DE CUBA");
  assert.equal(bestHit("Blokced Test", index)?.entry, "blocked test");
  assert.equal(bestHit("Blocked Test Holdings", index)?.entry, "blocked test");
  assert.equal(bestHit("James Wilson", index), null);
  assert.equal(bestHit("Cimex Road Partners", index), null);
  assert.equal(bestHit("Jane Borrower", index), null);
});

test("screening says when it had to fall back, and which mode it is in", async () => {
  assert.equal(ofacMode({}), "mock");
  assert.equal(ofacMode({ OFAC_SDN_URL: "https://example.org/SDN.CSV" }), "treasury");
  assert.equal(ofacMode({ OFAC_API_URL: "https://example.org", OFAC_API_KEY: "k" }), "configured");
  const failed = await screenParty("Jane Borrower", { OFAC_SDN_URL: "http://127.0.0.1:9/SDN.CSV" });
  assert.equal(failed.provider, "local");
  assert.equal(failed.unavailable, true);
  assert.match(failed.detail, /not a real screen/);
  assert.equal((await screenParty("Jane Borrower", {})).unavailable, undefined);
});

async function makeParties(tag: string) {
  const seller = await prisma.user.create({ data: { email: `seller-${tag}@example.org`, name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const buyer = await prisma.user.create({ data: { email: `buyer-${tag}@example.org`, name: `Buyer ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  return { seller, buyer };
}

async function makeListing(sellerId: string, data: { approvedAt?: Date; status?: "PENDING" | "APPROVED"; bidMode?: "SEALED"; bidDeadline?: Date; borrowers?: string[] } = {}) {
  const borrowers = data.borrowers ?? [""];
  return prisma.listing.create({
    data: {
      kind: borrowers.length > 1 ? "POOL" : "SINGLE",
      sellerId,
      status: data.status ?? "APPROVED",
      approvedAt: data.approvedAt,
      bidMode: data.bidMode ?? "NONE",
      bidDeadline: data.bidDeadline,
      title: "Safety test note",
      summary: "Test",
      notes: {
        create: borrowers.map((borrowerName) => ({
          streetAddress: "1 Test St",
          city: "Miami",
          state: "FL",
          zip: "33101",
          propertyType: "SFR",
          occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST",
          upb: 100000,
          interestRate: 6,
          monthlyPi: 700,
          paymentStatus: "PERFORMING",
          monthsDelinquent: 0,
          askingPrice: 80000,
          estimatedValue: 150000,
          borrowerName,
        })) as never,
      },
    },
    include: { notes: true },
  });
}

async function clean(userIds: string[], listingId?: string) {
  if (listingId) {
    await prisma.ofacCheck.deleteMany({ where: { listingId } });
    await prisma.listing.deleteMany({ where: { id: listingId } });
  }
  await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test("a cleared OFAC decision carries forward for that name, and a new match asks again", async () => {
  const name = `Blocked Test ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const first = await screenAndRecord(name, { context: "Test" });
    assert.equal(first.screen.result, "REVIEW");
    assert.equal(first.check.status, "OPEN");
    assert.equal(first.blocked, true);
    await prisma.ofacCheck.update({ where: { id: first.check.id }, data: { status: "CLEARED", reviewNote: "Different person" } });
    const second = await screenAndRecord(name, { context: "Test" });
    assert.equal(second.check.status, "CLEARED");
    assert.equal(second.blocked, false);
    await prisma.ofacCheck.update({ where: { id: first.check.id }, data: { matched: "SOME OTHER ENTRY" } });
    await prisma.ofacCheck.update({ where: { id: second.check.id }, data: { matched: "SOME OTHER ENTRY" } });
    assert.equal((await screenAndRecord(name, { context: "Test" })).check.status, "OPEN");
  } finally {
    await prisma.ofacCheck.deleteMany({ where: { name } });
  }
});

test("a tape screens every named borrower, and only a match gets a row", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { seller, buyer } = await makeParties(tag);
  const listing = await makeListing(seller.id, { borrowers: ["Jane Borrower", `Blocked Test ${tag}`, ""] });
  try {
    const result = await screenListing(listing.id, seller.id);
    assert.equal(result.flagged, 1);
    assert.equal(result.unnamed, 1);
    const rows = await prisma.ofacCheck.findMany({ where: { listingId: listing.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "OPEN");
    assert.ok(await ofacHold({ listingId: listing.id }));
    assert.equal(await ofacHold({ userIds: [buyer.id] }), null);
    await prisma.ofacCheck.update({ where: { id: rows[0].id }, data: { status: "CLEARED" } });
    assert.equal(await ofacHold({ listingId: listing.id }), null);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: listing.id } });
    await clean([seller.id, buyer.id], listing.id);
  }
});

test("an unreadable sanctions list is never a clear result, even for a sanctioned name", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { seller, buyer } = await makeParties(tag);
  const listing = await makeListing(seller.id, { borrowers: ["Vladimir Putin"] });
  const before = process.env.OFAC_SDN_URL;
  process.env.OFAC_SDN_URL = `http://127.0.0.1:9/${tag}/SDN.CSV`;
  try {
    const listed = await screenListing(listing.id, seller.id);
    assert.equal(listed.unavailable, true);
    const person = await screenAndRecord("Vladimir Putin", { context: "Test", userId: buyer.id });
    assert.equal(person.check.result, "CLEAR");
    assert.equal(person.unavailable, true);
    assert.equal(person.blocked, true);
  } finally {
    if (before === undefined) delete process.env.OFAC_SDN_URL;
    else process.env.OFAC_SDN_URL = before;
    await prisma.auditEvent.deleteMany({ where: { entityId: listing.id } });
    await clean([seller.id, buyer.id], listing.id);
  }
});

test("a canceled closing puts the note back, posts nothing, and cannot run twice", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { seller, buyer } = await makeParties(tag);
  const listing = await makeListing(seller.id, { status: "PENDING", approvedAt: new Date() });
  const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 80000, message: "Bid" } });
  try {
    await prisma.listing.update({ where: { id: listing.id }, data: { acceptedInquiryId: inquiry.id } });
    const closing = await openClosing({ listingId: listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 80000, title: listing.title });
    assert.ok(await cancelOpenClosing(closing.id, "Buyer walked"));
    const after = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
    assert.equal(after.status, "CANCELED");
    assert.equal(after.cancelReason, "Buyer walked");
    const relisted = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(relisted.status, "APPROVED");
    assert.equal(relisted.acceptedInquiryId, null);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } })).status, "DECLINED");
    assert.equal(await prisma.revenueEvent.count({ where: { listingId: listing.id } }), 0);
    assert.equal(await cancelOpenClosing(closing.id, "Again"), null);
  } finally {
    await clean([seller.id, buyer.id], listing.id);
  }
});

test("canceling a desk purchase never publishes a listing the desk had not approved", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { seller, buyer } = await makeParties(tag);
  const listing = await makeListing(seller.id, { status: "PENDING" });
  const bid = await prisma.deskBid.create({ data: { listingId: listing.id, amount: 70000, status: "ACCEPTED" } });
  try {
    const closing = await openClosing({ listingId: listing.id, deskBidId: bid.id, noteId: null, salePrice: 70000, title: listing.title });
    await cancelOpenClosing(closing.id, "Seller changed their mind");
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status, "UNDER_REVIEW");
    assert.equal((await prisma.deskBid.findUniqueOrThrow({ where: { id: bid.id } })).status, "WITHDRAWN");
  } finally {
    await clean([seller.id, buyer.id], listing.id);
  }
});

test("a seller joins a sealed bid's thread only after the round opens", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { seller, buyer } = await makeParties(tag);
  const listing = await makeListing(seller.id, { bidMode: "SEALED", bidDeadline: new Date(Date.now() + 86400000), approvedAt: new Date() });
  const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 75000, message: "Our best number and why" } });
  try {
    const members = async (threadId: string) => (await prisma.threadMember.findMany({ where: { threadId } })).map((row) => row.userId);
    const thread = await ensureInquiryThread(inquiry.id);
    assert.ok(thread);
    assert.deepEqual(await members(thread.id), [buyer.id]);
    // A thread from before this fix, with the seller already seated, loses that seat on the next sync.
    await prisma.threadMember.create({ data: { threadId: thread.id, userId: seller.id } });
    await ensureInquiryThread(inquiry.id);
    assert.deepEqual(await members(thread.id), [buyer.id]);
    await prisma.listing.update({ where: { id: listing.id }, data: { bidDeadline: new Date(Date.now() - 1000) } });
    await ensureInquiryThread(inquiry.id);
    assert.equal((await members(thread.id)).includes(seller.id), true);
  } finally {
    await clean([seller.id, buyer.id], listing.id);
  }
});

test("no form pairs a field named like a form property with a named submit button", () => {
  // A field named "id" shadows form.id in the DOM, and React then drops the clicked button's value from the submit.
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? files(full) : full.endsWith(".tsx") ? [full] : [];
    });
  const risky = [...files("app"), ...files("components")].filter((file) =>
    [...readFileSync(file, "utf8").matchAll(/<form\b[\s\S]*?<\/form>/g)].some(
      ([form]) => /<(button|Button|SubmitButton)\b[^>]*\bname=/.test(form) && /<(input|select|textarea)\b[^>]*\bname="(id|action|method|target)"/.test(form),
    ),
  );
  assert.deepEqual(risky, []);
});
