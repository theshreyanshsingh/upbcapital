import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { askSeller, awardOffer, checkAward } from "../lib/awards";
import { openClosing } from "../lib/closing-service";
import { chargeFees, feeTerms, feesFor, flatTerms, payerText, rateText, type FeeSchedule } from "../lib/fee-schedule";
import { prisma } from "../lib/prisma";
import {
  BID_SUMMARY_COLUMNS,
  DEFAULT_RESPONSE_HOURS,
  answerDue,
  bidSummary,
  bidSummaryCsv,
  bidSummaryPdf,
  carriedSellerTerms,
  counterAnyBid,
  feePayerBlock,
  fundsBand,
  readResponseHours,
  remindSellerAnswers,
  respondByFor,
  sellerCounterBlock,
  sellerTermsLine,
  setFeePayer,
  setResponseWindow,
  trackLine,
  trackRecord,
} from "../lib/seller-decisions";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: tagged people and a pool, so parallel runs and other builders never share rows, and cleanup finds all.

const note = (street: string, upb = 100000) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 80000, estimatedValue: 150000,
});

async function makeDeal(listing: Record<string, unknown> = {}) {
  const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
  const user = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN" | "BROKER", extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email: `b-seller-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra } });
  const seller = await user("seller", "INDIVIDUAL_SELLER");
  const other = await user("other", "INDIVIDUAL_SELLER");
  const buyer = await user("buyer", "BUYER", { companyName: `Acme Notes ${tag}`, createdAt: new Date("2023-05-01T00:00:00Z") });
  const second = await user("second", "BUYER");
  const third = await user("third", "BUYER");
  const desk = await user("desk", "ADMIN");
  const trader = await user("trader", "ADMIN", { deskRole: "TRADER" });
  const broker = await user("broker", "BROKER");
  const row = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      brokerId: broker.id,
      status: "APPROVED",
      approvedAt: new Date(),
      title: `Seller decisions ${tag}`,
      bidMode: "NONE",
      notes: { create: [note("1 First St"), note("2 Second St")] as never },
      ...listing,
    },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
  return { tag, seller, other, buyer, second, third, desk, trader, broker, listing: row, users: [seller, other, buyer, second, third, desk, trader, broker] };
}

type Deal = Awaited<ReturnType<typeof makeDeal>>;

async function cleanDeal(deal: Deal, extraListings: string[] = []) {
  const listingIds = [deal.listing.id, ...extraListings];
  const inquiries = await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
  const closings = await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
  const ids = [...listingIds, ...inquiries.map((row) => row.id), ...closings.map((row) => row.id), ...deal.users.map((user) => user.id)];
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { inquiryId: { in: inquiries.map((row) => row.id) } }, { closingId: { in: closings.map((row) => row.id) } }] } });
  await prisma.ofacCheck.deleteMany({ where: { userId: { in: deal.users.map((user) => user.id) } } });
  await prisma.buyerStrike.deleteMany({ where: { userId: { in: deal.users.map((user) => user.id) } } });
  await prisma.groupBuy.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: deal.users.map((user) => user.email) } }, { subject: { contains: deal.tag } }] } });
  await prisma.user.deleteMany({ where: { id: { in: deal.users.map((user) => user.id) } } });
}

const bid = (deal: Deal, buyerId: string, amount: number, extra: Record<string, unknown> = {}) =>
  prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId, type: "OFFER", status: "OPEN", amount, ...extra } });

const mail = (deal: Deal, toEmail: string, subject: string) =>
  prisma.notification.count({ where: { toEmail, subject: `${subject} · ${deal.listing.title}` } });

async function ask(inquiryId: string) {
  const check = await checkAward(inquiryId);
  if (check.error !== null) throw new Error(check.error);
  assert.equal(check.agreed, null);
  await askSeller(check.offer, check.price);
  return prisma.inquiry.findUniqueOrThrow({ where: { id: inquiryId } });
}

// ---------------------------------------------------------------------------------------------------------------
// The window to answer.

