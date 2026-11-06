import assert from "node:assert/strict";
import test from "node:test";
import type { CompCell } from "../lib/comps";
import { FORECLOSURE_TABLE, foreclosureFor, foreclosureProgress, MIN_MONTHS_LEFT, monthsSince } from "../lib/foreclosure";
import {
  DEFAULT_INDICATIVE_YIELD,
  indicativeRange,
  indicativeTarget,
  indicativeText,
  ladderSummary,
  loadIndicative,
  marketRate,
  modelBand,
  priceLadder,
  RATE_STALE_DAYS,
  rateStale,
  rateStamp,
  type IndicativeNote,
} from "../lib/indicative";
import { rescoreBox, rescoreListing, scoreMatch, standingDemand } from "../lib/matching";
import { prisma } from "../lib/prisma";
import { clearSettingsCache, getSettings } from "../lib/settings";
import {
  DEFAULT_INDICATIVE_YIELD as SCHEMA_DEFAULT,
  indicativeFor,
  inviteToConfirm,
  NO_RATE,
  readStandingRule,
  remainingTerm,
  ruleLabel,
  ruleOf,
  ruleTarget,
  standingSheet,
  yieldPrice,
} from "../lib/standing-bids";
import {
  currentLtv,
  headlinePrices,
  nplCases,
  payoffChance,
  performingWeights,
  PREPAYMENT,
  priceForYield,
  pricingValue,
  yieldAtPrice,
  type PricingNote,
} from "../lib/underwriting";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-05T12:00:00Z");

