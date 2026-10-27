import assert from "node:assert/strict";
import test from "node:test";
import { assessBrokerFees, feeFromPool, feeMonths, payoutNoteProblem, type AssessInput } from "../lib/broker-fees";

const schedule = {
  brokerSchedule: { basis: "PERCENT" as const, bps: 2000, cents: 0 },
  affiliateSchedule: { basis: "PERCENT" as const, bps: 1000, cents: 0 },
};

function input(overrides: Partial<AssessInput> = {}): AssessInput {
  return {
    premiumCents: 4000,
    commissionCents: 6000,
    sellerId: "seller",
    buyerId: "buyer",
    clientSellerName: "Helen Marsh",
    brokerName: "Nora Vale",
    deal: { brokerId: "nora", role: "SELLER_BROKER", terms: null },
    referrer: null,
    ...schedule,
    ...overrides,
  };
}

test("a broker fee is a percent of premium plus commission", () => {
  assert.equal(feeFromPool(10000, { basis: "PERCENT", bps: 2000, cents: 0 }), 2000);
  const result = assessBrokerFees(input());
  assert.deepEqual(result.fees, [{ brokerId: "nora", role: "SELLER_BROKER", amountCents: 2000, basis: "PERCENT" }]);
});

test("a flat fee ignores the pool and an override replaces the desk schedule", () => {
  const result = assessBrokerFees(input({
    deal: { brokerId: "nora", role: "SELLER_BROKER", terms: { basis: "FLAT", bps: 0, cents: 75000 } },
  }));
  assert.equal(result.fees[0]?.amountCents, 75000);
  assert.equal(result.fees[0]?.basis, "FLAT");
});

test("an affiliate introduction uses the affiliate schedule", () => {
  const result = assessBrokerFees(input({
    deal: { brokerId: "nora", role: "AFFILIATE", terms: null },
  }));
  assert.equal(result.fees[0]?.amountCents, 1000);
  assert.equal(result.fees[0]?.role, "AFFILIATE");
});

test("the same broker is not paid twice when they also referred the buyer", () => {
  const result = assessBrokerFees(input({
    referrer: { brokerId: "nora", terms: null },
  }));
  assert.equal(result.fees.length, 1);
  assert.match(result.withheld.join(" "), /already paid/);
});

test("a listing broker and a different referring affiliate are both paid", () => {
  const result = assessBrokerFees(input({
    referrer: { brokerId: "ada", terms: null },
  }));
  assert.deepEqual(result.fees.map((fee) => [fee.brokerId, fee.amountCents]), [
    ["nora", 2000],
    ["ada", 1000],
  ]);
});

test("no fee when the broker is the buyer or the named seller", () => {
  const buyer = assessBrokerFees(input({ buyerId: "nora" }));
  assert.equal(buyer.fees.length, 0);
  assert.match(buyer.withheld.join(" "), /buyer/);
  const seller = assessBrokerFees(input({ clientSellerName: "Nora Vale", sellerId: "nora" }));
  assert.equal(seller.fees.length, 0);
  assert.match(seller.withheld.join(" "), /seller/);
  const unnamed = assessBrokerFees(input({ clientSellerName: "", sellerId: "nora" }));
  assert.equal(unnamed.fees.length, 0);
});

test("a named client still pays when the broker's account files the listing", () => {
  const result = assessBrokerFees(input({ sellerId: "nora" }));
  assert.equal(result.fees.length, 1);
  assert.equal(result.fees[0]?.amountCents, 2000);
});

test("payout notes refuse account numbers", () => {
  assert.equal(payoutNoteProblem("ACH to the operating account on the W-9."), null);
  assert.match(payoutNoteProblem("Account number 123456789") ?? "", /account/i);
  assert.match(payoutNoteProblem("Routing 021000021") ?? "", /routing|account/i);
});

test("earnings months keep paid and owed apart", () => {
  const months = feeMonths(
    [
      { at: new Date(Date.UTC(2026, 6, 15)), amountCents: 1000, status: "PAID" },
      { at: new Date(Date.UTC(2026, 9, 2)), amountCents: 500, status: "OWED" },
    ],
    new Date(Date.UTC(2026, 9, 25)),
  );
  assert.deepEqual(months.map((month) => month.label), ["May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
  assert.equal(months.find((month) => month.label === "Jul")?.paid, 1000);
  assert.equal(months.find((month) => month.label === "Oct")?.owed, 500);
});
