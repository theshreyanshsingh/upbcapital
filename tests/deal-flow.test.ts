import assert from "node:assert/strict";
import test from "node:test";
import { listingActivity, sellerReport } from "../lib/activity";
import { buyerRecords, fundsCoverage, proofExpiry, rankBids, type BidInput } from "../lib/bid-sheet";
import { closingSchedule, closingStats, effectiveDue, stepClock, stepNeedsReminder, targetDays } from "../lib/closing-clock";
import { cancelOpenClosing, openClosing, tradeConflict } from "../lib/closing-service";
import { deskSearch, searchTerm } from "../lib/desk-search";
import { unset } from "../lib/db-filters";
import { awardOffer, claimLoan, declineLosingBids } from "../lib/awards";
import { dealAccess } from "../lib/data-room";
import { remindClosingSteps, remindSaleNotices } from "../lib/jobs";
import { recentlySent, sendBody, sendFunnel, sendListing } from "../lib/outreach";
import { prisma } from "../lib/prisma";
import { statementLines, variance } from "../lib/settlement";

// An award sends the purchase agreement for signature, so its PDF stays on disk and signing stays in the app,
// whatever storage or signing keys the local .env carries.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

test("a closing runs 3, 6, 15, 21, 27, and 30 days at the default target", () => {
  const opened = at("2026-11-01");
  const { targetCloseAt, due } = closingSchedule(opened, 30);
  const offsets = Object.values(due).map((date) => Math.round((date.getTime() - opened.getTime()) / DAY));
  assert.deepEqual(offsets, [3, 6, 15, 21, 27, 30]);
  assert.equal(Math.round((targetCloseAt.getTime() - opened.getTime()) / DAY), 30);
  assert.equal(targetDays(null), 30);
  assert.equal(targetDays(2), 30);
  assert.equal(targetDays(45), 45);
});

test("a step's own date wins, and an undated step follows the closing's target", () => {
  const closing = { openedAt: at("2026-11-01"), targetCloseAt: at("2026-11-21") };
  assert.equal(effectiveDue({ key: "BUYER_DEPOSIT", status: "PENDING", dueAt: at("2026-11-04") }, closing, 30)?.toISOString(), at("2026-11-04").toISOString());
  assert.equal(effectiveDue({ key: "CLOSED", status: "PENDING", dueAt: null }, closing, 30)?.toISOString(), at("2026-11-21").toISOString());
  const legacy = { openedAt: at("2026-11-01"), targetCloseAt: null };
  assert.equal(effectiveDue({ key: "COLLATERAL_TRANSFER", status: "PENDING", dueAt: null }, legacy, 30)?.toISOString(), at("2026-11-16").toISOString());
});

test("reminders start two days out, repeat daily while late, and stop when the step is done", () => {
  const due = at("2026-11-10");
  assert.equal(stepClock("PENDING", due, at("2026-11-05")), "on_track");
  assert.equal(stepClock("PENDING", due, at("2026-11-09")), "due_soon");
  assert.equal(stepClock("PENDING", due, at("2026-11-11")), "overdue");
  assert.equal(stepClock("COMPLETE", due, at("2026-11-11")), "done");
  assert.equal(stepNeedsReminder({ status: "PENDING", remindedAt: null }, due, at("2026-11-05")), false);
  assert.equal(stepNeedsReminder({ status: "PENDING", remindedAt: null }, due, at("2026-11-09")), true);
  assert.equal(stepNeedsReminder({ status: "PENDING", remindedAt: new Date(at("2026-11-11").getTime() - 2 * 60 * 60 * 1000) }, due, at("2026-11-11")), false);
  assert.equal(stepNeedsReminder({ status: "PENDING", remindedAt: at("2026-11-10") }, due, at("2026-11-11")), true);
  assert.equal(stepNeedsReminder({ status: "COMPLETE", remindedAt: null }, due, at("2026-11-11")), false);
});

test("close rate counts only finished files, and days to close averages the closed ones", () => {
  const stats = closingStats([
    { status: "COMPLETE", openedAt: at("2026-10-01"), closedAt: at("2026-10-21") },
    { status: "COMPLETE", openedAt: at("2026-10-01"), closedAt: at("2026-10-31") },
    { status: "CANCELED", openedAt: at("2026-10-01"), closedAt: null },
    { status: "OPEN", openedAt: at("2026-10-01"), closedAt: null },
  ]);
  assert.equal(stats.complete, 2);
  assert.equal(stats.canceled, 1);
  assert.equal(Math.round((stats.closeRate ?? 0) * 100), 67);
  assert.equal(stats.averageDays, 25);
  assert.equal(closingStats([]).closeRate, null);
});

