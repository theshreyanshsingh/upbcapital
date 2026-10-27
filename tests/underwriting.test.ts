import assert from "node:assert/strict";
import test from "node:test";
import { canSubmitBid, hideCompetingBids, sealedFromSeller } from "../lib/auction";
import { suggestedPrice } from "../lib/comps";
import { foreclosureFor } from "../lib/foreclosure";
import { rateLimit, resetRateLimits } from "../lib/rate-limit";
import { stratify } from "../lib/strata";
import { generateTotpSecret, totpCode, verifyTotp } from "../lib/totp";
import { monthlyIrr, performingCase, projectFlows } from "../lib/underwriting";

test("performing IRR is the note rate when the bid equals the balance", () => {
  const upb = 100000;
  const annualRate = 6;
  const monthly = annualRate / 100 / 12;
  const monthlyPi = (upb * monthly) / (1 - (1 + monthly) ** -360);
  const result = performingCase({ bid: upb, upb, annualRate, monthlyPi, termMonths: 360 });
  assert.ok(result.irrPct != null);
  const effective = ((1 + monthly) ** 12 - 1) * 100;
  assert.ok(Math.abs(result.irrPct - effective) < 0.05);
  assert.equal(result.cashOnCash, result.yieldPct);
  assert.ok(result.paybackMonths != null && result.paybackMonths > 0);
  const flows = projectFlows({ bid: upb, upb, annualRate, monthlyPi, termMonths: 360 });
  const irr = monthlyIrr(flows);
  assert.ok(irr != null);
  const npv = flows.reduce((sum, flow, month) => sum + flow / (1 + irr) ** month, 0);
  assert.ok(Math.abs(npv) < 1);
});

test("unknown states use Florida judicial timing", () => {
  const rule = foreclosureFor("ZZ");
  assert.equal(rule.assumed, true);
  assert.equal(rule.state, "FL");
  assert.equal(rule.process, "Judicial");
  assert.equal(rule.months, 18);
  assert.equal(rule.cost, 12000);
  assert.equal(foreclosureFor("fl").assumed, false);
});

test("strata weights by unpaid principal", () => {
  const tape = stratify([
    { state: "FL", lien: "FIRST", status: "PERFORMING", upb: 100000, value: 200000, rate: 6, monthsDelinquent: 0 },
    { state: "GA", lien: "SECOND", status: "NON_PERFORMING", upb: 100000, value: 200000, rate: 8, monthsDelinquent: 2 },
  ]);
  assert.equal(tape.wac, 7);
  assert.equal(tape.waltv, 50);
  assert.equal(tape.weightedDelinquency, 1);
  assert.equal(tape.byState.length, 2);
  assert.equal(tape.byUpb[0].label, "$100–250k");
});

test("totp accepts the current code and a one-step neighbor", () => {
  const secret = generateTotpSecret();
  const time = 1_700_000_000_000;
  const code = totpCode(secret, time);
  assert.equal(verifyTotp(secret, code, time), true);
  assert.equal(verifyTotp(secret, totpCode(secret, time - 30_000), time), true);
  assert.equal(verifyTotp(secret, "000000", time), false);
});

test("sealed bids hide until the deadline and best-and-final is one bid", () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  assert.equal(hideCompetingBids({ bidMode: "SEALED", deadline: future, isDesk: false }), true);
  assert.equal(hideCompetingBids({ bidMode: "SEALED", deadline: past, isDesk: false }), false);
  assert.equal(hideCompetingBids({ bidMode: "SEALED", deadline: future, isDesk: true }), false);
  assert.equal(canSubmitBid({ bidMode: "BEST_AND_FINAL", deadline: future, alreadyBid: true }).ok, false);
  assert.equal(canSubmitBid({ bidMode: "SEALED", deadline: past, alreadyBid: false }).ok, false);
  assert.equal(canSubmitBid({ bidMode: "NONE", deadline: past, alreadyBid: true }).ok, true);
  assert.equal(sealedFromSeller({ bidMode: "SEALED", bidDeadline: future }), true);
  assert.equal(sealedFromSeller({ bidMode: "SEALED", bidDeadline: past }), false);
  assert.equal(sealedFromSeller({ bidMode: "BEST_AND_FINAL", bidDeadline: future }), false);
});

test("suggested price is the median comparable ratio", () => {
  const subject = { state: "FL", paymentStatus: "PERFORMING", upb: 100000, askingPrice: 50000 };
  const suggestion = suggestedPrice(subject, [
    subject,
    { state: "FL", paymentStatus: "PERFORMING", upb: 90000, askingPrice: 72000 },
    { state: "FL", paymentStatus: "PERFORMING", upb: 110000, askingPrice: 99000 },
    { state: "FL", paymentStatus: "PERFORMING", upb: 105000, askingPrice: 73500 },
    { state: "TX", paymentStatus: "PERFORMING", upb: 100000, askingPrice: 10000 },
  ]);
  assert.ok(suggestion);
  assert.equal(suggestion.sample, 3);
  assert.equal(suggestion.price, 80000);
});

test("rate limit closes after the budget", () => {
  resetRateLimits();
  assert.equal(rateLimit("desk", 2, 1000, 0), true);
  assert.equal(rateLimit("desk", 2, 1000, 10), true);
  assert.equal(rateLimit("desk", 2, 1000, 20), false);
  assert.equal(rateLimit("desk", 2, 1000, 2000), true);
});
