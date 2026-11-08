import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_RESPONSE_DAYS,
  DEFAULT_SURVIVAL_DAYS,
  DESK_PARTY_REFUSAL,
  DESK_PARTY_TEXT,
  answerClaim,
  askDeskReview,
  answerProblem,
  canReadClaimFile,
  claimClock,
  claimDue,
  claimsOnClosing,
  confirmSettlement,
  decideClaim,
  decisionProblem,
  deskClaimQueue,
  deskIsParty,
  fileClaim,
  filingProblem,
  loanPriceCents,
  readAnswer,
  readClaimSettings,
  responseDaysOf,
  survivalDaysOf,
  withdrawClaim,
} from "../lib/claims";
import { DESK_DENIED } from "../lib/desk-roles";
import { prisma } from "../lib/prisma";
import { getSettings } from "../lib/settings";
import { uploadDir } from "../lib/storage";
import { attestationProblem, attestationSide, saveAttestation } from "../lib/track-record";

// Claim files are written to the local disk, whatever storage keys the local .env carries.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) process.env[key] = "";

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PDF = Buffer.from("%PDF-1.4\n% claim evidence\n");

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The rules, without the database.

test("a claim can be filed on a closed deal by the buyer side, within the survival window", () => {
  const closedAt = at("2026-05-01");
  const closing = { status: "COMPLETE", closedAt, deskBidId: null };
  const base = { closing, userId: "buyer", buyerIds: ["buyer", "seat"], survivalDays: 180 };
  assert.equal(filingProblem({ ...base, now: new Date(closedAt.getTime() + 180 * DAY) }), null);
  assert.match(filingProblem({ ...base, now: new Date(closedAt.getTime() + 180 * DAY + 1) }) ?? "", /window for claims closed on Oct 28, 2026/);
  // A seat on a group closing files too. The seller, a stranger or another bidder can't.
  assert.equal(filingProblem({ ...base, userId: "seat", now: at("2026-06-01") }), null);
  assert.match(filingProblem({ ...base, userId: "seller", now: at("2026-06-01") }) ?? "", /Only the buyer/);
  assert.match(filingProblem({ ...base, userId: "bidder", now: at("2026-06-01") }) ?? "", /Only the buyer/);
  assert.match(filingProblem({ ...base, closing: { ...closing, status: "OPEN", closedAt: null }, now: at("2026-06-01") }) ?? "", /once the closing has closed/);
  // On the desk's own purchase UPB is the buyer, and a desk-book member files for it.
  const deskBuy = { ...base, closing: { ...closing, deskBidId: "desk-bid" }, buyerIds: [], now: at("2026-06-01") };
  assert.match(filingProblem({ ...deskBuy, userId: "buyer" }) ?? "", /desk-book member/);
  assert.equal(filingProblem({ ...deskBuy, userId: "trader", deskBook: true }), null);
  // Missing or nonsense settings fall back to the agreement's 180 days and 10 days to answer.
  assert.equal(DEFAULT_SURVIVAL_DAYS, 180);
  assert.equal(survivalDaysOf(null), 180);
  assert.equal(survivalDaysOf(0), 180);
  assert.equal(survivalDaysOf(90), 90);
  assert.equal(survivalDaysOf(1000), 180);
  assert.equal(responseDaysOf(undefined), DEFAULT_RESPONSE_DAYS);
  assert.equal(responseDaysOf(14), 14);
  assert.equal(responseDaysOf(2), 10);
});

