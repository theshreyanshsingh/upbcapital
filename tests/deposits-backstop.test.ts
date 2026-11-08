import assert from "node:assert/strict";
import test from "node:test";
import { awardOffer } from "../lib/awards";
import { BACKUP_COUNT, BACKUP_GRACE_DAYS, answerBackup, awardBackup, backupAsksFor, backupsFor, lapseBackups, pickBackups } from "../lib/backup-bids";
import { STALL_REASON, backstopStage, moneyMoved, runBackstop, stallDaysOf } from "../lib/backstop";
import { cancelOpenClosing, dealTimeline, finalizeClosing, loadDealTimeline, openClosing } from "../lib/closing-service";
import { decideDepositOutcome, depositNoticeLine, depositOutcome, endingStatus, proposeDepositOutcome } from "../lib/deposits";
import { expireBids } from "../lib/jobs";
import { prisma } from "../lib/prisma";
import { getSettings } from "../lib/settings";
import { statementLines } from "../lib/settlement";
import { strikeLimitOf } from "../lib/strikes";

// An award sends the purchase agreement for signature, so its PDF stays on disk and signing stays in the app,
// whatever storage or signing keys the local .env carries.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The rules, without the database.

test("the deposit's outcome follows how the deal ended", () => {
  const ended = { depositReceivedCents: 1000000, cancelReason: "Title defect", canceledAt: at("2026-11-20"), diligenceEndsAt: at("2026-11-10") };
  assert.equal(depositOutcome({ ...ended, status: "OPEN", depositReceivedCents: null }), null);
  assert.equal(depositOutcome({ ...ended, status: "CANCELED", cancelFault: "SELLER", depositReceivedCents: 0 }), null);
  assert.equal(depositOutcome({ ...ended, status: "OPEN" }), "HELD");
  assert.equal(depositOutcome({ ...ended, status: "COMPLETE" }), "APPLIED");
  assert.equal(depositOutcome({ ...ended, status: "CANCELED", cancelFault: "SELLER" }), "REFUND_DUE");
  assert.equal(depositOutcome({ ...ended, status: "CANCELED", cancelFault: "NEITHER" }), "REFUND_DUE");
  // A cancel from before faults were kept owes it back: a forfeit needs the buyer's failure on record.
  assert.equal(depositOutcome({ ...ended, status: "CANCELED", cancelFault: null }), "REFUND_DUE");
  // The buyer's failure inside the diligence window, where walking away was their right.
  assert.equal(depositOutcome({ ...ended, status: "CANCELED", cancelFault: "BUYER", canceledAt: at("2026-11-08") }), "REFUND_DUE");
  assert.equal(depositOutcome({ ...ended, status: "CANCELED", cancelFault: "BUYER", cancelReason: "The buyer walked away in diligence: liens" }), "REFUND_DUE");
  // After the window, or with none, the rules suggest a forfeit, and the deposit stays held until two people agree.
  assert.equal(depositOutcome({ ...ended, status: "CANCELED", cancelFault: "BUYER" }), "FORFEITED");
  assert.equal(depositOutcome({ ...ended, status: "CANCELED", cancelFault: "BUYER", diligenceEndsAt: null }), "FORFEITED");
  assert.equal(endingStatus("FORFEITED"), "HELD");
  assert.equal(endingStatus("REFUND_DUE"), "REFUND_DUE");
  assert.match(depositNoticeLine({ ...ended, status: "CANCELED", cancelFault: "SELLER" }), /\$10,000\.00 is due back to you/);
  assert.match(depositNoticeLine({ ...ended, status: "CANCELED", cancelFault: "BUYER" }), /may be kept under the purchase terms/);
  assert.equal(depositNoticeLine({ ...ended, status: "CANCELED", cancelFault: "SELLER", depositReceivedCents: null }), "");
});

