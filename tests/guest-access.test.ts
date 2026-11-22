import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { accessLog } from "../lib/access-log";
import {
  DEFAULT_GUEST_DAYS,
  GUEST_HITS_PER_MINUTE,
  GUEST_VIEW,
  LIVE_PASS_LIMIT,
  createGuestPass,
  guestClosingFileDownload,
  guestDocumentDownload,
  guestHolder,
  guestPaperDownload,
  guestTitle,
  guestTokenHash,
  openGuestPass,
  outsideParties,
  passState,
  readGuestDays,
  revokeGuestPass,
} from "../lib/guest-access";
import { prisma } from "../lib/prisma";
import { resolveSessionUser, type ActingUser } from "../lib/seats";
import { putBytes, uploadDir } from "../lib/storage";
import { watermarkLine } from "../lib/watermark";

// Files go to local disk, mail to the log, and rate limits to memory, whatever the shared .env says. Nothing in these
// tests runs inside a request, so a guest path that read or set a session cookie would throw here.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";
process.env.RATE_LIMIT_STORE = "memory";

const DAY = 24 * 60 * 60 * 1000;
const STEPS = ["PURCHASE_AGREEMENT", "BUYER_DEPOSIT", "COLLATERAL_TRANSFER", "ASSIGNMENT", "PAYMENT_RECEIVED", "CLOSED"];
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const stored: string[] = [];
let ipCount = 0;
// Each call from its own address, so the per-address limit never trips a test that isn't about it.
const ip = () => `198.51.100.${tag}.${(ipCount += 1)}`;
const request = (url = "http://localhost/guest") => new Request(url, { headers: { "x-forwarded-for": ip() } });
const tokenOf = (link: { token: string }) => link.token;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The rules, without the database.

test("a link runs 7, 14 or 30 days, 14 by default, and reads as whose guest it is", () => {
  assert.equal(readGuestDays(""), DEFAULT_GUEST_DAYS);
  assert.equal(readGuestDays(undefined), 14);
  for (const days of [7, 14, 30]) assert.equal(readGuestDays(String(days)), days);
  for (const days of ["0", "3", "31", "90", "120", "x"]) assert.equal(readGuestDays(days), null, days);
  assert.equal(guestHolder({ name: "Jane Roe", role: "ATTORNEY" }), "Guest · Jane Roe · Attorney");
  assert.equal(guestHolder({ name: "Sam Lee", role: "TITLE" }), "Guest · Sam Lee · Title officer");
  assert.equal(guestHolder({ name: "Sam Lee", role: "NOPE" }), "Guest · Sam Lee · Other");
  assert.equal(guestTitle({ side: "SELLER", role: "ATTORNEY" }), "Seller's attorney");
  assert.equal(guestTitle({ side: "DESK", role: "AUDITOR" }), "Desk's auditor");
  assert.equal(guestTitle({ side: "BUYER", role: "CUSTODIAN" }, "Bidder A"), "Bidder A's document custodian");
  const now = new Date("2026-11-22T12:00:00Z");
  assert.equal(passState({ expiresAt: new Date(now.getTime() + 1000), revokedAt: null }, now), "live");
  assert.equal(passState({ expiresAt: now, revokedAt: null }, now), "expired");
  assert.equal(passState({ expiresAt: new Date(now.getTime() + DAY), revokedAt: now }, now), "revoked");
  assert.match(guestTokenHash("a".repeat(64)), /^[0-9a-f]{64}$/);
});

test("the guest route is limited per address, and a malformed link says only that it ended", async () => {
  const address = `203.0.113.${tag}`;
  for (let hit = 0; hit < GUEST_HITS_PER_MINUTE; hit += 1) assert.deepEqual(await openGuestPass("not-a-token", { ip: address }), { state: "ended" });
  assert.deepEqual(await openGuestPass("f".repeat(64), { ip: address }), { state: "limited" });
  assert.deepEqual(await openGuestPass("f".repeat(64), { ip: `${address}.other` }), { state: "ended" });
  const limited = await guestDocumentDownload("f".repeat(64), "x", new Request("http://localhost/x", { headers: { "x-forwarded-for": address } }));
  assert.equal(limited.status, 429);
});

