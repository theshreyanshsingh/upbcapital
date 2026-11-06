import assert from "node:assert/strict";
import test from "node:test";
import { marketView, type ClosedTrade } from "../lib/comps";
import {
  COVER_BID_HEADER,
  COVER_BID_NOTE,
  agencyLines,
  bookStats,
  buildDispatch,
  claimDispatchMonth,
  coverBidLabel,
  dispatchEmail,
  dispatchMonth,
  dispatchRecipients,
  dispatchStory,
  dispatchView,
  monthTitle,
  periodOf,
  readAgencySale,
  safeSourceUrl,
  seesFullDispatch,
  sendMarketDispatch,
  type AgencySaleRow,
  type BookListing,
} from "../lib/dispatch";
import { prisma } from "../lib/prisma";

const DAY = 24 * 60 * 60 * 1000;
// Mail stays in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

const NOW = new Date("2026-11-06T12:00:00Z");

const sale = (over: Partial<AgencySaleRow> = {}): AgencySaleRow => ({
  id: over.id ?? crypto.randomUUID(),
  program: "FANNIE_MAE",
  name: "29th NPL sale",
  bidDate: new Date("2026-11-04T00:00:00Z"),
  settleBy: null,
  loans: 1179,
  upb: 252_400_000,
  coverPctUpb: 97.08,
  coverPctBpo: 48.44,
  bpoLtv: 50,
  winner: "",
  sourceUrl: "",
  ...over,
});

test("agency results are cover bids, the second-highest bid, and never a clearing price", () => {
  const result = sale();
  assert.equal(coverBidLabel(result, NOW), "Cover bid 97.08% of UPB and 48.44% of BPO, at 50% BPO LTV");
  assert.equal(coverBidLabel({ ...result, coverPctBpo: null, bpoLtv: null }, NOW), "Cover bid 97.08% of UPB");
  assert.match(COVER_BID_HEADER, /second-highest/);
  assert.match(COVER_BID_NOTE, /second-highest bid/);
  assert.match(COVER_BID_NOTE, /winning price is not published/);
  // Nothing still to come reads as a result.
  assert.equal(coverBidLabel({ ...result, coverPctUpb: null, coverPctBpo: null }, NOW), "Cover bid not yet published");
  assert.equal(coverBidLabel({ ...result, coverPctUpb: null, coverPctBpo: null, bidDate: new Date(NOW.getTime() + 10 * DAY) }, NOW), "Bids not yet due");
  assert.equal(coverBidLabel({ ...result, coverPctUpb: null, coverPctBpo: null, bidDate: null }, NOW), "Bid date not yet announced");

  const { calendar, results } = agencyLines(
    [
      result,
      sale({ id: "hvls", program: "HUD", name: "HVLS 2027-1", bidDate: new Date("2026-10-27T00:00:00Z"), coverPctUpb: null, coverPctBpo: null, bpoLtv: null }),
      sale({ id: "next", program: "FREDDIE_MAC", name: "SPO pool 5", bidDate: new Date("2026-12-03T00:00:00Z"), coverPctUpb: null, coverPctBpo: null, bpoLtv: null }),
      sale({ id: "far", program: "FREDDIE_MAC", name: "Far off", bidDate: new Date("2027-09-01T00:00:00Z"), coverPctUpb: null, coverPctBpo: null }),
      sale({ id: "old", name: "An old sale", bidDate: new Date("2025-11-01T00:00:00Z") }),
    ],
    NOW,
  );
  assert.deepEqual(results.map((line) => line.label), ["Fannie Mae, 29th NPL sale"]);
  assert.deepEqual(calendar.map((line) => [line.id, line.stage]), [["hvls", "awaiting"], ["next", "upcoming"]]);
  // A name that already carries the agency isn't doubled.
  assert.equal(agencyLines([sale({ name: "Fannie Mae 29th NPL sale" })], NOW).results[0].label, "Fannie Mae 29th NPL sale");

  const dispatch = buildDispatch({ now: NOW, sales: [result], comps: marketView([], NOW), listings: [], rules: [], rate: null, demo: false });
  const story = dispatchStory(dispatch).join(" ");
  assert.match(story, /Cover bid 97\.08% of UPB/);
  assert.match(story, /second-highest bid; the winning price is not published/);
  const email = dispatchEmail(dispatch, "https://upb.example");
  for (const text of [story, email.body, ...results.map((line) => line.cover)]) {
    assert.doesNotMatch(text.replace(COVER_BID_NOTE, ""), /clear(ing|ed)/i);
  }
  assert.match(email.body, /second-highest bid/);
});

