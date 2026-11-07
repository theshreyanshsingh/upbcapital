import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cancelOpenClosing, openClosing } from "../lib/closing-service";
import { literal } from "../lib/db-filters";
import { prisma } from "../lib/prisma";
import { getSettings } from "../lib/settings";
import {
  applyVendorEvent,
  declineRequest,
  docuSignEvent,
  docuSignSignature,
  documentHash,
  dropboxSignEvent,
  dropboxSignHash,
  readSigners,
  requestStatus,
  reminderDue,
  sendForSignatures,
  sendOnAward,
  sentCopy,
  signHours,
  signRequest,
  signatureClock,
  verifyDocuSign,
  verifyDropboxSign,
  voidRequest,
} from "../lib/signatures";
import { uploadDir } from "../lib/storage";

const HOUR = 60 * 60 * 1000;
// Files stay on disk, mail stays in the log and signing stays in the app, whatever keys the local .env carries.
for (const key of [
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "RESEND_API_KEY",
  "SMTP_HOST",
  "DESK_EMAIL",
  "DROPBOX_SIGN_API_KEY",
  "DOCUSIGN_ACCESS_TOKEN",
  "DOCUSIGN_ACCOUNT_ID",
  "DOCUSIGN_CONNECT_SECRET",
]) {
  process.env[key] = "";
}

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The vendors' signatures, against fixed vectors. The Jefe pair is RFC 4231 test case 2.