test("each side's statement carries the deposit's outcome, and the seller's leaves out the buyer's refund wire", () => {
  const closing = {
    id: "c1", salePrice: 100000, buyerPremiumCents: 250000, sellerCommissionCents: 300000, buyerTotalCents: 10250000, netToSellerCents: 9700000,
    openedAt: at("2026-11-01"), closedAt: null, status: "CANCELED",
    fundsReceivedCents: null, fundsReceivedAt: null, fundsReference: null, proceedsSentCents: null, proceedsSentAt: null, proceedsReference: null,
    depositCents: 1000000, depositReceivedCents: 1000000, depositReceivedAt: at("2026-11-03"), depositReference: "DEP1",
    depositStatus: "REFUNDED", depositResolvedAt: at("2026-11-21"), depositRefundReference: "RFD9",
  };
  const buyer = statementLines(closing, "buyer")[0].lines;
  const refund = buyer.find((line) => line.label === "Deposit refunded");
  assert.equal(refund?.cents, 1000000);
  assert.equal(refund?.detail, "2026-11-21 · RFD9");
  const seller = statementLines(closing, "seller")[0].lines;
  assert.deepEqual(seller.at(-1), { label: "Buyer deposit refunded", cents: 1000000, detail: "2026-11-21" });
  const desk = statementLines({ ...closing, depositStatus: "FORFEITED" }, "desk");
  assert.ok(desk[0].lines.some((line) => line.label === "Deposit forfeited"));
  assert.ok(desk[1].lines.some((line) => line.label === "Buyer deposit forfeited"));
  // With no outcome recorded, the lines are as they were.
  assert.equal(statementLines({ ...closing, depositStatus: null }, "buyer")[0].lines.length, 6);
});

test("the deal timeline shows the deposit's outcome and its four-eyes decision to the buyer side, the reason to the desk only", () => {
  const day = (n: number) => new Date(at("2026-11-01").getTime() + n * DAY);
  const input = {
    closing: {
      status: "CANCELED", openedAt: day(0), closedAt: null, canceledAt: day(10), cancelReason: "The buyer never wired the balance.", cancelFault: "BUYER",
      targetCloseAt: day(30), salePrice: 100000, depositCents: 1000000, depositDueAt: day(3), fundsReceivedCents: null, fundsReceivedAt: null,
      depositReceivedCents: 1000000, depositReceivedAt: day(2), proceedsSentCents: null, proceedsSentAt: null,
    },
    steps: [],
    audits: [
      { id: "d1", action: "DEPOSIT_RECEIVED", actorId: "admin", detail: "Buyer deposit received: none to $10,000.00 on 2026-11-03 · DEP-1", createdAt: day(2) },
      { id: "d2", action: "DEPOSIT_STATUS", actorId: null, detail: "Deposit held: $10,000.00. The rules suggest a forfeit, which two desk members decide.", createdAt: day(10) },
      { id: "d3", action: "DEPOSIT_PROPOSED", actorId: "admin", detail: "refund of $10,000.00. Goodwill, the buyer's lender failed.", createdAt: day(11) },
      { id: "d4", action: "DEPOSIT_REJECTED", actorId: "second", detail: "Rejected the refund of $10,000.00", createdAt: day(12) },
      { id: "d5", action: "DEPOSIT_PROPOSED", actorId: "admin", detail: "forfeit of $10,000.00. The buyer missed the close by two weeks.", createdAt: day(13) },
      { id: "d6", action: "DEPOSIT_APPROVED", actorId: "second", detail: "forfeit of $10,000.00, proposed by admin", createdAt: day(14) },
    ],
    posts: [],
    people: { admin: { name: "Dana Desk", role: "ADMIN" }, second: { name: "Sol Second", role: "ADMIN" }, seller: { name: "Sam Seller", role: "INDIVIDUAL_SELLER" }, buyer: { name: "Bea Buyer", role: "BUYER" } },
    sellerId: "seller",
    buyerIds: ["buyer"],
    days: 30,
    now: day(20),
  };
  const titles = (side: "desk" | "buyer" | "seller" | "observer") => dealTimeline(input, side).entries.map((entry) => entry.title).filter((title) => /deposit/i.test(title));
  assert.deepEqual(titles("buyer"), ["Buyer deposit recorded", "Deposit held", "Deposit refund proposed", "Deposit proposal withdrawn", "Deposit forfeit proposed", "Deposit forfeit approved"]);
  assert.deepEqual(titles("desk"), ["Buyer deposit recorded", "Deposit held", "Deposit refund proposed", "Deposit proposal rejected", "Deposit forfeit proposed", "Deposit forfeit approved"]);
  assert.deepEqual(titles("seller"), []);
  assert.deepEqual(titles("observer"), []);
  const entry = (side: "desk" | "buyer", id: string) => dealTimeline(input, side).entries.find((row) => row.id === `audit:${id}`);
  assert.match(entry("desk", "d5")?.detail ?? "", /^Keep \$10,000\.00\. A second desk member approves it before it takes effect\. Reason: The buyer missed the close/);
  assert.doesNotMatch(entry("buyer", "d5")?.detail ?? "", /Reason/);
  assert.equal(entry("buyer", "d6")?.who, "The desk");
  assert.equal(entry("desk", "d6")?.who, "Sol Second, desk");
  const refunded = dealTimeline({ ...input, audits: [{ id: "r1", action: "DEPOSIT_APPROVED", actorId: "second", detail: "refund of $10,000.00, proposed by admin · RFD-9", createdAt: day(15) }] }, "buyer");
  assert.deepEqual(
    refunded.entries.filter((row) => row.id === "audit:r1").map((row) => [row.title, row.detail]),
    [["Deposit refunded", "$10,000.00 sent back to the buyer · reference RFD-9, approved by a second desk member."]],
  );
});