test("the desk's entry needs a bid date for a result, and only a web address as its source", () => {
  const form = (values: Record<string, string>) => (name: string) => values[name] ?? "";
  const base = { program: "FANNIE_MAE", name: "29th NPL sale", bidDate: "2026-11-04", upb: "252.4M", loans: "1,179", coverPctUpb: "97.08", coverPctBpo: "48.44", bpoLtv: "50" };
  const read = readAgencySale(form(base), NOW);
  assert.ok(read.ok);
  assert.equal(read.value.upb, 252_400_000);
  assert.equal(read.value.loans, 1179);
  assert.equal(read.value.bidDate?.toISOString().slice(0, 10), "2026-11-04");
  assert.match((readAgencySale(form({ ...base, bidDate: "" }), NOW) as { error: string }).error, /bid date for a result/);
  assert.match((readAgencySale(form({ ...base, bidDate: "2026-12-20" }), NOW) as { error: string }).error, /after bids are due/);
  assert.match((readAgencySale(form({ ...base, program: "NOPE" }), NOW) as { error: string }).error, /agency/);
  assert.match((readAgencySale(form({ ...base, coverPctUpb: "900" }), NOW) as { error: string }).error, /percent of UPB/);
  assert.match((readAgencySale(form({ ...base, sourceUrl: "javascript:alert(1)" }), NOW) as { error: string }).error, /web address/);
  assert.equal(safeSourceUrl("javascript:alert(1)"), null);
  assert.equal(safeSourceUrl("https://www.prnewswire.com/x"), "https://www.prnewswire.com/x");
  // A calendar entry with no result yet needs no figures.
  assert.ok(readAgencySale(form({ program: "HUD", name: "HVLS 2027-1", bidDate: "2026-12-10" }), NOW).ok);
});

const listing = (id: string, status: string, loans: [number, number, string][], approvedAt: Date | null = new Date("2026-08-01T00:00:00Z")): BookListing => ({
  id,
  status,
  approvedAt,
  notes: loans.map(([upb, askingPrice, paymentStatus]) => ({ upb, askingPrice, paymentStatus, tradeStatus: "AVAILABLE" })),
});

test("book cells under three listings are dropped, and standing demand shows as counts", () => {
  const period = periodOf("2026-11");
  assert.equal(period.label, "October 2026");
  assert.equal(monthTitle("2026-11"), "November 2026");
  assert.equal(dispatchMonth(NOW), "2026-11");
  const book = bookStats(
    [
      listing("p1", "APPROVED", [[100000, 90000, "PERFORMING"]], new Date("2026-10-04T00:00:00Z")),
      listing("p2", "APPROVED", [[100000, 92000, "PERFORMING"]]),
      listing("p3", "APPROVED", [[100000, 95000, "PERFORMING"]]),
      // Three non-performing loans, but in two listings: one pool's ask must not read as the market's.
      listing("n1", "APPROVED", [[100000, 50000, "NON_PERFORMING"], [100000, 52000, "NON_PERFORMING"]]),
      listing("n2", "APPROVED", [[100000, 54000, "NON_PERFORMING"]]),
      listing("sold", "SOLD", [[80000, 70000, "PERFORMING"]], new Date("2026-10-20T00:00:00Z")),
    ],
    [
      { userId: "a", statuses: "" },
      { userId: "b", statuses: "NON_PERFORMING" },
    ],
    period,
  );
  assert.deepEqual(book.asks.map((cell) => [cell.paymentStatus, cell.listings, cell.median]), [["PERFORMING", 3, 92]]);
  assert.equal(book.suppressedAsks, 3);
  assert.equal(book.live, 5);
  assert.equal(book.loans, 6);
  assert.equal(book.upb, 600000);
  assert.equal(book.newListings, 2);
  assert.equal(book.newUpb, 180000);
  // Two buyers: the count of rules shows, the count of buyers doesn't.
  assert.equal(book.standing.rules, 2);
  assert.equal(book.standing.buyers, null);
  assert.deepEqual(book.standing.byStatus.map((row) => [row.paymentStatus, row.rules]), [["PERFORMING", 1], ["SUB_PERFORMING", 1], ["NON_PERFORMING", 2]]);
  // Counts only: no price, basis or holder rides along.
  assert.deepEqual(Object.keys(book.standing).sort(), ["buyers", "byStatus", "rules"]);
  assert.deepEqual(Object.keys(book.standing.byStatus[0]).sort(), ["label", "paymentStatus", "rules"]);

  // Closed trades follow lib/comps: two in a cell show nothing, and the story says the comps aren't out.
  const trade = (price: number): ClosedTrade => ({ price, upb: 100000, lienPosition: "FIRST", paymentStatus: "PERFORMING", state: "FL", closedAt: new Date("2026-09-01T00:00:00Z") });
  const thin = buildDispatch({ now: NOW, sales: [], comps: marketView([trade(71000), trade(75000)], NOW), listings: [], rules: [], rate: null, demo: false });
  assert.equal(thin.comps.national.length, 0);
  assert.match(dispatchStory(thin).join(" "), /Fewer than three trades/);
  assert.doesNotMatch(dispatchStory(thin).join(" "), /71|75/);
});