test("the window defaults to 72 hours, takes 24 to 240, and is due a reminder at half time and the desk at the end", () => {
  const asked = new Date("2026-11-08T12:00:00Z");
  assert.equal(DEFAULT_RESPONSE_HOURS, 72);
  assert.equal(respondByFor({}, asked).toISOString(), "2026-11-11T12:00:00.000Z");
  assert.equal(respondByFor({ sellerResponseHours: 24 }, asked).toISOString(), "2026-11-09T12:00:00.000Z");
  // A stored value outside the limits reads as the default.
  assert.equal(respondByFor({ sellerResponseHours: 5 }, asked).toISOString(), "2026-11-11T12:00:00.000Z");
  assert.match(readResponseHours("23").error ?? "", /from 24 to 240 hours/);
  assert.match(readResponseHours("241").error ?? "", /from 24 to 240 hours/);
  assert.match(readResponseHours("36.5").error ?? "", /whole hours/);
  assert.match(readResponseHours("").error ?? "", /hours/);
  assert.deepEqual(readResponseHours("24"), { error: null, hours: 24 });
  assert.deepEqual(readResponseHours(" 240 "), { error: null, hours: 240 });

  const offer = { sellerAskedAt: asked, sellerAnsweredAt: null, sellerRespondBy: new Date(asked.getTime() + 48 * HOUR), sellerRemindedAt: null };
  assert.equal(answerDue(offer, new Date(asked.getTime() + 23 * HOUR)), null);
  assert.equal(answerDue(offer, new Date(asked.getTime() + 24 * HOUR)), "remind");
  const reminded = { ...offer, sellerRemindedAt: new Date(asked.getTime() + 24 * HOUR) };
  assert.equal(answerDue(reminded, new Date(asked.getTime() + 30 * HOUR)), null);
  assert.equal(answerDue(reminded, new Date(asked.getTime() + 48 * HOUR)), "report");
  assert.equal(answerDue({ ...offer, sellerRemindedAt: new Date(asked.getTime() + 48 * HOUR) }, new Date(asked.getTime() + 60 * HOUR)), null);
  // A run that missed half time and lands after the deadline tells the desk only.
  assert.equal(answerDue(offer, new Date(asked.getTime() + 50 * HOUR)), "report");
  // An answered ask is due nothing, and neither is one from before the window existed.
  assert.equal(answerDue({ ...offer, sellerAnsweredAt: new Date(asked.getTime() + HOUR) }, new Date(asked.getTime() + 50 * HOUR)), null);
  assert.equal(answerDue({ ...offer, sellerRespondBy: null }, new Date(asked.getTime() + 50 * HOUR)), null);
  // A reminder from an earlier ask doesn't count for a new one.
  assert.equal(answerDue({ ...offer, sellerRemindedAt: new Date(asked.getTime() - HOUR) }, new Date(asked.getTime() + 25 * HOUR)), "remind");
});