test("Dropbox Sign's event hash is the hex HMAC-SHA256 of event_time then event_type, keyed with the API key", () => {
  assert.equal(dropboxSignHash("what do ya want ", "for nothing?", "Jefe"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  assert.equal(dropboxSignHash("1700000000", "signature_request_signed", "test-api-key-123"), "1e1ffef96d2abe38da52cbac761d90e1b230458b94de7ddf90acf3c331227b88");
  const event = { event_time: "1700000000", event_type: "signature_request_signed", event_hash: "1e1ffef96d2abe38da52cbac761d90e1b230458b94de7ddf90acf3c331227b88" };
  assert.equal(verifyDropboxSign(event, "test-api-key-123"), true);
  // Dropbox Sign sends the time as a string; a number reads the same.
  assert.equal(verifyDropboxSign({ ...event, event_time: 1700000000 }, "test-api-key-123"), true);
  assert.equal(verifyDropboxSign({ ...event, event_hash: event.event_hash.toUpperCase() }, "test-api-key-123"), true);
  assert.equal(verifyDropboxSign(event, "another-key"), false);
  assert.equal(verifyDropboxSign({ ...event, event_type: "signature_request_all_signed" }, "test-api-key-123"), false);
  assert.equal(verifyDropboxSign({ ...event, event_time: "1700000001" }, "test-api-key-123"), false);
  assert.equal(verifyDropboxSign({ event_time: event.event_time, event_type: event.event_type }, "test-api-key-123"), false);
  assert.equal(verifyDropboxSign(event, ""), false);
  assert.equal(verifyDropboxSign(event, undefined), false);
  assert.equal(verifyDropboxSign(null, "test-api-key-123"), false);
});

test("DocuSign Connect's signature is the base64 HMAC-SHA256 of the raw body, and any one header may carry it", () => {
  assert.equal(docuSignSignature("what do ya want for nothing?", "Jefe"), "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=");
  const body = '{"event":"envelope-completed","data":{"envelopeId":"env-1"}}';
  const signature = "Zu/rhIw1svCtVLtWnX5y31bLdcslTFP84UK7afJp2z4=";
  assert.equal(docuSignSignature(body, "connect-secret-abc"), signature);
  assert.equal(verifyDocuSign(Buffer.from(body), [signature], "connect-secret-abc"), true);
  // While keys rotate, the matching key's header may not be the first.
  assert.equal(verifyDocuSign(body, ["bm90IGl0", signature], "connect-secret-abc"), true);
  assert.equal(verifyDocuSign(`${body} `, [signature], "connect-secret-abc"), false);
  assert.equal(verifyDocuSign(body, [signature], "another-secret"), false);
  assert.equal(verifyDocuSign(body, [], "connect-secret-abc"), false);
  assert.equal(verifyDocuSign(body, [null, ""], "connect-secret-abc"), false);
  assert.equal(verifyDocuSign(body, [signature], undefined), false);
});

test("vendor events map to signer lines, and the request's status follows from the lines", () => {
  const dropbox = dropboxSignEvent({
    event: { event_time: "1700000000", event_type: "signature_request_signed" },
    signature_request: {
      signature_request_id: "ds-1",
      is_complete: false,
      signatures: [
        { signer_email_address: "seller@example.org", signer_name: "Sally", status_code: "signed", signed_at: 1700000000 },
        { signer_email_address: "buyer@example.org", signer_name: "Bob", status_code: "awaiting_signature", signed_at: null },
      ],
    },
  });
  assert.equal(dropbox?.ref, "ds-1");
  assert.equal(dropbox?.signers.length, 1);
  assert.equal(dropbox?.signers[0].email, "seller@example.org");
  assert.equal(dropbox?.signers[0].signedAt?.toISOString(), new Date(1700000000 * 1000).toISOString());
  assert.equal(dropbox?.allSigned, false);
  // The test event Dropbox Sign sends on setup names no request.
  assert.equal(dropboxSignEvent({ event: { event_type: "callback_test" } }), null);
  const recipient = docuSignEvent({ event: "recipient-completed", generatedDateTime: "2026-11-08T10:00:00Z", data: { envelopeId: "env-1", recipientId: "2" } });
  assert.deepEqual(recipient?.signers, [{ index: 1, signedAt: new Date("2026-11-08T10:00:00Z") }]);
  const summary = docuSignEvent({
    event: "envelope-declined",
    data: { envelopeId: "env-2", envelopeSummary: { recipients: { signers: [{ email: "b@example.org", name: "B", recipientId: "2", status: "declined", declinedReason: "Wrong price" }] } } },
  });
  assert.equal(summary?.declined, true);
  assert.equal(summary?.signers[0].declineReason, "Wrong price");
  assert.equal(summary?.signers[0].index, 1);
  const signers = readSigners([{ role: "SELLER", name: "S", email: "s@x", signedAt: "2026-11-08T00:00:00Z" }, { role: "BUYER", name: "B", email: "b@x" }, "junk"]);
  assert.equal(signers.length, 2);
  assert.equal(requestStatus(signers), "PARTIAL");
  assert.equal(requestStatus(signers.map((signer) => ({ ...signer, signedAt: "2026-11-08T00:00:00Z" }))), "SIGNED");
  assert.equal(requestStatus([signers[0], { ...signers[1], declinedAt: "2026-11-08T00:00:00Z" }]), "DECLINED");
  assert.equal(signHours(null), 48);
  assert.equal(signHours(2), 2);
  assert.equal(signHours(0), 48);
  assert.equal(signHours(10_000), 48);
  const sentAt = new Date("2026-11-08T00:00:00Z");
  const clocked = { status: "SENT", sentAt, dueAt: new Date(sentAt.getTime() + 48 * HOUR), remindedAt: null };
  assert.equal(reminderDue(clocked, new Date(sentAt.getTime() + 23 * HOUR)), false);
  assert.equal(reminderDue(clocked, new Date(sentAt.getTime() + 24 * HOUR)), true);
  assert.equal(reminderDue({ ...clocked, remindedAt: sentAt }, new Date(sentAt.getTime() + 24 * HOUR)), false);
  assert.equal(reminderDue(clocked, new Date(sentAt.getTime() + 48 * HOUR)), false);
});

// ---------------------------------------------------------------------------------------------------------------
// A desk member, a seller, a buyer and a stranger on one open closing, tagged so nothing seeded is touched.

async function makeClosing() {
  const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN", name: string) =>
    prisma.user.create({ data: { email: `c-esign-${prefix}-${tag}@example.org`, name, role, accountStatus: "APPROVED", passwordHash: "x" } });
  const desk = await person("desk", "ADMIN", `Desk ${tag}`);
  const seller = await person("seller", "INDIVIDUAL_SELLER", `Seller ${tag}`);
  const buyer = await person("buyer", "BUYER", `Buyer ${tag}`);
  const stranger = await person("stranger", "BUYER", `Stranger ${tag}`);
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "APPROVED",
      approvedAt: new Date(),
      title: `E-sign ${tag}`,
      notes: {
        create: [{
          streetAddress: "1 Sign St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000,
        }] as never,
      },
    },
  });
  const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 100000, message: "E-sign bid" } });
  const closing = await openClosing({ listingId: listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 100000, title: listing.title });
  const users = [desk, seller, buyer, stranger];
  return { tag, desk, seller, buyer, stranger, listing, inquiry, closing, users };
}

