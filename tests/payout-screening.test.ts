import assert from "node:assert/strict";
import test from "node:test";
import { awardOffer } from "../lib/awards";
import { DESK_DENIED } from "../lib/desk-roles";
import {
  PAYOUT_HOLD_MESSAGE,
  addPayoutAccount,
  approveBrokerFee,
  decidePayoutAccount,
  logCallback,
  payoutAccountsFor,
  payoutGate,
  proceedsAccount,
  recordBrokerFeePaid,
  sameHolder,
  vettedPayeeNames,
} from "../lib/payout-accounts";
import { prisma } from "../lib/prisma";
import { OFAC_HOLD_MESSAGE } from "../lib/screening";

// Mail goes to the log and screens use the local stand-in list, whatever the shared .env says. Its planted strings
// "blocked test" and "ofac sample" always go to review.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const desk = (name: string, deskRole: string) => ({ id: `e-payscreen-${name}-${tag}`, role: "ADMIN", deskRole, name: `Desk ${name}` });
const caller = desk("caller", "CLOSINGS");
const checker = desk("checker", "COMPLIANCE");
const closer = desk("closer", "CLOSINGS");
const sales = desk("sales", "SALES");
const call = (accountId: string) => ({ accountId, phone: "(212) 555-0199", source: "BANK_PUBLISHED", note: "Spoke to the holder, who read back the routing number and last four.", independent: true });
const entry = (accountName: string, last4 = "4321") => ({ bankName: "First Test Bank", accountName, routingNumber: "021000021", accountLast4: last4 });

function fixture() {
  const userIds: string[] = [];
  const emails: string[] = [];
  const listingIds: string[] = [];
  const person = async (prefix: string, role: "BUYER" | "INDIVIDUAL_SELLER" | "BROKER", extra: Record<string, unknown> = {}) => {
    const email = `payscreen-${prefix}-${tag}@example.test`;
    const user = await prisma.user.create({ data: { email, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra } });
    userIds.push(user.id);
    emails.push(email);
    return user;
  };
  const listing = async (sellerId: string, status: "APPROVED" | "SOLD") => {
    const row = await prisma.listing.create({
      data: {
        kind: "SINGLE", sellerId, status, approvedAt: new Date(), reservePrice: 1000, title: `Payout screening ${tag} ${listingIds.length}`,
        notes: {
          create: [{
            streetAddress: "1 First St", city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", lienPosition: "FIRST",
            upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0, askingPrice: 80000, estimatedValue: 150000,
          }] as never,
        },
      },
    });
    listingIds.push(row.id);
    return row;
  };
  // Waits for a screen run in the background to land on the account.
  const screened = async (accountId: string) => {
    for (let tries = 0; tries < 50; tries += 1) {
      const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: accountId } });
      if (row.screenedAt) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The background screen never landed.");
  };
  const clean = async () => {
    const accounts = (await prisma.payoutAccount.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
    const inquiries = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
    const closings = (await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
    const fees = (await prisma.brokerFee.findMany({ where: { closingId: { in: closings } }, select: { id: true } })).map((row) => row.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...userIds, ...accounts, ...inquiries, ...closings, ...fees, ...listingIds] } }, { actorId: { in: userIds } }] } });
    await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { closingId: { in: closings } }] } });
    await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.invoice.deleteMany({ where: { closingId: { in: closings } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: emails } }, { userId: { in: userIds } }, { subject: { contains: tag } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  };
  return { person, listing, screened, clean };
}

// ---------------------------------------------------------------------------------------------------------------
// Payout accounts.

