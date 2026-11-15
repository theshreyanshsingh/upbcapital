import assert from "node:assert/strict";
import test from "node:test";
import { openClosing } from "../lib/closing-service";
import { cellFacts, compCells, compsFor, marketView, monthText, MIN_RECENT_TRADES, RECENT_MONTHS, type ClosedTrade } from "../lib/comps";
import { literal } from "../lib/db-filters";
import { feesAtApproval } from "../lib/desk-fees";
import {
  bidderPipeline,
  engagementOf,
  nextStep,
  sortPipeline,
  stageOf,
  type BidderEvents,
  type PipelineFacts,
  type PipelineListing,
} from "../lib/engagement";
import {
  buyerCut,
  chargeFees,
  checkSchedule,
  cutText,
  feeTerms,
  premiumCutOf,
  readSchedule,
  scheduleFromForm,
  volumeTierFor,
  type FeeSchedule,
  type FeeTerms,
} from "../lib/fee-schedule";
import { invoiceDescription } from "../lib/invoices";
import { kickOutLoan } from "../lib/kickouts";
import { prisma } from "../lib/prisma";
import { economicsRows, statementLines } from "../lib/settlement";
import { closingPremiumCut, premiumCutAtAward, trailingVolumeCents } from "../lib/volume-tiers";