type Fixture = Awaited<ReturnType<typeof makeClosing>>;

async function clean(fixture: Fixture) {
  const userIds = fixture.users.map((user) => user.id);
  const closingIds = [fixture.closing.id];
  await prisma.signatureRequest.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [fixture.listing.id, fixture.inquiry.id, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: fixture.listing.id }, { inquiryId: fixture.inquiry.id }, { closingId: { in: closingIds } }] } });
  await prisma.closing.deleteMany({ where: { id: { in: closingIds } } });
  await prisma.listing.deleteMany({ where: { id: fixture.listing.id } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: fixture.users.map((user) => user.email) } }, { subject: { contains: literal(fixture.tag) } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await fs.rm(path.join(uploadDir(), "signatures", fixture.closing.id), { recursive: true, force: true });
}

async function noticesTo(email: string, subject: string) {
  return prisma.notification.count({ where: { toEmail: email, subject: { contains: literal(subject) } } });
}

test("the desk sends the purchase agreement in the app, each party signs their own line, and the last signature completes the step", async () => {
  const fixture = await makeClosing();
  try {
    const now = new Date();
    const hours = signHours((await getSettings()).psaSignHours);
    const sent = await sendForSignatures(fixture.closing.id, "PSA", fixture.desk, now);
    assert.equal(sent.error, null);
    if (sent.error !== null) return;
    const { request } = sent;
    assert.equal(request.provider, "in_app");
    assert.equal(request.status, "SENT");
    assert.equal(request.dueAt?.getTime(), now.getTime() + hours * HOUR);
    assert.match(request.documentHash, /^[0-9a-f]{64}$/);
    const signers = readSigners(request.signers);
    assert.deepEqual(signers.map((signer) => [signer.role, signer.userId, signer.email]), [
      ["SELLER", fixture.seller.id, fixture.seller.email],
      ["BUYER", fixture.buyer.id, fixture.buyer.email],
    ]);
    assert.ok(signers.every((signer) => signer.name));
    assert.equal(await noticesTo(fixture.buyer.email, "Sign the purchase agreement"), 1);
    assert.equal(await noticesTo(fixture.seller.email, "Sign the purchase agreement"), 1);
    // The copy a party opens is the one sent, byte for byte. Someone off the closing gets nothing.
    const copy = await sentCopy(fixture.closing.id, request.id, fixture.buyer);
    assert.ok(copy?.allowed);
    if (copy?.allowed) assert.equal(documentHash(copy.pdf), request.documentHash);
    assert.deepEqual(await sentCopy(fixture.closing.id, request.id, fixture.stranger), { allowed: false });

    // A name and consent are both needed.
    const at = new Date(now.getTime() + HOUR);
    assert.match((await signRequest(request.id, fixture.seller, { name: "Sally Seller", consent: false, ip: "203.0.113.5" }, at)).error ?? "", /agree to sign electronically/);
    assert.match((await signRequest(request.id, fixture.seller, { name: " ", consent: true, ip: "203.0.113.5" }, at)).error ?? "", /full legal name/);
    const first = await signRequest(request.id, fixture.seller, { name: "  Sally   Seller ", consent: true, ip: "203.0.113.5" }, at);
    assert.deepEqual(first, { error: null, status: "PARTIAL" });
    assert.match((await signRequest(request.id, fixture.seller, { name: "Sally Seller", consent: true, ip: "203.0.113.5" }, at)).error ?? "", /already answered/);
    const partial = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(partial.status, "PARTIAL");
    const sellerLine = readSigners(partial.signers)[0];
    assert.equal(sellerLine.signedName, "Sally Seller");
    assert.equal(sellerLine.ip, "203.0.113.5");
    assert.equal(sellerLine.signedAt, at.toISOString());
    const pending = await prisma.closingStep.findFirstOrThrow({ where: { closingId: fixture.closing.id, key: "PURCHASE_AGREEMENT" } });
    assert.equal(pending.status, "PENDING");

    const last = await signRequest(request.id, fixture.buyer, { name: "Bob Buyer", consent: true, ip: "198.51.100.7" }, at);
    assert.deepEqual(last, { error: null, status: "SIGNED" });
    const done = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(done.status, "SIGNED");
    assert.equal(done.completedAt?.getTime(), at.getTime());
    const step = await prisma.closingStep.findFirstOrThrow({ where: { closingId: fixture.closing.id, key: "PURCHASE_AGREEMENT" } });
    assert.equal(step.status, "COMPLETE");
    assert.match(step.note, /Signed electronically by every party/);
    // The same audit the desk's form writes, which the deal timeline reads, and the parties' notice.
    assert.equal(await prisma.auditEvent.count({ where: { action: "CLOSING", entityId: fixture.closing.id, detail: "PURCHASE_AGREEMENT", actorId: fixture.buyer.id } }), 1);
    assert.equal(await noticesTo(fixture.seller.email, `Closing · ${fixture.listing.title}`), 1);
    assert.equal(await noticesTo(fixture.buyer.email, `Closing · ${fixture.listing.title}`), 1);
    // A signed request takes nothing more.
    assert.match((await signRequest(request.id, fixture.buyer, { name: "Bob Buyer", consent: true, ip: "198.51.100.7" }, at)).error ?? "", /Every party has signed/);
  } finally {
    await clean(fixture);
  }
});

