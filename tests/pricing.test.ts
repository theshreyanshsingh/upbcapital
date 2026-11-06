import assert from "node:assert/strict";
import test from "node:test";
import { MIN_TRADES, compCells, compsFor, marketView, regionOf, tradeFromLoans, upbBand, type ClosedTrade } from "../lib/comps";
import { FORECLOSURE_TABLE, foreclosureFor, processCost, stateCode } from "../lib/foreclosure";
import { US_STATES } from "../lib/labels";
import {
  annualize,
  cashIn,
  expectedFlows,
  irrPct,
  monthlyIrr,
  nplCases,
  nplOutcomes,
  priceForPool,
  priceForYield,
  projectFlows,
  quantileDots,
  scenarioWeights,
  weightedQuantile,
  yieldAtPrice,
  type PricingNote,
} from "../lib/underwriting";

const close = (actual: number | null | undefined, expected: number, tolerance: number) => {
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

const performing: PricingNote = {
  upb: 100000,
  interestRate: 6,
  monthlyPi: 644.3,
  termMonths: 300,
  estimatedValue: 180000,
  state: "FL",
  paymentStatus: "PERFORMING",
  lienPosition: "FIRST",
};

const npl = (state: string): PricingNote => ({
  upb: 150000,
  interestRate: 7,
  monthlyPi: 1000,
  estimatedValue: 250000,
  state,
  paymentStatus: "NON_PERFORMING",
  occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST",
  monthsDelinquent: 14,
});

test("the foreclosure table covers all 50 states and DC, each with a source", () => {
  assert.deepEqual(Object.keys(FORECLOSURE_TABLE).sort(), [...US_STATES].sort());
  assert.equal(Object.keys(FORECLOSURE_TABLE).length, 51);
  for (const [code, rule] of Object.entries(FORECLOSURE_TABLE)) {
    assert.ok(rule.process === "Judicial" || rule.process === "Non-judicial", code);
    assert.ok(rule.days > 0 && rule.months === Math.round(rule.days / 30.44), code);
    assert.ok(rule.cost >= 4500, code);
    assert.ok(rule.law.length > 5 && rule.source.length > 10 && rule.asOf, code);
    assert.ok(rule.basis === "ATTOM" || rule.basis === "Desk estimate", code);
    assert.equal(foreclosureFor(code).assumed, false);
  }
  // ATTOM's ten published Q2 2026 states carry its figures exactly.
  assert.equal(FORECLOSURE_TABLE.LA.days, 3491);
  assert.equal(FORECLOSURE_TABLE.TX.days, 155);
  assert.equal(FORECLOSURE_TABLE.TX.basis, "ATTOM");
  assert.match(FORECLOSURE_TABLE.TX.source, /Q2 2026/);
  assert.equal(FORECLOSURE_TABLE.FL.basis, "Desk estimate");
});

test("New York is a judicial state of well over 1,500 days", () => {
  const rule = foreclosureFor("NY");
  assert.ok(rule.days > 1500);
  assert.equal(rule.process, "Judicial");
  assert.ok(rule.months > 60);
  assert.equal(foreclosureFor("New York").state, "NY");
  assert.equal(stateCode(" ny "), "NY");
  // Longer cases cost more to run, within the cap.
  assert.ok(rule.cost > FORECLOSURE_TABLE.TX.cost);
  assert.equal(processCost("Judicial", 10000), 21000);
});

test("unknown codes get the national average, never another state", () => {
  for (const code of ["PR", "", "Narnia"]) {
    const rule = foreclosureFor(code);
    assert.equal(rule.assumed, true);
    assert.equal(rule.basis, "National average");
    assert.notEqual(rule.state, "FL");
  }
});

test("the performing solver round-trips: the IRR at the solved bid is the target", () => {
  for (const target of [6, 9, 12, 18]) {
    const solved = priceForYield(performing, target);
    assert.ok(solved.bid != null && solved.bid > 0);
    const flows = projectFlows({ bid: solved.bid, upb: 100000, annualRate: 6, monthlyPi: 644.3, termMonths: 300 });
    close(annualize(monthlyIrr(flows)), target, 0.01);
    close(yieldAtPrice(performing, solved.bid).irrPct, target, 0.01);
    close(solved.pctOfUpb, (solved.bid / 100000) * 100, 1e-9);
    close(solved.pctOfValue, (solved.bid / 180000) * 100, 1e-9);
  }
  // At the note rate the price is about par, and a higher target pays less.
  close(priceForYield(performing, annualize(0.005) as number).bid, 100000, 5);
  assert.ok((priceForYield(performing, 14).bid ?? 0) < (priceForYield(performing, 10).bid ?? 0));
});

test("fees are part of the cash in, so the solved bid falls by them", () => {
  const costs = { premiumBps: 100, closingCost: 1500 };
  const gross = priceForYield(performing, 10).bid ?? 0;
  const net = priceForYield(performing, 10, costs).bid ?? 0;
  close(cashIn(net, costs), gross, 0.05);
  close(yieldAtPrice(performing, net, costs).irrPct, 10, 0.01);
});

test("the non-performing solver round-trips on the weighted resolutions", () => {
  for (const state of ["NY", "TX", "FL"]) {
    const solved = priceForYield(npl(state), 15);
    assert.ok(solved.bid != null && solved.bid > 0, state);
    close(yieldAtPrice(npl(state), solved.bid).irrPct, 15, 0.01);
    // Each resolution's own price returns the target on that resolution's flows.
    for (const row of solved.scenarios.filter((item) => item.bid != null && item.bid > 0)) {
      const cases = nplCases({
        bid: row.bid as number,
        upb: 150000,
        value: 250000,
        monthlyPi: 1000,
        monthsDelinquent: 14,
        foreclosureMonths: foreclosureFor(state).months,
        foreclosureCost: foreclosureFor(state).cost,
        process: foreclosureFor(state).process,
        occupancy: "OWNER_OCCUPIED",
        lienPosition: "FIRST",
      });
      close(cases.find((item) => item.key === row.key)?.irrPct, 15, 0.01);
    }
    assert.ok(solved.range && solved.range.p10 <= solved.range.p50 && solved.range.p50 <= solved.range.p90);
    assert.equal(solved.dots.length, 20);
    assert.ok(solved.timeline && solved.timeline.state === state);
  }
});

test("a longer foreclosure timeline lowers the price for the same yield", () => {
  const ny = priceForYield(npl("NY"), 15).bid ?? 0;
  const fl = priceForYield(npl("FL"), 15).bid ?? 0;
  const tx = priceForYield(npl("TX"), 15).bid ?? 0;
  assert.ok(ny < fl && fl < tx, `${ny} ${fl} ${tx}`);
  // A foreclosure already two years in has less of the New York timeline left to carry.
  const filed = new Date();
  filed.setMonth(filed.getMonth() - 24);
  assert.ok((priceForYield({ ...npl("NY"), foreclosureFiledAt: filed }, 15).bid ?? 0) > ny);
});

test("the scenario weights sum to 1 for every occupancy, lien and delinquency", () => {
  for (const occupancy of ["OWNER_OCCUPIED", "TENANT", "VACANT", "UNKNOWN", null]) {
    for (const lienPosition of ["FIRST", "SECOND", "THIRD", "OTHER", null]) {
      for (const monthsDelinquent of [0, 2, 6, 14, 30]) {
        const { weights, basis } = scenarioWeights({ occupancy, lienPosition, monthsDelinquent });
        close(Object.values(weights).reduce((sum, weight) => sum + weight, 0), 1, 1e-9);
        assert.ok(Object.values(weights).every((weight) => weight >= 0));
        assert.match(basis, /behind/);
      }
    }
  }
  const owner = scenarioWeights({ occupancy: "OWNER_OCCUPIED", lienPosition: "FIRST", monthsDelinquent: 6 }).weights;
  const vacant = scenarioWeights({ occupancy: "VACANT", lienPosition: "FIRST", monthsDelinquent: 6 }).weights;
  assert.ok(vacant.foreclosure > owner.foreclosure);
  const fresh = scenarioWeights({ occupancy: "OWNER_OCCUPIED", lienPosition: "FIRST", monthsDelinquent: 2 }).weights;
  const stale = scenarioWeights({ occupancy: "OWNER_OCCUPIED", lienPosition: "FIRST", monthsDelinquent: 30 }).weights;
  assert.ok(fresh.reinstatement > stale.reinstatement);
  // Fifteen outcomes, five resolutions at three timelines, and their weights also sum to 1.
  const outcomes = nplOutcomes({ bid: 80000, upb: 150000, value: 250000, monthlyPi: 1000, monthsDelinquent: 14, foreclosureMonths: 25, foreclosureCost: 12000, process: "Judicial" });
  assert.equal(outcomes.length, 15);
  close(outcomes.reduce((sum, row) => sum + row.weight, 0), 1, 1e-9);
  close(expectedFlows(outcomes)[0], -80000, 1e-6);
});

test("a junior lien with no equity is wiped out, and a sale never pays more than the debt", () => {
  const base = { bid: 5000, upb: 50000, value: 200000, monthlyPi: 450, monthsDelinquent: 20, foreclosureMonths: 7, foreclosureCost: 4500, process: "Non-judicial" };
  const junior = nplCases({ ...base, lienPosition: "SECOND", seniorBalance: 190000 });
  const wiped = junior.find((row) => row.key === "foreclosure");
  assert.equal(wiped?.recovery, 0);
  assert.equal(wiped?.irrPct, -100);
  // A first lien at 25% LTV recovers its claim, not the house.
  const first = nplCases({ ...base, lienPosition: "FIRST" }).find((row) => row.key === "foreclosure");
  assert.ok(first && first.recovery < 200000 * 0.75 * 0.92);
  assert.ok(first && first.recovery <= 50000 + (20 + first.months) * 450 + first.cost + 1);
});

test("weighted quantiles and dots read the distribution", () => {
  const points = [
    { value: 1, weight: 0.5 },
    { value: 10, weight: 0.3 },
    { value: 100, weight: 0.2 },
  ];
  assert.equal(weightedQuantile(points, 0.1), 1);
  assert.equal(weightedQuantile(points, 0.5), 1);
  assert.equal(weightedQuantile(points, 0.6), 10);
  assert.equal(weightedQuantile(points, 0.9), 100);
  const dots = quantileDots(points);
  assert.equal(dots.length, 20);
  assert.deepEqual([dots.filter((dot) => dot === 1).length, dots.filter((dot) => dot === 10).length, dots.filter((dot) => dot === 100).length], [10, 6, 4]);
  assert.equal(irrPct([-100, -5, -5]), -100);
});

test("a pool's price is the sum of its loans' prices", () => {
  const pool = priceForPool([performing, npl("TX")], 12);
  const sum = (priceForYield(performing, 12).bid ?? 0) + (priceForYield(npl("TX"), 12).bid ?? 0);
  close(pool.bid, sum, 0.01);
  close(pool.pctOfUpb, (sum / 250000) * 100, 1e-9);
});

const at = new Date("2026-10-01T00:00:00Z");
const trade = (state: string, lien: string, status: string, ratio: number, upb = 100000, closedAt = at): ClosedTrade => ({
  state,
  lienPosition: lien,
  paymentStatus: status,
  upb,
  price: upb * ratio,
  closedAt,
});

test("comps suppress any cell with fewer than three trades", () => {
  assert.equal(MIN_TRADES, 3);
  const trades = [
    trade("FL", "FIRST", "PERFORMING", 0.8),
    trade("FL", "FIRST", "PERFORMING", 0.7),
    trade("GA", "FIRST", "PERFORMING", 0.9, 300000),
    trade("NY", "FIRST", "NON_PERFORMING", 0.5),
    trade("NY", "FIRST", "NON_PERFORMING", 0.4),
  ];
  const byState = compCells(trades, "state");
  assert.equal(byState.cells.length, 0);
  assert.equal(byState.suppressed, 5);
  // The South has three performing first liens, so that cell shows; the Northeast's two do not.
  const byRegion = compCells(trades, "region");
  assert.equal(byRegion.cells.length, 1);
  assert.equal(byRegion.suppressed, 2);
  const south = byRegion.cells[0];
  assert.equal(south.place, "South");
  assert.equal(south.count, 3);
  assert.equal(south.median, 80);
  assert.equal(south.low, 70);
  assert.equal(south.high, 90);
  assert.equal(south.upbBand, "$100–250k");
  // A raised floor is honoured; a lowered one is not.
  assert.equal(compCells(trades, "region", 4).cells.length, 0);
  assert.equal(compCells(trades, "region", 1).cells.length, 1);
  // Nothing in a cell names a trade: no prices, dates or exact amounts.
  assert.deepEqual(Object.keys(south).sort(), ["count", "geo", "high", "label", "lienPosition", "low", "median", "paymentStatus", "place", "upbBand"]);
});

test("comps widen from state to region to all states until a cell has three trades", () => {
  const trades = [trade("FL", "FIRST", "PERFORMING", 0.8), trade("GA", "FIRST", "PERFORMING", 0.7), trade("TX", "FIRST", "PERFORMING", 0.9)];
  const region = compsFor({ state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING" }, trades);
  assert.equal(region?.geo, "region");
  const national = compsFor({ state: "CA", lienPosition: "FIRST", paymentStatus: "PERFORMING" }, [...trades, trade("CA", "FIRST", "PERFORMING", 0.6)]);
  assert.equal(national?.geo, "national");
  assert.equal(national?.count, 4);
  assert.equal(compsFor({ state: "FL", lienPosition: "SECOND", paymentStatus: "PERFORMING" }, trades), null);
  const state = compsFor({ state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING" }, [...trades, ...trades.map((row) => ({ ...row, state: "FL" }))]);
  assert.equal(state?.geo, "state");
  assert.equal(regionOf("dc"), "South");
  assert.equal(upbBand(49999), "Under $50k");
  assert.equal(upbBand(2_000_000), "$1M and up");
});

test("the market view keeps to its window, and mixed pools stay out", () => {
  const old = new Date("2023-01-01T00:00:00Z");
  const trades = [
    trade("FL", "FIRST", "PERFORMING", 0.8),
    trade("GA", "FIRST", "PERFORMING", 0.7),
    trade("TX", "FIRST", "PERFORMING", 0.9),
    trade("TX", "FIRST", "PERFORMING", 0.2, 100000, old),
  ];
  const view = marketView(trades, new Date("2026-11-05T00:00:00Z"));
  assert.equal(view.total, 3);
  assert.equal(view.asOf, "2026-11-05");
  assert.equal(view.national[0].count, 3);
  assert.equal(view.regional[0].median, 80);
  const mixed = tradeFromLoans(100000, [
    { upb: 60000, lienPosition: "FIRST", paymentStatus: "PERFORMING", state: "FL" },
    { upb: 40000, lienPosition: "SECOND", paymentStatus: "PERFORMING", state: "FL" },
  ], at);
  assert.equal(mixed, null);
  const pool = tradeFromLoans(90000, [
    { upb: 90000, lienPosition: "FIRST", paymentStatus: "PERFORMING", state: "fl" },
    { upb: 10000, lienPosition: "FIRST", paymentStatus: "PERFORMING", state: "GA" },
  ], at);
  assert.equal(pool?.state, "FL");
  assert.equal(pool?.upb, 100000);
});
