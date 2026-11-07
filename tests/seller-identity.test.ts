import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { anonymiseAccount } from "../lib/account-deletion";
import { isDeskOnlyDocument, isPrivateDocument } from "../lib/acl";
import { literal } from "../lib/db-filters";
import { prisma } from "../lib/prisma";
import { launchReadiness } from "../lib/readiness";
import { relistDocuments } from "../lib/relist-file";
import { documentGate } from "../lib/room-access";
import { addPoolFiles, roomFileType } from "../lib/room-files";
import { OFAC_HOLD_MESSAGE } from "../lib/screening";
import {
  MANDATE_MISSING,
  canReadSellerFile,
  decideSellerIdentity,
  identityGateMessage,
  readSellerIdentity,
  readTaxIdLast4,
  recordSellerVendor,
  sellerIdentityHold,
  sellerIdentityRequired,
  sellerOnTitle,
  sellerVerified,
  submitSellerIdentity,
} from "../lib/seller-identity";
import { uploadDir } from "../lib/storage";
import { DESK_DENIED } from "../lib/staff";

// Files go to local disk, mail to the log, and screens to the short local list, whatever the shared .env says.
for (const key of [
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "VERCEL",
  "RESEND_API_KEY",
  "SMTP_HOST",
  "DESK_EMAIL",
  "EMAIL_FROM",
  "OFAC_SDN_URL",
  "OFAC_API_URL",
  "OFAC_API_KEY",
  "PERSONA_API_KEY",
  "PARALLEL_API_KEY",
  "UPB_RELEASE",
]) {
  process.env[key] = "";
}

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Tagged people nothing seeded touches. Desk fixtures are never approved, so other tests' desk mail passes them by.

type Role = "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BUYER" | "ADMIN" | "BROKER";