test("funds coverage compares the all-in with the verified amount and its expiry", () => {
  const now = at("2026-11-02");
  const proof = { amount: 100000, expiresAt: at("2026-12-01"), verifiedAt: at("2026-10-01") };
  assert.equal(fundsCoverage(90000, proof, now), "covered");
  assert.equal(fundsCoverage(100001, proof, now), "short");
  assert.equal(fundsCoverage(50000, { ...proof, expiresAt: at("2026-11-01") }, now), "expired");
  assert.equal(fundsCoverage(50000, { amount: null, expiresAt: null, verifiedAt: null }, now), "unstated");
  assert.equal(proofExpiry("", at("2026-11-01")).toISOString().slice(0, 10), "2027-01-30");
  assert.equal(proofExpiry("2026-12-15", at("2026-11-01")).toISOString().slice(0, 10), "2026-12-15");
});

test("the bid sheet ranks by price and says why a lower bid may close better", () => {
  const base: Omit<BidInput, "inquiryId" | "buyerId" | "buyerName" | "amount"> = {
    status: "OPEN",
    createdAt: at("2026-11-01"),
    noteLabel: null,
    ask: 100000,
    upb: 125000,
    fileStatus: "APPROVED",
    proof: { amount: 200000, expiresAt: at("2027-01-01"), verifiedAt: at("2026-10-01") },
    record: { closed: 2, canceled: 0 },
    ofacHold: false,
  };
  const rows = rankBids([
    { ...base, inquiryId: "a", buyerId: "1", buyerName: "Thin funds", amount: 95000, proof: { amount: 90000, expiresAt: null, verifiedAt: at("2026-10-01") } },
    { ...base, inquiryId: "b", buyerId: "2", buyerName: "Solid", amount: 90000 },
    { ...base, inquiryId: "c", buyerId: "3", buyerName: "Walked before", amount: 88000, record: { closed: 0, canceled: 1 } },
  ], 250, at("2026-11-02"));
  assert.deepEqual(rows.map((row) => row.buyerName), ["Thin funds", "Solid", "Walked before"]);
  assert.deepEqual(rows.map((row) => row.rank), [1, 2, 3]);
  assert.equal(rows[0].strength, "weak");
  assert.ok(rows[0].flags.includes("All-in is above verified funds"));
  assert.equal(rows[0].allIn, 97375);
  assert.equal(rows[1].strength, "strong");
  assert.equal(Math.round(rows[1].ofAsk ?? 0), 90);
  assert.equal(Math.round(rows[1].ofUpb ?? 0), 72);
  assert.equal(rows[2].strength, "watch");
  assert.ok(rows[2].flags.includes("1 canceled closing"));
});

test("a desk send never repeats inside its window and carries no address or borrower", () => {
  const now = at("2026-11-10");
  const sends = [{ userId: "u", kind: "LISTING", createdAt: at("2026-11-05") }, { userId: "u", kind: "DEADLINE", createdAt: at("2026-11-08") }];
  assert.equal(recentlySent(sends, "u", "LISTING", now), true);
  assert.equal(recentlySent(sends, "u", "LISTING", at("2026-11-13")), false);
  assert.equal(recentlySent(sends, "u", "DEADLINE", now), false);
  assert.equal(recentlySent(sends, "v", "LISTING", now), false);
  const body = sendBody({ kind: "DEADLINE", title: "Miami first", loans: 3, states: ["FL", "GA"], bidMode: "SEALED", deadline: at("2026-11-20"), note: "Clean pay history", link: "https://upbcapital.com/marketplace/x" });
  assert.match(body, /close 2026-11-20 12:00 UTC, sealed/);
  assert.match(body, /3 loans in FL, GA/);
  assert.match(body, /From the desk: Clean pay history/);
  assert.match(body, /Turn off desk picks/);
});

