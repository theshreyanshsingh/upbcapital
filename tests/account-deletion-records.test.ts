import assert from "node:assert/strict";
import test from "node:test";
import { SANCTIONS_BLOCKER, anonymiseAccount, blockerSentence, completeDeletion, deletionBlockers, requestDeletion } from "../lib/account-deletion";
import { DEFAULT_LEGAL, fillLegal } from "../lib/legal";
import { SANCTIONS_RECORD_YEARS, listVersion } from "../lib/ofac";
import { prisma } from "../lib/prisma";
import { screenAndRecord } from "../lib/screening";

// Mail goes to the log and screens use the local stand-in list, whatever the shared .env says.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people, listings and closings nothing seeded touches.

function world() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const userIds: string[] = [];
  const listingIds: string[] = [];
  const person = async (prefix: string, role: "BUYER" | "INDIVIDUAL_SELLER" | "ADMIN") => {
    const user = await prisma.user.create({ data: { email: `del-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
    userIds.push(user.id);
    return user;
  };
  // A buyer file with every compliance field filled, two owners and a buying entity.
  const buyerFile = async (userId: string) => {
    await prisma.buyerProfile.create({
      data: {
        userId, status: "APPROVED", entityType: "LLC", entityName: `Fund ${tag} LLC`, jurisdiction: "DE", accredited: true, certificationText: "I certify the entity is accredited.",
        proofAmount: 250000, proofExpiresAt: new Date("2027-01-01"), proofVerifiedAt: new Date("2026-06-01"), reviewerNote: "Looks fine to the desk.",
        homesControlled: 12, reoStrategy: "HOLD", eligibilityAt: new Date("2026-06-01"), vendor: "persona", vendorRef: `inq_${tag}`, taxIdLast4: "6789",
        submittedAt: new Date("2026-05-30"), reviewedAt: new Date("2026-06-01"), recertifyBy: new Date("2027-06-01"),
      },
    });
    await prisma.beneficialOwner.createMany({ data: [{ userId, name: `Robin Owner ${tag}`, ownershipPct: 60, controlPerson: true }, { userId, name: `Sam Owner ${tag}`, ownershipPct: 40 }] });
    return prisma.buyerEntity.create({ data: { userId, name: `Trust ${tag}`, entityType: "TRUST", taxIdLast4: "1111", status: "APPROVED" } });
  };
  const sale = async (sellerId: string, buyerId: string) => {
    const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId, status: "SOLD", title: `Deletion records ${tag}`, notes: { create: [] } } });
    listingIds.push(listing.id);
    const bid = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId, type: "OFFER", amount: 90000, status: "ACCEPTED" } });
    return prisma.closing.create({
      data: { listingId: listing.id, inquiryId: bid.id, status: "COMPLETE", closedAt: new Date(), salePrice: 90000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 9000000, netToSellerCents: 9000000 },
    });
  };
  const clean = async () => {
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: userIds } }, { actorId: { in: userIds } }] } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { subject: { contains: tag } }, { body: { contains: tag } }] } });
    await prisma.deletionRequest.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  };
  return { tag, person, buyerFile, sale, clean };
}

// ---------------------------------------------------------------------------------------------------------------

test("a deletion keeps the owners, the buyer file's compliance record and the KYC reference when a closing names the account", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await w.person("buyer", "BUYER");
    const entity = await w.buyerFile(buyer.id);
    await prisma.sellerProfile.create({ data: { userId: seller.id, status: "APPROVED", entityType: "LLC", entityName: `Notes ${w.tag} LLC`, signerName: "Ada Lane", reviewerNote: "Checked.", taxIdLast4: "4321", vendor: "persona", vendorRef: `inq_s_${w.tag}` } });
    await w.sale(seller.id, buyer.id);

    assert.deepEqual(await anonymiseAccount(buyer.id), { proof: "none" });
    const file = await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: buyer.id } });
    assert.equal(file.entityType, "LLC");
    assert.equal(file.entityName, `Fund ${w.tag} LLC`);
    assert.equal(file.jurisdiction, "DE");
    assert.equal(file.accredited, true);
    assert.equal(file.certificationText, "I certify the entity is accredited.");
    assert.equal(file.proofAmount, 250000);
    assert.ok(file.proofExpiresAt && file.proofVerifiedAt);
    assert.equal(file.homesControlled, 12);
    assert.equal(file.reoStrategy, "HOLD");
    assert.ok(file.eligibilityAt);
    assert.equal(file.vendor, "persona");
    assert.equal(file.vendorRef, `inq_${w.tag}`);
    assert.equal(file.taxIdLast4, "6789");
    assert.ok(file.reviewedAt);
    // What only served the person still goes: the desk's note to them and the re-certification reminders.
    assert.equal(file.reviewerNote, "");
    assert.equal(file.recertifyBy, null);
    assert.equal(await prisma.beneficialOwner.count({ where: { userId: buyer.id } }), 2);
    assert.equal((await prisma.buyerEntity.findUniqueOrThrow({ where: { id: entity.id } })).taxIdLast4, "1111");
    // The person is gone.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    assert.equal(after.name, "Deleted account");
    assert.ok(after.deletedAt);

    // The seller file keeps its vendor case and tax-ID last four as well as its entity and signer.
    await anonymiseAccount(seller.id);
    const sellerFile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    assert.equal(sellerFile.entityName, `Notes ${w.tag} LLC`);
    assert.equal(sellerFile.signerName, "Ada Lane");
    assert.equal(sellerFile.vendor, "persona");
    assert.equal(sellerFile.vendorRef, `inq_s_${w.tag}`);
    assert.equal(sellerFile.taxIdLast4, "4321");
    assert.equal(sellerFile.reviewerNote, "");
  } finally {
    await w.clean();
  }
});

test("with no closing naming the account, the owners and the compliance record go as before", async () => {
  const w = world();
  try {
    const buyer = await w.person("buyer", "BUYER");
    const entity = await w.buyerFile(buyer.id);
    await anonymiseAccount(buyer.id);
    const file = await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: buyer.id } });
    assert.equal(file.status, "APPROVED");
    assert.equal(file.entityName, "");
    assert.equal(file.entityType, "INDIVIDUAL");
    assert.equal(file.accredited, false);
    assert.equal(file.certificationText, "");
    assert.equal(file.vendor, "");
    assert.equal(file.vendorRef, "");
    assert.equal(file.taxIdLast4, null);
    assert.equal(file.homesControlled, null);
    assert.equal(file.proofAmount, null);
    assert.equal(file.recertifyBy, null);
    assert.equal(await prisma.beneficialOwner.count({ where: { userId: buyer.id } }), 0);
    assert.equal((await prisma.buyerEntity.findUniqueOrThrow({ where: { id: entity.id } })).taxIdLast4, null);
  } finally {
    await w.clean();
  }
});

test("an open or confirmed sanctions match stops a deletion, and the desk is told why", async (t) => {
  t.mock.method(console, "info", () => {});
  const w = world();
  try {
    const buyer = await w.person("held", "BUYER");
    const desk = await w.person("desk", "ADMIN");
    const asked = await requestDeletion(buyer, "");
    assert.ok("request" in asked && asked.request);
    const check = await prisma.ofacCheck.create({ data: { name: buyer.name, result: "REVIEW", status: "OPEN", matched: "BLOCKED TEST", userId: buyer.id, context: "test" } });
    assert.deepEqual(await deletionBlockers(buyer.id), [SANCTIONS_BLOCKER]);
    const refused = await completeDeletion(asked.request.id, desk);
    assert.deepEqual(refused.blockers, [SANCTIONS_BLOCKER]);
    assert.match(refused.error ?? "", /open or confirmed sanctions match, so it can't be deleted/);
    assert.match(refused.error ?? "", /Say nothing about the match to the holder/);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).deletedAt, null);
    // A confirmed match holds too. Its records stay whole.
    await prisma.ofacCheck.update({ where: { id: check.id }, data: { status: "CONFIRMED" } });
    assert.deepEqual(await deletionBlockers(buyer.id), [SANCTIONS_BLOCKER]);
    // The sentence names the deal blockers first.
    assert.equal(
      blockerSentence(["an open bid", SANCTIONS_BLOCKER]),
      "This account still has an open bid. That has to finish or close before the account can be deleted. It also has an open or confirmed sanctions match, so it can't be deleted. Decide an open one under OFAC reviews. A confirmed match's records stay whole, so call counsel. Say nothing about the match to the holder.",
    );
    // Cleared, it no longer stands in the way.
    await prisma.ofacCheck.update({ where: { id: check.id }, data: { status: "CLEARED" } });
    assert.deepEqual(await deletionBlockers(buyer.id), []);
    assert.equal((await completeDeletion(asked.request.id, desk)).error, undefined);
    // The screens stay after the deletion.
    assert.ok(await prisma.ofacCheck.findUnique({ where: { id: check.id } }));
  } finally {
    await w.clean();
  }
});

test("every screen row names the list it ran against", async () => {
  const w = world();
  try {
    const buyer = await w.person("listed", "BUYER");
    const clear = await screenAndRecord(`Clear Name ${w.tag}`, { context: "test", userId: buyer.id });
    assert.equal(clear.check.listVersion, "local stand-in");
    const flagged = await screenAndRecord("Blocked Test", { context: "test", userId: buyer.id });
    assert.equal(flagged.check.result, "REVIEW");
    assert.equal(flagged.check.listVersion, "local stand-in");
    assert.equal(listVersion({ provider: "treasury", fetchedAt: new Date("2026-11-09T04:00:00.000Z") }), "treasury 2026-11-09T04:00:00.000Z");
    assert.equal(listVersion({ provider: "live", fetchedAt: new Date("2026-11-09T04:00:00.000Z") }), "parsed vendor 2026-11-09T04:00:00.000Z");
  } finally {
    await w.clean();
  }
});

test("the privacy text keeps sanctions records for the 10-year floor and deal records for the setting", () => {
  assert.equal(SANCTIONS_RECORD_YEARS, 10);
  const privacy = fillLegal(DEFAULT_LEGAL.PRIVACY.body, { retentionYears: 7, contact: "desk@example.org" });
  assert.match(privacy, /deal records, with the compliance file behind each trade, for at least 7 years/);
  assert.match(privacy, /sanctions screening records for at least 10 years even when that period is shorter/);
  assert.match(privacy, /Counsel to confirm both periods/);
});
