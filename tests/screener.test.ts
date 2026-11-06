import assert from "node:assert/strict";
import test from "node:test";
import {
  appliedChips,
  bookMatches,
  facetCount,
  FIGURE_KEYS,
  filtersFor,
  filtersFromSaved,
  filtersQuery,
  listingMatches,
  noteMatches,
  pageWindow,
  parseFilters,
  sortFor,
  sortRows,
  SORTS,
  stateCounts,
  toggleValue,
  type BookFilters,
  type MatchListing,
  type MatchNote,
} from "../lib/filters";
import { allInYield, bookVeil, compareColumn, listingFigures, loansForSale, type CompareListing, type CompareNote } from "../lib/metrics";

const loan = (overrides: Partial<MatchNote> = {}): MatchNote => ({
  city: "Tampa",
  state: "FL",
  paymentStatus: "PERFORMING",
  lienPosition: "FIRST",
  propertyType: "SFR",
  upb: 100000,
  askingPrice: 80000,
  tradeStatus: "AVAILABLE",
  occupancy: "OWNER_OCCUPIED",
  foreclosureStatus: "NONE",
  monthsDelinquent: 0,
  interestRate: 6,
  monthlyPi: 800,
  estimatedValue: 160000,
  modified: null,
  bankruptcyChapter: null,
  bankruptcyFiledAt: null,
  hoaLien: null,
  taxDelinquent: null,
  ...overrides,
});

const listing = (notes: MatchNote[], overrides: Partial<MatchListing> = {}): MatchListing => ({
  kind: notes.length > 1 ? "POOL" : "SINGLE",
  status: "APPROVED",
  bidMode: "NONE",
  bidDeadline: null,
  notes,
  ...overrides,
});

// The address bar as Next hands it over: repeated keys arrive as arrays.
const fromQuery = (search: URLSearchParams) => {
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    raw[key] = all.length > 1 ? all : all[0];
  }
  return raw;
};

test("filters read lists, typed figures and flags, and drop anything they don't know", () => {
  const filters = parseFilters({
    state: "fl",
    paymentStatus: ["PERFORMING", "NOT_A_STATUS", "SUB_PERFORMING"],
    lienPosition: "FIRST,SECOND",
    occupancy: "VACANT",
    foreclosureStatus: ["LIS_PENDENS"],
    upbMin: "$250k",
    ptuMax: "70%",
    rateMin: "4.5",
    dlqMin: "0",
    dlqMax: "0",
    modified: "yes",
    bankruptcy: "maybe",
    deadline: "no",
    bidMode: "SEALED",
    kind: "LOAN",
    status: "PENDING",
    q: "  Tampa ",
    priceMax: "about a million",
  });
  assert.deepEqual(filters, {
    state: "FL",
    paymentStatus: ["PERFORMING", "SUB_PERFORMING"],
    lienPosition: ["FIRST", "SECOND"],
    upbMin: 250000,
    q: "Tampa",
    occupancy: ["VACANT"],
    foreclosureStatus: ["LIS_PENDENS"],
    dlqMax: 0,
    modified: "yes",
    bidMode: ["SEALED"],
    deadline: "no",
    status: "PENDING",
    rateMin: 4.5,
    ptuMax: 70,
  });
  assert.deepEqual(parseFilters({ state: "ZZ", kind: "POOL", dlqMax: "-1", yieldMin: "0" }), { kind: "POOL" });
});

