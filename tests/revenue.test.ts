import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { MIN_AWARDS, backtestGroups, backtestStats, loadBacktest, scoreAward, type BacktestRow } from "../lib/backtest";
import { openClosing } from "../lib/closing-service";
import { literal } from "../lib/db-filters";
import { feesAtApproval, listingFeeBps } from "../lib/desk-fees";
import {
  allInFor,
  chargeFees,
  checkSchedule,
  feeTerms,
  feesFor,
  flatTerms,
  premiumOn,
  rateText,
  readSchedule,
  scheduleFromForm,
  tierFor,
  tierLabel,
  type FeeSchedule,
} from "../lib/fee-schedule";
import { fundsExposure, fundsLimitBlock } from "../lib/inquiry";
import { kickOutLoan } from "../lib/kickouts";
import { feeBreakdown } from "../lib/money";
import { prisma } from "../lib/prisma";
import { clearSettingsCache, getSettings } from "../lib/settings";
import { SAMPLE_TAPE_ROWS, TAPE_HEADERS } from "../lib/tape-fields";
import { easternDay, latestParYield, nextBusinessDay, parseParYields, readTenYear, refreshTenYear, treasuryDecision } from "../lib/treasury";
import {
  EMAIL_LIMIT,
  IP_LIMIT,
  RATE_LIMITED,
  closeValuation,
  inviteFromValuation,
  quoteValuation,
  readTypedLoans,
  readValuationTape,
  requestValuation,
  storedLoans,
  valuationRange,
  type ValuationLoan,
} from "../lib/valuations";

const DAY = 24 * 60 * 60 * 1000;
// Desk notices stay in the log, screening uses the built-in list, and nothing reaches Treasury, whatever the local
// .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY", "TREASURY_FEED_URL"]) process.env[key] = "";
// Any fetch a test didn't stub fails loudly instead of reaching the network.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`A test tried to reach the network: ${String(input)}`);
}) as typeof fetch;

test.after(async () => {
  await prisma.$disconnect();
});

