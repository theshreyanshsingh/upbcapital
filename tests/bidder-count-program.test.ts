import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { GET as getListing } from "../app/api/v1/listings/[id]/route";
import { GET as getListings } from "../app/api/v1/listings/route";
import { BUYER_SCOPES, hashKey, mintKey } from "../lib/api-keys";
import {
  BIDDER_COUNT_CAP,
  bidderCountFor,
  bidderCountLabel,
  bidderCountLock,
  bidderCountShown,
  otherBidders,
  setBidderCount,
} from "../lib/bidder-count";
import {
  appliedChips,
  bookMatches,
  fileFiltersActive,
  filtersFromSaved,
  filtersQuery,
  listingMatches,
  parseFilters,
  type MatchNote,
} from "../lib/filters";
import { criteriaFrom, programFit, rescoreListing, scoreBox, scoreMatch, type ProgramNote } from "../lib/matching";
import { letterContent } from "../lib/process-letter";
import { prisma } from "../lib/prisma";
import { sendSearchRoundup } from "../lib/search-alerts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], listings: [] as string[], tokens: [] as string[], boxes: [] as string[], searches: [] as string[] };
// A city and state nobody else's fixtures use, so the roundup and the box score only this file's paper.
const CITY = `Countville ${tag}`;
const STATE = "ZB";

type Role = "BUYER" | "INSTITUTIONAL_SELLER" | "ADMIN";

