import assert from "node:assert/strict";
import test from "node:test";
import { literal } from "../lib/db-filters";
import { rescoreBox, rescoreListing } from "../lib/matching";
import { prisma } from "../lib/prisma";
import { OFAC_HOLD_MESSAGE } from "../lib/screening";
import { clearSettingsCache, getSettings } from "../lib/settings";
import {
  claimStandingNotice,
  confirmStanding,
  indicativeFor,
  inviteToConfirm,
  openInvitations,
  passStanding,
  readStandingRule,
  remainingTerm,
  ruleOf,
  standingNotice,
  standingSheet,
  yieldPrice,
} from "../lib/standing-bids";
import { performingCase } from "../lib/underwriting";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

const loan = (id: string, upb: number, ask: number, extra: Partial<{ paymentStatus: string; tradeStatus: string; monthlyPi: number; interestRate: number; maturityDate: Date | null }> = {}) => ({
  id,
  upb,
  askingPrice: ask,
  interestRate: 7,
  monthlyPi: 700,
  paymentStatus: "PERFORMING",
  maturityDate: null,
  tradeStatus: "AVAILABLE",
  ...extra,
});
const rule = (over: Partial<{ standingBids: boolean | null; bidBasis: string | null; bidPercent: number | null; bidCap: number | null; targetYield: number | null }> = {}) => ({
  standingBids: true,
  bidBasis: "UPB",
  bidPercent: 70,
  bidCap: null,
  targetYield: null,
  ...over,
});

test("a UPB rule prices each loan at its percent, under the per-loan cap and the ask, and sums a pool", () => {
  assert.equal(indicativeFor(rule({ standingBids: false }), { kind: "SINGLE" }, [loan("a", 100000, 90000)]), null);
  assert.equal(indicativeFor(rule({ bidPercent: null }), { kind: "SINGLE" }, [loan("a", 100000, 90000)]), null);

  const single = indicativeFor(rule(), { kind: "SINGLE" }, [loan("a", 100000, 90000)]);
  assert.equal(single?.price, 70000);
  assert.equal(single?.ofUpb, 70);
  assert.equal(single?.loans[0].limit, "rule");

  // The cap binds per loan: 70% of 200,000 is 140,000, held to 100,000. The small loan is under the cap.
  const pool = indicativeFor(rule({ bidCap: 100000 }), { kind: "POOL" }, [loan("a", 200000, 180000), loan("b", 50000, 45000)]);
  assert.deepEqual(pool?.loans.map((row) => [row.price, row.limit]), [[100000, "cap"], [35000, "rule"]]);
  assert.equal(pool?.price, 135000);
  assert.equal(pool?.ofUpb, 54);

  // Never above what the seller asks.
  const cheap = indicativeFor(rule(), { kind: "SINGLE" }, [loan("a", 100000, 60000)]);
  assert.equal(cheap?.price, 60000);
  assert.equal(cheap?.loans[0].limit, "ask");

  // A pool with a traded loan can't be bid whole, so it gets no price.
  const traded = indicativeFor(rule(), { kind: "POOL" }, [loan("a", 100000, 90000), loan("b", 100000, 90000, { tradeStatus: "IN_CONTRACT" })]);
  assert.equal(traded?.price, null);
  assert.match(traded?.why ?? "", /1 of 2 loans have traded/);
});