test("a view's address and a saved search read back to the same filters", () => {
  const filters: BookFilters = parseFilters({ state: "TX", lienPosition: ["SECOND", "FIRST"], occupancy: "TENANT", priceMax: "90000", yieldMin: "9", taxDelinquent: "no" });
  assert.deepEqual(parseFilters(fromQuery(filtersQuery(filters))), filters);
  // The page posts JSON.stringify(applied); saveSearch turns each value into a string before parsing it.
  const posted = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(filters))).map(([key, value]) => [key, String(value)]));
  assert.deepEqual(parseFilters(posted), filters);
  // An older saved search held single strings and every key, the empty ones as undefined.
  assert.deepEqual(filtersFromSaved({ state: "TX", paymentStatus: "PERFORMING", upbMin: 50000 }), { state: "TX", paymentStatus: ["PERFORMING"], upbMin: 50000 });
  assert.deepEqual(filtersFromSaved("not an object"), {});
  // The order is fixed, so one view has one address.
  assert.equal(filtersQuery({ yieldMin: 9, state: "TX" }).toString(), filtersQuery({ state: "TX", yieldMin: 9 }).toString());
});

test("each new filter matches the loan file, and a list matches any of its values", () => {
  const vacant = loan({ occupancy: "VACANT", foreclosureStatus: "LIS_PENDENS", monthsDelinquent: 7, paymentStatus: "NON_PERFORMING", interestRate: 9 });
  assert.equal(noteMatches(vacant, { occupancy: ["VACANT", "TENANT"] }), true);
  assert.equal(noteMatches(vacant, { occupancy: "OWNER_OCCUPIED" }), false);
  assert.equal(noteMatches(vacant, { foreclosureStatus: ["LIS_PENDENS"] }), true);
  assert.equal(noteMatches(vacant, { dlqMin: 6, dlqMax: 12 }), true);
  assert.equal(noteMatches(vacant, { dlqMax: 0 }), false);
  assert.equal(noteMatches(loan(), { dlqMax: 0 }), true);
  assert.equal(noteMatches(vacant, { rateMin: 8, rateMax: 10 }), true);
  assert.equal(noteMatches(vacant, { rateMax: 8 }), false);
  assert.equal(noteMatches(vacant, { paymentStatus: ["PERFORMING", "NON_PERFORMING"] }), true);

  // "No" means the tape doesn't mark it.
  assert.equal(noteMatches(loan({ modified: true }), { modified: "yes" }), true);
  assert.equal(noteMatches(loan({ modified: false }), { modified: "yes" }), false);
  assert.equal(noteMatches(loan({ modified: null }), { modified: "no" }), true);
  assert.equal(noteMatches(loan({ bankruptcyChapter: "13" }), { bankruptcy: "yes" }), true);
  assert.equal(noteMatches(loan({ bankruptcyFiledAt: new Date("2026-03-01") }), { bankruptcy: "no" }), false);
  assert.equal(noteMatches(loan({ hoaLien: true }), { hoaLien: "yes" }), true);
  assert.equal(noteMatches(loan({ taxDelinquent: true }), { taxDelinquent: "no" }), false);

  // A caller that passes only the card's fields can't match a filter on the file.
  const cardOnly: MatchNote = { city: "Tampa", state: "FL", paymentStatus: "PERFORMING", lienPosition: "FIRST", propertyType: "SFR", upb: 1, askingPrice: 1 };
  for (const filters of [{ occupancy: "VACANT" }, { dlqMax: 3 }, { rateMin: 1 }, { modified: "no" as const }, { bankruptcy: "no" as const }]) {
    assert.equal(noteMatches(cardOnly, filters), false, JSON.stringify(filters));
  }
  assert.equal(listingMatches({ kind: "SINGLE", notes: [cardOnly] }, { bidMode: "SEALED" }), false);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [cardOnly] }, { ptuMax: 90 }), false);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [cardOnly] }, {}), true);
});