test("the send funnel counts only what buyers did after the desk reached them", () => {
  const funnel = sendFunnel(
    [{ userId: "a", createdAt: at("2026-11-05") }, { userId: "b", createdAt: at("2026-11-05") }, { userId: "a", createdAt: at("2026-11-07") }],
    [{ userId: "a", createdAt: at("2026-11-04") }, { userId: "b", createdAt: at("2026-11-06") }, { userId: "c", createdAt: at("2026-11-06") }],
    [{ buyerId: "a", createdAt: at("2026-11-06") }],
  );
  assert.deepEqual(funnel, { reached: 2, viewed: 1, offered: 1 });
});

test("settlement checks wires against the expected totals and shows each side only its own", () => {
  assert.deepEqual(variance(100000, null), { state: "none", diffCents: 0 });
  assert.equal(variance(100000, 100050).state, "match");
  assert.deepEqual(variance(100000, 90000), { state: "short", diffCents: -10000 });
  assert.equal(variance(100000, 110000).state, "over");
  const closing = {
    id: "c1", salePrice: 80000, buyerPremiumCents: 200000, sellerCommissionCents: 240000, buyerTotalCents: 8200000, netToSellerCents: 7760000,
    openedAt: at("2026-11-01"), closedAt: null, status: "OPEN",
    fundsReceivedCents: 8200000, fundsReceivedAt: at("2026-11-20"), fundsReference: "FED123", proceedsSentCents: null, proceedsSentAt: null, proceedsReference: null,
  };
  assert.deepEqual(statementLines(closing, "buyer").map((section) => section.heading), ["Buyer"]);
  assert.deepEqual(statementLines(closing, "seller").map((section) => section.heading), ["Seller"]);
  const desk = statementLines(closing, "desk", 50000);
  assert.deepEqual(desk.map((section) => section.heading), ["Buyer", "Seller", "Desk"]);
  assert.equal(desk[2].lines.at(-1)?.cents, 200000 + 240000 - 50000);
  assert.match(statementLines(closing, "buyer")[0].lines[3].detail ?? "", /2026-11-20 · FED123/);
});

test("desk search ignores short terms and trims long ones", () => {
  assert.equal(searchTerm("  jane   doe "), "jane doe");
  assert.equal(searchTerm("x".repeat(200)).length, 80);
});

