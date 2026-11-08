import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptTerms,
  addTranche,
  buyerPrograms,
  createProgram,
  criteriaFlags,
  deskTranche,
  criteriaOf,
  decideProgram,
  firstLookView,
  gridRowFor,
  gridSuggestion,
  inviteToProgram,
  moveCommitment,
  readGrid,
  readProgram,
  removeTranche,
  runFlowReleases,
  setGrid,
  startFirstLook,
  syncTranche,
  termsVersion,
  trancheReports,
  trancheStatusFor,
  type ProgramInput,
} from "../lib/flow-programs";
import { prisma } from "../lib/prisma";
import {
  addExclusion,
  audienceOf,
  AWARD_FIRST_LOOK,
  awardBlock,
  canSee,
  canSeeListing,
  inviteBuyers,
  invitedTo,
  listingAccess,
  listingScope,
  listingSight,
  outsideFirstLook,
} from "../lib/private-listings";
import { alertMatchingSearches } from "../lib/search-alerts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const email = (who: string) => `a-flow-${who}-${tag}@example.org`;
const made = { users: [] as string[], listings: [] as string[], emails: [] as string[], programs: [] as string[] };
const city = `Flowton${tag}`;

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER" | "ADMIN", file: "APPROVED" | "SUBMITTED" | null = role === "BUYER" ? "APPROVED" : null, extra: { companyName?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      email: email(who),
      name: `Flow ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      companyName: extra.companyName ?? "",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
    },
  });
  if (file) await prisma.buyerProfile.create({ data: { userId: user.id, status: file } });
  made.users.push(user.id);
  made.emails.push(user.email);
  return user;
}

type Loan = { state?: string; lienPosition?: "FIRST" | "SECOND"; paymentStatus?: "PERFORMING" | "NON_PERFORMING"; upb?: number; estimatedValue?: number; originationDate?: Date | null };

async function pool(sellerId: string, title: string, loans: Loan[], status: "SUBMITTED" | "APPROVED" = "SUBMITTED") {
  const row = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId,
      status,
      ...(status === "APPROVED" ? { approvedAt: new Date() } : {}),
      // Already claimed, so scoring this fixture never sends the desk a standing-bid notice.
      standingBidsNotifiedAt: new Date(),
      title: `${title} ${tag}`,
      notes: {
        create: loans.map((loan, index) => ({
          streetAddress: `${index + 1} Flow St`, city, state: loan.state ?? "TX", zip: "75001", propertyType: "SFR", occupancy: "TENANT",
          lienPosition: loan.lienPosition ?? "FIRST", upb: loan.upb ?? 100000, interestRate: 7, monthlyPi: 800, paymentStatus: loan.paymentStatus ?? "PERFORMING",
          monthsDelinquent: 0, askingPrice: 80000, estimatedValue: loan.estimatedValue ?? 200000, originationDate: loan.originationDate === undefined ? new Date(Date.now() - 40 * 30 * DAY) : loan.originationDate,
        })) as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

const TERMS = "Committed buyers see each tranche for the first-look hours before the market. Each bid is confirmed by the buyer.";

function input(extra: Partial<ProgramInput> = {}): ProgramInput {
  return {
    name: `Gulf flow ${tag}`,
    cadence: "MONTHLY",
    firstLookHours: "72",
    expectedVolume: "2,500,000",
    terms: TERMS,
    lienPositions: ["FIRST"],
    paymentStatuses: ["PERFORMING"],
    states: "TX, FL",
    maxUpb: "250,000",
    minSeasoningMonths: "12",
    ...extra,
  };
}

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const committed = await person("committed", "BUYER");
  const outsider = await person("outsider", "BUYER");
  const pending = await person("pending", "BUYER", "SUBMITTED");
  const rival = await person("rival", "BUYER", "APPROVED", { companyName: `Rival Flow ${tag}` });
  return { seller, desk, committed, outsider, pending, rival };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  const listingIds = made.listings;
  const userIds = made.users;
  const programs = (await prisma.flowProgram.findMany({ where: { sellerId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.flowTranche.deleteMany({ where: { programId: { in: programs } } });
  await prisma.flowCommitment.deleteMany({ where: { programId: { in: programs } } });
  await prisma.flowProgram.deleteMany({ where: { id: { in: programs } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingInvite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.sellerExclusion.deleteMany({ where: { sellerId: { in: userIds } } });
  await prisma.savedSearch.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...userIds, ...programs] } }, { actorId: { in: userIds } }] } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.rateWindow.deleteMany({ where: { OR: userIds.flatMap((id) => [{ key: { startsWith: `flow-invite:${id}` } }, { key: { startsWith: `listing-invite:${id}` } }]) } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.emails } }, { subject: { contains: tag } }, { body: { contains: tag } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

// An open programme with `committed` active on it.
async function openProgram(name: string, extra: Partial<ProgramInput> = {}) {
  const { seller, desk, committed } = world;
  const created = await createProgram(seller, input({ name: `${name} ${tag}`, ...extra }));
  if (!created.ok) throw new Error(created.error);
  made.programs.push(created.value.id);
  assert.equal((await decideProgram(desk, { programId: created.value.id, decision: "APPROVE", note: "" })).ok, true);
  const invited = await inviteToProgram(seller, { programId: created.value.id, emails: committed.email });
  assert.equal(invited.ok, true);
  const commitment = await prisma.flowCommitment.findUniqueOrThrow({ where: { programId_buyerId: { programId: created.value.id, buyerId: committed.id } } });
  const program = await prisma.flowProgram.findUniqueOrThrow({ where: { id: created.value.id } });
  assert.equal((await acceptTerms(committed, { commitmentId: commitment.id, version: termsVersion(program.terms) })).ok, true);
  return { program, commitment };
}

// The desk's approval, as reviewListing writes it, then the one call it makes.
async function approve(listingId: string, now = new Date()) {
  await prisma.listing.update({ where: { id: listingId }, data: { status: "APPROVED", approvedAt: now, launchAt: null } });
  return startFirstLook(listingId, now);
}

test("the criteria check flags each loan outside the programme, with why", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const criteria = criteriaOf({ lienPositions: ["FIRST"], paymentStatuses: ["PERFORMING"], states: ["TX", "FL"], maxUpb: 250000, minSeasoningMonths: 12 });
  const flags = criteriaFlags(
    [
      { state: "TX", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 200000, originationDate: new Date("2024-01-15T00:00:00Z") },
      { state: "GA", lienPosition: "SECOND", paymentStatus: "PERFORMING", upb: 90000, originationDate: new Date("2020-01-01T00:00:00Z") },
      { state: "FL", lienPosition: "FIRST", paymentStatus: "NON_PERFORMING", upb: 300000, originationDate: new Date("2026-06-01T00:00:00Z") },
      { state: "TX", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 100000, originationDate: null },
    ],
    criteria,
    now,
  );
  assert.deepEqual(flags.map((flag) => flag.index), [1, 2, 3], "the first loan fits");
  assert.deepEqual(flags[0].reasons, ["Second lien", "in GA"]);
  assert.deepEqual(flags[1].reasons, ["Non-performing", "UPB $300,000 is over $250,000", "seasoned 5 months, under 12"]);
  assert.deepEqual(flags[2].reasons, ["no origination date to show seasoning"]);
  assert.deepEqual(criteriaFlags([{ state: "NY", lienPosition: "THIRD", paymentStatus: "SUB_PERFORMING", upb: 9e6 }], criteriaOf(null)), [], "no criteria takes any loan");
  assert.deepEqual(criteriaOf({ lienPositions: ["first", "bogus"], states: "tx, zz", maxUpb: "nope" }), { lienPositions: ["FIRST"], paymentStatuses: [], states: ["TX"], maxUpb: null, minSeasoningMonths: null });

  assert.equal(readProgram(input({ firstLookHours: "23" })).error, "Set the first look between 24 and 168 hours.");
  assert.equal(readProgram(input({ firstLookHours: "169" })).error, "Set the first look between 24 and 168 hours.");
  assert.equal(readProgram(input({ firstLookHours: "168" })).error, null);
  assert.match(readProgram(input({ states: "TX, QQ" })).error ?? "", /QQ/);
  assert.equal(readProgram(input({ cadence: "WEEKLY" })).error, "Choose monthly, quarterly or ad hoc.");
  const read = readProgram(input({ expectedVolume: "" }));
  assert.equal(read.error, null);
  if (read.error === null) assert.equal(read.data.expectedVolumeCents, null);
  const large = readProgram(input({ expectedVolume: "3,000,000,000" }));
  assert.equal(large.error === null && large.data.expectedVolumeCents, 300_000_000_000, "past 32 bits is fine");
  assert.equal(readProgram(input({ expectedVolume: "6,000,000,000" })).error, "Enter an expected volume up to $5,000,000,000.");
});

test("the grid prices each loan from its own row, the tightest LTV band first, and the cap holds the total", () => {
  const grid = [
    { paymentStatus: "ANY", lienPosition: "ANY", maxLtv: null, pct: 40 },
    { paymentStatus: "PERFORMING", lienPosition: "FIRST", maxLtv: 100, pct: 70 },
    { paymentStatus: "PERFORMING", lienPosition: "FIRST", maxLtv: 60, pct: 85 },
    { paymentStatus: "NON_PERFORMING", lienPosition: "FIRST", maxLtv: 80, pct: 50 },
  ];
  const loan = (upb: number, value: number, paymentStatus = "PERFORMING", lienPosition = "FIRST") => ({ upb, estimatedValue: value, paymentStatus, lienPosition });
  assert.equal(gridRowFor(loan(50000, 100000), grid)?.pct, 85, "50% LTV sits in the 60 band");
  assert.equal(gridRowFor(loan(90000, 100000), grid)?.pct, 70, "90% LTV only fits the 100 band");
  assert.equal(gridRowFor(loan(120000, 100000), grid)?.pct, 40, "over every named band, the any row");
  assert.equal(gridRowFor(loan(90000, 100000, "NON_PERFORMING"), grid)?.pct, 40, "a non-performer over its band falls to the any row");
  assert.equal(gridRowFor(loan(90000, 0), grid)?.pct, 40, "no value, no LTV band fits");
  assert.equal(gridRowFor(loan(90000, 100000), grid.slice(1, 3))?.pct, 70);
  assert.equal(gridRowFor(loan(90000, 100000, "SUB_PERFORMING", "SECOND"), grid.slice(1)), null);

  const loans = [loan(100000, 200000), loan(100000, 125000), loan(100000, 100000, "SUB_PERFORMING", "SECOND")];
  const named = grid.slice(1);
  assert.deepEqual(gridSuggestion(loans, named), { amount: 155000, priced: 2, unpriced: 1, capped: false, cap: null, upb: 200000 });
  assert.deepEqual(gridSuggestion(loans, named, 12_000_000), { amount: 120000, priced: 2, unpriced: 1, capped: true, cap: 120000, upb: 200000 });
  assert.equal(gridSuggestion(loans, []), null);

  const rows = readGrid({ statuses: ["PERFORMING", "ANY", "ANY"], liens: ["FIRST", "ANY", "ANY"], ltvs: ["75", "", ""], pcts: ["82.5", "", "40"] });
  assert.equal(rows.error, null);
  if (rows.error === null) assert.deepEqual(rows.grid, [{ paymentStatus: "PERFORMING", lienPosition: "FIRST", maxLtv: 75, pct: 82.5 }, { paymentStatus: "ANY", lienPosition: "ANY", maxLtv: null, pct: 40 }]);
  assert.match(readGrid({ statuses: ["ANY"], liens: ["ANY"], ltvs: [""], pcts: ["400"] }).error ?? "", /Row 1/);
  assert.match(readGrid({ statuses: ["ANY"], liens: ["ANY"], ltvs: ["lots"], pcts: ["50"] }).error ?? "", /LTV/);
});

test("a tranche follows its listing: in contract is awarded, withdrawn is withdrawn, and a fallen award goes back", () => {
  assert.equal(trancheStatusFor({ status: "FIRST_LOOK", releasedAt: null }, "PENDING"), "AWARDED");
  assert.equal(trancheStatusFor({ status: "RELEASED", releasedAt: new Date() }, "SOLD"), "AWARDED");
  assert.equal(trancheStatusFor({ status: "AWARDED", releasedAt: null }, "APPROVED"), "FIRST_LOOK");
  assert.equal(trancheStatusFor({ status: "AWARDED", releasedAt: new Date() }, "APPROVED"), "RELEASED");
  assert.equal(trancheStatusFor({ status: "FIRST_LOOK", releasedAt: null }, "WITHDRAWN"), "WITHDRAWN");
  assert.equal(trancheStatusFor({ status: "WITHDRAWN", releasedAt: null }, "APPROVED"), "WITHDRAWN", "a withdrawal is final");
  assert.equal(trancheStatusFor({ status: "FIRST_LOOK", releasedAt: null }, "UNDER_REVIEW"), "FIRST_LOOK");
});

test("a programme opens on the desk's approval, takes approved buyers only, and the terms are accepted once against their version", async () => {
  const { seller, desk, committed, outsider, pending, rival } = world;
  assert.equal((await createProgram(committed, input())).ok, false, "a buyer can't start one");
  const created = await createProgram(seller, input({ name: `Lifecycle ${tag}` }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const programId = created.value.id;
  assert.equal((await inviteToProgram(seller, { programId, emails: committed.email })).ok, false, "no buyers before approval");
  assert.equal((await decideProgram(seller, { programId, decision: "APPROVE", note: "" })).ok, false, "the seller can't approve it");
  assert.equal((await decideProgram(desk, { programId, decision: "PAUSE", note: "" })).ok, false, "a draft can't be paused");
  assert.equal((await decideProgram(desk, { programId, decision: "APPROVE", note: "" })).ok, true);
  assert.equal((await prisma.flowProgram.findUniqueOrThrow({ where: { id: programId } })).status, "OPEN");

  await addExclusion(seller, { kind: "COMPANY", value: `Rival Flow ${tag}`, reason: "" });
  const invited = await inviteToProgram(seller, { programId, emails: [committed.email, pending.email, rival.email, `nobody-${tag}@example.org`, desk.email].join(", ") });
  assert.equal(invited.ok, true);
  if (invited.ok) {
    assert.deepEqual(invited.value.invited, [committed.email]);
    assert.deepEqual(
      Object.fromEntries(invited.value.skipped.map((row) => [row.email, row.reason])),
      { [pending.email]: "not an approved buyer", [rival.email]: "on the seller's excluded buyers", [`nobody-${tag}@example.org`]: "not an approved buyer", [desk.email]: "not an approved buyer" },
    );
  }
  const again = await inviteToProgram(seller, { programId, emails: committed.email });
  assert.equal(again.ok && again.value.skipped[0]?.reason, "already in the programme");
  assert.equal((await inviteToProgram(outsider, { programId, emails: committed.email })).ok, false, "only the seller or the desk invites");

  const commitment = await prisma.flowCommitment.findUniqueOrThrow({ where: { programId_buyerId: { programId, buyerId: committed.id } } });
  assert.equal(commitment.status, "INVITED");
  assert.equal((await acceptTerms(outsider, { commitmentId: commitment.id, version: termsVersion(TERMS) })).ok, false, "not their invitation");
  assert.equal((await acceptTerms(committed, { commitmentId: commitment.id, version: "stale" })).ok, false);
  const accepted = await acceptTerms(committed, { commitmentId: commitment.id, version: termsVersion(TERMS) });
  assert.equal(accepted.ok, true);
  const active = await prisma.flowCommitment.findUniqueOrThrow({ where: { id: commitment.id } });
  assert.equal(active.status, "ACTIVE");
  assert.ok(active.acceptedAt);
  assert.equal(active.termsVersion, termsVersion(TERMS));
  assert.equal((await acceptTerms(committed, { commitmentId: commitment.id, version: termsVersion(TERMS) })).ok, false, "accepted once");
  assert.equal((await decideProgram(desk, { programId, decision: "CLOSE", note: "" })).ok, true);
});

test("in first look only active committed buyers, the seller and the desk see a tranche; the book, search and alerts follow", async () => {
  const { seller, desk, committed, outsider } = world;
  const { program, commitment } = await openProgram("Visibility");
  const listing = await pool(seller.id, "First look pool", [{}, { upb: 150000 }, { lienPosition: "SECOND", state: "GA" }]);
  const added = await addTranche(seller, { programId: program.id, listingId: listing.id });
  assert.equal(added.ok, true);
  if (added.ok) assert.equal(added.value.flagged, 1, "the second lien in GA is flagged");
  assert.equal((await addTranche(seller, { programId: program.id, listingId: listing.id })).ok, false, "a listing joins once");
  assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).flowProgramId, program.id);

  for (const user of [committed, outsider]) {
    await prisma.savedSearch.create({ data: { userId: user.id, name: `Flowton ${tag}`, filters: { q: city.toLowerCase() }, cadence: "INSTANT" } });
  }
  const now = new Date();
  const started = await approve(listing.id, now);
  assert.ok(started, "approval starts the first look and holds the market's alerts");
  assert.equal(started?.endsAt.getTime(), now.getTime() + 72 * HOUR);
  const shown = { id: listing.id, sellerId: listing.sellerId };
  assert.equal(await canSeeListing(committed, shown), true);
  assert.equal(await canSeeListing(outsider, shown), false);
  assert.equal(await canSeeListing(null, shown), false);
  assert.equal(await canSeeListing(seller, shown), true);
  assert.equal(await canSeeListing(desk, shown), true);
  assert.deepEqual(await listingSight(committed, shown), { visible: true, invited: true }, "the first look lifts the early and slice holds");

  const book = async (user: { id: string; role: string } | null) =>
    (await prisma.listing.findMany({ where: { id: listing.id, AND: [await listingScope(user)] }, select: { id: true } })).length;
  assert.equal(await book(committed), 1);
  assert.equal(await book(outsider), 0);
  assert.equal(await book(null), 0);
  assert.equal(await book(seller), 1);
  assert.equal(await book(desk), 1);
  const access = await listingAccess(committed);
  assert.equal(canSee(access, shown), true);
  assert.equal(invitedTo(access, shown), true);
  assert.equal(access.firstLookOpen?.has(listing.id), true, "the book lifts its veil for a committed buyer");
  assert.equal(canSee(await listingAccess(outsider), shown), false);
  assert.equal((await prisma.listing.count({ where: { id: listing.id, AND: [await outsideFirstLook()] } })), 0, "off the public pages");
  assert.deepEqual((await audienceOf(shown, [committed, outsider])).map((user) => user.id), [committed.id]);
  assert.equal(await awardBlock({ id: "bid", listingId: listing.id, listing: shown, buyer: outsider }), AWARD_FIRST_LOOK);
  assert.equal(await awardBlock({ id: "bid", listingId: listing.id, listing: shown, buyer: committed }), null);

  // The committed buyer heard, with a link. Nobody else did, and no market alert went out.
  const mail = async (to: string) => prisma.notification.findMany({ where: { toEmail: to, OR: [{ subject: { contains: tag } }, { body: { contains: tag } }] }, select: { subject: true, body: true } });
  const heard = await mail(committed.email);
  assert.ok(heard.some((row) => row.subject === `First look · ${listing.title}` && row.body.includes(`/marketplace/${listing.id}`)));
  assert.equal((await mail(outsider.email)).length, 0);
  assert.ok(!heard.some((row) => row.subject.startsWith("New paper matches")), "approval sent no saved-search alert");
  // Even a stray alert during the first look reaches committed buyers only.
  await alertMatchingSearches(listing.id, now);
  assert.equal((await mail(outsider.email)).length, 0);

  // Paused, the committed buyer is outside; resumed, back in.
  assert.equal((await moveCommitment(committed, { commitmentId: commitment.id, move: "PAUSE" })).ok, true);
  assert.equal(await canSeeListing(committed, shown), false);
  assert.equal((await moveCommitment(committed, { commitmentId: commitment.id, move: "RESUME" })).ok, true);
  assert.equal(await canSeeListing(committed, shown), true);

  // The release opens it to the market, alerts it as approval would have, and counts it as new from now.
  const early = await runFlowReleases(new Date(now.getTime() + 71 * HOUR), { listingIds: [listing.id] });
  assert.equal(early.sent, 0, "not before the first look ends");
  const at = new Date(now.getTime() + 72 * HOUR + 60000);
  const released = await runFlowReleases(at, { listingIds: [listing.id] });
  assert.equal(released.sent, 1);
  assert.equal((await runFlowReleases(at, { listingIds: [listing.id] })).sent, 0, "released once");
  const tranche = await prisma.flowTranche.findUniqueOrThrow({ where: { listingId: listing.id } });
  assert.equal(tranche.status, "RELEASED");
  assert.equal(tranche.releasedAt?.getTime(), at.getTime());
  assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).approvedAt?.getTime(), at.getTime());
  assert.equal(await canSeeListing(outsider, shown), true);
  assert.equal(await book(null), 1);
  assert.ok((await mail(outsider.email)).some((row) => row.subject.startsWith("New paper matches")), "the market's alert went at the release");
  assert.ok((await mail(seller.email)).some((row) => row.subject === `Released · ${listing.title}`));
});

test("first look narrows a private tranche and never widens it: a committed buyer still needs an invitation", async () => {
  const { seller, committed, outsider, pending } = world;
  const { program } = await openProgram("Private");
  const listing = await pool(seller.id, "Private tranche", [{}]);
  await prisma.listing.update({ where: { id: listing.id }, data: { visibility: "PRIVATE" } });
  assert.equal((await addTranche(seller, { programId: program.id, listingId: listing.id })).ok, true);
  const now = new Date();
  assert.ok(await approve(listing.id, now));
  const shown = { id: listing.id, sellerId: listing.sellerId };
  assert.equal(await canSeeListing(committed, shown), false, "committed but not invited");
  const invited = await inviteBuyers(seller, { listingId: listing.id, emails: `${committed.email}, ${outsider.email}` });
  assert.equal(invited.ok, true);
  assert.equal(await canSeeListing(committed, shown), true, "committed and invited");
  assert.equal(await canSeeListing(outsider, shown), false, "invited but not committed waits for the release");
  assert.equal(canSee(await listingAccess(outsider), shown), false);
  assert.equal(canSee(await listingAccess(committed), shown), true);

  await runFlowReleases(new Date(now.getTime() + 73 * HOUR), { listingIds: [listing.id] });
  assert.equal(await canSeeListing(outsider, shown), true, "after the release the invitation opens it");
  assert.equal(await canSeeListing(pending, shown), false, "and it is still private to everyone else");
  assert.equal(await canSeeListing(null, shown), false);
});

test("the bid form is pre-filled from the committed buyer's grid, held to their cap, and the seller never sees the grid", async () => {
  const { seller, committed, outsider } = world;
  const { program, commitment } = await openProgram("Grid");
  const listing = await pool(seller.id, "Grid pool", [{ upb: 100000, estimatedValue: 200000 }, { upb: 200000, estimatedValue: 220000 }, { upb: 50000, paymentStatus: "NON_PERFORMING" }]);
  assert.equal((await addTranche(seller, { programId: program.id, listingId: listing.id })).ok, true);
  const grid = [
    { paymentStatus: "PERFORMING", lienPosition: "FIRST", maxLtv: 60, pct: 90 },
    { paymentStatus: "PERFORMING", lienPosition: "FIRST", maxLtv: null, pct: 75 },
  ];
  assert.equal((await setGrid(outsider, { commitmentId: commitment.id, grid, cap: "" })).ok, false, "only the buyer sets their grid");
  assert.equal((await setGrid(committed, { commitmentId: commitment.id, grid, cap: "" })).ok, true);
  assert.ok(await approve(listing.id));
  const loans = (await prisma.note.findMany({ where: { listingId: listing.id } })).map((note) => ({ upb: Number(note.upb), estimatedValue: Number(note.estimatedValue), lienPosition: note.lienPosition, paymentStatus: note.paymentStatus }));
  const view = await firstLookView(listing.id, committed, loans);
  assert.ok(view?.endsAt);
  assert.equal(view?.suggestion?.amount, 240000, "90% of 100,000 and 75% of 200,000; the non-performer adds nothing");
  assert.match(view?.suggestion?.line ?? "", /1 loan sits outside your grid/);
  assert.match(view?.suggestion?.line ?? "", /confirm/);
  assert.equal((await firstLookView(listing.id, seller, loans))?.suggestion, null, "the seller gets the banner, no suggestion");
  assert.ok((await firstLookView(listing.id, seller, loans))?.endsAt);

  assert.equal((await setGrid(committed, { commitmentId: commitment.id, grid, cap: "200,000" })).ok, true);
  const capped = await firstLookView(listing.id, committed, loans);
  assert.equal(capped?.suggestion?.amount, 200000);
  assert.match(capped?.suggestion?.line ?? "", /Held to your \$200,000 cap/);
  assert.equal((await setGrid(committed, { commitmentId: commitment.id, grid, cap: "6,000,000,000" })).ok, false, "a cap past $5B is refused");
  assert.equal((await setGrid(committed, { commitmentId: commitment.id, grid, cap: "3,000,000,000" })).ok, true);
  assert.equal((await prisma.flowCommitment.findUniqueOrThrow({ where: { id: commitment.id } })).maxPerTrancheCents, 300_000_000_000);
  assert.equal((await setGrid(committed, { commitmentId: commitment.id, grid, cap: "200,000" })).ok, true);
  // The desk's review names the programme and the flagged loan.
  const desk = await deskTranche(listing.id);
  assert.equal(desk?.program.id, program.id);
  assert.deepEqual(desk?.flags.map((flag) => flag.index), [2]);
  assert.equal(await deskTranche(world.outsider.id), null);
  // Nothing is bid for the buyer.
  assert.equal(await prisma.inquiry.count({ where: { listingId: listing.id } }), 0);

  // The seller's report counts buyers and bids; no grid, no bidder.
  const [report] = await trancheReports(program.id);
  assert.equal(report.loans, 3);
  assert.equal(report.upb, 350000);
  assert.equal(report.flagged, 1);
  assert.equal(report.committed, 1);
  assert.ok(!JSON.stringify(report).includes("pct"), "no grid in the seller's report");
  await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: committed.id, type: "OFFER", amount: 245000, status: "ACCEPTED" } });
  const [after] = await trancheReports(program.id);
  assert.equal(after.firstLookBids, 1);
  assert.equal(after.marketBids, 0);
  assert.equal(after.committedBidders, 1);
  assert.equal(after.awardPct?.toFixed(1), "70.0");
  const mine = await buyerPrograms(committed.id);
  assert.ok(mine.find((row) => row.programId === program.id)?.open.some((tranche) => tranche.listingId === listing.id), "the buyer's page lists the open tranche");
});

test("no first look without an active committed buyer or an open programme, an award ends it, and a tranche leaves before approval only", async () => {
  const { seller, desk, committed } = world;
  // A plain listing is outside any programme: the caller alerts the market as usual.
  const plain = await pool(seller.id, "Plain pool", [{}], "APPROVED");
  assert.equal(await startFirstLook(plain.id), null);

  const { program, commitment } = await openProgram("Empty");
  const lonely = await pool(seller.id, "Lonely pool", [{}]);
  assert.equal((await addTranche(seller, { programId: program.id, listingId: lonely.id })).ok, true);
  assert.equal((await moveCommitment(committed, { commitmentId: commitment.id, move: "LEAVE" })).ok, true);
  assert.equal(await approve(lonely.id), null, "nobody active, so it goes straight to the market");
  assert.equal((await prisma.flowTranche.findUniqueOrThrow({ where: { listingId: lonely.id } })).status, "RELEASED");

  const { program: busy } = await openProgram("Busy");
  const taken = await pool(seller.id, "Taken pool", [{}]);
  const back = await pool(seller.id, "Back out pool", [{}]);
  const added = await addTranche(seller, { programId: busy.id, listingId: back.id });
  assert.equal(added.ok, true);
  if (added.ok) {
    assert.equal((await removeTranche(seller, added.value.trancheId)).ok, true, "out before approval");
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: back.id } })).flowProgramId, null);
  }
  assert.equal((await addTranche(seller, { programId: busy.id, listingId: taken.id })).ok, true);
  assert.ok(await approve(taken.id));
  const trancheId = (await prisma.flowTranche.findUniqueOrThrow({ where: { listingId: taken.id } })).id;
  assert.equal((await removeTranche(seller, trancheId)).ok, false, "past approval it stays");
  await prisma.listing.update({ where: { id: taken.id }, data: { status: "PENDING" } });
  assert.equal(await syncTranche(taken.id), "AWARDED");
  assert.equal(await canSeeListing(world.outsider, { id: taken.id, sellerId: seller.id }), true, "an awarded tranche has no first look");
  await prisma.listing.update({ where: { id: taken.id }, data: { status: "APPROVED" } });
  assert.equal(await syncTranche(taken.id), "FIRST_LOOK", "a fallen award puts the first look back");
  await prisma.listing.update({ where: { id: taken.id }, data: { status: "WITHDRAWN" } });
  await runFlowReleases(new Date(), { listingIds: [taken.id] });
  assert.equal((await prisma.flowTranche.findUniqueOrThrow({ where: { listingId: taken.id } })).status, "WITHDRAWN", "the job brings it in line");

  // Paused, the programme takes no tranche; closed, its first looks release at once.
  assert.equal((await decideProgram(desk, { programId: busy.id, decision: "PAUSE", note: "" })).ok, true);
  const late = await pool(seller.id, "Late pool", [{}]);
  assert.equal((await addTranche(seller, { programId: busy.id, listingId: late.id })).ok, false);
  assert.equal((await decideProgram(desk, { programId: busy.id, decision: "RESUME", note: "" })).ok, true);
  assert.equal((await addTranche(seller, { programId: busy.id, listingId: late.id })).ok, true);
  assert.ok(await approve(late.id));
  assert.equal((await decideProgram(desk, { programId: busy.id, decision: "CLOSE", note: "" })).ok, true);
  assert.equal((await prisma.flowTranche.findUniqueOrThrow({ where: { listingId: late.id } })).status, "RELEASED");
  assert.equal(await canSeeListing(world.outsider, { id: late.id, sellerId: seller.id }), true);
});
