import assert from "node:assert/strict";
import test from "node:test";
import { boardPack, coverFigures, poolAttrition } from "../lib/board-pack";
import { loadDealTimeline, openClosing, walkAwayFromClosing } from "../lib/closing-service";
import { literal } from "../lib/db-filters";
import { checkOffer } from "../lib/inquiry";
import { kickOutLoan } from "../lib/kickouts";
import { prisma } from "../lib/prisma";
import { WALK_AWAY_REASONS, loanShares, readWalkAway, rebidBlock, sameLoan, walkAwayLine } from "../lib/retrade";
import { SALE_FILE_LOCKED, awardCover, saleFile, saleFileCsv, saleFilePdf, sellerSaleFile, type BidOnRecord } from "../lib/sale-file";
import { trackRecordsFor } from "../lib/seller-decisions";
import { bidderFacts } from "../lib/track-record";

const DAY = 24 * 60 * 60 * 1000;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

// Stored files, mail and signing stay local, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The rules, without the database.

test("a walk-away needs a finding from the list, and Other needs the buyer's own words", () => {
  assert.deepEqual([...WALK_AWAY_REASONS], ["TITLE", "COLLATERAL", "PAY_HISTORY", "VALUE", "DATA_MISMATCH", "OCCUPANCY", "LITIGATION", "OTHER"]);
  assert.match(readWalkAway({ reason: "", words: "The title is clouded." }).error ?? "", /Choose what you found/);
  assert.match(readWalkAway({ reason: "BAD_VIBES", words: "The title is clouded." }).error ?? "", /Choose what you found/);
  assert.match(readWalkAway({ reason: "OTHER", words: "" }).error ?? "", /Say what you found/);
  assert.match(readWalkAway({ reason: "OTHER", words: "No." }).error ?? "", /Say what you found/);
  const title = readWalkAway({ reason: "TITLE", words: "" });
  assert.equal(title.error, null);
  assert.ok(title.error === null && title.text === "Title.");
  const other = readWalkAway({ reason: "other", words: "  The servicer won't confirm   the escrow balance " });
  assert.ok(other.error === null && other.reason === "OTHER" && other.text === "Other. The servicer won't confirm the escrow balance.");
});

test("the record counts walk-aways with their findings, never a grade", () => {
  assert.equal(walkAwayLine([]), null);
  assert.equal(walkAwayLine(["TITLE"]), "Walked away once in diligence: title");
  assert.equal(walkAwayLine(["PAY_HISTORY", "TITLE"]), "Walked away twice in diligence: title, pay history");
  assert.equal(walkAwayLine(["TITLE", null, "TITLE"]), "Walked away 3 times in diligence: title (2), no finding recorded");
});

test("a price spreads across loans by the buyer's loan prices, else the asks, and a relisted loan is the same loan", () => {
  const loans = [{ id: "a", ask: 60000 }, { id: "b", ask: 40000 }];
  assert.deepEqual([...loanShares(90000, loans).shares], [["a", 54000], ["b", 36000]]);
  const priced = loanShares(90000, loans, { a: 70000, b: 20000 });
  assert.equal(priced.basis, "loanPrice");
  assert.equal(priced.shares.get("a"), 70000);
  // Prices that no longer add up to the bid don't describe it.
  assert.equal(loanShares(80000, loans, { a: 70000, b: 20000 }).basis, "askShare");
  assert.equal(loanShares(100, [{ id: "a", ask: 0 }, { id: "b", ask: 0 }]).shares.get("b"), 50);
  const loan = { id: "x", askingPrice: 1, upb: 100000, streetAddress: "12 Main Street", city: "Mobile", state: "AL", zip: "36602", loanNumber: null, servicerName: null, mersMin: null };
  assert.ok(sameLoan(loan, { ...loan, id: "y", streetAddress: "12 MAIN ST", askingPrice: 5 }));
  assert.ok(!sameLoan(loan, { ...loan, id: "z", streetAddress: "14 Main Street", zip: "36603", city: "Dothan" }));
});

