import assert from "node:assert/strict";
import test from "node:test";
import { funnelSteps, daysBetween, average } from "@/lib/analytics";
import { scoreAgainstBox } from "@/lib/buy-box";
import { canReadThreadFile } from "@/lib/acl";
import { mockDeskAnswer } from "@/lib/desk-ai";
import { bookReturn } from "@/lib/holdings";
import { indicativeQuote } from "@/lib/quote";
import { messageWasRead } from "@/lib/read-state";
import { reviewTape } from "@/lib/tape-quality";

const note = {
  state: "FL",
  lienPosition: "FIRST",
  paymentStatus: "PERFORMING",
  upb: 200000,
  askingPrice: 140000,
  monthlyPi: 1200,
  interestRate: 8,
  termMonths: 360,
};

test("a buy box scores a fitting note and rejects a miss", () => {
  const box = {
    states: ["FL"],
    liens: ["FIRST"],
    statuses: ["PERFORMING"],
    upbMin: 100000,
    upbMax: 400000,
    priceMin: null,
    priceMax: null,
    maxPriceToUpb: 80,
    targetYield: 8,
  };
  const hit = scoreAgainstBox([note], box);
  assert.ok(hit);
  assert.ok(hit.score >= 55);
  assert.equal(scoreAgainstBox([{ ...note, state: "TX" }], box), null);
  assert.equal(scoreAgainstBox([{ ...note, askingPrice: 190000 }], box), null);
  assert.equal(scoreAgainstBox([{ ...note, monthlyPi: 400, interestRate: 2 }], box), null);
});

test("an indicative range stays inside the balance", () => {
  const quote = indicativeQuote({
    state: "FL",
    paymentStatus: "PERFORMING",
    upb: 200000,
    estimatedValue: 320000,
    interestRate: 6.5,
    monthlyPi: 1400,
  });
  assert.ok(quote.low > 0);
  assert.ok(quote.high >= quote.low);
  assert.ok(quote.high < 200000);
  assert.match(quote.basis, /Desk band/);
});

test("tape review fixes common formats and flags bad rows", () => {
  const rows = [
    { City: "Miami", State: "Florida", UPB: "$228,000", Value: "400000", Rate: "0.065", ZIP: "33130-1234", Lien: "1st", Status: "current" },
    { City: "Atlanta, GA", State: "FL", UPB: "180000", Value: "100000", Rate: "22", ZIP: "30308", Lien: "First", Status: "Performing" },
    { City: "", State: "FL", UPB: "", Value: "100000", Rate: "6", ZIP: "", Lien: "First", Status: "Performing" },
  ];
  const mapping = { city: "City", state: "State", upb: "UPB", estimatedValue: "Value", interestRate: "Rate", zip: "ZIP", lienPosition: "Lien", paymentStatus: "Status" };
  const flags = reviewTape(rows, mapping);
  assert.ok(flags.some((flag) => flag.row === 2 && flag.level === "fix" && flag.field === "state"));
  assert.ok(flags.some((flag) => flag.row === 2 && flag.level === "fix" && flag.field === "rate"));
  assert.ok(flags.some((flag) => flag.row === 3 && flag.message.includes("LTV")));
  assert.ok(flags.some((flag) => flag.row === 3 && flag.message.includes("GA")));
  assert.ok(flags.some((flag) => flag.row === 4 && flag.level === "error"));
});

test("the desk sketch summarizes a tape without a model", () => {
  const text = mockDeskAnswer("summarize", JSON.stringify({
    loans: [
      { state: "FL", upb: 100000, paymentStatus: "PERFORMING" },
      { state: "GA", upb: 50000, paymentStatus: "NON_PERFORMING" },
    ],
  }));
  assert.match(text, /2 loans/);
  assert.match(text, /FL/);
  assert.match(text, /non-performing/);
});

test("a reply is read only after every other participant has opened it", () => {
  const sent = new Date("2026-10-01T12:00:00Z");
  assert.equal(messageWasRead(sent, [new Date("2026-10-01T12:05:00Z")]), true);
  assert.equal(messageWasRead(sent, [new Date("2026-10-01T11:00:00Z")]), false);
  assert.equal(messageWasRead(sent, []), false);
  assert.equal(canReadThreadFile({ role: "BUYER", userId: "a", memberIds: ["b"] }), false);
  assert.equal(canReadThreadFile({ role: "ADMIN", userId: "a", memberIds: ["b"] }), true);
});

test("funnel rates and holding variance use the prior step", () => {
  const steps = funnelSteps({ visits: 100, signups: 40, verified: 10, offers: 5, closings: 2, closed: 1 });
  assert.equal(steps[1].rate, 40);
  assert.equal(steps[0].rate, null);
  assert.equal(daysBetween(new Date("2026-01-01"), new Date("2026-01-11")), 10);
  assert.equal(average([10, 30]), 20);
  const book = bookReturn({
    cost: 100000,
    received: 8000,
    acquiredAt: new Date("2026-01-01"),
    now: new Date("2026-07-01"),
    underwrittenYield: 12,
  });
  assert.ok(book.expected != null && book.expected > 5000);
  assert.equal(book.variance != null && book.variance > 0, true);
});