test("the desk's ask sets the seller's window, the seller hears once at half time, and the desk once at the deadline", async () => {
  const deal = await makeDeal();
  try {
    // The seller sets their window; anything outside 24 to 240 hours is refused, and only the seller sets it.
    assert.match((await setResponseWindow({ listingId: deal.listing.id, actorId: deal.seller.id, hours: "12" })).error ?? "", /24 to 240/);
    assert.equal((await setResponseWindow({ listingId: deal.listing.id, actorId: deal.buyer.id, hours: "48" })).error, "That listing isn't yours.");
    assert.equal((await setResponseWindow({ listingId: deal.listing.id, actorId: deal.broker.id, hours: "48" })).error, "That listing isn't yours.");
    assert.equal((await setResponseWindow({ listingId: deal.listing.id, actorId: deal.seller.id, hours: "48" })).error, null);

    const offer = await bid(deal, deal.buyer.id, 150000);
    const asked = await ask(offer.id);
    assert.ok(asked.sellerAskedAt && asked.sellerRespondBy);
    assert.equal(asked.sellerRespondBy.getTime() - asked.sellerAskedAt.getTime(), 48 * HOUR);
    assert.equal(asked.sellerRemindedAt, null);
    const body = await prisma.notification.findFirstOrThrow({ where: { toEmail: deal.seller.email, subject: `Approve a sale · ${deal.listing.title}` } });
    assert.match(body.body, /Please answer by .* UTC\. Approve or decline here: /);

    const at = (hours: number) => new Date(asked.sellerAskedAt!.getTime() + hours * HOUR);
    const own = { inquiryIds: [offer.id] };
    assert.equal((await remindSellerAnswers(at(12), own)).sent, 0);
    // Two runs at once send one reminder.
    const half = await Promise.all([remindSellerAnswers(at(25), own), remindSellerAnswers(at(25), own)]);
    assert.equal(half[0].sent + half[1].sent, 1);
    assert.equal(await mail(deal, deal.seller.email, "Waiting on your answer"), 1);
    assert.equal((await remindSellerAnswers(at(30), own)).sent, 0);
    assert.equal(await mail(deal, deal.desk.email, "Seller didn't answer"), 0);

    const late = await Promise.all([remindSellerAnswers(at(49), own), remindSellerAnswers(at(49), own)]);
    assert.equal(late[0].sent + late[1].sent, 1);
    assert.equal(await mail(deal, deal.desk.email, "Seller didn't answer"), 1);
    assert.equal((await remindSellerAnswers(at(72), own)).sent, 0);
    assert.equal(await mail(deal, deal.desk.email, "Seller didn't answer"), 1);
    assert.equal(await mail(deal, deal.seller.email, "Waiting on your answer"), 1);
    // The bid isn't declined for the seller: it stays open and the question still waits.
    const after = await prisma.inquiry.findUniqueOrThrow({ where: { id: offer.id } });
    assert.equal(after.status, "OPEN");
    assert.equal(after.sellerDeclined, null);
    assert.equal(after.sellerAnsweredAt, null);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: offer.id, action: "SELLER_ANSWER_LATE" } }), 1);

    // A new ask starts the window again, and the reminder with it.
    const again = await ask(offer.id);
    assert.equal(again.sellerRemindedAt, null);
    assert.ok(again.sellerRespondBy && again.sellerRespondBy.getTime() > after.sellerRespondBy!.getTime() - 1);
  } finally {
    await cleanDeal(deal);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Counters to several bidders.

test("a seller counter waits out a sealed or best-and-final round, and never meets a bid at or under its price", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const base = { type: "OFFER", status: "OPEN", listing: { status: "APPROVED", bidMode: "NONE", bidDeadline: null }, expiresAt: null, current: 90000, amount: 95000, picked: false, now };
  assert.equal(sellerCounterBlock(base), null);
  const ahead = new Date(now.getTime() + DAY);
  const behind = new Date(now.getTime() - DAY);
  assert.match(sellerCounterBlock({ ...base, listing: { status: "APPROVED", bidMode: "SEALED", bidDeadline: ahead } }) ?? "", /sealed until the deadline/);
  assert.match(sellerCounterBlock({ ...base, listing: { status: "APPROVED", bidMode: "BEST_AND_FINAL", bidDeadline: ahead } }) ?? "", /Best and final gives each bidder one bid/);
  assert.equal(sellerCounterBlock({ ...base, listing: { status: "APPROVED", bidMode: "SEALED", bidDeadline: behind } }), null);
  assert.equal(sellerCounterBlock({ ...base, listing: { status: "APPROVED", bidMode: "BEST_AND_FINAL", bidDeadline: behind } }), null);
  assert.match(sellerCounterBlock({ ...base, listing: { ...base.listing, status: "PENDING" } }) ?? "", /isn't live/);
  assert.match(sellerCounterBlock({ ...base, status: "DECLINED" }) ?? "", /no longer open/);
  assert.match(sellerCounterBlock({ ...base, expiresAt: behind }) ?? "", /good-until/);
  assert.match(sellerCounterBlock({ ...base, picked: true }) ?? "", /picked it/);
  assert.match(sellerCounterBlock({ ...base, amount: 90000 }) ?? "", /above the buyer's bid/);
  assert.match(sellerCounterBlock({ ...base, amount: Number.NaN }) ?? "", /in dollars/);
});

test("the seller counters a second bid under the sealed rules, and an award closes the other counters", async () => {
  const deal = await makeDeal({ bidMode: "SEALED", bidDeadline: new Date(Date.now() + DAY) });
  try {
    const first = await bid(deal, deal.buyer.id, 100000);
    const second = await bid(deal, deal.second.id, 90000);
    const third = await bid(deal, deal.third.id, 85000);
    // Sealed until the deadline, then best and final until its deadline: no counter either way.
    assert.match((await counterAnyBid({ inquiryId: second.id, sellerId: deal.seller.id, amount: 95000 })).error ?? "", /sealed until the deadline/);
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { bidMode: "BEST_AND_FINAL" } });
    assert.match((await counterAnyBid({ inquiryId: second.id, sellerId: deal.seller.id, amount: 95000 })).error ?? "", /Best and final/);
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { bidMode: "SEALED", bidDeadline: new Date(Date.now() - 60_000) } });

    // The desk asks about the first bid. The seller counters the second, which the desk never asked about.
    await ask(first.id);
    assert.equal((await counterAnyBid({ inquiryId: second.id, sellerId: deal.other.id, amount: 95000 })).error, "That bid isn't on your listing.");
    assert.match((await counterAnyBid({ inquiryId: second.id, sellerId: deal.seller.id, amount: 90000 })).error ?? "", /above the buyer's bid/);
    const countered = await counterAnyBid({ inquiryId: second.id, sellerId: deal.seller.id, amount: 95000 });
    assert.equal(countered.error, null);
    // A second counter to the same bid replaces the first.
    assert.equal((await counterAnyBid({ inquiryId: second.id, sellerId: deal.seller.id, amount: 97000 })).error, null);
    const row = await prisma.inquiry.findUniqueOrThrow({ where: { id: second.id }, include: { messages: true } });
    assert.equal(row.sellerCounterAmount, 97000);
    assert.equal(row.sellerApprovedAmount, 97000);
    assert.equal(row.sellerAskedAt, null);
    assert.equal(row.messages.filter((message) => message.kind === "COUNTER" && message.authorId === deal.seller.id).length, 2);
    assert.equal(await mail(deal, deal.second.email, "Seller counter"), 2);
    // The first bid, which the desk asked about, is countered through the desk's question.
    assert.equal((await counterAnyBid({ inquiryId: first.id, sellerId: deal.seller.id, amount: 120000 })).error, null);
    const asked = await prisma.inquiry.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(asked.sellerCounterAmount, 120000);
    assert.ok(asked.sellerAnsweredAt);

    // Accepting a counter doesn't award. The desk awards it, and the other counter closes with the round.
    await prisma.offerMessage.create({ data: { inquiryId: second.id, authorId: deal.second.id, kind: "COUNTER", amount: 97000, body: "Accepted the seller's counter at $97,000." } });
    assert.equal(await prisma.closing.count({ where: { listingId: deal.listing.id } }), 0);
    const check = await checkAward(second.id);
    assert.equal(check.error === null && check.agreed, "approved");
    const award = await awardOffer(second.id, deal.desk.id, { backups: true });
    assert.equal(award.error, null);
    const backup = await prisma.inquiry.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(backup.status, "OPEN");
    assert.ok(backup.backupAskedAt);
    assert.equal(backup.sellerCounterAmount, null);
    assert.equal(backup.sellerCounteredAt, null);
    assert.equal(backup.sellerApprovedAmount, null);
    assert.equal(await mail(deal, deal.buyer.email, "Seller counter closed"), 1);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: third.id } })).sellerCounterAmount, null);
    assert.equal(await mail(deal, deal.third.email, "Seller counter closed"), 0);
  } finally {
    await cleanDeal(deal);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The bid summary and the track record.

test("the track record shows funds by band, the entity, the record and the year, and nothing that names the bidder", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const file = { status: "APPROVED", entityType: "LLC", proofAmount: 400000, proofExpiresAt: new Date("2027-01-01T00:00:00Z"), proofVerifiedAt: new Date("2026-10-01T00:00:00Z") };
  const input = {
    file,
    record: { closed: 3, canceled: 1 },
    strikes: 1,
    memberSince: new Date("2023-05-01T00:00:00Z"),
    // What a caller might carry along. None of it comes out.
    name: "Jane Hidden",
    email: "jane.hidden@example.org",
    companyName: "Hidden Capital LLC",
  };
  const record = trackRecord(input, now);
  assert.deepEqual(record, { funds: "verified $250k–$1M", entity: "Limited liability company", closed: 3, closeRate: "3 of 4 closed", strikes: 1, memberSince: 2023 });
  const shown = JSON.stringify(record) + trackLine(record);
  for (const secret of ["Jane", "Hidden", "jane.hidden", "400000", "400,000", "400k"]) assert.ok(!shown.includes(secret), secret);
  assert.equal(trackLine(record), "Verified $250k–$1M · Limited liability company · 3 closed on UPB · 3 of 4 closed · 1 strike · member since 2023");
  // Under five closes the rate is its counts, never a percentage. From five it is the percentage.
  assert.equal(trackRecord({ ...input, record: { closed: 4, canceled: 1 } }, now).closeRate, "4 of 5 closed");
  const seasoned = trackRecord({ ...input, record: { closed: 6, canceled: 2 } }, now);
  assert.equal(seasoned.closeRate, "75%");
  assert.match(trackLine(seasoned), / · 6 closed on UPB · 75% close rate · /);
  // The entity the bid is for wins over the main file.
  assert.equal(trackRecord({ ...input, entityType: "IRA" }, now).entity, "Self-directed IRA");
  assert.equal(trackRecord({ ...input, record: { closed: 0, canceled: 0 }, strikes: 0 }, now).closeRate, "no closings yet");
  // Bands, and funds the desk hasn't verified or that lapsed.
  assert.equal(fundsBand({ ...file, proofAmount: 99999 }, now), "verified under $100k");
  assert.equal(fundsBand({ ...file, proofAmount: 100000 }, now), "verified $100k–$250k");
  assert.equal(fundsBand({ ...file, proofAmount: 1_000_000 }, now), "verified $1M–$5M");
  assert.equal(fundsBand({ ...file, proofAmount: 5_000_000 }, now), "verified over $5M");
  assert.equal(fundsBand({ ...file, proofExpiresAt: new Date("2026-11-01T00:00:00Z") }, now), "funds proof expired");
  assert.equal(fundsBand({ ...file, status: "SUBMITTED" }, now), "funds not verified");
  assert.equal(fundsBand({ ...file, proofVerifiedAt: null }, now), "funds not verified");
  assert.equal(fundsBand(null, now), "funds not verified");
});

