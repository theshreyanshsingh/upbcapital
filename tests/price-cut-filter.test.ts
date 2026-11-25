import assert from "node:assert/strict";
import test from "node:test";
import { GET as getListing } from "../app/api/v1/listings/[id]/route";
import { GET as getListings } from "../app/api/v1/listings/route";
import { hashKey, mintKey } from "../lib/api-keys";
import { apiLogSettled } from "../lib/api-log";
import { cutFromHistory, matchesFilters, priceMoves, type ListingWithNotes } from "../lib/buyer-api";
import {
  appliedChips,
  bookMatches,
  FIGURE_KEYS,
  filtersFor,
  filtersFromSaved,
  filtersQuery,
  listingMatches,
  parseFilters,
  PRICE_CUT_LABEL,
  savableFilters,
  sortFor,
  SORTS,
  sortRows,
  type BookFilters,
  type MatchNote,
} from "../lib/filters";
import { MCP_TOOLS, argumentProblem, toolUrl } from "../lib/mcp";
import { latestCuts, recordPriceChange } from "../lib/price-history";
import { prisma } from "../lib/prisma";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const STATE = "ZP";
const made = { users: [] as string[], listings: [] as string[], tokens: [] as string[] };

// ---------------------------------------------------------------------------------------------------------------
// The book: rows built as app/(desk)/marketplace/page.tsx builds them, with the cuts recentCuts() would return.

const note = (state = "FL"): MatchNote => ({ city: "Tampa", state, paymentStatus: "PERFORMING", lienPosition: "FIRST", propertyType: "SFR", upb: 100000, askingPrice: 80000 });

function bookRows(now: number) {
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
  // The latest move on each listing in the window, kept where it was a cut, as recentCuts() reads it.
  const cuts = latestCuts([
    { listingId: "cutEarly", before: 100000, after: 95000, createdAt: at(20) },
    { listingId: "cutLate", before: 90000, after: 80000, createdAt: at(5) },
    { listingId: "raised", before: 100000, after: 90000, createdAt: at(12) },
    { listingId: "raised", before: 90000, after: 99000, createdAt: at(3) },
  ]);
  const listing = (id: string, approvedDaysAgo: number, state = "FL") => {
    const cut = cuts.get(id) ?? null;
    return {
      id,
      match: { kind: "SINGLE", status: "APPROVED", bidMode: "NONE", bidDeadline: null, notes: [note(state)], priceCut: cut },
      held: false,
      approvedAt: now - approvedDaysAgo * DAY,
      cutAt: cut?.at.getTime() ?? null,
      deadline: null,
      state,
      figures: { upb: 100000, asking: 80000, value: 150000, priceToUpb: 80, yield: null },
    };
  };
  return [listing("cutEarly", 40), listing("cutLate", 35, "GA"), listing("raised", 30), listing("quiet", 10), listing("older", 50)];
}

test("the price-cut filter keeps a listing whose latest move in 30 days was a cut, as the card's line reads it", () => {
  const rows = bookRows(Date.now());
  const shown = (filters: BookFilters) => rows.filter((row) => bookMatches(row.match, filters, row.held)).map((row) => row.id).sort();
  assert.deepEqual(shown({ priceCut: true }), ["cutEarly", "cutLate"]);
  assert.deepEqual(shown({ priceCut: true, state: "FL" }), ["cutEarly"]);
  assert.equal(shown({}).length, 5);
  // A caller that read no cuts can't claim a listing was cut, so the filter never matches its rows.
  assert.equal(listingMatches({ kind: "SINGLE", notes: [note()] }, { priceCut: true }), false);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [note()], priceCut: null }, { priceCut: true }), false);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [note()] }, {}), true);

  // The address bar and the filter form's checkbox, the applied chip, and the URL's fixed order.
  assert.deepEqual(parseFilters({ priceCut: "1", state: "fl" }), { state: "FL", priceCut: true });
  assert.deepEqual(parseFilters({ priceCut: "0" }), {});
  assert.deepEqual(parseFilters({ priceCut: "maybe" }), {});
  const filters = parseFilters({ priceCut: "1", ltvMax: "80", state: "FL" });
  assert.equal(filtersQuery(filters).toString(), "state=FL&ltvMax=80&priceCut=1");
  assert.deepEqual(parseFilters(Object.fromEntries(filtersQuery(filters))), filters);
  const chips = appliedChips({ priceCut: true, state: "FL" });
  assert.deepEqual(chips.map((chip) => chip.label), ["FL", PRICE_CUT_LABEL]);
  assert.deepEqual(chips[1].without, { state: "FL" });
});