test("a payout account whose holder screen is under review is refused by the gate and for proceeds", async () => {
  const account = { id: "p1", userId: "seller", status: "VERIFIED", retiredAt: null, bankName: "Bank", accountLast4: "1234" };
  assert.equal(payoutGate({ ...account, screenResult: "CLEAR" }, "seller"), null);
  assert.equal(payoutGate({ ...account, screenResult: "REVIEW" }, "seller"), PAYOUT_HOLD_MESSAGE);
  assert.match(payoutGate(null, "broker", "broker") ?? "", /Choose the broker's payout account/);
  const fx = fixture();
  try {
    const seller = await fx.person("held", "INDIVIDUAL_SELLER", { name: "Blocked Test" });
    // The name is screened when the account is added, in the background.
    const added = await addPayoutAccount(seller, entry("Blocked Test"));
    assert.equal(added.error, null);
    const stored = await fx.screened(added.account!.id);
    assert.equal(stored.screenResult, "REVIEW");
    const review = await prisma.ofacCheck.findFirstOrThrow({ where: { userId: seller.id, name: "Blocked Test", result: "REVIEW" } });
    assert.match(review.context ?? "", /^Payout account holder · First Test Bank, account ending 4321/);
    assert.equal(review.listVersion, "local stand-in");
    // Verifying screens again and refuses while the match is open, call-back or not.
    assert.equal((await logCallback(caller, call(stored.id))).error, null);
    assert.equal((await decidePayoutAccount(checker, { accountId: stored.id, decision: "VERIFIED" })).error, PAYOUT_HOLD_MESSAGE);
    assert.equal((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: stored.id } })).status, "PENDING");
    assert.equal((await payoutAccountsFor(seller.id))[0].held, true);
    // Compliance clears it as a false match, and the next verify carries that decision forward.
    await prisma.ofacCheck.updateMany({ where: { userId: seller.id, result: "REVIEW" }, data: { status: "CLEARED", reviewNote: "Different date of birth." } });
    assert.equal((await decidePayoutAccount(checker, { accountId: stored.id, decision: "VERIFIED" })).error, null);
    const verified = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: stored.id } });
    assert.equal(verified.status, "VERIFIED");
    assert.equal(verified.screenResult, "CLEAR");
    assert.equal((await proceedsAccount(seller.id, stored.id)).error, null);
    // A decision reopened after verification holds the account again, for proceeds too.
    await prisma.ofacCheck.updateMany({ where: { userId: seller.id, result: "REVIEW" }, data: { status: "OPEN" } });
    assert.equal((await proceedsAccount(seller.id, stored.id)).error, PAYOUT_HOLD_MESSAGE);
  } finally {
    await fx.clean();
  }
});