test("sale filters read the listing, and a pool's ratio, yield and value are its totals for sale", () => {
  const sealed = listing([loan()], { bidMode: "SEALED", bidDeadline: new Date("2026-12-01") });
  assert.equal(listingMatches(sealed, { bidMode: ["SEALED", "BEST_AND_FINAL"] }), true);
  assert.equal(listingMatches(sealed, { bidMode: "NONE" }), false);
  assert.equal(listingMatches(sealed, { deadline: "yes" }), true);
  assert.equal(listingMatches(listing([loan()]), { deadline: "yes" }), false);
  assert.equal(listingMatches(listing([loan()]), { deadline: "no" }), true);
  assert.equal(listingMatches(sealed, { status: "PENDING" }), false);

  // Two loans for sale at 80% of UPB and one sold at 20%: the pool prices at 80%.
  const pool = listing([loan(), loan({ city: "Atlanta", state: "GA", occupancy: "VACANT" }), loan({ askingPrice: 20000, tradeStatus: "SOLD" })]);
  assert.equal(listingMatches(pool, { ptuMin: 79, ptuMax: 81 }), true);
  assert.equal(listingMatches(pool, { ptuMax: 60 }), false);
  // 9,600 a year on 80,000 asked, per loan: 12% current yield on the pool.
  assert.equal(listingMatches(pool, { yieldMin: 11.9 }), true);
  assert.equal(listingMatches(pool, { valueMin: 320000, valueMax: 320000 }), true);
  // Place and file facts can match any one loan still for sale.
  assert.equal(listingMatches(pool, { state: "GA", occupancy: "VACANT" }), true);
  assert.equal(listingMatches(pool, { state: "FL", occupancy: "VACANT" }), false);
  const npl = listing([loan({ paymentStatus: "NON_PERFORMING" })]);
  assert.equal(listingMatches(npl, { yieldMin: 1 }), false);
});

