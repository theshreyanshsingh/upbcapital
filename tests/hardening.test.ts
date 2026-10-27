import assert from "node:assert/strict";
import test from "node:test";
import { canReadClosingFile, canReadDocument, canReadProof, closingAccess, isPrivateDocument, shouldApplyReferralCredit } from "../lib/acl";
import { fillTemplate } from "../lib/closing-docs";
import { parseKycWebhook } from "../lib/vendors";
import { consumeRateLimit, limitStore, rateLimit, resetRateLimits } from "../lib/rate-limit";
import { hashRecoveryCode, newRecoveryCodes, packHashes, takeRecoveryCode } from "../lib/recovery";
import { attachmentName, uploadProblem } from "../lib/uploads";
import { prisma } from "../lib/prisma";

test("recovery codes are single use", () => {
  const codes = newRecoveryCodes(2);
  assert.equal(codes.length, 2);
  const packed = packHashes(codes);
  const left = takeRecoveryCode(packed, codes[0]);
  assert.ok(left != null);
  assert.equal(takeRecoveryCode(left, codes[0]), null);
  assert.equal(takeRecoveryCode(left, codes[1]) != null, true);
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toLowerCase()));
});

test("closing form tokens fill and unknown tokens drop", () => {
  assert.equal(fillTemplate("Pay {{buyer}} {{missing}}", { buyer: "Ortiz" }), "Pay Ortiz ");
});

test("download names and uploads reject the wrong bytes", () => {
  assert.equal(attachmentName('note\r\n".pdf'), "note_.pdf");
  assert.equal(uploadProblem("file.exe", 10, Buffer.from("hello")), "That file type is not accepted.");
  assert.equal(uploadProblem("note.pdf", 8, Buffer.from("not a pdf")), "The file contents do not match its type.");
  assert.equal(uploadProblem("note.pdf", 8, Buffer.from("%PDF-1.4")), null);
});

test("file access stays with the parties", () => {
  assert.equal(canReadProof({ id: "a", role: "BUYER" }, "b"), false);
  assert.equal(canReadProof({ id: "a", role: "ADMIN" }, "b"), true);
  assert.equal(canReadClosingFile({ role: "BUYER", userId: "b", sellerId: "s", buyerId: "b" }), true);
  assert.equal(canReadClosingFile({ role: "BUYER", userId: "x", sellerId: "s", buyerId: "b" }), false);
  assert.equal(canReadDocument({ owner: false, admin: false, ownNda: false, privateFile: false, proBuyer: true, signedNda: false, listingVisible: true }), false);
  assert.equal(canReadDocument({ owner: false, admin: false, ownNda: true, privateFile: true, proBuyer: false, signedNda: false, listingVisible: false }), true);
});

test("signed NDAs and the seller authorization stay out of the data room", () => {
  const broker = { authorizationKey: "auth-letter.pdf" };
  assert.equal(isPrivateDocument({ type: "NDA", storedName: "ndas/u/l.pdf" }, { authorizationKey: "" }), true);
  assert.equal(isPrivateDocument({ type: "OTHER", storedName: "auth-letter.pdf" }, broker), true);
  assert.equal(isPrivateDocument({ type: "OTHER", storedName: "photos.pdf" }, broker), false);
  assert.equal(isPrivateDocument({ type: "OTHER", storedName: "" }, { authorizationKey: "" }), false);
  const proBuyer = { owner: false, admin: false, ownNda: false, proBuyer: true, signedNda: true, listingVisible: true };
  assert.equal(canReadDocument({ ...proBuyer, privateFile: false }), true);
  assert.equal(canReadDocument({ ...proBuyer, privateFile: true }), false);
  assert.equal(canReadDocument({ ...proBuyer, privateFile: true, owner: true }), true);
  assert.equal(canReadDocument({ ...proBuyer, privateFile: true, admin: true }), true);
});

test("a referrer follows a closing only as an approved broker", () => {
  const closing = { sellerId: "s", buyerId: "b", funderIds: ["f"], brokerId: null, buyerReferrerId: "r" };
  assert.equal(closingAccess({ ...closing, role: "BUYER", accountStatus: "APPROVED", userId: "b" }), "party");
  assert.equal(closingAccess({ ...closing, role: "BUYER", accountStatus: "APPROVED", userId: "f" }), "party");
  assert.equal(closingAccess({ ...closing, role: "BROKER", accountStatus: "APPROVED", userId: "r" }), "observer");
  assert.equal(closingAccess({ ...closing, role: "BUYER", accountStatus: "APPROVED", userId: "r" }), null);
  assert.equal(closingAccess({ ...closing, role: "BROKER", accountStatus: "REJECTED", userId: "r" }), null);
  assert.equal(closingAccess({ ...closing, role: "BROKER", accountStatus: "APPROVED", userId: "x" }), null);
  assert.equal(closingAccess({ ...closing, brokerId: "s", role: "BROKER", accountStatus: "PENDING", userId: "s" }), "party");
});

test("a referral credit is a Stripe coupon only when one is banked", () => {
  assert.equal(shouldApplyReferralCredit(0), false);
  assert.equal(shouldApplyReferralCredit(2), true);
});

test("kyc webhook reads a flat status and a persona inquiry", () => {
  assert.equal(parseKycWebhook({ userId: "u1", reference: "inq", status: "approved" })?.status, "APPROVED");
  const persona = parseKycWebhook({
    data: { attributes: { payload: { data: { id: "inq_1", attributes: { status: "completed", "reference-id": "u1" } } } } },
  });
  assert.equal(persona?.reference, "inq_1");
  assert.equal(persona?.status, "APPROVED");
  assert.equal(parseKycWebhook({ nope: true }), null);
});

test("limits use memory or the database from the env", async () => {
  const previous = process.env.RATE_LIMIT_STORE;
  process.env.RATE_LIMIT_STORE = "memory";
  resetRateLimits();
  assert.equal(limitStore(), "memory");
  assert.equal(await consumeRateLimit("mem-desk", 1, 1000, 0), true);
  assert.equal(await consumeRateLimit("mem-desk", 1, 1000, 10), false);
  assert.equal(rateLimit("other", 1, 1000, 0), true);
  process.env.RATE_LIMIT_STORE = "postgres";
  assert.equal(limitStore(), "database");
  process.env.RATE_LIMIT_STORE = "database";
  const key = `harden-${Date.now()}`;
  assert.equal(await consumeRateLimit(key, 1, 60_000), true);
  assert.equal(await consumeRateLimit(key, 1, 60_000), false);
  await prisma.rateWindow.deleteMany({ where: { key: { startsWith: key } } });
  process.env.RATE_LIMIT_STORE = previous;
});