test("a payout account in a name that isn't the vetted seller's needs the verifier's reason, which is audited", async () => {
  assert.equal(sameHolder("Harbor Notes, LLC", ["Harbor Notes LLC"]), true);
  assert.equal(sameHolder("José Núñez", ["Jose Nunez"]), true);
  assert.equal(sameHolder("Harbor Notes Inc", ["Harbor Notes LLC"]), false);
  assert.equal(sameHolder("", [""]), false);
  const fx = fixture();
  try {
    const seller = await fx.person("named", "INDIVIDUAL_SELLER", { companyName: `Harbor ${tag} LLC` });
    // With no approved seller file, the account's company or name passes.
    assert.deepEqual(await vettedPayeeNames(seller.id), [`Harbor ${tag} LLC`, `named ${tag}`]);
    const added = await addPayoutAccount(seller, entry(`Someone Else ${tag}`));
    const account = await fx.screened(added.account!.id);
    assert.equal((await payoutAccountsFor(seller.id))[0].nameMatches, false);
    assert.equal((await logCallback(caller, call(account.id))).error, null);
    const refused = await decidePayoutAccount(checker, { accountId: account.id, decision: "VERIFIED" });
    assert.match(refused.error ?? "", /isn't Harbor .* LLC, the name the desk vetted\. Say why/);
    assert.match((await decidePayoutAccount(checker, { accountId: account.id, decision: "VERIFIED", reason: "Too short" })).error ?? "", /Say why/);
    const reason = "The seller's trustee holds the account; the trust deed is on the seller file.";
    assert.equal((await decidePayoutAccount(checker, { accountId: account.id, decision: "VERIFIED", reason })).error, null);
    const mismatch = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: account.id, action: "PAYOUT_NAME_MISMATCH" } });
    assert.equal(mismatch.actorId, checker.id);
    assert.match(mismatch.detail, new RegExp(`Someone Else ${tag} against Harbor ${tag} LLC or named ${tag} · ${reason}`));
    // An approved seller file's entity is the only name that passes once it exists.
    await prisma.sellerProfile.create({ data: { userId: seller.id, status: "APPROVED", entityType: "LLC", entityName: `Harbor ${tag} Holdings LLC` } });
    assert.deepEqual(await vettedPayeeNames(seller.id), [`Harbor ${tag} Holdings LLC`]);
  } finally {
    await fx.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Broker fees.

test("a broker fee goes only to a verified account, after a fresh screen, and the member who approved it can't record it paid", async () => {
  const fx = fixture();
  try {
    const broker = await fx.person("broker", "BROKER", { brokerProfile: { create: { company: `Brokerage ${tag}`, states: "FL", payoutNote: "ACH to the operating account." } } });
    const seller = await fx.person("seller", "INDIVIDUAL_SELLER");
    const listing = await fx.listing(seller.id, "SOLD");
    const closing = await prisma.closing.create({
      data: { listingId: listing.id, status: "COMPLETE", closedAt: new Date(), salePrice: 90000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 9000000, netToSellerCents: 9000000 },
    });
    const fee = await prisma.brokerFee.create({ data: { closingId: closing.id, brokerId: broker.id, role: "AFFILIATE", amountCents: 50000, basis: "FLAT" } });

    // A broker adds a payout account the way a seller does, and it is called back and verified the same way.
    const added = await addPayoutAccount(broker, entry(broker.name, "7777"));
    assert.equal(added.error, null);
    const account = added.account!;
    assert.match((await approveBrokerFee(closer, { feeId: fee.id, accountId: account.id })).error ?? "", /isn't verified yet/);
    assert.match((await recordBrokerFeePaid(closer, { feeId: fee.id })).error ?? "", /Approve the fee to a verified payout account/);
    assert.equal((await logCallback(caller, call(account.id))).error, null);
    assert.equal((await decidePayoutAccount(checker, { accountId: account.id, decision: "VERIFIED" })).error, null);

    // The sales side can't approve money out, and another party's account is refused.
    assert.equal((await approveBrokerFee(sales, { feeId: fee.id, accountId: account.id })).error, DESK_DENIED);
    const sellers = await prisma.payoutAccount.create({ data: { userId: seller.id, bankName: "Other Bank", accountName: seller.name, routingNumber: "021000021", accountLast4: "9999", status: "VERIFIED" } });
    assert.match((await approveBrokerFee(caller, { feeId: fee.id, accountId: sellers.id })).error ?? "", /isn't the broker's/);

    // The approval screens the broker again: a company name now on the list stops it until compliance decides.
    await prisma.user.update({ where: { id: broker.id }, data: { companyName: "Ofac Sample" } });
    assert.match((await approveBrokerFee(caller, { feeId: fee.id, accountId: account.id })).error ?? "", /OFAC match on this broker/);
    await prisma.ofacCheck.updateMany({ where: { userId: broker.id, result: "REVIEW" }, data: { status: "CLEARED", reviewNote: "A different company." } });
    assert.equal((await approveBrokerFee(caller, { feeId: fee.id, accountId: account.id })).error, null);
    const approved = await prisma.brokerFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(approved.payoutAccountId, account.id);
    assert.equal(approved.approvedById, caller.id);
    assert.ok(approved.approvedAt);
    assert.equal(approved.status, "OWED");
    assert.ok(await prisma.ofacCheck.findFirst({ where: { userId: broker.id, name: broker.name, context: `Broker fee on ${listing.title}` } }), "the broker was screened at approval");

    // Four eyes: the member who approved it can't record it paid, and compliance doesn't record closings work.
    assert.equal((await recordBrokerFeePaid(caller, { feeId: fee.id })).error, "You approved this fee, so another desk member records it paid.");
    assert.equal((await recordBrokerFeePaid(checker, { feeId: fee.id })).error, DESK_DENIED);
    assert.equal((await recordBrokerFeePaid(closer, { feeId: fee.id })).error, null);
    const paid = await prisma.brokerFee.findUniqueOrThrow({ where: { id: fee.id } });
    assert.equal(paid.status, "PAID");
    assert.equal(paid.paidById, closer.id);
    assert.ok(paid.paidAt);
    assert.match((await recordBrokerFeePaid(closer, { feeId: fee.id })).error ?? "", /not waiting/);
    const actions = (await prisma.auditEvent.findMany({ where: { entityId: fee.id }, orderBy: { createdAt: "asc" } })).map((event) => event.action);
    assert.deepEqual(actions, ["BROKER_FEE_APPROVED", "broker.paid"]);
  } finally {
    await fx.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Award.

test("an award screens the winner again and is refused on a new match, until compliance decides it", async () => {
  const fx = fixture();
  try {
    const seller = await fx.person("awardseller", "INDIVIDUAL_SELLER");
    const buyer = await fx.person("winner", "BUYER");
    // The main file's entity is the name the papers give the buyer. It is on the stand-in list.
    await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED", entityType: "LLC", entityName: "Blocked Test LLC" } });
    const listing = await fx.listing(seller.id, "APPROVED");
    const offer = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "OPEN", amount: 90000 } });
    // No earlier screen holds this buyer, so only the fresh screen can stop it.
    assert.equal(await prisma.ofacCheck.count({ where: { userId: buyer.id } }), 0);
    assert.equal((await awardOffer(offer.id, caller.id)).error, OFAC_HOLD_MESSAGE);
    assert.equal(await prisma.closing.count({ where: { listingId: listing.id } }), 0);
    const review = await prisma.ofacCheck.findFirstOrThrow({ where: { userId: buyer.id, name: "Blocked Test LLC", result: "REVIEW" } });
    assert.equal(review.status, "OPEN");
    assert.equal(review.context, `Award on ${listing.title}`);
    assert.equal(review.listVersion, "local stand-in");
    assert.ok(await prisma.ofacCheck.findFirst({ where: { userId: buyer.id, name: buyer.name, result: "CLEAR" } }), "the buyer's own name was screened too");
    // Cleared as a false match, the decision stands at the next try.
    await prisma.ofacCheck.updateMany({ where: { userId: buyer.id, result: "REVIEW" }, data: { status: "CLEARED", reviewNote: "Different formation state." } });
    assert.equal((await awardOffer(offer.id, caller.id)).error, null);
    assert.equal(await prisma.closing.count({ where: { listingId: listing.id } }), 1);
  } finally {
    await fx.clean();
  }
});