test("only a named party signs their own line, and sending again or voiding closes the open copy", async () => {
  const fixture = await makeClosing();
  try {
    const now = new Date();
    // Only the closings desk sends.
    assert.match((await sendForSignatures(fixture.closing.id, "PSA", fixture.seller, now)).error ?? "", /closings desk/);
    const first = await sendForSignatures(fixture.closing.id, "PSA", fixture.desk, now);
    assert.equal(first.error, null);
    if (first.error !== null) return;
    const at = new Date(now.getTime() + HOUR);
    for (const outsider of [fixture.stranger, fixture.desk]) {
      assert.match((await signRequest(first.request.id, outsider, { name: "Not A Party", consent: true, ip: "192.0.2.1" }, at)).error ?? "", /Only the parties named/);
      assert.match((await declineRequest(first.request.id, outsider, "Not mine to sign", at)).error ?? "", /Only the parties named/);
    }
    const untouched = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: first.request.id } });
    assert.equal(untouched.status, "SENT");
    assert.ok(readSigners(untouched.signers).every((signer) => !signer.signedAt));

    const second = await sendForSignatures(fixture.closing.id, "PSA", fixture.desk, new Date(now.getTime() + 1000));
    assert.equal(second.error, null);
    if (second.error !== null) return;
    assert.equal(second.replaced, 1);
    const voided = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: first.request.id } });
    assert.equal(voided.status, "VOIDED");
    assert.equal(voided.voidReason, "Sent again.");
    assert.equal(await prisma.signatureRequest.count({ where: { closingId: fixture.closing.id, kind: "PSA", status: { in: ["SENT", "PARTIAL"] } } }), 1);
    assert.match((await signRequest(first.request.id, fixture.seller, { name: "Sally Seller", consent: true, ip: "192.0.2.1" }, at)).error ?? "", /withdrew this request/);

    assert.match((await voidRequest(second.request.id, fixture.closing.id, fixture.desk, "no")).error ?? "", /Say why/);
    assert.match((await voidRequest(second.request.id, fixture.closing.id, fixture.buyer, "Wrong form")).error ?? "", /closings desk/);
    assert.equal((await voidRequest(second.request.id, fixture.closing.id, fixture.desk, "Wrong loan schedule")).error, null);
    const after = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: second.request.id } });
    assert.equal(after.status, "VOIDED");
    assert.equal(after.voidReason, "Wrong loan schedule");
    assert.equal(await noticesTo(fixture.buyer.email, "Signature request withdrawn"), 1);
    assert.match((await voidRequest(second.request.id, fixture.closing.id, fixture.desk, "Again")).error ?? "", /already finished/);
  } finally {
    await clean(fixture);
  }
});