test("the latest-cut sort puts the most recent cut first, then the rest newest first", () => {
  const rows = bookRows(Date.now());
  assert.deepEqual(sortRows(rows, { key: "cut", dir: "desc" }).map((row) => row.id), ["cutLate", "cutEarly", "quiet", "raised", "older"]);
  // Reversed, the cuts turn over and the rest still follow, newest first.
  assert.deepEqual(sortRows(rows, { key: "cut", dir: "asc" }).map((row) => row.id), ["cutEarly", "cutLate", "quiet", "raised", "older"]);
  // A row from a caller that knows nothing of cuts sorts with the rest.
  const bare = rows.map((row) => ({ ...row, cutAt: undefined }));
  assert.deepEqual(sortRows(bare, { key: "cut", dir: "desc" }).map((row) => row.id), ["quiet", "raised", "cutLate", "cutEarly", "older"]);
});

test("the price-cut filter and the latest-cut sort are Pro only, like the other figures", () => {
  assert.ok((FIGURE_KEYS as readonly string[]).includes("priceCut"));
  const free = filtersFor({ priceCut: true, state: "FL" }, false);
  assert.equal(free.priceCut, undefined);
  assert.equal(free.state, "FL");
  assert.deepEqual(filtersFor({ priceCut: true, state: "FL" }, true), { priceCut: true, state: "FL" });
  // A free member's book shows every row, whatever the address bar asked.
  const rows = bookRows(Date.now());
  assert.equal(rows.filter((row) => bookMatches(row.match, filtersFor({ priceCut: true }, false), row.held)).length, 5);

  assert.equal(SORTS.find((sort) => sort.value === "cut")?.pro, true);
  assert.deepEqual(sortFor("cut", undefined, false), { key: "new", dir: "desc" });
  assert.deepEqual(sortFor("cut", undefined, true), { key: "cut", dir: "desc" });
  assert.deepEqual(sortFor("cut", "asc", true), { key: "cut", dir: "asc" });
});

test("a saved search leaves the price-cut filter out, and never reads one back as applied", () => {
  // The book's save form posts savableFilters(applied) and says the price-cut filter isn't saved.
  const applied = parseFilters({ priceCut: "1", state: "FL", lienPosition: "FIRST" });
  const posted = JSON.parse(JSON.stringify(savableFilters(applied)));
  assert.deepEqual(posted, { state: "FL", lienPosition: ["FIRST"] });
  assert.deepEqual(filtersFromSaved(posted), { state: "FL", lienPosition: ["FIRST"] });
  assert.deepEqual(savableFilters({ priceCut: true }), {});
  // A flag stored by a hand-made request is dropped on reading, so the alerts page, the saved view's link and the
  // alert all agree on what the search holds, rather than an alert that silently never fires.
  const stored = filtersFromSaved({ state: "FL", priceCut: true });
  assert.deepEqual(stored, { state: "FL" });
  assert.deepEqual(appliedChips(stored).map((chip) => chip.label), ["FL"]);
  // The alert's own match input carries no cuts (lib/search-alerts.ts), and it still alerts on new paper.
  assert.equal(listingMatches({ kind: "SINGLE", notes: [note()] }, stored), true);
});

