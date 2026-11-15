import assert from "node:assert/strict";
import test from "node:test";
import { demandBoard, HIDDEN_LINE, loadDemandBoxes, MIN_FIRMS, type DemandBox } from "../lib/demand-board";
import { DESK_DENIED } from "../lib/desk-roles";
import { literal } from "../lib/db-filters";
import { prisma } from "../lib/prisma";
import { decideReview, publicTestimonials, readReviewToken, requestReviews, reviewForm, reviewStates, reviewToken, submitReview, testimonialByline } from "../lib/reviews";
import { applyMailings, mailingsFor, preferenceAddress, preferenceToken, readPreferenceToken, readUnsubscribeToken, stopAllMailings, unsubscribeToken } from "../lib/unsubscribe";
import {
  askDeskToFile,
  funnelOf,
  linkValuationAtSignup,
  linkValuationListings,
  listingFromValuation,
  readValuationCookie,
  requestValuation,
  sameEmail,
  sellerValuations,
  signupPrefill,
  stageValuationIntake,
  valuationCookieValue,
} from "../lib/valuations";

// Tokens and the valuation cookie are signed with the auth secret. Mail stays in the log and files on local disk,
// whatever the local .env carries.
process.env.AUTH_SECRET = "supply-funnel-test-secret-not-for-production-01";
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) process.env[key] = "";
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`A test tried to reach the network: ${String(input)}`);
}) as typeof fetch;