test("the cover bid is the highest other bid on the same loans before the award, over the winning bid", () => {
  const at = day("2026-03-10");
  const bid = (id: string, amount: number, extra: Partial<BidOnRecord> = {}): BidOnRecord => ({ id, buyerId: `buyer-${id}`, noteId: null, amount, status: "DECLINED", createdAt: day("2026-03-01"), messages: [], ...extra });
  const bids = [
    bid("win", 100000, { status: "ACCEPTED" }),
    bid("second", 94000),
    bid("third", 90000),
    // Not rivals: another loan's bid, one placed after the award, one withdrawn before it, and one lapsed by then.
    bid("loan", 99000, { noteId: "n1" }),
    bid("late", 99000, { createdAt: day("2026-03-11") }),
    bid("gone", 98000, { status: "WITHDRAWN", withdrawnAt: day("2026-03-05") }),
    bid("lapsed", 97000, { expiresAt: day("2026-03-09") }),
    // A price the buyer posted after the award doesn't count; the one before does.
    bid("raised", 80000, { messages: [{ kind: "COUNTER", amount: 95000, createdAt: day("2026-03-12"), authorId: "buyer-raised" }] }),
  ];
  const cover = awardCover({ winner: { id: "win", noteId: null, price: 100000 }, at, bids });
  assert.deepEqual(cover, { winnerPrice: 100000, bids: 4, cover: 94000, ratio: 0.94 });
  // One bid: no cover, counted on its own.
  const alone = awardCover({ winner: { id: "loan", noteId: "n1", price: 99000 }, at, bids });
  assert.deepEqual(alone, { winnerPrice: 99000, bids: 1, cover: null, ratio: null });
  assert.equal(awardCover({ winner: { id: null, noteId: null, price: null }, at, bids }), null);
  const figures = coverFigures([cover, alone, { winnerPrice: 1, bids: 2, cover: 0.9, ratio: 0.9 }, null]);
  assert.ok(Math.abs((figures.median ?? 0) - 0.92) < 1e-9);
  assert.deepEqual({ contested: figures.contested, oneBid: figures.oneBid }, { contested: 2, oneBid: 1 });
  assert.deepEqual(coverFigures([alone]), { median: null, contested: 0, oneBid: 1 });
});

test("pool attrition counts each loan once from offered to awarded to closed, with kick-outs by count and UPB", () => {
  const loan = (id: string, upbCents: number) => ({ id, upbCents });
  const figures = poolAttrition([
    // A pool of three bid whole: the desk kicked one out, and two closed.
    { offered: [loan("a", 10_000_000), loan("b", 8_000_000), loan("c", 5_000_000)], awarded: [loan("a", 10_000_000), loan("b", 8_000_000), loan("c", 5_000_000)], closed: [loan("a", 10_000_000), loan("b", 8_000_000)], kickedOut: [loan("c", 5_000_000)] },
    // A walk-away, then the same loan awarded again and closed: offered and closed once each.
    { offered: [loan("d", 4_000_000)], awarded: [loan("d", 4_000_000)], closed: [], kickedOut: [] },
    { offered: [loan("d", 4_000_000)], awarded: [loan("d", 4_000_000)], closed: [loan("d", 4_000_000)], kickedOut: [] },
  ]);
  assert.deepEqual(figures, {
    offered: { loans: 4, upbCents: 27_000_000 },
    awarded: { loans: 4, upbCents: 27_000_000 },
    closed: { loans: 3, upbCents: 22_000_000 },
    kickedOut: { loans: 1, upbCents: 5_000_000 },
    lostShare: 5_000_000 / 27_000_000,
  });
  assert.equal(poolAttrition([]).lostShare, null);
});

// ---------------------------------------------------------------------------------------------------------------
// On the database. Every row carries this run's tag and is removed by id at the end.

const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

type Made = { users: string[]; listings: string[] };