test("a yield rule solves for the price that returns the target IRR, and skips loans no model can price", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const maturity = new Date(now.getTime() + 240 * 30 * DAY);
  const input = { upb: 100000, annualRate: 7, monthlyPi: 775.3, termMonths: remainingTerm(maturity, now) };
  assert.equal(input.termMonths, 240);
  for (const target of [8, 10, 12.5, 15]) {
    const price = yieldPrice(input, target);
    assert.ok(price && price > 0);
    // Round trip: the performing case at that price returns the target.
    const irr = performingCase({ ...input, bid: price }).irrPct ?? 0;
    assert.ok(Math.abs(irr - target) < 0.001, `target ${target}, got ${irr}`);
  }
  // A higher target means a lower price.
  assert.ok((yieldPrice(input, 15) ?? 0) < (yieldPrice(input, 8) ?? 0));
  assert.equal(yieldPrice({ ...input, monthlyPi: 0 }, 10), null);

  const box = rule({ bidBasis: "YIELD", bidPercent: null, targetYield: 12 });
  assert.equal(ruleOf(rule({ bidBasis: "YIELD", targetYield: null })), null);
  const priced = indicativeFor(box, { kind: "SINGLE" }, [loan("a", 100000, 100000, { monthlyPi: 775.3, maturityDate: maturity })], now);
  assert.equal(priced?.price, Math.round(yieldPrice(input, 12) ?? 0));
  // Sub- and non-performing loans get no yield price, and a pool holding one gets none at all.
  const mixed = indicativeFor(box, { kind: "POOL" }, [loan("a", 100000, 100000), loan("b", 80000, 40000, { paymentStatus: "NON_PERFORMING" })], now);
  assert.equal(mixed?.price, null);
  assert.equal(mixed?.loans[0].price != null, true);
  assert.equal(mixed?.loans[1].skipped, "status");
  assert.match(mixed?.why ?? "", /performing loans only/);
  // A UPB rule still prices a non-performing loan, because the buyer named the figure.
  assert.equal(indicativeFor(rule(), { kind: "SINGLE" }, [loan("a", 80000, 60000, { paymentStatus: "NON_PERFORMING" })])?.price, 56000);
});

test("the rule form is Pro only, needs a figure for its basis, and stays under the box's own ceiling", () => {
  const box = { targetYield: null, maxPriceToUpb: 75 };
  const fields = (over: Partial<{ basis: string; percent: string; cap: string; target: string }>) => ({ basis: "UPB", percent: "70", cap: "", target: "", ...over });
  assert.deepEqual(readStandingRule(fields({ basis: "OFF" }), box, false), { error: null, data: { standingBids: false } });
  assert.match((readStandingRule(fields({}), box, false) as { error: string }).error, /Pro privilege/);
  assert.match((readStandingRule(fields({ basis: "MAYBE" }), box, true) as { error: string }).error, /Choose how/);
  assert.deepEqual(readStandingRule(fields({ percent: "70%", cap: "$50,000" }), box, true), { error: null, data: { standingBids: true, bidBasis: "UPB", bidPercent: 70, bidCap: 50000 } });
  assert.match((readStandingRule(fields({ percent: "80" }), box, true) as { error: string }).error, /tops out at 75%/);
  assert.match((readStandingRule(fields({ percent: "" }), box, true) as { error: string }).error, /percent of UPB/);
  assert.match((readStandingRule(fields({ cap: "-5" }), box, true) as { error: string }).error, /most for one loan/);
  assert.match((readStandingRule(fields({ basis: "YIELD" }), box, true) as { error: string }).error, /target IRR/);
  assert.deepEqual(readStandingRule(fields({ basis: "YIELD", target: "12" }), box, true), { error: null, data: { standingBids: true, bidBasis: "YIELD", bidCap: null, targetYield: 12 } });
  assert.deepEqual(readStandingRule(fields({ basis: "YIELD" }), { targetYield: 11, maxPriceToUpb: null }, true), { error: null, data: { standingBids: true, bidBasis: "YIELD", bidCap: null } });
  assert.equal(standingNotice("Pool A", [{ userId: "a", ofUpb: 71.6 }, { userId: "b", ofUpb: 64 }, { userId: "b", ofUpb: 60 }]), "3 standing bids from 2 buyers on Pool A, top 72% of UPB.");
});