test("a decline closes the request for everyone and tells the desk, and the closing stays open", async () => {
  const fixture = await makeClosing();
  try {
    const now = new Date();
    const sent = await sendForSignatures(fixture.closing.id, "PSA", fixture.desk, now);
    assert.equal(sent.error, null);
    if (sent.error !== null) return;
    const at = new Date(now.getTime() + HOUR);
    assert.match((await declineRequest(sent.request.id, fixture.buyer, "no", at)).error ?? "", /Say why/);
    assert.deepEqual(await declineRequest(sent.request.id, fixture.buyer, "The price on page one is wrong.", at), { error: null, status: "DECLINED" });
    const row = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: sent.request.id } });
    assert.equal(row.status, "DECLINED");
    const line = readSigners(row.signers).find((signer) => signer.userId === fixture.buyer.id);
    assert.equal(line?.declinedAt, at.toISOString());
    assert.equal(line?.declineReason, "The price on page one is wrong.");
    assert.equal(await noticesTo(fixture.desk.email, `Signature declined · ${fixture.listing.title}`), 1);
    assert.equal(await noticesTo(fixture.seller.email, `Signature declined · ${fixture.listing.title}`), 1);
    assert.match((await signRequest(sent.request.id, fixture.seller, { name: "Sally Seller", consent: true, ip: "192.0.2.1" }, at)).error ?? "", /declined this request/);
    const closing = await prisma.closing.findUniqueOrThrow({ where: { id: fixture.closing.id } });
    assert.equal(closing.status, "OPEN");
    const step = await prisma.closingStep.findFirstOrThrow({ where: { closingId: fixture.closing.id, key: "PURCHASE_AGREEMENT" } });
    assert.equal(step.status, "PENDING");

    // A corrected copy goes out, then the closing is canceled: the copy is void at once and nobody signs it.
    const again = await sendForSignatures(fixture.closing.id, "PSA", fixture.desk, at);
    assert.equal(again.error, null);
    if (again.error !== null) return;
    await cancelOpenClosing(fixture.closing.id, "Test cancel with papers out.");
    const voided = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: again.request.id } });
    assert.equal(voided.status, "VOIDED");
    assert.equal(voided.voidReason, "Closing canceled");
    assert.equal(await prisma.auditEvent.count({ where: { action: "SIGNATURE_VOIDED", entityId: fixture.closing.id, detail: "PSA: Closing canceled" } }), 1);
    // The cancel notice tells the parties; the void sends nothing more.
    assert.equal(await noticesTo(fixture.seller.email, "Signature request withdrawn"), 0);
    assert.match((await signRequest(again.request.id, fixture.seller, { name: "Sally Seller", consent: true, ip: "192.0.2.1" }, at)).error ?? "", /withdrew this request/);
    assert.match((await sendForSignatures(fixture.closing.id, "PSA", fixture.desk, at)).error ?? "", /already finished/);
    assert.equal((await signatureClock(new Date(at.getTime() + 60_000), { closingIds: [fixture.closing.id] })).sent, 0);
  } finally {
    await clean(fixture);
  }
});

test("the clock reminds the parties still to sign once at half time, and expires the request at its due time", async () => {
  const fixture = await makeClosing();
  try {
    const start = new Date();
    const sent = await sendForSignatures(fixture.closing.id, "PSA", fixture.desk, start);
    assert.equal(sent.error, null);
    if (sent.error !== null) return;
    const window = (sent.request.dueAt!.getTime() - start.getTime()) / 2;
    assert.equal((await signRequest(sent.request.id, fixture.seller, { name: "Sally Seller", consent: true, ip: "192.0.2.1" }, new Date(start.getTime() + 60_000))).error, null);
    const scope = { closingIds: [fixture.closing.id] };
    assert.equal((await signatureClock(new Date(start.getTime() + window - 60_000), scope)).sent, 0);
    const half = new Date(start.getTime() + window + 60_000);
    assert.equal((await signatureClock(half, scope)).sent, 1);
    assert.equal((await signatureClock(half, scope)).sent, 0);
    assert.equal((await prisma.signatureRequest.findUniqueOrThrow({ where: { id: sent.request.id } })).remindedAt?.getTime(), half.getTime());
    // Only the party still to sign hears.
    assert.equal(await noticesTo(fixture.buyer.email, "Reminder: sign the purchase agreement"), 1);
    assert.equal(await noticesTo(fixture.seller.email, "Reminder: sign the purchase agreement"), 0);

    const late = new Date(sent.request.dueAt!.getTime() + 60_000);
    // Past the due time, before the job has run, signing is already closed.
    assert.match((await signRequest(sent.request.id, fixture.buyer, { name: "Bob Buyer", consent: true, ip: "192.0.2.1" }, late)).error ?? "", /time to sign has run out/);
    const run = await signatureClock(late, scope);
    assert.equal(run.sent, 1);
    assert.equal(run.failed, 0);
    assert.equal((await signatureClock(late, scope)).sent, 0);
    const expired = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: sent.request.id } });
    assert.equal(expired.status, "EXPIRED");
    assert.equal(await noticesTo(fixture.desk.email, `Signature time ran out · ${fixture.listing.title}`), 1);
    // The closing isn't canceled; the desk decides what comes next.
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: fixture.closing.id } })).status, "OPEN");
  } finally {
    await clean(fixture);
  }
});

