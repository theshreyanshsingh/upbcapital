import assert from "node:assert/strict";
import test from "node:test";
import nextConfig, { securityHeaders } from "../next.config";
import { openClosing } from "../lib/closing-service";
import { literal } from "../lib/db-filters";
import { feesAtApproval, listingFeeBps } from "../lib/desk-fees";
import { fundsExposure } from "../lib/inquiry";
import {
  CONSENT_REQUIRED,
  DEFAULT_LEGAL,
  LEGAL_VERSION,
  acceptTerms,
  currentLegalVersion,
  fillLegal,
  legalBlocks,
  legalDue,
  legalLinkParts,
  nextLegalVersion,
  raiseLegalVersion,
  signupConsent,
} from "../lib/legal";
import { prisma } from "../lib/prisma";
import { INVESTOR_HOLD_MESSAGE, investorAllocationBlock, investorContext, investorHold, screenInvestor } from "../lib/screening";
import { clearSettingsCache, getSettings } from "../lib/settings";
import { isTemplateKey } from "../lib/templates";

const DAY = 24 * 60 * 60 * 1000;
// Desk notices stay in the log, and screening uses the built-in list, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The legal texts, as pure rules.

test("the built-in terms and privacy policy open with the draft note and cover what counsel asked for", () => {
  for (const doc of Object.values(DEFAULT_LEGAL)) {
    const [first] = legalBlocks(doc.body);
    assert.equal(first.kind, "note");
    assert.match(first.kind === "note" ? first.text : "", /^Draft under counsel review\./);
  }
  const terms = DEFAULT_LEGAL.TERMS.body;
  assert.match(terms, /accredited-investor certification/);
  assert.match(terms, /not a lender, a loan servicer, a fund or an investment adviser/);
  assert.match(terms, /within \[12\] months/);
  assert.match(terms, /do not contact the borrower, the occupants or the servicer/);
  assert.match(terms, /anonymised, aggregate market data/);
  assert.match(terms, /laws of \[state\]/);
  const privacy = fillLegal(DEFAULT_LEGAL.PRIVACY.body, { retentionYears: 7, contact: "desk@example.org" });
  assert.match(privacy, /for at least 7 years/);
  assert.match(privacy, /Write to desk@example\.org from the email on your account/);
  assert.doesNotMatch(privacy, /\{\{/);
  // The legal pages are never closing paper.
  assert.equal(isTemplateKey("TERMS"), false);
  assert.equal(isTemplateKey("PRIVACY"), false);
});

test("the desk's plain text becomes headings, callouts, lists and paragraphs, and site paths become links", () => {
  const blocks = legalBlocks("> A note\nover two lines.\r\n\r\n## Fees\n\nSee /fees for the rates.\n\n- one\n- two\n\nA line\nwrapped.");
  assert.deepEqual(blocks, [
    { kind: "note", text: "A note over two lines." },
    { kind: "heading", text: "Fees" },
    { kind: "paragraph", text: "See /fees for the rates." },
    { kind: "list", items: ["one", "two"] },
    { kind: "paragraph", text: "A line wrapped." },
  ]);
  assert.deepEqual(legalLinkParts("See /fees and /privacy."), [
    { text: "See ", href: null },
    { text: "/fees", href: "/fees" },
    { text: " and ", href: null },
    { text: "/privacy", href: "/privacy" },
    { text: ".", href: null },
  ]);
  assert.equal(nextLegalVersion("1"), "2");
  assert.equal(nextLegalVersion("9"), "10");
  assert.equal(nextLegalVersion("draft"), "2");
  assert.equal(legalDue({ termsVersion: null }, "1"), true);
  assert.equal(legalDue({ termsVersion: "1" }, "1"), false);
  assert.equal(legalDue({ termsVersion: "1" }, "2"), true);
});

// ---------------------------------------------------------------------------------------------------------------
// Consent at signup, and asking every account again.

async function makePeople(tag: string) {
  const person = (prefix: string, role: "BUYER" | "ADMIN" | "INDIVIDUAL_SELLER") =>
    prisma.user.create({ data: { email: `legal-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" } });
  return { desk: await person("desk", "ADMIN"), buyer: await person("buyer", "BUYER"), seller: await person("seller", "INDIVIDUAL_SELLER") };
}

async function cleanPeople(ids: string[]) {
  await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test("signup refuses an unticked box and records the version agreed to on the new account", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  assert.deepEqual(await signupConsent(null), { error: CONSENT_REQUIRED });
  assert.deepEqual(await signupConsent(""), { error: CONSENT_REQUIRED });
  assert.deepEqual(await signupConsent("on"), { error: CONSENT_REQUIRED });
  const now = new Date();
  const consent = await signupConsent("yes", now);
  if (consent.error !== null) throw new Error(consent.error);
  const version = await currentLegalVersion();
  assert.deepEqual(consent.data, { termsVersion: version, termsAcceptedAt: now });
  // The signup action spreads it into the account it creates.
  const user = await prisma.user.create({
    data: { email: `legal-signup-${tag}@example.org`, name: `Signup ${tag}`, role: "BUYER", passwordHash: "x", ...consent.data },
  });
  try {
    assert.equal(user.termsVersion, version);
    assert.equal(user.termsAcceptedAt?.getTime(), now.getTime());
    assert.equal(legalDue(user, version), false);
  } finally {
    await cleanPeople([user.id]);
  }
});

test("raising the version asks every account again, and accepting records the new one", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const { desk, buyer, seller } = await makePeople(tag);
  const before = (await prisma.platformSettings.findUnique({ where: { id: "default" } }))?.legalVersion ?? null;
  try {
    clearSettingsCache();
    const current = await currentLegalVersion();
    assert.equal(current, before || LEGAL_VERSION);
    // An account from before the terms existed is asked, and one that accepted is not.
    assert.equal(legalDue(seller, current), true);
    assert.equal(await acceptTerms(buyer.id), current);
    const accepted = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    assert.equal(accepted.termsVersion, current);
    assert.ok(accepted.termsAcceptedAt);
    assert.equal(legalDue(accepted, current), false);

    const raised = await raiseLegalVersion(desk.id);
    assert.equal(raised, nextLegalVersion(current));
    assert.equal(await currentLegalVersion(), raised);
    assert.equal(legalDue(accepted, raised), true);
    assert.ok(await prisma.auditEvent.findFirst({ where: { actorId: desk.id, action: "LEGAL_VERSION" } }));

    assert.equal(await acceptTerms(buyer.id), raised);
    const again = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    assert.equal(again.termsVersion, raised);
    assert.equal(legalDue(again, raised), false);
    assert.ok(await prisma.auditEvent.findFirst({ where: { actorId: buyer.id, action: "TERMS_ACCEPTED", detail: { contains: `version ${raised}` } } }));
  } finally {
    // The shared test database goes back to the version it had.
    await prisma.platformSettings.update({ where: { id: "default" }, data: { legalVersion: before ?? { unset: true } } });
    clearSettingsCache();
    await prisma.auditEvent.deleteMany({ where: { actorId: desk.id, action: "LEGAL_VERSION" } });
    await cleanPeople([desk.id, buyer.id, seller.id]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Fees fixed when a listing goes live.

test("a listing keeps the fees from its approval, and only an older listing falls back to the settings", () => {
  const settings = { buyerPremiumBps: 250, sellerCommissionBps: 300 };
  assert.deepEqual(feesAtApproval(settings), { feeBuyerPremiumBps: 250, feeSellerCommissionBps: 300 });
  assert.deepEqual(listingFeeBps({ feeBuyerPremiumBps: 100, feeSellerCommissionBps: 0 }, settings), { premiumBps: 100, commissionBps: 0 });
  assert.deepEqual(listingFeeBps({ feeBuyerPremiumBps: null }, settings), { premiumBps: 250, commissionBps: 300 });
  assert.deepEqual(listingFeeBps(null, settings), { premiumBps: 250, commissionBps: 300 });
});

async function makeListing(sellerId: string, tag: string, fees: { feeBuyerPremiumBps?: number; feeSellerCommissionBps?: number }) {
  return prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      title: `Fees ${tag}`,
      ...fees,
      notes: {
        create: [{
          streetAddress: "1 First St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000,
        }] as never,
      },
    },
    include: { notes: true },
  });
}

test("an award charges the fees fixed at approval after the settings move, and the bid limit counts the same premium", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const { desk, buyer, seller } = await makePeople(tag);
  const listingIds: string[] = [];
  try {
    clearSettingsCache();
    const live = await getSettings();
    // The settings when this listing was approved, which have since moved to `live`. The test reads the shared
    // settings rather than changing them, since other test files price against them.
    const atApproval = { buyerPremiumBps: live.buyerPremiumBps + 125, sellerCommissionBps: live.sellerCommissionBps + 75 };
    const fixed = await makeListing(seller.id, `fixed ${tag}`, feesAtApproval(atApproval));
    const older = await makeListing(seller.id, `older ${tag}`, {});
    const desked = await makeListing(seller.id, `desk ${tag}`, feesAtApproval(atApproval));
    listingIds.push(fixed.id, older.id, desked.id);

    const price = 100000;
    const bid = await prisma.inquiry.create({ data: { listingId: fixed.id, buyerId: buyer.id, type: "OFFER", noteId: fixed.notes[0].id, amount: price, status: "OPEN" } });
    // Before the award, the buyer's funds are held at the listing's premium, the one the closing will charge.
    const [held] = await fundsExposure(buyer.id, live.buyerPremiumBps);
    assert.ok(Math.abs(held.allIn - price * (1 + atApproval.buyerPremiumBps / 10000)) < 0.01);

    await prisma.inquiry.update({ where: { id: bid.id }, data: { status: "ACCEPTED" } });
    const closing = await openClosing({ listingId: fixed.id, inquiryId: bid.id, noteId: fixed.notes[0].id, salePrice: price, title: fixed.title });
    assert.equal(closing.buyerPremiumCents, Math.round((price * 100 * atApproval.buyerPremiumBps) / 10000));
    assert.equal(closing.sellerCommissionCents, Math.round((price * 100 * atApproval.sellerCommissionBps) / 10000));
    assert.equal(closing.buyerTotalCents, price * 100 + closing.buyerPremiumCents);
    assert.equal(closing.netToSellerCents, price * 100 - closing.sellerCommissionCents);

    // A listing approved before fees were kept trades at the settings of the day.
    const oldBid = await prisma.inquiry.create({ data: { listingId: older.id, buyerId: buyer.id, type: "OFFER", noteId: older.notes[0].id, amount: price, status: "ACCEPTED" } });
    const oldClosing = await openClosing({ listingId: older.id, inquiryId: oldBid.id, noteId: older.notes[0].id, salePrice: price, title: older.title });
    assert.equal(oldClosing.buyerPremiumCents, Math.round((price * 100 * live.buyerPremiumBps) / 10000));
    assert.equal(oldClosing.sellerCommissionCents, Math.round((price * 100 * live.sellerCommissionBps) / 10000));

    // The desk buying for its own book pays no premium, and the seller's commission is the one fixed at approval.
    const deskBid = await prisma.deskBid.create({ data: { listingId: desked.id, noteId: desked.notes[0].id, amount: price, status: "ACCEPTED" } });
    const deskClosing = await openClosing({ listingId: desked.id, deskBidId: deskBid.id, noteId: desked.notes[0].id, salePrice: price, title: desked.title });
    assert.equal(deskClosing.buyerPremiumCents, 0);
    assert.equal(deskClosing.sellerCommissionCents, live.chargeDeskFees ? Math.round((price * 100 * atApproval.sellerCommissionBps) / 10000) : 0);
  } finally {
    const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [...listingIds, ...closingIds] } } });
    await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { closingId: { in: closingIds } }] } });
    await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.notification.deleteMany({ where: { subject: { contains: literal(tag) } } });
    await cleanPeople([desk.id, buyer.id, seller.id]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Sanctions on the desk's own investors.

test("an open or confirmed OFAC match on an investor holds their allocations until the desk clears it", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const blockedName = `Blocked Test ${tag}`;
  const cleanName = `Jane Investor ${tag}`;
  const names = [blockedName, cleanName, `Legacy Test ${tag}`];
  const investors = await Promise.all([
    prisma.investor.create({ data: { name: blockedName, email: `inv-a-${tag}@example.org` } }),
    prisma.investor.create({ data: { name: cleanName, email: `inv-b-${tag}@example.org`, entity: "" } }),
    prisma.investor.create({ data: { name: blockedName, email: `inv-c-${tag}@example.org` } }),
  ]);
  const [flagged, clean, namesake] = investors;
  try {
    // The screen when the investor is added is tied to them, and an open match holds the allocation.
    await screenInvestor(flagged);
    const review = await investorHold(flagged);
    assert.ok(review);
    assert.equal(review.context, investorContext(flagged));
    assert.equal(review.status, "OPEN");
    assert.equal(await investorAllocationBlock(flagged), INVESTOR_HOLD_MESSAGE);

    // A confirmed match holds too.
    await prisma.ofacCheck.update({ where: { id: review.id }, data: { status: "CONFIRMED" } });
    assert.equal(await investorAllocationBlock(flagged), INVESTOR_HOLD_MESSAGE);

    // Cleared, the allocation goes through, and screening again carries the decision instead of reopening it.
    await prisma.ofacCheck.update({ where: { id: review.id }, data: { status: "CLEARED", reviewNote: "Different person" } });
    assert.equal(await investorHold(flagged), null);
    assert.equal(await investorAllocationBlock(flagged), null);
    assert.equal(await prisma.ofacCheck.count({ where: { name: blockedName, result: "REVIEW", status: "OPEN" } }), 0);

    // Someone else with the same name is a different investor, so the allocation screens them and asks the desk.
    assert.equal(await investorAllocationBlock(namesake), INVESTOR_HOLD_MESSAGE);
    const theirs = await investorHold(namesake);
    assert.equal(theirs?.context, investorContext(namesake));
    assert.equal(theirs?.status, "OPEN");

    // A clear investor allocates, with the screen on file.
    assert.equal(await investorAllocationBlock(clean), null);
    assert.ok(await prisma.ofacCheck.findFirst({ where: { name: cleanName, result: "CLEAR", context: investorContext(clean) } }));

    // A match recorded before screens were tied to investors still holds, by name.
    const legacy = await prisma.investor.create({ data: { name: `Legacy Test ${tag}`, email: `inv-d-${tag}@example.org` } });
    investors.push(legacy);
    await prisma.ofacCheck.create({ data: { name: legacy.name, result: "REVIEW", context: "Investor", matched: "BLOCKED TEST", status: "OPEN" } });
    assert.equal(await investorAllocationBlock(legacy), INVESTOR_HOLD_MESSAGE);
  } finally {
    await prisma.ofacCheck.deleteMany({ where: { name: { in: names } } });
    await prisma.notification.deleteMany({ where: { subject: { contains: literal(tag) } } });
    await prisma.investor.deleteMany({ where: { id: { in: investors.map((row) => row.id) } } });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Security headers.

test("every response carries the security headers, and HSTS only on an https app", async () => {
  const keys = (headers: { key: string; value: string }[]) => Object.fromEntries(headers.map((header) => [header.key, header.value]));
  const plain = keys(securityHeaders("http://127.0.0.1:4317"));
  assert.equal(plain["X-Content-Type-Options"], "nosniff");
  assert.equal(plain["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(plain["X-Frame-Options"], "DENY");
  assert.equal(plain["Content-Security-Policy"], "frame-ancestors 'none'");
  assert.equal(plain["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(plain["Strict-Transport-Security"], undefined);
  assert.equal(keys(securityHeaders(""))["Strict-Transport-Security"], undefined);
  assert.equal(keys(securityHeaders("https://upb.example.com"))["Strict-Transport-Security"], "max-age=31536000");
  const rules = (await nextConfig.headers?.()) ?? [];
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, "/:path*");
});