test("free members read the aggregate story; Pro and the desk read the tables", () => {
  const trades: ClosedTrade[] = [72000, 73000, 74000].map((price) => ({ price, upb: 100000, lienPosition: "FIRST", paymentStatus: "PERFORMING", state: "FL", closedAt: new Date("2026-09-01T00:00:00Z") }));
  const dispatch = buildDispatch({
    now: NOW,
    sales: [sale({ winner: "Example Fund" })],
    comps: marketView(trades, NOW),
    listings: [61000, 61000, 61000].map((ask, index) => listing(`l${index}`, "APPROVED", [[100000, ask, "SUB_PERFORMING"]])),
    rules: [{ userId: "a", statuses: "" }, { userId: "b", statuses: "" }, { userId: "c", statuses: "PERFORMING" }],
    rate: { rate: 4.31, asOf: new Date("2026-11-05T00:00:00Z") },
    demo: false,
  });
  const free = dispatchView(dispatch, { full: false });
  const pro = dispatchView(dispatch, { full: true });
  assert.equal(free.tables, null);
  assert.deepEqual(free.story, pro.story);
  const freeText = JSON.stringify(free);
  // The comps median (73%), the book's median ask (61%) and the agency's winner stay in the tables.
  assert.doesNotMatch(freeText, /73%|61%|Example Fund/);
  assert.match(freeText, /3 trades closed on UPB/);
  assert.match(freeText, /4\.31% as of Nov 5, 2026/);
  assert.ok(pro.tables);
  assert.equal(pro.tables.comps.national[0].median, 73);
  assert.equal(pro.tables.asks[0].median, 61);
  assert.equal(pro.tables.standing.buyers, 3);
  assert.equal(pro.tables.results[0].cover, "Cover bid 97.08% of UPB and 48.44% of BPO, at 50% BPO LTV");
  // The email is the story, so it carries nothing a free member can't read.
  assert.doesNotMatch(dispatchEmail(dispatch, "https://upb.example").body, /73%|61%|Example Fund/);
  assert.match(dispatchEmail(dispatch, "https://upb.example").body, /https:\/\/upb\.example\/market/);

  const member = { role: "BUYER", accountStatus: "APPROVED", subscriptionTier: "FREE", subscriptionStatus: "INCOMPLETE", subscriptionCurrentPeriodEnd: null };
  assert.equal(seesFullDispatch({ ...member, role: "ADMIN" }), true);
  assert.equal(seesFullDispatch({ ...member, subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" }), true);
  assert.equal(seesFullDispatch(member), false);
  assert.equal(seesFullDispatch({ ...member, subscriptionTier: "PRO", subscriptionStatus: "ACTIVE", accountStatus: "PENDING" }), false);
  assert.equal(seesFullDispatch({ ...member, role: "INDIVIDUAL_SELLER", subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" }), false);
});

test("each month goes out once, and only to approved accounts that opted in", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  // A settings row of the test's own holds the claim, so the shared default row is never touched.
  const settingsId = `dispatch-test-${tag}`;
  await prisma.platformSettings.create({ data: { id: settingsId } });
  const person = (prefix: string, data: { role?: "BUYER" | "INDIVIDUAL_SELLER"; accountStatus?: "APPROVED" | "PENDING" | "SUSPENDED"; marketDispatch?: boolean }) =>
    prisma.user.create({
      data: {
        email: `dispatch-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role: data.role ?? "BUYER",
        accountStatus: data.accountStatus ?? "APPROVED",
        passwordHash: "x",
        ...(data.marketDispatch === undefined ? {} : { marketDispatch: data.marketDispatch }),
      },
    });
  const reader = await person("reader", { marketDispatch: true });
  const seller = await person("seller", { role: "INDIVIDUAL_SELLER", marketDispatch: true });
  const pending = await person("pending", { accountStatus: "PENDING", marketDispatch: true });
  const suspended = await person("suspended", { accountStatus: "SUSPENDED", marketDispatch: true });
  const off = await person("off", { marketDispatch: false });
  const never = await person("never", {});
  const people = [reader, seller, pending, suspended, off, never];
  const userIds = people.map((user) => user.id);
  const emails = people.map((user) => user.email);
  const count = (email: string) => prisma.notification.count({ where: { toEmail: email, subject: { startsWith: "UPB note-market dispatch" } } });
  try {
    assert.deepEqual((await dispatchRecipients(userIds)).map((user) => user.id).sort(), [reader.id, seller.id].sort());

    const now = new Date();
    const first = await sendMarketDispatch(now, { settingsId, userIds });
    assert.equal(first.claimed, true);
    assert.equal(first.month, dispatchMonth(now));
    assert.equal(first.sent, 2);
    assert.equal(first.failed, 0);
    assert.equal((await prisma.platformSettings.findUniqueOrThrow({ where: { id: settingsId } })).lastDispatchMonth, dispatchMonth(now));

    // A second run, or a second cron delivery, in the same month sends nothing.
    const again = await sendMarketDispatch(new Date(now.getTime() + 60 * 1000), { settingsId, userIds });
    assert.deepEqual([again.claimed, again.sent], [false, 0]);
    assert.equal(await claimDispatchMonth(dispatchMonth(now), settingsId), false);

    // Two runs racing on the next month: one claims it, the other finds it taken.
    const next = new Date(now.getTime() + 32 * DAY);
    const raced = await Promise.all([sendMarketDispatch(next, { settingsId, userIds }), sendMarketDispatch(next, { settingsId, userIds })]);
    assert.deepEqual(raced.map((run) => run.claimed).sort(), [false, true]);
    assert.equal(raced.reduce((sum, run) => sum + run.sent, 0), 2);

    // An earlier month never goes out after a later one.
    assert.equal((await sendMarketDispatch(new Date(now.getTime() - 40 * DAY), { settingsId, userIds })).claimed, false);

    assert.equal(await count(reader.email), 2);
    assert.equal(await count(seller.email), 2);
    for (const user of [pending, suspended, off, never]) assert.equal(await count(user.email), 0, `${user.name} got the dispatch`);
    const mail = await prisma.notification.findFirstOrThrow({ where: { toEmail: reader.email, subject: { startsWith: "UPB note-market dispatch" } } });
    assert.match(mail.body, /\/market/);
    assert.match(mail.body, /second-highest bid/);
    assert.match(mail.body, /not investment advice/);
    assert.equal(await prisma.auditEvent.count({ where: { action: "MARKET_DISPATCH", entityId: settingsId } }), 2);
  } finally {
    await prisma.notification.deleteMany({ where: { toEmail: { in: emails } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: settingsId }, { actorId: { in: userIds } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.platformSettings.deleteMany({ where: { id: settingsId } });
  }
});