const close = (actual: number | null | undefined, expected: number, tolerance: number) => {
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Spread rules.

const spreadBox = (over: Partial<{ standingBids: boolean; bidSpread: number | null; bidCap: number | null }> = {}) => ({
  standingBids: true,
  bidBasis: "SPREAD",
  bidPercent: null,
  bidCap: null,
  targetYield: null,
  bidSpread: 7,
  ...over,
});
const loan = (id: string, upb: number, ask: number, extra: Partial<{ paymentStatus: string; maturityDate: Date | null }> = {}) => ({
  id,
  upb,
  askingPrice: ask,
  interestRate: 7,
  monthlyPi: 775.3,
  paymentStatus: "PERFORMING",
  maturityDate: new Date(now.getTime() + 240 * 30 * DAY),
  tradeStatus: "AVAILABLE",
  ...extra,
});

test("a spread rule prices for the 10-year plus its spread, and stamps the rate's date", () => {
  const rate = { rate: 4.95, asOf: new Date("2026-11-03T00:00:00Z") };
  const rule = ruleOf(spreadBox());
  assert.deepEqual(rule, { basis: "SPREAD", spread: 7, cap: null });
  assert.equal(ruleOf(spreadBox({ bidSpread: null })), null);
  assert.equal(ruleOf(spreadBox({ bidSpread: 0 })), null);
  assert.equal(ruleTarget(rule, rate), 11.95);
  assert.equal(ruleTarget(rule, null), null);

  // The same price a yield rule at 11.95% would give, premium included, and the rate's date on it.
  const priced = indicativeFor(spreadBox(), { kind: "SINGLE" }, [loan("a", 100000, 100000)], now, 250, rate);
  const term = remainingTerm(loan("a", 1, 1).maturityDate, now);
  const expected = Math.round(yieldPrice({ upb: 100000, annualRate: 7, monthlyPi: 775.3, termMonths: term }, 11.95, 250) ?? 0);
  assert.ok(expected > 0);
  assert.equal(priced?.price, expected);
  assert.equal(priced?.target, 11.95);
  assert.equal(priced?.rateAsOf?.toISOString(), rate.asOf.toISOString());
  // A higher rate is a higher target and a lower price: the rule holds through a hike without a rewrite.
  const hiked = indicativeFor(spreadBox(), { kind: "SINGLE" }, [loan("a", 100000, 100000)], now, 250, { rate: 5.2, asOf: rate.asOf });
  assert.ok((hiked?.price ?? 0) < expected);

  // No rate on file: no price, and the reason says why.
  const waiting = indicativeFor(spreadBox(), { kind: "SINGLE" }, [loan("a", 100000, 100000)], now, 250, null);
  assert.equal(waiting?.price, null);
  assert.equal(waiting?.why, NO_RATE);
  // Like a yield rule, it prices performing loans only.
  const npl = indicativeFor(spreadBox(), { kind: "SINGLE" }, [loan("a", 100000, 100000, { paymentStatus: "NON_PERFORMING" })], now, 0, rate);
  assert.equal(npl?.price, null);
  assert.match(npl?.why ?? "", /yield or spread rule prices performing loans only/);
  // A UPB rule carries no rate stamp.
  const upbRule = indicativeFor({ ...spreadBox(), bidBasis: "UPB", bidPercent: 70 }, { kind: "SINGLE" }, [loan("a", 100000, 100000)], now, 0, rate);
  assert.equal(upbRule?.rateAsOf, null);
  // Before the ask caps it, for the seller's view: the box's own figure, even above the ask.
  const cheapAsk = indicativeFor(spreadBox(), { kind: "SINGLE" }, [loan("a", 100000, 30000)], now, 250, rate);
  assert.equal(cheapAsk?.price, 30000);
  assert.equal(indicativeFor(spreadBox(), { kind: "SINGLE" }, [loan("a", 100000, 30000)], now, 250, rate, { ignoreAsk: true })?.price, expected);

  assert.equal(ruleLabel(rule, rate), "10-year Treasury + 7 points, an 11.95% IRR on the 4.95% rate as of Nov 3, 2026");
  assert.equal(ruleLabel(rule, null), "10-year Treasury + 7 points, waiting for the desk's 10-year rate");
});

test("the rule form reads a spread in points and keeps it in range", () => {
  const box = { targetYield: null, maxPriceToUpb: null };
  const fields = (spread: string) => ({ basis: "SPREAD", percent: "", cap: "", target: "", spread });
  assert.deepEqual(readStandingRule(fields("7"), box, true), { error: null, data: { standingBids: true, bidBasis: "SPREAD", bidCap: null, bidSpread: 7 } });
  assert.deepEqual(readStandingRule(fields("6.5%"), box, true), { error: null, data: { standingBids: true, bidBasis: "SPREAD", bidCap: null, bidSpread: 6.5 } });
  for (const bad of ["", "0", "-1", "31", "lots"]) {
    assert.match((readStandingRule(fields(bad), box, true) as { error: string }).error, /spread over the 10-year/);
  }
  assert.match((readStandingRule(fields("7"), box, false) as { error: string }).error, /Pro privilege/);
});

// ---------------------------------------------------------------------------------------------------------------
// The stale-rate flag.

test("a rate over seven days old is stale, and says its date", () => {
  assert.equal(RATE_STALE_DAYS, 7);
  const asOf = new Date("2026-10-29T12:00:00Z");
  assert.equal(rateStale(asOf, new Date(asOf.getTime() + 7 * DAY)), false);
  assert.equal(rateStale(asOf, new Date(asOf.getTime() + 7 * DAY + 1)), true);
  assert.equal(rateStale(null, now), true);
  assert.deepEqual(rateStamp(new Date("2026-11-03T00:00:00Z"), now), { asOf: "2026-11-03", text: "rate as of Nov 3, 2026", stale: false });
  assert.equal(rateStamp(new Date("2026-10-20T00:00:00Z"), now)?.stale, true);
  assert.equal(rateStamp(null, now), null);
  // Settings without both a rate and its date have no rate.
  assert.equal(marketRate({ tenYearRate: 4.95, tenYearAsOf: null }), null);
  assert.equal(marketRate({ tenYearRate: null, tenYearAsOf: now }), null);
  assert.deepEqual(marketRate({ tenYearRate: 4.95, tenYearAsOf: now }), { rate: 4.95, asOf: now });
  // A spread-priced standing bid in the range carries the stamp, flagged.
  const range = indicativeRange({ notes: [performingNote()], standing: [{ price: 60000, rateAsOf: new Date("2026-10-20T00:00:00Z") }], now });
  assert.equal(range?.rate?.stale, true);
  assert.equal(range?.sources.find((row) => row.key === "standing")?.rate?.text, "rate as of Oct 20, 2026");
  assert.equal(indicativeRange({ notes: [performingNote()], standing: [{ price: 60000 }], now })?.rate, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Foreclosure months remaining.

test("a filed foreclosure shows months in and the state timeline left, in the model too", () => {
  const ny = foreclosureFor("NY");
  const filed = new Date(now.getTime() - 14 * 30.44 * DAY);
  assert.equal(monthsSince(filed, now), 14);
  const progress = foreclosureProgress(ny, filed, now);
  assert.equal(progress?.monthsIn, 14);
  assert.equal(progress?.monthsLeft, FORECLOSURE_TABLE.NY.months - 14);
  assert.equal(progress?.pastAverage, false);
  assert.match(progress?.line ?? "", new RegExp(`About ${FORECLOSURE_TABLE.NY.months - 14} months left of the New York average of ${FORECLOSURE_TABLE.NY.months} months \\(ATTOM, Q2 2026\\)`));
  // Texas runs about five months, so a case a year old is past it and the model allows the minimum.
  const tx = foreclosureProgress(foreclosureFor("TX"), new Date(now.getTime() - 12 * 30.44 * DAY), now);
  assert.equal(tx?.pastAverage, true);
  assert.equal(tx?.monthsLeft, MIN_MONTHS_LEFT);
  assert.match(tx?.line ?? "", /past the Texas average/);
  assert.equal(foreclosureProgress(ny, null, now), null);
  assert.equal(foreclosureProgress(ny, new Date(now.getTime() + 60 * DAY), now), null);

  const note: PricingNote = {
    upb: 150000,
    interestRate: 7,
    monthlyPi: 1000,
    estimatedValue: 250000,
    state: "NY",
    paymentStatus: "NON_PERFORMING",
    occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST",
    monthsDelinquent: 20,
    foreclosureFiledAt: filed,
  };
  const solved = priceForYield(note, 15, { now });
  assert.equal(solved.foreclosure?.monthsLeft, FORECLOSURE_TABLE.NY.months - 14);
  assert.equal(yieldAtPrice(note, 60000, { now }).foreclosure?.monthsIn, 14);
  // The scenario model runs the foreclosure on the time left, and says so.
  const row = nplCases({
    bid: 60000,
    upb: 150000,
    value: 250000,
    monthlyPi: 1000,
    monthsDelinquent: 20,
    foreclosureMonths: ny.months,
    foreclosureCost: ny.cost,
    process: ny.process,
    occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST",
    foreclosureMonthsElapsed: 14,
  }).find((item) => item.key === "foreclosure");
  assert.match(row?.note ?? "", new RegExp(`14 months into the case, about ${ny.months - 14} months of the judicial timeline still to run`));
  // Performing paper has no clock, and an unfiled loan none either.
  assert.equal(priceForYield(performingNote(), 12, { now }).foreclosure, null);
  assert.equal(priceForYield({ ...note, foreclosureFiledAt: null }, 15, { now }).foreclosure, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Prepayment and current value.

test("the performing paths weigh an early payoff from a low, labelled prepayment speed", () => {
  assert.equal(PREPAYMENT.cpr, 7);
  close(payoffChance(7), 1 - 0.93 ** 3, 1e-12);
  const weights = performingWeights();
  close(weights.reduce((sum, row) => sum + row.weight, 0), 1, 1e-12);
  close(weights[1].weight, 1 - 0.93 ** 3, 1e-12);
  assert.equal(weights[2].weight, 0.1);
  const solved = priceForYield(performingNote(), 12, { now });
  assert.equal(solved.prepayment?.assumed, true);
  assert.match(solved.prepayment?.label ?? "", /7% CPR, a low default \(ICE First Look, September 2026: 0.59% SMM/);
  assert.match(solved.prepayment?.label ?? "", /An assumption, not a forecast/);
  close(solved.scenarios.find((row) => row.key === "payoff")?.weight, 1 - 0.93 ** 3, 1e-9);
  // A faster speed moves weight to the payoff path; the headline stays on the contract.
  const fast = priceForYield(performingNote(), 12, { now, cpr: 20 });
  assert.equal(fast.prepayment?.assumed, false);
  assert.ok((fast.scenarios.find((row) => row.key === "payoff")?.weight ?? 0) > 0.4);
  close(fast.bid, solved.bid ?? 0, 1e-6);
  // headlinePrices is priceForYield's headline at a fraction of the work.
  close(headlinePrices(performingNote(), [12], { now })[0], solved.bid ?? 0, 0.01);
});

test("price on current LTV: a showable value estimate first, otherwise the seller's value, labelled", () => {
  assert.deepEqual(pricingValue(200000, { value: 180000, provider: "ATTOM", asOf: "2026-10-01T00:00:00Z" }), { value: 180000, source: "estimate", label: "ATTOM value estimate, Oct 1, 2026" });
  assert.equal(pricingValue(200000, { value: 180000, provider: "mock" }).label, "stand-in value estimate (demo data)");
  assert.deepEqual(pricingValue(200000, { value: null }), { value: 200000, source: "seller", label: "seller's value" });
  assert.equal(pricingValue(200000, null, { type: "BPO", asOf: "2026-06-01T00:00:00Z" }).label, "seller's value (BPO, Jun 1, 2026)");
  assert.equal(pricingValue(0, null).source, "none");
  close(currentLtv({ upb: 90000, lienPosition: "FIRST" }, 120000)?.pct, 75, 1e-9);
  // A junior's LTV counts the senior, assumed at 70% of value when unknown.
  const junior = currentLtv({ upb: 30000, lienPosition: "SECOND" }, 200000);
  close(junior?.pct, 85, 1e-9);
  assert.equal(junior?.combined, true);
  assert.equal(junior?.seniorAssumed, true);
  // The indicative's model prices on the estimate and says so; a lower value lowers a non-performing price.
  const npl: IndicativeNote = { ...performingNote(), paymentStatus: "NON_PERFORMING", monthsDelinquent: 10, state: "FL" };
  const onSeller = modelBand([npl], 12);
  const onEstimate = modelBand([{ ...npl, avm: { value: 120000, provider: "ATTOM", asOf: "2026-10-01T00:00:00Z" } }], 12);
  assert.match(onSeller?.valueBasis ?? "", /from the seller's value/);
  assert.match(onEstimate?.valueBasis ?? "", /from the ATTOM value estimate, Oct 1, 2026/);
  assert.ok((onEstimate?.mid ?? 0) < (onSeller?.mid ?? 0));
});

// ---------------------------------------------------------------------------------------------------------------
// The indicative range.

function performingNote(): IndicativeNote {
  return {
    upb: 100000,
    interestRate: 6,
    monthlyPi: 644.3,
    termMonths: 300,
    estimatedValue: 180000,
    state: "FL",
    paymentStatus: "PERFORMING",
    lienPosition: "FIRST",
  };
}

const cell = (count: number, median: number): CompCell => ({
  lienPosition: "FIRST",
  paymentStatus: "PERFORMING",
  place: "South",
  geo: "region",
  label: "First lien, performing, South",
  count,
  median,
  low: median - 8,
  high: median + 6,
  upbBand: "$100–250k",
});

test("the indicative range from the model alone is its price one point of IRR either side, at the default yield", () => {
  assert.equal(DEFAULT_INDICATIVE_YIELD, 12);
  assert.equal(SCHEMA_DEFAULT, 12);
  assert.deepEqual(indicativeTarget(null), { target: 12, assumed: true, label: "12% IRR, the desk's default" });
  assert.equal(indicativeTarget(10).label, "10% IRR, set by the desk");
  const range = indicativeRange({ notes: [performingNote()], now });
  assert.ok(range);
  const [at13, at12, at11] = headlinePrices(performingNote(), [13, 12, 11], { now });
  assert.equal(range.low, Math.floor(((at13 ?? 0) / 100000) * 100));
  assert.equal(range.high, Math.ceil(((at11 ?? 0) / 100000) * 100));
  assert.ok(range.low < range.high);
  assert.deepEqual(range.sources.map((row) => row.key), ["model"]);
  close(range.sources[0].ofUpb, ((at12 ?? 0) / 100000) * 100, 1e-9);
  assert.equal(range.sources[0].label, "Desk model at 11–13% IRR");
  assert.match(range.sources[0].basis, /12% IRR, the desk's default/);
  assert.equal(range.asOf, "2026-11-05");
  assert.match(range.basis, /as of Nov 5, 2026/);
  assert.match(range.disclaimer, /Not an appraisal, an offer or advice/);
  assert.equal(range.lowPrice, range.low * 1000);
  assert.equal(indicativeText(range), `indicative ${range.low}–${range.high}% of UPB`);
  // The buyer premium lowers the model's bid, as it does a standing yield rule.
  assert.ok((indicativeRange({ notes: [performingNote()], premiumBps: 250, now })?.sources[0].ofUpb ?? 0) < range.sources[0].ofUpb);
  // A desk-set yield moves the band.
  assert.ok((indicativeRange({ notes: [performingNote()], targetYield: 9, now })?.low ?? 0) > range.high);
  // Nothing to price, nothing to show.
  assert.equal(indicativeRange({ notes: [], now }), null);
  assert.equal(indicativeRange({ notes: [{ ...performingNote(), upb: 0 }], now }), null);
});

test("comps and standing bids widen the range, and a thin comp cell is left out", () => {
  const modelOnly = indicativeRange({ notes: [performingNote()], now });
  const full = indicativeRange({ notes: [performingNote()], comps: cell(5, 80), standing: [{ price: 70000 }, { price: 84000, pricedAt: "2026-11-04T00:00:00Z" }], now });
  assert.ok(modelOnly && full);
  assert.deepEqual(full.sources.map((row) => row.key), ["model", "comps", "standing"]);
  const comps = full.sources.find((row) => row.key === "comps");
  assert.equal(comps?.ofUpb, 80);
  assert.equal(comps?.label, "Median of 5 closed trades");
  assert.match(comps?.basis ?? "", /First lien, performing, South, closed on UPB in the 24 months to Nov 5, 2026/);
  const standing = full.sources.find((row) => row.key === "standing");
  assert.equal(standing?.ofUpb, 84);
  assert.equal(standing?.count, 2);
  assert.equal(standing?.label, "Top of 2 standing bids");
  assert.equal(standing?.asOf, "2026-11-04");
  assert.equal(full.low, modelOnly.low);
  assert.equal(full.high, 84);
  // Standing bids and comps alone still make a range.
  const noModel = indicativeRange({ notes: [{ ...performingNote(), monthlyPi: Number.NaN }], comps: cell(3, 66), standing: [{ price: 61000 }], now });
  assert.deepEqual(noModel?.sources.map((row) => row.key), ["comps", "standing"]);
  assert.deepEqual([noModel?.low, noModel?.high], [61, 66]);
  // Fewer than three trades never shows.
  assert.deepEqual(indicativeRange({ notes: [performingNote()], comps: cell(2, 99), now })?.sources.map((row) => row.key), ["model"]);
  assert.equal(indicativeText({ low: 61, high: 61 }), "indicative 61% of UPB");
});

test("no bidder identity reaches the indicative range or the seller's ladder", () => {
  const range = indicativeRange({ notes: [performingNote()], comps: cell(4, 72), standing: [{ price: 70000, rateAsOf: now, pricedAt: now }], now });
  const keys = new Set(range?.sources.flatMap((row) => Object.keys(row)));
  assert.deepEqual([...keys].sort(), ["asOf", "basis", "count", "high", "key", "label", "low", "ofUpb", "rate"]);
  assert.match(range?.sources.find((row) => row.key === "standing")?.basis ?? "", /No bidder is named/);
  const ladder = priceLadder({ upb: 100000, ask: 72000, standing: [{ price: 65400 }, { price: 68200 }, { price: 70900 }], now });
  assert.deepEqual(Object.keys(ladder.rows[0]).sort(), ["atOrAbove", "ofUpb", "price", "tags"]);
  // Rungs show a standing price only down to the whole percent.
  assert.deepEqual(ladder.rows.map((row) => row.ofUpb), [72, 70, 68, 65]);
});

test("the seller's ladder places the ask against standing demand", () => {
  const ladder = priceLadder({ upb: 100000, ask: 72000, standing: [{ price: 65400 }, { price: 68200 }, { price: 70900 }], comps: cell(4, 66), model: { low: 58, mid: 61, high: 64 }, fits: 5, now });
  assert.equal(ladder.summary, "At 72% of UPB, 3 standing bids would be below your ask; at 65% all would be at or above.");
  assert.equal(ladder.askOfUpb, 72);
  assert.equal(ladder.fits, 5);
  assert.deepEqual(ladder.rows.find((row) => row.ofUpb === 72)?.tags, ["Your ask"]);
  assert.equal(ladder.rows.find((row) => row.ofUpb === 72)?.atOrAbove, 0);
  assert.equal(ladder.rows.find((row) => row.ofUpb === 65)?.atOrAbove, 3);
  assert.deepEqual(ladder.rows.find((row) => row.ofUpb === 66)?.tags, ["Comps median"]);
  assert.deepEqual(ladder.rows.find((row) => row.ofUpb === 61)?.tags, ["Desk model at 12%"]);
  assert.equal(ladderSummary(60, [65.4, 70.9]), "At 60% of UPB, all 2 standing bids would be at or above your ask.");
  assert.equal(ladderSummary(70, [65.4, 70.9]), "At 70% of UPB, 1 standing bid would be below your ask; at 65% all would be at or above.");
  assert.equal(ladderSummary(72, [65.4]), "At 72% of UPB, the one standing bid would be below your ask; at 65% it would be at or above.");
  assert.equal(ladderSummary(72, []), "No standing bid fits this paper yet.");
  // A spread-priced standing bid on an old rate says so.
  assert.equal(priceLadder({ upb: 100000, ask: 72000, standing: [{ price: 70000, rateAsOf: new Date("2026-10-01T00:00:00Z") }], now }).rate?.stale, true);
});

// ---------------------------------------------------------------------------------------------------------------
// The database: a spread rule's match carries the rate's date, a stale one flags on the sheet, and the listing's
// indicative never names the buyer. Timestamp-tagged records only, deleted afterwards. The shared settings row's
// rate fields are saved first and put back.

async function makeSpreadTape() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  // A code no other test's boxes cover, so this box and that test's tapes never meet when the files run together.
  const state = "QX";
  const user = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN", pro = false) =>
    prisma.user.create({
      data: {
        email: `ix-${prefix}-${tag}@example.org`,
        name: `Ix ${prefix} ${tag}`,
        companyName: `Ix Co ${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(pro ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const seller = await user("seller", "INDIVIDUAL_SELLER");
  const buyer = await user("buyer", "BUYER", true);
  const desk = await user("desk", "ADMIN");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED", entityName: `Ix Fund ${tag}` } });
  const note = (street: string, upb: number) => ({
    streetAddress: street, city: "Testville", state, zip: "00000", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST", upb, interestRate: 7, monthlyPi: 775.3, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: upb * 0.9, estimatedValue: upb * 1.5,
  });
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: "SUBMITTED",
      title: `Spread tape ${tag}`,
      notes: { create: [note("1 First St", 100000), note("2 Second St", 60000)] as never },
    },
    include: { notes: true },
  });
  const box = await prisma.buyBox.create({
    data: { userId: buyer.id, name: `Ix Box ${tag}`, states: state, standingBids: true, bidBasis: "SPREAD", bidSpread: 7 },
  });
  return { tag, seller, buyer, desk, listing, box, users: [seller, buyer, desk] };
}

type Tape = Awaited<ReturnType<typeof makeSpreadTape>>;

async function cleanTape(tape: Tape) {
  const listingId = tape.listing.id;
  const userIds = tape.users.map((row) => row.id);
  const matches = await prisma.listingMatch.findMany({ where: { OR: [{ listingId }, { buyBoxId: tape.box.id }] }, select: { id: true } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [listingId, ...matches.map((row) => row.id)] } }, { actorId: { in: userIds } }] } });
  await prisma.listingMatch.deleteMany({ where: { id: { in: matches.map((row) => row.id) } } });
  await prisma.buyBox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.note.deleteMany({ where: { listingId } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: tape.users.map((row) => row.email) } }, { subject: { contains: tape.tag } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function setRate(rate: number | null, asOf: Date | null) {
  await prisma.platformSettings.update({ where: { id: "default" }, data: { tenYearRate: rate, tenYearAsOf: asOf } });
  clearSettingsCache();
}

test("a spread rule's match is priced on the desk's rate, stamped with its date, and flagged once stale", async () => {
  clearSettingsCache();
  const settings = await getSettings();
  const saved = { rate: settings.tenYearRate ?? null, asOf: settings.tenYearAsOf ?? null };
  const tape = await makeSpreadTape();
  const matchOf = () => prisma.listingMatch.findUniqueOrThrow({ where: { listingId_buyBoxId: { listingId: tape.listing.id, buyBoxId: tape.box.id } } });
  const expectedAt = (target: number) =>
    tape.listing.notes.reduce(
      (sum, note) => sum + Math.round(yieldPrice({ upb: note.upb, annualRate: 7, monthlyPi: 775.3, termMonths: remainingTerm(note.maturityDate, new Date()) }, target, settings.buyerPremiumBps) ?? 0),
      0,
    );
  try {
    const fresh = new Date(Date.now() - 2 * DAY);
    await setRate(4.95, fresh);
    await rescoreListing(tape.listing.id, false);
    const first = await matchOf();
    assert.equal(first.indicativePrice, expectedAt(11.95));
    assert.equal(first.rateAsOf?.toISOString(), fresh.toISOString());
    assert.match(first.reasons, /At the standing price/);
    let row = (await standingSheet(tape.listing)).find((item) => item.matchId === first.id);
    assert.equal(row?.rateStale, false);
    assert.match(row?.rule ?? "", /10-year Treasury \+ 7 points, an 11\.95% IRR on the 4\.95% rate as of/);

    // The same rate read on a later day moves only the stamp, so an invite the desk sent stays good.
    await prisma.listing.update({ where: { id: tape.listing.id }, data: { status: "APPROVED", approvedAt: new Date() } });
    assert.equal((await inviteToConfirm(first.id, tape.listing.id, tape.desk.id)).error, null);
    const later = new Date(Date.now() - DAY);
    await setRate(4.95, later);
    await rescoreBox(tape.box.id, { quiet: true });
    const restamped = await matchOf();
    assert.equal(restamped.indicativePrice, first.indicativePrice);
    assert.equal(restamped.rateAsOf?.toISOString(), later.toISOString());
    assert.ok(restamped.invitedAt);

    // A hike on a rate read ten days ago: a lower price, the old invite withdrawn, and the stamp flagged stale.
    const old = new Date(Date.now() - 10 * DAY);
    await setRate(5.2, old);
    await rescoreBox(tape.box.id, { quiet: true });
    const hiked = await matchOf();
    assert.equal(hiked.indicativePrice, expectedAt(12.2));
    assert.ok((hiked.indicativePrice ?? 0) < (first.indicativePrice ?? 0));
    assert.equal(hiked.invitedAt, null);
    assert.equal(hiked.rateAsOf?.toISOString(), old.toISOString());
    row = (await standingSheet({ ...tape.listing, status: "APPROVED" })).find((item) => item.matchId === hiked.id);
    assert.equal(row?.rateStale, true);

    // The listing's indicative carries the top standing bid and its stale stamp, and names nobody.
    const indicative = await loadIndicative(tape.listing.id);
    const standing = indicative?.sources.find((source) => source.key === "standing");
    close(standing?.ofUpb, ((hiked.indicativePrice ?? 0) / 160000) * 100, 1e-9);
    assert.equal(standing?.rate?.stale, true);
    const text = JSON.stringify(indicative);
    for (const secret of [tape.buyer.id, tape.buyer.name, tape.buyer.email, tape.buyer.companyName ?? "", `Ix Fund ${tape.tag}`, tape.box.id, tape.box.name, hiked.id]) {
      assert.equal(text.includes(secret), false, `the indicative leaked ${secret}`);
    }

    // The seller's view of standing demand finds this box's own figure before the ask caps it, and no name.
    const draft = tape.listing.notes.map((note) => ({ ...note, askingPrice: note.upb * 0.5 }));
    const demand = await standingDemand("POOL", draft);
    assert.ok(demand.standing.some((point) => point.price === expectedAt(12.2)));
    assert.ok(demand.fits >= 1);
    const demandText = JSON.stringify(demand);
    for (const secret of [tape.buyer.id, tape.buyer.name, tape.box.id, tape.box.name]) assert.equal(demandText.includes(secret), false);
    // scoreMatch is what both share: priced at the box's figure, with the rate's date.
    const scored = scoreMatch("POOL", draft, { ...tape.box, user: tape.buyer }, draft.map((note) => ({ ...note, termMonths: 240 })), new Date(), settings.buyerPremiumBps, { rate: 5.2, asOf: old }, { ignoreAsk: true });
    assert.equal(scored.rateAsOf?.toISOString(), old.toISOString());

    // With no rate on file, a spread rule prices nothing and its stamp clears.
    await setRate(null, null);
    await rescoreBox(tape.box.id, { quiet: true });
    const cleared = await matchOf();
    assert.equal(cleared.indicativePrice, null);
    assert.equal(cleared.rateAsOf, null);
    row = (await standingSheet({ ...tape.listing, status: "APPROVED" })).find((item) => item.matchId === cleared.id);
    assert.equal(row?.why, NO_RATE);
  } finally {
    await setRate(saved.rate, saved.asOf);
    await cleanTape(tape);
  }
});
