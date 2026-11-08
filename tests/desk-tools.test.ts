import assert from "node:assert/strict";
import test from "node:test";
import { redirect } from "next/navigation";
import { bidCapBlock, bidCapFor, bidCapRule, capBlock, capHint, capLine, completedCloses, newBidderClosesOf, readCapDollars, readReason, type CapInput } from "../lib/bid-caps";
import { bidViews, buyerRates, SEALED_DETAIL, walledFigure, type RawBid } from "../lib/buyer-desk";
import { literal } from "../lib/db-filters";
import { bulkDetail, bulkHead, captureOutcome, isRunId, outcomeFromUrl, parseBulkDetail, pickedIds, runBulk } from "../lib/desk-bulk";
import { editDetail, listingChanges, readEditReason, sellerEditNotice, type EditSnapshot } from "../lib/desk-edits";
import { approvalHold } from "../lib/discrepancies";
import { bidStanding, checkOffer } from "../lib/inquiry";
import { prisma } from "../lib/prisma";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: f-desk- people and listings nothing seeded touches, removed by id afterwards.

function world() {
  const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string; email: string }[] = [];
  const listings: string[] = [];
  const person = async (prefix: string, role: "BUYER" | "INDIVIDUAL_SELLER", extra: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: {
        email: `f-desk-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
        ...extra,
      },
    });
    users.push(user);
    return user;
  };
  const listing = async (sellerId: string, data: Record<string, unknown> = {}) => {
    const row = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId,
        status: "APPROVED",
        approvedAt: new Date(Date.now() - 7 * DAY),
        title: `Desk tools ${tag}`,
        notes: {
          create: [
            {
              streetAddress: "1 First St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
              lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
              askingPrice: 80000, estimatedValue: 200000,
            } as never,
          ],
        },
        ...data,
      },
      include: { notes: true },
    });
    listings.push(row.id);
    return row;
  };
  const clean = async () => {
    const userIds = users.map((user) => user.id);
    const inquiryIds = (await prisma.inquiry.findMany({ where: { OR: [{ listingId: { in: listings } }, { buyerId: { in: userIds } }] }, select: { id: true } })).map((row) => row.id);
    const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listings } }, select: { id: true } })).map((row) => row.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listings, ...inquiryIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
    await prisma.closingFunder.deleteMany({ where: { OR: [{ closingId: { in: closingIds } }, { userId: { in: userIds } }] } });
    await prisma.closing.deleteMany({ where: { id: { in: closingIds } } });
    await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
    await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
    await prisma.fieldDiscrepancy.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.note.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.listing.deleteMany({ where: { id: { in: listings } } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: users.map((user) => user.email) } }, { subject: { contains: literal(tag) } }] } });
    await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  };
  return { tag, person, listing, clean };
}

const approvedFile = (userId: string, funds: number) => ({
  userId,
  status: "APPROVED" as const,
  accredited: true,
  entityName: "Test Buyer LLC",
  proofAmount: funds,
  proofVerifiedAt: new Date(Date.now() - DAY),
  proofExpiresAt: new Date(Date.now() + 60 * DAY),
  recertifyBy: new Date(Date.now() + 300 * DAY),
});

// ---------------------------------------------------------------------------------------------------------------
// 1. The cap rule.

const rule = (over: Partial<CapInput> = {}) =>
  bidCapRule({ fundsCents: 10_000_000, deskCapCents: null, newBidderCapCents: null, newBidderCloses: null, closes: 0, lifted: false, ...over });

test("a buyer's largest bid is the lowest of verified funds, the desk's cap and the new-bidder cap", () => {
  // Funds lowest: the funds check speaks for it, and the caps are named as they stand.
  const funds = rule({ fundsCents: 3_000_000, deskCapCents: 5_000_000, newBidderCapCents: 4_000_000 });
  assert.equal(funds.capCents, 3_000_000);
  assert.equal(funds.source, "funds");
  assert.equal(funds.newBidder, "applies");
  assert.equal(capLine(funds), null);
  assert.match(capBlock(funds, 3_500_000) ?? "", /verified funds are \$30,000/);

  // The desk's own cap lower.
  const desk = rule({ deskCapCents: 2_000_000, newBidderCapCents: 4_000_000 });
  assert.equal(desk.source, "desk");
  assert.equal(desk.capCents, 2_000_000);
  assert.equal(capBlock(desk, 2_000_000), null);
  assert.match(capBlock(desk, 2_000_100) ?? "", /The desk set your largest single bid at \$20,000\. Bid \$20,000 or less\. Write the desk/);

  // The new-bidder cap, until the first close; missing newBidderCloses means one.
  const fresh = rule({ deskCapCents: 6_000_000, newBidderCapCents: 2_500_000 });
  assert.equal(fresh.source, "newBidder");
  assert.equal(fresh.closesNeeded, 1);
  const message = capBlock(fresh, 3_000_000) ?? "";
  assert.match(message, /New bidders bid up to \$25,000 on one bid until they have closed 1 deal on UPB\. You have closed 0 deals\./);
  assert.match(message, /Close a deal to lift it, or write the desk/);
  assert.match(capLine(fresh) ?? "", /until you have closed 1 deal/);

  // Lifted by the desk: the desk cap, then the funds, take over.
  const lifted = rule({ deskCapCents: 6_000_000, newBidderCapCents: 2_500_000, lifted: true });
  assert.equal(lifted.newBidder, "lifted");
  assert.equal(lifted.source, "desk");
  assert.equal(capBlock(lifted, 3_000_000), null);

  // Lifted by closes: two closings needed, two done.
  const closed = rule({ newBidderCapCents: 2_500_000, newBidderCloses: 2, closes: 2 });
  assert.equal(closed.newBidder, "graduated");
  assert.equal(closed.source, "funds");
  assert.equal(capBlock(closed, 3_000_000), null);
  const oneShort = rule({ newBidderCapCents: 2_500_000, newBidderCloses: 2, closes: 1 });
  assert.equal(oneShort.newBidder, "applies");
  assert.match(capBlock(oneShort, 3_000_000) ?? "", /closed 2 deals on UPB\. You have closed 1 deal\. .*Close a deal to lift it/);

  // No cap and no funds on file: nothing limits one bid here.
  const open = rule({ fundsCents: null });
  assert.equal(open.capCents, null);
  assert.equal(capBlock(open, 99_000_000), null);
  // A tie names the desk's cap, which this check enforces.
  assert.equal(rule({ fundsCents: 2_000_000, deskCapCents: 2_000_000 }).source, "desk");

  // The line beside each bid box, only for a cap below the funds.
  assert.deepEqual(capHint(fresh), { cents: 2_500_000, line: "Your largest bid right now: $25,000. Close a deal or ask the desk to raise it." });
  assert.deepEqual(capHint(desk), { cents: 2_000_000, line: "Your largest bid right now: $20,000. Ask the desk to raise it." });
  assert.equal(capHint(funds), null);
  assert.equal(capHint(open), null);
});

test("the desk's cap inputs read whole figures and want a reason", () => {
  assert.deepEqual(readCapDollars(""), { error: null, cents: null });
  assert.deepEqual(readCapDollars("$25,000"), { error: null, cents: 2_500_000 });
  assert.ok(readCapDollars("500").error);
  assert.ok(readCapDollars("abc").error);
  assert.ok(readReason(" no").error);
  assert.deepEqual(readReason("  First deal   pending  "), { error: null, reason: "First deal pending" });
  assert.equal(newBidderClosesOf(undefined), 1);
  assert.equal(newBidderClosesOf(3), 3);
  assert.equal(newBidderClosesOf(99), 1);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The gate on a real bid, and closings counted once.

test("a bid over the desk's cap is refused with the cap and how to lift it, and one under it passes", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    // Lifted, so a new-bidder cap in the shared settings can't change which cap speaks.
    const buyer = await w.person("buyer", "BUYER", { bidCapCents: 5_000_000, bidCapLifted: true });
    await prisma.buyerProfile.create({ data: approvedFile(buyer.id, 1_000_000) });
    const listing = await w.listing(seller.id);
    const over = await checkOffer({ user: buyer, listing, noteId: "", amount: 60000, goodUntil: "" });
    assert.equal(over.error, "The desk set your largest single bid at $50,000. Bid $50,000 or less. Write the desk to ask for a higher limit.");
    assert.equal(over.error !== null && over.verification, false);
    const under = await checkOffer({ user: buyer, listing, noteId: "", amount: 45000, goodUntil: "" });
    assert.equal(under.error, null);
    // The bid forms read the cap from the buyer's standing.
    assert.deepEqual((await bidStanding(buyer.id)).cap, { cents: 5_000_000, line: "Your largest bid right now: $50,000. Ask the desk to raise it." });
    // A group seat checks the same helper.
    assert.match((await bidCapBlock(buyer.id, 50001)) ?? "", /\$50,000/);
    assert.equal(await bidCapBlock(buyer.id, 50000), null);
  } finally {
    await w.clean();
  }
});

test("closings count once each, as the winning buyer or a funder, and graduate a buyer past the new-bidder cap", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await w.person("closer", "BUYER");
    await prisma.buyerProfile.create({ data: approvedFile(buyer.id, 1_000_000) });
    const settings = { newBidderCapCents: 2_500_000, newBidderCloses: 2 };
    assert.equal(await completedCloses(buyer.id), 0);
    assert.equal((await bidCapFor(buyer.id, { settings })).source, "newBidder");
    assert.match((await bidCapBlock(buyer.id, 30000, { settings })) ?? "", /New bidders bid up to \$25,000/);

    const closing = (listingId: string, status: "COMPLETE" | "CANCELED" | "OPEN", inquiryId?: string) =>
      prisma.closing.create({
        data: { listingId, status, salePrice: 50000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 5_000_000, netToSellerCents: 5_000_000, ...(inquiryId ? { inquiryId } : {}) },
      });
    const first = await w.listing(seller.id, { status: "SOLD" });
    const won = await prisma.inquiry.create({ data: { listingId: first.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 50000 } });
    const done = await closing(first.id, "COMPLETE", won.id);
    // The group lead also funds a seat on the same closing: still one.
    await prisma.closingFunder.create({ data: { closingId: done.id, userId: buyer.id, amount: 25000, premiumCents: 0, percent: 50 } });
    assert.equal(await completedCloses(buyer.id), 1);
    // A canceled closing doesn't count.
    const failed = await w.listing(seller.id, { status: "APPROVED" });
    const lost = await prisma.inquiry.create({ data: { listingId: failed.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 40000 } });
    await closing(failed.id, "CANCELED", lost.id);
    assert.equal(await completedCloses(buyer.id), 1);
    // A seat on someone else's closing does.
    const group = await w.listing(seller.id, { status: "SOLD" });
    const funded = await closing(group.id, "COMPLETE");
    await prisma.closingFunder.create({ data: { closingId: funded.id, userId: buyer.id, amount: 20000, premiumCents: 0, percent: 40 } });
    assert.equal(await completedCloses(buyer.id), 2);
    const cap = await bidCapFor(buyer.id, { settings });
    assert.equal(cap.newBidder, "graduated");
    assert.equal(await bidCapBlock(buyer.id, 30000, { settings }), null);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The buyer profile keeps the sealed-bid wall.

test("the buyer profile hides sealed amounts from a role behind the wall and shows them to sales", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const sealed = { title: "Sealed pool", bidMode: "SEALED", bidDeadline: new Date(now.getTime() + DAY), status: "APPROVED" };
  const open = { title: "Open loan", bidMode: "NONE", bidDeadline: null, status: "APPROVED" };
  const bid = (id: string, listing: RawBid["listing"], amount: number): RawBid => ({
    id,
    buyerId: "buyer",
    listingId: `listing-${id}`,
    status: "OPEN",
    createdAt: now,
    amount,
    messages: [{ kind: "COUNTER", amount: amount + 1000, createdAt: now, authorId: "buyer" }],
    listing,
  });
  const bids = [bid("a", sealed, 90000), bid("b", open, 50000)];
  const compliance = { role: "ADMIN", deskRole: "COMPLIANCE" };
  const [hidden, shown] = bidViews(compliance, bids, now);
  assert.equal(hidden.sealed, true);
  assert.equal(hidden.amount, null);
  assert.equal(hidden.listingTitle, "Sealed pool");
  // The buyer's own latest price, not the opening amount.
  assert.equal(shown.amount, 51000);
  for (const viewer of [{ role: "ADMIN", deskRole: "SALES" }, { role: "ADMIN", deskRole: null }]) {
    assert.equal(bidViews(viewer, bids, now)[0].amount, 91000);
  }
  // Past the deadline the wall lifts for compliance.
  assert.equal(bidViews(compliance, bids, new Date(now.getTime() + 2 * DAY))[0].amount, 91000);
  // Closing figures and log lines on a walled listing go the same way.
  assert.equal(walledFigure(compliance, sealed, "OFFER_COUNTER $91,000", now), null);
  assert.equal(walledFigure({ role: "ADMIN", deskRole: "SALES" }, sealed, 91000, now), 91000);
  assert.ok(SEALED_DETAIL.length > 0);
});

test("win rate counts decided bids and close rate finished closings", () => {
  const rates = buyerRates(
    [{ status: "ACCEPTED" }, { status: "DECLINED" }, { status: "EXPIRED" }, { status: "OPEN" }, { status: "WITHDRAWN" }],
    [{ status: "COMPLETE" }, { status: "CANCELED" }, { status: "OPEN" }],
  );
  assert.equal(rates.bids, 5);
  assert.equal(rates.decided, 3);
  assert.equal(rates.won, 1);
  assert.equal(rates.winRate, 1 / 3);
  assert.equal(rates.finished, 2);
  assert.equal(rates.closeRate, 0.5);
  assert.equal(buyerRates([], []).winRate, null);
});

// ---------------------------------------------------------------------------------------------------------------
// 4. A desk edit's reason and diff.

const snapshot = (over: Record<string, unknown> = {}, notes: Record<string, unknown>[] = [{}]): EditSnapshot => ({
  title: "Austin first",
  summary: "Performing first lien.",
  notes: notes.map((note, index) => ({
    id: `n${index}`,
    streetAddress: "1 First St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    borrowerName: "Jane Doe",
    upb: 120000,
    askingPrice: 100000,
    estimatedValue: 250000,
    interestRate: 6.5,
    monthlyPi: 900,
    monthsDelinquent: 0,
    paymentStatus: "PERFORMING",
    memo: "Performing first lien.",
    ...note,
  })),
  ...over,
});

test("a desk edit needs a reason and records each changed field before and after", () => {
  assert.ok(readEditReason("").error);
  assert.ok(readEditReason("  ok ").error);
  assert.deepEqual(readEditReason(" Ask matched to   the tape "), { error: null, reason: "Ask matched to the tape" });

  const before = snapshot();
  const after = snapshot({}, [{ askingPrice: 95000 }]);
  const changes = listingChanges(before, after);
  assert.deepEqual(changes, [{ field: "n0.askingPrice", label: "Asking price", before: "$100,000", after: "$95,000" }]);
  assert.equal(editDetail("Ask matched to the tape", changes), "Reason: Ask matched to the tape · Changed: Asking price $100,000 → $95,000");
  assert.equal(sellerEditNotice("Ask matched to the tape", changes), "The desk changed Asking price on your listing. Reason: Ask matched to the tape. Open the listing to see the new figures, and write the desk if anything is wrong.");
  // Unchanged figures to the cent, and the same text, are not changes.
  assert.deepEqual(listingChanges(before, snapshot({ title: " Austin first " }, [{ askingPrice: 100000.001 }])), []);
  assert.equal(editDetail("Saved again", []), "Reason: Saved again · No field changed.");

  // A pool names each loan, and a long edit stays inside the audit log's 500 characters.
  const pool = snapshot({}, Array.from({ length: 30 }, (_, index) => ({ city: `City${index}` })));
  const repriced = snapshot({ title: "Austin first, repriced" }, Array.from({ length: 30 }, (_, index) => ({ city: `City${index}`, askingPrice: 90000 + index })));
  const many = listingChanges(pool, repriced);
  assert.equal(many.length, 31);
  assert.equal(many[1].label, "Loan in City0, TX: Asking price");
  const detail = editDetail("Tape repriced", many);
  assert.ok(detail.length <= 500);
  assert.match(detail, /^Reason: Tape repriced · Changed: Title Austin first → Austin first, repriced; Loan in City0, TX: Asking price \$100,000 → \$90,000;/);
  assert.match(detail, /; and \d+ more$/);
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Bulk approval goes through the single path and reports the listing a gate stops.

test("bulk approve runs each listing through its gates and reports the one the discrepancy gate holds", async () => {
  const w = world();
  try {
    const seller = await w.person("bulk-seller", "INDIVIDUAL_SELLER");
    const clear = await w.listing(seller.id, { status: "SUBMITTED", approvedAt: null, title: `Clear ${w.tag}` });
    const held = await w.listing(seller.id, { status: "SUBMITTED", approvedAt: null, title: `Held ${w.tag}` });
    await prisma.fieldDiscrepancy.create({ data: { listingId: held.id, noteId: held.notes[0].id, field: "upb", tapeValue: "100000", documentValue: "98000", status: "OPEN" } });
    // The single-listing decision answers with a redirect, as reviewListing does, and runs its gate first.
    const single = async (listingId: string) => {
      const hold = await approvalHold(listingId);
      if (hold) redirect(`/admin/listings/${listingId}?error=${encodeURIComponent(hold)}`);
      await prisma.listing.update({ where: { id: listingId }, data: { status: "APPROVED", approvedAt: new Date() } });
      redirect(`/admin/listings/${listingId}?notice=${encodeURIComponent("Listing is live")}`);
    };
    const rows = await runBulk([clear, held].map(({ id, title }) => ({ id, title })), (id) => captureOutcome(() => single(id)));
    assert.deepEqual(rows.map((row) => row.ok), [true, false]);
    assert.equal(rows[0].message, "Listing is live");
    assert.match(rows[1].message, /^One tape difference is open\./);
    assert.equal((await prisma.listing.findUnique({ where: { id: clear.id } }))?.status, "APPROVED");
    assert.equal((await prisma.listing.findUnique({ where: { id: held.id } }))?.status, "SUBMITTED");

    const head = bulkHead("APPROVE", rows);
    assert.deepEqual(head, { ok: false, text: "Approved 1 of 2. 1 still needs the desk. The reasons are below." });
    const line = bulkDetail("1a2b3c4d", "APPROVE", rows[1]);
    assert.match(line, /^Bulk 1a2b3c4d · approve · not done · One tape difference is open\./);
    assert.deepEqual(parseBulkDetail(line), { ok: false, message: rows[1].message });
    assert.equal(isRunId("1a2b3c4d"), true);
    assert.equal(isRunId("../../x"), false);
  } finally {
    await w.clean();
  }
});

test("a bulk run reads each answer from its redirect and keeps going past a failure", async () => {
  assert.deepEqual(outcomeFromUrl("/admin/listings/x?error=No%20way"), { ok: false, message: "No way" });
  assert.deepEqual(outcomeFromUrl("/admin/listings/x?notice=Changes%20requested"), { ok: true, message: "Changes requested" });
  assert.equal(outcomeFromUrl("/login").ok, false);
  const quiet = console.error;
  console.error = () => {};
  try {
    const rows = await runBulk(
      [{ id: "a", title: "A" }, { id: "b", title: "B" }],
      (id) => captureOutcome(async () => (id === "a" ? Promise.reject(new Error("boom")) : redirect("/admin/listings/b?notice=Listing%20is%20live"))),
    );
    assert.deepEqual(rows.map((row) => row.ok), [false, true]);
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(pickedIds(["a1", "a1", "b2", "../x", ""]), ["a1", "b2"]);
  assert.equal(pickedIds(Array.from({ length: 80 }, (_, index) => `id${index}`)).length, 50);
});