test("the MCP search_listings tool takes price_cut and both listing tools name the new fields", () => {
  const search = MCP_TOOLS.find((tool) => tool.name === "search_listings")!;
  const one = MCP_TOOLS.find((tool) => tool.name === "get_listing")!;
  assert.equal(search.properties.price_cut?.type, "boolean");
  assert.match(search.description, /lastPriceCut/);
  assert.match(one.description, /priceHistory/);
  assert.equal(argumentProblem(search, { price_cut: true, state: "FL" }), null);
  assert.equal(argumentProblem(search, { price_cut: "yes" }), "price_cut is true or false.");
  assert.equal(toolUrl(search, { price_cut: true, state: "FL" }, "http://localhost/api/mcp").search, "?price_cut=1&state=FL");
  assert.equal(toolUrl(search, { price_cut: false }, "http://localhost/api/mcp").search, "");
});

test("the detail's cut and history come from the listing's own moves, with no source", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  const row = (daysAgo: number, before: number, after: number, source = "LADDER") => ({ before, after, loans: 2, source, createdAt: new Date(now.getTime() - daysAgo * DAY) });
  assert.deepEqual(cutFromHistory("x", [row(40, 100, 90), row(10, 90, 81)], now), { percent: 10, at: row(10, 0, 0).createdAt });
  assert.equal(cutFromHistory("x", [row(10, 90, 81), row(2, 81, 85)], now), null);
  // A cut older than the window no longer marks the listing.
  assert.equal(cutFromHistory("x", [row(31, 100, 90)], now), null);
  assert.equal(cutFromHistory("x", [], now), null);
  const moves = priceMoves([row(10, 90000.004, 81000, "DESK")]);
  assert.deepEqual(moves, [{ at: row(10, 0, 0).createdAt.toISOString(), before: 90000, after: 81000, loans: 2 }]);
  // Without the cuts the list route reads, the API's filter matches nothing either.
  const bare = { id: "x", kind: "SINGLE", status: "APPROVED", bidMode: "NONE", bidDeadline: null, notes: [note()] } as unknown as ListingWithNotes;
  assert.equal(matchesFilters(bare, { priceCut: true }), false);
  assert.equal(matchesFilters(bare, { priceCut: true }, new Map([["x", { percent: 5, at: now }]])), true);
});