test("the backstop takes one step per run: the warning, the final notice, then the backstop", () => {
  const target = at("2026-11-01");
  const fresh = { status: "OPEN", openedAt: at("2026-10-01"), targetCloseAt: target, stallWarnedAt: null, stallFinalAt: null, stallEscalatedAt: null };
  assert.equal(stallDaysOf(null), 15);
  assert.equal(stallDaysOf(2), 15);
  assert.equal(stallDaysOf(20), 20);
  assert.equal(backstopStage(fresh, 15, 30, new Date(target.getTime() - HOUR)), null);
  assert.equal(backstopStage(fresh, 15, 30, new Date(target.getTime() + HOUR)), "warn");
  // A deal found late is still warned first, and gets its final notice three days before anything happens.
  assert.equal(backstopStage(fresh, 15, 30, new Date(target.getTime() + 20 * DAY)), "warn");
  const warned = { ...fresh, stallWarnedAt: target };
  assert.equal(backstopStage(warned, 15, 30, new Date(target.getTime() + 11 * DAY)), null);
  assert.equal(backstopStage(warned, 15, 30, new Date(target.getTime() + 12 * DAY)), "final");
  const late = { ...warned, stallFinalAt: new Date(target.getTime() + 20 * DAY) };
  assert.equal(backstopStage(late, 15, 30, new Date(target.getTime() + 22 * DAY)), null);
  assert.equal(backstopStage(late, 15, 30, new Date(target.getTime() + 23 * DAY)), "act");
  assert.equal(backstopStage({ ...late, stallEscalatedAt: target }, 15, 30, new Date(target.getTime() + 23 * DAY)), null);
  assert.equal(backstopStage({ ...late, status: "CANCELED" }, 15, 30, new Date(target.getTime() + 23 * DAY)), null);
  assert.equal(moneyMoved({ depositReceivedCents: null, fundsReceivedCents: null, proceedsSentCents: null }), false);
  assert.equal(moneyMoved({ depositReceivedCents: null, fundsReceivedCents: null, proceedsSentCents: null }, [{ status: "FUNDED" }]), true);
  assert.equal(moneyMoved({ depositReceivedCents: 500, fundsReceivedCents: null, proceedsSentCents: null }), true);
});

