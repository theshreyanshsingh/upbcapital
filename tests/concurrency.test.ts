import assert from "node:assert/strict";
import test from "node:test";
import { purgeApiCalls } from "../lib/api-log";
import { awardOffer } from "../lib/awards";
import { placeInquiry } from "../lib/bid-form";
import { answerRequest, createRequest, OPEN_LIMIT, setRequestStatus, type RequestInput } from "../lib/bids-wanted";
import { literal, unset } from "../lib/db-filters";
import { decideDepositOutcome, proposeDepositOutcome } from "../lib/deposits";
import { createGuestPass, LIVE_PASS_LIMIT } from "../lib/guest-access";
import { fundsExposure, placeBuyNow } from "../lib/inquiry";
import { remindSaleNotices } from "../lib/jobs";
import { launchNow, runLaunches } from "../lib/launch";
import { addWatchedNote, MAX_WATCHED, sendNoteWatch } from "../lib/note-watch";
import { approveBrokerFee, recordBrokerFeePaid } from "../lib/payout-accounts";
import { prisma } from "../lib/prisma";
import { runFreshness } from "../lib/provenance";
import { requestReviews } from "../lib/reviews";
import { setShortlist } from "../lib/sale-rounds";
import { approveSeatBid, resolveSessionUser } from "../lib/seats";
import { getSettings } from "../lib/settings";
import { confirmStanding } from "../lib/standing-bids";
import { confirmReceived } from "../lib/trailing-docs";
import { exposureByKey } from "../lib/verification";
import { decideWireChange, proposeWireChange } from "../lib/wire-changes";

// Each case fires one action many times at once against one record, the way a double click, a second tab or two
// people racing for the same note would, and then checks the invariant the action promises. Mail stays in the log,
// files stay on disk, signing stays in the app, and screens use the local stand-in list, whatever the .env says.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";
process.env.RATE_LIMIT_STORE = "memory";
// Review links are signed, so the review job needs a secret. A test value, never a real one.
process.env.AUTH_SECRET ||= "concurrency-test-secret-not-for-production-0001";

const DAY = 24 * 60 * 60 * 1000;
const RUN = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;

test.after(async () => {
  await prisma.$disconnect();
});

type Role = "BUYER" | "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BROKER" | "ADMIN";

const loan = (street: string, extra: Record<string, unknown> = {}) => ({
  streetAddress: street, city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 120000, estimatedValue: 260000, ...extra,
});