function tagOf() {
  return `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
}

// Paperstac-like tiers with minimums, in dollars.
const SCHEDULE: FeeSchedule = {
  tiers: [
    { upTo: 50000, premiumBps: 370, commissionBps: 185 },
    { upTo: 250000, premiumBps: 200, commissionBps: 150 },
    { upTo: null, premiumBps: 66, commissionBps: 100 },
  ],
  minPremiumCents: 75000,
  minCommissionCents: 50000,
};
const GRADED = { schedule: SCHEDULE, premiumBps: 250, commissionBps: 300 };

// ---------------------------------------------------------------------------------------------------------------
// The schedule, as pure rules.

test("a graded schedule charges the whole price at its tier, lifts each side to its minimum, and never charges past the price", () => {
  // $25,000 is in the first tier: 3.7% premium, and the 1.85% commission of $462.50 comes up to the $500 minimum.
  const small = chargeFees(GRADED, 25000);
  assert.equal(small.premiumCents, 92500);
  assert.equal(small.commissionCents, 50000);
  assert.equal(small.premiumFloor, false);
  assert.equal(small.commissionFloor, true);
  assert.equal(small.buyerTotalCents, 2500000 + 92500);
  assert.equal(small.netToSellerCents, 2500000 - 50000);
  // A tier's upTo is in it; a cent over is the next tier.
  assert.equal(tierFor(SCHEDULE, 50000).premiumBps, 370);
  assert.equal(tierFor(SCHEDULE, 50000.01).premiumBps, 200);
  // Not marginal: $100,000 pays 2% on all of it, not 3.7% on the first $50,000.
  const mid = chargeFees(GRADED, 100000);
  assert.equal(mid.premiumCents, 200000);
  assert.equal(mid.commissionCents, 150000);
  assert.equal(mid.premiumBps, 200);
  const large = chargeFees(GRADED, 500000);
  assert.equal(large.premiumCents, 330000);
  assert.equal(large.commissionCents, 500000);
  // On a $400 sale the minimums would pass the price, so each side stops at the price.
  const tiny = chargeFees(GRADED, 400);
  assert.equal(tiny.premiumCents, 40000);
  assert.equal(tiny.commissionCents, 40000);
  assert.equal(tiny.netToSellerCents, 0);
  assert.equal(tiny.buyerTotalCents, 80000);
  assert.deepEqual([chargeFees(GRADED, 0).premiumCents, chargeFees(GRADED, 0).commissionCents], [0, 0]);
  // The desk buying for its own book pays no premium; the setting decides the commission, minimum and all.
  assert.deepEqual([chargeFees(GRADED, 25000, { deskPurchase: true, chargeDeskFees: true }).premiumCents, chargeFees(GRADED, 25000, { deskPurchase: true, chargeDeskFees: true }).commissionCents], [0, 50000]);
  assert.equal(chargeFees(GRADED, 25000, { deskPurchase: true, chargeDeskFees: false }).commissionCents, 0);
  // Bid forms price the premium the same way.
  assert.equal(premiumOn(GRADED, 25000), 925);
  assert.equal(premiumOn(GRADED, 10000), 750);
  assert.equal(allInFor(GRADED, 10000), 10750);
  assert.equal(premiumOn(GRADED, Number.NaN), 0);
  // Labels for the pages.
  assert.equal(tierLabel(SCHEDULE, 0), "Up to $50,000");
  assert.equal(tierLabel(SCHEDULE, 1), "$50,001 to $250,000");
  assert.equal(tierLabel(SCHEDULE, 2), "Over $250,000");
  assert.equal(rateText(GRADED, "premium"), "0.66% to 3.70% by sale size, at least $750");
  assert.equal(rateText(flatTerms(250, 300), "commission"), "3.00%");
});

test("flat terms charge exactly what the flat rates always did, with no minimum", () => {
  for (const price of [168000, 25000, 400, 99999.99]) {
    const flat = chargeFees(flatTerms(250, 300), price);
    const before = feeBreakdown(price, 250, 300);
    assert.deepEqual(
      { saleCents: flat.saleCents, premiumCents: flat.premiumCents, commissionCents: flat.commissionCents, buyerTotalCents: flat.buyerTotalCents, netToSellerCents: flat.netToSellerCents },
      before,
    );
    assert.equal(flat.graded, false);
  }
  const desk = chargeFees(flatTerms(250, 300), 100000, { deskPurchase: true, chargeDeskFees: true });
  assert.deepEqual([desk.premiumCents, desk.commissionCents], [0, 300000]);
});

test("a schedule is checked: ascending tiers, one open tier at the end, rates from 0 to 10%, and sane minimums", () => {
  assert.equal(checkSchedule(SCHEDULE).error, null);
  assert.match(checkSchedule({ tiers: [] }).error ?? "", /at least one tier/);
  assert.match(checkSchedule({ tiers: [{ upTo: 100, premiumBps: 100, commissionBps: 100 }] }).error ?? "", /blank on the last tier/);
  assert.match(checkSchedule({ tiers: [{ upTo: null, premiumBps: 100, commissionBps: 100 }, { upTo: null, premiumBps: 100, commissionBps: 100 }] }).error ?? "", /Only the last tier is open-ended/);
  assert.match(checkSchedule({ tiers: [{ upTo: 100000, premiumBps: 1, commissionBps: 1 }, { upTo: 50000, premiumBps: 1, commissionBps: 1 }, { upTo: null, premiumBps: 1, commissionBps: 1 }] }).error ?? "", /go up in price/);
  assert.match(checkSchedule({ tiers: [{ upTo: null, premiumBps: 1001, commissionBps: 1 }] }).error ?? "", /between 0% and 10%/);
  assert.match(checkSchedule({ tiers: [{ upTo: null, premiumBps: 12.5, commissionBps: 1 }] }).error ?? "", /between 0% and 10%/);
  assert.match(checkSchedule({ tiers: [{ upTo: null, premiumBps: 100, commissionBps: 100 }], minPremiumCents: -1 }).error ?? "", /Minimums/);
  // A stored schedule that no longer passes reads as none, so the flat rates apply.
  assert.equal(readSchedule({ tiers: [{ upTo: 5, premiumBps: 1, commissionBps: 1 }] }), null);
  assert.equal(readSchedule(null), null);
  assert.deepEqual(readSchedule(SCHEDULE), SCHEDULE);

  // The settings form: percents, prices as typed, blank spare rows skipped, minimums in dollars.
  const form = scheduleFromForm({
    upTo: ["50k", "$250,000", "", ""],
    premium: ["3.7", "2", "0.66", ""],
    commission: ["1.85", "1.5", "1", ""],
    minPremium: "750",
    minCommission: "$500",
  });
  assert.equal(form.error, null);
  assert.deepEqual(form.schedule, SCHEDULE);
  assert.match(scheduleFromForm({ upTo: ["", ""], premium: ["2", ""], commission: ["", ""], minPremium: "", minCommission: "" }).error ?? "", /needs a buyer premium and a seller commission/);
  assert.match(scheduleFromForm({ upTo: [""], premium: ["2.555"], commission: ["1"], minPremium: "", minCommission: "" }).error ?? "", /two decimal places/);
  assert.match(scheduleFromForm({ upTo: ["abc", ""], premium: ["2", "1"], commission: ["1", "1"], minPremium: "", minCommission: "" }).error ?? "", /dollar amount/);
  assert.match(scheduleFromForm({ upTo: [""], premium: ["11"], commission: ["1"], minPremium: "", minCommission: "" }).error ?? "", /between 0% and 10%/);
});

test("a listing keeps the schedule from its approval; a flat approval stays flat; nothing kept takes the settings of the day", () => {
  const flatSettings = { buyerPremiumBps: 250, sellerCommissionBps: 300, feeSchedule: null };
  const gradedSettings = { buyerPremiumBps: 250, sellerCommissionBps: 300, feeSchedule: SCHEDULE };
  // Approval writes the schedule with the flat fields, or null to clear one an earlier approval kept.
  assert.deepEqual(feesAtApproval(gradedSettings), { feeBuyerPremiumBps: 250, feeSellerCommissionBps: 300, feeSchedule: SCHEDULE });
  assert.deepEqual(feesAtApproval(flatSettings), { feeBuyerPremiumBps: 250, feeSellerCommissionBps: 300, feeSchedule: null });
  // A caller without the field is unchanged.
  assert.deepEqual(feesAtApproval({ buyerPremiumBps: 250, sellerCommissionBps: 300 }), { feeBuyerPremiumBps: 250, feeSellerCommissionBps: 300 });

  const kept = feesAtApproval(gradedSettings);
  assert.deepEqual(feeTerms(kept, flatSettings).schedule, SCHEDULE);
  assert.equal(feesFor(kept, flatSettings, 100000).premiumCents, 200000);
  // Approved flat: the settings' later schedule doesn't reach it.
  const flatKept = { feeBuyerPremiumBps: 100, feeSellerCommissionBps: 0, feeSchedule: null };
  assert.equal(feeTerms(flatKept, gradedSettings).schedule, null);
  assert.deepEqual([feesFor(flatKept, gradedSettings, 100000).premiumCents, feesFor(flatKept, gradedSettings, 100000).commissionCents], [100000, 0]);
  // Nothing kept: the settings of the day, graded or flat.
  assert.deepEqual(feeTerms({}, gradedSettings).schedule, SCHEDULE);
  assert.equal(feeTerms(null, flatSettings).schedule, null);
  assert.equal(feesFor(null, flatSettings, 100000).premiumCents, 250000);
  // The flat helper still answers as it did.
  assert.deepEqual(listingFeeBps({ feeBuyerPremiumBps: 100, feeSellerCommissionBps: 0 }, flatSettings), { premiumBps: 100, commissionBps: 0 });
  assert.deepEqual(listingFeeBps(null, flatSettings), { premiumBps: 250, commissionBps: 300 });
});

// ---------------------------------------------------------------------------------------------------------------
// The schedule through approval, award, kick-out and the bid limit.

async function makePeople(tag: string) {
  const person = (prefix: string, role: "BUYER" | "ADMIN" | "INSTITUTIONAL_SELLER") =>
    prisma.user.create({ data: { email: `revenue-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  return { desk: await person("desk", "ADMIN"), buyer: await person("buyer", "BUYER"), seller: await person("seller", "INSTITUTIONAL_SELLER") };
}