test.after(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;

function tagOf() {
  return `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
}

const user = (tag: string, who: string, data: Record<string, unknown>) =>
  prisma.user.create({ data: { email: `supply-${tag}-${who}@example.org`, name: `${who} ${tag}`, accountStatus: "APPROVED", passwordHash: "x", ...data } as never });

const loan = (street: string, extra: Record<string, unknown> = {}) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 150000, interestRate: 7, monthlyPi: 1100, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 120000, estimatedValue: 240000, ...extra,
});

const TYPED = [
  { state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: "150000", interestRate: "7", monthlyPi: "1100", estimatedValue: "240000" },
  { state: "GA", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: "90000", interestRate: "8", monthlyPi: "760", estimatedValue: "160000" },
];

async function valuation(tag: string, email: string, screens: Promise<unknown>[]) {
  const made = await requestValuation({
    name: `Valuer ${tag}`,
    email,
    company: `Holdings ${tag}`,
    terms: "yes",
    typed: TYPED,
    ipAddress: `ip-${tag}`,
    screen: (work) => void screens.push(work()),
    store: async () => undefined,
  });
  if (made.error !== null) throw new Error(made.error);
  return made.id;
}

async function cleanUp(tag: string, userIds: string[], emails: string[], since: Date) {
  const listings = await prisma.listing.findMany({ where: { sellerId: { in: userIds } }, select: { id: true } });
  const listingIds = listings.map((row) => row.id);
  const closings = await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
  const closingIds = closings.map((row) => row.id);
  const requests = await prisma.valuationRequest.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const testimonials = await prisma.testimonial.findMany({ where: { OR: [{ closingId: { in: closingIds } }, { authorId: { in: userIds } }] }, select: { id: true } });
  const subscribers = await prisma.subscriber.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const entityIds = [...userIds, ...listingIds, ...closingIds, ...requests.map((row) => row.id), ...testimonials.map((row) => row.id), ...subscribers.map((row) => row.id)];
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: entityIds } }, { actorId: { in: userIds } }] } });
  await prisma.testimonial.deleteMany({ where: { id: { in: testimonials.map((row) => row.id) } } });
  await prisma.closing.deleteMany({ where: { id: { in: closingIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.valuationRequest.deleteMany({ where: { id: { in: requests.map((row) => row.id) } } });
  await prisma.subscriber.deleteMany({ where: { id: { in: subscribers.map((row) => row.id) } } });
  await prisma.savedSearch.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyBox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({
    where: { OR: [{ toEmail: { in: emails } }, { subject: { contains: literal(tag) } }, { subject: { in: ["Review received"] }, createdAt: { gte: since } }] },
  });
  await prisma.ofacCheck.deleteMany({ where: { name: { contains: literal(tag) } } });
  await prisma.rateWindow.deleteMany({ where: { key: { contains: literal(tag) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// ---------------------------------------------------------------------------------------------------------------
// Part 1: the valuation carries through signup.

test("a valuation joins a new seller account only on the request's own email, and the id alone fills in nothing", async () => {
  const tag = tagOf();
  const since = new Date();
  const email = `supply-${tag}-valuer@example.org`;
  const screens: Promise<unknown>[] = [];
  const users: string[] = [];
  try {
    const id = await valuation(tag, email, screens);
    // Case and spaces don't count; anything else does.
    assert.equal(sameEmail(` ${email.toUpperCase()} `, email), true);
    assert.equal(sameEmail(`x${email}`, email), false);

    // The form starts with the seller role from the id; the name, email and company only with the browser's cookie.
    const bare = await signupPrefill(id, null);
    assert.deepEqual(bare && { role: bare.role, name: bare.name, email: bare.email, company: bare.company }, { role: "INSTITUTIONAL_SELLER", name: "", email: "", company: "" });
    const other = await signupPrefill(id, valuationCookieValue("someotherrequest"));
    assert.equal(other?.email, "");
    const forged = await signupPrefill(id, `${id}.not-a-signature`);
    assert.equal(forged?.email, "");
    const own = await signupPrefill(id, valuationCookieValue(id));
    assert.deepEqual(own && [own.name, own.email, own.company], [`Valuer ${tag}`, email, `Holdings ${tag}`]);
    assert.equal(readValuationCookie(valuationCookieValue(id)), id);

    // Someone else's account, or a buyer's with the same address, never takes it.
    const stranger = await user(tag, "stranger", { role: "INSTITUTIONAL_SELLER" });
    users.push(stranger.id);
    assert.equal(await linkValuationAtSignup({ valuationId: id, userId: stranger.id, email: stranger.email, role: stranger.role }), false);
    assert.equal(await linkValuationAtSignup({ valuationId: id, userId: stranger.id, email, role: "BUYER" }), false);
    assert.equal((await prisma.valuationRequest.findUniqueOrThrow({ where: { id } })).userId, null);

    // The seller who signs up with the request's email gets it, typed however.
    const seller = await prisma.user.create({ data: { email, name: `Valuer ${tag}`, role: "INSTITUTIONAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
    users.push(seller.id);
    assert.equal(await linkValuationAtSignup({ valuationId: id, userId: seller.id, email: ` ${email.toUpperCase()}`, role: seller.role }), true);
    assert.equal((await prisma.valuationRequest.findUniqueOrThrow({ where: { id } })).userId, seller.id);
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: id, action: "VALUATION_SIGNUP" } }));
    // Once it is on an account, nobody else can take it, and the form fills in nothing more.
    assert.equal(await linkValuationAtSignup({ valuationId: id, userId: stranger.id, email, role: stranger.role }), false);
    assert.equal(await signupPrefill(id, valuationCookieValue(id)), null);

    // The seller's desk shows it, and a typed request can't go to intake.
    const cards = await sellerValuations(seller.id);
    assert.deepEqual(cards.map((card) => [card.id, card.loans, card.upb, card.tape]), [[id, 2, 240000, false]]);
    assert.ok(cards[0].lowPrice != null && cards[0].highPrice != null);
    assert.match((await askDeskToFile(seller, id)).error ?? "", /files from a tape/);
    assert.match((await askDeskToFile(stranger, id)).error ?? "", /isn't on your account/);
  } finally {
    await Promise.allSettled(screens);
    await cleanUp(tag, users, [email, `supply-${tag}-stranger@example.org`], since);
  }
});

test("a listing filed from the valuation's loans marks it listed, and no other listing does", async () => {
  const tag = tagOf();
  const since = new Date();
  const email = `supply-${tag}-lister@example.org`;
  const screens: Promise<unknown>[] = [];
  const users: string[] = [];
  try {
    // The rule alone: at least half the listing's loans are loans the request priced, by state and balance.
    const priced = [{ state: "FL", upb: 150000 }, { state: "GA", upb: 90000 }];
    assert.equal(listingFromValuation(priced, [{ state: "FL", upb: 150000.2 }]), true);
    assert.equal(listingFromValuation(priced, [{ state: "GA", upb: 150000 }]), false);
    assert.equal(listingFromValuation(priced, [{ state: "FL", upb: 150000 }, { state: "TX", upb: 1 }, { state: "TX", upb: 2 }]), false);
    assert.equal(listingFromValuation(priced, [{ state: "FL", upb: 150000 }, { state: "FL", upb: 150000 }]), true);
    assert.equal(listingFromValuation([], [{ state: "FL", upb: 150000 }]), false);

    const seller = await prisma.user.create({ data: { email, name: `Lister ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
    const other = await user(tag, "other", { role: "INDIVIDUAL_SELLER" });
    users.push(seller.id, other.id);
    // A listing from before the request doesn't count.
    await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SUBMITTED", title: `Before ${tag}`, notes: { create: [loan("1 Early Row")] as never } } });
    const id = await valuation(tag, email, screens);
    assert.equal(await linkValuationAtSignup({ valuationId: id, userId: seller.id, email, role: seller.role }), true);
    // Another seller's listing of the same loans, and this seller's listing of other loans, leave it open.
    await prisma.listing.create({ data: { kind: "SINGLE", sellerId: other.id, status: "SUBMITTED", title: `Other ${tag}`, notes: { create: [loan("2 Copy Row")] as never } } });
    await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SUBMITTED", title: `Unrelated ${tag}`, notes: { create: [loan("3 Other Row", { state: "TX", upb: 55000 })] as never } } });
    assert.equal(await linkValuationListings({ userId: seller.id }), 0);
    assert.equal((await prisma.valuationRequest.findUniqueOrThrow({ where: { id } })).status, "NEW");

    // The seller lists the Georgia loan: the request is listed, tied to it, and leaves the seller's desk.
    const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SUBMITTED", title: `From valuation ${tag}`, notes: { create: [loan("4 Peach Row", { state: "GA", upb: 90000 })] as never } } });
    assert.equal((await sellerValuations(seller.id)).length, 0);
    const listed = await prisma.valuationRequest.findUniqueOrThrow({ where: { id } });
    assert.equal(listed.status, "LISTED");
    assert.equal(listed.listingId, listing.id);
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: id, action: "VALUATION_LISTED" } }));
    assert.equal(await linkValuationListings({ userId: seller.id }), 0);

    // The conversion line counts it as signed up and listed, not closed until a sale from the listing completes.
    assert.deepEqual(
      funnelOf([
        { createdAt: new Date(), userId: seller.id, listingId: listing.id, sold: false },
        { createdAt: new Date(), userId: null, listingId: null, sold: false },
        { createdAt: new Date(), userId: other.id, listingId: "x", sold: true },
      ]),
      { requests: 3, signedUp: 2, listed: 2, closed: 1 },
    );
    // A request with no tape never reaches desk intake.
    const desk = await user(tag, "desk", { role: "ADMIN", deskRole: "SALES" });
    users.push(desk.id);
    assert.match((await stageValuationIntake(desk, { id, priceMode: "COLUMN", percent: null, rules: [], bands: [] })).error ?? "", /already listed/);
    const analyst = await user(tag, "analyst", { role: "ADMIN", deskRole: "ANALYST" });
    users.push(analyst.id);
    assert.equal((await stageValuationIntake(analyst, { id, priceMode: "COLUMN", percent: null, rules: [], bands: [] })).error, DESK_DENIED);
  } finally {
    await Promise.allSettled(screens);
    await cleanUp(tag, users, [email, ...["other", "desk", "analyst"].map((who) => `supply-${tag}-${who}@example.org`)], since);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Part 2: notice preferences without an account.

test("a preference link opens one address, and its toggles change that address's mailings only", async () => {
  const tag = tagOf();
  const since = new Date();
  const users: string[] = [];
  const listEmail = `supply-${tag}-list@example.org`;
  try {
    const mine = await user(tag, "mine", { role: "BUYER", announcements: true, marketDispatch: true });
    const theirs = await user(tag, "theirs", { role: "BUYER", announcements: true, marketDispatch: true });
    const seller = await user(tag, "seller", { role: "INDIVIDUAL_SELLER" });
    users.push(mine.id, theirs.id, seller.id);
    await prisma.savedSearch.createMany({ data: [mine, theirs].map((row) => ({ userId: row.id, name: `Search ${tag}`, filters: {} })) });

    const token = preferenceToken({ source: "account", id: mine.id, email: mine.email });
    assert.ok(token);
    assert.equal(await preferenceAddress(token), mine.email);
    assert.ok(!token!.includes(mine.email) && !token!.includes(encodeURIComponent(mine.email)));
    // Pointed at another account, or made for another address, it opens nothing.
    assert.equal(await preferenceAddress(token!.replace(mine.id, theirs.id)), null);
    assert.equal(await preferenceAddress(preferenceToken({ source: "account", id: mine.id, email: theirs.email })), null);
    assert.equal(await preferenceAddress(`${token}x`), null);
    // An unsubscribe link and a preference link never read as each other.
    const unsubscribe = unsubscribeToken({ category: "dispatch", userId: mine.id });
    assert.equal(readPreferenceToken(unsubscribe), null);
    assert.equal(readUnsubscribeToken(token), null);

    // A buyer's mailings, and a seller's, by name and state only.
    assert.deepEqual((await mailingsFor(mine.email)).map((row) => [row.key, row.on]), [["announcements", true], ["dispatch", true], ["deals", true], ["watch", true], ["search", true], ["digest", true]]);
    assert.deepEqual((await mailingsFor(seller.email)).map((row) => row.key), ["announcements", "dispatch", "report"]);
    assert.ok((await mailingsFor(mine.email)).every((row) => Object.keys(row).join() === "key,label,on"));

    // Toggles change this address alone. A key it can't receive is ignored.
    const changed = await applyMailings(mine.email, { dispatch: false, deals: false, report: false, announcements: true });
    assert.deepEqual(changed, ["dispatch", "deals"]);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: mine.id } });
    assert.deepEqual([after.marketDispatch, after.dealAlerts, after.announcements], [false, false, true]);
    // Stop everything turns off each list for this address, saved searches included, and mail about deals stays on.
    await stopAllMailings(mine.email);
    const stopped = await prisma.user.findUniqueOrThrow({ where: { id: mine.id } });
    assert.deepEqual([stopped.announcements, stopped.marketDispatch, stopped.dealAlerts, stopped.watchAlerts, stopped.digest, stopped.notifyEmail], [false, false, false, false, "OFF", true]);
    assert.equal(await prisma.savedSearch.count({ where: { userId: mine.id, alertEnabled: true } }), 0);
    assert.ok((await mailingsFor(mine.email)).every((row) => !row.on));
    // The other buyer is untouched.
    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: theirs.id } });
    assert.deepEqual([untouched.announcements, untouched.marketDispatch, untouched.digest], [true, true, "WEEKLY"]);
    assert.equal(await prisma.savedSearch.count({ where: { userId: theirs.id, alertEnabled: true } }), 1);
    // Turned back on, the searches wake together and the digest comes weekly.
    await applyMailings(mine.email, { search: true, digest: true });
    assert.equal(await prisma.savedSearch.count({ where: { userId: mine.id, alertEnabled: true } }), 1);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: mine.id } })).digest, "WEEKLY");

    // A deal-list subscriber without an account has one list, and leaves it from the same page.
    const subscriber = await prisma.subscriber.create({ data: { email: listEmail, token: `supply-list-token-${tag}`, confirmedAt: new Date() } });
    const listToken = preferenceToken({ source: "list", id: subscriber.id, email: listEmail });
    assert.equal(await preferenceAddress(listToken), listEmail);
    assert.deepEqual((await mailingsFor(listEmail)).map((row) => [row.key, row.on]), [["announcements", true]]);
    await stopAllMailings(listEmail);
    assert.ok((await prisma.subscriber.findUniqueOrThrow({ where: { id: subscriber.id } })).unsubscribedAt);
    assert.deepEqual(await mailingsFor(`supply-${tag}-nobody@example.org`), []);
  } finally {
    await cleanUp(tag, users, [listEmail, ...["mine", "theirs", "seller"].map((who) => `supply-${tag}-${who}@example.org`)], since);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Part 3: the public demand board.

test("the demand board counts firms, hides any cell under three, and carries no price or name", async () => {
  const box = (firm: string, extra: Partial<DemandBox> = {}): DemandBox => ({ firm, states: [], liens: ["FIRST"], statuses: ["PERFORMING"], standing: false, ...extra });
  const board = demandBoard(
    [
      box("a", { standing: true }),
      // Two boxes and a seat's box from one firm count once.
      box("b"),
      box("b", { states: ["TX"] }),
      box("c", { states: ["NY"], standing: true }),
      box("d", { liens: ["SECOND"], statuses: [] }),
      box("e", { liens: ["SECOND"], statuses: [] }),
    ],
    new Date("2026-11-15T12:00:00Z"),
  );
  const cell = (lien: string, status: string) => board.liens.find((row) => row.value === lien)!.cells.find((item) => item.value === status)!.cell;
  assert.equal(MIN_FIRMS, 3);
  assert.deepEqual(cell("FIRST", "PERFORMING"), { buyers: 3, standing: null });
  assert.deepEqual(cell("SECOND", "PERFORMING"), { buyers: null, standing: null });
  assert.deepEqual(cell("FIRST", "NON_PERFORMING"), { buyers: null, standing: null });
  assert.deepEqual(board.total, { buyers: 5, standing: null });
  // A box with no states counts in every region; one in New York only in the Northeast.
  assert.deepEqual(board.regions.map((row) => [row.region, row.cell.buyers]), [["Northeast", 5], ["Midwest", 4], ["South", 4], ["West", 4]]);
  assert.equal(HIDDEN_LINE, "Fewer than 3 buyers: not shown");
  assert.doesNotMatch(JSON.stringify(board), /price|yield|spread|cap|percent|name|email|"a"|"b"/i);

  // From the database: approved buyers' active boxes only, and only the fields the board counts.
  const tag = tagOf();
  const users: string[] = [];
  try {
    const firm = await user(tag, "firm", { role: "BUYER" });
    const seat = await user(tag, "seat", { role: "BUYER", principalId: firm.id });
    const pending = await user(tag, "pending", { role: "BUYER", accountStatus: "PENDING" });
    users.push(firm.id, seat.id, pending.id);
    const rule = { liens: "FIRST", statuses: "PERFORMING", priceMax: 90000, targetYield: 11, standingBids: true, bidBasis: "UPB", bidPercent: 82, bidCap: 100000 };
    await prisma.buyBox.createMany({
      data: [
        { userId: firm.id, name: `Firm ${tag}`, ...rule },
        { userId: seat.id, name: `Seat ${tag}`, ...rule },
        { userId: pending.id, name: `Pending ${tag}`, ...rule },
        { userId: firm.id, name: `Paused ${tag}`, ...rule, active: false },
      ],
    });
    const mine = (await loadDemandBoxes()).filter((row) => row.firm === firm.id || row.firm === pending.id);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((row) => row.firm === firm.id && row.standing));
    assert.ok(mine.every((row) => Object.keys(row).sort().join() === "firm,liens,standing,states,statuses"));
  } finally {
    await cleanUp(tag, users, ["firm", "seat", "pending"].map((who) => `supply-${tag}-${who}@example.org`), new Date());
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Part 4: reviews only after a confirmed close.

test("each side is asked once, only after the closing and its file are complete, and a review waits for the desk as written", async () => {
  const tag = tagOf();
  const since = new Date();
  const users: string[] = [];
  const now = new Date("2026-11-15T12:00:00Z");
  try {
    const seller = await user(tag, "seller", { role: "INDIVIDUAL_SELLER" });
    const buyer = await user(tag, "buyer", { role: "BUYER" });
    const stranger = await user(tag, "stranger", { role: "BUYER" });
    const editor = await user(tag, "editor", { role: "ADMIN", deskRole: "SALES" });
    const closer = await user(tag, "closer", { role: "ADMIN", deskRole: "CLOSINGS" });
    users.push(seller.id, buyer.id, stranger.id, editor.id, closer.id);
    const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SOLD", title: `Review ${tag}`, notes: { create: [loan("9 Review Row")] as never } } });
    const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 120000 } });
    const closing = (data: Record<string, unknown>) =>
      prisma.closing.create({ data: { listingId: listing.id, salePrice: 120000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 12000000, netToSellerCents: 12000000, ...data } as never });
    const open = await closing({ status: "OPEN", postCloseCompleteAt: new Date(now.getTime() - DAY) });
    const unfiled = await closing({ status: "COMPLETE", closedAt: new Date("2026-11-02T12:00:00Z") });
    const done = await closing({ status: "COMPLETE", inquiryId: inquiry.id, closedAt: new Date("2026-11-02T12:00:00Z"), postCloseCompleteAt: new Date(now.getTime() - DAY) });
    const old = await closing({ status: "COMPLETE", closedAt: new Date("2026-06-02T12:00:00Z"), postCloseCompleteAt: new Date(now.getTime() - 120 * DAY) });
    const ids = [open.id, unfiled.id, done.id, old.id];

    const first = await requestReviews(now, { closingIds: ids });
    assert.deepEqual(first, { sent: 1, failed: 0, error: "" });
    const asked = await prisma.closing.findMany({ where: { id: { in: ids } }, select: { id: true, reviewRequestedAt: true } });
    assert.deepEqual(asked.filter((row) => row.reviewRequestedAt).map((row) => row.id), [done.id]);
    // A second run asks nobody again.
    assert.deepEqual(await requestReviews(new Date(now.getTime() + DAY), { closingIds: ids }), { sent: 0, failed: 0, error: "" });
    const mail = (email: string) => prisma.notification.findMany({ where: { toEmail: email, subject: { contains: "How did the trade go?" } }, select: { body: true } });
    const [toBuyer, toSeller] = await Promise.all([mail(buyer.email), mail(seller.email)]);
    assert.equal(toBuyer.length, 1);
    assert.equal(toSeller.length, 1);
    assert.match(toBuyer[0].body, /never your name\. Nothing is offered for a review/);
    assert.match(toBuyer[0].body, /no stars and no ratings/);

    // The link in the email is the buyer's own, for this closing.
    const token = decodeURIComponent(/\/review\?token=([^\s]+)/.exec(toBuyer[0].body)![1]);
    assert.deepEqual(readReviewToken(token, now), { closingId: done.id, side: "BUYER", userId: buyer.id, expired: false });
    assert.equal(readReviewToken(token, new Date(now.getTime() + 90 * DAY))?.expired, true);
    assert.deepEqual(await reviewForm(token, now), { state: "ok", side: "BUYER", closedAt: new Date("2026-11-02T12:00:00Z") });
    // Someone who isn't the closing's buyer can't write one with a link of their own making.
    const forged = reviewToken({ closingId: done.id, side: "BUYER", userId: stranger.id }, now)!;
    assert.match((await submitReview({ token: forged, text: "A trade I was never part of, told at length." }, now)).error ?? "", /doesn't work/);
    assert.match((await submitReview({ token, text: "Short." }, now)).error ?? "", /at least 20/);
    assert.match((await submitReview({ token, text: "x".repeat(601) }, now)).error ?? "", /600 characters/);

    const words = "The file was complete when we opened the room, and the desk kept the closing to its dates.";
    const sent = await submitReview({ token, text: `  ${words}  ` }, now);
    assert.equal(sent.error, null);
    const row = await prisma.testimonial.findUniqueOrThrow({ where: { id: sent.id! } });
    assert.deepEqual([row.quote, row.published, row.closingId, row.authorId, row.side, row.role], [words, false, done.id, buyer.id, "BUYER", "Buyer"]);
    assert.match((await submitReview({ token, text: words }, now)).error ?? "", /already has your review/);
    assert.equal((await reviewForm(token, now)).state, "done");
    assert.equal((await reviewStates([row.id])).get(row.id)?.state, "WAITING");
    assert.ok(!(await publicTestimonials(50)).some((quote) => quote.id === row.id));

    // Only the content side of the desk decides. Publishing changes the flag, never the words.
    assert.equal((await decideReview(closer, { id: row.id, publish: true })).error, DESK_DENIED);
    assert.equal((await decideReview(editor, { id: row.id, publish: true })).error, null);
    const live = await prisma.testimonial.findUniqueOrThrow({ where: { id: row.id } });
    assert.deepEqual([live.published, live.quote], [true, words]);
    assert.equal((await reviewStates([row.id])).get(row.id)?.state, "PUBLISHED");
    const shown = (await publicTestimonials(50)).find((quote) => quote.id === row.id);
    assert.deepEqual(shown && [shown.byline, shown.review, shown.quote], ["Buyer · closed on UPB, November 2026", true, words]);
    // A typed testimonial keeps its own line.
    assert.equal(testimonialByline({ role: "Fund manager", place: "Austin" }), "Fund manager · Austin");

    // Declined, it leaves the public pages and stays on file as written.
    assert.equal((await decideReview(editor, { id: row.id, publish: false })).error, null);
    const declined = await prisma.testimonial.findUniqueOrThrow({ where: { id: row.id } });
    assert.deepEqual([declined.published, declined.quote], [false, words]);
    assert.equal((await reviewStates([row.id])).get(row.id)?.state, "DECLINED");
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: row.id, action: "REVIEW_DECLINED", actorId: editor.id } }));
  } finally {
    await cleanUp(tag, users, ["seller", "buyer", "stranger", "editor", "closer"].map((who) => `supply-${tag}-${who}@example.org`), since);
  }
});