test("the backups are the next two best live bids on the same scope, at each buyer's latest price", () => {
  const now = at("2026-11-08");
  const bid = (id: string, amount: number, extra: Partial<Parameters<typeof pickBackups>[1][number]> = {}) => ({
    id, type: "OFFER", status: "OPEN", noteId: null, buyerId: `b-${id}`, amount, expiresAt: null, createdAt: at("2026-11-01"), messages: [], ...extra,
  });
  const winner = { id: "w", buyerId: "b-w", noteId: null };
  const bids = [
    bid("low", 70000),
    bid("raised", 60000, { messages: [{ kind: "OFFER", amount: 98000, createdAt: at("2026-11-02"), authorId: "b-raised" }] }),
    bid("mid", 90000),
    bid("loan", 99000, { noteId: "loan-1" }),
    bid("lapsed", 99500, { expiresAt: at("2026-11-07") }),
    bid("group", 99900),
    bid("mine", 99800, { buyerId: "b-w" }),
    bid("gone", 99700, { status: "DECLINED" }),
    bid("tie", 90000, { createdAt: at("2026-11-03") }),
  ];
  const picked = pickBackups(winner, bids, now, new Set(["group"]));
  assert.equal(picked.length, BACKUP_COUNT);
  assert.deepEqual(picked.map((row) => row.bid.id), ["raised", "mid"]);
  assert.deepEqual(picked.map((row) => row.price), [98000, 90000]);
  // A one-loan winner's backups bid on that loan.
  assert.deepEqual(pickBackups({ id: "w", buyerId: "b-w", noteId: "loan-1" }, bids, now).map((row) => row.bid.id), ["loan"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Against the database. Every row is made here with an e-backstop- email, and only those rows are removed.

const note = (street: string) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 120000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 100000, estimatedValue: 180000,
});

async function makeDeal(opts: { buyers?: number; status?: "APPROVED" | "PENDING" } = {}) {
  const tag = crypto.randomUUID().slice(0, 8);
  const email = (who: string) => `e-backstop-${tag}-${who}@example.org`;
  const seller = await prisma.user.create({ data: { email: email("seller"), name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const buyers = [];
  for (let index = 0; index < (opts.buyers ?? 1); index += 1) {
    buyers.push(await prisma.user.create({ data: { email: email(`buyer${index}`), name: `Buyer ${index} ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } }));
  }
  // An owner, who can do anything, and a closings desk member, who approves wires but doesn't run sales.
  const owner = await prisma.user.create({ data: { email: email("owner"), name: `Owner ${tag}`, role: "ADMIN", deskRole: "OWNER", accountStatus: "APPROVED", passwordHash: "x" } });
  const closer = await prisma.user.create({ data: { email: email("closer"), name: `Closer ${tag}`, role: "ADMIN", deskRole: "CLOSINGS", accountStatus: "APPROVED", passwordHash: "x" } });
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: opts.status ?? "PENDING",
      approvedAt: new Date(),
      reservePrice: 1000,
      title: `E backstop ${tag}`,
      notes: { create: [note("9 Backstop Row")] as never },
    },
    include: { notes: true },
  });
  return { tag, seller, buyers, owner, closer, listing, users: [seller, ...buyers, owner, closer] };
}

type Deal = Awaited<ReturnType<typeof makeDeal>>;

async function cleanDeal(deal: Deal) {
  const listingId = deal.listing.id;
  const userIds = deal.users.map((user) => user.id);
  const inquiries = await prisma.inquiry.findMany({ where: { listingId }, select: { id: true } });
  const closings = await prisma.closing.findMany({ where: { listingId }, select: { id: true } });
  const closingIds = closings.map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [listingId, ...userIds, ...inquiries.map((row) => row.id), ...closingIds] } } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId } });
  await prisma.invoice.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.buyerHolding.deleteMany({ where: { closingId: { in: closingIds } } });
  await prisma.buyerStrike.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: deal.users.map((user) => user.email) } }, { subject: { contains: deal.listing.title } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function openBuyerClosing(deal: Deal, extra: { targetCloseAt?: Date; depositReceivedCents?: number; diligenceEndsAt?: Date | null } = {}) {
  const inquiry = await prisma.inquiry.create({ data: { listingId: deal.listing.id, buyerId: deal.buyers[0].id, type: "OFFER", status: "ACCEPTED", amount: 100000 } });
  const opened = await openClosing({ listingId: deal.listing.id, inquiryId: inquiry.id, noteId: null, salePrice: 100000, title: deal.listing.title });
  const closing = await prisma.closing.update({
    where: { id: opened.id },
    data: {
      depositCents: 1000000,
      ...(extra.depositReceivedCents != null ? { depositReceivedCents: extra.depositReceivedCents, depositReceivedAt: new Date(), depositReference: "DEP1" } : {}),
      ...(extra.targetCloseAt ? { targetCloseAt: extra.targetCloseAt } : {}),
      ...("diligenceEndsAt" in extra ? { diligenceEndsAt: extra.diligenceEndsAt } : {}),
    },
  });
  return { inquiry, closing };
}

const subjects = async (email: string) => (await prisma.notification.findMany({ where: { toEmail: email }, select: { subject: true, body: true } }));

test("a completed sale applies the deposit, and a refund or forfeit needs a second desk member", async () => {
  const deal = await makeDeal();
  const second = await makeDeal();
  try {
    const buyerEmail = deal.buyers[0].email;
    // The buyer fails after the diligence window: the rules suggest a forfeit, and the deposit is held until decided.
    const failed = await openBuyerClosing(deal, { depositReceivedCents: 1000000, diligenceEndsAt: new Date(Date.now() - DAY) });
    assert.ok(await cancelOpenClosing(failed.closing.id, "The buyer never wired the balance.", { fault: "BUYER", actorId: deal.owner.id }));
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: failed.closing.id } })).depositStatus, "HELD");
    const owner = { ...deal.owner, deskRole: "OWNER" };
    const closer = { ...deal.closer, deskRole: "CLOSINGS" };
    const id = failed.closing.id;
    assert.match((await proposeDepositOutcome({ ...owner, deskRole: "SALES" }, { closingId: id, outcome: "FORFEITED", note: "The buyer missed the close." })).error ?? "", /desk role/);
    assert.match((await proposeDepositOutcome(owner, { closingId: id, outcome: "FORFEITED", note: "short" })).error ?? "", /in a sentence/);
    assert.equal((await proposeDepositOutcome(owner, { closingId: id, outcome: "FORFEITED", note: "The buyer missed the close by two weeks." })).error, null);
    assert.match((await proposeDepositOutcome(closer, { closingId: id, outcome: "REFUNDED", note: "A second proposal on top." })).error ?? "", /already waiting/);
    // Four eyes: the proposer can't approve their own.
    assert.equal((await decideDepositOutcome(owner, { closingId: id, decision: "APPROVED" })).error, "You proposed this, so another desk member approves it.");
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id } })).depositStatus, "HELD");
    assert.equal((await decideDepositOutcome(closer, { closingId: id, decision: "APPROVED" })).error, null);
    const forfeited = await prisma.closing.findUniqueOrThrow({ where: { id } });
    assert.equal(forfeited.depositStatus, "FORFEITED");
    assert.equal(forfeited.depositProposedById, deal.owner.id);
    assert.equal(forfeited.depositResolvedById, deal.closer.id);
    assert.match((await decideDepositOutcome(owner, { closingId: id, decision: "APPROVED" })).error ?? "", /Nothing on this deposit/);
    assert.match((await proposeDepositOutcome(closer, { closingId: id, outcome: "REFUNDED", note: "Changing our minds now." })).error ?? "", /already decided/);
    const told = (await subjects(buyerEmail)).filter((row) => row.subject === `Your deposit · ${deal.listing.title}`);
    assert.equal(told.length, 2);
    assert.match(told.map((row) => row.body).join(" "), /proposed keeping your deposit/);
    const actions = (await prisma.auditEvent.findMany({ where: { entityId: id, action: { startsWith: "DEPOSIT_" } }, select: { action: true } })).map((row) => row.action);
    assert.deepEqual([...actions].sort(), ["DEPOSIT_APPROVED", "DEPOSIT_PROPOSED", "DEPOSIT_STATUS"]);
    // The buyer's log carries each step, without the desk's reason, which the desk's log keeps.
    const log = (await loadDealTimeline(id, "buyer"))!.entries;
    assert.deepEqual(log.filter((row) => row.title.startsWith("Deposit")).map((row) => row.title), ["Deposit held", "Deposit forfeit proposed", "Deposit forfeit approved"]);
    assert.ok(log.some((row) => row.title === "Buyer deposit recorded"));
    assert.ok(log.every((row) => !row.detail.includes("two weeks")));
    assert.ok((await loadDealTimeline(id, "desk"))!.entries.some((row) => row.detail.includes("Reason: The buyer missed the close by two weeks.")));
    assert.ok((await loadDealTimeline(id, "seller"))!.entries.every((row) => !row.title.includes("eposit")));

    // A seller's failure owes it back: no forfeit, and the refund takes its wire reference. A rejection clears it.
    const refund = await openBuyerClosing(second, { depositReceivedCents: 1000000 });
    assert.ok(await cancelOpenClosing(refund.closing.id, "The seller lost the collateral file.", { fault: "SELLER", actorId: deal.owner.id }));
    const rid = refund.closing.id;
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: rid } })).depositStatus, "REFUND_DUE");
    assert.match((await proposeDepositOutcome(closer, { closingId: rid, outcome: "FORFEITED", note: "Trying to keep it anyway." })).error ?? "", /owed back/);
    assert.equal((await proposeDepositOutcome(closer, { closingId: rid, outcome: "REFUNDED", note: "Seller failed, refund in full." })).error, null);
    assert.equal((await decideDepositOutcome(owner, { closingId: rid, decision: "REJECTED" })).error, null);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: rid } })).depositProposal, null);
    assert.equal((await proposeDepositOutcome(closer, { closingId: rid, outcome: "REFUNDED", note: "Seller failed, refund in full." })).error, null);
    assert.equal((await decideDepositOutcome(owner, { closingId: rid, decision: "APPROVED" })).error, "Enter the refund wire's reference.");
    assert.equal((await decideDepositOutcome(owner, { closingId: rid, decision: "APPROVED", reference: "RFD-77" })).error, null);
    const refunded = await prisma.closing.findUniqueOrThrow({ where: { id: rid } });
    assert.equal(refunded.depositStatus, "REFUNDED");
    assert.equal(refunded.depositRefundReference, "RFD-77");
    const refundLog = (await loadDealTimeline(rid, "buyer"))!.entries.filter((row) => row.title.startsWith("Deposit"));
    assert.deepEqual(refundLog.map((row) => row.title), ["Deposit refund due", "Deposit refund proposed", "Deposit proposal withdrawn", "Deposit refund proposed", "Deposit refunded"]);
    assert.match(refundLog.at(-1)?.detail ?? "", /reference RFD-77/);

    // A completed sale applies it to the price.
    const sold = await makeDeal();
    try {
      const done = await openBuyerClosing(sold, { depositReceivedCents: 1000000 });
      await prisma.closingStep.updateMany({ where: { closingId: done.closing.id }, data: { status: "COMPLETE", completedAt: new Date() } });
      assert.equal((await finalizeClosing(done.closing.id))?.depositStatus, "APPLIED");
    } finally {
      await cleanDeal(sold);
    }
  } finally {
    await cleanDeal(deal);
    await cleanDeal(second);
  }
});

test("the backstop warns, gives a final notice, then cancels a deal with no money moved or escalates one with money, each once", async () => {
  const idle = await makeDeal();
  const funded = await makeDeal();
  try {
    const stall = stallDaysOf((await getSettings()).stallDays);
    const target = new Date(Date.now() - 60_000);
    const a = await openBuyerClosing(idle, { targetCloseAt: target });
    const b = await openBuyerClosing(funded, { targetCloseAt: target, depositReceivedCents: 1000000 });
    const ids = [a.closing.id, b.closing.id];
    const run = (offset: number) => runBackstop(new Date(target.getTime() + offset), { closingIds: ids });
    const parties = (deal: Deal) => [deal.buyers[0].email, deal.seller.email];
    const count = async (deal: Deal, subject: string) => prisma.notification.count({ where: { toEmail: { in: parties(deal) }, subject } });

    assert.equal((await run(HOUR)).sent, 2);
    assert.equal((await run(HOUR)).sent, 0);
    assert.equal(await count(idle, `Past the target close · ${idle.listing.title}`), 2);
    assert.match((await subjects(idle.seller.email)).find((row) => row.subject.startsWith("Past the target"))?.body ?? "", /it is canceled and the note goes back on the book/);
    assert.match((await subjects(funded.seller.email)).find((row) => row.subject.startsWith("Past the target"))?.body ?? "", /the desk decides/);

    const final = (stall - 3) * DAY + HOUR;
    assert.equal((await run(final)).sent, 2);
    assert.equal((await run(final)).sent, 0);
    assert.equal(await count(idle, `Final notice · ${idle.listing.title}`), 2);
    // The backstop waits three days after the final notice.
    assert.equal((await run(stall * DAY)).sent, 0);

    const backstop = stall * DAY + 2 * HOUR;
    assert.equal((await run(backstop)).sent, 2);
    assert.equal((await run(backstop)).sent, 0);
    const canceled = await prisma.closing.findUniqueOrThrow({ where: { id: a.closing.id } });
    assert.equal(canceled.status, "CANCELED");
    assert.equal(canceled.cancelReason, STALL_REASON);
    assert.equal(canceled.cancelFault, "NEITHER");
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: idle.listing.id } })).status, "APPROVED");
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: a.inquiry.id } })).status, "DECLINED");
    assert.equal(await prisma.buyerStrike.count({ where: { userId: idle.buyers[0].id } }), 0);
    assert.equal(await count(idle, `Closing canceled · ${idle.listing.title}`), 2);
    const escalated = await prisma.closing.findUniqueOrThrow({ where: { id: b.closing.id } });
    assert.equal(escalated.status, "OPEN");
    assert.ok(escalated.stallEscalatedAt);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: b.closing.id, action: "STALL_ESCALATED" } }), 1);
    assert.equal(await prisma.notification.count({ where: { subject: `Stalled closing · ${funded.listing.title}`, toEmail: funded.owner.email } }), 1);
  } finally {
    await cleanDeal(idle);
    await cleanDeal(funded);
  }
});

test("after an award the next two bids are asked to stand as backup, and one is awarded when the winner's closing fails", async () => {
  const deal = await makeDeal({ buyers: 4, status: "APPROVED" });
  try {
    const listingId = deal.listing.id;
    const [w, b2, b3, b4] = await Promise.all(
      [100000, 95000, 90000, 85000].map((amount, index) => prisma.inquiry.create({ data: { listingId, buyerId: deal.buyers[index].id, type: "OFFER", status: "OPEN", amount } })),
    );
    const award = await awardOffer(w.id, deal.owner.id, { backups: true });
    assert.equal(award.error, null);
    assert.equal(award.declined, 1);
    const status = async (id: string) => prisma.inquiry.findUniqueOrThrow({ where: { id } });
    assert.ok((await status(b2.id)).backupAskedAt);
    assert.equal((await status(b2.id)).status, "OPEN");
    assert.equal((await status(b3.id)).status, "OPEN");
    assert.equal((await status(b4.id)).status, "DECLINED");
    // The backup hears where it stood, as a losing bid does; the fourth hears the usual notice with the same round.
    const asked = (await subjects(deal.buyers[1].email)).find((row) => row.subject === `Stand as backup? · ${deal.listing.title}`);
    assert.match(asked?.body ?? "", /The round had 4 bids, and yours ranked 2nd by price/);
    const lost = (await subjects(deal.buyers[3].email)).find((row) => row.subject === `Bid not selected · ${deal.listing.title}`);
    assert.match(lost?.body ?? "", /The round had 4 bids, and yours ranked 4th by price/);
    assert.deepEqual((await backupAsksFor(deal.buyers[1].id)).map((row) => row.state), ["asked"]);

    // The second agrees and the third declines. A decline closes the bid as before, and nobody answers twice.
    assert.equal((await answerBackup({ inquiryId: b2.id, buyerId: deal.buyers[2].id, answer: "ACCEPT" })).error, "That bid isn't yours.");
    const yes = await answerBackup({ inquiryId: b2.id, buyerId: deal.buyers[1].id, answer: "ACCEPT" });
    assert.equal(yes.error, null);
    assert.equal((await answerBackup({ inquiryId: b3.id, buyerId: deal.buyers[2].id, answer: "DECLINE" })).error, null);
    assert.equal((await answerBackup({ inquiryId: b2.id, buyerId: deal.buyers[1].id, answer: "DECLINE" })).error, "You already answered.");
    const standing = await status(b2.id);
    assert.ok(standing.backupAt && standing.backupUntil);
    assert.equal(standing.expiresAt?.getTime(), standing.backupUntil.getTime());
    const declined = await status(b3.id);
    assert.equal(declined.status, "DECLINED");
    assert.ok(declined.backupDeclinedAt);
    // The bid expiry job leaves a backup to its own lapse.
    assert.equal((await expireBids(new Date(standing.backupUntil.getTime() + HOUR), { inquiryIds: [b2.id] })).sent, 0);

    // While the winner's closing is open, a backup can't be awarded.
    const owner = { ...deal.owner, deskRole: "OWNER" };
    assert.match((await awardBackup(owner, b2.id)).error ?? "", /in contract/);
    assert.equal((await awardBackup({ ...deal.closer, deskRole: "CLOSINGS" }, b2.id)).error, "Your desk role doesn't cover this. Ask an owner to change it.");

    // The winner's closing fails. The desk hears which backups are live, and the award runs its usual checks.
    assert.ok(await cancelOpenClosing(award.closingId!, "The buyer's funding fell through.", { fault: "BUYER", actorId: deal.owner.id }));
    assert.equal(await prisma.notification.count({ where: { toEmail: deal.owner.email, subject: `Backup bids live · ${deal.listing.title}` } }), 1);
    const panel = await backupsFor({ id: award.closingId!, listingId, noteId: null, noteIds: [] });
    assert.deepEqual(panel.standing.map((row) => row.id), [b2.id]);
    const limit = strikeLimitOf((await getSettings()).strikeLimit);
    await prisma.buyerStrike.createMany({ data: Array.from({ length: limit }, (_, index) => ({ userId: deal.buyers[1].id, closingId: `e-backstop-none-${index}`, reason: "Earlier miss." })) });
    assert.match((await awardBackup(owner, b2.id)).error ?? "", /paused/);
    await prisma.buyerStrike.deleteMany({ where: { userId: deal.buyers[1].id } });
    const awarded = await awardBackup(owner, b2.id);
    assert.equal(awarded.error, null);
    assert.ok(awarded.closingId);
    assert.equal((await status(b2.id)).status, "ACCEPTED");
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: awarded.closingId! } })).inquiryId, b2.id);
    assert.equal((await backupsFor({ id: award.closingId!, listingId, noteId: null, noteIds: [] })).awardedTo, awarded.closingId);
  } finally {
    await cleanDeal(deal);
  }
});

test("a backup lapses at its date, and an ask left unanswered closes after three days", async () => {
  const deal = await makeDeal({ buyers: 3, status: "APPROVED" });
  try {
    const listingId = deal.listing.id;
    const [w, b2, b3] = await Promise.all(
      [100000, 95000, 90000].map((amount, index) => prisma.inquiry.create({ data: { listingId, buyerId: deal.buyers[index].id, type: "OFFER", status: "OPEN", amount } })),
    );
    assert.equal((await awardOffer(w.id, deal.owner.id, { backups: true })).error, null);
    const yes = await answerBackup({ inquiryId: b2.id, buyerId: deal.buyers[1].id, answer: "ACCEPT" });
    assert.equal(yes.error, null);
    const until = (await prisma.inquiry.findUniqueOrThrow({ where: { id: b2.id } })).backupUntil!;
    const ids = [b2.id, b3.id];
    // Before the backup's date, only the unanswered ask is due, and only after three days.
    assert.equal((await lapseBackups(new Date(Date.now() + HOUR), { inquiryIds: ids })).sent, 0);
    assert.equal((await lapseBackups(new Date(Date.now() + 3 * DAY + HOUR), { inquiryIds: ids })).sent, 1);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: b3.id } })).status, "DECLINED");
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: b2.id } })).status, "OPEN");
    const after = new Date(until.getTime() + HOUR);
    assert.equal((await lapseBackups(after, { inquiryIds: ids })).sent, 1);
    assert.equal((await lapseBackups(after, { inquiryIds: ids })).sent, 0);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: b2.id } })).status, "EXPIRED");
    assert.equal((await subjects(deal.buyers[1].email)).filter((row) => row.subject === `Backup bid ended · ${deal.listing.title}`).length, 1);
    assert.equal((await subjects(deal.buyers[2].email)).filter((row) => row.subject === `Bid not selected · ${deal.listing.title}`).length, 1);
  } finally {
    await cleanDeal(deal);
  }
});

test("a completed sale releases the backups behind it", async () => {
  const deal = await makeDeal({ buyers: 2, status: "APPROVED" });
  try {
    const listingId = deal.listing.id;
    const [w, b2] = await Promise.all(
      [100000, 95000].map((amount, index) => prisma.inquiry.create({ data: { listingId, buyerId: deal.buyers[index].id, type: "OFFER", status: "OPEN", amount } })),
    );
    const award = await awardOffer(w.id, deal.owner.id, { backups: true });
    assert.equal(award.error, null);
    assert.equal((await answerBackup({ inquiryId: b2.id, buyerId: deal.buyers[1].id, answer: "ACCEPT" })).error, null);
    await prisma.closingStep.updateMany({ where: { closingId: award.closingId! }, data: { status: "COMPLETE", completedAt: new Date() } });
    assert.equal((await finalizeClosing(award.closingId!))?.status, "COMPLETE");
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: b2.id } })).status, "DECLINED");
    const released = (await subjects(deal.buyers[1].email)).find((row) => row.subject === `Bid not selected · ${deal.listing.title}`);
    assert.match(released?.body ?? "", /your backup bid is released/);
    assert.deepEqual(await backupAsksFor(deal.buyers[1].id), []);
  } finally {
    await cleanDeal(deal);
  }
});

test("a backup outlives the backstop, so a deal the backstop cancels can still go to it", async () => {
  const deal = await makeDeal({ buyers: 2, status: "APPROVED" });
  try {
    const listingId = deal.listing.id;
    const stall = stallDaysOf((await getSettings()).stallDays);
    const [w, b2] = await Promise.all(
      [100000, 95000].map((amount, index) => prisma.inquiry.create({ data: { listingId, buyerId: deal.buyers[index].id, type: "OFFER", status: "OPEN", amount } })),
    );
    const award = await awardOffer(w.id, deal.owner.id, { backups: true });
    assert.equal(award.error, null);
    // The winner's target fell far enough back that the backstop is due now, with nothing wired.
    const target = new Date(Date.now() - stall * DAY - 3 * HOUR);
    await prisma.closing.update({ where: { id: award.closingId! }, data: { targetCloseAt: target } });
    assert.equal((await answerBackup({ inquiryId: b2.id, buyerId: deal.buyers[1].id, answer: "ACCEPT" })).error, null);
    const until = (await prisma.inquiry.findUniqueOrThrow({ where: { id: b2.id } })).backupUntil!;
    assert.equal(until.getTime(), target.getTime() + (stall + BACKUP_GRACE_DAYS) * DAY);
    const run = (offset: number) => runBackstop(new Date(target.getTime() + offset), { closingIds: [award.closingId!] });
    assert.equal((await run(HOUR)).sent, 1);
    assert.equal((await run((stall - 3) * DAY + HOUR)).sent, 1);
    assert.equal((await run(stall * DAY + 2 * HOUR)).sent, 1);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: award.closingId! } })).cancelReason, STALL_REASON);
    // The desk's cancel notice names the backup, which is still live and isn't lapsed by the job.
    const notice = await prisma.notification.findFirst({ where: { toEmail: deal.owner.email, subject: `Closing canceled by the backstop · ${deal.listing.title}` } });
    assert.ok(notice?.body.includes(`Backup bids live: ${deal.buyers[1].name} at $95,000, standing until`));
    assert.equal((await lapseBackups(new Date(), { inquiryIds: [b2.id] })).sent, 0);
    const awarded = await awardBackup({ ...deal.owner, deskRole: "OWNER" }, b2.id);
    assert.equal(awarded.error, null);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: b2.id } })).status, "ACCEPTED");
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: awarded.closingId! } })).status, "OPEN");
  } finally {
    await cleanDeal(deal);
  }
});