// Timestamp-tagged people, a pool in a state no seeded box covers, and buy boxes that only fit it.
async function makeTape(opts: { status?: "SUBMITTED" | "APPROVED"; pro?: boolean; verified?: boolean } = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const state = "ZZ";
  const user = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN", pro = false) =>
    prisma.user.create({
      data: {
        email: `sb-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(pro ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const seller = await user("seller", "INDIVIDUAL_SELLER");
  const buyer = await user("buyer", "BUYER", opts.pro ?? true);
  const desk = await user("desk", "ADMIN");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, status: opts.verified === false ? "SUBMITTED" : "APPROVED", entityName: `Fund ${tag}` } });
  const note = (street: string, upb: number) => ({
    streetAddress: street, city: "Testville", state, zip: "00000", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST", upb, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: upb * 0.9, estimatedValue: upb * 1.5,
  });
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: opts.status ?? "SUBMITTED",
      ...(opts.status === "APPROVED" ? { approvedAt: new Date() } : {}),
      title: `Standing tape ${tag}`,
      notes: { create: [note("1 First St", 100000), note("2 Second St", 60000)] as never },
    },
    include: { notes: true },
  });
  const box = await prisma.buyBox.create({
    data: { userId: buyer.id, name: `Box ${tag}`, states: state, standingBids: true, bidBasis: "UPB", bidPercent: 70 },
  });
  return { tag, seller, buyer, desk, listing, box, users: [seller, buyer, desk] };
}

type Tape = Awaited<ReturnType<typeof makeTape>>;

async function cleanTape(tape: Tape) {
  const listingId = tape.listing.id;
  const userIds = tape.users.map((row) => row.id);
  const inquiries = await prisma.inquiry.findMany({ where: { listingId }, select: { id: true } });
  const inquiryIds = inquiries.map((row) => row.id);
  const boxes = await prisma.buyBox.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const matches = await prisma.listingMatch.findMany({ where: { OR: [{ listingId }, { buyBoxId: { in: boxes.map((row) => row.id) } }] }, select: { id: true } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [listingId, ...inquiryIds, ...matches.map((row) => row.id)] } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId }, { inquiryId: { in: inquiryIds } }] } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId } });
  await prisma.listingMatch.deleteMany({ where: { id: { in: matches.map((row) => row.id) } } });
  await prisma.buyBox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.note.deleteMany({ where: { listingId } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: tape.users.map((row) => row.email) } }, { subject: { contains: tape.listing.title } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const matchOf = (tape: Tape, boxId = tape.box.id) => prisma.listingMatch.findUniqueOrThrow({ where: { listingId_buyBoxId: { listingId: tape.listing.id, buyBoxId: boxId } } });
// `contains` runs as a pattern on MongoDB, so the dollar sign in a subject is escaped.
const mail = (toEmail: string, subject: string) => prisma.notification.count({ where: { toEmail, subject: { contains: literal(subject) } } });

test("a new tape is priced against standing rules, the desk hears once, and a rule change reprices open matches", async () => {
  const tape = await makeTape();
  try {
    await rescoreListing(tape.listing.id, false);
    const first = await matchOf(tape);
    // 70% of 160,000 UPB, each loan under its 90% ask.
    assert.equal(first.indicativePrice, 112000);
    assert.ok(first.indicativeAt);
    assert.match(first.reasons, /At the standing price/);
    assert.equal(await mail(tape.desk.email, `Standing bids · ${tape.listing.title}`), 1);
    const body = await prisma.notification.findFirstOrThrow({ where: { toEmail: tape.desk.email, subject: { contains: "Standing bids" } } });
    assert.match(body.body, /1 standing bid on Standing tape .*, top 70% of UPB\./);
    // A second scoring run, as on a resubmission, says nothing new.
    await rescoreListing(tape.listing.id, false);
    assert.equal(await mail(tape.desk.email, `Standing bids · ${tape.listing.title}`), 1);

    // The desk sees it on the sheet while the tape is in review, with invites waiting for approval.
    const rows = await standingSheet(tape.listing);
    const row = rows.find((item) => item.matchId === first.id);
    assert.equal(row?.price, 112000);
    assert.equal(row?.ofUpb, 70);
    assert.equal(row?.canInvite, false);
    assert.equal(row?.block, "Invites open once the listing is live.");

    // A rule change reprices: a lower percent and a cap that binds the big loan.
    await prisma.buyBox.update({ where: { id: tape.box.id }, data: { bidPercent: 60, bidCap: 50000 } });
    await rescoreBox(tape.box.id, { quiet: true });
    assert.equal((await matchOf(tape)).indicativePrice, 50000 + 36000);
    assert.equal(await mail(tape.buyer.email, "Buy box ·"), 0);

    // An invite at a figure that then moves is withdrawn, so the buyer never confirms a stale price.
    await prisma.listing.update({ where: { id: tape.listing.id }, data: { status: "APPROVED", approvedAt: new Date() } });
    assert.equal((await inviteToConfirm(first.id, tape.listing.id, tape.desk.id)).error, null);
    await prisma.buyBox.update({ where: { id: tape.box.id }, data: { bidCap: null } });
    await rescoreBox(tape.box.id, { quiet: true });
    const moved = await matchOf(tape);
    assert.equal(moved.indicativePrice, 96000);
    assert.equal(moved.invitedAt, null);

    // An answered match keeps its figure. Turning the rule off clears an open one.
    await prisma.listingMatch.update({ where: { id: first.id }, data: { answeredAt: new Date() } });
    await prisma.buyBox.update({ where: { id: tape.box.id }, data: { bidPercent: 50 } });
    await rescoreBox(tape.box.id, { quiet: true });
    assert.equal((await matchOf(tape)).indicativePrice, 96000);
    await prisma.listingMatch.update({ where: { id: first.id }, data: { answeredAt: null } });
    await prisma.buyBox.update({ where: { id: tape.box.id }, data: { standingBids: false } });
    await rescoreBox(tape.box.id, { quiet: true });
    const off = await matchOf(tape);
    assert.equal(off.indicativePrice, null);
    assert.doesNotMatch(off.reasons, /standing price/);

    // A lapsed Pro membership keeps the rule on file but prices nothing.
    await prisma.buyBox.update({ where: { id: tape.box.id }, data: { standingBids: true } });
    await prisma.user.update({ where: { id: tape.buyer.id }, data: { subscriptionTier: "FREE" } });
    await rescoreBox(tape.box.id, { quiet: true });
    assert.equal((await matchOf(tape)).indicativePrice, null);
  } finally {
    await cleanTape(tape);
  }
});

test("two runs claiming the same tape's desk notice at once send it once", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const seller = await prisma.user.create({ data: { email: `sb-claim-${tag}@example.org`, name: `Claim ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, title: `Claim ${tag}`, status: "SUBMITTED" } });
  try {
    const claims = await Promise.all([1, 2, 3].map(() => claimStandingNotice(listing.id)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await claimStandingNotice(listing.id), false);
  } finally {
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.user.deleteMany({ where: { id: seller.id } });
  }
});

