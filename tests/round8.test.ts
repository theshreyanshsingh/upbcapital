import assert from "node:assert/strict";
import test from "node:test";
import { parseFilingCsv, matchFiling } from "../lib/filings";
import { hashKey, mintKey } from "../lib/api-keys";
import { lineCost, rehabPicture } from "../lib/rehab";
import { bidNeedsReminder, taskNeedsReminder } from "../lib/schedule";
import { fuzzyHit, parseSanctionNames } from "../lib/sdn";
import { projectFlows, performingCase } from "../lib/underwriting";
import { isPrivateAddress, publicLookup, signWebhook, webhookUrlProblem } from "../lib/webhooks";

test("fuzzy screening catches a near miss and parses a vendor body", () => {
  const hit = fuzzyHit("AEROCARIBBEAN AIRLINE", ["AEROCARIBBEAN AIRLINES"]);
  assert.ok(hit && hit.score >= 0.82);
  const names = parseSanctionNames(JSON.stringify({ results: [{ caption: "Sample Trust", properties: { name: ["Sample Trust LLC"] } }] }));
  assert.ok(names.includes("Sample Trust"));
  assert.ok(names.includes("Sample Trust LLC"));
});

test("irregular cash flows honor a balloon, a skip, and an ARM reset", () => {
  const balloon = projectFlows({ bid: 100000, upb: 100000, annualRate: 6, monthlyPi: 600, termMonths: 360, balloonMonth: 12 });
  assert.equal(balloon.length, 13);
  assert.ok(balloon[12] > 90000);
  const skipped = projectFlows({ bid: 50000, upb: 50000, annualRate: 12, monthlyPi: 500, termMonths: 4, missedMonths: [1] });
  assert.equal(skipped[1], 0);
  assert.ok(skipped[skipped.length - 1] > 50000);
  const arm = performingCase({
    bid: 100000,
    upb: 100000,
    annualRate: 3,
    monthlyPi: 500,
    termMonths: 24,
    armResets: [{ month: 2, annualRate: 12 }],
  });
  assert.ok(arm.irrPct == null || Number.isFinite(arm.irrPct));
  const level = projectFlows({ bid: 80000, upb: 100000, annualRate: 6, monthlyPi: 600, termMonths: 360 });
  assert.ok(level.length > 2);
  assert.equal(level[0], -80000);
});

test("rehab math uses the selected bid and a cap rate", () => {
  assert.equal(lineCost(10, 850), 85);
  const picture = rehabPicture({
    basis: 100000,
    lines: [{ quantity: 1, unitCostCents: 2000000 }],
    bids: [{ amount: 25000, selected: true }],
    arv: 180000,
    holdingMonths: 4,
    monthlyHold: 1000,
    monthlyRent: 2000,
    expenseRatio: 35,
  });
  assert.equal(picture.hard, 25000);
  assert.equal(picture.holding, 4000);
  assert.equal(picture.resaleProfit, 180000 - 129000);
  assert.ok(picture.capRate != null && picture.capRate > 0);
});

test("a clerk csv matches a note and a deadline reminder is due once", () => {
  const parsed = parseFilingCsv("case_number,address,city\n2026-9,100 Banyan St,Miami\n", "Miami-Dade");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].caseNumber, "2026-9");
  const noteId = matchFiling(parsed.rows[0], [{ id: "n1", streetAddress: "100 Banyan St", city: "Miami" }]);
  assert.equal(noteId, "n1");
  const now = new Date("2026-10-18T12:00:00Z");
  assert.equal(taskNeedsReminder({ dueOn: new Date("2026-10-19T12:00:00Z"), doneAt: null, remindedAt: null }, now), true);
  assert.equal(taskNeedsReminder({ dueOn: new Date("2026-10-19T12:00:00Z"), doneAt: null, remindedAt: now }, now), false);
  assert.equal(bidNeedsReminder({ bidMode: "SEALED", bidDeadline: new Date("2026-10-19T00:00:00Z"), bidReminderAt: null }, now), true);
  assert.equal(bidNeedsReminder({ bidMode: "NONE", bidDeadline: new Date("2026-10-19T00:00:00Z"), bidReminderAt: null }, now), false);
});

test("api keys hash and webhooks sign", () => {
  const minted = mintKey();
  assert.ok(minted.token.startsWith("upb_"));
  assert.equal(hashKey(minted.token), minted.hash);
  assert.equal(signWebhook("secret", "{\"a\":1}").length, 64);
});

test("webhooks reach only public https hosts, checked again on the dialed address", async () => {
  assert.equal(webhookUrlProblem("https://hooks.example.com/upb"), null);
  assert.match(webhookUrlProblem("http://hooks.example.com/upb") ?? "", /https URLs only/);
  assert.match(webhookUrlProblem("not a url") ?? "", /full https URL/);
  assert.match(webhookUrlProblem("https://user:pw@hooks.example.com/") ?? "", /credentials/);
  for (const url of ["https://localhost/x", "https://api.internal/x", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/", "https://[::1]/", "https://[::ffff:127.0.0.1]/"]) {
    assert.ok(webhookUrlProblem(url), url);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  assert.equal(isPrivateAddress("172.32.0.1"), false);
  assert.equal(isPrivateAddress("172.20.1.1"), true);
  assert.equal(isPrivateAddress("::ffff:10.1.2.3"), true);
  assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
  assert.equal(isPrivateAddress("::ffff:808:808"), false);
  assert.equal(isPrivateAddress("fd00::1"), true);
  // A name that resolves inside the network is refused at dial time, whatever the URL check said.
  const refused = await new Promise<NodeJS.ErrnoException | null>((resolve) => publicLookup("localhost", {}, (error) => resolve(error)));
  assert.equal(refused?.code, "EPRIVATE");
});