test("the settings page takes whole days within the bounds, or blank for the default", () => {
  assert.deepEqual(readClaimSettings({ repSurvivalDays: "", claimResponseDays: " " }), { error: null, repSurvivalDays: null, claimResponseDays: null });
  assert.deepEqual(readClaimSettings({ repSurvivalDays: "365", claimResponseDays: "14" }), { error: null, repSurvivalDays: 365, claimResponseDays: 14 });
  assert.deepEqual(readClaimSettings({ repSurvivalDays: "30", claimResponseDays: "30" }), { error: null, repSurvivalDays: 30, claimResponseDays: 30 });
  assert.match(readClaimSettings({ repSurvivalDays: "29", claimResponseDays: "" }).error ?? "", /claim window as whole days from 30 to 730/);
  assert.match(readClaimSettings({ repSurvivalDays: "731", claimResponseDays: "" }).error ?? "", /from 30 to 730/);
  assert.match(readClaimSettings({ repSurvivalDays: "90.5", claimResponseDays: "" }).error ?? "", /from 30 to 730/);
  assert.match(readClaimSettings({ repSurvivalDays: "", claimResponseDays: "2" }).error ?? "", /answer time as whole days from 3 to 30/);
  assert.match(readClaimSettings({ repSurvivalDays: "", claimResponseDays: "ten" }).error ?? "", /from 3 to 30/);
  assert.match(readClaimSettings({ repSurvivalDays: null, claimResponseDays: "31" }).error ?? "", /from 3 to 30/);
});

test("the clock reminds two days before the answer date, then moves an unanswered claim to the desk", () => {
  const respondBy = at("2026-11-20");
  const claim = { status: "FILED", respondBy, sellerRespondedAt: null };
  assert.equal(claimDue(claim, at("2026-11-17")), null);
  assert.equal(claimDue(claim, at("2026-11-18")), "remind");
  assert.equal(claimDue(claim, at("2026-11-20")), "overdue");
  assert.equal(claimDue({ ...claim, sellerRespondedAt: at("2026-11-19") }, at("2026-11-21")), null);
  assert.equal(claimDue({ ...claim, status: "UNDER_REVIEW" }, at("2026-11-21")), null);
});

test("claim files open to the buyer who filed, the seller and the desk only", () => {
  const claim = { filedById: "buyer", sellerId: "seller" };
  assert.equal(canReadClaimFile({ role: "BUYER", userId: "buyer", ...claim }), true);
  assert.equal(canReadClaimFile({ role: "INDIVIDUAL_SELLER", userId: "seller", ...claim }), true);
  assert.equal(canReadClaimFile({ role: "ADMIN", userId: "desk", ...claim }), true);
  assert.equal(canReadClaimFile({ role: "BUYER", userId: "seat", ...claim }), false);
  assert.equal(canReadClaimFile({ role: "BROKER", userId: "broker", ...claim }), false);
});