// ---------------------------------------------------------------------------------------------------------------
// The world: a pool in contract. The buyer is closing on loan 1; loan 2 is still for sale, so its own file is shut
// to the buyer. A broker filed it, a stranger bid and lost, and the buyer's firm has a view-only and a trading seat.

const loan = (street: string, extra: Record<string, unknown> = {}) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 120000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 100000, estimatedValue: 180000, ...extra,
});

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

function streamText(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const body = Buffer.from(match[1], "latin1");
    try {
      out += inflateSync(body).toString("latin1");
    } catch {
      out += match[1];
    }
  }
  return out;
}

const hex = (text: string) => Buffer.from(text, "latin1").toString("hex").toUpperCase();

async function storePdf(name: string) {
  const key = `guest-test/${tag}/${name}`;
  await putBytes(key, await samplePdf(), "application/pdf");
  stored.push(key);
  return key;
}

async function makeWorld() {
  const email = (who: string) => `guest-${who}-${tag}@example.org`;
  const user = (who: string, data: Record<string, unknown>) =>
    prisma.user.create({ data: { email: email(who), name: `${who} ${tag}`, accountStatus: "APPROVED", passwordHash: "x", emailConfirmedAt: new Date(), ...data } as never });
  const seller = await user("seller", { role: "INSTITUTIONAL_SELLER", companyName: `Seller Bank ${tag}` });
  const buyer = await user("buyer", { role: "BUYER", companyName: `Buyer Fund ${tag}` });
  const stranger = await user("stranger", { role: "BUYER", companyName: `Stranger Capital ${tag}`, subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" });
  const broker = await user("broker", { role: "BROKER", companyName: `Broker House ${tag}` });
  const closer = await user("closer", { role: "ADMIN", deskRole: "CLOSINGS" });
  const sales = await user("sales", { role: "ADMIN", deskRole: "SALES" });
  const seat = (who: string, seatRole: string) =>
    user(who, { role: "BUYER", principalId: buyer.id, seatRole, seatAddedAt: new Date() });
  const viewSeat = await seat("view-seat", "VIEW");
  const tradeSeat = await seat("trade-seat", "TRADE");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED", entityType: "LLC", entityName: `KYC Entity ${tag}`, jurisdiction: "Delaware" } });
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      brokerId: broker.id,
      status: "PENDING",
      approvedAt: new Date(Date.now() - 10 * DAY),
      standingBidsNotifiedAt: new Date(),
      title: `Guest pool ${tag}`,
      notes: { create: [loan("1 Guest Row", { tradeStatus: "IN_CONTRACT" }), loan("2 Guest Row")] as never },
    },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
  const [first, second] = listing.notes;
  const doc = async (type: string, name: string, extra: Record<string, unknown> = {}) =>
    prisma.document.create({ data: { listingId: listing.id, type, originalName: name, storedName: await storePdf(name), mime: "application/pdf", size: 10, ...extra } as never });
  const bpo = await doc("BPO", `bpo-${tag}.pdf`);
  const loanFile = await doc("OE_REPORT", `oe-loan-2-${tag}.pdf`, { noteId: second.id });
  const nda = await doc("NDA", `nda-${tag}.pdf`);
  const mandate = await doc("MANDATE", `mandate-${tag}.pdf`);
  const won = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 100000 } });
  // A losing bid whose amount must never reach a guest.
  await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: stranger.id, type: "OFFER", status: "DECLINED", amount: 87654 } });
  const closing = await prisma.closing.create({
    data: {
      listingId: listing.id,
      inquiryId: won.id,
      noteIds: [first.id],
      status: "OPEN",
      salePrice: 100000,
      buyerPremiumCents: 0,
      sellerCommissionCents: 0,
      buyerTotalCents: 10000000,
      netToSellerCents: 10000000,
      wireInstructions: `Wire to ROUTING-${tag} account 99887766`,
      fundsReceivedCents: 10000000,
      fundsReceivedAt: new Date(Date.now() - DAY),
      fundsReference: `WIREREF-${tag}`,
      steps: { create: STEPS.map((key) => ({ key, status: key === "PURCHASE_AGREEMENT" ? "COMPLETE" : "PENDING", ...(key === "PURCHASE_AGREEMENT" ? { completedAt: new Date(Date.now() - 2 * DAY) } : {}) })) as never },
    },
    include: { steps: true },
  });
  const psaStep = closing.steps.find((step) => step.key === "PURCHASE_AGREEMENT")!;
  const closingFile = await prisma.closingFile.create({ data: { stepId: psaStep.id, originalName: `signed-psa-${tag}.pdf`, storageKey: await storePdf(`signed-psa-${tag}.pdf`), mime: "application/pdf", size: 10, uploadedById: seller.id } });
  await prisma.trailingDoc.create({ data: { closingId: closing.id, noteId: first.id, kind: "ORIGINAL_NOTE", owner: "SELLER", status: "SENT", dueAt: new Date(Date.now() + 5 * DAY), sentAt: new Date() } });
  // Wire records on the log that a guest's copy leaves out.
  await prisma.auditEvent.create({ data: { actorId: closer.id, action: "FUNDS_RECEIVED", entityType: "closing", entityId: closing.id, detail: `Buyer funds received: none to $100,000.00 on 2026-11-20 · WIREREF-${tag}` } });
  await prisma.auditEvent.create({ data: { actorId: closer.id, action: "WIRE_EDIT", entityType: "closing", entityId: closing.id, detail: `ROUTING-${tag}` } });
  // A second closing on the same pool, to end by canceling and to check a pass opens only its own closing.
  const other = await prisma.closing.create({
    data: {
      listingId: listing.id,
      noteIds: [second.id],
      status: "OPEN",
      salePrice: 50000,
      buyerPremiumCents: 0,
      sellerCommissionCents: 0,
      buyerTotalCents: 5000000,
      netToSellerCents: 5000000,
      steps: { create: STEPS.map((key) => ({ key, status: "PENDING" })) as never },
    },
    include: { steps: true },
  });
  const otherFile = await prisma.closingFile.create({ data: { stepId: other.steps[0].id, originalName: `other-${tag}.pdf`, storageKey: await storePdf(`other-${tag}.pdf`), mime: "application/pdf", size: 10 } });
  const acting = async (id: string) => (await resolveSessionUser(id))!.user;
  return {
    seller: await acting(seller.id),
    buyer: await acting(buyer.id),
    stranger: await acting(stranger.id),
    broker: await acting(broker.id),
    closer: await acting(closer.id),
    sales: await acting(sales.id),
    viewSeat: await acting(viewSeat.id),
    tradeSeat: await acting(tradeSeat.id),
    listing,
    closing,
    other,
    closingFile,
    otherFile,
    bpo,
    loanFile,
    nda,
    mandate,
    users: [seller, buyer, stranger, broker, closer, sales, viewSeat, tradeSeat],
  };
}