async function makeDeal(tag: string, opts: { status?: "APPROVED" | "UNDER_REVIEW" } = {}) {
  const seller = await prisma.user.create({ data: { email: `deal-seller-${tag}@example.org`, name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const buyer = await prisma.user.create({ data: { email: `deal-buyer-${tag}@example.org`, name: `Buyer ${tag}`, companyName: `Fund ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  const quiet = await prisma.user.create({ data: { email: `deal-quiet-${tag}@example.org`, name: `Quiet ${tag}`, role: "BUYER", accountStatus: "APPROVED", dealAlerts: false, passwordHash: "x" } });
  const waiting = await prisma.user.create({ data: { email: `deal-waiting-${tag}@example.org`, name: `Waiting ${tag}`, role: "BUYER", accountStatus: "PENDING", passwordHash: "x" } });
  const desk = await prisma.user.create({ data: { email: `deal-desk-${tag}@upbcapital.test`, name: `Desk ${tag}`, role: "ADMIN", accountStatus: "APPROVED", passwordHash: "x" } });
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: opts.status ?? "APPROVED",
      approvedAt: new Date(),
      title: `Deal flow ${tag}`,
      notes: {
        create: [{
          streetAddress: "9 Hidden Ln", city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 80000, estimatedValue: 150000, borrowerName: `Borrower ${tag}`,
        }] as never,
      },
    },
  });
  for (const user of [buyer, quiet, waiting]) {
    const box = await prisma.buyBox.create({ data: { userId: user.id, name: `Box ${tag}`, states: "FL" } });
    await prisma.listingMatch.create({ data: { listingId: listing.id, buyBoxId: box.id, userId: user.id, score: user.id === buyer.id ? 90 : 70 } });
  }
  return { seller, buyer, quiet, waiting, desk, listing, users: [seller, buyer, quiet, waiting, desk] };
}

async function cleanDeal(deal: Awaited<ReturnType<typeof makeDeal>>) {
  await prisma.listing.deleteMany({ where: { id: deal.listing.id } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: deal.users.map((user) => user.email) } }, { subject: { contains: deal.listing.title } }] } });
  await prisma.user.deleteMany({ where: { id: { in: deal.users.map((user) => user.id) } } });
}

test("sending a listing reaches only approved, opted-in matches, once a week", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const everyone = [deal.buyer.id, deal.quiet.id, deal.waiting.id, deal.seller.id];
    const first = await sendListing({ listingId: deal.listing.id, userIds: everyone, kind: "LISTING", note: "", actorId: deal.desk.id });
    assert.deepEqual({ sent: first.sent, skipped: first.skipped, problem: first.problem }, { sent: 1, skipped: 3, problem: "" });
    const mail = await prisma.notification.findFirstOrThrow({ where: { toEmail: deal.buyer.email } });
    assert.match(mail.subject, /^Desk pick · /);
    assert.doesNotMatch(mail.body, /Hidden Ln|Borrower /);
    const again = await sendListing({ listingId: deal.listing.id, userIds: [deal.buyer.id], kind: "LISTING", note: "", actorId: deal.desk.id });
    assert.equal(again.sent, 0);
    assert.equal(await prisma.listingSend.count({ where: { listingId: deal.listing.id } }), 1);
    const deadline = await sendListing({ listingId: deal.listing.id, userIds: [deal.buyer.id], kind: "DEADLINE", note: "", actorId: deal.desk.id });
    assert.match(deadline.problem, /future bid deadline/);
  } finally {
    await cleanDeal(deal);
  }
});

test("an unapproved listing never goes out to buyers", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8), { status: "UNDER_REVIEW" });
  try {
    const result = await sendListing({ listingId: deal.listing.id, userIds: [deal.buyer.id], kind: "LISTING", note: "", actorId: deal.desk.id });
    assert.match(result.problem, /live listing/);
    assert.equal(await prisma.notification.count({ where: { toEmail: deal.buyer.email } }), 0);
  } finally {
    await cleanDeal(deal);
  }
});

test("activity leaves out desk and seller opens, and the seller sees counts only", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    await prisma.listingView.createMany({
      data: [
        { listingId: deal.listing.id, userId: deal.buyer.id },
        { listingId: deal.listing.id, userId: deal.buyer.id },
        { listingId: deal.listing.id, userId: deal.desk.id },
        { listingId: deal.listing.id, userId: deal.seller.id },
      ],
    });
    await prisma.ndaAcknowledgment.create({ data: { userId: deal.buyer.id, listingId: deal.listing.id, signerName: "Buyer Signer", ipAddress: "203.0.113.9" } });
    await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", amount: 75000 } });
    const activity = await listingActivity(deal.listing.id, deal.seller.id);
    assert.equal(activity.views, 2);
    assert.deepEqual(activity.viewers.map((row) => [row.user.id, row.count]), [[deal.buyer.id, 2]]);
    assert.equal(activity.ndas[0].ipAddress, "203.0.113.9");
    assert.equal(activity.bidders, 1);
    assert.equal(activity.matchedBuyers, 3);
    const report = sellerReport(activity);
    assert.equal(report.find((row) => row.label === "Buyers who opened it")?.value, 1);
    assert.ok(report.every((row) => typeof row.value === "number"));
  } finally {
    await cleanDeal(deal);
  }
});

test("a new closing is dated, and the reminder job tells each side once a day", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const inquiry = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 80000 } });
    const closing = await openClosing({ listingId: deal.listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 80000, title: deal.listing.title });
    const steps = await prisma.closingStep.findMany({ where: { closingId: closing.id } });
    assert.ok(closing.targetCloseAt);
    assert.ok(steps.every((step) => step.dueAt));
    const deposit = steps.find((step) => step.key === "BUYER_DEPOSIT")!;
    const transfer = steps.find((step) => step.key === "COLLATERAL_TRANSFER")!;
    // Push the deposit into the past and the transfer far out, so only the buyer's step is late.
    await prisma.closingStep.update({ where: { id: deposit.id }, data: { dueAt: new Date(Date.now() - DAY) } });
    await prisma.closingStep.updateMany({ where: { closingId: closing.id, id: { not: deposit.id } }, data: { dueAt: new Date(Date.now() + 20 * DAY) } });
    const before = await prisma.notification.count({ where: { toEmail: deal.buyer.email } });
    await remindClosingSteps(new Date(), { closingIds: [closing.id] });
    const buyerMail = await prisma.notification.findMany({ where: { toEmail: deal.buyer.email, subject: { startsWith: "Closing dates" } } });
    assert.equal(buyerMail.length, 1);
    assert.match(buyerMail[0].body, /Buyer deposit: late, was due/);
    assert.equal(await prisma.notification.count({ where: { toEmail: deal.seller.email, subject: { startsWith: "Closing dates" } } }), 0);
    assert.ok((await prisma.closingStep.findUniqueOrThrow({ where: { id: deposit.id } })).remindedAt);
    assert.equal((await prisma.closingStep.findUniqueOrThrow({ where: { id: transfer.id } })).remindedAt, null);
    await remindClosingSteps(new Date(), { closingIds: [closing.id] });
    assert.equal(await prisma.notification.count({ where: { toEmail: deal.buyer.email } }), before + 1);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: deal.listing.id } });
    await cleanDeal(deal);
  }
});

test("a loan or listing already in contract can't be awarded a second time", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const listingId = deal.listing.id;
    const note = await prisma.note.findFirstOrThrow({ where: { listingId } });
    assert.equal(await tradeConflict(listingId, null), null);
    assert.equal(await tradeConflict(listingId, note.id), null);

    const first = await prisma.inquiry.create({ data: { listingId, buyerId: deal.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 80000 } });
    const whole = await openClosing({ listingId, inquiryId: first.id, noteId: null, salePrice: 80000, title: deal.listing.title });
    assert.match((await tradeConflict(listingId, null)) ?? "", /already has an open closing/);
    assert.match((await tradeConflict(listingId, note.id)) ?? "", /already covers that loan/);

    await cancelOpenClosing(whole.id, "Test cancel");
    assert.equal(await tradeConflict(listingId, null), null);

    await prisma.note.update({ where: { id: note.id }, data: { tradeStatus: "IN_CONTRACT" } });
    assert.match((await tradeConflict(listingId, note.id)) ?? "", /already in contract/);
    assert.match((await tradeConflict(listingId, null)) ?? "", /in contract or sold/);

    await prisma.listing.update({ where: { id: listingId }, data: { status: "SOLD" } });
    assert.match((await tradeConflict(listingId, null)) ?? "", /already sold/);
    assert.equal(await tradeConflict("000000000000000000000000", null), "That listing no longer exists.");
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: deal.listing.id } });
    await cleanDeal(deal);
  }
});

test("the buyer hears about the sale notice five days out and again once it's late, never after it's sent", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const inquiry = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 80000 } });
    const closing = await openClosing({ listingId: deal.listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 80000, title: deal.listing.title });
    await prisma.note.updateMany({ where: { listingId: deal.listing.id }, data: { occupancy: "OWNER_OCCUPIED" } });
    await prisma.closing.update({ where: { id: closing.id }, data: { status: "COMPLETE", closedAt: new Date(Date.now() - 27 * DAY) } });
    const mail = () => prisma.notification.count({ where: { toEmail: deal.buyer.email, subject: { startsWith: "Sale notice" } } });
    await remindSaleNotices();
    assert.equal(await mail(), 1);
    await remindSaleNotices();
    assert.equal(await mail(), 1);
    // Move the close back so the notice is late. The first reminder came before the due date, so one more goes.
    await prisma.closing.update({ where: { id: closing.id }, data: { closedAt: new Date(Date.now() - 32 * DAY), ownerNoticeRemindedAt: new Date(Date.now() - 4 * DAY) } });
    await remindSaleNotices();
    assert.equal(await mail(), 2);
    await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeRemindedAt: null, ownerNoticeSentAt: new Date() } });
    await remindSaleNotices();
    assert.equal(await mail(), 2);
    // A business-purpose loan needs no notice at all.
    await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeSentAt: null, loanPurpose: "BUSINESS" } });
    await remindSaleNotices();
    assert.equal(await mail(), 2);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: deal.listing.id } });
    await cleanDeal(deal);
  }
});

test("a buyer's record counts closed and canceled wins, not open ones", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const statuses = ["COMPLETE", "CANCELED", "OPEN"] as const;
    for (const status of statuses) {
      const inquiry = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 1 } });
      await prisma.closing.create({ data: { listingId: deal.listing.id, inquiryId: inquiry.id, status, salePrice: 1, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 100, netToSellerCents: 100 } });
    }
    assert.deepEqual((await buyerRecords([deal.buyer.id])).get(deal.buyer.id), { closed: 1, canceled: 1 });
  } finally {
    await cleanDeal(deal);
  }
});

test("desk search finds accounts, listings, and borrowers without regard to case", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const deal = await makeDeal(tag);
  try {
    const byEmail = await deskSearch(`DEAL-BUYER-${tag.toUpperCase()}`);
    assert.ok(byEmail?.users.some((user) => user.id === deal.buyer.id));
    assert.ok((await deskSearch(`deal flow ${tag}`))?.listings.some((listing) => listing.id === deal.listing.id));
    assert.ok((await deskSearch(`borrower ${tag}`))?.borrowerNotes.some((note) => note.listingId === deal.listing.id));
    assert.ok((await deskSearch(deal.listing.id))?.listings.some((listing) => listing.id === deal.listing.id));
    assert.equal(await deskSearch("x"), null);
  } finally {
    await cleanDeal(deal);
  }
});

test("a field nothing has written yet counts as empty, which a plain null filter misses on MongoDB", async () => {
  const toEmail = `unset-${crypto.randomUUID().slice(0, 8)}@example.org`;
  try {
    await prisma.notification.create({ data: { toEmail, subject: "Unread check", body: "x" } });
    assert.equal(await prisma.notification.count({ where: { toEmail, readAt: null } }), 0);
    assert.equal(await prisma.notification.count({ where: { toEmail, ...unset("readAt") } }), 1);
    await prisma.notification.updateMany({ where: { toEmail }, data: { readAt: new Date() } });
    assert.equal(await prisma.notification.count({ where: { toEmail, ...unset("readAt") } }), 0);
    await prisma.notification.updateMany({ where: { toEmail }, data: { readAt: null } });
    assert.equal(await prisma.notification.count({ where: { toEmail, ...unset("readAt") } }), 1);
  } finally {
    await prisma.notification.deleteMany({ where: { toEmail } });
  }
});

test("a one-loan sale out of a pool ends bids on that loan and on the whole pool, and only its buyer gets the loan", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const listingId = deal.listing.id;
    const first = await prisma.note.findFirstOrThrow({ where: { listingId } });
    const fields: Record<string, unknown> = { ...first, streetAddress: "2 Second St" };
    delete fields.id;
    delete fields.createdAt;
    const second = await prisma.note.create({ data: fields as never });
    await prisma.listing.update({ where: { id: listingId }, data: { kind: "POOL" } });
    const offer = (buyerId: string, noteId: string | null) => prisma.inquiry.create({ data: { listingId, buyerId, type: "OFFER", status: "OPEN", amount: 50000, ...(noteId ? { noteId } : {}) } });
    const sameLoan = await offer(deal.quiet.id, first.id);
    const wholePool = await offer(deal.quiet.id, null);
    const otherLoan = await offer(deal.quiet.id, second.id);

    // Two awards of the same loan at once: only one claim wins.
    assert.equal(await claimLoan(first.id), true);
    assert.equal(await claimLoan(first.id), false);
    const declined = await declineLosingBids({ id: null, listingId, noteId: first.id }, deal.listing.title);
    assert.equal(declined, 2);
    const status = async (id: string) => (await prisma.inquiry.findUniqueOrThrow({ where: { id } })).status;
    assert.equal(await status(sameLoan.id), "DECLINED");
    assert.equal(await status(wholePool.id), "DECLINED");
    assert.equal(await status(otherLoan.id), "OPEN");

    const won = await prisma.inquiry.create({ data: { listingId, buyerId: deal.buyer.id, type: "OFFER", status: "ACCEPTED", amount: 50000, noteId: first.id } });
    await openClosing({ listingId, inquiryId: won.id, noteId: first.id, salePrice: 50000, title: deal.listing.title });
    const buyer = await dealAccess(listingId, deal.buyer.id);
    assert.equal(buyer.whole, false);
    assert.deepEqual([...buyer.loans], [first.id]);
    const loser = await dealAccess(listingId, deal.quiet.id);
    assert.equal(loser.whole || loser.loans.size > 0, false);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: deal.listing.id } });
    await cleanDeal(deal);
  }
});

test("no award without the seller's word, and the award sets the buyer's deposit and its due date", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    const offer = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "OPEN", amount: 80000 } });
    const refused = await awardOffer(offer.id, deal.desk.id);
    assert.equal(refused.error, "The seller hasn't approved this price.");
    assert.equal(await prisma.closing.count({ where: { inquiryId: offer.id } }), 0);

    // An approval of a different amount doesn't count. The exact price does.
    await prisma.inquiry.update({ where: { id: offer.id }, data: { sellerApprovedAmount: 79000 } });
    assert.equal((await awardOffer(offer.id, deal.desk.id)).error, "The seller hasn't approved this price.");
    await prisma.inquiry.update({ where: { id: offer.id }, data: { sellerApprovedAmount: 80000 } });
    const awarded = await awardOffer(offer.id, deal.desk.id);
    assert.equal(awarded.error, null);
    const closing = await prisma.closing.findUniqueOrThrow({ where: { inquiryId: offer.id }, include: { steps: true } });
    assert.equal(closing.depositCents, 800000);
    assert.ok(closing.depositDueAt);
    const days = (closing.depositDueAt!.getTime() - closing.openedAt.getTime()) / DAY;
    assert.ok(days > 2.9 && days < 3.1);
    const step = closing.steps.find((item) => item.key === "BUYER_DEPOSIT")!;
    assert.equal(step.dueAt?.getTime(), closing.depositDueAt!.getTime());
    assert.match((await prisma.auditEvent.findFirstOrThrow({ where: { entityId: offer.id, action: "AWARD" } })).detail, /approved by the seller/);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [deal.listing.id] } } });
    await cleanDeal(deal);
  }
});

test("a reserve the price clears is the seller's standing approval", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { reservePrice: 75000 } });
    const offer = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "OPEN", amount: 80000 } });
    const awarded = await awardOffer(offer.id, deal.desk.id);
    assert.equal(awarded.error, null);
    assert.match((await prisma.auditEvent.findFirstOrThrow({ where: { entityId: offer.id, action: "AWARD" } })).detail, /within the seller's reserve/);
  } finally {
    await cleanDeal(deal);
  }
});

test("a desk counter the buyer never accepted is not what gets awarded", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { reservePrice: 75000 } });
    const offer = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "OPEN", amount: 80000 } });
    await prisma.offerMessage.create({ data: { inquiryId: offer.id, authorId: deal.buyer.id, kind: "OFFER", amount: 80000, body: "Opening bid." } });
    await prisma.offerMessage.create({ data: { inquiryId: offer.id, authorId: deal.desk.id, kind: "COUNTER", amount: 100000, body: "Counter." } });
    const awarded = await awardOffer(offer.id, deal.desk.id);
    assert.equal(awarded.error, null);
    const closing = await prisma.closing.findUniqueOrThrow({ where: { inquiryId: offer.id } });
    assert.equal(Number(closing.salePrice), 80000);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: deal.listing.id } });
    await cleanDeal(deal);
  }
});

test("a group bid can't be awarded while a seat hasn't reconfirmed the price", async () => {
  const deal = await makeDeal(crypto.randomUUID().slice(0, 8));
  try {
    await prisma.listing.update({ where: { id: deal.listing.id }, data: { reservePrice: 50000 } });
    const offer = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyer.id, type: "OFFER", status: "OPEN", amount: 80000 } });
    const group = await prisma.groupBuy.create({ data: { listingId: deal.listing.id, openedById: deal.buyer.id, minPosition: 10000, deadline: new Date(Date.now() + 86400000), targetAmount: 80000, inquiryId: offer.id, status: "OFFERED" } });
    await prisma.groupPosition.create({ data: { groupId: group.id, userId: deal.buyer.id, seat: 1, amount: 40000, percent: 50, status: "PLEDGED" } });
    await prisma.groupPosition.create({ data: { groupId: group.id, userId: deal.quiet.id, seat: 2, amount: 40000, percent: 50, status: "RECONFIRM" } });
    assert.equal((await awardOffer(offer.id, deal.desk.id)).error, "Some group seats haven't reconfirmed the latest price.");
    await prisma.groupPosition.updateMany({ where: { groupId: group.id }, data: { status: "PLEDGED", amount: 30000 } });
    assert.match((await awardOffer(offer.id, deal.desk.id)).error ?? "", /seats add up to \$60,000, not \$80,000/);
  } finally {
    await prisma.groupBuy.deleteMany({ where: { listingId: deal.listing.id } });
    await prisma.auditEvent.deleteMany({ where: { entityId: deal.listing.id } });
    await cleanDeal(deal);
  }
});

test("desk search treats regex characters as text", async () => {
  const found = await deskSearch("[(*");
  assert.ok(found);
});
