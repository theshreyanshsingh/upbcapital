import assert from "node:assert/strict";
import test from "node:test";
import { awardOffer, sellerAgreed, setBuyNow } from "../lib/awards";
import { buyNowAgreed, buyNowClearBlock, buyNowConsent, buyNowOffer, buyNowSetBlock } from "../lib/buy-now";
import { literal } from "../lib/db-filters";
import {
  ACKNOWLEDGE_FIRST,
  acknowledgementMissing,
  confirmNotices,
  eligibilityFor,
  eligibilityLog,
  readEligibility,
  roadLoan,
} from "../lib/eligibility";
import { acknowledgeRoad, checkOffer, placeBuyNow } from "../lib/inquiry";
import { prisma } from "../lib/prisma";

const DAY = 24 * 60 * 60 * 1000;
// Desk and seller notices stay in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

test("buy it now is for open offers only, and a pool sells whole or not at all", () => {
  const base = { status: "APPROVED", bidMode: "NONE", price: 150000, tradedLoans: 0, openBuyNowBids: 0 };
  assert.equal(buyNowSetBlock(base), null);
  assert.equal(buyNowSetBlock({ ...base, status: "SUBMITTED" }), null);
  assert.equal(buyNowSetBlock({ ...base, status: "UNDER_REVIEW" }), null);
  for (const status of ["PENDING", "SOLD", "REJECTED", "WITHDRAWN", "CHANGES_REQUESTED"]) {
    assert.match(buyNowSetBlock({ ...base, status }) ?? "", /in review or live/);
  }
  assert.match(buyNowSetBlock({ ...base, bidMode: "SEALED" }) ?? "", /open offers only/);
  assert.match(buyNowSetBlock({ ...base, bidMode: "BEST_AND_FINAL" }) ?? "", /open offers only/);
  assert.match(buyNowSetBlock({ ...base, tradedLoans: 1 }) ?? "", /can't sell whole/);
  assert.match(buyNowSetBlock({ ...base, openBuyNowBids: 1 }) ?? "", /price stays/);
  for (const price of [0, -5, Number.NaN, 150000.5, 2_000_000_000]) assert.match(buyNowSetBlock({ ...base, price }) ?? "", /whole dollars/);

  assert.equal(buyNowClearBlock({ status: "APPROVED", buyNowPrice: 150000, openBuyNowBids: 0 }), null);
  assert.match(buyNowClearBlock({ status: "APPROVED", buyNowPrice: null, openBuyNowBids: 0 }) ?? "", /no buy-it-now price/);
  assert.match(buyNowClearBlock({ status: "APPROVED", buyNowPrice: 150000, openBuyNowBids: 1 }) ?? "", /price stays/);
  assert.match(buyNowClearBlock({ status: "PENDING", buyNowPrice: 150000, openBuyNowBids: 0 }) ?? "", /stays on the record/);

  const live = { status: "APPROVED", bidMode: "NONE", buyNowPrice: 150000 };
  assert.deepEqual(buyNowOffer(live, true), { price: 150000, reason: null });
  // A sealed or best-and-final round is weighed as a set at its deadline, so buy it now waits it out.
  assert.match(buyNowOffer({ ...live, bidMode: "SEALED" }, true).reason ?? "", /paused/);
  assert.match(buyNowOffer({ ...live, bidMode: "BEST_AND_FINAL" }, true).reason ?? "", /paused/);
  assert.match(buyNowOffer(live, false).reason ?? "", /bought whole/);
  assert.match(buyNowOffer({ ...live, status: "SUBMITTED" }, true).reason ?? "", /isn't taking bids/);
  assert.match(buyNowOffer({ ...live, buyNowPrice: null }, true).reason ?? "", /no buy-it-now price/);
});

test("a buy-it-now bid at exactly the price is the seller's agreement, and nothing else is", () => {
  const at = { bid: true, price: 150000 };
  assert.equal(sellerAgreed({ price: 150000, reserve: null, approvedAmount: null, buyNow: at }), "buyNow");
  // It counts first, so the audit says why the sale needed no question even when a reserve also covers it.
  assert.equal(sellerAgreed({ price: 150000, reserve: 100000, approvedAmount: null, buyNow: at }), "buyNow");
  assert.equal(sellerAgreed({ price: 149999, reserve: null, approvedAmount: null, buyNow: at }), null);
  assert.equal(sellerAgreed({ price: 150000, reserve: null, approvedAmount: null, buyNow: { bid: false, price: 150000 } }), null);
  assert.equal(sellerAgreed({ price: 150000, reserve: null, approvedAmount: null, buyNow: { bid: true, price: null } }), null);
  assert.equal(sellerAgreed({ price: 150000, reserve: null, approvedAmount: null }), null);
  assert.equal(buyNowAgreed({ buyNow: undefined, price: 150000, buyNowPrice: 150000 }), false);
  assert.match(buyNowConsent({ pool: true, price: 150000 }), /sell the whole pool at \$150,000 to the first verified buyer/);
  assert.match(buyNowConsent({ pool: false }), /this note at the price below/);
});

const npl = { state: "FL", propertyType: "SFR", paymentStatus: "NON_PERFORMING" };

test("the eligibility notices: ROAD on non-performing one- and two-unit loans, Maryland for anyone but a trust", () => {
  assert.equal(roadLoan(npl), true);
  assert.equal(roadLoan({ ...npl, propertyType: "CONDO" }), true);
  assert.equal(roadLoan({ ...npl, propertyType: "TOWNHOUSE" }), true);
  assert.equal(roadLoan({ ...npl, propertyType: "MULTIFAMILY" }), false);
  assert.equal(roadLoan({ ...npl, propertyType: "COMMERCIAL" }), false);
  assert.equal(roadLoan({ ...npl, paymentStatus: "PERFORMING" }), false);
  assert.equal(roadLoan({ ...npl, paymentStatus: "SUB_PERFORMING" }), false);

  const small = { entityType: "LLC", homesControlled: 12, reoStrategy: "SELL" };
  const shown = eligibilityFor([npl], small);
  assert.deepEqual([shown.road, shown.acknowledge, shown.unanswered, shown.maryland], [true, false, false, false]);
  // A pool shows the notice when any loan in it qualifies.
  assert.equal(eligibilityFor([{ ...npl, paymentStatus: "PERFORMING" }, npl], small).road, true);
  assert.equal(eligibilityFor([{ ...npl, paymentStatus: "PERFORMING" }], small).road, false);
  // No answer yet: the notice shows and the buyer is asked, but nothing is required of them.
  const unanswered = eligibilityFor([npl], { entityType: "LLC", homesControlled: null });
  assert.deepEqual([unanswered.road, unanswered.unanswered, unanswered.acknowledge], [true, true, false]);

  const large = eligibilityFor([npl], { entityType: "FUND", homesControlled: 350, reoStrategy: "HOLD_TO_RENT" });
  assert.deepEqual([large.acknowledge, large.holdToRent], [true, true]);
  assert.equal(eligibilityFor([npl], { entityType: "FUND", homesControlled: 349 }).acknowledge, false);
  // Over the threshold but nothing here is in scope: no acknowledgement.
  assert.equal(eligibilityFor([{ ...npl, paymentStatus: "PERFORMING" }], { homesControlled: 5000 }).acknowledge, false);

  const maryland = { ...npl, state: "md", paymentStatus: "PERFORMING" };
  assert.equal(eligibilityFor([maryland], { entityType: "LLC" }).maryland, true);
  assert.equal(eligibilityFor([maryland], { entityType: "INDIVIDUAL" }).maryland, true);
  assert.equal(eligibilityFor([maryland], { entityType: "TRUST" }).maryland, false);
  assert.equal(eligibilityFor([maryland], null).maryland, true);
  assert.equal(eligibilityFor([npl], { entityType: "LLC" }).maryland, false);

  const both = eligibilityFor([{ ...npl, state: "MD" }], { entityType: "LLC", homesControlled: 400, reoStrategy: "HOLD_TO_RENT" });
  const lines = confirmNotices(both);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /ROAD to Housing Act/);
  assert.match(lines[1], /hold foreclosed homes to rent/);
  assert.match(lines[2], /Maryland license/);
  assert.deepEqual(confirmNotices(eligibilityFor([{ ...npl, paymentStatus: "PERFORMING" }], small)), []);
  assert.match(eligibilityLog(both, new Date(Date.UTC(2026, 10, 5))), /ROAD notice shown · 400 homes stated · acknowledged Nov 5, 2026 · holds REO to rent · Maryland prompt shown/);

  assert.deepEqual(readEligibility("1,200", "LOSS_MITIGATION"), { error: null, homesControlled: 1200, reoStrategy: "LOSS_MITIGATION" });
  assert.deepEqual(readEligibility("0", "NOT_SURE"), { error: null, homesControlled: 0, reoStrategy: "NOT_SURE" });
  assert.match(readEligibility("", "SELL").error ?? "", /whole number/);
  assert.match(readEligibility("-3", "SELL").error ?? "", /whole number/);
  assert.match(readEligibility("12.5", "SELL").error ?? "", /whole number/);
  assert.match(readEligibility("12", "FLIP").error ?? "", /Choose what you do/);
});

test("the 350-home acknowledgement counts once given, and a changed answer asks again", () => {
  const large = eligibilityFor([npl], { homesControlled: 400 });
  const answered = new Date(Date.UTC(2026, 10, 1));
  assert.equal(acknowledgementMissing(large, null, answered), true);
  assert.equal(acknowledgementMissing(large, new Date(Date.UTC(2026, 10, 2)), answered), false);
  assert.equal(acknowledgementMissing(large, new Date(Date.UTC(2026, 9, 30)), answered), true);
  assert.equal(acknowledgementMissing(large, new Date(Date.UTC(2026, 10, 2)), null), false);
  assert.equal(acknowledgementMissing(eligibilityFor([npl], { homesControlled: 10 }), null, answered), false);
});

// Timestamp-tagged people and a listing nothing seeded touches: a non-performing single-family note.
async function makeDeal(opts: { buyers?: number; homes?: number | null; pro?: boolean; paymentStatus?: string } = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN", pro = false) =>
    prisma.user.create({
      data: {
        email: `bn-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(pro ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const buyers = [];
  for (let index = 0; index < (opts.buyers ?? 2); index += 1) {
    const buyer = await person(`buyer${index}`, "BUYER", opts.pro ?? true);
    await prisma.buyerProfile.create({
      data: {
        userId: buyer.id,
        status: "APPROVED",
        entityType: "LLC",
        entityName: `Fund ${index} ${tag}`,
        ...(opts.homes !== null ? { homesControlled: opts.homes ?? 4, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY) } : {}),
      },
    });
    buyers.push(buyer);
  }
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      title: `Buy now ${tag}`,
      notes: {
        create: [{
          streetAddress: "1 First St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: opts.paymentStatus ?? "NON_PERFORMING", monthsDelinquent: 9,
          askingPrice: 120000, estimatedValue: 260000,
        }] as never,
      },
    },
    include: { notes: true },
  });
  return { tag, seller, desk, buyers, listing, users: [seller, desk, ...buyers] };
}

type Deal = Awaited<ReturnType<typeof makeDeal>>;

async function cleanDeal(deal: Deal) {
  const listingId = deal.listing.id;
  const userIds = deal.users.map((user) => user.id);
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId }, select: { id: true } })).map((row) => row.id);
  const closingIds = (await prisma.closing.findMany({ where: { listingId }, select: { id: true } })).map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [listingId, ...inquiryIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId }, { inquiryId: { in: inquiryIds } }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId } });
  await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: deal.users.map((user) => user.email) } }, { subject: { contains: literal(deal.listing.title) } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const listingOf = (deal: Deal) => prisma.listing.findUniqueOrThrow({ where: { id: deal.listing.id } });

test("the seller sets, changes and clears buy it now, with their consent and the date on the record", async () => {
  const deal = await makeDeal();
  try {
    const listingId = deal.listing.id;
    assert.equal((await setBuyNow(listingId, deal.buyers[0].id, 150000)).error, "That listing isn't yours.");
    assert.match((await setBuyNow(listingId, deal.seller.id, 150000.25)).error ?? "", /whole dollars/);

    const set = await setBuyNow(listingId, deal.seller.id, 150000);
    assert.equal(set.error, null);
    let listing = await listingOf(deal);
    assert.equal(listing.buyNowPrice, 150000);
    assert.ok(listing.buyNowSetAt);
    assert.match(listing.buyNowConsent ?? "", /sell this note at \$150,000 to the first verified buyer who confirms it/);
    const logged = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: listingId, action: "BUY_NOW_SET" } });
    assert.match(logged.detail, /\$150,000 · I agree to sell/);

    assert.equal((await setBuyNow(listingId, deal.seller.id, 160000)).error, null);
    assert.equal((await listingOf(deal)).buyNowPrice, 160000);

    // A sealed round sets its price at the deadline, so buy it now can't be set while one runs.
    await prisma.listing.update({ where: { id: listingId }, data: { bidMode: "SEALED", bidDeadline: new Date(Date.now() + DAY) } });
    assert.match((await setBuyNow(listingId, deal.seller.id, 170000)).error ?? "", /open offers only/);
    assert.match((await placeBuyNow({ user: deal.buyers[0], listingId, price: 160000 })).error ?? "", /paused/);
    await prisma.listing.update({ where: { id: listingId }, data: { bidMode: "NONE", bidDeadline: null } });

    // While a confirmed buy-it-now bid waits on the desk, the price holds.
    const waiting = await prisma.inquiry.create({ data: { listingId, buyerId: deal.buyers[0].id, type: "OFFER", status: "OPEN", amount: 160000, buyNow: true } });
    assert.match((await setBuyNow(listingId, deal.seller.id, null)).error ?? "", /price stays/);
    assert.match((await setBuyNow(listingId, deal.seller.id, 170000)).error ?? "", /price stays/);
    await prisma.inquiry.update({ where: { id: waiting.id }, data: { status: "WITHDRAWN" } });

    assert.equal((await setBuyNow(listingId, deal.seller.id, null)).error, null);
    listing = await listingOf(deal);
    assert.equal(listing.buyNowPrice, null);
    assert.equal(listing.buyNowConsent, null);
    assert.match((await setBuyNow(listingId, deal.seller.id, null)).error ?? "", /no buy-it-now price/);
    assert.match((await placeBuyNow({ user: deal.buyers[0], listingId, price: 160000 })).error ?? "", /no buy-it-now price/);
  } finally {
    await cleanDeal(deal);
  }
});

test("buyers confirming at once open exactly one closing, and the others are closed owing nothing", async () => {
  const deal = await makeDeal({ buyers: 3 });
  try {
    const listingId = deal.listing.id;
    assert.equal((await setBuyNow(listingId, deal.seller.id, 150000)).error, null);
    // A buyer with an ordinary open bid is declined when the buy-it-now sale goes through.
    const earlier = await prisma.inquiry.create({ data: { listingId, buyerId: deal.buyers[0].id, type: "OFFER", status: "OPEN", amount: 100000 } });
    const results = await Promise.all(deal.buyers.map((user) => placeBuyNow({ user, listingId, price: 150000 })));
    const won = results.filter((result) => result.error === null);
    assert.equal(won.length, 1);
    const winner = won[0];
    assert.ok(winner.error === null && winner.closingId);
    for (const lost of results.filter((result) => result.error !== null)) {
      assert.match(lost.error ?? "", /Another buyer confirmed first|not taking new inquiries|in contract/);
    }
    const closings = await prisma.closing.findMany({ where: { listingId } });
    assert.equal(closings.length, 1);
    assert.equal(closings[0].salePrice, 150000);
    const listing = await listingOf(deal);
    assert.equal(listing.status, "PENDING");
    assert.equal(listing.acceptedInquiryId, closings[0].inquiryId);
    const accepted = await prisma.inquiry.findUniqueOrThrow({ where: { id: closings[0].inquiryId ?? "" } });
    assert.equal(accepted.buyNow, true);
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(await prisma.inquiry.count({ where: { listingId, status: { in: ["OPEN", "REVIEWED"] } } }), 0);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: earlier.id } })).status, "DECLINED");
    const award = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: accepted.id, action: "AWARD" } });
    assert.match(award.detail, /at the seller's buy-it-now price, agreed in advance/);
    // The desk and the seller hear at once.
    assert.equal(await prisma.notification.count({ where: { toEmail: deal.seller.email, subject: { contains: literal(`Sold at your buy-it-now price · ${listing.title}`) } } }), 1);
    assert.ok((await prisma.notification.count({ where: { subject: { contains: literal(`Buy it now · ${listing.title}`) } } })) >= 1);
    // The price stays on the record once the listing is in contract.
    assert.match((await setBuyNow(listingId, deal.seller.id, null)).error ?? "", /stays on the record/);
  } finally {
    await cleanDeal(deal);
  }
});

test("a buy-it-now bid at the price awards without asking the seller, and a changed price falls back to asking", async () => {
  const deal = await makeDeal();
  try {
    const listingId = deal.listing.id;
    await prisma.listing.update({ where: { id: listingId }, data: { buyNowPrice: 150000, buyNowSetAt: new Date(), buyNowConsent: "Test consent." } });
    // Off the price: the seller never agreed to this figure.
    const off = await prisma.inquiry.create({ data: { listingId, buyerId: deal.buyers[1].id, type: "OFFER", status: "OPEN", amount: 140000, buyNow: true } });
    assert.equal((await awardOffer(off.id, deal.desk.id)).error, "The seller hasn't approved this price.");
    const at = await prisma.inquiry.create({ data: { listingId, buyerId: deal.buyers[0].id, type: "OFFER", status: "OPEN", amount: 150000, buyNow: true } });
    const awarded = await awardOffer(at.id, deal.desk.id);
    assert.equal(awarded.error, null);
    assert.equal(await prisma.closing.count({ where: { listingId } }), 1);
    assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: off.id } })).status, "DECLINED");
  } finally {
    await cleanDeal(deal);
  }
});

test("buy it now binds to the figure the buyer saw, is a Pro privilege, and a hold leaves the bid for the desk", async () => {
  const deal = await makeDeal({ buyers: 1 });
  const free = await makeDeal({ buyers: 1, pro: false });
  try {
    const listingId = deal.listing.id;
    const [buyer] = deal.buyers;
    assert.equal((await setBuyNow(listingId, deal.seller.id, 150000)).error, null);
    assert.match((await placeBuyNow({ user: buyer, listingId, price: 145000 })).error ?? "", /price changed/);
    assert.equal((await setBuyNow(free.listing.id, free.seller.id, 150000)).error, null);
    assert.match((await placeBuyNow({ user: free.buyers[0], listingId: free.listing.id, price: 150000 })).error ?? "", /Pro privilege/);

    // A screening hold stops the award but not the bid. The seller's price stands while the desk clears it.
    const hold = await prisma.ofacCheck.create({ data: { name: buyer.name, result: "REVIEW", status: "OPEN", userId: buyer.id, context: "test" } });
    const held = await placeBuyNow({ user: buyer, listingId, price: 150000 });
    assert.ok(held.error === null && held.closingId === null);
    const bid = await prisma.inquiry.findUniqueOrThrow({ where: { id: held.inquiryId } });
    assert.equal(bid.status, "OPEN");
    assert.equal(bid.buyNow, true);
    assert.match((await setBuyNow(listingId, deal.seller.id, null)).error ?? "", /price stays/);
    assert.match((await placeBuyNow({ user: buyer, listingId, price: 150000 })).error ?? "", /already confirmed/);
    assert.ok((await prisma.notification.count({ where: { subject: { contains: literal(`Buy it now needs the desk · ${deal.listing.title}`) } } })) >= 1);
    await prisma.ofacCheck.delete({ where: { id: hold.id } });
    assert.equal((await awardOffer(bid.id, deal.desk.id)).error, null);
  } finally {
    await cleanDeal(deal);
    await cleanDeal(free);
  }
});

test("a buyer with 350 or more homes acknowledges the ROAD Act notice before bidding, and the bid logs what they saw", async () => {
  const deal = await makeDeal({ buyers: 2, homes: 400 });
  const performing = await makeDeal({ buyers: 1, homes: 400, paymentStatus: "PERFORMING" });
  try {
    const listingId = deal.listing.id;
    const [large, other] = deal.buyers;
    await prisma.buyerProfile.update({ where: { userId: other.id }, data: { homesControlled: 349 } });
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    const bid = (user: (typeof deal.buyers)[number]) => checkOffer({ user, listing, noteId: "", amount: 100000, goodUntil: "" });

    assert.equal((await bid(large)).error, ACKNOWLEDGE_FIRST);
    assert.equal((await bid(other)).error, null);
    // Nothing in scope on a performing loan, so nothing to acknowledge.
    const performingListing = await prisma.listing.findUniqueOrThrow({ where: { id: performing.listing.id } });
    assert.equal((await checkOffer({ user: performing.buyers[0], listing: performingListing, noteId: "", amount: 100000, goodUntil: "" })).error, null);
    assert.equal((await setBuyNow(listingId, deal.seller.id, 150000)).error, null);
    assert.equal((await placeBuyNow({ user: large, listingId, price: 150000 })).error, ACKNOWLEDGE_FIRST);

    assert.equal((await acknowledgeRoad(large, listingId)).error, null);
    const passed = await bid(large);
    assert.ok(passed.error === null && passed.eligibility.acknowledge && passed.acknowledgedAt);

    // A changed answer asks again.
    await prisma.buyerProfile.update({ where: { userId: large.id }, data: { eligibilityAt: new Date(Date.now() + 1000) } });
    assert.equal((await bid(large)).error, ACKNOWLEDGE_FIRST);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await acknowledgeRoad(large, listingId)).error, null);

    const bought = await placeBuyNow({ user: large, listingId, price: 150000 });
    assert.ok(bought.error === null && bought.closingId);
    const log = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: bought.inquiryId, action: "ELIGIBILITY" } });
    assert.match(log.detail, /ROAD notice shown · 400 homes stated · acknowledged/);
  } finally {
    await cleanDeal(deal);
    await cleanDeal(performing);
  }
});
