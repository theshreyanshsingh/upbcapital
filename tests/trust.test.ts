import assert from "node:assert/strict";
import test from "node:test";
import { closingSchedule, effectiveDue, nextSettlementDay, settlementLabel, settlementSetting, settlementWeekdays, settlesOn } from "../lib/closing-clock";
import { cancelOpenClosing, dealTimeline, loadDealTimeline, openClosing, walkAwayFromClosing, type TimelineInput } from "../lib/closing-service";
import { literal } from "../lib/db-filters";
import { bidStanding, checkOffer, inquiryBlock } from "../lib/inquiry";
import { prisma } from "../lib/prisma";
import { getSettings } from "../lib/settings";
import { clearStrike, pauseMessage, strikeLimitOf, strikeStanding } from "../lib/strikes";
import { bidLimit, bidTarget, credentialLine, exposureByKey, fundsCredential, headroomAfter } from "../lib/verification";

const DAY = 24 * 60 * 60 * 1000;
const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);
// Desk and buyer notices stay in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The credential and the bid limit, as pure rules.

test("a verified ceiling is a credential, and a stated amount isn't", () => {
  const now = noon("2026-11-06");
  assert.equal(fundsCredential(null, now), null);
  assert.equal(fundsCredential({ proofAmount: 250000, proofExpiresAt: noon("2026-11-30"), proofVerifiedAt: null }, now), null);
  assert.equal(fundsCredential({ proofAmount: 0, proofExpiresAt: null, proofVerifiedAt: now }, now), null);
  const credential = fundsCredential({ proofAmount: 250000, proofExpiresAt: noon("2026-11-30"), proofVerifiedAt: noon("2026-11-01") }, now)!;
  assert.equal(credential.expired, false);
  assert.equal(credentialLine(credential, now), "Verified funds $250,000 to Nov 30");
  assert.equal(credentialLine({ ...credential, expiresAt: noon("2027-02-01") }, now), "Verified funds $250,000 to Feb 1, 2027");
  const lapsed = fundsCredential({ proofAmount: 250000, proofExpiresAt: noon("2026-11-01"), proofVerifiedAt: noon("2026-08-01") }, now)!;
  assert.equal(lapsed.expired, true);
  assert.equal(credentialLine(lapsed, now), "Verified funds $250,000 expired Nov 1");
});