async function person(made: Made, prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN", extra: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `retrade-${prefix}-${tag}@example.org`,
      name: `${prefix} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...extra,
    },
  });
  made.users.push(user.id);
  return user;
}

async function buyerFile(userId: string, name: string) {
  // Approved with no verified ceiling, so the funds limit stays out of these bids.
  await prisma.buyerProfile.create({ data: { userId, status: "APPROVED", entityType: "LLC", entityName: name, homesControlled: 2, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY) } });
}

const loanData = (street: string, upb: number, ask: number, extra: Record<string, unknown> = {}) => ({
  streetAddress: street, city: "Retradeville", state: "ZZ", zip: "00911", propertyType: "SFR", occupancy: "VACANT", lienPosition: "FIRST",
  upb, interestRate: 7, monthlyPi: 900, paymentStatus: "PERFORMING", monthsDelinquent: 0, askingPrice: ask, estimatedValue: upb * 1.4, ...extra,
});

async function pool(made: Made, sellerId: string, title: string, loans: ReturnType<typeof loanData>[], extra: Record<string, unknown> = {}) {
  const listing = await prisma.listing.create({
    data: { kind: loans.length > 1 ? "POOL" : "SINGLE", sellerId, status: "APPROVED", approvedAt: new Date(Date.now() - 7 * DAY), title: `${title} ${tag}`, notes: { create: loans as never }, ...extra },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
  made.listings.push(listing.id);
  return listing;
}

// Nested loans can share a timestamp, so a test finds each by its street rather than its place.
const street = <T extends { streetAddress: string }>(listing: { notes: T[] }, address: string) => listing.notes.find((note) => note.streetAddress === address)!;

// A won whole-listing bid with its closing open and the diligence window running.
async function wonInDiligence(listing: { id: string; title: string }, buyerId: string, amount: number) {
  const bid = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId, type: "OFFER", amount, status: "ACCEPTED" } });
  await prisma.listing.update({ where: { id: listing.id }, data: { status: "PENDING", acceptedInquiryId: bid.id } });
  const closing = await openClosing({ listingId: listing.id, inquiryId: bid.id, noteId: null, salePrice: amount, title: listing.title });
  await prisma.closing.update({ where: { id: closing.id }, data: { diligenceEndsAt: new Date(Date.now() + 3 * DAY) } });
  return { bid, closing };
}

async function clean(made: Made) {
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: made.listings } }, select: { id: true } })).map((row) => row.id);
  const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: made.listings } }, select: { id: true } })).map((row) => row.id);
  const subjects = [...made.listings, ...inquiryIds, ...closingIds];
  await prisma.buyerStrike.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...subjects, ...made.users] } }, { actorId: { in: made.users } }] } });
  await prisma.deskNote.deleteMany({ where: { subjectId: { in: subjects } } });
  await prisma.ofacCheck.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { listingId: { in: made.listings } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: made.listings } }, { inquiryId: { in: inquiryIds } }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId: { in: made.listings } } });
  await prisma.listing.deleteMany({ where: { id: { in: made.listings } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { contains: literal(tag) } }, { subject: { contains: literal(tag) } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
}

test("a walk-away stores its finding, tells both sides, stays no-fault, and the firm can't come back lower", async () => {
  const made: Made = { users: [], listings: [] };
  try {
    const seller = await person(made, "seller", "INDIVIDUAL_SELLER");
    const desk = await person(made, "desk", "ADMIN");
    const buyer = await person(made, "buyer", "BUYER", { companyName: `Walker Fund ${tag}` });
    await buyerFile(buyer.id, `Walker Fund ${tag}`);
    // A seat on the buyer's firm, signed in as the firm (lib/seats.ts).
    const seatRow = await person(made, "seat", "BUYER", { principalId: buyer.id, seatRole: "TRADE" });
    const seat = { ...buyer, actor: { id: seatRow.id, name: seatRow.name, email: seatRow.email, seatRole: "TRADE", bidLimitCents: null } };
    const rival = await person(made, "rival", "BUYER");
    await buyerFile(rival.id, `Rival ${tag}`);

    // A two-loan pool, asks 60k and 40k, won whole at 90k.
    const listing = await pool(made, seller.id, "Retrade pool", [loanData("10 Walk Way", 100000, 60000), loanData("20 Walk Way", 80000, 40000)]);
    const loanA = street(listing, "10 Walk Way");
    await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: rival.id, type: "OFFER", amount: 87000, status: "OPEN" } });
    const { closing } = await wonInDiligence(listing, buyer.id, 90000);

    // No finding, or Other without words, is refused and nothing changes.
    assert.match((await walkAwayFromClosing(closing.id, buyer.id, { reason: "", words: "The title search shows a second lien." })).error ?? "", /Choose what you found/);
    assert.match((await walkAwayFromClosing(closing.id, buyer.id, { reason: "OTHER", words: "" })).error ?? "", /Say what you found/);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).status, "OPEN");

    assert.equal((await walkAwayFromClosing(closing.id, buyer.id, { reason: "TITLE", words: "The title search shows a second lien." })).error, null);
    const after = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
    assert.equal(after.status, "CANCELED");
    assert.equal(after.walkAwayReason, "TITLE");
    assert.equal(after.cancelReason, "The buyer walked away in diligence: Title. The title search shows a second lien.");
    assert.equal(after.cancelFault, "NEITHER");
    assert.equal(await prisma.buyerStrike.count({ where: { userId: buyer.id } }), 0, "a walk-away is never a strike");
    // The seller and the desk read the finding in the notice and on the timeline.
    const notice = await prisma.notification.findFirstOrThrow({ where: { toEmail: seller.email, subject: `Buyer walked away · ${listing.title}` } });
    assert.match(notice.body, /Reason: Title\. The title search shows a second lien\./);
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: desk.email, subject: `Buyer walked away · ${listing.title}`, body: { contains: "Reason: Title." } } }));
    const timeline = await loadDealTimeline(closing.id, "seller");
    assert.equal(timeline?.entries.find((entry) => entry.title === "The buyer walked away in diligence")?.detail, "Title. The title search shows a second lien.");

    const bidOn = (user: typeof buyer, amount: number, noteId = "") => checkOffer({ user, listing: { ...listing, status: "APPROVED" }, noteId, amount, goodUntil: "" });
    // Lower, from the firm or its seat, is refused with the firm's own price and nothing of the rival's.
    const lower = await bidOn(buyer, 85000);
    assert.equal(lower.error, "You walked away from these loans in diligence at $90,000. A new bid on them can't be lower, so bid $90,000 or more.");
    assert.ok(!(lower.error ?? "").includes("87,000"));
    assert.match((await bidOn(seat, 89999)).error ?? "", /walked away from these loans in diligence at \$90,000/);
    // A seat's own account reads as its firm too.
    assert.match((await rebidBlock({ userIds: [seatRow.id], listingId: listing.id, noteId: null, amount: 80000 })) ?? "", /walked away/);
    // At the price or above, the bid goes through.
    assert.equal((await bidOn(buyer, 90000)).error, null);
    assert.equal((await bidOn(seat, 95000)).error, null);
    // Another buyer bids what they like.
    assert.equal((await bidOn(rival, 50000)).error, null);
    // One loan of the pool: its share of the walked price by the asks, 54k of 90k.
    assert.match((await bidOn(buyer, 53000, loanA.id)).error ?? "", /from a loan in this bid, at \$54,000 for it\. This bid puts \$53,000 on it/);
    assert.equal(await rebidBlock({ userIds: [buyer.id], listingId: listing.id, noteId: loanA.id, amount: 54000 }), null);
    // A group the firm opens or sits in is held to the same price.
    assert.match((await rebidBlock({ userIds: [buyer.id], actorId: buyer.id, listingId: listing.id, noteId: null, amount: 80000, group: true })) ?? "", /can't join a group bid of less/);
    const told = await rebidBlock({ userIds: [rival.id, buyer.id], actorId: rival.id, listingId: listing.id, noteId: null, amount: 80000, group: true });
    assert.match(told ?? "", /A seat in this group walked away from these loans in diligence at a higher price/);
    assert.ok(!(told ?? "").includes("$"), "another seat's price stays out");

    // The same loan relisted inside another pool keeps its floor; a different loan beside it doesn't add one.
    const relist = await pool(made, seller.id, "Retrade relist", [loanData("10 WALK WAY", 100000, 70000), loanData("99 Other Rd", 50000, 30000)]);
    assert.match((await rebidBlock({ userIds: [buyer.id], listingId: relist.id, noteId: null, amount: 70000 })) ?? "", /at \$54,000 for it\. This bid puts \$49,000 on it, by their share of the asking prices/);
    assert.equal(await rebidBlock({ userIds: [buyer.id], listingId: relist.id, noteId: null, amount: 80000 }), null);
    assert.equal(await rebidBlock({ userIds: [buyer.id], listingId: relist.id, noteId: street(relist, "99 Other Rd").id, amount: 1000 }), null);

    // After a kick-out the floor is the price as kicked out, on the loans that were left.
    const second = await pool(made, seller.id, "Retrade kicked", [loanData("30 Kick Ct", 100000, 60000), loanData("40 Kick Ct", 80000, 40000)]);
    const kicked = await wonInDiligence(second, buyer.id, 100000);
    const [kept, gone] = [street(second, "30 Kick Ct"), street(second, "40 Kick Ct")];
    const out = await kickOutLoan({ closingId: kicked.closing.id, noteId: gone.id, reason: "Paid off before settlement.", actorId: desk.id });
    assert.equal(out.error, null);
    assert.equal((await walkAwayFromClosing(kicked.closing.id, buyer.id, { reason: "PAY_HISTORY", words: "" })).error, null);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: kicked.closing.id } })).walkAwayReason, "PAY_HISTORY");
    assert.equal(await rebidBlock({ userIds: [buyer.id], listingId: second.id, noteId: kept.id, amount: 60000 }), null);
    assert.match((await rebidBlock({ userIds: [buyer.id], listingId: second.id, noteId: kept.id, amount: 59000 })) ?? "", /at \$60,000\. A new bid on it can't be lower/);
    // The loan the desk took out was never walked away from.
    assert.equal(await rebidBlock({ userIds: [buyer.id], listingId: second.id, noteId: gone.id, amount: 1 }), null);

    // The seller reads the count and the findings beside the bidder, as facts.
    const facts = (await bidderFacts([buyer.id])).get(buyer.id) ?? [];
    assert.ok(facts.includes("Walked away twice in diligence: title, pay history"), facts.join(" | "));
    assert.ok(facts.includes("2 failed closings: 2 on neither side"));
    const fresh = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 91000, status: "OPEN" } });
    const record = (await trackRecordsFor([{ id: fresh.id, buyerId: buyer.id }])).get(fresh.id);
    assert.equal(record?.strikes, 0);
    assert.ok(record?.facts?.includes("Walked away twice in diligence: title, pay history"));
    assert.ok(!(record?.facts ?? []).some((line) => /score|grade|rating|\d+\s*\/\s*\d+ stars?/i.test(line)));
  } finally {
    await clean(made);
  }
});

test("the seller's sale file opens after an award and leaves out desk notes, screening and buyers' notices", async () => {
  const made: Made = { users: [], listings: [] };
  try {
    const seller = await person(made, "file-seller", "INDIVIDUAL_SELLER");
    const desk = await person(made, "file-desk", "ADMIN", { deskRole: "OWNER" });
    const winner = await person(made, "file-winner", "BUYER", { companyName: `Winner Capital ${tag}` });
    const rival = await person(made, "file-rival", "BUYER", { companyName: `Rival Capital ${tag}` });
    const stranger = await person(made, "file-stranger", "BUYER");
    const listing = await pool(made, seller.id, "Sale file", [loanData("50 File St", 120000, 90000)], { reservePrice: 80000 });
    const win = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: winner.id, type: "OFFER", amount: 100000, status: "OPEN", createdAt: new Date(Date.now() - 3 * DAY) } });
    const lose = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: rival.id, type: "OFFER", amount: 95000, status: "OPEN", createdAt: new Date(Date.now() - 2 * DAY) } });
    await prisma.ndaAcknowledgment.create({ data: { userId: rival.id, listingId: listing.id } });
    await prisma.deskNote.create({ data: { subjectType: "listing", subjectId: listing.id, authorId: desk.id, body: `Desk only: seller is motivated ${tag}` } });
    await prisma.ofacCheck.create({ data: { name: `Rival Capital ${tag}`, result: "REVIEW", matched: `SDN Entry ${tag}`, userId: rival.id, listingId: listing.id, status: "OPEN" } });

    // Before an award the seller has no sale file, and a buyer never does.
    const early = await sellerSaleFile(listing.id, seller);
    assert.equal(early.status, 403);
    assert.equal(early.status === 403 && early.error, SALE_FILE_LOCKED);

    await prisma.inquiry.update({ where: { id: win.id }, data: { status: "ACCEPTED" } });
    await prisma.inquiry.update({ where: { id: lose.id }, data: { status: "DECLINED" } });
    await prisma.auditEvent.create({ data: { actorId: seller.id, action: "SELLER_APPROVED", entityType: "inquiry", entityId: win.id, detail: `${listing.title} · $100,000` } });
    await prisma.auditEvent.create({ data: { actorId: desk.id, action: "AWARD", entityType: "inquiry", entityId: win.id, detail: `${listing.title} · ${winner.name} · within the seller's reserve` } });
    await prisma.notification.create({ data: { toEmail: rival.email, subject: `Bid not selected · ${listing.title}`, body: "Thank you for bidding." } });
    const closing = await openClosing({ listingId: listing.id, inquiryId: win.id, noteId: null, salePrice: 100000, title: listing.title });
    await prisma.deskNote.create({ data: { subjectType: "closing", subjectId: closing.id, authorId: desk.id, body: `Desk only: watch the wire ${tag}` } });
    await prisma.closing.update({ where: { id: closing.id }, data: { status: "COMPLETE", closedAt: new Date() } });
    await prisma.trailingDoc.create({ data: { closingId: closing.id, noteId: listing.notes[0].id, kind: "ORIGINAL_NOTE", owner: "SELLER", status: "RECEIVED", dueAt: new Date(Date.now() + 5 * DAY), receivedAt: new Date() } });

    assert.equal((await sellerSaleFile(listing.id, stranger)).status, 403);
    assert.equal((await sellerSaleFile(listing.id, desk)).status, 403, "the desk reads its own file");
    const result = await sellerSaleFile(listing.id, seller);
    assert.equal(result.status, 200);
    if (result.status !== 200) return;
    const file = result.file;
    assert.equal(file.copy, "seller");
    const section = (name: string) => file.rows.filter((row) => row.section === name);
    // The bids as the bid summary shows them: highest first, the awarded buyer named and the other by letter.
    assert.deepEqual(section("Bid").map((row) => [row.amount, row.status, row.reserveMet]), [[100000, "Accepted", "Yes"], [95000, "Declined", "Yes"]]);
    assert.equal(section("Bid")[0].party, `Winner Capital ${tag}`);
    assert.match(section("Bid")[1].party, /^Bidder [A-Z]+$/);
    assert.ok(section("Bid").every((row) => /track record: /.test(row.detail)));
    assert.deepEqual(section("Seller approval").map((row) => [row.status, row.by]), [["Approved", "The seller"]]);
    assert.deepEqual(section("Award").map((row) => [row.party, row.amount]), [[`Winner Capital ${tag}`, 100000]]);
    assert.deepEqual(section("Cover bid").map((row) => [row.amount, row.status]), [[95000, "95.00% of the winning bid"]]);
    assert.deepEqual(section("Closing outcome").map((row) => row.status), ["Closed"]);
    assert.equal(section("Trailing document").length, 1);
    assert.deepEqual(section("Interest").map((row) => [row.status, row.detail]), [["NDAs signed", "1"], ["Data room", "0 files taken by 0 buyers"]]);
    assert.equal(section("Decline sent").length, 0);
    assert.equal(section("Decline").length, 0);

    const csv = saleFileCsv(file);
    for (const hidden of ["Desk only", "SDN Entry", rival.email, winner.email, desk.name, "Bid not selected", `Rival Capital ${tag}`]) assert.ok(!csv.includes(hidden), hidden);
    const pdf = await saleFilePdf(file);
    assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-");
    // The desk's own file still names every bidder and its notices.
    const deskFile = await saleFile(listing.id, desk);
    assert.ok(deskFile?.rows.some((row) => row.section === "Decline sent"));
    assert.equal(deskFile?.copy, "desk");
  } finally {
    await clean(made);
  }
});