test("only the seller answers, once, and a party to the closing never decides", () => {
  const claim = { status: "FILED", sellerId: "seller", sellerRespondedAt: null, respondBy: at("2026-11-20") };
  assert.equal(answerProblem(claim, "seller"), null);
  assert.match(answerProblem(claim, "buyer") ?? "", /Only the seller/);
  assert.match(answerProblem({ ...claim, sellerRespondedAt: at("2026-11-12") }, "seller") ?? "", /already answered/);
  assert.equal(answerProblem({ ...claim, status: "UNDER_REVIEW" }, "seller"), null);
  assert.match(answerProblem({ ...claim, status: "UPHELD" }, "seller") ?? "", /past the seller's answer/);
  const compliance = { id: "desk", role: "ADMIN", deskRole: "COMPLIANCE" };
  const input = { actor: compliance, claim: { ...claim, status: "UNDER_REVIEW" }, partyIds: ["buyer", "seller"], deskParty: false, outcome: "DENIED", amountCents: 0, now: at("2026-11-21") };
  assert.equal(decisionProblem(input), null);
  // Where UPB is a party, no desk member decides, the owner included.
  assert.equal(decisionProblem({ ...input, deskParty: true }), DESK_PARTY_REFUSAL);
  assert.equal(decisionProblem({ ...input, deskParty: true, actor: { id: "owner", role: "ADMIN", deskRole: "OWNER" } }), DESK_PARTY_REFUSAL);
  assert.equal(deskIsParty({ deskBidId: "desk-bid", partyRoles: ["INDIVIDUAL_SELLER"] }), true);
  assert.equal(deskIsParty({ deskBidId: null, partyRoles: ["ADMIN", "BUYER"] }), true);
  assert.equal(deskIsParty({ deskBidId: null, partyRoles: ["INSTITUTIONAL_SELLER", "BUYER", "BUYER"] }), false);
  assert.match(DESK_PARTY_TEXT, /governing law terms of the master agreements/);
  assert.match(decisionProblem({ ...input, partyIds: ["buyer", "seller", "desk"] }) ?? "", /party to this closing/);
  assert.equal(decisionProblem({ ...input, actor: { id: "desk", role: "ADMIN", deskRole: "CLOSINGS" } }), DESK_DENIED);
  assert.equal(decisionProblem({ ...input, actor: { id: "desk", role: "ADMIN", deskRole: "OWNER" } }), null);
  assert.match(decisionProblem({ ...input, claim: { ...claim, respondBy: at("2026-11-25") } }) ?? "", /still has time/);
  assert.match(decisionProblem({ ...input, outcome: "UPHELD", amountCents: null }) ?? "", /what the seller owes/);
  assert.match(decisionProblem({ ...input, outcome: "GRADE_A" }) ?? "", /Choose the outcome/);
  assert.deepEqual(readAnswer("DISPUTE: The tape was right."), { kind: "DISPUTE", text: "The tape was right." });
  assert.deepEqual(readAnswer("ACCEPT"), { kind: "ACCEPT", text: "" });
});

test("the repurchase figure is the loan's price on the schedule, or its share of the pool by balance", () => {
  const loans = [{ id: "a", upb: 300000 }, { id: "b", upb: 100000 }];
  const pool = { salePrice: 200000, buyerPremiumCents: 400000, loans };
  assert.deepEqual(loanPriceCents({ ...pool, loanPrices: { a: 120000, b: 80000 }, noteId: "b" }), { priceCents: 8000000, premiumCents: 160000 });
  assert.deepEqual(loanPriceCents({ ...pool, loanPrices: null, noteId: "b" }), { priceCents: 5000000, premiumCents: 100000 });
  assert.deepEqual(loanPriceCents({ salePrice: 90000, buyerPremiumCents: 180000, loans: [{ id: "a", upb: 1 }], loanPrices: null, noteId: "a" }), { priceCents: 9000000, premiumCents: 180000 });
});

// ---------------------------------------------------------------------------------------------------------------
// On the database: a group closing on a two-loan pool, closed ten days ago. The options make UPB a party: a desk
// account on a seat, a desk account as the seller, or the desk buying for its own book.

async function fixture(tag: string, options: { deskSeat?: boolean; deskSeller?: boolean; deskPurchase?: boolean } = {}) {
  const mk = (who: string, role: "BUYER" | "INDIVIDUAL_SELLER" | "ADMIN", extra: { deskRole?: string } = {}) =>
    prisma.user.create({ data: { email: `claims-${tag}-${who}-${stamp}@example.test`, name: `Claims ${who}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra } });
  const [seller, buyer, seat, stranger, compliance, closer, insider, trader] = await Promise.all([
    options.deskSeller ? mk("seller", "ADMIN", { deskRole: "SALES" }) : mk("seller", "INDIVIDUAL_SELLER"),
    mk("buyer", "BUYER"),
    mk("seat", "BUYER"),
    mk("stranger", "BUYER"),
    mk("compliance", "ADMIN", { deskRole: "COMPLIANCE" }),
    mk("closer", "ADMIN", { deskRole: "CLOSINGS" }),
    // A desk account that takes a seat on the deal when deskSeat is set.
    mk("insider", "ADMIN", { deskRole: "COMPLIANCE" }),
    mk("trader", "ADMIN", { deskRole: "TRADER" }),
  ]);
  const note = (street: string, upb: number) => ({
    streetAddress: street, city: "Tampa", state: "FL", propertyType: "SFR" as const, estimatedValue: 400000, lienPosition: "FIRST" as const,
    upb, interestRate: 6, monthlyPi: 1500, paymentStatus: "PERFORMING" as const, askingPrice: upb * 0.7,
  });
  const listing = await prisma.listing.create({
    data: { kind: "POOL", sellerId: seller.id, status: "SOLD", title: `Claims pool ${tag} ${stamp}`, notes: { create: [note("1 Claim St", 300000), note("2 Claim St", 100000)] } },
    include: { notes: { orderBy: { upb: "desc" } } },
  });
  const [big, small] = listing.notes;
  const inquiry = options.deskPurchase
    ? null
    : await prisma.inquiry.create({
        data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 300000, message: "Claims bid", loanPrices: { [big.id]: 220000, [small.id]: 80000 } },
      });
  const deskBid = options.deskPurchase ? await prisma.deskBid.create({ data: { listingId: listing.id, amount: 300000, status: "ACCEPTED" } }) : null;
  const closedAt = new Date(Date.now() - 10 * DAY);
  const closing = await prisma.closing.create({
    data: {
      listingId: listing.id, inquiryId: inquiry?.id ?? null, deskBidId: deskBid?.id ?? null, status: "COMPLETE", salePrice: 300000, buyerPremiumCents: 600000, sellerCommissionCents: 0,
      buyerTotalCents: 30600000, netToSellerCents: 30000000, openedAt: new Date(closedAt.getTime() - 20 * DAY), closedAt,
      funders: {
        create: options.deskPurchase
          ? []
          : [
              { userId: buyer.id, amount: 150000, premiumCents: 300000, percent: 50 },
              { userId: seat.id, amount: options.deskSeat ? 100000 : 150000, premiumCents: options.deskSeat ? 200000 : 300000, percent: options.deskSeat ? 33.34 : 50 },
              ...(options.deskSeat ? [{ userId: insider.id, amount: 50000, premiumCents: 100000, percent: 16.66 }] : []),
            ],
      },
    },
  });
  const users = [seller, buyer, seat, stranger, compliance, closer, insider, trader];
  const cleanup = async () => {
    const claims = await prisma.repurchaseClaim.findMany({ where: { closingId: closing.id }, select: { id: true } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [closing.id, ...claims.map((claim) => claim.id)] } }, { actorId: { in: users.map((user) => user.id) } }] } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: users.map((user) => user.email) } }, { subject: { contains: stamp } }] } });
    for (const claim of claims) await fs.rm(path.join(uploadDir(), "claims", claim.id), { recursive: true, force: true });
    await prisma.closeAttestation.deleteMany({ where: { closingId: closing.id } });
    await prisma.closing.deleteMany({ where: { id: closing.id } });
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  };
  return { seller, buyer, seat, stranger, compliance, closer, insider, trader, listing, big, small, closing, closedAt, cleanup };
}

test("a claim runs from filing through the seller's dispute and the desk's decision to settlement", async () => {
  const deal = await fixture("flow");
  try {
    const now = new Date();
    const settings = await getSettings();
    const base = { closingId: deal.closing.id, rep: "PAY_HISTORY", noteId: deal.small.id, description: "The tape shows twelve on-time payments, and the servicer history shows four missed.", remedy: "REPURCHASE" };
    // Who may file, and when.
    assert.match((await fileClaim(deal.stranger, base, now)).error ?? "", /Only the buyer/);
    assert.match((await fileClaim(deal.seller, base, now)).error ?? "", /Only the buyer/);
    const late = new Date(deal.closedAt.getTime() + (survivalDaysOf(settings.repSurvivalDays) + 1) * DAY);
    assert.match((await fileClaim(deal.buyer, base, late)).error ?? "", /window for claims closed/);
    assert.match((await fileClaim(deal.buyer, { ...base, noteId: "someone-elses-loan" }, now)).error ?? "", /Choose the loan/);
    assert.match((await fileClaim(deal.buyer, { ...base, remedy: "PRICE_ADJUSTMENT", amount: "90000" }, now)).error ?? "", /can't be more than/);
    assert.match((await fileClaim(deal.buyer, { ...base, files: [{ name: "fake.pdf", bytes: Buffer.from("not a pdf") }] }, now)).error ?? "", /do not match/);

    const filed = await fileClaim(deal.buyer, { ...base, files: [{ name: "history.pdf", type: "application/pdf", bytes: PDF }] }, now);
    assert.equal(filed.error, null);
    if (filed.error !== null) return;
    const claim = filed.claim;
    assert.equal(claim.status, "FILED");
    assert.equal(claim.sellerId, deal.seller.id);
    // The small loan's price on the schedule, $80,000, and its share of the $6,000 premium.
    assert.equal(claim.amountCents, 8000000 + 160000);
    assert.equal(claim.respondBy.getTime(), now.getTime() + responseDaysOf(settings.claimResponseDays) * DAY);
    assert.match((await fileClaim(deal.seat, base, now)).error ?? "", /already open/);
    // A seat on the group files its own claim on another representation.
    const seatClaim = await fileClaim(deal.seat, { ...base, rep: "TITLE", remedy: "CURE" }, now);
    assert.equal(seatClaim.error, null);

    // Who reads what. The seat sees the buyer's claim and that it has a file, never the file itself.
    const sides = { sellerId: deal.seller.id, buyerIds: [deal.buyer.id, deal.seat.id] };
    const forBuyer = (await claimsOnClosing(deal.closing.id, deal.buyer, sides)).find((row) => row.id === claim.id);
    const forSeller = (await claimsOnClosing(deal.closing.id, deal.seller, sides)).find((row) => row.id === claim.id);
    const forSeat = (await claimsOnClosing(deal.closing.id, deal.seat, sides)).find((row) => row.id === claim.id);
    const forDesk = (await claimsOnClosing(deal.closing.id, deal.closer, sides)).find((row) => row.id === claim.id);
    assert.equal(forBuyer?.files.length, 1);
    assert.equal(forSeller?.files.length, 1);
    assert.equal(forDesk?.files.length, 1);
    assert.equal(forSeat?.files.length, 0);
    assert.equal(forSeat?.fileCount, 1);
    assert.deepEqual(await claimsOnClosing(deal.closing.id, deal.stranger, sides), []);
    const stored = await prisma.claimFile.findFirst({ where: { claimId: claim.id } });
    assert.ok(stored && (await fs.readFile(path.join(uploadDir(), stored.storageKey))).equals(PDF));
    assert.equal(await prisma.notification.count({ where: { toEmail: deal.seller.email, subject: { contains: "Repurchase claim filed" } } }), 2);

    // Only the seller answers, and once. A dispute goes to the desk.
    assert.match((await answerClaim(deal.buyer, { claimId: claim.id, kind: "ACCEPT", text: "" }, now)).error ?? "", /Only the seller/);
    assert.match((await answerClaim(deal.seller, { claimId: claim.id, kind: "DISPUTE", text: "Short." }, now)).error ?? "", /Say why/);
    const answered = await answerClaim(deal.seller, { claimId: claim.id, kind: "DISPUTE", text: "The four payments were in a forbearance the file disclosed on page three." }, now);
    assert.equal(answered.error, null);
    assert.equal((await prisma.repurchaseClaim.findUnique({ where: { id: claim.id } }))?.status, "UNDER_REVIEW");
    assert.match((await answerClaim(deal.seller, { claimId: claim.id, kind: "ACCEPT", text: "" }, now)).error ?? "", /already answered/);

    // A role without compliance can't decide it.
    const decision = { claimId: claim.id, outcome: "PARTLY_UPHELD", amount: "$12,500", reason: "Two of the four missed payments fall outside the disclosed forbearance." };
    assert.equal((await decideClaim(deal.closer, decision, now)).error, DESK_DENIED);
    assert.match((await decideClaim(deal.compliance, { ...decision, amount: "" }, now)).error ?? "", /what the seller owes/);
    const decided = await decideClaim(deal.compliance, decision, now);
    assert.equal(decided.error, null);
    const ruled = await prisma.repurchaseClaim.findUnique({ where: { id: claim.id } });
    assert.equal(ruled?.status, "PARTLY_UPHELD");
    assert.equal(ruled?.outcomeCents, 1250000);
    assert.equal(ruled?.decidedById, deal.compliance.id);
    assert.equal(ruled?.resolvedAt ?? null, null);
    assert.match((await withdrawClaim(deal.buyer, { claimId: claim.id }, now)).error ?? "", /decided/);

    // No money moves through UPB: both sides confirm, and only then is it settled.
    assert.match((await confirmSettlement(deal.seat, { claimId: claim.id }, now)).error ?? "", /Only the buyer who filed and the seller/);
    const first = await confirmSettlement(deal.buyer, { claimId: claim.id }, now);
    assert.deepEqual(first, { error: null, settled: false });
    assert.match((await confirmSettlement(deal.buyer, { claimId: claim.id }, now)).error ?? "", /already confirmed/);
    const second = await confirmSettlement(deal.seller, { claimId: claim.id }, now);
    assert.deepEqual(second, { error: null, settled: true });
    const settled = await prisma.repurchaseClaim.findUnique({ where: { id: claim.id } });
    assert.equal(settled?.status, "SETTLED");
    assert.equal(settled?.outcomeCents, 1250000);
    const timeline = (await claimsOnClosing(deal.closing.id, deal.buyer, sides)).find((row) => row.id === claim.id)?.timeline.map((event) => event.text) ?? [];
    assert.equal(timeline.length, 6);
    assert.match(timeline[0], /^The buyer filed on payment history/);
    assert.match(timeline.at(-1) ?? "", /Both sides confirmed/);

    // The buyer who filed may withdraw a claim the desk hasn't decided. Nobody else may.
    if (seatClaim.error !== null) return;
    assert.match((await withdrawClaim(deal.buyer, { claimId: seatClaim.claim.id }, now)).error ?? "", /Only the buyer who filed/);
    assert.equal((await withdrawClaim(deal.seat, { claimId: seatClaim.claim.id }, now)).error, null);
    assert.equal((await prisma.repurchaseClaim.findUnique({ where: { id: seatClaim.claim.id } }))?.status, "WITHDRAWN");
  } finally {
    await deal.cleanup();
  }
});

test("the claim clock reminds the seller once and moves an unanswered claim to the desk once", async () => {
  const deal = await fixture("clock");
  try {
    const now = new Date();
    const filed = await fileClaim(deal.buyer, { closingId: deal.closing.id, rep: "DOCUMENTS", noteId: deal.big.id, description: "The allonge to the current holder was never delivered with the collateral file.", remedy: "CURE" }, now);
    assert.equal(filed.error, null);
    if (filed.error !== null) return;
    const claim = filed.claim;
    const only = { claimIds: [claim.id] };
    assert.equal((await claimClock(new Date(claim.respondBy.getTime() - 3 * DAY), only)).sent, 0);
    const soon = new Date(claim.respondBy.getTime() - DAY);
    assert.equal((await claimClock(soon, only)).sent, 1);
    assert.equal((await claimClock(soon, only)).sent, 0);
    // Two runs at once send one reminder between them.
    await prisma.auditEvent.deleteMany({ where: { entityId: claim.id, action: "CLAIM_REMINDED" } });
    const [one, two] = await Promise.all([claimClock(soon, only), claimClock(soon, only)]);
    assert.equal(one.sent + two.sent, 1);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: claim.id, action: "CLAIM_REMINDED" } }), 1);

    const past = new Date(claim.respondBy.getTime() + 60 * 1000);
    assert.equal((await claimClock(past, only)).sent, 1);
    assert.equal((await prisma.repurchaseClaim.findUnique({ where: { id: claim.id } }))?.status, "UNDER_REVIEW");
    assert.equal((await claimClock(past, only)).sent, 0);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: claim.id, action: "CLAIM_OVERDUE" } }), 1);
    assert.ok((await prisma.notification.count({ where: { toEmail: deal.compliance.email, subject: { contains: "Claim to review" } } })) >= 1);
    // The seller can still answer while the desk reviews, and the desk can decide now.
    assert.equal((await answerClaim(deal.seller, { claimId: claim.id, kind: "CURE", text: "The allonge went out by courier today." }, past)).error, null);
  } finally {
    await deal.cleanup();
  }
});

test("each side answers its questions once per closing, and can change them for 30 days", async () => {
  const deal = await fixture("attest");
  try {
    const now = new Date();
    const lead = { deskBidId: null, sellerId: deal.seller.id, leadBuyerId: deal.buyer.id };
    assert.equal(attestationSide(lead, deal.buyer.id), "BUYER");
    assert.equal(attestationSide(lead, deal.seller.id), "SELLER");
    assert.equal(attestationSide(lead, deal.seat.id), null);
    assert.equal(attestationSide({ ...lead, deskBidId: "desk" }, deal.seller.id), null);
    assert.match(attestationProblem({ status: "OPEN", side: "BUYER", existing: null, userId: "b", now }) ?? "", /once the closing has closed/);

    assert.match((await saveAttestation(deal.buyer, { closingId: deal.closing.id, answers: { fileAsDescribed: "yes" } }, now)).error ?? "", /collateral arrived complete/);
    assert.match((await saveAttestation(deal.seat, { closingId: deal.closing.id, answers: { fileAsDescribed: "yes", collateralComplete: "yes" } }, now)).error ?? "", /Only the buyer and the seller/);
    const buyerFirst = await saveAttestation(deal.buyer, { closingId: deal.closing.id, answers: { fileAsDescribed: "yes", collateralComplete: "no" }, note: "The allonge was missing." }, now);
    assert.equal(buyerFirst.error, null);
    const buyerAgain = await saveAttestation(deal.buyer, { closingId: deal.closing.id, answers: { fileAsDescribed: "yes", collateralComplete: "yes" } }, new Date(now.getTime() + 29 * DAY));
    assert.equal(buyerAgain.error === null && buyerAgain.created, false);
    assert.match((await saveAttestation(deal.buyer, { closingId: deal.closing.id, answers: { fileAsDescribed: "no", collateralComplete: "no" } }, new Date(now.getTime() + 31 * DAY))).error ?? "", /changed for 30 days/);
    // Two submits at once still leave one answer for the side.
    await Promise.all([
      saveAttestation(deal.seller, { closingId: deal.closing.id, answers: { fundedOnTime: "yes" } }, now),
      saveAttestation(deal.seller, { closingId: deal.closing.id, answers: { fundedOnTime: "yes" } }, now),
    ]);
    const rows = await prisma.closeAttestation.findMany({ where: { closingId: deal.closing.id }, orderBy: { side: "asc" } });
    assert.deepEqual(rows.map((row) => row.side), ["BUYER", "SELLER"]);
    assert.equal(rows[0].collateralComplete, true);
    assert.equal(rows[0].fundedOnTime ?? null, null);
    assert.equal(rows[1].fundedOnTime, true);
  } finally {
    await deal.cleanup();
  }
});

test("where UPB is a party, both sides still file, answer and settle, and no desk member decides", async () => {
  const deals = await Promise.all([fixture("seat", { deskSeat: true }), fixture("sold", { deskSeller: true }), fixture("bought", { deskPurchase: true })]);
  const [seated, sold, bought] = deals;
  try {
    const now = new Date();
    const claimOn = (deal: (typeof deals)[number], filer: { id: string; role: string; deskRole?: string | null }, extra: Record<string, unknown> = {}) =>
      fileClaim(filer, { closingId: deal.closing.id, rep: "LIEN_POSITION", noteId: deal.big.id, description: "A senior lien recorded before the mortgage was never disclosed on the tape.", remedy: "REPURCHASE", ...extra }, now);
    const decision = (claimId: string) => ({ claimId, outcome: "UPHELD", amount: "1000", reason: "The title search shows the senior lien." });

    // A desk account on a seat: the buyer files and the seller disputes as usual, and nobody on the desk decides.
    const one = await claimOn(seated, seated.buyer);
    assert.equal(one.error, null);
    if (one.error !== null) return;
    assert.equal((await answerClaim(seated.seller, { claimId: one.claim.id, kind: "DISPUTE", text: "The senior lien was released before closing, and the release is recorded." }, now)).error, null);
    assert.equal((await decideClaim(seated.compliance, decision(one.claim.id), now)).error, DESK_PARTY_REFUSAL);
    assert.equal((await decideClaim(seated.insider, decision(one.claim.id), now)).error, DESK_PARTY_REFUSAL);
    assert.deepEqual(await confirmSettlement(seated.buyer, { claimId: one.claim.id }, now), { error: null, settled: false });
    assert.deepEqual(await confirmSettlement(seated.seller, { claimId: one.claim.id }, now), { error: null, settled: true });
    assert.equal((await prisma.repurchaseClaim.findUnique({ where: { id: one.claim.id } }))?.status, "SETTLED");

    // A desk account as the seller: it answers, nothing goes to the desk, and both sides settle at what was asked.
    const two = await claimOn(sold, sold.buyer);
    assert.equal(two.error, null);
    if (two.error !== null) return;
    assert.equal((await answerClaim(sold.seller, { claimId: two.claim.id, kind: "ACCEPT", text: "" }, now)).error, null);
    assert.equal((await askDeskReview(sold.buyer, { claimId: two.claim.id, reason: "The seller hasn't repurchased yet." }, now)).error, DESK_PARTY_TEXT);
    assert.equal((await decideClaim(sold.compliance, decision(two.claim.id), now)).error, DESK_PARTY_REFUSAL);
    await confirmSettlement(sold.seller, { claimId: two.claim.id }, now);
    await confirmSettlement(sold.buyer, { claimId: two.claim.id }, now);
    const settled = await prisma.repurchaseClaim.findUnique({ where: { id: two.claim.id } });
    assert.equal(settled?.status, "SETTLED");
    assert.equal(settled?.outcomeCents, two.claim.amountCents);

    // The desk's own purchase: a desk-book member files for UPB; a buyer or a desk role without the book can't.
    assert.match((await claimOn(bought, bought.buyer)).error ?? "", /desk-book member/);
    assert.match((await claimOn(bought, bought.compliance)).error ?? "", /desk-book member/);
    const three = await claimOn(bought, bought.trader, { remedy: "CURE" });
    assert.equal(three.error, null);
    if (three.error !== null) return;
    // Unanswered, it stops at "not agreed" and the desk hears it isn't theirs to decide.
    assert.equal((await claimClock(new Date(three.claim.respondBy.getTime() + 60 * 1000), { claimIds: [three.claim.id] })).sent, 1);
    assert.equal((await prisma.repurchaseClaim.findUnique({ where: { id: three.claim.id } }))?.status, "UNDER_REVIEW");
    assert.match((await prisma.auditEvent.findFirst({ where: { entityId: three.claim.id, action: "CLAIM_OVERDUE" } }))?.detail ?? "", /UPB is a party/);
    assert.equal((await decideClaim(bought.compliance, decision(three.claim.id), now)).error, DESK_PARTY_REFUSAL);
    const queue = await deskClaimQueue();
    assert.ok(queue.deskParty.some((row) => row.id === three.claim.id && row.deskParty));
    assert.ok(!queue.review.some((row) => row.id === three.claim.id));
    assert.equal((await confirmSettlement(bought.trader, { claimId: three.claim.id }, now)).error, null);
    assert.deepEqual(await confirmSettlement(bought.seller, { claimId: three.claim.id }, now), { error: null, settled: true });
  } finally {
    for (const deal of deals) await deal.cleanup();
  }
});
