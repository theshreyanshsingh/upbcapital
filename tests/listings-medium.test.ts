import assert from "node:assert/strict";
import test from "node:test";
import { toCsv } from "../lib/csv";
import { estimateProperty } from "../lib/enrichment";
import { filtersFor, listingMatches } from "../lib/filters";
import { typedNumber } from "../lib/money";
import { normalizeTapeRows } from "../lib/tape";
import { reviewTape } from "../lib/tape-quality";

const mapping = {
  city: "City",
  state: "State",
  propertyType: "Type",
  lienPosition: "Lien",
  paymentStatus: "Status",
  upb: "UPB",
  estimatedValue: "Value",
  interestRate: "Rate",
  askingPrice: "Ask",
} as const;
const row = (rate: string, upb = "100000") => ({ City: "Tampa", State: "FL", Type: "SFR", Lien: "First", Status: "Performing", UPB: upb, Value: "150000", Rate: rate, Ask: "80000" });

test("a typed figure reads commas, dollar signs, percent signs and k or M", () => {
  assert.equal(typedNumber("1,250,000"), 1250000);
  assert.equal(typedNumber("$1.25M"), 1250000);
  assert.equal(typedNumber("250k"), 250000);
  assert.equal(typedNumber("70%"), 70);
  assert.ok(Number.isNaN(typedNumber("")));
  assert.ok(Number.isNaN(typedNumber("about a million")));
});

test("a tape rate written as a percent imports, and a bare fraction still scales", () => {
  const { loans, errors } = normalizeTapeRows({ rows: [row("6.50%"), row("0.065"), row("0.75%")], mapping, priceMode: "COLUMN" });
  assert.deepEqual(errors, []);
  assert.deepEqual(loans.map((loan) => loan.interestRate), [6.5, 6.5, 0.75]);
  // The preview says the same thing the import does.
  const flags = reviewTape([row("0.75%")], mapping);
  assert.ok(!flags.some((flag) => /75\.00%/.test(JSON.stringify(flag))));
});

test("a pool price that isn't a number is refused, not saved as NaN", () => {
  const bad = normalizeTapeRows({ rows: [row("6%")], mapping, priceMode: "POOL_TOTAL", poolTotal: typedNumber("a lot") });
  assert.equal(bad.loans.length, 0);
  assert.match(bad.errors[0].message, /pool asking price/);
  const good = normalizeTapeRows({ rows: [row("6%", "100000"), row("6%", "300000")], mapping, priceMode: "POOL_TOTAL", poolTotal: typedNumber("$400,000") });
  assert.deepEqual(good.loans.map((loan) => loan.askingPrice), [100000, 300000]);
  const odd = normalizeTapeRows({ rows: [row("6%")], mapping, priceMode: "AUCTION" as never });
  assert.equal(odd.loans.length, 0);
});

test("CSV cells that would run as formulas are defused", () => {
  const csv = toCsv([{ city: '=HYPERLINK("https://x.example","Miami")', note: "+1", at: "@SUM(A1)", balance: -500, text: "-250", dash: "- see file", tab: "\tx" }]);
  const cells = csv.split("\n")[1];
  assert.ok(cells.startsWith(`"'=HYPERLINK`));
  assert.ok(cells.includes(",'+1,'@SUM(A1),-500,-250,'- see file,'\tx"));
});

const loan = (upb: number, askingPrice: number, tradeStatus = "AVAILABLE") => ({
  city: "Tampa",
  state: "FL",
  paymentStatus: "PERFORMING",
  lienPosition: "FIRST",
  propertyType: "SFR",
  upb,
  askingPrice,
  tradeStatus,
});

test("a pool matches balance and price on the totals of the loans still for sale", () => {
  const pool = { kind: "POOL", notes: Array.from({ length: 10 }, () => loan(60000, 50000)) };
  assert.equal(listingMatches(pool, { priceMin: 400000 }), true);
  assert.equal(listingMatches(pool, { priceMax: 100000 }), false);
  const partly = { kind: "POOL", notes: [...pool.notes.slice(0, 9), loan(60000, 50000, "SOLD")] };
  assert.equal(listingMatches(partly, { priceMin: 500000 }), false);
  assert.equal(listingMatches(partly, { priceMin: 450000, state: "FL" }), true);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [loan(60000, 50000)] }, { priceMin: 400000 }), false);
});

test("free members can't filter on the figures they see veiled", () => {
  const filters = { state: "FL", upbMin: 200000, upbMax: 250000, priceMin: 1, priceMax: 9 };
  assert.deepEqual(filtersFor(filters, false), { state: "FL", upbMin: undefined, upbMax: undefined, priceMin: undefined, priceMax: undefined });
  assert.deepEqual(filtersFor(filters, true), filters);
});

test("an ATTOM setup with no answer saves a stand-in labelled mock, never attom", async () => {
  const saved = process.env.ATTOM_API_KEY;
  delete process.env.ATTOM_API_KEY;
  try {
    const estimate = await estimateProperty({ city: "Tampa", state: "FL", zip: "33602", street: "1 Main St", estimatedValue: 150000 }, "attom");
    assert.equal(estimate.providerId, "mock");
  } finally {
    if (saved !== undefined) process.env.ATTOM_API_KEY = saved;
  }
});

test("tape edge cases: short ZIPs, accounting negatives and a 1% coupon", () => {
  const { loans, errors } = normalizeTapeRows({
    rows: [{ ...row("1"), Zip: "2134" }, { ...row("6"), UPB: "(1,000)" }],
    mapping: { ...mapping, zip: "Zip" },
    priceMode: "COLUMN",
  });
  assert.equal(loans.length, 1);
  assert.equal(loans[0].zip, "02134");
  assert.equal(loans[0].interestRate, 1);
  assert.match(errors[0].message, /UPB must be greater than zero/);
});

test("a blank note rate is refused instead of saved as 0%", async () => {
  const { noteSchema } = await import("../lib/validators");
  const base = { streetAddress: "1 Main St", city: "Tampa", state: "FL", zip: "33602", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", estimatedValue: "150000", lienPosition: "FIRST", upb: "100000", monthlyPi: "0", paymentStatus: "PERFORMING", monthsDelinquent: "0", askingPrice: "80000", foreclosureStatus: "NONE" };
  assert.equal(noteSchema.safeParse({ ...base, interestRate: "" }).success, false);
  assert.equal(noteSchema.safeParse({ ...base, interestRate: "0" }).success, true);
  assert.equal(noteSchema.safeParse({ ...base, interestRate: "41" }).success, false);
});

test("the tape API refuses a title or tape that isn't text", async () => {
  const { ingestTape } = await import("../lib/ingest");
  assert.deepEqual(await ingestTape({ sellerId: "x", title: 42, csv: "a,b" }), { error: "Send title, csv and summary as text." });
  assert.deepEqual(await ingestTape({ sellerId: "x", title: "Big pool", csv: "x".repeat(10 * 1024 * 1024 + 1) }), { error: "Tapes are limited to 10 MB." });
});