// The board pack's two figures on real rows, in March 1993, a month nothing else writes to.
test("the board pack counts pool attrition and the cover bid, with a one-bid award on its own line", async () => {
  const made: Made = { users: [], listings: [] };
  try {
    const seller = await person(made, "board-seller", "INDIVIDUAL_SELLER");
    const first = await person(made, "board-first", "BUYER");
    const second = await person(made, "board-second", "BUYER");
    const create = async (title: string, data: Record<string, unknown>, loans: ReturnType<typeof loanData>[]) => {
      const row = await prisma.listing.create({ data: { title: `${title} ${tag}`, sellerId: seller.id, ...data, notes: { create: loans as never } } as never, include: { notes: { orderBy: { createdAt: "asc" } } } });
      made.listings.push(row.id);
      return row;
    };
    // A pool of three bid whole at 120k against a rival's 108k. The desk kicked one loan out and two closed.
    const pool3 = await create("Board pool", { kind: "POOL", status: "SOLD", submittedAt: day("1993-01-10"), approvedAt: day("1993-01-12"), soldAt: day("1993-03-20") }, [
      loanData("1 Attrition Ave", 100000, 60000), loanData("2 Attrition Ave", 80000, 50000), loanData("3 Attrition Ave", 50000, 30000),
    ]);
    const [one, two, three] = ["1 Attrition Ave", "2 Attrition Ave", "3 Attrition Ave"].map((address) => street(pool3, address));
    const won = await prisma.inquiry.create({ data: { listingId: pool3.id, buyerId: first.id, type: "OFFER", amount: 120000, status: "ACCEPTED", createdAt: day("1993-02-01") } });
    await prisma.inquiry.create({ data: { listingId: pool3.id, buyerId: second.id, type: "OFFER", amount: 108000, status: "DECLINED", createdAt: day("1993-02-02") } });
    await prisma.inquiry.create({ data: { listingId: pool3.id, buyerId: second.id, type: "OFFER", noteId: one.id, amount: 70000, status: "DECLINED", createdAt: day("1993-02-03") } });
    const sold = await prisma.closing.create({
      data: {
        listingId: pool3.id, inquiryId: won.id, noteIds: [one.id, two.id], salePrice: 105000, buyerPremiumCents: 0, sellerCommissionCents: 0,
        buyerTotalCents: 10_500_000, netToSellerCents: 10_500_000, status: "COMPLETE", openedAt: day("1993-03-01"), closedAt: day("1993-03-15"),
      },
    });
    await prisma.closingKickout.create({ data: { closingId: sold.id, noteId: three.id, priceCents: 1_500_000, reason: "Paid off", actorId: seller.id, createdAt: day("1993-03-08") } });
    // A single loan with one bid, walked away from in diligence.
    const single = await create("Board single", { kind: "SINGLE", status: "WITHDRAWN", submittedAt: day("1993-01-15"), approvedAt: day("1993-01-16"), withdrawnAt: day("1993-03-28") }, [loanData("4 Attrition Ave", 40000, 30000)]);
    const walked = await prisma.inquiry.create({ data: { listingId: single.id, buyerId: first.id, type: "OFFER", amount: 30000, status: "WITHDRAWN", createdAt: day("1993-02-10"), withdrawnAt: day("1993-03-10") } });
    await prisma.closing.create({
      data: {
        listingId: single.id, inquiryId: walked.id, noteId: single.notes[0].id, salePrice: 30000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 3_000_000,
        netToSellerCents: 3_000_000, status: "CANCELED", openedAt: day("1993-03-02"), canceledAt: day("1993-03-10"), cancelFault: "NEITHER", walkAwayReason: "TITLE",
        cancelReason: "The buyer walked away in diligence: Title.",
      },
    });

    const pack = await boardPack("1993-03", { now: day("1993-04-15") });
    assert.deepEqual(pack.current.speed.attrition, {
      offered: { loans: 4, upbCents: 27_000_000 },
      awarded: { loans: 4, upbCents: 27_000_000 },
      closed: { loans: 2, upbCents: 18_000_000 },
      kickedOut: { loans: 1, upbCents: 5_000_000 },
      lostShare: 9_000_000 / 27_000_000,
    });
    assert.deepEqual(pack.current.liquidity.cover, { median: 0.9, contested: 1, oneBid: 1 });
    // The prior month had no awards.
    assert.deepEqual(pack.prior.liquidity.cover, { median: null, contested: 0, oneBid: 0 });
  } finally {
    await clean(made);
  }
});
