import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import { CLOSING_STEPS, canCompleteStep, closingTotals } from "../lib/closing";
import { simulatedCheckout, stripeConfigured } from "../lib/billing";
import { getEscrowProvider } from "../lib/escrow";
import { deskRecipients, resolveMailTransport } from "../lib/mail-config";
import { feeBreakdown } from "../lib/money";
import { buildNdaPdf, pngFromDataUrl } from "../lib/nda-pdf";
import { canCounter, threadLabel, workingAmount } from "../lib/offers";
import { assertStorageKey, storageMode } from "../lib/storage";
import { priceNeedsReplace } from "../lib/stripe-sync";
import { canSubmitOffer } from "../lib/verification";

test("fee math keeps premium on top and commission off the seller", () => {
  const fees = feeBreakdown(168000, 250, 300);
  assert.equal(fees.premiumCents, 420000);
  assert.equal(fees.commissionCents, 504000);
  assert.equal(fees.buyerTotalCents, 16800000 + 420000);
  assert.equal(fees.netToSellerCents, 16800000 - 504000);
  assert.deepEqual(closingTotals(168000, 250, 300).buyerTotalCents, fees.buyerTotalCents);
});

test("a closing cannot be marked closed while a step is open", () => {
  const steps = CLOSING_STEPS.map((step) => ({ key: step.key, status: step.key === "ASSIGNMENT" ? "PENDING" : "COMPLETE" }));
  assert.equal(canCompleteStep(steps, "PAYMENT_RECEIVED"), true);
  assert.equal(canCompleteStep(steps, "CLOSED"), false);
  assert.equal(canCompleteStep(steps.map((step) => ({ ...step, status: "COMPLETE" })), "CLOSED"), true);
});

test("offers use the latest counter and stay closed once decided", () => {
  const created = new Date("2026-01-01");
  const later = new Date("2026-02-01");
  const amount = workingAmount(100, [
    { kind: "OFFER", amount: 100, createdAt: created },
    { kind: "COUNTER", amount: 120, createdAt: later },
  ]);
  assert.equal(amount, 120);
  assert.equal(canCounter("OPEN"), true);
  assert.equal(canCounter("ACCEPTED"), false);
  assert.equal(threadLabel("OPEN", [{ kind: "COUNTER", amount: 120, createdAt: later }]), "Counter open");
});

test("offers require an approved buyer file", () => {
  assert.equal(canSubmitOffer({ role: "BUYER", accountStatus: "APPROVED", verificationStatus: "SUBMITTED" }).ok, false);
  assert.equal(canSubmitOffer({ role: "BUYER", accountStatus: "APPROVED", verificationStatus: "APPROVED" }).ok, true);
  assert.equal(canSubmitOffer({ role: "BUYER", accountStatus: "PENDING", verificationStatus: "APPROVED" }).ok, false);
});

test("mail, storage, and stripe price decisions follow env", () => {
  assert.equal(resolveMailTransport({}), "log");
  assert.equal(resolveMailTransport({ RESEND_API_KEY: "re_test", EMAIL_FROM: "desk@example.com" }), "resend");
  assert.equal(resolveMailTransport({ SMTP_HOST: "smtp.example.com", EMAIL_FROM: "desk@example.com" }), "smtp");
  assert.deepEqual(deskRecipients(["ops@example.com", "lead@example.com"]), ["ops@example.com", "lead@example.com"]);
  assert.deepEqual(deskRecipients(["ops@example.com"], " Ops@Example.com "), ["ops@example.com"]);
  assert.deepEqual(deskRecipients(["ops@example.com"], "desk@example.com"), ["ops@example.com", "desk@example.com"]);
  assert.deepEqual(deskRecipients([], ""), []);
  assert.equal(storageMode({}), "local");
  assert.equal(storageMode({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" }), "s3");
  assert.equal(storageMode({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test" }), "blob");
  assert.equal(storageMode({ BLOB_STORE_ID: "store_test", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" }), "s3");
  assert.equal(priceNeedsReplace(null, 24900), true);
  assert.equal(priceNeedsReplace({ unitAmount: 24900, currency: "usd", active: true, interval: "month" }, 24900), false);
  assert.equal(priceNeedsReplace({ unitAmount: 19900, currency: "usd", active: true, interval: "month" }, 24900), true);
  assert.throws(() => assertStorageKey("../etc/passwd"));
});

test("Pro checkout uses the saved price and never simulates once Stripe is set", () => {
  const previous = { secret: process.env.STRIPE_SECRET_KEY, price: process.env.STRIPE_PRO_PRICE_ID };
  delete process.env.STRIPE_PRO_PRICE_ID;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(simulatedCheckout(), true);
  assert.equal(stripeConfigured("price_saved"), false);
  process.env.STRIPE_SECRET_KEY = "sk_test_example";
  assert.equal(simulatedCheckout(), false);
  assert.equal(stripeConfigured(""), false);
  assert.equal(stripeConfigured("price_saved"), true);
  process.env.STRIPE_PRO_PRICE_ID = "price_env";
  assert.equal(stripeConfigured(""), true);
  for (const [key, value] of [["STRIPE_SECRET_KEY", previous.secret], ["STRIPE_PRO_PRICE_ID", previous.price]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a signed NDA pdf records the signer", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  assert.ok(pngFromDataUrl(dataUrl));
  assert.equal(pngFromDataUrl("data:image/jpeg;base64,aaaa"), null);
  const pdf = await buildNdaPdf({
    listingTitle: "First-lien performing · Miami",
    listingId: "listing_test",
    signerName: "Camille Ortiz",
    signerEmail: "camille.ortiz@upbcapital.test",
    method: "TYPED",
    signedAt: new Date("2026-10-18T15:00:00.000Z"),
    ipAddress: "203.0.113.10",
    userAgent: "Test",
  });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const raw = pdf.toString("latin1");
  const chunks = [raw];
  for (const match of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    try {
      chunks.push(inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"));
    } catch {
      // not a flate stream
    }
  }
  const text = chunks
    .join("\n")
    .replace(/<([0-9A-Fa-f\s]+)>/g, (_, hex: string) => Buffer.from(hex.replace(/\s/g, ""), "hex").toString("latin1"));
  assert.match(text, /Camille Ortiz/);
  assert.match(text, /203\.0\.113\.10/);
});

test("manual escrow returns wire copy and a stable provider id", async () => {
  const opened = await getEscrowProvider("manual").open({
    closingId: "cls_test",
    listingTitle: "Sample",
    salePrice: 1000,
    buyerTotalCents: 102500,
    netToSellerCents: 97000,
    wireInstructions: "Bank of Fiction\nReference cls_test",
  });
  assert.equal(opened.provider, "manual");
  assert.match(opened.instructions, /Bank of Fiction/);
});
