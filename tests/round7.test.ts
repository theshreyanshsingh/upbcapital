import assert from "node:assert/strict";
import test from "node:test";
import { showsOriginationReminder, retentionCutoff } from "@/lib/compliance";
import { deskFeeBps } from "@/lib/desk-fees";
import { digestBody, digestSince } from "@/lib/digest";
import { screenOfac } from "@/lib/ofac";
import { modelParticipation } from "@/lib/participation";

test("desk fees can be waived", () => {
  assert.deepEqual(deskFeeBps(false, 250, 300), { premiumBps: 0, commissionBps: 0 });
  assert.deepEqual(deskFeeBps(true, 250, 300), { premiumBps: 250, commissionBps: 300 });
});

test("a participation splits percent and payment streams", () => {
  const percent = modelParticipation({
    basis: 100000,
    upb: 140000,
    annualRate: 8,
    monthlyPi: 1100,
    termMonths: 360,
    percent: 40,
    paymentCount: null,
    slicePrice: 40000,
  });
  assert.ok(percent);
  assert.equal(percent.mode, "percent");
  assert.ok(percent.buyerMonthly > 0 && percent.sellerMonthly > 0);
  assert.ok(percent.buyerIrr == null || Number.isFinite(percent.buyerIrr));
  const stream = modelParticipation({
    basis: 100000,
    upb: 140000,
    annualRate: 8,
    monthlyPi: 1100,
    termMonths: 120,
    percent: 100,
    paymentCount: 12,
    slicePrice: 12000,
  });
  assert.ok(stream);
  assert.equal(stream.mode, "payments");
  assert.equal(modelParticipation({
    basis: 100000,
    upb: 140000,
    annualRate: 8,
    monthlyPi: 1100,
    termMonths: 120,
    percent: 40,
    paymentCount: null,
    slicePrice: 100000,
  }), null);
});

test("the OFAC list flags a planted or fuzzy name", () => {
  assert.equal(screenOfac("Jane Borrower").result, "CLEAR");
  assert.equal(screenOfac("Blocked Test Holdings").result, "REVIEW");
  assert.equal(screenOfac("Blokced Test").result, "REVIEW");
});

test("retention and origination reminders", () => {
  const cutoff = retentionCutoff(7, new Date("2026-10-18T00:00:00Z"));
  assert.equal(cutoff.toISOString().slice(0, 10), "2019-10-18");
  assert.equal(showsOriginationReminder({ sellerFinanced: false, sellerRole: "INDIVIDUAL_SELLER" }), true);
  assert.equal(showsOriginationReminder({ sellerFinanced: true, sellerRole: "INSTITUTIONAL_SELLER" }), true);
  assert.equal(showsOriginationReminder({ sellerFinanced: false, sellerRole: "INSTITUTIONAL_SELLER" }), false);
});

test("a digest waits out its window", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  assert.equal(digestSince("OFF", null, now), null);
  assert.equal(digestSince("WEEKLY", new Date("2026-10-16T00:00:00Z"), now), null);
  const since = digestSince("WEEKLY", new Date("2026-10-01T00:00:00Z"), now);
  assert.ok(since);
  assert.equal(since.toISOString().slice(0, 10), "2026-10-11");
  assert.equal(digestBody([]), "");
  assert.match(digestBody([{ title: "Naples first", score: 80 }]), /Naples first/);
});
