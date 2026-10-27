import assert from "node:assert/strict";
import test from "node:test";
import { fillState, positionEconomics, resolvePositionAmount, seatName, splitPremium, scaleToTarget } from "@/lib/group-buy";

test("a group fills to the price and ignores a dropped seat", () => {
  const open = fillState(100000, [
    { amount: 60000, status: "PLEDGED" },
    { amount: 40000, status: "DROPPED" },
  ]);
  assert.equal(open.complete, false);
  assert.equal(open.remaining, 40000);
  const full = fillState(100000, [
    { amount: 60000, status: "PLEDGED" },
    { amount: 40000, status: "PLEDGED" },
  ]);
  assert.equal(full.complete, true);
  assert.equal(full.pct, 100);
});

test("a seat can be a percent and cannot exceed what is left", () => {
  assert.equal(resolvePositionAmount({ target: 100000, amount: null, percent: 25, min: 10000, remaining: 40000 }), 25000);
  assert.equal(resolvePositionAmount({ target: 100000, amount: 5000, percent: null, min: 10000, remaining: 40000 }), null);
  assert.equal(resolvePositionAmount({ target: 100000, amount: 50000, percent: null, min: 10000, remaining: 40000 }), null);
  assert.equal(resolvePositionAmount({ target: 100000, amount: 39999.2, percent: null, min: 1000, remaining: 40000 }), 40000);
});

test("premium cents split across seats and sum to the total", () => {
  const splits = splitPremium(25000, [
    { userId: "a", amount: 60000 },
    { userId: "b", amount: 40000 },
  ]);
  assert.equal(splits[0].premiumCents + splits[1].premiumCents, 25000);
  assert.equal(splits[0].premiumCents, 15000);
});

test("other buyers see a seat number", () => {
  assert.equal(seatName({ seat: 2, userId: "b", name: "Camille Ortiz", viewerId: "a", viewerRole: "BUYER" }), "Seat 2");
  assert.equal(seatName({ seat: 2, userId: "b", name: "Camille Ortiz", viewerId: "b", viewerRole: "BUYER" }), "Camille Ortiz");
  assert.equal(seatName({ seat: 2, userId: "b", name: "Camille Ortiz", viewerId: "desk", viewerRole: "ADMIN" }), "Camille Ortiz");
});

test("a counter scales a seat and the last dollar lands on the price", () => {
  assert.equal(scaleToTarget(40000, 100000, 110000), 44000);
});

test("senior is paid first and junior keeps the remainder", () => {
  const shared = {
    structure: "SENIOR_JUNIOR" as const,
    price: 100000,
    upb: 150000,
    annualRate: 8,
    monthlyPi: 1100,
    termMonths: 360,
    seniorYield: 6,
    seniorCapital: 60000,
    juniorCapital: 40000,
  };
  const senior = positionEconomics({ ...shared, amount: 60000, slice: "SENIOR" });
  const junior = positionEconomics({ ...shared, amount: 40000, slice: "JUNIOR" });
  assert.ok(senior.irrPct != null && senior.irrPct > 5 && senior.irrPct < 7);
  assert.ok(junior.irrPct != null && junior.irrPct > senior.irrPct);
  const pari = positionEconomics({ ...shared, structure: "PRO_RATA", amount: 40000, slice: "PARI" });
  assert.ok(pari.irrPct != null && Number.isFinite(pari.irrPct));
});