const DAY = 24 * 60 * 60 * 1000;
const tagOf = () => `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Engagement, from synthetic events.

const NOW = new Date("2026-11-15T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const none = (): BidderEvents => ({ ndaSignedAt: null, visits: [], files: [], questions: [], savedAt: null, bids: [] });

test("engagement is observed and recent activity counts more than old", () => {
  // A bid, a question or a file in the last 7 days is active on its own.
  assert.equal(engagementOf({ ...none(), bids: [ago(2)] }, NOW).level, "Active");
  assert.equal(engagementOf({ ...none(), questions: [ago(6)] }, NOW).level, "Active");
  const file = engagementOf({ ...none(), ndaSignedAt: ago(9), files: [{ name: "pay-history.pdf", at: ago(1) }] }, NOW);
  assert.equal(file.level, "Active");
  assert.equal(file.why, "Opened a file on Nov 14, 2026");
  // The same file three weeks ago only reads as looking, and two months ago as quiet.
  assert.equal(engagementOf({ ...none(), files: [{ name: "pay-history.pdf", at: ago(20) }] }, NOW).level, "Looking");
  const old = engagementOf({ ...none(), files: [{ name: "pay-history.pdf", at: ago(60) }] }, NOW);
  assert.equal(old.level, "Quiet");
  assert.match(old.why, /^Nothing in the last 30 days; last opened a file on Sep 16, 2026/);
  // Opening the listing is light on its own, unless the bidder comes back on three different days in a week.
  assert.equal(engagementOf({ ...none(), visits: [ago(1), ago(2)] }, NOW).level, "Looking");
  const back = engagementOf({ ...none(), visits: [ago(1), ago(2), ago(4)] }, NOW);
  assert.equal(back.level, "Active");
  assert.equal(back.why, "Opened the listing on 3 days in the last 7");
  // Saving it or signing the NDA in the month is looking.
  assert.equal(engagementOf({ ...none(), savedAt: ago(12) }, NOW).level, "Looking");
  assert.equal(engagementOf({ ...none(), ndaSignedAt: ago(29) }, NOW).level, "Looking");
  assert.equal(engagementOf({ ...none(), ndaSignedAt: ago(31) }, NOW).level, "Quiet");
  // Nothing at all.
  const blank = engagementOf(none(), NOW);
  assert.deepEqual([blank.level, blank.why, blank.last, blank.facts], ["Quiet", "Nothing on this listing yet", null, ["No NDA"]]);
});

test("the facts behind a level count what was logged, distinct files once each, with the latest dates", () => {
  const read = engagementOf(
    {
      ndaSignedAt: ago(10),
      visits: [ago(10), ago(8), ago(3)],
      files: [{ name: "note.pdf", at: ago(9) }, { name: "note.pdf", at: ago(4) }, { name: "bpo.pdf", at: ago(5) }],
      questions: [ago(7)],
      savedAt: ago(10),
      bids: [],
    },
    NOW,
  );
  assert.deepEqual(read.facts, [
    "NDA signed Nov 5, 2026",
    "3 visits, the last Nov 12, 2026",
    "2 files opened, the last Nov 11, 2026",
    "1 question",
    "Watching since Nov 5, 2026",
  ]);
  assert.deepEqual(read.last, { what: "Opened the listing", at: ago(3) });
  // Nothing in the future counts, so a clock skew can't make a bidder look active.
  assert.equal(engagementOf({ ...none(), bids: [new Date(NOW.getTime() + DAY)] }, NOW).level, "Quiet");
});

// ---------------------------------------------------------------------------------------------------------------
// Stages and next steps.

const facts = (over: Partial<PipelineFacts> = {}, events: Partial<BidderEvents> = {}): PipelineFacts => ({
  events: { ...none(), ...events },
  matched: true,
  sendable: true,
  optedOut: false,
  sentAt: null,
  invitedAt: null,
  inviteOpenedAt: null,
  room: null,
  openQuestions: 0,
  liveBid: null,
  awarded: null,
  ...over,
});

const live: PipelineListing = { id: "L1", status: "APPROVED", bidMode: "SEALED", bidDeadline: new Date(NOW.getTime() + 3 * DAY), eventId: null, awardedElsewhere: false };

test("each bidder's stage is the furthest the facts show, from matched to awarded", () => {
  assert.equal(stageOf(facts()), "MATCHED");
  assert.equal(stageOf(facts({ sentAt: ago(3) })), "SENT");
  assert.equal(stageOf(facts({ invitedAt: ago(3), matched: false })), "SENT");
  assert.equal(stageOf(facts({ invitedAt: ago(3), inviteOpenedAt: ago(2) })), "VIEWED");
  assert.equal(stageOf(facts({}, { savedAt: ago(1) })), "VIEWED");
  assert.equal(stageOf(facts({ room: "PENDING" }, { ndaSignedAt: ago(1) })), "NDA");
  assert.equal(stageOf(facts({ room: "OPEN" }, { ndaSignedAt: ago(1) })), "ROOM");
  assert.equal(stageOf(facts({ room: "OPEN" }, { ndaSignedAt: ago(1), questions: [ago(1)] })), "QUESTIONS");
  assert.equal(stageOf(facts({ room: "OPEN" }, { ndaSignedAt: ago(1), bids: [ago(1)] })), "BID");
  assert.equal(stageOf(facts({ awarded: { inquiryId: "i", closingId: "c" } }, { bids: [ago(1)] })), "AWARDED");
});

test("the next step comes from rules, and says why when there is none", () => {
  const at = (f: PipelineFacts, listing = live) => nextStep(f, listing, NOW);
  assert.deepEqual(at(facts()), { key: "SEND", text: "Send the listing", href: "/admin/listings/L1#send-heading" });
  assert.deepEqual(at(facts(), { ...live, eventId: "E1" }), { key: "LETTER", text: "Send the process letter", href: "/admin/events/E1" });
  assert.equal(at(facts({ optedOut: true, sendable: false })).text, "None: they turned off desk picks");
  assert.equal(at(facts({ sendable: false })).text, "None: their account isn't approved");
  assert.equal(at(facts({ sentAt: ago(4) })).key, "FOLLOW_UP");
  assert.equal(at(facts({}, { visits: [ago(1)] })).text, "Point them to the NDA");
  assert.deepEqual(at(facts({ room: "PENDING" }, { ndaSignedAt: ago(1) })), { key: "ROOM", text: "Decide their room access", href: "/admin/listings/L1#room-access" });
  assert.equal(at(facts({ room: "DECLINED" }, { ndaSignedAt: ago(1) })).text, "None: their room access was declined");
  // In the room with no bid: remind before a deadline, or ask on open offers.
  assert.equal(at(facts({ room: "OPEN" }, { ndaSignedAt: ago(1) })).text, "Remind before the deadline");
  assert.equal(at(facts({ room: "OPEN" }, { ndaSignedAt: ago(1) }), { ...live, bidMode: "NONE", bidDeadline: null }).text, "Ask whether they will bid");
  // A question waiting comes before anything else the desk does on a live listing.
  assert.deepEqual(at(facts({ room: "OPEN", openQuestions: 1, liveBid: { inquiryId: "B1" } }, { questions: [ago(1)], bids: [ago(1)] })), { key: "ANSWER", text: "Answer their question", href: "/admin/listings/L1#questions" });
  assert.equal(at(facts({ room: "OPEN", openQuestions: 2 }, { questions: [ago(1), ago(2)] })).text, "Answer their 2 questions");
  // A sealed bid waits for the deadline; after it, the desk decides on the offer book.
  assert.equal(at(facts({ room: "OPEN", liveBid: { inquiryId: "B1" } }, { bids: [ago(1)] })).text, "None until the deadline on Nov 18, 2026");
  assert.deepEqual(at(facts({ room: "OPEN", liveBid: { inquiryId: "B1" } }, { bids: [ago(1)] }), { ...live, bidDeadline: ago(1) }), { key: "DECIDE", text: "Decide on their bid", href: "/admin/offers#offer-B1" });
  assert.equal(at(facts({ room: "OPEN" }, { ndaSignedAt: ago(3) }), { ...live, bidDeadline: ago(1) }).text, "None: bidding has closed");
  // The award, and everyone else once it went to someone.
  assert.deepEqual(at(facts({ awarded: { inquiryId: "B1", closingId: "C1" } }, { bids: [ago(1)] }), { ...live, status: "PENDING", awardedElsewhere: true }), { key: "CLOSING", text: "Run the closing", href: "/closings/C1" });
  assert.equal(at(facts({ room: "OPEN" }, { bids: [ago(1)] }), { ...live, status: "PENDING", awardedElsewhere: true }).text, "None: the sale went to another bidder");
  assert.equal(at(facts(), { ...live, status: "UNDER_REVIEW" }).text, "None until the listing is live");
});

test("the pipeline sorts by stage, then the most recent activity", () => {
  const row = (name: string, stage: "MATCHED" | "SENT" | "BID" | "ROOM", days: number | null) => ({ name, stage, last: days == null ? null : { what: "x", at: ago(days) } });
  const sorted = sortPipeline([row("matched", "MATCHED", null), row("room old", "ROOM", 9), row("bid", "BID", 5), row("room new", "ROOM", 1), row("sent", "SENT", 2)]);
  assert.deepEqual(sorted.map((item) => item.name), ["bid", "room new", "room old", "sent", "matched"]);
});

// ---------------------------------------------------------------------------------------------------------------
// The buyer cuts: pure rules.

// $0–50,000 at 3% and 2%, then 2% and 1.5%; a $750 minimum premium; volume cuts at $100,000 and $500,000 of 12-month
// purchases; and 0.10% off on a forward-flow tranche.
const SCHEDULE: FeeSchedule = {
  tiers: [
    { upTo: 50000, premiumBps: 300, commissionBps: 200 },
    { upTo: null, premiumBps: 200, commissionBps: 150 },
  ],
  minPremiumCents: 75000,
  minCommissionCents: 0,
  volumeTiers: [
    { minCents: 10_000_000, premiumOffBps: 25 },
    { minCents: 50_000_000, premiumOffBps: 50 },
  ],
  flowPremiumOffBps: 10,
};
const TERMS: FeeTerms = { schedule: SCHEDULE, premiumBps: 250, commissionBps: 300 };

test("a volume tier is the highest a 12-month total reaches, and the cut comes off the premium only", () => {
  assert.equal(volumeTierFor(SCHEDULE, 9_999_999), null);
  assert.equal(volumeTierFor(SCHEDULE, 10_000_000)?.premiumOffBps, 25);
  assert.equal(volumeTierFor(SCHEDULE, 49_999_999)?.premiumOffBps, 25);
  assert.equal(volumeTierFor(SCHEDULE, 60_000_000)?.premiumOffBps, 50);
  assert.equal(volumeTierFor({ ...SCHEDULE, volumeTiers: undefined }, 60_000_000), null);
  const plain = chargeFees(TERMS, 100000);
  const cut = chargeFees({ ...TERMS, premiumOffBps: 50 }, 100000);
  assert.deepEqual([plain.premiumCents, cut.premiumCents, cut.premiumBps, cut.premiumOffBps], [200000, 150000, 150, 50]);
  assert.equal(cut.commissionCents, plain.commissionCents);
  assert.equal(cut.buyerTotalCents, 10000000 + 150000);
  // The buyer's cut never reaches the seller's side: when the seller pays both fees, nothing changes.
  const sellerPays = { ...TERMS, payer: "SELLER" as const };
  assert.deepEqual(chargeFees({ ...sellerPays, premiumOffBps: 50 }, 100000), chargeFees(sellerPays, 100000));
  // When the buyer pays both, the cut comes off the premium part of the two.
  assert.equal(chargeFees({ ...TERMS, payer: "BUYER", premiumOffBps: 50 }, 100000).premiumCents, 300000);
  // A desk purchase pays no premium, cut or not.
  assert.equal(chargeFees({ ...TERMS, premiumOffBps: 50 }, 100000, { deskPurchase: true }).premiumCents, 0);
});

test("the minimum premium still holds under a cut", () => {
  // $30,000 at 3% is $900; 0.75% off would be $675, so the $750 minimum sets it.
  const fees = chargeFees({ ...TERMS, premiumOffBps: 75 }, 30000);
  assert.equal(fees.premiumCents, 75000);
  assert.equal(fees.premiumFloor, true);
  // A cut larger than the rate leaves the minimum, never a negative fee.
  assert.equal(chargeFees({ ...TERMS, premiumOffBps: 1000 }, 30000).premiumCents, 75000);
  // On a sale big enough the cut shows in full.
  assert.equal(chargeFees({ ...TERMS, premiumOffBps: 75 }, 60000).premiumCents, Math.round(6000000 * 0.0125));
});

test("a forward-flow tranche takes its own cut, which adds to a volume cut; a group's bid takes only the flow cut", () => {
  assert.deepEqual(buyerCut(TERMS, { volumeCents: 0, flowTranche: true }), { volumeBps: 0, flowBps: 10, offBps: 10, tier: null, volumeCents: 0 });
  assert.equal(buyerCut(TERMS, { volumeCents: 60_000_000, flowTranche: true })?.offBps, 60);
  assert.equal(buyerCut(TERMS, { volumeCents: null, flowTranche: true })?.offBps, 10);
  assert.equal(buyerCut(TERMS, { volumeCents: 60_000_000, flowTranche: false })?.offBps, 50);
  assert.equal(buyerCut(TERMS, { volumeCents: 0, flowTranche: false }), null);
  // No schedule, or the seller paying both, means no cut.
  assert.equal(buyerCut({ schedule: null, premiumBps: 250, commissionBps: 300 }, { volumeCents: 60_000_000, flowTranche: true }), null);
  assert.equal(buyerCut({ ...TERMS, payer: "SELLER" }, { volumeCents: 60_000_000, flowTranche: true }), null);
});

test("a closing's cut reads back from its premium, and the statement and invoice show it", () => {
  assert.equal(premiumCutOf(TERMS, { salePrice: 100000, buyerPremiumCents: 200000 }), null);
  const cut = premiumCutOf(TERMS, { salePrice: 100000, buyerPremiumCents: 140000 }, true);
  assert.deepEqual(cut, { beforeCents: 200000, cutCents: 60000, offBps: 60, flowCents: 10000, volumeCents: 50000 });
  assert.equal(cutText(cut!), "$2,000.00 at the listing's rate, less a volume cut of $500.00 and a forward-flow cut of $100.00, fixed at award");
  // A cut the minimum swallowed whole isn't a cut at all.
  assert.equal(premiumCutOf(TERMS, { salePrice: 25000, buyerPremiumCents: 75000 }), null);
  assert.equal(premiumCutOf(TERMS, { salePrice: 100000, buyerPremiumCents: 150000, deskBidId: "d" }), null);
  // A schedule with no cuts reads none, so an old closing never shows one.
  assert.equal(premiumCutOf({ ...TERMS, schedule: { tiers: SCHEDULE.tiers, minPremiumCents: 75000, minCommissionCents: 0 } }, { salePrice: 100000, buyerPremiumCents: 150000 }), null);

  const closing = {
    id: "c1", salePrice: 100000, buyerPremiumCents: 175000, sellerCommissionCents: 150000, buyerTotalCents: 10175000, netToSellerCents: 9850000,
    openedAt: NOW, closedAt: null, status: "OPEN", fundsReceivedCents: null, fundsReceivedAt: null, fundsReference: null,
    proceedsSentCents: null, proceedsSentAt: null, proceedsReference: null,
    premiumCut: premiumCutOf(TERMS, { salePrice: 100000, buyerPremiumCents: 175000 }),
  };
  const buyer = statementLines(closing, "buyer")[0].lines.find((line) => line.label === "Buyer premium");
  assert.equal(buyer?.cents, 175000);
  assert.equal(buyer?.detail, "$2,000.00 at the listing's rate, less a volume cut of $250.00, fixed at award");
  const desk = statementLines(closing, "desk").find((section) => section.heading === "Desk")?.lines[0];
  assert.match(desk?.detail ?? "", /volume cut of \$250\.00/);
  // The seller's statement carries no premium line at all.
  assert.equal(statementLines(closing, "seller")[0].lines.some((line) => line.label === "Buyer premium"), false);
  // The closing page names the cut on the premium row.
  assert.deepEqual(economicsRows(closing, "buyer")[1], { label: "Buyer premium, after a $250.00 cut fixed at award", cents: 175000 });
  assert.equal(economicsRows({ ...closing, premiumCut: null }, "buyer")[1].label, "Buyer premium");
  assert.equal(invoiceDescription("PREMIUM", "SPLIT", "Pool A", closing.premiumCut), "Buyer premium on Pool A, paid by the buyer. $2,000.00 at the listing's rate, less a volume cut of $250.00, fixed at award");
  assert.equal(invoiceDescription("PREMIUM", "SPLIT", "Pool A", closing.premiumCut, true), "Buyer premium on Pool A, paid by the buyer. Your share, after the premium cut fixed at award");
  assert.equal(invoiceDescription("COMMISSION", "SPLIT", "Pool A", closing.premiumCut), "Seller commission on Pool A, paid by the seller");
  assert.equal(invoiceDescription("PREMIUM", "SPLIT", "Pool A"), "Buyer premium on Pool A, paid by the buyer");
});

test("the schedule keeps volume tiers and the flow cut only when set, and refuses ones that don't go up", () => {
  const plain = { tiers: SCHEDULE.tiers, minPremiumCents: 75000, minCommissionCents: 0 };
  assert.deepEqual(checkSchedule(plain).schedule, plain);
  assert.deepEqual(readSchedule(SCHEDULE), SCHEDULE);
  assert.deepEqual(checkSchedule({ ...plain, volumeTiers: [], flowPremiumOffBps: 0 }).schedule, plain);
  assert.match(checkSchedule({ ...plain, volumeTiers: [{ minCents: 50_000_000, premiumOffBps: 25 }, { minCents: 10_000_000, premiumOffBps: 50 }] }).error ?? "", /go up in volume/);
  assert.match(checkSchedule({ ...plain, volumeTiers: [{ minCents: 10_000_000, premiumOffBps: 50 }, { minCents: 50_000_000, premiumOffBps: 25 }] }).error ?? "", /can't cut the premium by less/);
  assert.match(checkSchedule({ ...plain, volumeTiers: [{ minCents: 0, premiumOffBps: 25 }] }).error ?? "", /above zero/);
  assert.match(checkSchedule({ ...plain, volumeTiers: [{ minCents: 10_000_000, premiumOffBps: 0 }] }).error ?? "", /more than 0%/);
  assert.match(checkSchedule({ ...plain, flowPremiumOffBps: 1001 }).error ?? "", /forward-flow cut/);
  // A bad stored cut reads as no schedule, so the flat rates apply rather than a half-read one.
  assert.equal(readSchedule({ ...plain, flowPremiumOffBps: -5 }), null);

  const form = scheduleFromForm({
    upTo: ["50,000", ""],
    premium: ["3", "2"],
    commission: ["2", "1.5"],
    minPremium: "750",
    minCommission: "",
    volumeMin: ["100k", "", "500,000"],
    volumeOff: ["0.25", "", "0.5"],
    flowOff: "0.1",
  });
  assert.equal(form.error, null);
  assert.deepEqual(form.schedule, SCHEDULE);
  assert.match(scheduleFromForm({ upTo: [""], premium: ["2"], commission: ["1"], minPremium: "", minCommission: "", volumeMin: ["100000"], volumeOff: [""] }).error ?? "", /needs a 12-month purchase total and a cut/);
  assert.match(scheduleFromForm({ upTo: [""], premium: ["2"], commission: ["1"], minPremium: "", minCommission: "", flowOff: "0.125" }).error ?? "", /forward-flow cut as a percent/);
});

// ---------------------------------------------------------------------------------------------------------------
// The buyer cuts through the database: the 12-month total, the award, and what stays fixed after it.

async function makePeople(tag: string) {
  const person = (prefix: string, role: "BUYER" | "ADMIN" | "INSTITUTIONAL_SELLER", extra: object = {}) =>
    prisma.user.create({ data: { email: `pipeline-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra } });
  const firm = await person("firm", "BUYER");
  return {
    desk: await person("desk", "ADMIN"),
    firm,
    seat: await person("seat", "BUYER", { principalId: firm.id, seatRole: "TRADE", seatAddedAt: new Date() }),
    other: await person("other", "BUYER"),
    seller: await person("seller", "INSTITUTIONAL_SELLER"),
  };
}