// ---------------------------------------------------------------------------------------------------------------
// The buyer API, with real price changes recorded the way watchReprice records them.

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER") {
  const user = await prisma.user.create({
    data: {
      email: `price-cut-${who}-${tag}@example.org`,
      name: `Price cut ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
    },
  });
  made.users.push(user.id);
  return user;
}

async function listing(sellerId: string, title: string) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 60 * DAY),
      standingBidsNotifiedAt: new Date(),
      title: `${title} ${tag}`,
      summary: "A price-cut test listing.",
      notes: {
        create: [{
          streetAddress: `1 Cut Lane ${tag}`, city: "Cutville", state: STATE, zip: "99001", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 150000, interestRate: 7, monthlyPi: 1100, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 114000, estimatedValue: 240000,
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

function call(handler: (request: Request, context: never) => Promise<Response>, path: string, token: string, params?: Record<string, string>) {
  const request = new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
  return handler(request, (params ? { params: Promise.resolve(params) } : undefined) as never);
}

type Summary = { id: string; lastPriceCut: { percent: number; at: string } | null };

async function listed(token: string, query: string) {
  const response = await call(getListings, `/api/v1/listings?limit=100&state=${STATE}${query}`, token);
  const body = (await response.json()) as { listings?: Summary[]; error?: string };
  return { status: response.status, error: body.error, rows: (body.listings ?? []).filter((row) => made.listings.includes(row.id)) };
}

test("the buyer API carries lastPriceCut on the list, price_cut=1, and the history on the detail without its source", async () => {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer", "BUYER");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED" } });
  const minted = mintKey();
  await prisma.apiKey.create({ data: { userId: buyer.id, name: `Key ${tag}`, prefix: minted.prefix, hash: minted.hash, scopes: "listings:read" } });
  made.tokens.push(minted.token);

  const cut = await listing(seller.id, "Cut");
  const raised = await listing(seller.id, "Raised");
  const quiet = await listing(seller.id, "Quiet");
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  // A cut from before the window, then one inside it: 4% off 118,750.
  await recordPriceChange({ listingId: cut.id, before: 125000, after: 118750, loans: 1, source: "SELLER", actorId: seller.id, at: ago(45) });
  await recordPriceChange({ listingId: cut.id, before: 118750, after: 114000, loans: 1, source: "LADDER", actorId: seller.id, at: ago(4) });
  // Cut, then raised: the latest move wasn't a cut.
  await recordPriceChange({ listingId: raised.id, before: 120000, after: 110000, loans: 1, source: "DESK", actorId: seller.id, at: ago(9) });
  await recordPriceChange({ listingId: raised.id, before: 110000, after: 114000, loans: 1, source: "SELLER", actorId: seller.id, at: ago(2) });

  const all = await listed(minted.token, "");
  assert.equal(all.status, 200);
  assert.deepEqual(all.rows.map((row) => row.id).sort(), [cut.id, raised.id, quiet.id].sort());
  const byId = new Map(all.rows.map((row) => [row.id, row]));
  assert.equal(byId.get(cut.id)?.lastPriceCut?.percent, 4);
  assert.equal(byId.get(raised.id)?.lastPriceCut, null);
  assert.equal(byId.get(quiet.id)?.lastPriceCut, null);
  const recorded = await prisma.priceChange.findFirst({ where: { listingId: cut.id, source: "LADDER" } });
  assert.equal(byId.get(cut.id)?.lastPriceCut?.at, recorded?.createdAt.toISOString());

  const cutOnly = await listed(minted.token, "&price_cut=1");
  assert.deepEqual(cutOnly.rows.map((row) => row.id), [cut.id]);
  assert.equal((await listed(minted.token, "&price_cut=0")).rows.length, 3);
  const bad = await listed(minted.token, "&price_cut=yes");
  assert.equal(bad.status, 400);
  assert.match(bad.error ?? "", /price_cut is 1/);

  const detail = await call(getListing, `/api/v1/listings/${cut.id}`, minted.token, { id: cut.id });
  assert.equal(detail.status, 200);
  const text = await detail.text();
  const body = JSON.parse(text) as { lastPriceCut: Summary["lastPriceCut"]; priceHistory: Record<string, unknown>[] };
  assert.deepEqual(body.lastPriceCut, byId.get(cut.id)?.lastPriceCut);
  assert.deepEqual(body.priceHistory.map((row) => [row.before, row.after, row.loans]), [[125000, 118750, 1], [118750, 114000, 1]]);
  for (const row of body.priceHistory) assert.deepEqual(Object.keys(row).sort(), ["after", "at", "before", "loans"]);
  assert.ok((body.priceHistory[0].at as string) < (body.priceHistory[1].at as string), "oldest first");
  // Who moved it stays private: no source, no actor.
  for (const hidden of ["source", "LADDER", "SELLER", "actorId", seller.id]) assert.ok(!text.includes(hidden), hidden);

  const raisedBody = (await (await call(getListing, `/api/v1/listings/${raised.id}`, minted.token, { id: raised.id })).json()) as { lastPriceCut: unknown; priceHistory: unknown[] };
  assert.equal(raisedBody.lastPriceCut, null);
  assert.equal(raisedBody.priceHistory.length, 2);
  const quietBody = (await (await call(getListing, `/api/v1/listings/${quiet.id}`, minted.token, { id: quiet.id })).json()) as { lastPriceCut: unknown; priceHistory: unknown[] };
  assert.equal(quietBody.lastPriceCut, null);
  assert.deepEqual(quietBody.priceHistory, []);
});

test.after(async () => {
  await apiLogSettled();
  const ids = made.listings;
  await prisma.priceChange.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.apiCall.deleteMany({ where: { userId: { in: made.users } } }).catch(() => null);
  await prisma.apiKey.deleteMany({ where: { userId: { in: made.users } } });
  if (made.tokens.length) await prisma.rateWindow.deleteMany({ where: { OR: made.tokens.map((token) => ({ key: { startsWith: `api:${hashKey(token).slice(0, 32)}` } })) } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...made.users] } }, { actorId: { in: made.users } }] } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});