test("open bids share the ceiling, a raise on the same loan needs room only for the raise, and the refusal says what's left", () => {
  const now = noon("2026-11-06");
  const credential = fundsCredential({ proofAmount: 100000, proofExpiresAt: noon("2026-11-30"), proofVerifiedAt: now }, now)!;
  const byKey = exposureByKey([
    { key: bidTarget("L1", "N1"), allIn: 30000 },
    { key: bidTarget("L1", "N1"), allIn: 35000 },
    { key: bidTarget("L2", null), allIn: 40000 },
  ]);
  // Two bids on one loan hold the larger, since only one can win.
  assert.equal(byKey[bidTarget("L1", "N1")], 35000);
  const fits = bidLimit({ credential, byKey, key: bidTarget("L3", null), allIn: 25000, now });
  assert.deepEqual(fits, { ok: true, headroomAfter: 0 });
  const over = bidLimit({ credential, byKey, key: bidTarget("L3", null), allIn: 25001, now });
  assert.equal(over.ok, false);
  assert.ok(!over.ok && over.reason === "over" && over.headroom === 25000);
  assert.match(!over.ok ? over.message : "", /You have \$25,000 of headroom left of \$100,000/);
  // Raising the L1 bid to 60k: the 35k already held there is replaced, not added to.
  assert.deepEqual(bidLimit({ credential, byKey, key: bidTarget("L1", "N1"), allIn: 60000, now }), { ok: true, headroomAfter: 0 });
  assert.equal(bidLimit({ credential, byKey, key: bidTarget("L1", "N1"), allIn: 60001, now }).ok, false);
  // No ceiling, no limit.
  assert.deepEqual(bidLimit({ credential: null, byKey, key: "x", allIn: 1e9, now }), { ok: true, headroomAfter: null });
  // The form's figure matches the server's.
  const view = { line: credentialLine(credential, now), amount: 100000, expired: false, byKey, headroom: 25000 };
  assert.equal(headroomAfter(view, bidTarget("L3", null), 20000), 5000);
  assert.equal(headroomAfter(view, bidTarget("L1", "N1"), 30000), 25000);
  assert.equal(headroomAfter({ ...view, expired: true }, bidTarget("L3", null), 1), null);
  const expired = bidLimit({ credential: { ...credential, expiresAt: noon("2026-11-05"), expired: true }, byKey: {}, key: "x", allIn: 1, now });
  assert.ok(!expired.ok && expired.reason === "expired");
  assert.match(!expired.ok ? expired.message : "", /expired Nov 5\. Send the desk a fresh proof of funds/);
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and listings nothing seeded touches.

async function makeDesk(opts: { listings?: number } = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN") =>
    prisma.user.create({
      data: {
        email: `trust-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const buyer = await person("buyer", "BUYER");
  await prisma.buyerProfile.create({
    data: {
      userId: buyer.id,
      status: "APPROVED",
      entityType: "LLC",
      entityName: `Fund ${tag}`,
      homesControlled: 4,
      reoStrategy: "SELL",
      eligibilityAt: new Date(Date.now() - DAY),
      proofAmount: 100000,
      proofVerifiedAt: new Date(Date.now() - DAY),
      proofExpiresAt: new Date(Date.now() + 30 * DAY),
    },
  });
  const listings = [];
  for (let index = 0; index < (opts.listings ?? 3); index += 1) {
    listings.push(
      await prisma.listing.create({
        data: {
          kind: "SINGLE",
          sellerId: seller.id,
          status: "APPROVED",
          approvedAt: new Date(Date.now() - 7 * DAY),
          title: `Trust ${index} ${tag}`,
          notes: {
            create: [{
              streetAddress: `${index} First St`, city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
              lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
              askingPrice: 120000, estimatedValue: 260000,
            }] as never,
          },
        },
        include: { notes: true },
      }),
    );
  }
  return { tag, seller, desk, buyer, listings, users: [seller, desk, buyer] };
}

type Desk = Awaited<ReturnType<typeof makeDesk>>;

async function cleanDesk(fixture: Desk) {
  const listingIds = fixture.listings.map((listing) => listing.id);
  const userIds = fixture.users.map((user) => user.id);
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.buyerStrike.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...inquiryIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { inquiryId: { in: inquiryIds } }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: fixture.users.map((user) => user.email) } }, { subject: { contains: literal(fixture.tag) } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// A bid's price for a target all-in, at the desk's own premium.
async function priceFor(allIn: number) {
  const { buyerPremiumBps } = await getSettings();
  return allIn / (1 + buyerPremiumBps / 10000);
}

async function placeBid(fixture: Desk, index: number, allIn: number) {
  const listing = fixture.listings[index];
  const amount = await priceFor(allIn);
  const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: fixture.buyer.id, type: "OFFER", noteId: listing.notes[0].id, amount, status: "OPEN" } });
  await prisma.offerMessage.create({ data: { inquiryId: inquiry.id, authorId: fixture.buyer.id, kind: "OFFER", amount, body: "Opening bid." } });
  return inquiry;
}

const check = async (fixture: Desk, index: number, allIn: number) =>
  checkOffer({ user: fixture.buyer, listing: fixture.listings[index], noteId: fixture.listings[index].notes[0].id, amount: await priceFor(allIn), goodUntil: "" });

test("the bid limit holds open bids to the verified funds, stops an expired proof, and leaves information requests alone", async () => {
  const fixture = await makeDesk();
  try {
    const first = await check(fixture, 0, 60000);
    assert.equal(first.error, null);
    assert.ok(first.error === null && Math.abs((first.headroomAfter ?? 0) - 40000) < 0.01);
    await placeBid(fixture, 0, 60000);

    // 60k held, so 50k more is over by 10k and the buyer is told 40k is left.
    const over = await check(fixture, 1, 50000);
    assert.ok(over.error !== null);
    assert.equal(over.verification, false);
    assert.match(over.error, /all-in of \$50,000 is over your verified funds\. You have \$40,000 of headroom left of \$100,000/);
    const fits = await check(fixture, 1, 40000);
    assert.equal(fits.error, null);

    // A higher bid on the loan already bid needs room only for the raise.
    assert.equal((await check(fixture, 0, 100000)).error, null);
    assert.ok((await check(fixture, 0, 100001)).error !== null);

    // A bid past its good-until date can't be awarded, so it holds nothing.
    const lapsed = await placeBid(fixture, 2, 30000);
    assert.ok((await check(fixture, 1, 40001)).error !== null);
    await prisma.inquiry.update({ where: { id: lapsed.id }, data: { expiresAt: new Date(Date.now() - DAY) } });
    assert.equal((await check(fixture, 1, 40000)).error, null);

    // The credential as the bid forms get it.
    const standing = await bidStanding(fixture.buyer.id);
    assert.equal(standing.paused, null);
    assert.ok(standing.credential);
    assert.match(standing.credential.line, /^Verified funds \$100,000 to /);
    assert.ok(Math.abs(standing.credential.headroom - 40000) < 0.01);

    // Information requests never meet the limit.
    assert.equal(await inquiryBlock(fixture.buyer, fixture.listings[1]), null);

    // An expired proof stops every new bid and points the buyer at their file.
    await prisma.buyerProfile.update({ where: { userId: fixture.buyer.id }, data: { proofExpiresAt: new Date(Date.now() - DAY) } });
    const expired = await check(fixture, 1, 1000);
    assert.ok(expired.error !== null);
    assert.equal(expired.verification, true);
    assert.match(expired.error, /Your verified funds expired .+\. Send the desk a fresh proof of funds to bid again\./);
    assert.equal((await bidStanding(fixture.buyer.id)).credential?.expired, true);
    assert.equal(await inquiryBlock(fixture.buyer, fixture.listings[1]), null);

    // A buyer the desk approved before it verified figures has no ceiling yet.
    await prisma.buyerProfile.update({ where: { userId: fixture.buyer.id }, data: { proofVerifiedAt: null } });
    assert.equal((await check(fixture, 1, 5_000_000)).error, null);
  } finally {
    await cleanDesk(fixture);
  }
});

// A won bid on listing `index`, with its closing open.
async function awardedClosing(fixture: Desk, index: number, allIn: number) {
  const listing = fixture.listings[index];
  const bid = await placeBid(fixture, index, allIn);
  await prisma.inquiry.update({ where: { id: bid.id }, data: { status: "ACCEPTED" } });
  await prisma.note.update({ where: { id: listing.notes[0].id }, data: { tradeStatus: "IN_CONTRACT" } });
  return openClosing({ listingId: listing.id, inquiryId: bid.id, noteId: listing.notes[0].id, salePrice: await priceFor(allIn), title: listing.title });
}

test("a strike is recorded on a buyer fault only, never on a seller fault, neither or a diligence walk-away", async () => {
  const fixture = await makeDesk({ listings: 4 });
  try {
    const strikes = () => prisma.buyerStrike.findMany({ where: { userId: fixture.buyer.id } });
    // An open closing holds its all-in against the ceiling until it finishes.
    const seller = await awardedClosing(fixture, 0, 70000);
    assert.ok((await check(fixture, 3, 30001)).error !== null);
    assert.ok(await cancelOpenClosing(seller.id, "The seller couldn't find the original note.", { fault: "SELLER", actorId: fixture.desk.id }));
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: seller.id } })).cancelFault, "SELLER");
    assert.equal((await strikes()).length, 0);
    assert.equal((await check(fixture, 3, 100000)).error, null);

    const neither = await awardedClosing(fixture, 1, 10000);
    assert.ok(await cancelOpenClosing(neither.id, "Title defect.", { fault: "NEITHER", actorId: fixture.desk.id }));
    assert.equal((await strikes()).length, 0);

    // The diligence window is the buyer's right under the terms, so a walk-away is nobody's fault.
    const walk = await awardedClosing(fixture, 2, 10000);
    await prisma.closing.update({ where: { id: walk.id }, data: { diligenceEndsAt: new Date(Date.now() + 3 * DAY) } });
    assert.equal((await walkAwayFromClosing(walk.id, fixture.buyer.id, "The collateral file is missing the allonge.")).error, null);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: walk.id } })).cancelFault, "NEITHER");
    assert.equal((await strikes()).length, 0);

    const buyer = await awardedClosing(fixture, 3, 10000);
    assert.ok(await cancelOpenClosing(buyer.id, "The buyer's wire never came.", { fault: "BUYER", actorId: fixture.desk.id }));
    // A second cancel finds the closing finished and records nothing more.
    assert.equal(await cancelOpenClosing(buyer.id, "Again.", { fault: "BUYER", actorId: fixture.desk.id }), null);
    const recorded = await strikes();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].closingId, buyer.id);
    assert.equal(recorded[0].createdById, fixture.desk.id);
    assert.equal(recorded[0].reason, "The buyer's wire never came.");
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: fixture.buyer.id, action: "STRIKE_RECORDED" } }));

    // The fault line reaches the desk and the buyer, not the seller. The loader reads the same records.
    const forBuyer = await loadDealTimeline(buyer.id, "buyer");
    const forSeller = await loadDealTimeline(buyer.id, "seller");
    assert.match(forBuyer?.entries.find((entry) => entry.title === "Closing canceled")?.detail ?? "", /strike on the buyer file/);
    assert.doesNotMatch(forSeller?.entries.find((entry) => entry.title === "Closing canceled")?.detail ?? "missing", /strike|buyer's failure/);
  } finally {
    await cleanDesk(fixture);
  }
});

test("at the strike limit new bids pause, information requests still go, and clearing one with a note lifts the pause", async () => {
  const fixture = await makeDesk({ listings: 3 });
  try {
    const limit = strikeLimitOf((await getSettings()).strikeLimit);
    // Strikes up to the desk's limit: the first two through the real cancel, any more written directly.
    for (let index = 0; index < limit; index += 1) {
      if (index < 2) {
        const closing = await awardedClosing(fixture, index, 10000);
        assert.ok(await cancelOpenClosing(closing.id, `Wire ${index} never came.`, { fault: "BUYER", actorId: fixture.desk.id }));
      } else {
        await prisma.buyerStrike.create({ data: { userId: fixture.buyer.id, closingId: `none-${index}`, reason: "Earlier miss." } });
      }
    }
    const standing = await strikeStanding(fixture.buyer.id);
    assert.equal(standing.active, limit);
    assert.equal(standing.paused, pauseMessage(limit));
    assert.equal(pauseMessage(2), "Your bidding is paused while the desk reviews two closings that didn't complete.");
    assert.equal(pauseMessage(1), "Your bidding is paused while the desk reviews one closing that didn't complete.");

    const paused = await check(fixture, 2, 1000);
    assert.ok(paused.error !== null);
    assert.equal(paused.error, pauseMessage(limit));
    assert.equal(paused.verification, true);
    assert.equal((await bidStanding(fixture.buyer.id)).paused, pauseMessage(limit));
    assert.equal(await inquiryBlock(fixture.buyer, fixture.listings[2]), null);
    // The desk heard when a real cancel took the buyer to the limit.
    if (limit <= 2) assert.ok((await prisma.notification.count({ where: { subject: { contains: literal(`Bidding paused · ${fixture.buyer.name}`) } } })) >= 1);

    const [first] = await prisma.buyerStrike.findMany({ where: { userId: fixture.buyer.id }, orderBy: { createdAt: "asc" } });
    assert.match((await clearStrike({ strikeId: first.id, actorId: fixture.desk.id, note: "short" })).error ?? "", /Say why/);
    assert.equal((await clearStrike({ strikeId: first.id, actorId: fixture.desk.id, note: "The wire landed late; the bank confirmed its own error." })).error, null);
    assert.match((await clearStrike({ strikeId: first.id, actorId: fixture.desk.id, note: "Clearing it a second time." })).error ?? "", /already cleared/);
    const cleared = await prisma.buyerStrike.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(cleared.clearedById, fixture.desk.id);
    assert.match(cleared.clearNote, /bank confirmed/);
    const logged = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: fixture.buyer.id, action: "STRIKE_CLEARED" } });
    assert.match(logged.detail, /bank confirmed/);

    assert.equal((await strikeStanding(fixture.buyer.id)).paused, null);
    assert.equal((await check(fixture, 2, 1000)).error, null);
  } finally {
    await cleanDesk(fixture);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The shared timeline, cut per side.

function timelineFixture(overrides: Partial<TimelineInput["closing"]> = {}): TimelineInput {
  const opened = noon("2026-11-02");
  const later = (days: number) => new Date(opened.getTime() + days * DAY);
  return {
    closing: {
      status: "OPEN",
      openedAt: opened,
      closedAt: null,
      canceledAt: null,
      cancelReason: null,
      cancelFault: null,
      targetCloseAt: later(30),
      salePrice: 90000,
      depositCents: 900000,
      depositDueAt: later(3),
      fundsReceivedCents: null,
      fundsReceivedAt: null,
      depositReceivedCents: 900000,
      depositReceivedAt: later(2),
      proceedsSentCents: null,
      proceedsSentAt: null,
      ...overrides,
    },
    steps: [
      { key: "PURCHASE_AGREEMENT", status: "COMPLETE", completedAt: later(1), dueAt: later(3), note: "Signed by both.", files: [{ id: "f1", originalName: "psa-signed.pdf", createdAt: later(1), uploadedById: "seller" }] },
      { key: "BUYER_DEPOSIT", status: "COMPLETE", completedAt: later(2), dueAt: later(3), note: "Deposit of $9,000.00 received.", files: [] },
      { key: "COLLATERAL_TRANSFER", status: "PENDING", completedAt: null, dueAt: later(15), note: "", files: [] },
      { key: "ASSIGNMENT", status: "PENDING", completedAt: null, dueAt: later(21), note: "", files: [] },
      { key: "PAYMENT_RECEIVED", status: "PENDING", completedAt: null, dueAt: later(27), note: "", files: [] },
      { key: "CLOSED", status: "PENDING", completedAt: null, dueAt: later(30), note: "", files: [] },
    ],
    audits: [
      { id: "a1", action: "CLOSING", actorId: "admin", detail: "PURCHASE_AGREEMENT", createdAt: later(1) },
      { id: "a2", action: "DEPOSIT_RECEIVED", actorId: "admin", detail: "Buyer deposit received: none to $9,000.00 on 2026-11-04 · DEP-1", createdAt: later(2) },
      { id: "a3", action: "PROCEEDS_SENT", actorId: "admin", detail: "Seller proceeds sent: none to $80,000.00 on 2026-11-05 · OUT-1", createdAt: later(3) },
      { id: "a4", action: "CLOSING_DATES", actorId: "admin", detail: "Target 2026-12-03. COLLATERAL_TRANSFER 2026-11-18", createdAt: later(4) },
      { id: "a5", action: "WIRE_EDIT", actorId: "admin", detail: "Before: old bank. After: new bank.", createdAt: later(4) },
      { id: "a6", action: "CLOSING_OVERRIDE", actorId: "admin", detail: "BUYER_DEPOSIT: no wire. Reason: bank letter", createdAt: later(2) },
    ],
    posts: [{ id: "p1", authorId: "buyer", body: "Is the allonge in the file?", createdAt: later(5) }],
    people: {
      admin: { name: "Dana Desk", role: "ADMIN" },
      seller: { name: "Sam Seller", companyName: "Seller Co", role: "INDIVIDUAL_SELLER" },
      buyer: { name: "Bea Buyer", role: "BUYER" },
    },
    sellerId: "seller",
    buyerIds: ["buyer"],
    days: 30,
    now: later(16),
  };
}

test("each party sees the timeline its closing page shows it, and the next step is marked", () => {
  const input = timelineFixture();
  const titles = (side: "desk" | "buyer" | "seller" | "observer") => dealTimeline(input, side).entries.map((entry) => entry.title);

  const desk = dealTimeline(input, "desk");
  assert.ok(titles("desk").includes("Buyer deposit recorded"));
  assert.ok(titles("desk").includes("Seller proceeds sent"));
  assert.ok(titles("desk").includes("Step marked without the wire on record"));
  assert.equal(desk.entries.find((entry) => entry.title === "Purchase agreement complete")?.who, "Dana Desk, desk");
  assert.match(desk.entries.find((entry) => entry.title === "Dates changed")?.detail ?? "", /Target Dec 3, 2026\. Collateral file transfer Nov 18, 2026/);
  assert.equal(desk.entries.find((entry) => entry.title === "Wire instructions changed")?.detail, "Before: old bank. After: new bank.");

  // The buyer: their own deposit, not the seller's proceeds or the desk's override, and the desk without names.
  const buyer = dealTimeline(input, "buyer");
  assert.ok(titles("buyer").includes("Buyer deposit recorded"));
  assert.ok(!titles("buyer").includes("Seller proceeds sent"));
  assert.ok(!titles("buyer").includes("Step marked without the wire on record"));
  assert.equal(buyer.entries.find((entry) => entry.title === "Buyer deposit recorded")?.detail, "$9,000.00 on Nov 4, 2026 · reference DEP-1");
  assert.equal(buyer.entries.find((entry) => entry.title === "Purchase agreement complete")?.who, "The desk");
  assert.match(buyer.entries.find((entry) => entry.title === "Closing opened")?.detail ?? "", /Awarded at \$90,000\..*deposit of \$9,000 is due/);
  assert.match(buyer.entries.find((entry) => entry.title === "Wire instructions changed")?.detail ?? "", /Confirm them by phone/);
  assert.ok(buyer.entries.some((entry) => entry.title === "Message" && entry.owner === "buyer" && entry.who === "Bea Buyer"));

  // The seller: their proceeds, not the buyer's deposit or the deposit terms.
  const seller = dealTimeline(input, "seller");
  assert.ok(titles("seller").includes("Seller proceeds sent"));
  assert.ok(!titles("seller").includes("Buyer deposit recorded"));
  assert.doesNotMatch(seller.entries.find((entry) => entry.title === "Closing opened")?.detail ?? "", /deposit/);
  assert.equal(seller.entries.find((entry) => entry.id === "file:f1")?.detail, "psa-signed.pdf");
  assert.equal(seller.entries.find((entry) => entry.id === "file:f1")?.who, "Seller Co");

  // A broker watching the deal: steps, files by count and dates. No figures, file names, wires or messages.
  const observer = dealTimeline(input, "observer");
  assert.deepEqual(
    titles("observer").filter((title) => /recorded|proceeds|Message|Wire instructions|without the wire/.test(title)),
    [],
  );
  assert.equal(observer.entries.find((entry) => entry.id === "file:f1")?.detail, "");
  assert.doesNotMatch(observer.entries.find((entry) => entry.title === "Closing opened")?.detail ?? "", /\$/);
  assert.ok(titles("observer").includes("Dates changed"));

  // Oldest first, then the open steps in due order with the first marked next and a late one flagged.
  const times = desk.entries.map((entry) => entry.at.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.deepEqual(desk.upcoming.map((step) => step.key), ["COLLATERAL_TRANSFER", "ASSIGNMENT", "PAYMENT_RECEIVED", "CLOSED"]);
  assert.deepEqual(desk.upcoming.map((step) => step.next), [true, false, false, false]);
  assert.equal(desk.upcoming[0].owner, "seller");
  assert.equal(desk.upcoming[0].late, true);

  // A cancel: the fault is the desk's record, and each side hears only a finding against itself.
  const canceled = timelineFixture({ status: "CANCELED", canceledAt: noon("2026-11-20"), cancelReason: "The wire never came.", cancelFault: "BUYER" });
  const detail = (side: "desk" | "buyer" | "seller" | "observer") => dealTimeline(canceled, side).entries.find((entry) => entry.title === "Closing canceled")?.detail ?? "";
  assert.match(detail("desk"), /buyer's failure to close, with a strike/);
  assert.match(detail("buyer"), /strike on the buyer file/);
  assert.equal(detail("seller"), "The wire never came.");
  assert.equal(detail("observer"), "The wire never came.");
  assert.deepEqual(dealTimeline(canceled, "desk").upcoming, []);
});

// ---------------------------------------------------------------------------------------------------------------
// Settlement days.

test("payment and the close snap to the next settlement day, and older closings keep their dates", () => {
  assert.deepEqual(settlementWeekdays("TUE,THU"), [2, 4]);
  assert.deepEqual(settlementWeekdays("thu, tue"), [2, 4]);
  assert.deepEqual(settlementWeekdays(null), [1, 2, 3, 4, 5]);
  assert.deepEqual(settlementWeekdays("SAT,SUN"), [1, 2, 3, 4, 5]);
  assert.equal(settlementSetting(["THU", "TUE", "SAT"]), "TUE,THU");
  assert.equal(settlementSetting([]), null);
  assert.equal(settlementSetting(["MON", "TUE", "WED", "THU", "FRI"]), null);
  assert.equal(settlementLabel("TUE,THU"), "Tuesdays and Thursdays");
  assert.equal(settlementLabel(null), "any business day");

  // Saturday Nov 21 goes to Tuesday Nov 24; a settlement day stays put.
  assert.equal(nextSettlementDay(noon("2026-11-21"), [2, 4]).toISOString(), noon("2026-11-24").toISOString());
  assert.equal(nextSettlementDay(noon("2026-11-19"), [2, 4]).toISOString(), noon("2026-11-19").toISOString());
  assert.equal(settlesOn(noon("2026-11-17")), "Tuesday, Nov 17");

  // Opened Wednesday Nov 4: payment falls on Tuesday Dec 1 and stays, the close on Friday Dec 4 moves to Tuesday Dec 8.
  const opened = noon("2026-11-04");
  const snapped = closingSchedule(opened, 30, [2, 4]);
  const offsets = Object.values(snapped.due).map((date) => Math.round((date.getTime() - opened.getTime()) / DAY));
  assert.deepEqual(offsets, [3, 6, 15, 21, 27, 34]);
  assert.equal(snapped.due.CLOSED.toISOString(), noon("2026-12-08").toISOString());
  assert.equal(snapped.targetCloseAt.toISOString(), snapped.due.CLOSED.toISOString());
  // Any business day: a Saturday close moves to Monday.
  assert.equal(closingSchedule(noon("2026-11-05"), 30, settlementWeekdays(null)).due.CLOSED.toISOString(), noon("2026-12-07").toISOString());

  // Without weekdays the schedule is the plain spread, which is what an older closing's undated steps read.
  const plain = closingSchedule(noon("2026-11-05"), 30);
  assert.equal(plain.due.CLOSED.toISOString(), noon("2026-12-05").toISOString());
  const legacy = { openedAt: noon("2026-11-05"), targetCloseAt: null };
  assert.equal(effectiveDue({ key: "CLOSED", status: "PENDING", dueAt: null }, legacy, 30)?.toISOString(), noon("2026-12-05").toISOString());
  assert.equal(effectiveDue({ key: "PAYMENT_RECEIVED", status: "PENDING", dueAt: noon("2026-11-28") }, legacy, 30)?.toISOString(), noon("2026-11-28").toISOString());
});

test("a new closing settles on a settlement day, and an open closing's stored dates don't move", async () => {
  const fixture = await makeDesk({ listings: 2 });
  try {
    // An existing closing with a Saturday close, stored before settlement days.
    const old = await awardedClosing(fixture, 0, 10000);
    const saturday = noon("2026-12-05");
    await prisma.closingStep.updateMany({ where: { closingId: old.id, key: "CLOSED" }, data: { dueAt: saturday } });
    await prisma.closing.update({ where: { id: old.id }, data: { targetCloseAt: saturday } });

    const fresh = await awardedClosing(fixture, 1, 10000);
    const weekdays = settlementWeekdays((await getSettings()).settlementDays);
    const steps = await prisma.closingStep.findMany({ where: { closingId: fresh.id } });
    for (const key of ["PAYMENT_RECEIVED", "CLOSED"]) {
      const due = steps.find((step) => step.key === key)?.dueAt;
      assert.ok(due && weekdays.includes(due.getUTCDay()), `${key} falls on a settlement day`);
    }
    assert.equal(fresh.targetCloseAt?.toISOString(), steps.find((step) => step.key === "CLOSED")?.dueAt?.toISOString());

    const kept = await prisma.closingStep.findFirstOrThrow({ where: { closingId: old.id, key: "CLOSED" } });
    assert.equal(kept.dueAt?.toISOString(), saturday.toISOString());
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: old.id } })).targetCloseAt?.toISOString(), saturday.toISOString());
  } finally {
    await cleanDesk(fixture);
  }
});