function loan(ask: number, upb: number) {
  return {
    streetAddress: "1 Test St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
    lienPosition: "FIRST", upb, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: ask, estimatedValue: upb * 1.4,
  };
}

async function makeListing(sellerId: string, title: string, extra: object = {}) {
  return prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      title,
      ...feesAtApproval({ buyerPremiumBps: 250, sellerCommissionBps: 300, feeSchedule: SCHEDULE }),
      ...extra,
      notes: { create: [loan(40000, 60000), loan(60000, 90000)] as never },
    },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
}

// A purchase that closed: an accepted bid and its complete closing, closed `daysAgo` before now.
async function closedPurchase(listingId: string, buyerId: string, price: number, daysAgo: number, status: "COMPLETE" | "OPEN" = "COMPLETE") {
  const bid = await prisma.inquiry.create({ data: { listingId, buyerId, type: "OFFER", amount: price, status: "ACCEPTED" } });
  const closedAt = new Date(Date.now() - daysAgo * DAY);
  return prisma.closing.create({
    data: {
      listingId, inquiryId: bid.id, salePrice: price, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: Math.round(price * 100), netToSellerCents: Math.round(price * 100),
      status, ...(status === "COMPLETE" ? { closedAt } : {}), openedAt: new Date(closedAt.getTime() - 20 * DAY),
    },
  });
}