test("a rule prices a tape that asks more than the box would pay, scored at the box's own price", async () => {
  const tape = await makeTape();
  try {
    // The ask is 90% of UPB, over this box's 75% ceiling, so it fits only at the standing price.
    await prisma.buyBox.update({ where: { id: tape.box.id }, data: { maxPriceToUpb: 75 } });
    await rescoreListing(tape.listing.id, false);
    assert.equal((await matchOf(tape)).indicativePrice, 112000);
    await prisma.buyBox.update({ where: { id: tape.box.id }, data: { standingBids: false } });
    await rescoreBox(tape.box.id, { quiet: true });
    assert.equal(await prisma.listingMatch.count({ where: { listingId: tape.listing.id, buyBoxId: tape.box.id } }), 0);
  } finally {
    await cleanTape(tape);
  }
});

test("an invite then a confirm makes exactly one bid, after every gate the bid form runs", async () => {
  clearSettingsCache();
  const settings = await getSettings();
  const tape = await makeTape({ verified: false });
  try {
    await rescoreListing(tape.listing.id, false);
    const match = await matchOf(tape);
    const price = match.indicativePrice ?? 0;
    assert.equal(price, 112000);
    const confirm = (over: Partial<{ price: number; goodUntil: string; matchId: string }> = {}) =>
      confirmStanding({ matchId: match.id, user: tape.buyer, price, goodUntil: "", ...over });

    // The desk can't invite on a tape still in review, and a buyer can't confirm what wasn't sent.
    assert.match((await inviteToConfirm(match.id, tape.listing.id, tape.desk.id)).error ?? "", /once the listing is live/);
    assert.match((await confirm()).error ?? "", /hasn't sent/);
    await prisma.listing.update({ where: { id: tape.listing.id }, data: { status: "APPROVED", approvedAt: new Date() } });
    assert.match((await inviteToConfirm(match.id, "someone-else", tape.desk.id)).error ?? "", /gone/);

    // An OFAC hold on the buyer stops the invite, in the desk's words only.
    const hold = await prisma.ofacCheck.create({ data: { name: tape.buyer.name, result: "REVIEW", status: "OPEN", userId: tape.buyer.id } });
    assert.equal((await inviteToConfirm(match.id, tape.listing.id, tape.desk.id)).error, OFAC_HOLD_MESSAGE);
    await prisma.ofacCheck.delete({ where: { id: hold.id } });

    assert.equal((await inviteToConfirm(match.id, tape.listing.id, tape.desk.id)).error, null);
    assert.match((await inviteToConfirm(match.id, tape.listing.id, tape.desk.id)).error ?? "", /Sent to the buyer/);
    assert.equal(await mail(tape.buyer.email, "Confirm a standing bid"), 1);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: tape.listing.id, action: "STANDING_INVITE" } }), 1);

    // The same gates as the bid form, each refusing without a bid or an answer.
    const unverified = await confirm();
    assert.equal(unverified.error, "The desk has to approve your buyer file before you can offer.");
    assert.equal(unverified.error !== null && unverified.verification, true);
    await prisma.buyerProfile.update({ where: { userId: tape.buyer.id }, data: { status: "APPROVED" } });
    assert.match((await confirm({ price: price + 5000 })).error ?? "", /standing price changed/);
    assert.match((await confirm({ goodUntil: "next week" })).error ?? "", /as a date/);
    if (settings.earlyAccessHours > 0) {
      // A free account can't bid during early access, as on the listing page.
      await prisma.user.update({ where: { id: tape.buyer.id }, data: { subscriptionTier: "FREE" } });
      assert.match((await confirmStanding({ matchId: match.id, user: { ...tape.buyer, subscriptionTier: "FREE" }, price, goodUntil: "" })).error ?? "", /membership/);
      await prisma.user.update({ where: { id: tape.buyer.id }, data: { subscriptionTier: "PRO" } });
    }
    const traded = tape.listing.notes[1].id;
    await prisma.note.update({ where: { id: traded }, data: { tradeStatus: "IN_CONTRACT" } });
    assert.match((await confirm()).error ?? "", /can't be bid whole/);
    await prisma.note.update({ where: { id: traded }, data: { tradeStatus: "AVAILABLE" } });
    await prisma.listing.update({ where: { id: tape.listing.id }, data: { status: "UNDER_REVIEW" } });
    assert.match((await confirm()).error ?? "", /not taking new inquiries/);
    await prisma.listing.update({ where: { id: tape.listing.id }, data: { status: "APPROVED" } });
    assert.equal(await prisma.inquiry.count({ where: { listingId: tape.listing.id } }), 0);
    assert.equal((await matchOf(tape)).answeredAt, null);

    // A double click: both pass the checks, one claim lands, one bid is written.
    const goodUntil = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const results = await Promise.all([confirm({ goodUntil }), confirm({ goodUntil })]);
    const placed = results.filter((result) => result.error === null);
    assert.equal(placed.length, 1);
    assert.match(results.find((result) => result.error !== null)?.error ?? "", /answered this invitation/);
    const bids = await prisma.inquiry.findMany({ where: { listingId: tape.listing.id, buyerId: tape.buyer.id } });
    assert.equal(bids.length, 1);
    assert.equal(bids[0].type, "OFFER");
    assert.equal(bids[0].amount, 112000);
    assert.equal(bids[0].status, "OPEN");
    assert.equal(bids[0].noteId, null);
    assert.equal(bids[0].expiresAt?.toISOString(), `${goodUntil}T23:59:00.000Z`);
    assert.equal(await prisma.offerMessage.count({ where: { inquiryId: bids[0].id, kind: "OFFER", amount: 112000 } }), 1);
    const answered = await matchOf(tape);
    assert.equal(answered.inquiryId, bids[0].id);
    assert.ok(answered.answeredAt);
    assert.equal(await mail(tape.seller.email, `Offer of $112,000 · ${tape.listing.title}`), 1);
    assert.equal(await mail(tape.desk.email, `Offer of $112,000 · ${tape.listing.title}`), 1);
    assert.match((await confirm()).error ?? "", /already answered/);
    assert.match((await passStanding(match.id, tape.buyer.id)).error ?? "", /already answered/);
    const sheet = await standingSheet(tape.listing);
    assert.equal(sheet.find((item) => item.matchId === match.id)?.inquiryId, bids[0].id);

    // Best and final is one bid per buyer, so a second box's invite can't add another.
    await prisma.listing.update({ where: { id: tape.listing.id }, data: { bidMode: "BEST_AND_FINAL", bidDeadline: new Date(Date.now() + 5 * DAY) } });
    const second = await prisma.buyBox.create({ data: { userId: tape.buyer.id, name: `Second ${tape.tag}`, states: "ZZ", standingBids: true, bidBasis: "UPB", bidPercent: 65 } });
    await rescoreBox(second.id, { quiet: true });
    const other = await matchOf(tape, second.id);
    assert.equal((await inviteToConfirm(other.id, tape.listing.id, tape.desk.id)).error, null);
    const final = await confirmStanding({ matchId: other.id, user: tape.buyer, price: other.indicativePrice ?? 0, goodUntil: "" });
    assert.equal(final.error, "Best and final allows one bid on this listing.");
    // The bid is decided after the deadline, so a good-until before it is refused too.
    const early = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
    assert.match((await confirmStanding({ matchId: other.id, user: tape.buyer, price: other.indicativePrice ?? 0, goodUntil: early })).error ?? "", /on or after it/);
    assert.equal(await prisma.inquiry.count({ where: { listingId: tape.listing.id } }), 1);
    // Someone else's invitation is refused.
    assert.match((await confirmStanding({ matchId: other.id, user: tape.desk, price: other.indicativePrice ?? 0, goodUntil: "" })).error ?? "", /isn't yours/);
  } finally {
    await cleanTape(tape);
  }
});