test("figure filters and metric sorts stay Pro only", () => {
  const every = Object.fromEntries(FIGURE_KEYS.map((key) => [key, 5])) as BookFilters;
  const free = filtersFor({ ...every, state: "FL", occupancy: ["VACANT"] }, false);
  for (const key of FIGURE_KEYS) assert.equal(free[key], undefined, key);
  assert.equal(free.state, "FL");
  assert.deepEqual(free.occupancy, ["VACANT"]);
  assert.deepEqual(filtersFor(every, true), every);

  for (const sort of SORTS) {
    const asFree = sortFor(sort.value, undefined, false);
    assert.equal(asFree.key, sort.pro ? "new" : sort.value, sort.value);
    assert.equal(sortFor(sort.value, undefined, true).key, sort.value);
  }
  assert.deepEqual(sortFor("yield", "asc", false), { key: "new", dir: "desc" });
  assert.deepEqual(sortFor("yield", "asc", true), { key: "yield", dir: "asc" });
  assert.deepEqual(sortFor("discount", "sideways", true), { key: "discount", dir: "asc" });
  assert.deepEqual(sortFor("not-a-sort", undefined, true), { key: "new", dir: "desc" });

  const row = (id: string, approvedAt: number, yieldPct: number | null, deadline: number | null = null) => ({
    id,
    approvedAt,
    deadline,
    state: "FL",
    figures: { upb: 1, asking: 1, value: 1, priceToUpb: 50, yield: yieldPct },
  });
  const rows = [row("a", 1, 8), row("b", 3, null, 50), row("c", 2, 12, 10)];
  assert.deepEqual(sortRows(rows, { key: "yield", dir: "desc" }).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(sortRows(rows, { key: "yield", dir: "asc" }).map((item) => item.id), ["a", "c", "b"]);
  assert.deepEqual(sortRows(rows, { key: "new", dir: "desc" }).map((item) => item.id), ["b", "c", "a"]);
  assert.deepEqual(sortRows(rows, { key: "deadline", dir: "asc" }).map((item) => item.id), ["c", "b", "a"]);
});

test("a held listing drops out on file filters instead of telling a free member what its file says", () => {
  const vacant = listing([loan({ occupancy: "VACANT" })]);
  assert.equal(bookMatches(vacant, { occupancy: "VACANT" }, false), true);
  assert.equal(bookMatches(vacant, { occupancy: "VACANT" }, true), false);
  assert.equal(bookMatches(vacant, { occupancy: "OWNER_OCCUPIED" }, true), false);
  // Card facts still screen a held listing, since its card shows them.
  assert.equal(bookMatches(vacant, { state: "FL", lienPosition: "FIRST" }, true), true);

  const rows = [
    { listing: vacant, held: true },
    { listing: listing([loan({ occupancy: "VACANT", lienPosition: "SECOND" })]), held: false },
    { listing: listing([loan(), loan({ state: "GA" })]), held: false },
  ];
  assert.equal(facetCount(rows, { occupancy: "VACANT" }, "lienPosition", "FIRST"), 0);
  assert.equal(facetCount(rows, {}, "lienPosition", "FIRST"), 2);
  assert.equal(facetCount(rows, { lienPosition: "SECOND" }, "lienPosition", "FIRST"), 2);
  assert.equal(facetCount(rows, {}, "kind", "POOL"), 1);
  // The map ignores the state filter and counts a pool in each state it lends in.
  const counts = stateCounts(rows, { state: "GA" });
  assert.equal(counts.get("FL"), 3);
  assert.equal(counts.get("GA"), 1);
  assert.equal(stateCounts(rows, { occupancy: "VACANT" }).get("FL"), 1);
});

test("chips toggle and remove filters in words a buyer reads", () => {
  assert.deepEqual(toggleValue({ lienPosition: ["FIRST"] }, "lienPosition", "SECOND"), { lienPosition: ["FIRST", "SECOND"] });
  assert.deepEqual(toggleValue({ lienPosition: ["FIRST"] }, "lienPosition", "FIRST"), { lienPosition: undefined });
  const chips = appliedChips({ state: "FL", paymentStatus: ["PERFORMING"], dlqMax: 0, upbMin: 50000, upbMax: 200000, modified: "no", deadline: "yes" });
  assert.deepEqual(chips.map((chip) => chip.label), ["FL", "Performing", "Not marked modified", "Dated deadline", "Current, 0 months late", "UPB $50,000 to $200,000"]);
  const upb = chips.find((chip) => chip.label.startsWith("UPB"));
  assert.equal(upb?.without.upbMin, undefined);
  assert.equal(upb?.without.upbMax, undefined);
  assert.equal(upb?.without.state, "FL");
});

const compareNote = (overrides: Partial<CompareNote> = {}): CompareNote => ({
  upb: 100000,
  askingPrice: 80000,
  estimatedValue: 160000,
  monthlyPi: 800,
  interestRate: 6,
  paymentStatus: "PERFORMING",
  tradeStatus: "AVAILABLE",
  city: "Tampa",
  state: "FL",
  lienPosition: "FIRST",
  propertyType: "SFR",
  occupancy: "VACANT",
  foreclosureStatus: "NONE",
  monthsDelinquent: 0,
  modified: true,
  bankruptcyChapter: null,
  bankruptcyFiledAt: null,
  hoaLien: null,
  taxDelinquent: null,
  ...overrides,
});

const compareListing = (overrides: Partial<CompareListing> = {}): CompareListing => ({
  id: "l1",
  title: "Tampa first",
  kind: "SINGLE",
  status: "APPROVED",
  bidMode: "SEALED",
  bidDeadline: new Date("2026-12-01T17:00:00Z"),
  notes: [compareNote()],
  ...overrides,
});

test("compare veils each listing the way its own page and card do", () => {
  const open = compareColumn(compareListing(), { ok: true }, false);
  assert.equal(open.hidden, false);
  assert.equal(open.figures, null);
  assert.equal(open.file?.occupancy, "VACANT");
  assert.deepEqual(open.file?.modified, { flagged: 1, of: 1 });
  assert.equal(open.file?.hoaLien, null);
  assert.equal(open.card?.deadline, "2026-12-01T17:00:00.000Z");

  const pro = compareColumn(compareListing(), { ok: true }, true);
  assert.equal(pro.figures?.asking, 80000);
  assert.equal(pro.figures?.priceToUpb, 80);

  // Held for early access or the free slice: the card's facts only, never the file or the figures.
  for (const reason of ["early", "limit"]) {
    const held = compareColumn(compareListing(), { ok: false, reason }, true);
    assert.equal(held.hold, reason);
    assert.equal(held.title, "Tampa first");
    assert.equal(held.card?.lien, "FIRST");
    assert.equal(held.file, null);
    assert.equal(held.figures, null);
  }
  // Off the open book: nothing at all, not even the title.
  for (const reason of ["unpublished", "account"]) {
    const off = compareColumn(compareListing(), { ok: false, reason }, true);
    assert.deepEqual([off.hidden, off.title, off.card, off.file, off.figures], [true, "", null, null, null]);
  }

  // A pool compares the loans still for sale, and says when its loans differ.
  const pool = compareColumn(compareListing({
    kind: "POOL",
    bidMode: "NONE",
    notes: [compareNote(), compareNote({ state: "GA", lienPosition: "SECOND", monthsDelinquent: 4 }), compareNote({ askingPrice: 1, tradeStatus: "SOLD" })],
  }), { ok: true }, true);
  assert.equal(pool.card?.loanCount, 2);
  assert.deepEqual(pool.card?.states, ["FL", "GA"]);
  assert.equal(pool.card?.lien, null);
  assert.equal(pool.card?.deadline, null);
  assert.deepEqual(pool.file?.monthsDelinquent, [0, 4]);
  assert.equal(pool.figures?.asking, 160000);
});

test("the book's veil matches the card: free members see no figures, and sold paper is never held", () => {
  assert.deepEqual(bookVeil({ sold: false, pro: true, early: true, openable: false }), { hold: null, figures: true });
  assert.deepEqual(bookVeil({ sold: false, pro: false, early: true, openable: true }), { hold: "early", figures: false });
  assert.deepEqual(bookVeil({ sold: false, pro: false, early: false, openable: false }), { hold: "limit", figures: false });
  assert.deepEqual(bookVeil({ sold: false, pro: false, early: false, openable: true }), { hold: null, figures: false });
  assert.deepEqual(bookVeil({ sold: true, pro: false, early: true, openable: false }), { hold: null, figures: false });
  const notes = [{ tradeStatus: "SOLD" }, { tradeStatus: "AVAILABLE" }];
  assert.equal(loansForSale("APPROVED", notes).length, 1);
  assert.equal(loansForSale("SOLD", notes).length, 2);
});

test("yield on the all-in price is the same income over the ask plus the premium", () => {
  const figures = listingFigures("SINGLE", [compareNote()]);
  assert.equal(figures.yield, 12);
  assert.ok(Math.abs((allInYield(figures.yield, 250) ?? 0) - 12 / 1.025) < 1e-9);
  assert.equal(allInYield(null, 250), null);
});

test("pagination stays inside the pages there are, so the count line is always true", () => {
  assert.deepEqual(pageWindow(31, "2", 12), { page: 2, pageCount: 3, start: 12, end: 24, first: 13 });
  assert.deepEqual(pageWindow(31, "3", 12), { page: 3, pageCount: 3, start: 24, end: 31, first: 25 });
  for (const raw of ["999", "Infinity"]) assert.equal(pageWindow(31, raw, 12).page, raw === "999" ? 3 : 1);
  for (const raw of ["0", "-4", "abc", "", undefined, "1.9"]) assert.equal(pageWindow(31, raw, 12).page, 1, String(raw));
  assert.deepEqual(pageWindow(0, "5", 12), { page: 1, pageCount: 1, start: 0, end: 0, first: 0 });
  assert.deepEqual(pageWindow(25, "2", 25), { page: 1, pageCount: 1, start: 0, end: 25, first: 1 });
});