async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string; email: string }[] = [];
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: {
        email: `a-sellerid-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: role === "ADMIN" ? "PENDING" : "APPROVED",
        passwordHash: "x",
        ...extra,
      },
    });
    users.push(user);
    return user;
  };
  return { tag, users, person };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const userIds = world.users.map((user) => user.id);
  const emails = world.users.map((user) => user.email);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: userIds } }, { actorId: { in: userIds } }] } });
  await prisma.ofacCheck.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { name: { contains: literal(world.tag) } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: emails } }, { subject: { contains: literal(world.tag) } }] } });
  await prisma.sellerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await Promise.all(userIds.map((id) => fs.rm(path.join(uploadDir(), "seller-identity", id), { recursive: true, force: true })));
}

const pdf = (name: string, body = "seller file") => new File([Buffer.from(`%PDF-1.4\n${body}\n`)], name, { type: "application/pdf" });

function sellerForm(fields: Record<string, string>, files: { idDoc?: File; authorityDoc?: File } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ entityType: "LLC", entityName: "Harbor Notes LLC", signerName: "Ada Lane", signerTitle: "Managing member", taxIdLast4: "6789", ...fields })) {
    form.set(key, value);
  }
  if (files.idDoc) form.set("idDoc", files.idDoc);
  if (files.authorityDoc) form.set("authorityDoc", files.authorityDoc);
  return form;
}

const exists = (key: string) => fs.access(path.join(uploadDir(), key)).then(() => true, () => false);

// ---------------------------------------------------------------------------------------------------------------

test("the tax ID is exactly four digits, and the file asks for each part", () => {
  assert.equal(readTaxIdLast4("1234"), "1234");
  assert.equal(readTaxIdLast4(" 12 34 "), "1234");
  // A whole number, or anything but four digits, is refused rather than cut down to four.
  for (const typed of ["123", "12345", "123456789", "12-3456789", "123-45-6789", "abcd", "", "***-**-1234"]) assert.equal(readTaxIdLast4(typed), null, typed);

  const base = { entityType: "LLC", entityName: "Harbor Notes LLC", signerName: "Ada Lane", signerTitle: "Managing member", taxIdLast4: "6789" };
  const ok = readSellerIdentity(base);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.data, { ...base, entityType: "LLC" });
  assert.match(readSellerIdentity({ ...base, entityType: "IRA" }).error ?? "", /Choose how you sell/);
  assert.match(readSellerIdentity({ ...base, entityType: "" }).error ?? "", /Choose how you sell/);
  assert.match(readSellerIdentity({ ...base, entityName: " x " }).error ?? "", /legal name/);
  assert.match(readSellerIdentity({ ...base, signerName: "" }).error ?? "", /person who signs/);
  assert.match(readSellerIdentity({ ...base, signerTitle: "" }).error ?? "", /signer's title/);
  assert.match(readSellerIdentity({ ...base, taxIdLast4: "123456789" }).error ?? "", /only the last four digits/);
  // Someone selling as themselves needs no title.
  assert.equal(readSellerIdentity({ ...base, entityType: "INDIVIDUAL", entityName: "Ada Lane", signerTitle: "" }).error, null);
});

test("a seller's submission stores two documents and four digits, and refuses bad files and non-sellers", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await world.person("buyer", "BUYER");
    const other = await world.person("other", "INSTITUTIONAL_SELLER");
    const compliance = await world.person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    const sales = await world.person("sales", "ADMIN", { deskRole: "SALES" });

    assert.match((await submitSellerIdentity(buyer, sellerForm({}, { idDoc: pdf("id.pdf"), authorityDoc: pdf("oa.pdf") }))).error ?? "", /seller and broker accounts/);
    assert.match((await submitSellerIdentity({ ...seller, accountStatus: "SUSPENDED" }, sellerForm({}, { idDoc: pdf("id.pdf"), authorityDoc: pdf("oa.pdf") }))).error ?? "", /can't send/);
    // A whole SSN is refused before anything is stored.
    assert.match((await submitSellerIdentity(seller, sellerForm({ taxIdLast4: "123456789" }, { idDoc: pdf("id.pdf"), authorityDoc: pdf("oa.pdf") }))).error ?? "", /last four/);
    assert.equal(await prisma.sellerProfile.findUnique({ where: { userId: seller.id } }), null);
    // Both documents are needed, and each has to be what its name says.
    assert.match((await submitSellerIdentity(seller, sellerForm({}))).error ?? "", /identity document/);
    assert.match((await submitSellerIdentity(seller, sellerForm({}, { idDoc: pdf("id.pdf") }))).error ?? "", /signer may sell/);
    const fake = new File([Buffer.from("not a pdf")], "id.pdf", { type: "application/pdf" });
    assert.match((await submitSellerIdentity(seller, sellerForm({}, { idDoc: fake, authorityDoc: pdf("oa.pdf") }))).error ?? "", /identity document as a PDF or image/);
    const sheet = new File([Buffer.from("a,b\n")], "oa.csv", { type: "text/csv" });
    assert.match((await submitSellerIdentity(seller, sellerForm({}, { idDoc: pdf("id.pdf"), authorityDoc: sheet }))).error ?? "", /authority document as a PDF or image/);
    assert.equal(await prisma.sellerProfile.findUnique({ where: { userId: seller.id } }), null);

    const sent = await submitSellerIdentity(seller, sellerForm({ taxIdLast4: " 67 89 " }, { idDoc: pdf("license.pdf"), authorityDoc: pdf("operating agreement.pdf") }));
    assert.deepEqual(sent, { ok: true });
    const first = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    assert.equal(first.status, "SUBMITTED");
    assert.equal(first.entityType, "LLC");
    assert.equal(first.entityName, "Harbor Notes LLC");
    assert.equal(first.signerName, "Ada Lane");
    assert.equal(first.taxIdLast4, "6789");
    assert.ok(first.submittedAt);
    assert.match(first.idDocKey, new RegExp(`^seller-identity/${seller.id}/id-`));
    assert.match(first.authorityDocKey, new RegExp(`^seller-identity/${seller.id}/authority-`));
    assert.equal(first.idDocMime, "application/pdf");
    assert.equal(await exists(first.idDocKey), true);
    assert.equal(await exists(first.authorityDocKey), true);
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "SELLER_FILE_SUBMITTED", entityId: seller.id } }));

    // Sent again with one new document: the other stays, and the replaced one is gone from the store.
    assert.deepEqual(await submitSellerIdentity(seller, sellerForm({ entityName: "Harbor Notes II LLC" }, { idDoc: pdf("passport.pdf") })), { ok: true });
    const second = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    assert.equal(second.entityName, "Harbor Notes II LLC");
    assert.notEqual(second.idDocKey, first.idDocKey);
    assert.equal(second.authorityDocKey, first.authorityDocKey);
    assert.equal(await exists(first.idDocKey), false);
    assert.equal(await exists(second.idDocKey), true);

    // The seller and compliance open the documents. Nobody else does.
    assert.equal(canReadSellerFile(seller, seller.id), true);
    assert.equal(canReadSellerFile(compliance, seller.id), true);
    assert.equal(canReadSellerFile(sales, seller.id), false);
    assert.equal(canReadSellerFile(other, seller.id), false);
    assert.equal(canReadSellerFile(buyer, seller.id), false);
  } finally {
    await cleanWorld(world);
  }
});

test("compliance decides a seller file: a note for changes, a fresh read, a screen before approval, and the seller is told", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("decided", "INSTITUTIONAL_SELLER", { companyName: `Decided Co ${world.tag}` });
    const compliance = await world.person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    const sales = await world.person("sales", "ADMIN", { deskRole: "SALES" });
    const nobody = await world.person("nofile", "INDIVIDUAL_SELLER");
    assert.match((await decideSellerIdentity(compliance, { userId: nobody.id, decision: "APPROVED", note: "" })).error ?? "", /hasn't sent/);

    assert.deepEqual(await submitSellerIdentity(seller, sellerForm({}, { idDoc: pdf("id.pdf"), authorityDoc: pdf("oa.pdf") })), { ok: true });
    const sent = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    const seen = sent.submittedAt!.toISOString();

    assert.equal((await decideSellerIdentity(sales, { userId: seller.id, decision: "APPROVED", note: "", seen })).error, DESK_DENIED);
    assert.match((await decideSellerIdentity(compliance, { userId: seller.id, decision: "MAYBE", note: "", seen })).error ?? "", /Choose a decision/);
    assert.match((await decideSellerIdentity(compliance, { userId: seller.id, decision: "CHANGES_REQUESTED", note: " ", seen })).error ?? "", /what to fix/);
    // A decision on a submission the desk didn't read is refused.
    assert.match((await decideSellerIdentity(compliance, { userId: seller.id, decision: "APPROVED", note: "", seen: new Date(0).toISOString() })).error ?? "", /Reload/);

    const asked = await decideSellerIdentity(compliance, { userId: seller.id, decision: "CHANGES_REQUESTED", note: "The resolution doesn't name Ada.", seen });
    assert.deepEqual(asked, { ok: true, status: "CHANGES_REQUESTED" });
    const changes = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    assert.equal(changes.status, "CHANGES_REQUESTED");
    assert.equal(changes.reviewedById, compliance.id);
    assert.ok(changes.reviewedAt);
    assert.equal(changes.reviewerNote, "The resolution doesn't name Ada.");
    assert.equal(await prisma.notification.count({ where: { toEmail: seller.email, subject: "Seller file needs changes" } }), 1);
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "SELLER_FILE", entityId: seller.id, actorId: compliance.id, detail: { startsWith: "CHANGES_REQUESTED" } } }));

    // The seller sends it back, which clears the last decision.
    assert.deepEqual(await submitSellerIdentity(seller, sellerForm({}, { authorityDoc: pdf("resolution.pdf") })), { ok: true });
    const back = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    assert.equal(back.status, "SUBMITTED");
    assert.equal(back.reviewerNote, "");
    assert.equal(back.reviewedById, null);

    const approved = await decideSellerIdentity(compliance, { userId: seller.id, decision: "APPROVED", note: "", seen: back.submittedAt!.toISOString() });
    assert.deepEqual(approved, { ok: true, status: "APPROVED" });
    const done = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    assert.equal(done.status, "APPROVED");
    assert.equal(done.reviewedById, compliance.id);
    assert.equal(await prisma.notification.count({ where: { toEmail: seller.email, subject: "Seller file approved" } }), 1);
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "SELLER_FILE", entityId: seller.id, detail: "APPROVED" } }));
    // Approval screened the entity and the signer under the seller's account.
    const screens = await prisma.ofacCheck.findMany({ where: { userId: seller.id, context: "Seller file approval" } });
    assert.deepEqual(screens.map((row) => row.name).sort(), ["Ada Lane", "Harbor Notes LLC"]);
    assert.equal(await sellerVerified(seller.id), true);

    // An approved file is the desk's: the seller can't send it again or open a vendor case over it.
    assert.match((await submitSellerIdentity(seller, sellerForm({}, { idDoc: pdf("id.pdf") }))).error ?? "", /approved this file/);
    assert.match((await recordSellerVendor(seller, { provider: "persona", reference: `inq_${world.tag}` })).error ?? "", /already decided/);
    // The desk can still decline it later, with a note.
    assert.deepEqual(await decideSellerIdentity(compliance, { userId: seller.id, decision: "REJECTED", note: "The ID was altered." }), { ok: true, status: "REJECTED" });
    assert.equal(await prisma.notification.count({ where: { toEmail: seller.email, subject: "Seller file declined" } }), 1);
    assert.equal(await sellerVerified(seller.id), false);
  } finally {
    await cleanWorld(world);
  }
});

test("a sanctions match on the entity or signer holds the approval until compliance decides it", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("listed", "INDIVIDUAL_SELLER");
    const compliance = await world.person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    const signer = `Blocked Test ${world.tag}`;
    assert.deepEqual(await submitSellerIdentity(seller, sellerForm({ entityType: "TRUST", entityName: `Lane Family Trust ${world.tag}`, signerName: signer, signerTitle: "Trustee" }, { idDoc: pdf("id.pdf"), authorityDoc: pdf("trust.pdf") })), { ok: true });
    const decided = await decideSellerIdentity(compliance, { userId: seller.id, decision: "APPROVED", note: "" });
    assert.equal(decided.error, OFAC_HOLD_MESSAGE);
    assert.equal((await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } })).status, "SUBMITTED");
    const hit = await prisma.ofacCheck.findFirst({ where: { userId: seller.id, name: signer, result: "REVIEW" } });
    assert.equal(hit?.status, "OPEN");
    // Once compliance clears it, the same file approves.
    await prisma.ofacCheck.updateMany({ where: { userId: seller.id, result: "REVIEW" }, data: { status: "CLEARED", reviewedById: compliance.id, reviewedAt: new Date(), reviewNote: "Different person." } });
    assert.deepEqual(await decideSellerIdentity(compliance, { userId: seller.id, decision: "APPROVED", note: "" }), { ok: true, status: "APPROVED" });
  } finally {
    await cleanWorld(world);
  }
});

test("the listing approval waits on an approved seller file when the gate is on, and not when it is off", async () => {
  const world = await makeWorld();
  try {
    // The desk's setting wins. Without one, a release build requires it and the demo doesn't.
    assert.equal(sellerIdentityRequired({ requireSellerIdentity: true }, {}), true);
    assert.equal(sellerIdentityRequired({ requireSellerIdentity: false }, { UPB_RELEASE: "1" }), false);
    assert.equal(sellerIdentityRequired({ requireSellerIdentity: null }, { UPB_RELEASE: "1" }), true);
    assert.equal(sellerIdentityRequired({}, {}), false);

    const seller = await world.person("gated", "INDIVIDUAL_SELLER");
    const desk = await world.person("desk", "ADMIN");
    const compliance = await world.person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    const listing = { sellerId: seller.id, brokerId: null, seller: { role: seller.role } };
    const on = { requireSellerIdentity: true };
    const off = { requireSellerIdentity: false };

    assert.match((await sellerIdentityHold(listing, on, {})) ?? "", /haven't sent their file/);
    assert.equal(await sellerIdentityHold(listing, off, { UPB_RELEASE: "1" }), null);
    assert.match((await sellerIdentityHold(listing, {}, { UPB_RELEASE: "1" })) ?? "", /Approval waits on the seller of record's identity/);
    assert.equal(await sellerIdentityHold(listing, {}, {}), null);

    assert.deepEqual(await submitSellerIdentity(seller, sellerForm({ entityType: "INDIVIDUAL", entityName: `Ada Lane ${world.tag}`, signerTitle: "" }, { idDoc: pdf("id.pdf"), authorityDoc: pdf("allonge.pdf") })), { ok: true });
    assert.match((await sellerIdentityHold(listing, on, {})) ?? "", /waiting for review/);
    assert.equal(await sellerIdentityHold(listing, off, {}), null);
    assert.match(identityGateMessage("CHANGES_REQUESTED"), /back with them for changes/);
    assert.match(identityGateMessage("REJECTED"), /declined/);

    assert.deepEqual(await decideSellerIdentity(compliance, { userId: seller.id, decision: "APPROVED", note: "" }), { ok: true, status: "APPROVED" });
    assert.equal(await sellerIdentityHold(listing, on, {}), null);
    // An approved file is screened again with the listing.
    assert.ok(await prisma.ofacCheck.findFirst({ where: { userId: seller.id, context: "Seller file on listing approval" } }));

    // The desk's own paper is outside the gate.
    assert.equal(await sellerIdentityHold({ sellerId: desk.id, seller: { role: "ADMIN" } }, on, {}), null);

    // Launch readiness names the gate.
    const by = (items: { label: string; state: string }[]) => items.find((item) => item.label === "Seller identity")?.state;
    assert.equal(by((await launchReadiness({ requireSellerIdentity: true }, {})).items), "live");
    assert.equal(by((await launchReadiness({ requireSellerIdentity: false }, { UPB_RELEASE: "1" })).items), "off");
    assert.equal(by((await launchReadiness({ requireSellerIdentity: null }, {})).items), "standin");
  } finally {
    await cleanWorld(world);
  }
});

test("a broker-filed listing waits on the broker's seller file until compliance approves it", async () => {
  const world = await makeWorld();
  let listingId = "";
  try {
    const broker = await world.person("broker", "BROKER", { companyName: `Lane Note Brokers ${world.tag}` });
    const compliance = await world.person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    // A broker files with themselves as the seller of record, for the note holder they name, with the holder's mandate.
    const made = await prisma.listing.create({
      data: { kind: "SINGLE", sellerId: broker.id, brokerId: broker.id, brokerRole: "SELLER_BROKER", clientSellerName: `Holder ${world.tag}`, status: "SUBMITTED", title: `Broker note ${world.tag}` },
    });
    listingId = made.id;
    await prisma.document.create({ data: { listingId, type: "MANDATE", originalName: "mandate.pdf", storedName: `seller-identity-mandate-${world.tag}.pdf`, mime: "application/pdf", size: 10 } });
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId }, include: { seller: true } });
    const on = { requireSellerIdentity: true };

    assert.match((await sellerIdentityHold(listing, on, {})) ?? "", /seller of record's identity.*haven't sent their file/);
    // The gate off still lets it through.
    assert.equal(await sellerIdentityHold(listing, { requireSellerIdentity: false }, {}), null);

    // The broker keeps the same file a seller does, with their own license as the authority document.
    assert.deepEqual(await submitSellerIdentity(broker, sellerForm({ entityName: `Lane Note Brokers ${world.tag}` }, { idDoc: pdf("id.pdf"), authorityDoc: pdf("broker license.pdf") })), { ok: true });
    const file = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: broker.id } });
    assert.match(file.authorityDocName, /license/);
    assert.match((await sellerIdentityHold(listing, on, {})) ?? "", /waiting for review/);

    assert.deepEqual(await decideSellerIdentity(compliance, { userId: broker.id, decision: "APPROVED", note: "", seen: file.submittedAt!.toISOString() }), { ok: true, status: "APPROVED" });
    assert.equal(await sellerIdentityHold(listing, on, {}), null);
    assert.equal(await sellerVerified(broker.id), true);
    assert.equal(canReadSellerFile(broker, broker.id), true);
  } finally {
    if (listingId) {
      await prisma.document.deleteMany({ where: { listingId } });
      await prisma.listing.deleteMany({ where: { id: listingId } });
    }
    await cleanWorld(world);
  }
});

test("a broker listing needs the holder's mandate on that listing, and the mandate is never served to a buyer", async () => {
  const world = await makeWorld();
  let listingId = "";
  try {
    const broker = await world.person("mandated", "BROKER");
    const seller = await world.person("plainseller", "INDIVIDUAL_SELLER");
    const compliance = await world.person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    const buyer = await world.person("buyer", "BUYER", { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" });
    // Only a broker is offered the mandate type, and it never goes on one loan's file.
    assert.equal(roomFileType("MANDATE", { broker: true, noteId: null }), "MANDATE");
    assert.equal(roomFileType("MANDATE", { broker: false, noteId: null }), "OTHER");
    assert.equal(roomFileType("TAPE", { broker: true, noteId: "loan" }), "OTHER");

    // An approved broker file, with the broker's own license as its authority document.
    assert.deepEqual(await submitSellerIdentity(broker, sellerForm({ entityName: `Mandated Brokers ${world.tag}` }, { idDoc: pdf("id.pdf"), authorityDoc: pdf("license.pdf") })), { ok: true });
    assert.deepEqual(await decideSellerIdentity(compliance, { userId: broker.id, decision: "APPROVED", note: "" }), { ok: true, status: "APPROVED" });

    const made = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId: broker.id,
        brokerId: broker.id,
        brokerRole: "SELLER_BROKER",
        clientSellerName: `Holder ${world.tag}`,
        status: "SUBMITTED",
        title: `Mandate note ${world.tag}`,
        notes: {
          create: [{
            streetAddress: "1 First St", city: `Mandateville${world.tag}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
            lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "NON_PERFORMING", monthsDelinquent: 9,
            askingPrice: 120000, estimatedValue: 260000,
          }] as never,
        },
      },
      include: { notes: true },
    });
    listingId = made.id;
    const gated = () => prisma.listing.findUniqueOrThrow({ where: { id: listingId }, include: { seller: true } });
    const on = { requireSellerIdentity: true };

    // An approved broker file isn't enough: the listing waits on its own mandate. With the gate off it doesn't.
    assert.equal(await sellerIdentityHold(await gated(), on, {}), MANDATE_MISSING);
    assert.equal(await sellerIdentityHold(await gated(), { requireSellerIdentity: false }, {}), null);
    const readiness = (await launchReadiness(on, {})).items.find((item) => item.label === "Broker mandates");
    assert.equal(readiness?.state, "off");

    // The broker adds it through the listing's file upload, even on a single note and even if a loan is picked.
    // Anyone else, or any other file type on a single note, is refused as before.
    const bytes = Buffer.from("%PDF-1.4\nmandate\n");
    assert.match((await addPoolFiles(seller, { listingId, files: [{ name: "mandate.pdf", bytes, type: "MANDATE" }] })).error ?? "", /isn't yours/);
    assert.match((await addPoolFiles(broker, { listingId, files: [{ name: "bpo.pdf", bytes, type: "BPO" }] })).error ?? "", /single note/);
    const added = await addPoolFiles(broker, { listingId, noteId: made.notes[0].id, files: [{ name: "holder mandate.pdf", bytes, type: "MANDATE" }] });
    assert.equal(added.error, null);
    assert.equal(added.added, 1);
    const mandate = await prisma.document.findFirstOrThrow({ where: { listingId, type: "MANDATE" } });
    assert.equal(mandate.noteId, null);
    assert.equal(await sellerIdentityHold(await gated(), on, {}), null);

    // Live, with a Pro buyer who signed the NDA: the room opens to them, and the mandate still doesn't.
    await prisma.listing.update({ where: { id: listingId }, data: { status: "APPROVED", approvedAt: new Date() } });
    await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId } });
    const roomFile = await prisma.document.create({ data: { listingId, type: "BPO", originalName: "bpo.pdf", storedName: `seller-identity-test-${world.tag}.pdf`, mime: "application/pdf", size: 10 } });
    assert.equal((await documentGate(buyer, roomFile.id)).allowed, true);
    assert.equal((await documentGate(buyer, mandate.id)).allowed, false);
    assert.equal((await documentGate(broker, mandate.id)).allowed, true);
    assert.equal((await documentGate(compliance, mandate.id)).allowed, true);
    // Every room list, copy and relist leaves it out.
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    assert.equal(isDeskOnlyDocument(mandate), true);
    assert.equal(isPrivateDocument(mandate, listing), true);
    assert.deepEqual(relistDocuments({ authorizationKey: listing.authorizationKey, documents: [mandate, roomFile] }, new Set(), true).map((row) => row.type), ["BPO"]);
  } finally {
    if (listingId) {
      const stored = await prisma.document.findMany({ where: { listingId }, select: { storedName: true } });
      await Promise.all(stored.map((row) => fs.rm(path.join(uploadDir(), row.storedName), { force: true })));
      await prisma.document.deleteMany({ where: { listingId } });
      await prisma.ndaAcknowledgment.deleteMany({ where: { listingId } });
      await prisma.note.deleteMany({ where: { listingId } });
      await prisma.listing.deleteMany({ where: { id: listingId } });
    }
    await cleanWorld(world);
  }
});