test("the bid summary has its columns, keeps the sealed wall, and opens to the seller, a broker and the desk only", async () => {
  const deal = await makeDeal({ reservePrice: 150000 });
  try {
    await prisma.buyerProfile.create({
      data: { userId: deal.buyer.id, status: "APPROVED", entityType: "LLC", entityName: `Hidden Capital ${deal.tag}`, proofAmount: 400000, proofVerifiedAt: new Date(), proofExpiresAt: new Date(Date.now() + 30 * DAY) },
    });
    const [loanA, loanB] = deal.listing.notes;
    const whole = await bid(deal, deal.buyer.id, 180000, { loanPrices: { [loanA.id]: 100000, [loanB.id]: 80000 }, allowPartial: true, expiresAt: new Date("2026-12-31T23:59:00Z") });
    await bid(deal, deal.second.id, 70000, { noteId: loanB.id });

    // Buyers, other sellers and desk staff outside sales are refused.
    assert.equal((await bidSummary(deal.listing.id, deal.buyer)).status, 403);
    assert.equal((await bidSummary(deal.listing.id, deal.second)).status, 403);
    assert.equal((await bidSummary(deal.listing.id, deal.other)).status, 403);
    assert.equal((await bidSummary(deal.listing.id, deal.trader)).status, 403);
    assert.equal((await bidSummary("000000000000000000000000", deal.seller)).status, 404);
    assert.equal((await bidSummary(deal.listing.id, deal.broker)).status, 200);
    assert.equal((await bidSummary(deal.listing.id, deal.desk)).status, 200);

    const open = await bidSummary(deal.listing.id, deal.seller);
    assert.equal(open.status, 200);
    if (open.status !== 200) return;
    assert.equal(open.sealed, false);
    assert.deepEqual(Object.keys(open.rows[0]), [...BID_SUMMARY_COLUMNS]);
    const csv = bidSummaryCsv(open);
    assert.equal(csv.split("\n")[0], BID_SUMMARY_COLUMNS.join(","));
    const top = open.rows[0];
    assert.equal(top.bidder, "Bidder A");
    assert.equal(top.scope, "Whole listing");
    assert.equal(top.price, "180000.00");
    assert.equal(top.pct_of_upb, "90.00");
    assert.equal(top.loan_prices, "Loan 1 100000.00; Loan 2 80000.00");
    assert.equal(top.good_until, "2026-12-31");
    assert.equal(top.status, "Open");
    assert.equal(top.reserve_met, "Yes");
    assert.equal(top.verified_funds, "verified $250k–$1M");
    assert.equal(top.entity, "Limited liability company");
    assert.equal(top.member_since, "2023");
    assert.equal(top.close_rate, "no closings yet");
    const loanRow = open.rows[1];
    assert.equal(loanRow.scope, "Loan 2 in Tampa, FL");
    assert.equal(loanRow.pct_of_upb, "70.00");
    assert.equal(loanRow.reserve_met, "No");
    assert.equal(loanRow.verified_funds, "funds not verified");
    // No name, email, company or funds figure before an award.
    for (const secret of [deal.buyer.name, deal.buyer.email, "Acme Notes", "Hidden Capital", "400000"]) assert.ok(!csv.includes(secret), secret);
    const pdf = await PDFDocument.load(await bidSummaryPdf(open));
    assert.ok(pdf.getPageCount() >= 1);

    // While a sealed round runs, the seller's copy carries no amount and nothing priced from one.
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { bidMode: "SEALED", bidDeadline: new Date(Date.now() + DAY) } });
    const sealed = await bidSummary(deal.listing.id, deal.seller);
    assert.equal(sealed.status === 200 && sealed.sealed, true);
    if (sealed.status !== 200) return;
    for (const row of sealed.rows) {
      assert.equal(row.price, "Sealed until the deadline");
      assert.equal(row.pct_of_upb, "");
      assert.equal(row.loan_prices, "");
      assert.equal(row.reserve_met, "");
    }
    const sealedCsv = bidSummaryCsv(sealed);
    for (const figure of ["180000", "100000", "70000", "90.00"]) assert.ok(!sealedCsv.includes(figure), figure);
    // In the order the bids came in, not by price.
    assert.deepEqual(sealed.rows.map((row) => row.scope), ["Whole listing", "Loan 2 in Tampa, FL"]);
    assert.ok(whole.id);
  } finally {
    await prisma.buyerProfile.deleteMany({ where: { userId: deal.buyer.id } });
    await cleanDeal(deal);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Who pays the fees.

// A schedule whose minimums set both fees on a $40,000 sale: 3% is $1,200 against a $1,500 minimum, 2% is $800
// against a $1,000 minimum.
const SCHEDULE: FeeSchedule = {
  tiers: [
    { upTo: 100000, premiumBps: 300, commissionBps: 200 },
    { upTo: null, premiumBps: 200, commissionBps: 100 },
  ],
  minPremiumCents: 150000,
  minCommissionCents: 100000,
};

test("each payer moves the same fees, on the same tiers and minimums, and a split charges as it always did", () => {
  const graded = { schedule: SCHEDULE, premiumBps: 250, commissionBps: 300 };
  const split = chargeFees(graded, 40000);
  assert.deepEqual([split.premiumCents, split.commissionCents, split.buyerTotalCents, split.netToSellerCents], [150000, 100000, 4150000, 3900000]);
  assert.equal("payer" in split, false);
  const seller = chargeFees({ ...graded, payer: "SELLER" }, 40000);
  assert.deepEqual([seller.premiumCents, seller.commissionCents, seller.buyerTotalCents, seller.netToSellerCents], [0, 250000, 4000000, 3750000]);
  assert.equal(seller.commissionFloor, true);
  const buyer = chargeFees({ ...graded, payer: "BUYER" }, 40000);
  assert.deepEqual([buyer.premiumCents, buyer.commissionCents, buyer.buyerTotalCents, buyer.netToSellerCents], [250000, 0, 4250000, 4000000]);
  // Above the minimums, on the second tier: 2% and 1% of $500,000.
  const large = chargeFees({ ...graded, payer: "SELLER" }, 500000);
  assert.deepEqual([large.premiumCents, large.commissionCents, large.commissionBps], [0, 1500000, 300]);
  // Never more than the price, even when both minimums together pass it.
  const tiny = chargeFees({ ...graded, payer: "BUYER" }, 2000);
  assert.deepEqual([tiny.premiumCents, tiny.buyerTotalCents, tiny.netToSellerCents], [200000, 400000, 200000]);

  // Flat terms, byte for byte as before for a split.
  assert.deepEqual(chargeFees(flatTerms(250, 300), 100000), {
    saleCents: 10000000, premiumCents: 250000, commissionCents: 300000, buyerTotalCents: 10250000, netToSellerCents: 9700000,
    premiumBps: 250, commissionBps: 300, graded: false, premiumFloor: false, commissionFloor: false,
  });
  const flatSeller = chargeFees({ ...flatTerms(250, 300), payer: "SELLER" }, 100000);
  assert.deepEqual([flatSeller.premiumCents, flatSeller.commissionCents, flatSeller.netToSellerCents, flatSeller.commissionBps], [0, 550000, 9450000, 550]);
  // The desk buying for its book never pays itself: with BUYER there is no fee at all, with SELLER only the commission.
  assert.deepEqual([chargeFees({ ...flatTerms(250, 300), payer: "BUYER" }, 100000, { deskPurchase: true, chargeDeskFees: true }).buyerTotalCents, chargeFees({ ...flatTerms(250, 300), payer: "BUYER" }, 100000, { deskPurchase: true, chargeDeskFees: true }).netToSellerCents], [10000000, 10000000]);
  assert.equal(chargeFees({ ...flatTerms(250, 300), payer: "SELLER" }, 100000, { deskPurchase: true, chargeDeskFees: true }).commissionCents, 300000);

  // The listing's choice comes through its terms, and a listing without one reads as before.
  const settings = { buyerPremiumBps: 250, sellerCommissionBps: 300 };
  assert.deepEqual(feeTerms({}, settings), { schedule: null, premiumBps: 250, commissionBps: 300 });
  assert.deepEqual(feeTerms({ feePayer: "SPLIT" }, settings), { schedule: null, premiumBps: 250, commissionBps: 300 });
  assert.equal(feeTerms({ feePayer: "BUYER" }, settings).payer, "BUYER");
  assert.equal(feeTerms({ feePayer: "nonsense" }, settings).payer, undefined);
  assert.equal(feesFor({ feePayer: "BUYER" }, settings, 100000).premiumCents, 550000);

  // The words a bidder reads before they bid.
  assert.equal(payerText(flatTerms(250, 300)), "A buyer premium of 2.50% is added to an accepted price. It is not part of your bid.");
  assert.match(payerText({ ...flatTerms(250, 300), payer: "SELLER" }), /The seller pays UPB's fees on this listing, so nothing is added/);
  assert.match(payerText({ ...flatTerms(250, 300), payer: "BUYER" }), /a premium of 5\.50%/);
  assert.equal(rateText({ ...graded, payer: "SELLER" }, "premium"), "0.00%");
  assert.equal(rateText({ ...graded, payer: "SELLER" }, "commission"), "3.00% to 5.00% by sale size, at least $2,500");
  assert.equal(rateText(graded, "commission"), "1.00% to 2.00% by sale size, at least $1,000");
});

test("who pays locks at go-live, and the closing's cents follow it for all three payers, minimums included", async () => {
  const deal = await makeDeal({ status: "UNDER_REVIEW", approvedAt: null });
  const extra: string[] = [];
  try {
    // Before go-live the seller picks; nobody else can, and a bad choice is refused.
    assert.equal(feePayerBlock("UNDER_REVIEW"), null);
    assert.match(feePayerBlock("APPROVED") ?? "", /fixed when the listing went live/);
    assert.equal((await setFeePayer({ listingId: deal.listing.id, actorId: deal.buyer.id, payer: "SELLER" })).error, "That listing isn't yours.");
    assert.match((await setFeePayer({ listingId: deal.listing.id, actorId: deal.seller.id, payer: "EVERYONE" })).error ?? "", /Choose who pays/);
    assert.equal((await setFeePayer({ listingId: deal.listing.id, actorId: deal.seller.id, payer: "SELLER" })).error, null);
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: deal.listing.id } })).feePayer, "SELLER");
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { status: "APPROVED", approvedAt: new Date() } });
    assert.match((await setFeePayer({ listingId: deal.listing.id, actorId: deal.seller.id, payer: "BUYER" })).error ?? "", /fixed when the listing went live/);
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: deal.listing.id } })).feePayer, "SELLER");

    // Three live listings with the same snapshot, one per payer, each closing a $40,000 sale.
    const expected = { SPLIT: [150000, 100000, 4150000, 3900000], SELLER: [0, 250000, 4000000, 3750000], BUYER: [250000, 0, 4250000, 4000000] } as const;
    for (const payer of ["SPLIT", "SELLER", "BUYER"] as const) {
      const listing = await prisma.listing.create({
        data: {
          kind: "SINGLE",
          sellerId: deal.seller.id,
          status: "APPROVED",
          approvedAt: new Date(),
          title: `Seller decisions ${deal.tag} ${payer}`,
          feeBuyerPremiumBps: 250,
          feeSellerCommissionBps: 300,
          feeSchedule: SCHEDULE,
          ...(payer === "SPLIT" ? {} : { feePayer: payer }),
          notes: { create: [note("9 Ninth St")] as never },
        },
      });
      extra.push(listing.id);
      const offer = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 40000 } });
      const closing = await openClosing({ listingId: listing.id, inquiryId: offer.id, noteId: null, salePrice: 40000, title: listing.title });
      assert.deepEqual([closing.buyerPremiumCents, closing.sellerCommissionCents, closing.buyerTotalCents, closing.netToSellerCents], [...expected[payer]], payer);
    }
  } finally {
    await cleanDeal(deal, extra);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// A duplicate or a relist carries the seller's terms as defaults.

test("a duplicate or relist starts with the source's fee payer and window, and the seller can still change both", async () => {
  // A split and a missing or out-of-range window stay off, so they read as the defaults, as before.
  assert.deepEqual(carriedSellerTerms({}), {});
  assert.deepEqual(carriedSellerTerms({ feePayer: "SPLIT", sellerResponseHours: 5 }), {});
  assert.deepEqual(carriedSellerTerms({ feePayer: "BUYER", sellerResponseHours: 36 }), { feePayer: "BUYER", sellerResponseHours: 36 });
  assert.equal(sellerTermsLine({ status: "APPROVED", feePayer: "SELLER", sellerResponseHours: 36 }), "UPB's fees: the seller pays both, fixed at go-live · the seller answers an ask within 36 hours");
  assert.equal(sellerTermsLine({ status: "SUBMITTED" }), "UPB's fees: split, the seller can change it until go-live · the seller answers an ask within 72 hours, the default");

  const deal = await makeDeal({ feePayer: "BUYER", sellerResponseHours: 36 });
  const extra: string[] = [];
  try {
    // The copy is written the way actions/desk.ts duplicateListing and actions/assets.ts relistFrom write it.
    const copy = await prisma.listing.create({
      data: { kind: "POOL", sellerId: deal.seller.id, status: "SUBMITTED", title: `Copy of ${deal.listing.title}`, ...carriedSellerTerms(deal.listing) },
    });
    extra.push(copy.id);
    assert.equal(copy.feePayer, "BUYER");
    assert.equal(copy.sellerResponseHours, 36);
    assert.equal(feeTerms(copy, { buyerPremiumBps: 250, sellerCommissionBps: 300 }).payer, "BUYER");
    // Before go-live the seller changes both.
    assert.equal((await setFeePayer({ listingId: copy.id, actorId: deal.seller.id, payer: "SPLIT" })).error, null);
    assert.equal((await setResponseWindow({ listingId: copy.id, actorId: deal.seller.id, hours: "96" })).error, null);
    const changed = await prisma.listing.findUniqueOrThrow({ where: { id: copy.id } });
    assert.equal(changed.feePayer, "SPLIT");
    assert.equal(changed.sellerResponseHours, 96);
    // The source keeps its own.
    const source = await prisma.listing.findUniqueOrThrow({ where: { id: deal.listing.id } });
    assert.deepEqual([source.feePayer, source.sellerResponseHours], ["BUYER", 36]);
  } finally {
    await cleanDeal(deal, extra);
  }
});