function loan(ask: number, upb: number) {
  return {
    streetAddress: "1 Test St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
    lienPosition: "FIRST", upb, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: ask, estimatedValue: upb * 1.4,
  };
}

async function makePool(sellerId: string, title: string, fees: object) {
  return prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      title,
      ...fees,
      notes: { create: [loan(40000, 60000), loan(60000, 90000)] as never },
    },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
}

async function cleanUp(tag: string, listingIds: string[], userIds: string[]) {
  const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { subject: { contains: literal(tag) } } });
  await prisma.notification.deleteMany({ where: { toEmail: { contains: literal(tag) } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test("the schedule kept at approval prices the award, a kick-out, a desk purchase and the bid limit; a flat listing is unchanged", async () => {
  const tag = tagOf();
  const { desk, buyer, seller } = await makePeople(tag);
  const listingIds: string[] = [];
  try {
    clearSettingsCache();
    const live = await getSettings();
    // The approval path spreads feesAtApproval into the listing, as here, with settings that carry a schedule.
    const graded = await makePool(seller.id, `Graded ${tag}`, feesAtApproval({ buyerPremiumBps: 250, sellerCommissionBps: 300, feeSchedule: SCHEDULE }));
    const flat = await makePool(seller.id, `Flat ${tag}`, feesAtApproval({ buyerPremiumBps: 250, sellerCommissionBps: 300, feeSchedule: null }));
    const desked = await makePool(seller.id, `Desk ${tag}`, feesAtApproval({ buyerPremiumBps: 250, sellerCommissionBps: 300, feeSchedule: SCHEDULE }));
    listingIds.push(graded.id, flat.id, desked.id);
    assert.deepEqual(graded.feeSchedule, SCHEDULE);
    assert.equal(flat.feeSchedule, null);

    // The bid limit: $20,000 on the graded listing owes the $750 minimum premium, so $20,500 of funds falls short,
    // where the flat 2.5% would just fit.
    await prisma.buyerProfile.create({ data: { userId: buyer.id, proofAmount: 20500, proofVerifiedAt: new Date(), proofExpiresAt: new Date(Date.now() + 30 * DAY) } as never });
    const over = await fundsLimitBlock({ userId: buyer.id, listingId: graded.id, noteId: graded.notes[0].id, amount: 20000 });
    assert.match(over.error ?? "", /all-in of \$20,750 is over your verified funds/);
    const fits = await fundsLimitBlock({ userId: buyer.id, listingId: flat.id, noteId: flat.notes[0].id, amount: 20000 });
    assert.equal(fits.error, null);
    // An open bid holds the graded all-in against the buyer's funds.
    await prisma.inquiry.create({ data: { listingId: graded.id, buyerId: buyer.id, type: "OFFER", noteId: graded.notes[0].id, amount: 20000, status: "OPEN" } });
    await prisma.inquiry.create({ data: { listingId: flat.id, buyerId: buyer.id, type: "OFFER", noteId: flat.notes[0].id, amount: 20000, status: "OPEN" } });
    const held = await fundsExposure(buyer.id, live.buyerPremiumBps);
    assert.deepEqual(held.map((row) => row.allIn).sort((a, b) => a - b), [20500, 20750]);

    // The award charges the tier the price falls in: $100,000 at 2% and 1.5%.
    const whole = await prisma.inquiry.create({ data: { listingId: graded.id, buyerId: buyer.id, type: "OFFER", amount: 100000, status: "ACCEPTED" } });
    const closing = await openClosing({ listingId: graded.id, inquiryId: whole.id, noteId: null, salePrice: 100000, title: graded.title });
    assert.equal(closing.buyerPremiumCents, 200000);
    assert.equal(closing.sellerCommissionCents, 150000);
    assert.equal(closing.buyerTotalCents, 10000000 + 200000);
    assert.equal(closing.netToSellerCents, 10000000 - 150000);

    // A kick-out takes the second loan's 60% of the asks out, and $40,000 falls into the first tier: 3.7% and 1.85%,
    // not the 2% and 1.5% the closing opened at.
    const kicked = await kickOutLoan({ closingId: closing.id, noteId: graded.notes[1].id, reason: "Title defect on the assignment.", actorId: desk.id });
    assert.equal(kicked.error, null);
    const after = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
    assert.equal(Number(after.salePrice), 40000);
    assert.equal(after.buyerPremiumCents, 148000);
    assert.equal(after.sellerCommissionCents, 74000);
    assert.equal(after.buyerTotalCents, 4000000 + 148000);
    assert.equal(after.netToSellerCents, 4000000 - 74000);

    // The flat listing charges its flat rates, exactly as before schedules.
    const flatBid = await prisma.inquiry.create({ data: { listingId: flat.id, buyerId: buyer.id, type: "OFFER", amount: 100000, status: "ACCEPTED" } });
    const flatClosing = await openClosing({ listingId: flat.id, inquiryId: flatBid.id, noteId: null, salePrice: 100000, title: flat.title });
    assert.equal(flatClosing.buyerPremiumCents, 250000);
    assert.equal(flatClosing.sellerCommissionCents, 300000);
    const flatKick = await kickOutLoan({ closingId: flatClosing.id, noteId: flat.notes[1].id, reason: "The borrower paid off.", actorId: desk.id });
    assert.equal(flatKick.error, null);
    const flatAfter = await prisma.closing.findUniqueOrThrow({ where: { id: flatClosing.id } });
    assert.equal(flatAfter.buyerPremiumCents, 100000);
    assert.equal(flatAfter.sellerCommissionCents, 120000);

    // A desk purchase pays no premium, and the commission follows the schedule when the desk charges it.
    const deskBid = await prisma.deskBid.create({ data: { listingId: desked.id, amount: 30000, status: "ACCEPTED" } });
    const deskClosing = await openClosing({ listingId: desked.id, deskBidId: deskBid.id, noteId: null, salePrice: 30000, title: desked.title });
    assert.equal(deskClosing.buyerPremiumCents, 0);
    assert.equal(deskClosing.sellerCommissionCents, live.chargeDeskFees ? 55500 : 0);
  } finally {
    await cleanUp(tag, listingIds, [desk.id, buyer.id, seller.id]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Value my loans.

const LOANS: ValuationLoan[] = [
  { state: "FL", city: "", lienPosition: "FIRST", paymentStatus: "PERFORMING", occupancy: "UNKNOWN", upb: 150000, interestRate: 7, monthlyPi: 1100, estimatedValue: 240000, monthsDelinquent: 0, maturityDate: null },
  { state: "GA", city: "", lienPosition: "FIRST", paymentStatus: "PERFORMING", occupancy: "UNKNOWN", upb: 90000, interestRate: 8, monthlyPi: 760, estimatedValue: 160000, monthsDelinquent: 0, maturityDate: null },
];

test("the instant range comes from the desk model and comps, with its basis said plainly", () => {
  const now = new Date("2026-11-07T15:00:00Z");
  const range = valuationRange(LOANS, { targetYield: 12, premiumBps: 250, trades: [], now });
  assert.ok(range.low != null && range.high != null && range.low <= range.high);
  assert.equal(range.lowPrice, Math.round((240000 * (range.low ?? 0)) / 100));
  assert.equal(range.highPrice, Math.round((240000 * (range.high ?? 0)) / 100));
  assert.match(range.basis, /^Desk model at 11–13% IRR/);
  assert.match(range.basis, /Priced on 2 loans as you entered them, before the desk reads any file\./);
  // Closed trades like these join the range once there are enough of them.
  const trades = Array.from({ length: 4 }, (_, index) => ({ price: 140000 + index * 1000, upb: 150000, lienPosition: "FIRST", paymentStatus: "PERFORMING", state: "FL", closedAt: new Date(now.getTime() - (index + 1) * 30 * DAY) }));
  const withComps = valuationRange(LOANS, { targetYield: 12, premiumBps: 250, trades, now });
  assert.match(withComps.basis, /median of 4 closed trades/);
});

test("typed loans skip blank rows, number problems by row, and stop at ten; a tape reads through the tape parser", async () => {
  const blank = { state: "", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: "", interestRate: "", monthlyPi: "", estimatedValue: "" };
  const row = { state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: "150,000", interestRate: "7", monthlyPi: "1100", estimatedValue: "240k" };
  const read = readTypedLoans([row, blank, { ...row, upb: "$90,000" }]);
  assert.equal(read.error, null);
  assert.deepEqual(read.loans?.map((item) => item.upb), [150000, 90000]);
  assert.equal(read.loans?.[0].estimatedValue, 240000);
  assert.match(readTypedLoans([blank, blank]).error ?? "", /at least one loan/);
  assert.equal(readTypedLoans([row, blank, { ...row, state: "" }]).error, "Loan 3 needs a US state.");
  assert.equal(readTypedLoans([{ ...row, estimatedValue: "0" }]).error, "The loan needs an unpaid balance and a value above zero.");
  assert.match(readTypedLoans(Array.from({ length: 11 }, () => row)).error ?? "", /up to 10 loans/);

  const csv = [TAPE_HEADERS, ...SAMPLE_TAPE_ROWS].map((cells) => cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const tape = await readValuationTape("loans.csv", Buffer.from(csv));
  assert.equal(tape.error, null);
  assert.equal(tape.loans?.length, 3);
  assert.deepEqual(tape.loans?.map((item) => item.state), ["FL", "GA", "NC"]);
  // Nothing that names a borrower is kept.
  assert.doesNotMatch(JSON.stringify(tape.loans), /FICTIONAL BORROWER|SAMPLE Banyan/);
  assert.match((await readValuationTape("loans.pdf", Buffer.from("x"))).error ?? "", /CSV or Excel/);
});

async function cleanValuations(tag: string, emails: string[], extraUserIds: string[] = []) {
  const ids = (await prisma.valuationRequest.findMany({ where: { email: { in: emails } }, select: { id: true } })).map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [...ids, ...extraUserIds] } } });
  await prisma.valuationRequest.deleteMany({ where: { id: { in: ids } } });
  await prisma.notification.deleteMany({ where: { OR: [{ subject: { contains: literal(tag) } }, { toEmail: { in: emails } }] } });
  await prisma.ofacCheck.deleteMany({ where: { name: { contains: literal(tag) } } });
  await prisma.rateWindow.deleteMany({ where: { key: { contains: literal(tag) } } });
  if (extraUserIds.length) {
    await prisma.passwordReset.deleteMany({ where: { userId: { in: extraUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } });
  }
}

test("a valuation request is stored with its range, screened and sent to the desk; the desk quotes, invites and closes it", async () => {
  const tag = tagOf();
  const email = `valuer-${tag}@example.org`;
  const desk = await prisma.user.create({ data: { email: `revenue-desk-${tag}@example.org`, name: `Desk ${tag}`, role: "ADMIN", accountStatus: "APPROVED", passwordHash: "x" } });
  const screens: Promise<unknown>[] = [];
  let invitedId: string | null = null;
  try {
    const typed = [
      { state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: "150000", interestRate: "7", monthlyPi: "1100", estimatedValue: "240000" },
      { state: "GA", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: "90000", interestRate: "8", monthlyPi: "760", estimatedValue: "160000" },
    ];
    const stored: string[] = [];
    const base = { name: `Valuer ${tag}`, email, company: `Holdings ${tag}`, terms: "yes", typed, ipAddress: `ip-${tag}`, screen: (work: () => Promise<unknown>) => void screens.push(work()), store: async (key: string) => void stored.push(key) };
    assert.match((await requestValuation({ ...base, terms: null })).error ?? "", /terms of use/);
    const made = await requestValuation(base);
    if (made.error !== null) throw new Error(made.error);
    await Promise.all(screens);
    const request = await prisma.valuationRequest.findUniqueOrThrow({ where: { id: made.id } });
    assert.equal(request.status, "NEW");
    assert.equal(request.loans, 2);
    assert.equal(request.upb, 240000);
    assert.equal(request.lowPrice, made.range.lowPrice);
    assert.equal(request.highPrice, made.range.highPrice);
    assert.match(request.basis, /Desk model/);
    assert.equal(storedLoans(request.rows).length, 2);
    assert.equal(request.tapeKey, "");
    assert.deepEqual(stored, []);
    // Both names were screened, and the desk heard.
    assert.equal(await prisma.ofacCheck.count({ where: { name: { contains: literal(tag) } } }), 2);
    assert.ok(await prisma.notification.findFirst({ where: { subject: `Valuation request · Valuer ${tag}` } }));

    // The desk's range, with a note the seller reads.
    const actor = { id: desk.id, name: desk.name };
    assert.match((await quoteValuation({ id: made.id, low: "150000", high: "120000", note: "On the pay history.", actor })).error ?? "", /can't be below/);
    assert.match((await quoteValuation({ id: made.id, low: "120000", high: "150000", note: "", actor })).error ?? "", /Add a note/);
    assert.equal((await quoteValuation({ id: made.id, low: "$120,000", high: "150k", note: "Both loans pay on time; the Georgia value needs a BPO.", actor })).error, null);
    const quoted = await prisma.valuationRequest.findUniqueOrThrow({ where: { id: made.id } });
    assert.equal(quoted.status, "QUOTED");
    assert.deepEqual([quoted.lowPrice, quoted.highPrice], [120000, 150000]);
    assert.equal(quoted.deskNote, "Both loans pay on time; the Georgia value needs a BPO.");
    const mail = await prisma.notification.findFirst({ where: { toEmail: email, subject: "Your valuation · 2 loans" } });
    assert.match(mail?.body ?? "", /\$120,000 to \$150,000/);
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: made.id, action: "VALUATION_QUOTED" } }));

    // Inviting a seller with no account sets one up and ties the request to it.
    const invite = await inviteFromValuation({ id: made.id, role: "INSTITUTIONAL_SELLER", actor });
    assert.equal(invite.error, null);
    assert.equal(invite.invited, true);
    const invited = await prisma.user.findUniqueOrThrow({ where: { email } });
    invitedId = invited.id;
    assert.equal(invited.role, "INSTITUTIONAL_SELLER");
    assert.equal((await prisma.valuationRequest.findUniqueOrThrow({ where: { id: made.id } })).userId, invited.id);

    // Closing needs a reason, and a closed request takes no quote.
    assert.match((await closeValuation({ id: made.id, note: "", actor })).error ?? "", /Say why/);
    assert.equal((await closeValuation({ id: made.id, note: "Listed with another desk.", actor })).error, null);
    assert.equal((await prisma.valuationRequest.findUniqueOrThrow({ where: { id: made.id } })).status, "CLOSED");
    assert.match((await closeValuation({ id: made.id, note: "Again.", actor })).error ?? "", /already closed/);
    assert.match((await quoteValuation({ id: made.id, low: "1", high: "2", note: "Late.", actor })).error ?? "", /closed/);
  } finally {
    await Promise.allSettled(screens);
    await cleanValuations(tag, [email], invitedId ? [invitedId] : []);
    await prisma.auditEvent.deleteMany({ where: { actorId: desk.id } });
    await prisma.user.deleteMany({ where: { id: desk.id } });
  }
});

test("valuation requests are rate limited per network and per email", async () => {
  const tag = tagOf();
  const email = `limited-${tag}@example.org`;
  try {
    // Every request counts against its network, even one refused for a missing name.
    for (let index = 0; index < IP_LIMIT; index += 1) {
      assert.equal((await requestValuation({ name: "", email, company: "Co", terms: "yes", ipAddress: `net-${tag}` })).error, "Enter your name.");
    }
    assert.equal((await requestValuation({ name: "Someone", email, company: "Co", terms: "yes", ipAddress: `net-${tag}` })).error, RATE_LIMITED);
    // And past the form's own checks, against its email, from any network.
    for (let index = 0; index < EMAIL_LIMIT; index += 1) {
      assert.match((await requestValuation({ name: "Someone", email, company: "Co", terms: "yes", typed: [], ipAddress: `other-${index}-${tag}` })).error ?? "", /at least one loan/);
    }
    assert.equal((await requestValuation({ name: "Someone", email, company: "Co", terms: "yes", typed: [], ipAddress: `fresh-${tag}` })).error, RATE_LIMITED);
    assert.equal(await prisma.valuationRequest.count({ where: { email } }), 0);
  } finally {
    await cleanValuations(tag, [email]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The 10-year from Treasury.

const SAMPLE = readFileSync(path.join(process.cwd(), "tests", "fixtures", "treasury", "par-yield-202510.xml"), "utf8");
const EMPTY_FEED = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="text">DailyTreasuryYieldCurveRateData</title></feed>`;

test("Treasury's par yield feed parses to its days with a 10-year, latest last", async () => {
  assert.deepEqual(parseParYields(SAMPLE), [
    { date: "2025-10-01", rate: 4.12 },
    { date: "2025-10-02", rate: 4.1 },
    { date: "2025-10-03", rate: 4.13 },
  ]);
  assert.deepEqual(latestParYield(SAMPLE), { date: "2025-10-03", rate: 4.13 });
  assert.equal(latestParYield(EMPTY_FEED), null);
  assert.equal(nextBusinessDay("2026-11-06"), "2026-11-09");
  assert.equal(nextBusinessDay("2026-11-09"), "2026-11-10");
  assert.equal(easternDay(new Date("2026-11-07T03:00:00Z")), "2026-11-06");
  // Early in a month, before its first curve, the read falls back to the month before.
  const asked: string[] = [];
  const read = await readTenYear(new Date("2025-11-01T14:00:00Z"), async (url) => {
    asked.push(String(url));
    return new Response(String(url).includes("202511") ? EMPTY_FEED : SAMPLE, { status: 200 });
  });
  assert.deepEqual(read, { date: "2025-10-03", rate: 4.13 });
  assert.match(asked[0], /data=daily_treasury_yield_curve&field_tdr_date_value_month=202511$/);
  assert.match(asked[1], /field_tdr_date_value_month=202510$/);
});

test("a desk entry holds until the next business day and a newer curve; a Treasury rate gives way to newer days and corrections", () => {
  const read = { date: "2026-11-06", rate: 4.21 };
  const manual = { rate: 4.2, asOf: new Date("2026-11-06T00:00:00Z"), source: "MANUAL" };
  // Entered Friday afternoon in New York.
  const enteredAt = new Date("2026-11-06T20:00:00Z");
  assert.equal(treasuryDecision({ current: manual, enteredAt, read, now: new Date("2026-11-07T13:00:00Z") }).apply, false);
  assert.match(treasuryDecision({ current: manual, enteredAt, read, now: new Date("2026-11-07T13:00:00Z") }).reason, /holds until Nov 9, 2026/);
  // Monday's run still has only Friday's curve, the read the desk overrode.
  assert.equal(treasuryDecision({ current: manual, enteredAt, read, now: new Date("2026-11-09T13:00:00Z") }).apply, false);
  assert.equal(treasuryDecision({ current: manual, enteredAt, read: { date: "2026-11-09", rate: 4.25 }, now: new Date("2026-11-10T13:00:00Z") }).apply, true);
  // A rate typed before sources were kept counts as the desk's.
  assert.equal(treasuryDecision({ current: { ...manual, source: null }, enteredAt: null, read, now: new Date("2026-11-07T13:00:00Z") }).apply, false);

  const treasury = { rate: 4.2, asOf: new Date("2026-11-05T00:00:00Z"), source: "TREASURY" };
  const now = new Date("2026-11-07T13:00:00Z");
  assert.equal(treasuryDecision({ current: treasury, enteredAt: null, read, now }).apply, true);
  assert.equal(treasuryDecision({ current: treasury, enteredAt: null, read: { date: "2026-11-04", rate: 4 }, now }).apply, false);
  assert.equal(treasuryDecision({ current: treasury, enteredAt: null, read: { date: "2026-11-05", rate: 4.2 }, now }).apply, false);
  assert.equal(treasuryDecision({ current: treasury, enteredAt: null, read: { date: "2026-11-05", rate: 4.22 }, now }).reason, "a correction");
  assert.equal(treasuryDecision({ current: { rate: null, asOf: null, source: null }, enteredAt: null, read, now }).apply, true);
});

test("the job stores Treasury's latest 10-year, and a failed read leaves the rate alone", async () => {
  const before = await prisma.platformSettings.findUnique({ where: { id: "default" } });
  const started = new Date();
  const now = new Date("2025-10-20T13:00:00Z");
  const quiet = console.error;
  try {
    // A Treasury rate older than the feed's latest day gives way to it.
    await prisma.platformSettings.upsert({
      where: { id: "default" },
      update: { tenYearRate: 3.9, tenYearAsOf: new Date("2025-09-30T00:00:00Z"), tenYearSource: "TREASURY" },
      create: { id: "default", tenYearRate: 3.9, tenYearAsOf: new Date("2025-09-30T00:00:00Z"), tenYearSource: "TREASURY" },
    });
    const stored = await refreshTenYear(now, { fetcher: async () => new Response(SAMPLE, { status: 200 }), rescore: false });
    assert.equal(stored.ok, true);
    assert.equal(stored.applied, true);
    let row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: "default" } });
    assert.equal(row.tenYearRate, 4.13);
    assert.equal(row.tenYearAsOf?.toISOString(), "2025-10-03T00:00:00.000Z");
    assert.equal(row.tenYearSource, "TREASURY");
    clearSettingsCache();
    assert.equal((await getSettings()).tenYearRate, 4.13);
    // The same read again changes nothing.
    assert.equal((await refreshTenYear(now, { fetcher: async () => new Response(SAMPLE, { status: 200 }), rescore: false })).applied, false);

    // A failed read, by status or by a network error, is logged and writes nothing.
    console.error = () => {};
    const down = await refreshTenYear(now, { fetcher: async () => new Response("Service unavailable", { status: 503 }), rescore: false });
    assert.equal(down.ok, false);
    assert.match(down.line, /Treasury answered 503/);
    const thrown = await refreshTenYear(now, { fetcher: async () => { throw new Error("connect ETIMEDOUT"); }, rescore: false });
    assert.equal(thrown.ok, false);
    assert.match(thrown.line, /ETIMEDOUT/);
    const garbled = await refreshTenYear(now, { fetcher: async () => new Response("<html>maintenance</html>", { status: 200 }), rescore: false });
    assert.equal(garbled.ok, false);
    row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: "default" } });
    assert.equal(row.tenYearRate, 4.13);
    assert.equal(row.tenYearAsOf?.toISOString(), "2025-10-03T00:00:00.000Z");
  } finally {
    console.error = quiet;
    // The shared settings row goes back to what it was.
    await prisma.platformSettings.update({
      where: { id: "default" },
      data: { tenYearRate: before?.tenYearRate ?? null, tenYearAsOf: before?.tenYearAsOf ?? null, tenYearSource: before?.tenYearSource ?? null },
    });
    clearSettingsCache();
    await prisma.auditEvent.deleteMany({ where: { action: "TREASURY_RATE", createdAt: { gte: started } } });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The back-test.

function award(error: number, lien: string, performance: string, inRange: boolean): BacktestRow {
  return { closingId: `${lien}${performance}${error}`, listingId: "l", title: "t", awardedAt: new Date(), loans: 1, upb: 100000, price: 0, lien, performance, awardOfUpb: 70 + error, low: 68, high: 72, mid: 70, error, inRange };
}

test("the back-test reports median error, mean absolute error and bias, overall and by lien and performance", async () => {
  const rows = [award(1, "FIRST", "PERFORMING", true), award(-2, "FIRST", "NON_PERFORMING", true), award(4, "SECOND", "PERFORMING", false)];
  const stats = backtestStats(rows);
  assert.equal(stats.count, 3);
  assert.equal(stats.medianError, 1);
  assert.ok(Math.abs((stats.meanAbsError ?? 0) - 7 / 3) < 1e-9);
  assert.ok(Math.abs((stats.bias ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((stats.inRange ?? 0) - 2 / 3) < 1e-9);
  assert.deepEqual(backtestStats([]), { count: 0, medianError: null, meanAbsError: null, bias: null, inRange: null });
  assert.equal(backtestStats([award(1, "FIRST", "PERFORMING", true), award(3, "FIRST", "PERFORMING", true)]).medianError, 2);
  const byLien = backtestGroups(rows, "lien");
  assert.deepEqual(byLien.map((group) => [group.label, group.count, group.medianError]), [["First", 2, -0.5], ["Second", 1, 4]]);
  const byPerformance = backtestGroups(rows, "performance");
  assert.deepEqual(byPerformance.map((group) => [group.key, group.count, group.bias]), [["PERFORMING", 2, 2.5], ["NON_PERFORMING", 1, -2]]);
  // An award at 74% of UPB against a 68–72% range is 4 points over its middle and outside it.
  assert.deepEqual(scoreAward({ price: 74000, upb: 100000, low: 68, high: 72 }), { awardOfUpb: 74, mid: 70, error: 4, inRange: false });
  assert.equal(scoreAward({ price: 0, upb: 100000, low: 68, high: 72 }), null);

  // An award on file is scored against its range recomputed as of the award, and a canceled one isn't.
  const tag = tagOf();
  const { desk, buyer, seller } = await makePeople(tag);
  const listingIds: string[] = [];
  try {
    const listing = await prisma.listing.create({
      data: { kind: "SINGLE", sellerId: seller.id, status: "PENDING", approvedAt: new Date(Date.now() - 30 * DAY), title: `Backtest ${tag}`, notes: { create: [loan(100000, 150000)] as never } },
      include: { notes: true },
    });
    listingIds.push(listing.id);
    const won = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 105000, status: "ACCEPTED" } });
    const closing = await openClosing({ listingId: listing.id, inquiryId: won.id, noteId: null, salePrice: 105000, title: listing.title });
    const lost = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 90000, status: "ACCEPTED" } });
    const canceled = await prisma.closing.create({ data: { listingId: listing.id, inquiryId: lost.id, noteId: null, salePrice: 90000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 9000000, netToSellerCents: 9000000, status: "CANCELED" } as never });
    const result = await loadBacktest();
    const scored = result.rows.find((item) => item.closingId === closing.id);
    assert.ok(scored, "the award is scored");
    assert.equal(result.rows.some((item) => item.closingId === canceled.id), false);
    assert.equal(scored.awardOfUpb, 70);
    assert.ok(Math.abs(scored.error - (70 - (scored.low + scored.high) / 2)) < 1e-9);
    assert.equal(scored.lien, "FIRST");
    assert.equal(scored.performance, "PERFORMING");
    assert.equal(result.enough, result.rows.length >= MIN_AWARDS);
    assert.equal(MIN_AWARDS, 10);
  } finally {
    await cleanUp(tag, listingIds, [desk.id, buyer.id, seller.id]);
  }
});
