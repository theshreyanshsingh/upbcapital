import assert from "node:assert/strict";
import test from "node:test";
import { addBeneficialOwner, OWNER_CONTEXT, OWNERS_INTRO, ownerGaps, ownersByFile, fileKey, readOwner, removeBeneficialOwner } from "../lib/beneficial-owners";
import { addBuyerEntity, deskEntityStatus, reviewBuyerEntity, submitBuyerEntity } from "../lib/buyer-entities";
import { confirmRecertification, lapsedFileBlock, remindRecertifications, reviewBuyerFile } from "../lib/buyer-file";
import { literal } from "../lib/db-filters";
import { checkOffer } from "../lib/inquiry";
import { prisma } from "../lib/prisma";
import { clearSettingsCache, getSettings } from "../lib/settings";
import { readTaxIdLast4, recertBlock, recertLapsed, recertOpen, recertifyByFrom, recertifyMonthsOf } from "../lib/verification";

const DAY = 24 * 60 * 60 * 1000;
// Notices stay in the log, whatever keys the local .env carries, and screens run on the local list.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_API_URL", "OFAC_API_KEY", "OFAC_SDN_URL", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The rules, as pure functions.

test("an entity lists a control person and shares that fit in 100%, and a person or an IRA lists nobody", () => {
  assert.deepEqual(ownerGaps("INDIVIDUAL", []), []);
  assert.deepEqual(ownerGaps("IRA", []), []);
  for (const kind of ["LLC", "TRUST", "FUND", "OTHER"]) assert.match(ownerGaps(kind, []).join(" "), /control person/);
  assert.deepEqual(ownerGaps("LLC", [{ ownershipPct: 60, controlPerson: true }, { ownershipPct: 40, controlPerson: false }]), []);
  // A control person who owns nothing counts, and thirds typed to two places still fit.
  assert.deepEqual(ownerGaps("TRUST", [{ ownershipPct: null, controlPerson: true }]), []);
  assert.deepEqual(ownerGaps("FUND", [33.34, 33.33, 33.34].map((ownershipPct, index) => ({ ownershipPct, controlPerson: index === 0 }))), []);
  const over = ownerGaps("LLC", [{ ownershipPct: 70, controlPerson: true }, { ownershipPct: 40, controlPerson: false }]);
  assert.equal(over.length, 1);
  assert.match(over[0], /110%.*can't total more than 100%/);
  assert.equal(ownerGaps("LLC", [{ ownershipPct: 70, controlPerson: false }, { ownershipPct: 40, controlPerson: false }]).length, 2);
  // The page states the threshold, and the form refuses a small owner who doesn't control the entity.
  assert.match(OWNERS_INTRO, /25% or more/);
  assert.match(readOwner({ name: "Pat Small", ownershipPct: "10" }).error ?? "", /25% or more/);
  assert.match(readOwner({ name: "P", ownershipPct: "50" }).error ?? "", /full legal name/);
  assert.match(readOwner({ name: "Pat Big", ownershipPct: "120" }).error ?? "", /from 0 to 100/);
  const read = readOwner({ name: "  Pat   Big ", ownershipPct: "33.333%", controlPerson: "yes", title: "Manager", country: "" });
  assert.deepEqual(read.error === null && read.data, { name: "Pat Big", title: "Manager", ownershipPct: 33.33, controlPerson: true, country: "US" });
  assert.equal(readOwner({ name: "Pat Manager", controlPerson: "yes" }).error, null);
});

test("the tax ID takes exactly four digits and never more", () => {
  assert.deepEqual(readTaxIdLast4(" 12 34 "), { error: null, value: "1234" });
  for (const raw of ["", "123", "12345", "12-3456789", "123456789", "abcd"]) assert.match(readTaxIdLast4(raw).error ?? "", /last four digits/, raw);
  assert.deepEqual(readTaxIdLast4("", true), { error: null, value: null });
  assert.match(readTaxIdLast4("98-7654321", true).error ?? "", /last four digits/);
});

test("an approved file is current for its months, opens to re-certify 30 days before, and lapses after", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  assert.equal(recertifyMonthsOf(null), 12);
  assert.equal(recertifyMonthsOf(0), 12);
  assert.equal(recertifyMonthsOf(37), 12);
  assert.equal(recertifyMonthsOf(6), 6);
  assert.equal(recertifyByFrom(now, 12).toISOString(), "2027-11-08T12:00:00.000Z");
  // A short month takes its last day.
  assert.equal(recertifyByFrom(new Date("2026-01-31T09:00:00Z"), 1).toISOString(), "2026-02-28T09:00:00.000Z");
  const approved = (recertifyBy: Date | null) => ({ status: "APPROVED", recertifyBy });
  // A file approved before re-certification began has no date and stays current.
  assert.equal(recertLapsed(approved(null), now), false);
  assert.equal(recertOpen(approved(null), now), false);
  assert.equal(recertOpen(approved(new Date(now.getTime() + 31 * DAY)), now), false);
  assert.equal(recertOpen(approved(new Date(now.getTime() + 29 * DAY)), now), true);
  assert.equal(recertLapsed(approved(new Date(now.getTime() + 29 * DAY)), now), false);
  assert.equal(recertLapsed(approved(new Date(now.getTime() - DAY)), now), true);
  assert.equal(recertLapsed({ status: "SUBMITTED", recertifyBy: new Date(now.getTime() - DAY) }, now), false);
  assert.match(recertBlock(approved(new Date("2026-11-01T00:00:00Z")), now) ?? "", /re-certification on Nov 1\. .*\/buyer\/verification/);
  assert.equal(recertBlock(approved(new Date(now.getTime() + DAY)), now), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and a listing nothing seeded touches.

async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string; email: string; name: string }[] = [];
  const person = async (prefix: string, role: "BUYER" | "ADMIN" | "INDIVIDUAL_SELLER") => {
    const user = await prisma.user.create({
      data: {
        email: `b-owners-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
    users.push(user);
    return user;
  };
  const buyer = async (prefix: string, data: Record<string, unknown> = {}) => {
    const user = await person(prefix, "BUYER");
    await prisma.buyerProfile.create({
      data: { userId: user.id, status: "APPROVED", entityType: "LLC", entityName: `${prefix} Fund ${tag}`, jurisdiction: "Delaware", homesControlled: 4, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY), ...data },
    });
    return user;
  };
  const desk = await person("desk", "ADMIN");
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      title: `Owners note ${tag}`,
      notes: {
        create: [{
          streetAddress: "1 First St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000,
        }] as never,
      },
    },
  });
  return { tag, desk, seller, listing, users, person, buyer };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const userIds = world.users.map((user) => user.id);
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: world.listing.id }, select: { id: true } })).map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...userIds, world.listing.id, ...inquiryIds] } }, { actorId: { in: userIds } }] } });
  await prisma.ofacCheck.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { name: { contains: literal(world.tag) } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: world.listing.id }, { inquiryId: { in: inquiryIds } }] } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.listing.deleteMany({ where: { id: world.listing.id } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: world.users.map((user) => user.email) } }, { subject: { contains: literal(world.tag) } }, { body: { contains: literal(world.tag) } }] } });
  await prisma.beneficialOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerEntity.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const approve = (world: World, userId: string, now = new Date()) =>
  reviewBuyerFile(world.desk, { userId, decision: "APPROVED", reviewerNote: "", proofAmount: "250000", proofExpiresAt: "" }, now);

// ---------------------------------------------------------------------------------------------------------------

test("each owner is screened on save, against the buyer's account, and the desk reads the screen as it stands", async () => {
  const world = await makeWorld();
  try {
    const buyer = await world.buyer("buyer", { status: "SUBMITTED" });
    const clean = await addBeneficialOwner(buyer, { name: `Robin Owner ${world.tag}`, title: "Managing member", ownershipPct: "60", controlPerson: "yes" });
    if (clean.error !== null) assert.fail(clean.error);
    assert.equal(clean.owner.screenResult, "CLEAR");
    const stored = await prisma.beneficialOwner.findUniqueOrThrow({ where: { id: clean.owner.id } });
    assert.equal(stored.screenResult, "CLEAR");
    assert.ok(stored.screenedAt);
    assert.equal(stored.buyerEntityId ?? null, null);
    const row = await prisma.ofacCheck.findFirstOrThrow({ where: { userId: buyer.id, name: `Robin Owner ${world.tag}` } });
    assert.equal(row.context, OWNER_CONTEXT);
    assert.equal(row.result, "CLEAR");

    const flaggedName = `Blocked Test ${world.tag}`;
    const flagged = await addBeneficialOwner(buyer, { name: flaggedName, ownershipPct: "40" });
    if (flagged.error !== null) assert.fail(flagged.error);
    assert.equal(flagged.owner.screenResult, "REVIEW");
    const review = await prisma.ofacCheck.findFirstOrThrow({ where: { userId: buyer.id, name: flaggedName } });
    assert.equal(review.context, OWNER_CONTEXT);
    assert.equal(review.result, "REVIEW");
    assert.equal(review.status, "OPEN");

    // The list refuses a duplicate, a share past 100%, and another buyer's entity.
    assert.match((await addBeneficialOwner(buyer, { name: `robin owner ${world.tag}`, ownershipPct: "1", controlPerson: "yes" })).error ?? "", /already listed/);
    assert.match((await addBeneficialOwner(buyer, { name: `Third Owner ${world.tag}`, ownershipPct: "30" })).error ?? "", /130%/);
    assert.match((await addBeneficialOwner(buyer, { buyerEntityId: "no-such-entity", name: `Third Owner ${world.tag}`, controlPerson: "yes" })).error ?? "", /your own buying entities/);

    let views = (await ownersByFile([buyer.id])).get(fileKey(buyer.id, null)) ?? [];
    assert.deepEqual(views.map((view) => [view.name, view.screen]), [[`Robin Owner ${world.tag}`, "CLEAR"], [flaggedName, "OPEN"]]);
    // Compliance decides the review; the desk's list shows the decision without another save.
    await prisma.ofacCheck.updateMany({ where: { userId: buyer.id, name: flaggedName, result: "REVIEW" }, data: { status: "CONFIRMED" } });
    views = (await ownersByFile([buyer.id])).get(fileKey(buyer.id, null)) ?? [];
    assert.equal(views[1].screen, "MATCH");

    // A file with the desk keeps a control person, so the only one can't go until another is added.
    assert.match((await removeBeneficialOwner(buyer, clean.owner.id)).error ?? "", /another control person/);
    const stranger = await world.buyer("stranger");
    assert.match((await removeBeneficialOwner(stranger, clean.owner.id)).error ?? "", /isn't on your file/);
    assert.equal((await removeBeneficialOwner(buyer, flagged.owner.id)).error, null);
    assert.equal(await prisma.beneficialOwner.count({ where: { userId: buyer.id } }), 1);
  } finally {
    await cleanWorld(world);
  }
});

test("the desk can't approve a file while an owner is missing, under open review or a confirmed match, and approval starts the year", async () => {
  const world = await makeWorld();
  try {
    const buyer = await world.buyer("buyer", { status: "SUBMITTED", taxIdLast4: "1234", recertRemindedAt: new Date(Date.now() - 400 * DAY) });
    // No control person yet.
    assert.match((await approve(world, buyer.id)).error ?? "", /control person/);
    const flaggedName = `Blocked Test ${world.tag}`;
    const owner = await addBeneficialOwner(buyer, { name: flaggedName, title: "Trustee", ownershipPct: "100", controlPerson: "yes" });
    if (owner.error !== null) assert.fail(owner.error);

    const open = await approve(world, buyer.id);
    assert.match(open.error ?? "", new RegExp(`${flaggedName}, an owner on this file, has an open sanctions review`));
    assert.equal((await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: buyer.id } })).status, "SUBMITTED");

    await prisma.ofacCheck.updateMany({ where: { userId: buyer.id, name: flaggedName, result: "REVIEW" }, data: { status: "CONFIRMED" } });
    assert.match((await approve(world, buyer.id)).error ?? "", /confirmed sanctions match/);
    assert.equal((await prisma.beneficialOwner.findUniqueOrThrow({ where: { id: owner.owner.id } })).screenResult, "MATCH");

    // Cleared by compliance, the file approves, and is current for the months the settings say.
    await prisma.ofacCheck.updateMany({ where: { userId: buyer.id, name: flaggedName, result: "REVIEW" }, data: { status: "CLEARED", reviewedById: world.desk.id, reviewedAt: new Date(), reviewNote: "Different party." } });
    const now = new Date();
    const approved = await approve(world, buyer.id, now);
    assert.equal(approved.error, null);
    clearSettingsCache();
    const months = recertifyMonthsOf((await getSettings()).recertifyMonths);
    const profile = await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: buyer.id } });
    assert.equal(profile.status, "APPROVED");
    assert.equal(profile.recertifyBy?.toISOString(), recertifyByFrom(now, months).toISOString());
    // A new year has its own reminder.
    assert.equal(profile.recertRemindedAt ?? null, null);
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: buyer.id, action: "VERIFICATION", detail: { contains: `current until ${profile.recertifyBy!.toISOString().slice(0, 10)}` } } }));
  } finally {
    await cleanWorld(world);
  }
});

test("a buying entity that lists owners goes to the desk only with them, and an owner's open review holds its approval", async () => {
  const world = await makeWorld();
  try {
    const buyer = await world.buyer("buyer");
    assert.match((await addBuyerEntity(buyer, { name: `Harbor ${world.tag} LLC`, entityType: "LLC", jurisdiction: "Delaware", taxIdLast4: "123456789" })).error ?? "", /last four digits/);
    assert.match((await addBuyerEntity(buyer, { name: `Harbor ${world.tag} LLC`, entityType: "LLC", jurisdiction: "Delaware" })).error ?? "", /last four digits/);
    const added = await addBuyerEntity(buyer, { name: `Harbor ${world.tag} LLC`, entityType: "LLC", jurisdiction: "Delaware", taxIdLast4: "9876" });
    if (added.error !== null) assert.fail(added.error);
    const llc = added.entity;
    assert.equal(llc.status, "NOT_STARTED");
    assert.equal(llc.taxIdLast4, "9876");
    // The desk's buyer files page reads a draft as one.
    assert.equal(deskEntityStatus(llc.status), "draft, not sent");
    assert.equal(deskEntityStatus("SUBMITTED"), "waiting for review");
    assert.equal(deskEntityStatus("APPROVED"), "approved");
    assert.equal(deskEntityStatus("CHANGES_REQUESTED"), "changes requested");
    // The desk can't approve a draft, and the buyer can't send it without a control person.
    assert.match((await reviewBuyerEntity(world.desk, { entityId: llc.id, decision: "APPROVED", note: "" })).error ?? "", /hasn't sent this entity/);
    assert.match((await submitBuyerEntity(buyer, llc.id)).error ?? "", /control person/);

    const flaggedName = `Blocked Test ${world.tag}`;
    const owner = await addBeneficialOwner(buyer, { buyerEntityId: llc.id, name: flaggedName, ownershipPct: "100", controlPerson: "yes" });
    if (owner.error !== null) assert.fail(owner.error);
    assert.equal(owner.owner.buyerEntityId, llc.id);
    const sent = await submitBuyerEntity(buyer, llc.id);
    assert.equal(sent.error, null);
    assert.match((await submitBuyerEntity(buyer, llc.id)).error ?? "", /already with the desk/);
    assert.match((await reviewBuyerEntity(world.desk, { entityId: llc.id, decision: "APPROVED", note: "" })).error ?? "", /an owner on this file, has an open sanctions review/);
    assert.equal((await prisma.buyerEntity.findUniqueOrThrow({ where: { id: llc.id } })).status, "SUBMITTED");
    // The main file's owners are a separate list.
    assert.equal((await ownersByFile([buyer.id])).get(fileKey(buyer.id, null)), undefined);

    await prisma.ofacCheck.updateMany({ where: { userId: buyer.id, name: flaggedName, result: "REVIEW" }, data: { status: "CLEARED", reviewedById: world.desk.id, reviewedAt: new Date(), reviewNote: "Different party." } });
    assert.equal((await reviewBuyerEntity(world.desk, { entityId: llc.id, decision: "APPROVED", note: "" })).error, null);
    // An IRA lists no owners, so it goes straight to the desk.
    const ira = await addBuyerEntity(buyer, { name: `Doe ${world.tag} IRA`, entityType: "IRA", iraCustodian: "Equity Trust Company", iraAccountTitle: "Equity Trust Company Custodian FBO Jane Doe IRA #12345" });
    assert.equal(ira.error === null && ira.entity.status, "SUBMITTED");
  } finally {
    await cleanWorld(world);
  }
});

test("a lapsed file stops new bids until the buyer re-certifies, and expired proof needs a fresh upload", async () => {
  const world = await makeWorld();
  try {
    const now = new Date();
    const buyer = await world.buyer("buyer", { recertifyBy: new Date(now.getTime() - DAY), taxIdLast4: "1234", proofExpiresAt: new Date(now.getTime() - 2 * DAY), proofAmount: 500000, proofVerifiedAt: new Date(now.getTime() - 100 * DAY) });
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: world.listing.id }, include: { seller: true } });
    const bid = () => checkOffer({ user: buyer, listing, noteId: "", amount: 100000, goodUntil: "", now });
    const lapsed = await bid();
    assert.equal(lapsed.error === null ? null : lapsed.verification, true);
    assert.match(lapsed.error ?? "", /due for re-certification.*\/buyer\/verification/);
    // A group seat taken, re-taken or reconfirmed commits money too, so it gets the same message.
    assert.equal(await lapsedFileBlock(buyer.id, now), lapsed.error);

    // Re-certifying: the box is ticked, the proof is fresh, the tax ID and the owners are on file.
    assert.match((await confirmRecertification(buyer, { confirmed: false }, now)).error ?? "", /Tick the box/);
    assert.match((await confirmRecertification(buyer, { confirmed: true }, now)).error ?? "", /proof of funds expired/);
    await prisma.buyerProfile.update({ where: { userId: buyer.id }, data: { proofExpiresAt: new Date(now.getTime() + 60 * DAY) } });
    assert.match((await confirmRecertification(buyer, { confirmed: true }, now)).error ?? "", /control person/);
    const owner = await addBeneficialOwner(buyer, { name: `Robin Owner ${world.tag}`, ownershipPct: "100", controlPerson: "yes" });
    assert.equal(owner.error, null);
    assert.equal((await confirmRecertification(buyer, { confirmed: true }, now)).error, null);
    const sent = await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: buyer.id } });
    assert.equal(sent.status, "SUBMITTED");
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: buyer.id, action: "RECERTIFIED" } }));
    // The desk approves it again, and bids go through.
    assert.equal((await approve(world, buyer.id, now)).error, null);
    assert.equal((await bid()).error, null);
    assert.equal(await lapsedFileBlock(buyer.id, now), null);
    // A file approved before re-certification began has no date and bids as before.
    const older = await world.buyer("older");
    assert.equal((await checkOffer({ user: older, listing, noteId: "", amount: 100000, goodUntil: "", now })).error, null);
    assert.equal(await lapsedFileBlock(older.id, now), null);
    // A file the desk hasn't approved isn't lapsed; the verification gate stops it instead.
    await prisma.buyerProfile.update({ where: { userId: older.id }, data: { status: "SUBMITTED", recertifyBy: new Date(now.getTime() - DAY) } });
    assert.equal(await lapsedFileBlock(older.id, now), null);
    assert.match((await confirmRecertification(older, { confirmed: true }, now)).error ?? "", /isn't due/);
  } finally {
    await cleanWorld(world);
  }
});

test("the reminder job tells each buyer once, 30 days before the date or after it lapsed", async () => {
  const world = await makeWorld();
  try {
    const now = new Date();
    const soon = await world.buyer("soon", { recertifyBy: new Date(now.getTime() + 20 * DAY) });
    const later = await world.buyer("later", { recertifyBy: new Date(now.getTime() + 60 * DAY) });
    const lapsed = await world.buyer("lapsed", { recertifyBy: new Date(now.getTime() - 3 * DAY) });
    const pending = await world.buyer("pending", { status: "SUBMITTED", recertifyBy: new Date(now.getTime() + 5 * DAY) });
    const notices = (email: string) => prisma.notification.findMany({ where: { toEmail: email, subject: { contains: "re-certification" } } });
    await remindRecertifications(now);
    await remindRecertifications(new Date(now.getTime() + 60 * 1000));
    const due = await notices(soon.email);
    assert.equal(due.length, 1);
    assert.equal(due[0].subject, "Your buyer file is due for re-certification");
    assert.match(due[0].body, /current until/);
    const overdue = await notices(lapsed.email);
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].subject, "Your buyer file needs re-certification");
    assert.equal((await notices(later.email)).length, 0);
    assert.equal((await notices(pending.email)).length, 0);
    assert.equal((await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: soon.id } })).recertRemindedAt?.toISOString(), now.toISOString());
    assert.equal((await prisma.buyerProfile.findUniqueOrThrow({ where: { userId: later.id } })).recertRemindedAt ?? null, null);
  } finally {
    await cleanWorld(world);
  }
});