test("an award sends the purchase agreement on its own, once, and a send that can't go tells the desk without failing", async () => {
  const fixture = await makeClosing();
  const deskBid = await prisma.deskBid.create({ data: { listingId: fixture.listing.id, amount: 90000, status: "ACCEPTED" } });
  let deskClosingId = "";
  try {
    const now = new Date();
    const sent = await sendOnAward(fixture.closing.id, { now });
    assert.ok(sent);
    assert.equal(sent?.createdById ?? null, null);
    assert.equal(sent?.status, "SENT");
    assert.equal(sent?.dueAt?.getTime(), now.getTime() + signHours((await getSettings()).psaSignHours) * HOUR);
    assert.deepEqual(readSigners(sent?.signers).map((signer) => signer.role), ["SELLER", "BUYER"]);
    const logged = await prisma.auditEvent.findFirstOrThrow({ where: { action: "SIGNATURE_SENT", entityId: fixture.closing.id } });
    assert.equal(logged.actorId, null);
    assert.match(logged.detail, /^Sent automatically at the award\./);
    assert.equal(await noticesTo(fixture.buyer.email, "Sign the purchase agreement"), 1);
    // A second award path on the same closing sends nothing more.
    assert.equal(await sendOnAward(fixture.closing.id), null);
    assert.equal(await prisma.signatureRequest.count({ where: { closingId: fixture.closing.id } }), 1);

    // A desk purchase with no deal owner has no one to sign for the desk, so the desk hears and nothing breaks.
    const deskClosing = await openClosing({ listingId: fixture.listing.id, deskBidId: deskBid.id, noteId: null, salePrice: 90000, title: fixture.listing.title });
    deskClosingId = deskClosing.id;
    assert.equal(await sendOnAward(deskClosing.id), null);
    assert.equal(await prisma.signatureRequest.count({ where: { closingId: deskClosing.id } }), 0);
    assert.equal(await noticesTo(fixture.desk.email, `Purchase agreement not sent · ${fixture.listing.title}`), 1);
    // Named, the desk member taking the bid signs as the buyer.
    const desk = await sendOnAward(deskClosing.id, { deskSignerId: fixture.desk.id });
    assert.deepEqual(readSigners(desk?.signers).map((signer) => [signer.role, signer.userId]), [["SELLER", fixture.seller.id], ["DESK", fixture.desk.id]]);
  } finally {
    if (deskClosingId) {
      await prisma.signatureRequest.deleteMany({ where: { closingId: deskClosingId } });
      await prisma.auditEvent.deleteMany({ where: { entityId: deskClosingId } });
      await prisma.deskThread.deleteMany({ where: { closingId: deskClosingId } });
      await prisma.closing.deleteMany({ where: { id: deskClosingId } });
      await fs.rm(path.join(uploadDir(), "signatures", deskClosingId), { recursive: true, force: true });
    }
    await prisma.deskBid.deleteMany({ where: { id: deskBid.id } });
    await clean(fixture);
  }
});