type World = Awaited<ReturnType<typeof makeWorld>>;
let world: World;

test.before(async () => {
  world = await makeWorld();
});

test.after(async () => {
  if (!world) return;
  const listingIds = [world.listing.id];
  const closingIds = [world.closing.id, world.other.id];
  const userIds = world.users.map((row) => row.id);
  await prisma.guestPass.deleteMany({ where: { OR: [{ closingId: { in: closingIds } }, { listingId: { in: listingIds } }] } });
  await prisma.closingFile.deleteMany({ where: { step: { is: { closingId: { in: closingIds } } } } });
  await prisma.trailingDoc.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.closingStep.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.closing.deleteMany({ where: { id: { in: closingIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.document.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { toEmail: { in: world.users.map((row) => row.email) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const key of stored) await fs.unlink(path.join(uploadDir(), key)).catch(() => undefined);
  await fs.rm(path.join(uploadDir(), "guest-test", tag), { recursive: true, force: true }).catch(() => undefined);
  // The shared folder goes once no other run is using it.
  await fs.rmdir(path.join(uploadDir(), "guest-test")).catch(() => undefined);
});

const guestEmail = (who: string) => `guest-outside-${who}-${tag}@example.org`;

async function pass(actor: ActingUser, scope: { closingId?: string; listingId?: string }, who: string, extra: { role?: string; days?: string; now?: Date } = {}) {
  const made = await createGuestPass(actor, { ...scope, name: `Guest ${who}`, email: guestEmail(who), role: extra.role ?? "ATTORNEY", days: extra.days, now: extra.now });
  if (!made.ok) throw new Error(`${who}: ${made.error}`);
  return made.value;
}

// ---------------------------------------------------------------------------------------------------------------

test("each side of a closing adds its own guests; a view-only seat, a broker watching and a stranger can't, and a side holds ten", async () => {
  const { buyer, seller, closer, sales, stranger, broker, viewSeat, tradeSeat, closing } = world;
  const at = { closingId: closing.id };
  const buyers = await pass(buyer, at, "buyer-attorney");
  const sellers = await pass(seller, at, "seller-attorney");
  const desks = await pass(closer, at, "desk-auditor", { role: "AUDITOR" });
  const rows = await prisma.guestPass.findMany({ where: { id: { in: [buyers.passId, sellers.passId, desks.passId] } } });
  assert.deepEqual(rows.map((row) => row.side).sort(), ["BUYER", "DESK", "SELLER"]);
  for (const row of rows) {
    assert.equal(row.closingId, closing.id);
    assert.equal(row.listingId, null);
    // Only the hash of the token is kept, and the default link runs 14 days.
    assert.equal(row.tokenHash, guestTokenHash([buyers, sellers, desks].find((made) => made.passId === row.id)!.token));
    assert.ok(Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - 14 * DAY) < 60 * 1000);
  }
  // A trading seat adds for its firm; a view-only seat commits to nothing.
  const bySeat = await pass(tradeSeat, at, "seat-title", { role: "TITLE", days: "7" });
  const seatRow = await prisma.guestPass.findUniqueOrThrow({ where: { id: bySeat.passId } });
  assert.equal(seatRow.createdById, buyer.id);
  assert.equal(seatRow.side, "BUYER");
  const viewOnly = await createGuestPass(viewSeat, { ...at, name: "Nope", email: guestEmail("view"), role: "ATTORNEY" });
  assert.equal(viewOnly.ok, false);
  assert.match(viewOnly.ok ? "" : viewOnly.error, /view only/);
  for (const outsider of [stranger, broker]) {
    const refused = await createGuestPass(outsider, { ...at, name: "Nope", email: guestEmail("outsider"), role: "ATTORNEY" });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /Only the buyer, the seller and the desk/);
  }
  // A desk role that doesn't run closings can't add one to a closing.
  const deskSales = await createGuestPass(sales, { ...at, name: "Nope", email: guestEmail("sales"), role: "AUDITOR" });
  assert.match(deskSales.ok ? "" : deskSales.error, /desk role doesn't cover/);
  // Bad input is refused, and one address holds one live link.
  assert.match(((r) => (r.ok ? "" : r.error))(await createGuestPass(seller, { ...at, name: "Jo Bloggs", email: "nope", role: "ATTORNEY" })), /valid email/);
  assert.match(((r) => (r.ok ? "" : r.error))(await createGuestPass(seller, { ...at, name: "Jo Bloggs", email: guestEmail("x"), role: "JUDGE" })), /Choose attorney/);
  assert.match(((r) => (r.ok ? "" : r.error))(await createGuestPass(seller, { ...at, name: "Jo Bloggs", email: guestEmail("x"), role: "ATTORNEY", days: "90" })), /7, 14 or 30/);
  assert.match(((r) => (r.ok ? "" : r.error))(await createGuestPass(seller, { ...at, name: "Again", email: guestEmail("seller-attorney"), role: "ATTORNEY" })), /already has a live link/);

  // The seller side fills its ten; the buyer side's count is its own.
  for (let index = 1; index < LIVE_PASS_LIMIT; index += 1) await pass(seller, at, `seller-${index}`, { role: "OTHER" });
  const eleventh = await createGuestPass(seller, { ...at, name: "One Too Many", email: guestEmail("seller-eleven"), role: "OTHER" });
  assert.match(eleventh.ok ? "" : eleventh.error, /10 live guest links on this closing/);
  // An ended link frees its place.
  const anyOne = await prisma.guestPass.findFirstOrThrow({ where: { closingId: closing.id, side: "SELLER", email: guestEmail("seller-9") } });
  assert.equal((await revokeGuestPass(seller, anyOne.id)).ok, true);
  assert.equal((await createGuestPass(seller, { ...at, name: "Now There Is Room", email: guestEmail("seller-eleven"), role: "OTHER" })).ok, true);
  assert.equal((await createGuestPass(buyer, { ...at, name: "Buyer Custodian", email: guestEmail("buyer-custodian"), role: "CUSTODIAN" })).ok, true);
  // End four more, so the seller side has room for the tests below.
  for (let index = 1; index <= 4; index += 1) {
    const row = await prisma.guestPass.findFirstOrThrow({ where: { closingId: closing.id, email: guestEmail(`seller-${index}`) } });
    assert.equal((await revokeGuestPass(seller, row.id)).ok, true);
  }

  // Every add is audited against the closing, without the guest's email.
  const audits = await prisma.auditEvent.findMany({ where: { entityId: closing.id, action: "GUEST_PASS_CREATED" } });
  assert.ok(audits.length >= 13);
  assert.ok(audits.every((event) => !event.detail.includes("@")));
  assert.ok(audits.some((event) => event.detail.includes("Seller's attorney · Guest seller-attorney")));
});

test("a closing's link opens its summary as that side sees it: steps, its documents, trailing documents, the log, and no bids, wires or identity records", async () => {
  const { buyer, closing, closingFile, otherFile, bpo, listing } = world;
  const made = await pass(buyer, { closingId: closing.id }, "summary-attorney");
  const before = await prisma.guestPass.findUniqueOrThrow({ where: { id: made.passId } });
  assert.equal(before.lastUsedAt, null);
  const opened = await openGuestPass(tokenOf(made), { ip: ip() });
  assert.equal(opened.state, "closing");
  if (opened.state !== "closing") return;
  assert.equal(opened.inviter, `Buyer Fund ${tag} (the buyer)`);
  assert.equal(opened.side, "BUYER");
  assert.equal(opened.name, "Guest summary-attorney");
  const { view } = opened;
  assert.equal(view.title, listing.title);
  assert.equal(view.parties, `Buyer Fund ${tag} buying from Seller Bank ${tag}`);
  assert.deepEqual(view.steps.map((step) => [step.key, step.done]), STEPS.map((key) => [key, key === "PURCHASE_AGREEMENT"]));
  assert.deepEqual(view.files.map((file) => file.id), [closingFile.id]);
  assert.deepEqual(view.papers.map((paper) => paper.kind), ["PSA", "ASSIGNMENT", "ALLONGE", "LOST_NOTE_AFFIDAVIT"]);
  assert.deepEqual(view.trailing.map((doc) => [doc.label, doc.status, doc.from]), [["Original note", "Sent", "Seller"]]);
  assert.ok(view.timeline.entries.some((entry) => entry.title === "Closing opened"));
  assert.ok(view.timeline.entries.some((entry) => entry.title === "File added to purchase agreement"));
  const text = JSON.stringify(opened);
  for (const secret of [`ROUTING-${tag}`, `WIREREF-${tag}`, "99887766", "Buyer funds recorded", "Wire instructions changed", "87,654", "87654", `KYC Entity ${tag}`, "Delaware", "@example.org", `oe-loan-2-${tag}`, `nda-${tag}`, `mandate-${tag}`]) {
    assert.ok(!text.includes(secret), `the guest's closing view leaks ${secret}`);
  }
  assert.notEqual((await prisma.guestPass.findUniqueOrThrow({ where: { id: made.passId } })).lastUsedAt, null);

  // Its own closing's files and papers only. A room file, or another closing's file, isn't in its scope.
  const own = await guestClosingFileDownload(tokenOf(made), closingFile.id, request());
  assert.equal(own.status, 200);
  assert.equal((await guestClosingFileDownload(tokenOf(made), otherFile.id, request())).status, 404);
  assert.equal((await guestDocumentDownload(tokenOf(made), bpo.id, request())).status, 403);
  const paper = await guestPaperDownload(tokenOf(made), "PSA", request());
  assert.equal(paper.status, 200);
  assert.equal(paper.headers.get("Content-Type"), "application/pdf");
  assert.equal((await guestPaperDownload(tokenOf(made), "toString", request())).status, 404);
  // Each closing download is logged against the closing as a guest view naming the pass.
  const views = await prisma.auditEvent.findMany({ where: { entityType: "closing", entityId: closing.id, action: GUEST_VIEW } });
  assert.ok(views.some((event) => event.detail === `${made.passId} · signed-psa-${tag}.pdf` && event.actorId === null));
  assert.ok(views.some((event) => event.detail === `${made.passId} · Purchase agreement`));
});

test("a buyer with the room open adds a guest who opens only what the buyer may; the seller's guest opens more", async () => {
  const { buyer, seller, broker, sales, stranger, viewSeat, listing, bpo, loanFile, nda, mandate } = world;
  const at = { listingId: listing.id };
  // The stranger lost and has no room on a listing in contract. A view-only seat can't add one either.
  assert.match(((r) => (r.ok ? "" : r.error))(await createGuestPass(stranger, { ...at, name: "Nope", email: guestEmail("room-stranger"), role: "ATTORNEY" })), /a buyer with the room open/);
  assert.match(((r) => (r.ok ? "" : r.error))(await createGuestPass(viewSeat, { ...at, name: "Nope", email: guestEmail("room-view"), role: "ATTORNEY" })), /view only/);
  const buyers = await pass(buyer, at, "room-buyer-attorney");
  const sellers = await pass(seller, at, "room-seller-attorney");
  const brokers = await pass(broker, at, "room-broker-custodian", { role: "CUSTODIAN" });
  const desks = await pass(sales, at, "room-desk-auditor", { role: "AUDITOR" });
  const sides = await prisma.guestPass.findMany({ where: { id: { in: [buyers.passId, sellers.passId, brokers.passId, desks.passId] } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(sides.map((row) => row.side), ["BUYER", "SELLER", "SELLER", "DESK"]);

  const buyerView = await openGuestPass(tokenOf(buyers), { ip: ip() });
  assert.equal(buyerView.state, "room");
  if (buyerView.state !== "room") return;
  // Loan 2 is still for sale, so its own file is shut to the buyer closing on loan 1, and to the buyer's guest.
  assert.deepEqual(buyerView.view.files.map((file) => file.id), [bpo.id]);
  assert.equal((await guestDocumentDownload(tokenOf(buyers), loanFile.id, request())).status, 403);
  // Signed NDAs and the broker's mandate are never a guest's, whoever invited them.
  const sellerView = await openGuestPass(tokenOf(sellers), { ip: ip() });
  assert.equal(sellerView.state, "room");
  if (sellerView.state !== "room") return;
  assert.deepEqual(sellerView.view.files.map((file) => file.id).sort(), [bpo.id, loanFile.id].sort());
  assert.equal((await guestDocumentDownload(tokenOf(sellers), loanFile.id, request())).status, 200);
  for (const shut of [nda, mandate]) assert.equal((await guestDocumentDownload(tokenOf(sellers), shut.id, request())).status, 404);
  // A room link opens no closing file.
  assert.equal((await guestClosingFileDownload(tokenOf(buyers), world.closingFile.id, request())).status, 403);
});

test("a guest's download is stamped with the guest's name and role and logged as a guest view in the room's access log", async () => {
  const { buyer, seller, listing, bpo } = world;
  const made = await pass(buyer, { listingId: listing.id }, "stamp-attorney");
  const guest = await prisma.guestPass.findUniqueOrThrow({ where: { id: made.passId } });
  const now = new Date("2026-11-22T15:00:00Z");
  const response = await guestDocumentDownload(tokenOf(made), bpo.id, request(`http://localhost/api/documents/${bpo.id}?guest=${made.token}`), now);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const line = watermarkLine(guestHolder(guest), now);
  assert.equal(line, `Confidential · Guest · Guest stamp-attorney · Attorney · 2026-11-22 · UPB Capital`);
  assert.equal(streamText(bytes).split(hex(line)).length - 1, 2);
  const logged = await prisma.auditEvent.findFirst({ where: { entityType: "listing", entityId: listing.id, action: GUEST_VIEW, detail: `${made.passId} · ${bpo.originalName}` } });
  assert.ok(logged);
  assert.equal(logged.actorId, null);
  // The seller's access log names the buyer's guest by name and role, with the pass, and no email.
  const log = await accessLog(listing.id, seller);
  assert.equal(log.status, 200);
  if (log.status !== 200) return;
  const row = log.rows.find((entry) => entry.event === `Guest view · pass ${made.passId}`);
  assert.ok(row);
  assert.equal(row.bidder, `Buyer Fund ${tag}'s guest · Guest stamp-attorney, Attorney`);
  assert.equal(row.file, bpo.originalName);
  assert.ok(log.rows.every((entry) => !entry.bidder.includes("@")));
});

test("an expired or revoked link ends access and says nothing more, and only the side that added it or the desk ends it", async () => {
  const { buyer, seller, closer, closing, closingFile } = world;
  const expired = await pass(seller, { closingId: closing.id }, "expired-attorney", { days: "7", now: new Date(Date.now() - 8 * DAY) });
  assert.deepEqual(await openGuestPass(tokenOf(expired), { ip: ip() }), { state: "ended" });
  assert.equal((await guestClosingFileDownload(tokenOf(expired), closingFile.id, request())).status, 403);

  const live = await pass(seller, { closingId: closing.id }, "revoked-attorney");
  assert.equal((await openGuestPass(tokenOf(live), { ip: ip() })).state, "closing");
  // The buyer can't end the seller's guest; the seller can.
  assert.match(((r) => (r.ok ? "" : r.error))(await revokeGuestPass(buyer, live.passId)), /Only the side that added this guest/);
  const ended = await revokeGuestPass(seller, live.passId);
  assert.deepEqual(ended, { ok: true, value: { changed: true, closingId: closing.id, listingId: null } });
  assert.deepEqual(await openGuestPass(tokenOf(live), { ip: ip() }), { state: "ended" });
  const refused = await guestClosingFileDownload(tokenOf(live), closingFile.id, request());
  assert.equal(refused.status, 403);
  assert.equal(await refused.text(), "This link has ended.");
  assert.deepEqual(await revokeGuestPass(seller, live.passId), { ok: true, value: { changed: false, closingId: closing.id, listingId: null } });
  assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: closing.id, action: "GUEST_PASS_REVOKED", detail: { startsWith: live.passId } } }));

  // The desk ends any side's link.
  const buyers = await pass(buyer, { closingId: closing.id }, "desk-ends-this");
  assert.equal((await revokeGuestPass(closer, buyers.passId)).ok, true);
  assert.deepEqual(await openGuestPass(tokenOf(buyers), { ip: ip() }), { state: "ended" });
});

test("canceling a closing ends its links, and it takes no new ones", async () => {
  const { seller, closer, other, otherFile } = world;
  const made = await pass(closer, { closingId: other.id }, "cancel-auditor", { role: "AUDITOR" });
  assert.equal((await openGuestPass(tokenOf(made), { ip: ip() })).state, "closing");
  assert.equal((await guestClosingFileDownload(tokenOf(made), otherFile.id, request())).status, 200);
  await prisma.closing.update({ where: { id: other.id }, data: { status: "CANCELED", canceledAt: new Date(), cancelReason: "Test" } });
  assert.deepEqual(await openGuestPass(tokenOf(made), { ip: ip() }), { state: "ended" });
  assert.equal((await guestClosingFileDownload(tokenOf(made), otherFile.id, request())).status, 403);
  assert.match(((r) => (r.ok ? "" : r.error))(await createGuestPass(seller, { closingId: other.id, name: "Too Late", email: guestEmail("too-late"), role: "ATTORNEY" })), /canceled/);
  const section = await outsideParties(seller, { closingId: other.id, listingId: other.listingId });
  assert.ok(section);
  assert.match(section.block ?? "", /canceled/);
  assert.equal(section.forms.closing, false);
  // Its link reads as ended there, with nothing left to end.
  const row = section.rows.find((entry) => entry.id === made.passId);
  assert.equal(row?.state, "revoked");
  assert.equal(row?.canRevoke, false);
  assert.ok(row?.endedAt);
});

test("the other side sees a guest's name and role, never the email; the side that added it sees it all", async () => {
  const { buyer, seller, closer, closing, listing } = world;
  const made = await pass(buyer, { closingId: closing.id }, "counterparty-attorney");
  const sellerSees = await outsideParties(seller, { closingId: closing.id, listingId: listing.id });
  assert.ok(sellerSees);
  assert.equal(sellerSees.side, "SELLER");
  const theirs = sellerSees.rows.find((row) => row.id === made.passId);
  assert.ok(theirs);
  assert.equal(theirs.title, "Buyer's attorney");
  assert.equal(theirs.name, "Guest counterparty-attorney");
  assert.equal(theirs.email, null);
  assert.equal(theirs.expiresAt, null);
  assert.equal(theirs.lastUsedAt, null);
  assert.equal(theirs.canRevoke, false);
  assert.ok(!JSON.stringify(sellerSees.rows.filter((row) => row.side === "BUYER")).includes("@"));
  // The seller's own guests show in full, with the control to end the live ones.
  const ownRow = sellerSees.rows.find((row) => row.name === "Guest seller-attorney");
  assert.ok(ownRow);
  assert.equal(ownRow.email, guestEmail("seller-attorney"));
  assert.equal(ownRow.canRevoke, true);
  assert.equal(sellerSees.forms.closing, true);

  const buyerSees = await outsideParties(buyer, { closingId: closing.id, listingId: listing.id });
  assert.ok(buyerSees);
  const mine = buyerSees.rows.find((row) => row.id === made.passId);
  assert.equal(mine?.email, guestEmail("counterparty-attorney"));
  assert.equal(mine?.canRevoke, true);
  const sellerRow = buyerSees.rows.find((row) => row.name === "Guest seller-attorney");
  assert.equal(sellerRow?.title, "Seller's attorney");
  assert.equal(sellerRow?.email, null);
  // The buyer may also give a guest its room, from the closing page.
  assert.deepEqual(buyerSees.forms, { closing: true, room: true });

  // In the seller's view of the room, the buyer's room guest shows under the buyer, without the email.
  const roomSees = await outsideParties(seller, { listingId: listing.id });
  assert.ok(roomSees);
  const roomRow = roomSees.rows.find((row) => row.name === "Guest room-buyer-attorney");
  assert.equal(roomRow?.title, `Buyer Fund ${tag}'s attorney`);
  assert.equal(roomRow?.email, null);
  assert.ok(roomSees.rows.every((row) => row.scope === "room"));
  // A buyer reads its room guests on its closing, not on the seller's page; the desk sees every email.
  assert.equal(await outsideParties(buyer, { listingId: listing.id }), null);
  const deskSees = await outsideParties(closer, { closingId: closing.id, listingId: listing.id });
  assert.equal(deskSees?.rows.find((row) => row.id === made.passId)?.email, guestEmail("counterparty-attorney"));
});