async function person(who: string, role: Role, data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `count-${who}-${tag}@example.org`,
      name: `Count ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...data,
    },
  });
  made.users.push(user.id);
  return user;
}

// A seat on a firm's account: its own row, acting for the firm.
function seat(firmId: string, who: string) {
  return person(who, "BUYER", { principalId: firmId, seatRole: "TRADE", seatAddedAt: new Date() });
}

function loan(program: string | null, data: Record<string, unknown> = {}) {
  return {
    streetAddress: `1 Tally Way ${tag}`, city: CITY, state: STATE, zip: "99877", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: 80000, estimatedValue: 200000, borrowerName: `Borrower ${tag}`, ...(program ? { loanProgram: program } : {}), ...data,
  };
}

async function listing(sellerId: string, data: Partial<Prisma.ListingUncheckedCreateInput> = {}, loans = [loan("VA")]) {
  const row = await prisma.listing.create({
    data: {
      kind: loans.length > 1 ? "POOL" : "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 2 * HOUR),
      standingBidsNotifiedAt: new Date(),
      title: `Count listing ${tag} ${made.listings.length}`,
      summary: "A test listing.",
      bidMode: "SEALED",
      bidDeadline: new Date(Date.now() + 3 * DAY),
      notes: { create: loans as never },
      ...data,
    },
  });
  made.listings.push(row.id);
  return row;
}

function bid(listingId: string, buyerId: string, amount: number, data: Partial<Prisma.InquiryUncheckedCreateInput> = {}) {
  return prisma.inquiry.create({ data: { listingId, buyerId, type: "OFFER", amount, status: "OPEN", ...data } });
}

async function key(userId: string) {
  await prisma.buyerProfile.create({ data: { userId, status: "APPROVED" } });
  const minted = mintKey();
  await prisma.apiKey.create({ data: { userId, name: `Key ${tag}`, prefix: minted.prefix, hash: minted.hash, scopes: BUYER_SCOPES.join(",") } });
  made.tokens.push(minted.token);
  return minted.token;
}

function call(handler: (request: Request, context: never) => Promise<Response>, path: string, token: string, params?: Record<string, string>) {
  const request = new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
  return handler(request, (params ? { params: Promise.resolve(params) } : undefined) as never);
}

test.after(async () => {
  const ids = made.listings;
  const groups = await prisma.groupBuy.findMany({ where: { listingId: { in: ids } }, select: { id: true } });
  await prisma.groupPosition.deleteMany({ where: { groupId: { in: groups.map((group) => group.id) } } });
  await prisma.groupBuy.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.deskBid.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listingMatch.deleteMany({ where: { OR: [{ listingId: { in: ids } }, { buyBoxId: { in: made.boxes } }] } });
  await prisma.buyBox.deleteMany({ where: { id: { in: made.boxes } } });
  await prisma.savedSearch.deleteMany({ where: { id: { in: made.searches } } });
  await prisma.listingView.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: made.users } } });
  if (made.tokens.length) await prisma.rateWindow.deleteMany({ where: { OR: made.tokens.map((token) => ({ key: { startsWith: `api:${hashKey(token).slice(0, 32)}` } })) } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...made.users] } }, { actorId: { in: made.users } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ subject: { contains: tag } }, { body: { contains: tag } }, { toEmail: { contains: tag } }] } });
  await prisma.user.deleteMany({ where: { principalId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// 1. The bidder count: what it says, when it shows, and who counts.

test("the count reads exactly at one and two, and five or more past the cap", () => {
  assert.deepEqual(bidderCountLabel(0), { count: 0, orMore: false, label: "No other bids yet" });
  assert.deepEqual(bidderCountLabel(1), { count: 1, orMore: false, label: "1 other bidder" });
  assert.deepEqual(bidderCountLabel(2), { count: 2, orMore: false, label: "2 other bidders" });
  assert.deepEqual(bidderCountLabel(4), { count: 4, orMore: false, label: "4 other bidders" });
  assert.equal(BIDDER_COUNT_CAP, 5);
  for (const others of [5, 6, 40]) assert.deepEqual(bidderCountLabel(others), { count: 5, orMore: true, label: "5 or more other bidders" });
});

test("the count shows only where the seller opted in, while the listing is live and before the deadline", () => {
  const now = new Date();
  const live = { id: "l", status: "APPROVED", bidMode: "SEALED", bidDeadline: new Date(now.getTime() + DAY), showBidderCount: true };
  assert.equal(bidderCountShown(live, now), true);
  // Default off: an old listing has no answer, and a seller who said no.
  assert.equal(bidderCountShown({ ...live, showBidderCount: null }, now), false);
  assert.equal(bidderCountShown({ ...live, showBidderCount: undefined }, now), false);
  assert.equal(bidderCountShown({ ...live, showBidderCount: false }, now), false);
  // After a dated round's deadline the desk awards, so it stops.
  assert.equal(bidderCountShown({ ...live, bidDeadline: new Date(now.getTime() - 1000) }, now), false);
  assert.equal(bidderCountShown({ ...live, bidMode: "BEST_AND_FINAL", bidDeadline: new Date(now.getTime() - 1000) }, now), false);
  // Open offers have no deadline, so the count runs while the listing is for sale.
  assert.equal(bidderCountShown({ ...live, bidMode: "NONE", bidDeadline: null }, now), true);
  for (const status of ["PENDING", "SOLD", "UNDER_REVIEW", "WITHDRAWN"]) assert.equal(bidderCountShown({ ...live, status }, now), false, status);
  assert.equal(bidderCountShown({ ...live, launchAt: new Date(now.getTime() + HOUR) }, now), false);
});

test("bidders count by firm: seats once, a group once, the desk's book once, and never the viewer's own", async () => {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const firmA = await person("firm-a", "BUYER");
  const seatA1 = await seat(firmA.id, "seat-a1");
  const seatA2 = await seat(firmA.id, "seat-a2");
  const firmB = await person("firm-b", "BUYER");
  const viewer = await person("viewer", "BUYER");
  const lead = await person("group-lead", "BUYER");
  const member = await person("group-member", "BUYER");
  const late = await person("expired", "BUYER");
  const gone = await person("withdrawn", "BUYER");
  const row = await listing(seller.id, { showBidderCount: true });

  // Firm A bids from its own login and from two seats: one firm.
  await bid(row.id, firmA.id, 61001);
  await bid(row.id, seatA1.id, 61002, { status: "REVIEWED" });
  await bid(row.id, seatA2.id, 61003);
  await bid(row.id, firmB.id, 62001);
  // Not live: past its good-until date, withdrawn, declined.
  await bid(row.id, late.id, 63001, { expiresAt: new Date(Date.now() - HOUR) });
  await bid(row.id, gone.id, 64001, { status: "WITHDRAWN" });
  await bid(row.id, firmB.id, 64002, { status: "DECLINED" });
  // A group of two firms is one bidder.
  const groupBid = await bid(row.id, lead.id, 65001);
  const group = await prisma.groupBuy.create({
    data: { listingId: row.id, openedById: lead.id, minPosition: 10000, deadline: new Date(Date.now() + DAY), targetAmount: 65001, inquiryId: groupBid.id, status: "OFFERED" },
  });
  await prisma.groupPosition.create({ data: { groupId: group.id, userId: lead.id, seat: 1, amount: 40000, percent: 61.5 } });
  await prisma.groupPosition.create({ data: { groupId: group.id, userId: member.id, seat: 2, amount: 25001, percent: 38.5 } });
  // The viewer's own bid, and two of the desk's book bids, which count as one bidder.
  await bid(row.id, viewer.id, 66001);
  await prisma.deskBid.create({ data: { listingId: row.id, amount: 67001 } });
  await prisma.deskBid.create({ data: { listingId: row.id, amount: 67002 } });

  // The viewer sees firm A, firm B, the group and the desk.
  assert.equal(await otherBidders(row.id, viewer.id), 4);
  assert.deepEqual(await bidderCountFor(row, viewer), { count: 4, orMore: false, label: "4 other bidders" });
  // Firm A, by its own login or a seat's, never counts itself.
  assert.equal(await otherBidders(row.id, firmA.id), 4);
  assert.equal(await otherBidders(row.id, seatA1.id), 4);
  // A member of the group doesn't count the group, nor does its lead.
  assert.equal(await otherBidders(row.id, member.id), 4);
  assert.equal(await otherBidders(row.id, lead.id), 4);
  // A buyer with no bid sees every bidder.
  const outsider = await person("outsider", "BUYER");
  assert.equal(await otherBidders(row.id, outsider.id), 5);
  assert.deepEqual(await bidderCountFor(row, outsider), { count: 5, orMore: true, label: "5 or more other bidders" });

  // A dropped seat leaves the group, so its holder counts the group as someone else's.
  await prisma.groupPosition.updateMany({ where: { groupId: group.id, userId: member.id }, data: { status: "DROPPED" } });
  assert.equal(await otherBidders(row.id, member.id), 5);

  // Only an approved buyer reads it.
  assert.equal(await bidderCountFor(row, { ...viewer, role: "INSTITUTIONAL_SELLER" }), null);
  assert.equal(await bidderCountFor(row, { ...viewer, accountStatus: "SUSPENDED" }), null);

  // Once a bid is accepted, awards have begun and the count stops.
  await prisma.inquiry.update({ where: { id: groupBid.id }, data: { status: "ACCEPTED" } });
  assert.equal(await otherBidders(row.id, viewer.id), null);
  assert.equal(await bidderCountFor(row, viewer), null);
});

test("the count is hidden without the seller's opt-in and after the deadline, whatever the bids", async () => {
  const seller = await person("seller-2", "INSTITUTIONAL_SELLER");
  const bidder = await person("bidder-2", "BUYER");
  const viewer = await person("viewer-2", "BUYER");
  const quiet = await listing(seller.id);
  const closed = await listing(seller.id, { showBidderCount: true, bidDeadline: new Date(Date.now() - HOUR) });
  const open = await listing(seller.id, { showBidderCount: true, bidMode: "NONE", bidDeadline: null });
  for (const row of [quiet, closed, open]) await bid(row.id, bidder.id, 71001);
  assert.equal(await bidderCountFor(quiet, viewer), null);
  assert.equal(await bidderCountFor(closed, viewer), null);
  assert.deepEqual(await bidderCountFor(open, viewer), { count: 1, orMore: false, label: "1 other bidder" });
  const empty = await listing(seller.id, { showBidderCount: true });
  assert.deepEqual(await bidderCountFor(empty, viewer), { count: 0, orMore: false, label: "No other bids yet" });
});

test("the buyer API carries otherBidders as a count with no amount, and null where it is hidden", async () => {
  const seller = await person("seller-3", "INSTITUTIONAL_SELLER");
  const rival = await person("rival-3", "BUYER");
  const buyer = await person("buyer-3", "BUYER");
  const token = await key(buyer.id);
  const shown = await listing(seller.id, { showBidderCount: true });
  const hidden = await listing(seller.id);
  await bid(shown.id, rival.id, 123457.89);
  await bid(hidden.id, rival.id, 123457.89);
  await prisma.deskBid.create({ data: { listingId: shown.id, amount: 98765.43 } });

  const response = await call(getListing, `/api/v1/listings/${shown.id}`, token, { id: shown.id });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { otherBidders: unknown };
  assert.deepEqual(body.otherBidders, { count: 2, orMore: false, label: "2 other bidders" });
  // Nothing in it is a price, a rank or a time: three keys, and no bid's figure anywhere in the response.
  assert.deepEqual(Object.keys(body.otherBidders as object).sort(), ["count", "label", "orMore"]);
  const text = JSON.stringify(body);
  for (const figure of ["123457", "98765", "123,457", "98,765"]) assert.ok(!text.includes(figure), figure);
  assert.doesNotMatch(JSON.stringify(body.otherBidders), /amount|price|rank|At"|time|\$/i);
  // The page's line is the same object.
  assert.deepEqual(await bidderCountFor(shown, buyer), body.otherBidders);

  const quiet = (await (await call(getListing, `/api/v1/listings/${hidden.id}`, token, { id: hidden.id })).json()) as { otherBidders: unknown };
  assert.equal(quiet.otherBidders, null);
});

test("the seller's switch is off by default, audited, the desk's to set too, and locked once the deadline passes", async () => {
  const seller = await person("seller-4", "INSTITUTIONAL_SELLER");
  const stranger = await person("stranger-4", "BUYER");
  const desk = await person("desk-4", "ADMIN");
  const row = await listing(seller.id);
  assert.equal(row.showBidderCount, null);

  assert.deepEqual(await setBidderCount({ listingId: row.id, actor: stranger, on: true }), { error: "That listing isn't yours." });
  assert.deepEqual(await setBidderCount({ listingId: row.id, actor: seller, on: true }), { error: null, on: true, unchanged: false });
  assert.deepEqual(await setBidderCount({ listingId: row.id, actor: seller, on: true }), { error: null, on: true, unchanged: true });
  assert.deepEqual(await setBidderCount({ listingId: row.id, actor: desk, on: false }), { error: null, on: false, unchanged: false });
  const trail = await prisma.auditEvent.findMany({ where: { entityId: row.id, action: "BIDDER_COUNT" }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(trail.map((event) => [event.actorId, event.detail]), [[seller.id, "on"], [desk.id, "off, set by the desk"]]);

  const past = new Date(Date.now() + 4 * DAY);
  assert.equal(bidderCountLock({ status: "APPROVED", bidMode: "SEALED", bidDeadline: row.bidDeadline }, past), "Bids closed at the deadline, so the bidder count is fixed for this sale.");
  assert.deepEqual(await setBidderCount({ listingId: row.id, actor: seller, on: true, now: past }), { error: "Bids closed at the deadline, so the bidder count is fixed for this sale." });
  assert.equal(bidderCountLock({ status: "SOLD", bidMode: "NONE", bidDeadline: null }), "This listing is off the market, so the bidder count can't change.");
  assert.equal(bidderCountLock({ status: "APPROVED", bidMode: "NONE", bidDeadline: null }), null);
  assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: row.id } })).showBidderCount, false);
});

test("the process letter mentions the count on a listing that shows it, in one line", () => {
  const at = new Date("2026-12-01T17:00:00Z");
  const content = letterContent({
    event: { name: "Winter sale", status: "INDICATIONS", summary: "", indicationsAt: at, bestFinalAt: new Date(at.getTime() + 16 * DAY), ndaDueAt: null, qaCutoffAt: null, awardTargetAt: null, closingTargetAt: null, processNotes: "" },
    listings: [{ title: "Florida firsts", kind: "POOL", loans: 12, showBidderCount: true }, { title: "Ohio note", kind: "SINGLE", loans: 1 }],
    others: 0,
    settings: {},
    contact: "The desk",
  });
  assert.deepEqual(content.listings, ["Florida firsts · 12 loans · bidders see how many others are bidding, never amounts", "Ohio note · one note"]);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The loan-program filter.

const note = (over: Partial<MatchNote> = {}): MatchNote => ({
  city: "Tampa", state: "FL", paymentStatus: "PERFORMING", lienPosition: "FIRST", propertyType: "SFR", upb: 100000, askingPrice: 80000, ...over,
});

test("the program filter matches a note's program, and an unstated program matches only Any", () => {
  const va = { kind: "SINGLE", notes: [note({ loanProgram: "VA" })] };
  const unstated = { kind: "SINGLE", notes: [note({ loanProgram: null })] };
  const leftOut = { kind: "SINGLE", notes: [note()] };
  assert.equal(listingMatches(va, { loanProgram: ["VA"] }), true);
  assert.equal(listingMatches(va, { loanProgram: ["FHA", "VA"] }), true);
  assert.equal(listingMatches(va, { loanProgram: ["FHA"] }), false);
  assert.equal(listingMatches(unstated, { loanProgram: ["VA"] }), false);
  assert.equal(listingMatches(unstated, { loanProgram: ["OTHER"] }), false);
  assert.equal(listingMatches(unstated, {}), true);
  assert.equal(listingMatches(leftOut, { loanProgram: ["VA"] }), false);
  assert.equal(listingMatches(leftOut, {}), true);
});

test("a pool matches when any loan for sale carries the program", () => {
  const pool = (programs: (string | null)[], traded: number[] = []) => ({
    kind: "POOL",
    notes: programs.map((program, index) => note({ loanProgram: program, tradeStatus: traded.includes(index) ? "SOLD" : "AVAILABLE" })),
  });
  assert.equal(listingMatches(pool(["CONVENTIONAL", "VA"]), { loanProgram: ["VA"] }), true);
  assert.equal(listingMatches(pool(["CONVENTIONAL", null]), { loanProgram: ["VA"] }), false);
  assert.equal(listingMatches(pool([null, null]), { loanProgram: ["VA"] }), false);
  assert.equal(listingMatches(pool([null, null]), {}), true);
  // A loan that already traded out of the pool no longer counts.
  assert.equal(listingMatches(pool(["CONVENTIONAL", "VA"], [1]), { loanProgram: ["VA"] }), false);
  // With other filters, one loan meets them all, as the book's other loan facts do.
  assert.equal(listingMatches(pool(["VA", "FHA"]), { loanProgram: ["VA"], lienPosition: ["FIRST"] }), true);
});

test("the program reads from the address bar under its own name, round-trips, and shows as a chip", () => {
  const filters = parseFilters({ loanProgram: ["VA", "FHA", "BOGUS"], state: "fl" });
  assert.deepEqual(filters, { state: "FL", loanProgram: ["FHA", "VA"] });
  assert.equal(filtersQuery(filters).toString(), "state=FL&loanProgram=FHA&loanProgram=VA");
  assert.deepEqual(parseFilters({ loanProgram: "PRIVATE" }), { loanProgram: ["PRIVATE"] });
  assert.deepEqual(appliedChips({ loanProgram: ["VA", "PRIVATE"] }).map((chip) => chip.label), ["Program: VA", "Program: Private or seller-financed"]);
  assert.equal(appliedChips({ loanProgram: ["VA"] })[0].without.loanProgram, undefined);
  assert.deepEqual(appliedChips({ loanProgram: ["FHA", "VA"] })[0].without, { loanProgram: ["VA"] });
  // The program is in the loan file, so on a listing the viewer can't open yet it drops out rather than tell.
  assert.equal(fileFiltersActive({ loanProgram: ["VA"] }), true);
  const va = { kind: "SINGLE", notes: [note({ loanProgram: "VA" })] };
  assert.equal(bookMatches(va, { loanProgram: ["VA"] }, true), false);
  assert.equal(bookMatches(va, { loanProgram: ["VA"] }, false), true);
});

test("a saved search from before the program filter still parses and matches as it did", () => {
  const old = filtersFromSaved({ state: "FL", lienPosition: "FIRST", paymentStatus: ["PERFORMING"], upbMin: 50000 });
  assert.deepEqual(old, { state: "FL", lienPosition: ["FIRST"], paymentStatus: ["PERFORMING"], upbMin: 50000 });
  assert.equal("loanProgram" in old, false);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [note({ loanProgram: null })] }, old), true);
  assert.deepEqual(filtersFromSaved({}), {});
  assert.deepEqual(filtersFromSaved(null), {});
  // A new one saves the program as JSON and reads it back.
  const saved = JSON.parse(JSON.stringify(parseFilters({ loanProgram: ["VA"], state: "FL" })));
  assert.deepEqual(filtersFromSaved(saved), { state: "FL", loanProgram: ["VA"] });
});

test("the buyer API filters on loan_program and refuses a program it doesn't know", async () => {
  const seller = await person("seller-5", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer-5", "BUYER");
  const token = await key(buyer.id);
  const va = await listing(seller.id, {}, [loan("VA")]);
  const conventional = await listing(seller.id, {}, [loan("CONVENTIONAL")]);
  const unstated = await listing(seller.id, {}, [loan(null)]);
  const pool = await listing(seller.id, {}, [loan("CONVENTIONAL"), loan("VA", { streetAddress: `2 Tally Way ${tag}` })]);
  const ids = async (query: string) => {
    const response = await call(getListings, `/api/v1/listings?state=${STATE}&limit=100${query}`, token);
    assert.equal(response.status, 200);
    return new Set(((await response.json()) as { listings: { id: string }[] }).listings.map((row) => row.id));
  };
  const vaOnly = await ids("&loan_program=va");
  assert.ok(vaOnly.has(va.id) && vaOnly.has(pool.id));
  assert.ok(!vaOnly.has(conventional.id) && !vaOnly.has(unstated.id));
  const either = await ids("&loan_program=VA,CONVENTIONAL");
  assert.ok(either.has(conventional.id) && either.has(va.id) && !either.has(unstated.id));
  const all = await ids("");
  for (const row of [va, conventional, unstated, pool]) assert.ok(all.has(row.id));
  const bad = await call(getListings, "/api/v1/listings?loan_program=VA,GNMA", token);
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /^loan_program takes CONVENTIONAL, FHA, VA, USDA, PRIVATE, OTHER/);
});

test("a roundup reads the program from the saved search", async () => {
  const seller = await person("seller-6", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer-6", "BUYER");
  const now = new Date();
  const va = await listing(seller.id, { approvedAt: new Date(now.getTime() - HOUR), title: `VA roundup ${tag}` }, [loan("VA")]);
  const fha = await listing(seller.id, { approvedAt: new Date(now.getTime() - HOUR), title: `FHA roundup ${tag}` }, [loan("FHA")]);
  const search = await prisma.savedSearch.create({
    data: { userId: buyer.id, name: `Programs ${tag}`, filters: { q: CITY, loanProgram: ["VA"] }, cadence: "DAILY", lastAlertAt: new Date(now.getTime() - 25 * HOUR), createdAt: new Date(now.getTime() - 3 * DAY) },
    include: { user: true },
  });
  made.searches.push(search.id);
  assert.equal(await sendSearchRoundup(search, now), true);
  const roundup = await prisma.notification.findFirstOrThrow({ where: { toEmail: buyer.email, subject: `Daily roundup · ${search.name}` } });
  assert.ok(roundup.body.includes(va.title));
  assert.ok(!roundup.body.includes(fha.title));
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Buy boxes with programs.

const scored = (over: Partial<ProgramNote> = {}): ProgramNote => ({
  state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 100000, askingPrice: 80000, monthlyPi: 800, interestRate: 7,
  estimatedValue: 200000, seasoningMonths: 36, ...over,
});
const criteria = (programs: string, states = "") => criteriaFrom({ states, liens: "", statuses: "", upbMin: null, upbMax: null, priceMin: null, priceMax: null, maxPriceToUpb: null, targetYield: null, programs });

test("a buy box with programs scores paper that carries them and says so", () => {
  assert.deepEqual(criteria("va, fha").programs, ["VA", "FHA"]);
  // A box saved before programs takes any.
  assert.deepEqual(criteriaFrom({ states: "FL", liens: "", statuses: "", upbMin: null, upbMax: null, priceMin: null, priceMax: null, maxPriceToUpb: null, targetYield: null }).programs, []);
  assert.deepEqual(scoreBox([scored({ loanProgram: "VA" })], criteria("VA", "FL"))?.reasons, ["State fits", "VA, as your box asks"]);
  assert.equal(scoreBox([scored({ loanProgram: "FHA" })], criteria("VA", "FL")), null);
  assert.equal(scoreBox([scored({ loanProgram: null })], criteria("VA", "FL")), null);
  assert.equal(scoreBox([scored()], criteria("VA", "FL")), null);
  assert.deepEqual(scoreBox([scored()], criteria("", "FL"))?.reasons, ["State fits"]);
  // A box whose only limit is its programs still scores.
  assert.deepEqual(scoreBox([scored({ loanProgram: "VA" })], criteria("VA")), { score: 55, reasons: ["VA, as your box asks"] });
  assert.equal(scoreBox([scored({ loanProgram: "VA", askingPrice: 0 })], criteria("VA")), null);
  // A pool fits on half its UPB, and names what it carries.
  assert.deepEqual(scoreBox([scored({ loanProgram: "VA", upb: 150000 }), scored({ loanProgram: null })], criteria("VA"))?.reasons, ["60% of UPB is VA, as your box asks"]);
  assert.equal(scoreBox([scored({ loanProgram: "VA" }), scored({ loanProgram: null, upb: 150000 })], criteria("VA")), null);
  assert.deepEqual(programFit([scored({ loanProgram: "VA" }), scored({ loanProgram: "FHA" })], ["FHA", "VA"]), { fit: true, reason: "FHA and VA, as your box asks" });
  assert.deepEqual(programFit([scored({ loanProgram: "PRIVATE" })], ["PRIVATE"]).reason, "Private or seller-financed, as your box asks");
});

test("a standing bid prices only paper in the box's programs", () => {
  const user = { role: "BUYER", accountStatus: "APPROVED", subscriptionTier: "PRO", subscriptionStatus: "ACTIVE", subscriptionCurrentPeriodEnd: null };
  const box = {
    id: "box", userId: "u", name: "VA box", states: "", liens: "", statuses: "", programs: "VA", upbMin: null, upbMax: null, priceMin: null, priceMax: null, maxPriceToUpb: null,
    targetYield: null, maxLtv: null, minSeasoningMonths: null, standingBids: true, bidBasis: "UPB", bidPercent: 70, bidCap: null, bidSpread: null, active: true, user,
  } as never;
  const standing = [{ id: "n", upb: 100000, askingPrice: 90000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", maturityDate: null, tradeStatus: "AVAILABLE" }];
  const fits = scoreMatch("SINGLE", standing, box, [scored({ askingPrice: 90000, loanProgram: "VA" })], new Date(), 0, null);
  assert.equal(fits.price, 70000);
  assert.deepEqual(fits.result?.reasons, ["VA, as your box asks", "At the standing price"]);
  const misses = scoreMatch("SINGLE", standing, box, [scored({ askingPrice: 90000, loanProgram: "FHA" })], new Date(), 0, null);
  assert.equal(misses.result, null);
  assert.equal(misses.price, null);
});

test("matching writes the program reason on the box's match", async () => {
  const seller = await person("seller-7", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer-7", "BUYER");
  const box = await prisma.buyBox.create({ data: { userId: buyer.id, name: `VA box ${tag}`, states: STATE, programs: "VA" } });
  made.boxes.push(box.id);
  const va = await listing(seller.id, {}, [loan("VA")]);
  const conventional = await listing(seller.id, {}, [loan("CONVENTIONAL")]);
  await rescoreListing(va.id, false);
  await rescoreListing(conventional.id, false);
  const hit = await prisma.listingMatch.findUniqueOrThrow({ where: { listingId_buyBoxId: { listingId: va.id, buyBoxId: box.id } } });
  assert.equal(hit.reasons, "State fits · VA, as your box asks");
  assert.equal(await prisma.listingMatch.count({ where: { listingId: conventional.id, buyBoxId: box.id } }), 0);
});