// Every person, listing and title a case makes carries its tag, so other test files on the same database never meet
// these rows, and the case removes only what it made.
function world(name: string) {
  const tag = `race-${name}-${RUN}`;
  const users: { id: string; email: string }[] = [];
  const listings: string[] = [];
  const user = async (who: string, role: Role, data: Record<string, unknown> = {}) => {
    const row = await prisma.user.create({
      data: { email: `${tag}-${who}@example.org`, name: `${who} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", emailConfirmedAt: new Date(), ...data } as never,
    });
    users.push({ id: row.id, email: row.email });
    return row;
  };
  // An approved Pro buyer on a current file, past the new-bidder cap.
  const buyer = async (who: string, file: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => {
    const row = await user(who, "BUYER", { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE", bidCapLifted: true, ...data });
    await prisma.buyerProfile.create({
      data: { userId: row.id, status: "APPROVED", entityType: "LLC", entityName: `Fund ${who} ${tag}`, homesControlled: 4, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY), ...file } as never,
    });
    return row;
  };
  const listing = async (sellerId: string, label: string, data: Record<string, unknown> = {}, loans = 1) => {
    const row = await prisma.listing.create({
      data: {
        kind: loans > 1 ? "POOL" : "SINGLE",
        sellerId,
        status: "APPROVED",
        approvedAt: new Date(Date.now() - 7 * DAY),
        standingBidsNotifiedAt: new Date(),
        title: `${label} ${tag}`,
        notes: { create: Array.from({ length: loans }, (_, index) => loan(`${index + 1} Race St`)) },
        ...data,
      } as never,
      include: { notes: true },
    });
    listings.push(row.id);
    return row;
  };
  const clean = async () => {
    const userIds = users.map((row) => row.id);
    const emails = users.map((row) => row.email);
    const inquiryIds = (await prisma.inquiry.findMany({ where: { OR: [{ listingId: { in: listings } }, { buyerId: { in: userIds } }] }, select: { id: true } })).map((row) => row.id);
    const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listings } }, select: { id: true } })).map((row) => row.id);
    const requestIds = (await prisma.buyerRequest.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
    const approvalIds = (await prisma.seatApproval.findMany({ where: { principalId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
    const watchIds = (await prisma.trackedNote.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
    const feeIds = (await prisma.brokerFee.findMany({ where: { closingId: { in: closingIds } }, select: { id: true } })).map((row) => row.id);
    const accountIds = (await prisma.payoutAccount.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
    const entityIds = [...listings, ...userIds, ...inquiryIds, ...closingIds, ...requestIds, ...approvalIds, ...watchIds, ...feeIds, ...accountIds];
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: entityIds } }, { actorId: { in: userIds } }] } });
    await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listings } }, { inquiryId: { in: inquiryIds } }, { closingId: { in: closingIds } }] } });
    await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
    await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.invoice.deleteMany({ where: { closingId: { in: closingIds } } });
    await prisma.trailingDoc.deleteMany({ where: { closingId: { in: closingIds } } });
    await prisma.wireChange.deleteMany({ where: { closingId: { in: closingIds } } });
    await prisma.brokerFee.deleteMany({ where: { closingId: { in: closingIds } } });
    await prisma.guestPass.deleteMany({ where: { OR: [{ closingId: { in: closingIds } }, { listingId: { in: listings } }, { createdById: { in: userIds } }] } });
    await prisma.requestResponse.deleteMany({ where: { OR: [{ requestId: { in: requestIds } }, { listingId: { in: listings } }] } });
    await prisma.buyerRequest.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.listingInvite.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.listingMatch.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.buyBox.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.trackedNote.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.seatApproval.deleteMany({ where: { principalId: { in: userIds } } });
    await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.payoutAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.groupBuy.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
    await prisma.closing.deleteMany({ where: { id: { in: closingIds } } });
    await prisma.note.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.listing.deleteMany({ where: { id: { in: listings } } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: emails } }, { userId: { in: userIds } }, { subject: { contains: literal(tag) } }] } });
    await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.serverSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  };
  return { tag, users, user, buyer, listing, clean };
}

// Fires each call at once and waits for all of them. A call that threw fails the case with its reason.
async function burst<T>(calls: (() => Promise<T>)[]) {
  const settled = await Promise.allSettled(calls.map((call) => Promise.resolve().then(call)));
  const thrown = settled.filter((row): row is PromiseRejectedResult => row.status === "rejected");
  assert.equal(thrown.length, 0, `calls threw: ${thrown.map((row) => (row.reason instanceof Error ? row.reason.message : String(row.reason)).split("\n")[0]).join(" | ")}`);
  return settled.map((row) => (row as PromiseFulfilledResult<T>).value);
}

const times = <T>(count: number, call: () => Promise<T>) => Array.from({ length: count }, () => call);
const interleave = <T>(...groups: (() => Promise<T>)[][]) => {
  const out: (() => Promise<T>)[] = [];
  for (let index = 0; index < Math.max(...groups.map((group) => group.length)); index += 1) for (const group of groups) if (group[index]) out.push(group[index]);
  return out;
};
const notices = (where: { toEmail?: string; subject: string }) =>
  prisma.notification.count({ where: { ...(where.toEmail ? { toEmail: where.toEmail } : {}), subject: { contains: literal(where.subject) } } });

// ---------------------------------------------------------------------------------------------------------------
// 1. Awards

test("a double-clicked award opens one closing, and so do two bids awarded at once on a single note", async () => {
  const w = world("award");
  try {
    const seller = await w.user("seller", "INDIVIDUAL_SELLER");
    const desk = await w.user("desk", "ADMIN");
    const first = await w.buyer("first");
    const second = await w.buyer("second");

    // The same bid, awarded twelve times at once.
    const one = await w.listing(seller.id, "Same bid", { reservePrice: 1000 });
    const bid = await prisma.inquiry.create({ data: { listingId: one.id, buyerId: first.id, type: "OFFER", status: "OPEN", amount: 90000 } });
    const rival = await prisma.inquiry.create({ data: { listingId: one.id, buyerId: second.id, type: "OFFER", status: "OPEN", amount: 85000 } });
    const same = await burst(times(12, () => awardOffer(bid.id, desk.id)));
    assert.equal(same.filter((result) => result.error === null).length, 1);
    assert.equal(await prisma.closing.count({ where: { listingId: one.id } }), 1);
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: one.id } });
    assert.equal(listing.status, "PENDING");
    assert.equal(listing.acceptedInquiryId, bid.id);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: bid.id } })).status, "ACCEPTED");
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: rival.id } })).status, "DECLINED");
    assert.equal(await prisma.auditEvent.count({ where: { entityId: bid.id, action: "AWARD" } }), 1);
    assert.equal(await notices({ toEmail: seller.email, subject: `Offer accepted · ${one.title}` }), 1);
    assert.equal(await notices({ toEmail: second.email, subject: `Bid not selected · ${one.title}` }), 1);

    // Two bids on one note, each awarded several times at once: one wins, and the other is declined, not left live.
    for (let round = 0; round < 3; round += 1) {
      const two = await w.listing(seller.id, `Two bids ${round}`, { reservePrice: 1000 });
      const a = await prisma.inquiry.create({ data: { listingId: two.id, buyerId: first.id, type: "OFFER", status: "OPEN", amount: 90000 } });
      const b = await prisma.inquiry.create({ data: { listingId: two.id, buyerId: second.id, type: "OFFER", status: "OPEN", amount: 95000 } });
      const results = await burst(interleave(times(8, () => awardOffer(a.id, desk.id)), times(8, () => awardOffer(b.id, desk.id))));
      assert.equal(results.filter((result) => result.error === null).length, 1, `round ${round}`);
      const closings = await prisma.closing.findMany({ where: { listingId: two.id } });
      assert.equal(closings.length, 1, `round ${round}`);
      const winner = closings[0].inquiryId;
      const loser = winner === a.id ? b.id : a.id;
      const after = await prisma.listing.findUniqueOrThrow({ where: { id: two.id } });
      assert.equal(after.status, "PENDING");
      assert.equal(after.acceptedInquiryId, winner);
      assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: winner! } })).status, "ACCEPTED");
      assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: loser } })).status, "DECLINED", `round ${round}: the losing bid is closed`);
      assert.equal(await prisma.auditEvent.count({ where: { entityId: { in: [a.id, b.id] }, action: "AWARD" } }), 1);
    }
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Buy it now

test("buyers racing for buy it now, some clicking twice, open one closing and the rest are refused owing nothing", async () => {
  const w = world("buynow");
  try {
    const seller = await w.user("seller", "INDIVIDUAL_SELLER");
    const buyers = [];
    for (let index = 0; index < 8; index += 1) buyers.push(await w.buyer(`buyer${index}`));
    const listing = await w.listing(seller.id, "Buy now", { buyNowPrice: 150000, buyNowSetAt: new Date(), buyNowConsent: "Test consent." });
    const results = await burst(interleave(...buyers.map((user) => times(2, () => placeBuyNow({ user, listingId: listing.id, price: 150000 })))));
    const won = results.filter((result) => result.error === null);
    assert.equal(won.length, 1);
    for (const lost of results.filter((result) => result.error !== null)) {
      assert.match(lost.error ?? "", /Another buyer confirmed first|already confirmed buy it now|not taking new inquiries/);
    }
    const closings = await prisma.closing.findMany({ where: { listingId: listing.id } });
    assert.equal(closings.length, 1);
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(after.status, "PENDING");
    assert.equal(after.acceptedInquiryId, closings[0].inquiryId);
    // No bid is left waiting on a listing already in contract.
    assert.equal(await prisma.inquiry.count({ where: { listingId: listing.id, status: { in: ["OPEN", "REVIEWED"] } } }), 0);
    assert.equal(await prisma.inquiry.count({ where: { listingId: listing.id, status: "ACCEPTED" } }), 1);
    assert.equal(await notices({ toEmail: seller.email, subject: `Sold at your buy-it-now price · ${listing.title}` }), 1);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The funds ceiling

test("bids sent at once on different listings never hold more than the buyer's verified funds", async () => {
  const w = world("funds");
  try {
    const seller = await w.user("seller", "INDIVIDUAL_SELLER");
    const ceiling = 250000;
    const buyer = await w.buyer("buyer", { proofAmount: ceiling, proofVerifiedAt: new Date(Date.now() - DAY), proofExpiresAt: new Date(Date.now() + 30 * DAY) });
    const acting = (await resolveSessionUser(buyer.id))!.user;
    const form = (listingId: string) => {
      const data = new FormData();
      data.set("listingId", listingId);
      data.set("type", "OFFER");
      data.set("amount", "100000");
      data.set("message", "Race test bid.");
      return data;
    };
    // Each bid is $100,000 before the premium, so two fit under $250,000 and a third doesn't. They come through the
    // bid form, buy it now and confirmed standing bids, the three ways a bid is written.
    const calls: (() => Promise<{ error: string | null }>)[] = [];
    for (let index = 0; index < 6; index += 1) {
      const row = await w.listing(seller.id, `Funds form ${index}`);
      calls.push(() => placeInquiry(acting, form(row.id)));
    }
    for (let index = 0; index < 2; index += 1) {
      const row = await w.listing(seller.id, `Funds buy now ${index}`, { buyNowPrice: 100000, buyNowSetAt: new Date(), buyNowConsent: "Test consent." });
      calls.push(() => placeBuyNow({ user: buyer, listingId: row.id, price: 100000 }));
    }
    for (let index = 0; index < 2; index += 1) {
      const row = await w.listing(seller.id, `Funds standing ${index}`);
      const box = await prisma.buyBox.create({ data: { userId: buyer.id, name: `Box ${index} ${w.tag}`, states: "ZZ", standingBids: true, bidBasis: "UPB", bidPercent: 50 } as never });
      const match = await prisma.listingMatch.create({ data: { listingId: row.id, buyBoxId: box.id, userId: buyer.id, score: 90, indicativePrice: 100000, indicativeAt: new Date(), invitedAt: new Date() } });
      calls.push(() => confirmStanding({ matchId: match.id, user: buyer, price: 100000, goodUntil: "" }));
    }
    const results = await burst(calls);
    const held = exposureByKey(await fundsExposure(buyer.id, (await getSettings()).buyerPremiumBps));
    const total = Object.values(held).reduce((sum, allIn) => sum + allIn, 0);
    const placed = Object.keys(held).length;
    assert.ok(total <= ceiling + 0.01, `${placed} bids went in, holding $${Math.round(total).toLocaleString("en-US")} against $${ceiling.toLocaleString("en-US")} of verified funds`);
    assert.equal(results.filter((result) => result.error === null).length, placed);
    for (const refused of results.filter((result) => result.error !== null)) assert.match(refused.error ?? "", /over your verified funds/);
    // A standing bid refused on the funds can be confirmed again later.
    const reopened = await prisma.listingMatch.count({ where: { userId: buyer.id, ...unset("answeredAt") } });
    assert.equal(reopened, 2 - (await prisma.listingMatch.count({ where: { userId: buyer.id, inquiryId: { not: null } } })));
  } finally {
    await w.clean();
  }
});

test("a best-and-final bid sent several times at once leaves the buyer one bid", async () => {
  const w = world("final");
  try {
    const seller = await w.user("seller", "INDIVIDUAL_SELLER");
    const buyer = await w.buyer("buyer");
    const listing = await w.listing(seller.id, "Best and final", { bidMode: "BEST_AND_FINAL", bidDeadline: new Date(Date.now() + 3 * DAY) });
    const acting = (await resolveSessionUser(buyer.id))!.user;
    const form = () => {
      const data = new FormData();
      data.set("listingId", listing.id);
      data.set("type", "OFFER");
      data.set("amount", "100000");
      data.set("message", "Best and final.");
      return data;
    };
    const results = await burst(times(8, () => placeInquiry(acting, form())));
    const bids = await prisma.inquiry.count({ where: { listingId: listing.id, buyerId: buyer.id, type: "OFFER" } });
    assert.equal(bids, results.filter((result) => result.error === null).length);
    assert.ok(bids <= 1, `${bids} best-and-final bids from one buyer`);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Seat approvals

test("approvers deciding the same held bid at once place it once", async () => {
  const w = world("seats");
  try {
    const seller = await w.user("seller", "INDIVIDUAL_SELLER");
    const firm = await w.buyer("firm", {}, { companyName: `Race Bank ${RUN}` });
    const seat = (who: string, seatRole: string, limit: number | null = null) =>
      w.user(who, "BUYER", { principalId: firm.id, seatRole, seatBidLimitCents: limit, seatAddedById: firm.id, seatAddedAt: new Date() });
    const trader = await seat("trader", "TRADE", 5_000_000);
    const approver = await seat("approver", "APPROVE");
    const manager = await seat("manager", "MANAGE");
    const listing = await w.listing(seller.id, "Seat bid");
    const form = new FormData();
    form.set("listingId", listing.id);
    form.set("type", "OFFER");
    form.set("amount", "80000");
    form.set("message", "Above the trader's limit.");
    const held = await placeInquiry((await resolveSessionUser(trader.id))!.user, form);
    assert.ok(held.error === null && held.heldId, held.error ?? "the bid wasn't held");
    const deciders = await Promise.all([approver.id, manager.id, firm.id].map(async (id) => (await resolveSessionUser(id))!.user));
    const results = await burst(interleave(...deciders.map((user) => times(5, () => approveSeatBid(user, held.heldId!)))));
    assert.equal(results.filter((result) => result.error === null).length, 1);
    assert.equal(await prisma.inquiry.count({ where: { listingId: listing.id, type: "OFFER" } }), 1);
    const approval = await prisma.seatApproval.findUniqueOrThrow({ where: { id: held.heldId! } });
    assert.equal(approval.status, "APPROVED");
    assert.ok(approval.inquiryId);
    assert.equal(await notices({ toEmail: trader.email, subject: `Bid approved · ${listing.title}` }), 1);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Two-person controls

async function deskTeam(w: ReturnType<typeof world>) {
  const desk = (who: string) => w.user(who, "ADMIN", { deskRole: "CLOSINGS" });
  return { proposer: await desk("proposer"), others: [await desk("second"), await desk("third"), await desk("fourth")] };
}

async function closingFor(w: ReturnType<typeof world>, label: string, data: Record<string, unknown> = {}) {
  const seller = await w.user(`${label}-seller`, "INDIVIDUAL_SELLER");
  const buyer = await w.buyer(`${label}-buyer`);
  const listing = await w.listing(seller.id, label, { status: "PENDING" });
  const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 100000 } });
  const closing = await prisma.closing.create({
    data: {
      listingId: listing.id, inquiryId: inquiry.id, noteId: null, status: "OPEN", salePrice: 100000, buyerPremiumCents: 0, sellerCommissionCents: 0,
      buyerTotalCents: 10000000, netToSellerCents: 10000000, wireInstructions: `Old wires ${w.tag}`, ...data,
    } as never,
  });
  return { seller, buyer, listing, closing };
}

test("a wire change: the proposer can't approve it, a double proposal waits once, and approvals at once decide it once", async () => {
  const w = world("wires");
  try {
    const { proposer, others } = await deskTeam(w);
    const { seller, closing } = await closingFor(w, "Wires");
    const proposals = await burst(times(6, () => proposeWireChange(proposer, { closingId: closing.id, instructions: `New wires ${w.tag}`, reason: "Bank changed." })));
    assert.equal(proposals.filter((result) => result.error === null).length, 1, `proposals: ${proposals.map((result) => result.error ?? "ok").join(" | ")}`);
    const pending = await prisma.wireChange.findMany({ where: { closingId: closing.id, status: "PENDING" } });
    assert.equal(pending.length, 1, "one proposal waits");
    const change = pending[0];
    const results = await burst(
      interleave(...[proposer, ...others].map((actor) => times(4, () => decideWireChange(actor, { changeId: change.id, decision: "APPROVED" }).then((result) => ({ actor: actor.id, result }))))),
    );
    assert.equal(results.filter((row) => row.result.error === null).length, 1, `decisions: ${results.map((row) => row.result.error ?? "ok").join(" | ")}`);
    for (const row of results.filter((item) => item.actor === proposer.id)) assert.match(row.result.error ?? "", /You proposed this change|already decided/);
    const decided = await prisma.wireChange.findUniqueOrThrow({ where: { id: change.id } });
    assert.equal(decided.status, "APPROVED");
    assert.notEqual(decided.decidedById, proposer.id);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).wireInstructions, `New wires ${w.tag}`);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: closing.id, action: "WIRE_APPROVED" } }), 1);
    assert.equal(await notices({ toEmail: seller.email, subject: "Wires changed" }), 1);
    // The proposer alone never approves.
    const solo = await proposeWireChange(proposer, { closingId: closing.id, instructions: `Newer wires ${w.tag}` });
    assert.ok(solo.error === null && solo.change);
    assert.equal((await decideWireChange(proposer, { changeId: solo.change.id, decision: "APPROVED" })).error, "You proposed this change, so another desk member approves it.");
  } finally {
    await w.clean();
  }
});

test("a deposit refund or forfeit: proposed once, never approved by the proposer, and decided once", async () => {
  const w = world("deposit");
  try {
    const { proposer, others } = await deskTeam(w);
    for (const outcome of ["REFUNDED", "FORFEITED"] as const) {
      const canceled = {
        status: "CANCELED", canceledAt: new Date(), depositReceivedCents: 500000, cancelFault: outcome === "FORFEITED" ? "BUYER" : "SELLER",
        cancelReason: "Race test cancel.", diligenceEndsAt: new Date(Date.now() - 10 * DAY),
      };
      const { buyer, closing } = await closingFor(w, `Deposit ${outcome}`, canceled);
      const proposals = await burst(times(6, () => proposeDepositOutcome(proposer, { closingId: closing.id, outcome, note: "The rules give this outcome for the race test." })));
      assert.equal(proposals.filter((result) => result.error === null).length, 1, outcome);
      assert.equal(await prisma.auditEvent.count({ where: { entityId: closing.id, action: "DEPOSIT_PROPOSED" } }), 1, outcome);
      const decide = (actor: { id: string; role: string; deskRole?: string | null }) => () =>
        decideDepositOutcome(actor, { closingId: closing.id, decision: "APPROVED", reference: "WIRE-RACE-1" }).then((result) => ({ actor: actor.id, result }));
      const results = await burst(interleave(...[proposer, ...others].map((actor) => times(4, decide(actor)))));
      assert.equal(results.filter((row) => row.result.error === null).length, 1, outcome);
      for (const row of results.filter((item) => item.actor === proposer.id)) assert.match(row.result.error ?? "", /You proposed this|decided a moment ago|waiting for approval/, outcome);
      const after = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
      assert.equal(after.depositStatus, outcome);
      assert.ok(after.depositResolvedById && after.depositResolvedById !== proposer.id, outcome);
      assert.equal(await prisma.auditEvent.count({ where: { entityId: closing.id, action: "DEPOSIT_APPROVED" } }), 1, outcome);
      // The buyer heard once on the proposal and once on the decision.
      assert.equal(await notices({ toEmail: buyer.email, subject: "Your deposit" }), 2, outcome);
    }
  } finally {
    await w.clean();
  }
});

test("a broker fee is approved once and recorded paid once, by two different desk members", async () => {
  const w = world("brokerfee");
  try {
    const { proposer: approverA, others } = await deskTeam(w);
    const broker = await w.user("broker", "BROKER", { brokerProfile: { create: { company: `Brokerage ${RUN}`, states: "FL", payoutNote: "ACH." } } });
    const { closing } = await closingFor(w, "Broker fee", { status: "COMPLETE", closedAt: new Date() });
    const account = await prisma.payoutAccount.create({
      data: { userId: broker.id, bankName: "First Race Bank", accountName: broker.name, routingNumber: "021000021", accountLast4: "7777", status: "VERIFIED", screenResult: "CLEAR", screenedAt: new Date(), verifiedAt: new Date() },
    });
    const fee = await prisma.brokerFee.create({ data: { closingId: closing.id, brokerId: broker.id, role: "AFFILIATE", amountCents: 50000, basis: "FLAT" } });
    const approvers = [approverA, ...others.slice(0, 1)];
    const approvals = await burst(interleave(...approvers.map((actor) => times(5, () => approveBrokerFee(actor, { feeId: fee.id, accountId: account.id })))));
    assert.equal(approvals.filter((result) => result.error === null).length, 1);
    const approved = await prisma.brokerFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.ok(approved.approvedById && approvers.some((actor) => actor.id === approved.approvedById));
    assert.equal(await prisma.auditEvent.count({ where: { entityId: fee.id, action: "BROKER_FEE_APPROVED" } }), 1);
    const everyone = [approverA, ...others];
    const payments = await burst(interleave(...everyone.map((actor) => times(4, () => recordBrokerFeePaid(actor, { feeId: fee.id })))));
    assert.equal(payments.filter((result) => result.error === null).length, 1);
    const paid = await prisma.brokerFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(paid.status, "PAID");
    assert.ok(paid.paidById && paid.paidById !== paid.approvedById, "the member who approved it never records it paid");
    assert.equal(await prisma.auditEvent.count({ where: { entityId: fee.id, action: "broker.paid" } }), 1);
    assert.equal(await notices({ toEmail: broker.email, subject: "Broker fee marked paid" }), 1);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Limits

const WANT = (tag: string): RequestInput => ({
  title: `Performing firsts ${tag}`,
  kind: "POOL",
  liens: ["FIRST"],
  statuses: ["PERFORMING"],
  programs: [],
  states: "tx",
  upbMin: "1M",
  upbMax: "",
  minLoans: "",
  maxLoans: "",
  priceToUpbMax: "85%",
  targetYield: "",
  notes: "",
  expiryDays: "60",
});

test("ten buyer requests posted at once leave the firm at its open limit", async () => {
  const w = world("requests");
  try {
    const buyer = await w.buyer("buyer", { entityType: "FUND" });
    const results = await burst(Array.from({ length: 10 }, (_, index) => () => createRequest(buyer, { ...WANT(w.tag), title: `Performing firsts ${index} ${w.tag}` })));
    const posted = results.filter((result) => result.ok).length;
    const live = await prisma.buyerRequest.count({ where: { userId: buyer.id, status: "OPEN" } });
    assert.equal(live, posted);
    assert.ok(live <= OPEN_LIMIT, `${live} requests are open against a limit of ${OPEN_LIMIT}`);
    // The earlier requests stay, so the firm still gets its full limit.
    assert.equal(live, OPEN_LIMIT);
    for (const refused of results.filter((result) => !result.ok)) assert.match(refused.ok ? "" : refused.error, /the most at once/);

    // Paused requests resumed at once, while new ones are posted, hold the same limit.
    await prisma.buyerRequest.deleteMany({ where: { userId: buyer.id } });
    const paused = [];
    for (let index = 0; index < 4; index += 1) {
      const made = await createRequest(buyer, { ...WANT(w.tag), title: `Paused firsts ${index} ${w.tag}` });
      assert.ok(made.ok, made.ok ? "" : made.error);
      assert.ok((await setRequestStatus(buyer, made.value.id, "PAUSE")).ok);
      paused.push(made.value.id);
    }
    for (let index = 0; index < 2; index += 1) assert.ok((await createRequest(buyer, { ...WANT(w.tag), title: `Open firsts ${index} ${w.tag}` })).ok);
    await burst<unknown>([
      ...paused.map((id) => () => setRequestStatus(buyer, id, "RESUME")),
      ...Array.from({ length: 4 }, (_, index) => () => createRequest(buyer, { ...WANT(w.tag), title: `More firsts ${index} ${w.tag}` })),
    ]);
    const after = await prisma.buyerRequest.count({ where: { userId: buyer.id, status: "OPEN" } });
    assert.ok(after <= OPEN_LIMIT, `${after} requests are open after resuming, against a limit of ${OPEN_LIMIT}`);
    // A resume refused at the limit is paused again, not lost.
    assert.equal(await prisma.buyerRequest.count({ where: { id: { in: paused }, status: { in: ["OPEN", "PAUSED"] } } }), paused.length);
  } finally {
    await w.clean();
  }
});

test("ten notes added at once never take a holder past the watch limit", async () => {
  const w = world("watch");
  try {
    const seller = await w.user("seller", "INDIVIDUAL_SELLER");
    await prisma.trackedNote.createMany({
      data: Array.from({ length: MAX_WATCHED - 5 }, (_, index) => ({ userId: seller.id, label: `Held ${index} ${w.tag}`, state: "FL", propertyType: "SFR", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 150000, interestRate: 7, monthlyPi: 1100, estimatedValue: 240000 })),
    });
    const form = (index: number) => ({ label: `Added ${index}`, state: "FL", propertyType: "SFR", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: "150000", interestRate: "7", monthlyPi: "1100", estimatedValue: "240000", originationDate: "2021-03-01", maturityDate: "2051-03-01", occupancy: "", seniorLienBalance: "", loanProgram: "" });
    for (let round = 0; round < 3; round += 1) {
      await burst(Array.from({ length: 10 }, (_, index) => () => addWatchedNote(seller, form(index), { buyerIds: [] })));
      const count = await prisma.trackedNote.count({ where: { userId: seller.id } });
      assert.ok(count <= MAX_WATCHED, `round ${round}: ${count} notes on watch against a limit of ${MAX_WATCHED}`);
      assert.equal(count, MAX_WATCHED, `round ${round}: the five free places are filled`);
      await prisma.trackedNote.deleteMany({ where: { userId: seller.id, label: { startsWith: "Added" } } });
    }
  } finally {
    await w.clean();
  }
});

test("guest links sent at once stop at the side's live limit, and one address gets one live link", async () => {
  const w = world("guests");
  try {
    const { seller, closing } = await closingFor(w, "Guests");
    const add = (who: string) => () => createGuestPass(seller, { closingId: closing.id, name: `Guest ${who}`, email: `${w.tag}-outside-${who}@example.org`, role: "ATTORNEY", days: "14" });
    const results = await burst(Array.from({ length: 15 }, (_, index) => add(`g${index}`)));
    const live = await prisma.guestPass.count({ where: { closingId: closing.id, side: "SELLER", ...unset("revokedAt") } });
    assert.equal(live, results.filter((result) => result.ok).length);
    assert.ok(live <= LIVE_PASS_LIMIT, `${live} live links against a limit of ${LIVE_PASS_LIMIT}`);
    assert.equal(live, LIVE_PASS_LIMIT, "the earlier links stay, so the side still gets its full limit");
    await prisma.guestPass.deleteMany({ where: { closingId: closing.id } });
    await burst(times(6, add("same")));
    assert.equal(await prisma.guestPass.count({ where: { closingId: closing.id, email: `${w.tag}-outside-same@example.org` } }), 1, "one live link per address");
  } finally {
    await w.clean();
  }
});

test("a seller answering one request with the same listing several times at once sends one answer", async () => {
  const w = world("answers");
  try {
    const buyer = await w.buyer("buyer", { entityType: "FUND" });
    const seller = await w.user("seller", "INSTITUTIONAL_SELLER");
    const posted = await createRequest(buyer, WANT(w.tag));
    assert.ok(posted.ok, posted.ok ? "" : posted.error);
    const requestId = posted.value.id;
    // A public listing is sent as it is; a private one is invited to the buyer's account with the answer.
    for (const visibility of ["PUBLIC", "PRIVATE"]) {
      const listing = await w.listing(seller.id, `Answer pool ${visibility}`, visibility === "PRIVATE" ? { visibility } : {}, 2);
      const before = await notices({ toEmail: buyer.email, subject: "Answer to your request" });
      const results: Awaited<ReturnType<typeof answerRequest>>[] = await burst(times(10, () => answerRequest(seller, { requestId, listingId: listing.id })));
      assert.equal(results.filter((result) => result.ok).length, 1, visibility);
      assert.equal(await prisma.requestResponse.count({ where: { requestId, listingId: listing.id } }), 1, `${visibility}: one answer`);
      assert.equal(await notices({ toEmail: buyer.email, subject: "Answer to your request" }), before + 1, `${visibility}: the buyer hears once`);
      assert.equal(await prisma.listingInvite.count({ where: { listingId: listing.id, userId: buyer.id } }), visibility === "PRIVATE" ? 1 : 0, `${visibility}: invites`);
      for (const result of results.filter((item) => !item.ok)) assert.match(result.ok ? "" : result.error, /already went to this buyer/);
    }
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 7. Sale rounds

test("the shortlist sent twice at once by the seller and the desk is set once, and each bidder hears once", async () => {
  const w = world("rounds");
  try {
    const seller = await w.user("seller", "INSTITUTIONAL_SELLER");
    const desk = await w.user("desk", "ADMIN", { deskRole: "SALES" });
    const buyers = [await w.buyer("in-a"), await w.buyer("in-b"), await w.buyer("out")];
    const listing = await w.listing(seller.id, "Two rounds", { bidMode: "SEALED", roundOneEndsAt: new Date(Date.now() - 60 * 60 * 1000), bidDeadline: new Date(Date.now() + 3 * DAY) }, 2);
    const bids = [];
    for (const [index, buyer] of buyers.entries()) {
      bids.push(await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "OPEN", amount: 100000 + index, round: 1, createdAt: new Date(Date.now() - 2 * DAY) } }));
    }
    const pick = [bids[0].id, bids[1].id];
    const results = await burst(interleave(times(6, () => setShortlist(seller, { listingId: listing.id, inquiryIds: pick })), times(6, () => setShortlist(desk, { listingId: listing.id, inquiryIds: pick }))));
    assert.equal(results.filter((result) => result.error === null).length, 1);
    assert.ok((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).shortlistedAt);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: listing.id, action: "SHORTLIST" } }), 1);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: bids[2].id } })).status, "DECLINED");
    for (const buyer of buyers.slice(0, 2)) assert.equal(await notices({ toEmail: buyer.email, subject: `Final round · ${listing.title}` }), 1);
    assert.equal(await notices({ toEmail: buyers[2].email, subject: `Shortlist decided · ${listing.title}` }), 1);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 8. Standing bids

test("a buyer confirming the same standing bid several times at once places one bid", async () => {
  const w = world("standing");
  try {
    const seller = await w.user("seller", "INDIVIDUAL_SELLER");
    const buyer = await w.buyer("buyer");
    const listing = await w.listing(seller.id, "Standing");
    const box = await prisma.buyBox.create({ data: { userId: buyer.id, name: `Box ${w.tag}`, states: "ZZ", standingBids: true, bidBasis: "UPB", bidPercent: 56 } as never });
    const match = await prisma.listingMatch.create({ data: { listingId: listing.id, buyBoxId: box.id, userId: buyer.id, score: 90, indicativePrice: 112000, indicativeAt: new Date(), invitedAt: new Date() } });
    const results = await burst(times(10, () => confirmStanding({ matchId: match.id, user: buyer, price: 112000, goodUntil: "" })));
    assert.equal(results.filter((result) => result.error === null).length, 1);
    assert.equal(await prisma.inquiry.count({ where: { listingId: listing.id, buyerId: buyer.id, type: "OFFER" } }), 1);
    const answered = await prisma.listingMatch.findUniqueOrThrow({ where: { id: match.id } });
    assert.ok(answered.answeredAt && answered.inquiryId);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 9. The post-closing file

test("trailing documents received at once complete the file once, and each side hears once", async () => {
  const w = world("trailing");
  try {
    const desk = await w.user("closer", "ADMIN", { deskRole: "CLOSINGS" });
    const { seller, buyer, closing } = await closingFor(w, "Trailing", { status: "COMPLETE", closedAt: new Date(Date.now() - 10 * DAY) });
    const kinds = ["GOODBYE_LETTER", "HELLO_LETTER", "ORIGINAL_NOTE", "ALLONGE", "RECORDED_ASSIGNMENT", "TITLE_ENDORSEMENT"];
    await prisma.trailingDoc.createMany({ data: kinds.map((kind) => ({ closingId: closing.id, kind, owner: "SELLER", status: "SENT", dueAt: new Date(Date.now() + 5 * DAY) })) });
    const docs = await prisma.trailingDoc.findMany({ where: { closingId: closing.id } });
    const results = await burst(interleave(...docs.map((doc) => times(3, () => confirmReceived(desk, { docId: doc.id })))));
    assert.equal(results.filter((result) => result.ok).length, docs.length, "each item is received once");
    assert.ok((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).postCloseCompleteAt);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: closing.id, action: "TRAILING_COMPLETE" } }), 1);
    assert.equal(await notices({ toEmail: seller.email, subject: "File complete" }), 1);
    assert.equal(await notices({ toEmail: buyer.email, subject: "File complete" }), 1);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 10. Jobs run twice at once

test("the daily jobs run twice at once send each sale-notice reminder, note-watch email, availability reminder and review request once", async () => {
  const w = world("jobs");
  try {
    const now = new Date();
    // A sale notice due in a few days: the buyer hears once.
    const sale = await closingFor(w, "Sale notice", { status: "COMPLETE", closedAt: new Date(now.getTime() - 27 * DAY) });
    // A complete closing whose post-closing file just completed: both sides are asked once for a review.
    const review = await closingFor(w, "Review", { status: "COMPLETE", closedAt: new Date(now.getTime() - 20 * DAY), postCloseCompleteAt: new Date(now.getTime() - DAY), ownerNoticeSentAt: new Date(now.getTime() - 10 * DAY) });
    // A holder with three notes on watch, never read: one email covering all three.
    const holder = await w.user("holder", "INDIVIDUAL_SELLER");
    await prisma.trackedNote.createMany({
      data: [1, 2, 3].map((index) => ({ userId: holder.id, label: `Watched ${index} ${w.tag}`, state: "FL", propertyType: "SFR", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 150000, interestRate: 7, monthlyPi: 1100, estimatedValue: 240000 })),
    });
    // A live listing unconfirmed for 40 days: its seller is asked once.
    const owner = await w.user("owner", "INDIVIDUAL_SELLER");
    const stale = await w.listing(owner.id, "Stale", { approvedAt: new Date(now.getTime() - 40 * DAY) });

    for (let round = 0; round < 2; round += 1) {
      await burst([
        () => remindSaleNotices(now),
        () => remindSaleNotices(now),
        () => requestReviews(now, { closingIds: [review.closing.id] }),
        () => requestReviews(now, { closingIds: [review.closing.id] }),
        () => sendNoteWatch(now, { userIds: [holder.id], buyerIds: [] }),
        () => sendNoteWatch(now, { userIds: [holder.id], buyerIds: [] }),
        () => runFreshness(now, { listingIds: [stale.id] }),
        () => runFreshness(now, { listingIds: [stale.id] }),
      ]);
      assert.equal(await notices({ toEmail: sale.buyer.email, subject: "Sale notice" }), 1, `round ${round}: sale notice reminder`);
      assert.equal(await notices({ toEmail: review.seller.email, subject: "How did the trade go?" }), 1, `round ${round}: seller review request`);
      assert.equal(await notices({ toEmail: review.buyer.email, subject: "How did the trade go?" }), 1, `round ${round}: buyer review request`);
      assert.equal(await notices({ toEmail: holder.email, subject: "Note watch" }), 1, `round ${round}: note watch email`);
      assert.equal(await notices({ toEmail: owner.email, subject: "Still for sale?" }), 1, `round ${round}: availability reminder`);
    }
  } finally {
    await w.clean();
  }
});

test("note watch run twice at once against holders with many notes sends each holder one email", async () => {
  const w = world("watchjob");
  try {
    const now = new Date();
    const holders = [];
    for (let index = 0; index < 4; index += 1) {
      const holder = await w.user(`holder${index}`, "INDIVIDUAL_SELLER");
      await prisma.trackedNote.createMany({
        data: Array.from({ length: 8 }, (_, note) => ({ userId: holder.id, label: `Watched ${note} ${w.tag}`, state: "FL", propertyType: "SFR", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 150000 + note, interestRate: 7, monthlyPi: 1100, estimatedValue: 240000 })),
      });
      holders.push(holder);
    }
    const scope = { userIds: holders.map((holder) => holder.id), buyerIds: [] as string[] };
    await burst(times(3, () => sendNoteWatch(now, scope)));
    for (const holder of holders) assert.equal(await notices({ toEmail: holder.email, subject: "Note watch" }), 1, holder.email);
  } finally {
    await w.clean();
  }
});

test("the API call purge run twice at once removes old calls once and keeps recent ones", async () => {
  const w = world("apilog");
  const path = `/api/v1/race/${w.tag}`;
  try {
    const now = new Date();
    await prisma.apiCall.createMany({
      data: [
        ...Array.from({ length: 6 }, () => ({ keyId: `key-${w.tag}`, userId: `user-${w.tag}`, method: "GET", path, status: 200, createdAt: new Date(now.getTime() - 120 * DAY) })),
        ...Array.from({ length: 3 }, () => ({ keyId: `key-${w.tag}`, userId: `user-${w.tag}`, method: "GET", path, status: 200, createdAt: new Date(now.getTime() - DAY) })),
      ],
    });
    await burst(times(2, () => purgeApiCalls(now)));
    assert.equal(await prisma.apiCall.count({ where: { path } }), 3);
    assert.equal(await prisma.apiCall.count({ where: { path, createdAt: { lt: new Date(now.getTime() - 90 * DAY) } } }), 0);
  } finally {
    await prisma.apiCall.deleteMany({ where: { path } });
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 11. Desk launches

test("two desk members putting a coming-soon listing live at once, with the launch job running, send one launch notice", async () => {
  const w = world("launch");
  try {
    const seller = await w.user("seller", "INDIVIDUAL_SELLER");
    const desks = [await w.user("desk-a", "ADMIN", { deskRole: "SALES" }), await w.user("desk-b", "ADMIN", { deskRole: "SALES" })];
    const listing = await w.listing(seller.id, "Coming soon", { approvedAt: new Date(Date.now() + 2 * DAY), launchAt: new Date(Date.now() + 2 * DAY) });
    type Launched = Awaited<ReturnType<typeof launchNow>> | Awaited<ReturnType<typeof runLaunches>>;
    const results = await burst<Launched>([
      ...interleave(...desks.map((desk) => times(5, () => launchNow({ listingId: listing.id, actorId: desk.id })))),
      () => runLaunches(new Date(), { listingIds: [listing.id] }),
      () => runLaunches(new Date(), { listingIds: [listing.id] }),
    ]);
    const moved = results.filter((result) => "launched" in result && result.error === null);
    assert.equal(moved.length, 1);
    assert.ok((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).launchNotifiedAt);
    assert.equal(await prisma.auditEvent.count({ where: { entityId: listing.id, action: "LAUNCH_NOW" } }), 1);
    assert.equal(await notices({ toEmail: seller.email, subject: `Live · ${listing.title}` }), 1);
  } finally {
    await w.clean();
  }
});
