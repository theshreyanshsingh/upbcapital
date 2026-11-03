import assert from "node:assert/strict";
import test from "node:test";
import { needsSecondFactor } from "../lib/access";
import { awaitingSeller, sellerAgreed } from "../lib/awards";
import { simulatedCheckout } from "../lib/billing";
import { DEFAULT_DEPOSIT_BPS, DEFAULT_DEPOSIT_DAYS, depositCents, depositTerms } from "../lib/closing-clock";
import { showableAvm } from "../lib/enrichment";
import { launchReadiness } from "../lib/readiness";
import { isPro } from "../lib/settings";

const DAY = 24 * 60 * 60 * 1000;

test("a sale needs the seller's word: a reserve that covers the price, or an approval of that exact price", () => {
  assert.equal(sellerAgreed({ price: 80000, reserve: null, approvedAmount: null }), null);
  assert.equal(sellerAgreed({ price: 80000, reserve: 75000, approvedAmount: null }), "reserve");
  assert.equal(sellerAgreed({ price: 74999, reserve: 75000, approvedAmount: null }), null);
  assert.equal(sellerAgreed({ price: 80000, reserve: null, approvedAmount: 80000 }), "approved");
  // A counter after the approval changes the price, so the old approval no longer covers it.
  assert.equal(sellerAgreed({ price: 82000, reserve: null, approvedAmount: 80000 }), null);
  assert.equal(sellerAgreed({ price: 80000, reserve: 0, approvedAmount: null }), null);
  const asked = new Date("2026-11-03T10:00:00Z");
  assert.equal(awaitingSeller({ sellerAskedAt: asked, sellerAnsweredAt: null }), true);
  assert.equal(awaitingSeller({ sellerAskedAt: asked, sellerAnsweredAt: new Date("2026-11-03T11:00:00Z") }), false);
  assert.equal(awaitingSeller({ sellerAskedAt: new Date("2026-11-04T10:00:00Z"), sellerAnsweredAt: new Date("2026-11-03T11:00:00Z") }), true);
  assert.equal(awaitingSeller({ sellerAskedAt: null, sellerAnsweredAt: null }), false);
});

test("deposit terms default to ten percent in three days and stay inside sane bounds", () => {
  assert.deepEqual(depositTerms({}), { bps: DEFAULT_DEPOSIT_BPS, days: DEFAULT_DEPOSIT_DAYS });
  assert.deepEqual(depositTerms({ depositBps: 500, depositDays: 2 }), { bps: 500, days: 2 });
  assert.deepEqual(depositTerms({ depositBps: 0, depositDays: 2 }), { bps: 0, days: 2 });
  assert.deepEqual(depositTerms({ depositBps: 9000, depositDays: 90 }), { bps: DEFAULT_DEPOSIT_BPS, days: DEFAULT_DEPOSIT_DAYS });
  assert.equal(depositCents(80000, 1000), 800000);
  assert.equal(depositCents(123456.78, 250), 308642);
});

test("two-step sign-in: admins always, approved accounts when the desk requires it, demo seats never", () => {
  const buyer = { role: "BUYER", email: "buyer@fund.com", totpEnabled: false, accountStatus: "APPROVED" };
  assert.equal(needsSecondFactor(buyer, true), true);
  assert.equal(needsSecondFactor(buyer, false), false);
  assert.equal(needsSecondFactor({ ...buyer, totpEnabled: true }, true), false);
  assert.equal(needsSecondFactor({ ...buyer, accountStatus: "PENDING" }, true), false);
  assert.equal(needsSecondFactor({ ...buyer, email: "camille@upbcapital.test" }, true), false);
  assert.equal(needsSecondFactor({ role: "ADMIN", email: "owner@upbcapital.com", totpEnabled: false, accountStatus: "APPROVED" }, false), true);
});

test("in a release Pro lapses after its period plus a three-day grace; a desk comp and the demo desk don't", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const pro = { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" };
  assert.equal(isPro({ ...pro, subscriptionCurrentPeriodEnd: new Date(now.getTime() + DAY) }, now, true), true);
  assert.equal(isPro({ ...pro, subscriptionCurrentPeriodEnd: new Date(now.getTime() - 2 * DAY) }, now, true), true);
  assert.equal(isPro({ ...pro, subscriptionCurrentPeriodEnd: new Date(now.getTime() - 4 * DAY) }, now, true), false);
  assert.equal(isPro({ ...pro, subscriptionCurrentPeriodEnd: null }, now, true), true);
  assert.equal(isPro({ ...pro, subscriptionCurrentPeriodEnd: new Date(now.getTime() - 40 * DAY) }, now, false), true);
  assert.equal(isPro({ subscriptionTier: "PRO", subscriptionStatus: "CANCELED" }, now, true), false);
});

test("a release hides stand-in values and closes the simulated checkout", () => {
  assert.equal(showableAvm({ avmValue: 150000, avmProvider: "mock" }, false), 150000);
  assert.equal(showableAvm({ avmValue: 150000, avmProvider: "mock" }, true), null);
  assert.equal(showableAvm({ avmValue: 150000, avmProvider: "attom" }, true), 150000);
  assert.equal(showableAvm({ avmValue: null, avmProvider: "attom" }, true), null);
  const before = { release: process.env.UPB_RELEASE, stripe: process.env.STRIPE_SECRET_KEY };
  try {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.UPB_RELEASE;
    assert.equal(simulatedCheckout(), true);
    process.env.UPB_RELEASE = "1";
    assert.equal(simulatedCheckout(), false);
  } finally {
    if (before.release === undefined) delete process.env.UPB_RELEASE;
    else process.env.UPB_RELEASE = before.release;
    if (before.stripe !== undefined) process.env.STRIPE_SECRET_KEY = before.stripe;
  }
});

test("launch readiness names every stand-in and calls a release without Stripe closed", async () => {
  const demo = await launchReadiness({ requireTwoStep: null }, { OFAC_SDN_URL: "https://example.gov/SDN.CSV" });
  const by = (list: typeof demo.items, label: string) => list.find((item) => item.label === label)!;
  assert.equal(demo.release, false);
  assert.equal(by(demo.items, "Release mode").state, "standin");
  assert.equal(by(demo.items, "Sanctions list").state, "live");
  assert.equal(by(demo.items, "Pro payments").state, "standin");
  assert.equal(by(demo.items, "Two-step sign-in").state, "live");
  assert.equal(demo.ready, false);
  const release = await launchReadiness({ requireTwoStep: false }, { UPB_RELEASE: "1" });
  assert.equal(by(release.items, "Pro payments").state, "off");
  assert.equal(by(release.items, "Two-step sign-in").state, "off");
  assert.equal(by(release.items, "Sanctions list").state, "standin");
});