test("a verified vendor event marks each line once by its envelope, and the webhook refuses anything unverified", async () => {
  const fixture = await makeClosing();
  const saved = process.env.DROPBOX_SIGN_API_KEY;
  try {
    // A request a vendor holds, written directly so no envelope is sent.
    const ref = `c-esign-ref-${fixture.tag}`;
    const request = await prisma.signatureRequest.create({
      data: {
        closingId: fixture.closing.id,
        kind: "PSA",
        provider: "dropbox-sign",
        providerRef: ref,
        signers: [
          { role: "SELLER", userId: fixture.seller.id, name: "Seller LLC", email: fixture.seller.email },
          { role: "BUYER", userId: fixture.buyer.id, name: "Buyer Fund", email: fixture.buyer.email },
        ],
        documentHash: "0".repeat(64),
        dueAt: new Date(Date.now() + 48 * HOUR),
        createdById: fixture.desk.id,
      },
    });
    // In-app signing is closed on a vendor's envelope.
    assert.match((await signRequest(request.id, fixture.seller, { name: "Sally Seller", consent: true, ip: "192.0.2.1" })).error ?? "", /email Dropbox Sign sent you/);
    const payload = (statuses: [string, string]) => ({
      event: { event_time: "1700000000", event_type: "signature_request_signed" },
      signature_request: {
        signature_request_id: ref,
        signatures: [
          { signer_email_address: fixture.seller.email.toUpperCase(), signer_name: "Sally Seller", status_code: statuses[0], signed_at: 1700000000 },
          { signer_email_address: fixture.buyer.email, signer_name: "Bob Buyer", status_code: statuses[1], signed_at: statuses[1] === "signed" ? 1700000100 : null },
        ],
      },
    });
    const once = await applyVendorEvent(dropboxSignEvent(payload(["signed", "awaiting_signature"]))!);
    assert.deepEqual(once, { matched: true, status: "PARTIAL" });
    // A replay changes nothing.
    assert.deepEqual(await applyVendorEvent(dropboxSignEvent(payload(["signed", "awaiting_signature"]))!), { matched: true, status: "PARTIAL" });
    const partial = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(readSigners(partial.signers)[0].signedAt, new Date(1700000000 * 1000).toISOString());
    assert.equal(await prisma.auditEvent.count({ where: { action: "SIGNATURE_SIGNED", entityId: fixture.closing.id } }), 1);
    assert.deepEqual(await applyVendorEvent({ ...dropboxSignEvent(payload(["signed", "signed"]))!, ref: "someone-elses-envelope" }), { matched: false, status: null });

    // Through the route: an event signed with the wrong key is refused, the right one is acknowledged.
    process.env.DROPBOX_SIGN_API_KEY = `c-esign-key-${fixture.tag}`;
    const { POST } = await import("../app/api/esign/webhook/route");
    const post = (body: unknown, key: string) => {
      const event = (body as { event: { event_time: string; event_type: string } }).event;
      const form = new FormData();
      form.set("json", JSON.stringify({ ...(body as object), event: { ...event, event_hash: dropboxSignHash(event.event_time, event.event_type, key) } }));
      return POST(new Request("http://localhost/api/esign/webhook", { method: "POST", body: form }));
    };
    const all = { ...payload(["signed", "signed"]), event: { event_time: "1700000100", event_type: "signature_request_all_signed" } };
    const refused = await post(all, "the-wrong-key");
    assert.equal(refused.status, 401);
    assert.equal((await prisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id } })).status, "PARTIAL");
    const docusignForged = await POST(new Request("http://localhost/api/esign/webhook", { method: "POST", headers: { "X-DocuSign-Signature-1": "Zm9yZ2Vk" }, body: "{}" }));
    assert.equal(docusignForged.status, 401);
    const accepted = await post(all, process.env.DROPBOX_SIGN_API_KEY);
    assert.equal(accepted.status, 200);
    assert.equal(await accepted.text(), "Hello API Event Received");
    const signed = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(signed.status, "SIGNED");
    assert.equal(readSigners(signed.signers)[1].signedName, "Bob Buyer");
    assert.equal((await prisma.closingStep.findFirstOrThrow({ where: { closingId: fixture.closing.id, key: "PURCHASE_AGREEMENT" } })).status, "COMPLETE");
    // Delivered twice, it completes once.
    assert.equal((await post(all, process.env.DROPBOX_SIGN_API_KEY)).status, 200);
    assert.equal(await prisma.auditEvent.count({ where: { action: "SIGNATURE_COMPLETE", entityId: fixture.closing.id } }), 1);
  } finally {
    process.env.DROPBOX_SIGN_API_KEY = saved;
    await clean(fixture);
  }
});