async function cleanUp(tag: string, listingIds: string[], userIds: string[]) {
  const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ subject: { contains: literal(tag) } }, { toEmail: { contains: literal(tag) } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test("the 12-month total counts the firm, its seats and its funded group shares, and a purchase drops out after 12 months", async () => {
  const tag = tagOf();
  const people = await makePeople(tag);
  const listingIds: string[] = [];
  try {
    const history = await makeListing(people.seller.id, `History ${tag}`, { status: "SOLD" });
    listingIds.push(history.id);
    await closedPurchase(history.id, people.firm.id, 60000, 30);
    // A bid a seat placed is the firm's.
    await closedPurchase(history.id, people.seat.id, 30000, 100);
    // Older than 12 months, and not yet closed: neither counts.
    await closedPurchase(history.id, people.firm.id, 500000, 400);
    await closedPurchase(history.id, people.firm.id, 400000, 5, "OPEN");
    // A group closing another buyer opened: the seat's funded share counts for the firm, the rest for the other buyer.
    const group = await closedPurchase(history.id, people.other.id, 100000, 50);
    await prisma.closingFunder.create({ data: { closingId: group.id, userId: people.seat.id, amount: 20000, premiumCents: 0, percent: 20, status: "FUNDED" } });
    await prisma.closingFunder.create({ data: { closingId: group.id, userId: people.other.id, amount: 80000, premiumCents: 0, percent: 80, status: "FUNDED" } });

    assert.equal(await trailingVolumeCents(people.firm.id), 11_000_000);
    // Asked through the seat, it is the same firm.
    assert.equal(await trailingVolumeCents(people.seat.id), 11_000_000);
    assert.equal(volumeTierFor(SCHEDULE, await trailingVolumeCents(people.firm.id))?.premiumOffBps, 25);
    // The other buyer's own group closing counts only its own share.
    assert.equal(await trailingVolumeCents(people.other.id), 8_000_000);
    // 300 days on, the seat's purchase from 100 days ago is past 12 months: $80,000 is under the first tier.
    const later = new Date(Date.now() + 300 * DAY);
    assert.equal(await trailingVolumeCents(people.firm.id, later), 8_000_000);
    assert.equal(volumeTierFor(SCHEDULE, await trailingVolumeCents(people.firm.id, later)), null);
  } finally {
    await cleanUp(tag, listingIds, Object.values(people).map((person) => person.id));
  }
});

test("the cut is fixed when the closing opens, never moves after, and survives a kick-out", async () => {
  const tag = tagOf();
  const people = await makePeople(tag);
  const listingIds: string[] = [];
  try {
    const history = await makeListing(people.seller.id, `History ${tag}`, { status: "SOLD" });
    const pool = await makeListing(people.seller.id, `Pool ${tag}`);
    listingIds.push(history.id, pool.id);
    await closedPurchase(history.id, people.firm.id, 110000, 30);

    // $110,000 in 12 months reaches the first tier: 2% less 0.25% on $100,000 is $1,750.
    const bid = await prisma.inquiry.create({ data: { listingId: pool.id, buyerId: people.firm.id, type: "OFFER", amount: 100000, status: "ACCEPTED" } });
    const closing = await openClosing({ listingId: pool.id, inquiryId: bid.id, noteId: null, salePrice: 100000, title: pool.title });
    assert.equal(closing.buyerPremiumCents, 175000);
    assert.equal(closing.buyerTotalCents, 10000000 + 175000);
    assert.equal(closing.sellerCommissionCents, 150000);
    const logged = await prisma.auditEvent.findFirst({ where: { entityId: closing.id, action: "PREMIUM_CUT" } });
    assert.match(logged?.detail ?? "", /0\.25% off on \$110,000 closed in 12 months/);
    assert.deepEqual(await closingPremiumCut(closing), { beforeCents: 200000, cutCents: 25000, offBps: 25, flowCents: 0, volumeCents: 25000 });

    // A big purchase after the award lifts the firm to the next tier, but the open closing keeps what it opened with.
    await closedPurchase(history.id, people.firm.id, 600000, 1);
    assert.equal(volumeTierFor(SCHEDULE, await trailingVolumeCents(people.firm.id))?.premiumOffBps, 50);
    const again = await openClosing({ listingId: pool.id, inquiryId: bid.id, noteId: null, salePrice: 100000, title: pool.title });
    assert.equal(again.id, closing.id);
    const stored = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
    assert.deepEqual([stored.buyerPremiumCents, stored.buyerTotalCents], [175000, 10175000]);

    // A kick-out takes 60% of the asks out: $40,000 falls in the first tier, 3% less the same 0.25% is $1,100.
    const kicked = await kickOutLoan({ closingId: closing.id, noteId: pool.notes[1].id, reason: "Title defect on the assignment.", actorId: people.desk.id });
    assert.equal(kicked.error, null);
    const after = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
    assert.equal(Number(after.salePrice), 40000);
    assert.equal(after.buyerPremiumCents, 110000);
    assert.equal(after.sellerCommissionCents, 80000);
  } finally {
    await cleanUp(tag, listingIds, Object.values(people).map((person) => person.id));
  }
});

test("a forward-flow tranche's cut applies at award, a group's bid takes no volume cut, and a buyer with no history pays the full premium", async () => {
  const tag = tagOf();
  const people = await makePeople(tag);
  const listingIds: string[] = [];
  try {
    const history = await makeListing(people.seller.id, `History ${tag}`, { status: "SOLD" });
    const tranche = await makeListing(people.seller.id, `Tranche ${tag}`, { flowProgramId: `flow-${tag}` });
    const plain = await makeListing(people.seller.id, `Plain ${tag}`);
    listingIds.push(history.id, tranche.id, plain.id);
    await closedPurchase(history.id, people.firm.id, 600000, 10);

    // No history: the flow cut alone, 2% less 0.10% on $100,000.
    const otherBid = await prisma.inquiry.create({ data: { listingId: tranche.id, buyerId: people.other.id, type: "OFFER", amount: 100000, status: "ACCEPTED", noteId: tranche.notes[0].id } });
    const flowClosing = await openClosing({ listingId: tranche.id, inquiryId: otherBid.id, noteId: tranche.notes[0].id, salePrice: 100000, title: tranche.title });
    assert.equal(flowClosing.buyerPremiumCents, 190000);
    assert.deepEqual(await closingPremiumCut(flowClosing), { beforeCents: 200000, cutCents: 10000, offBps: 10, flowCents: 10000, volumeCents: 0 });

    // A group's bid on the tranche: the firm opened it, but its volume doesn't set a group's premium.
    const groupBid = await prisma.inquiry.create({ data: { listingId: tranche.id, buyerId: people.firm.id, type: "OFFER", amount: 100000, status: "OPEN" } });
    await prisma.groupBuy.create({ data: { listingId: tranche.id, openedById: people.firm.id, minPosition: 10000, deadline: new Date(Date.now() + DAY), targetAmount: 100000, inquiryId: groupBid.id } });
    const settings = { buyerPremiumBps: 250, sellerCommissionBps: 300 };
    const groupCut = await premiumCutAtAward({ listing: tranche, inquiryId: groupBid.id, settings });
    assert.deepEqual([groupCut?.volumeBps, groupCut?.flowBps, groupCut?.volumeCents], [0, 10, null]);
    // The firm alone on the tranche takes both cuts; on a plain listing only its volume cut.
    const soloBid = await prisma.inquiry.create({ data: { listingId: tranche.id, buyerId: people.firm.id, type: "OFFER", amount: 100000, status: "OPEN" } });
    assert.equal((await premiumCutAtAward({ listing: tranche, inquiryId: soloBid.id, settings }))?.offBps, 60);
    const plainBid = await prisma.inquiry.create({ data: { listingId: plain.id, buyerId: people.firm.id, type: "OFFER", amount: 100000, status: "OPEN" } });
    assert.equal((await premiumCutAtAward({ listing: plain, inquiryId: plainBid.id, settings }))?.offBps, 50);
    // A buyer with no history on a plain listing: no cut, the full 2%.
    const freshBid = await prisma.inquiry.create({ data: { listingId: plain.id, buyerId: people.other.id, type: "OFFER", amount: 100000, status: "ACCEPTED" } });
    assert.equal(await premiumCutAtAward({ listing: plain, inquiryId: freshBid.id, settings }), null);
    const fresh = await openClosing({ listingId: plain.id, inquiryId: freshBid.id, noteId: null, salePrice: 100000, title: plain.title });
    assert.equal(fresh.buyerPremiumCents, 200000);
    assert.equal(await closingPremiumCut(fresh), null);
    // A listing that went live with flat rates has no cuts at all.
    assert.equal(feeTerms({ feeBuyerPremiumBps: 250, feeSellerCommissionBps: 300, feeSchedule: null }, settings).schedule, null);
  } finally {
    await cleanUp(tag, listingIds, Object.values(people).map((person) => person.id));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The pipeline through the database.

test("the pipeline lists every prospective bidder for the sales side, furthest first, and stays closed to other roles", async () => {
  const tag = tagOf();
  const people = await makePeople(tag);
  const listingIds: string[] = [];
  try {
    const listing = await makeListing(people.seller.id, `Sale ${tag}`, { bidMode: "SEALED", bidDeadline: new Date(Date.now() + 3 * DAY) });
    listingIds.push(listing.id);
    // The firm opened it, signed, took a file and bid. The other buyer was only sent it. One address was invited.
    await prisma.listingView.create({ data: { listingId: listing.id, userId: people.firm.id, createdAt: new Date(Date.now() - 2 * DAY) } });
    await prisma.ndaAcknowledgment.create({ data: { listingId: listing.id, userId: people.firm.id, acknowledgedAt: new Date(Date.now() - 2 * DAY) } });
    await prisma.auditEvent.create({ data: { actorId: people.firm.id, action: "DOCUMENT_DOWNLOAD", entityType: "listing", entityId: listing.id, detail: "pay-history.pdf" } });
    await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: people.firm.id, type: "OFFER", amount: 55000, status: "OPEN" } });
    await prisma.listingSend.create({ data: { listingId: listing.id, userId: people.other.id, sentById: people.desk.id, kind: "LISTING", createdAt: new Date(Date.now() - 4 * DAY) } });
    await prisma.listingInvite.create({ data: { listingId: listing.id, email: `nobody-${tag}@example.org`, token: `token-${tag}`, invitedById: people.desk.id } });
    // The seller's own view isn't a bidder's.
    await prisma.listingView.create({ data: { listingId: listing.id, userId: people.seller.id } });

    const sales = { role: "ADMIN", deskRole: "SALES" };
    const pipeline = await bidderPipeline(listing.id, sales);
    assert.ok(pipeline);
    assert.equal(pipeline.walled, false);
    assert.deepEqual(pipeline.rows.map((row) => row.stage), ["BID", "SENT", "SENT"]);
    const [firm, ...rest] = pipeline.rows;
    assert.equal(firm.userId, people.firm.id);
    assert.equal(firm.engagement.level, "Active");
    assert.deepEqual(firm.bid, { amount: 55000, sealed: false });
    assert.match(firm.next.text, /^None until the deadline on /);
    const other = rest.find((row) => row.userId === people.other.id);
    assert.equal(other?.next.key, "FOLLOW_UP");
    assert.deepEqual(other?.last?.what, "Sent the listing");
    const invited = rest.find((row) => row.userId === null);
    assert.equal(invited?.name, `nobody-${tag}@example.org`);
    assert.equal(invited?.next.text, "Follow up: no account yet");
    assert.equal(pipeline.rows.some((row) => row.userId === people.seller.id), false);

    // Compliance and the desk book don't run sales, so they get nothing.
    assert.equal(await bidderPipeline(listing.id, { role: "ADMIN", deskRole: "COMPLIANCE" }), null);
    assert.equal(await bidderPipeline(listing.id, { role: "ADMIN", deskRole: "TRADER" }), null);
    assert.equal(await bidderPipeline(listing.id, { role: "BUYER" }), null);
  } finally {
    await prisma.listingInvite.deleteMany({ where: { email: `nobody-${tag}@example.org` } });
    await cleanUp(tag, listingIds, Object.values(people).map((person) => person.id));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The comps recency rule.

test("a comps cell needs three trades in 24 months and one in the last six, and says its count and latest month", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  const trade = (monthsAgo: number, ratio = 0.7): ClosedTrade => {
    const closedAt = new Date(now);
    closedAt.setMonth(closedAt.getMonth() - monthsAgo);
    return { price: 100000 * ratio, upb: 100000, lienPosition: "FIRST", paymentStatus: "PERFORMING", state: "FL", closedAt };
  };
  assert.deepEqual([RECENT_MONTHS, MIN_RECENT_TRADES], [6, 1]);
  // Three trades, none in six months: hidden and counted as suppressed.
  const stale = [trade(7), trade(9), trade(12)];
  assert.deepEqual(compCells(stale, "state", 3, now), { cells: [], suppressed: 3 });
  assert.equal(compsFor({ state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING" }, stale, 3, now), null);
  assert.equal(marketView(stale, now).national.length, 0);
  // One recent trade opens the cell, which shows its count and latest month.
  const fresh = [...stale, trade(2, 0.8)];
  const cell = compsFor({ state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING" }, fresh, 3, now);
  assert.equal(cell?.count, 4);
  assert.equal(cell?.latestMonth, "2026-09");
  assert.equal(cellFacts(cell!), "4 trades, the latest in September 2026");
  assert.equal(marketView(fresh, now).national[0]?.latestMonth, "2026-09");
  // Trades past 24 months don't count toward the three.
  assert.equal(compCells([trade(2), trade(25), trade(30)], "state", 3, now).cells.length, 0);
  // Read as of an earlier day, as the back-test does, the same stale trades were recent then.
  assert.equal(compCells(stale, "state", 3, new Date("2026-06-15T00:00:00Z")).cells.length, 1);
  assert.equal(monthText("2026-01"), "January 2026");
  assert.equal(monthText(undefined), "");
});