test("a pass answers the invitation with no bid, once", async () => {
  const tape = await makeTape({ status: "APPROVED" });
  try {
    await rescoreListing(tape.listing.id, false);
    const match = await matchOf(tape);
    // Only the buyer's own invitation, once the desk has sent it, can be passed.
    assert.equal((await openInvitations(tape.buyer.id)).length, 0);
    assert.match((await passStanding(match.id, tape.buyer.id)).error ?? "", /hasn't sent/);
    assert.equal((await inviteToConfirm(match.id, tape.listing.id, tape.desk.id)).error, null);
    assert.deepEqual((await openInvitations(tape.buyer.id)).map((row) => row.id), [match.id]);
    assert.match((await passStanding(match.id, tape.desk.id)).error ?? "", /isn't yours/);
    assert.equal((await passStanding(match.id, tape.buyer.id)).error, null);
    const passed = await matchOf(tape);
    assert.ok(passed.answeredAt);
    assert.equal((await openInvitations(tape.buyer.id)).length, 0);
    assert.equal(passed.inquiryId, null);
    assert.match((await passStanding(match.id, tape.buyer.id)).error ?? "", /already answered/);
    assert.match((await confirmStanding({ matchId: match.id, user: tape.buyer, price: match.indicativePrice ?? 0, goodUntil: "" })).error ?? "", /already answered/);
    assert.equal(await prisma.inquiry.count({ where: { listingId: tape.listing.id } }), 0);
    const row = (await standingSheet(tape.listing)).find((item) => item.matchId === match.id);
    assert.ok(row?.answeredAt);
    assert.equal(row?.canInvite, false);
  } finally {
    await cleanTape(tape);
  }
});

test("a yield rule holds its target on the all-in, so the premium lowers the bid", () => {
  const input = { upb: 100000, annualRate: 7, monthlyPi: 775.3, termMonths: 240 };
  const bare = yieldPrice(input, 12) ?? 0;
  const allIn = yieldPrice(input, 12, 250) ?? 0;
  assert.ok(allIn > 0 && allIn < bare);
  // Bid plus a 2.5% premium costs about what the bare bid did.
  assert.ok(Math.abs(allIn * 1.025 - bare) < 5);
});