test("closing papers name the approved entity, and the account's name until then", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("titled", "INSTITUTIONAL_SELLER", { companyName: `Account Co ${world.tag}` });
    const plain = await world.person("plain", "INDIVIDUAL_SELLER");
    const compliance = await world.person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    assert.equal(await sellerOnTitle(seller), `Account Co ${world.tag}`);
    assert.equal(await sellerOnTitle({ id: plain.id, name: plain.name, companyName: "" }), plain.name);

    const entity = `Harbor Notes Fund I LP ${world.tag}`;
    assert.deepEqual(await submitSellerIdentity(seller, sellerForm({ entityType: "FUND", entityName: entity }, { idDoc: pdf("id.pdf"), authorityDoc: pdf("resolution.pdf") })), { ok: true });
    // A file waiting on the desk names nobody new.
    assert.equal(await sellerOnTitle(seller), `Account Co ${world.tag}`);
    assert.deepEqual(await decideSellerIdentity(compliance, { userId: seller.id, decision: "APPROVED", note: "" }), { ok: true, status: "APPROVED" });
    assert.equal(await sellerOnTitle(seller), entity);
    assert.deepEqual(await decideSellerIdentity(compliance, { userId: seller.id, decision: "CHANGES_REQUESTED", note: "Send the current resolution." }), { ok: true, status: "CHANGES_REQUESTED" });
    assert.equal(await sellerOnTitle(seller), `Account Co ${world.tag}`);
  } finally {
    await cleanWorld(world);
  }
});

test("deleting a seller's account removes their identity documents and digits when no closing names them", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("leaving", "INDIVIDUAL_SELLER");
    assert.deepEqual(await submitSellerIdentity(seller, sellerForm({}, { idDoc: pdf("id.pdf"), authorityDoc: pdf("oa.pdf") })), { ok: true });
    const before = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    await anonymiseAccount(seller.id);
    const after = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: seller.id } });
    assert.equal(await exists(before.idDocKey), false);
    assert.equal(await exists(before.authorityDocKey), false);
    assert.equal(after.idDocKey, "");
    assert.equal(after.authorityDocKey, "");
    assert.equal(after.taxIdLast4, null);
    assert.equal(after.entityName, "");
    assert.equal(after.signerName, "");
    assert.equal(after.status, "SUBMITTED");
  } finally {
    await cleanWorld(world);
  }
});
