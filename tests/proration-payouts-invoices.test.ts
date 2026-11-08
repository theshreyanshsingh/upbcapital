import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { DESK_DENIED } from "../lib/desk-roles";
import { finalizeClosing } from "../lib/closing-service";
import { chargeFees, flatTerms } from "../lib/fee-schedule";
import { INVOICE_SERIES, buildInvoicePdf, canReadInvoice, creditInvoice, creditLeft, invoiceDescription, invoiceId, issueClosingInvoices, issueInvoice, nextInvoiceNumber, type InvoiceSeries } from "../lib/invoices";
import { abaValid, addPayoutAccount, decidePayoutAccount, logCallback, payoutGate, proceedsAccount, readPayoutEntry, retirePayoutAccount } from "../lib/payout-accounts";
import { prisma } from "../lib/prisma";
import { daysBetween, loanPriceShares, perDiemCents, prorate, prorateLoan, prorationProblem } from "../lib/proration";
import { clearProration, saveProration } from "../lib/proration-service";
import { balanceDueCents, buildStatementPdf, economicsRows, moneyGate, proceedsGate, statementLines } from "../lib/settlement";

// Fixtures share the test database with other builders, so every row here carries this run's suffix and is removed
// by it. The numbering tests draw from their own counter, never the live invoice series.
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const testSeries = (name: string): InvoiceSeries => ({ counter: `e-finance-${name}-${suffix}`, prefix: `EF${name.toUpperCase()}${suffix}` });
const desk = (name: string, deskRole: string) => ({ id: `e-finance-${name}-${suffix}`, role: "ADMIN", deskRole, name: `Desk ${name}` });

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Proration, without the database.

test("a paid-down performing loan comes off the price at its price-to-UPB ratio and owes the seller interest to closing", () => {
  const loan = prorateLoan(
    { noteId: "n1", label: "1 Main, Miami, FL", priceCents: 9_000_000, tapeUpbCents: 10_000_000, closingUpbCents: 9_980_000, ratePercent: 6, interestPaidTo: day("2026-11-01") },
    day("2026-11-15"),
  );
  // $200 paid down on a loan bought at 90% of UPB takes $180 off the price.
  assert.equal(loan.paidDownCents, 20_000);
  assert.equal(loan.principalCents, -18_000);
  // 6% on $99,800 is $16.4055 a day, actual/365, for the 14 days to closing.
  assert.equal(loan.perDiemCents, 1640.55);
  assert.equal(loan.interestDays, 14);
  assert.equal(loan.interestCents, 22_968);
  assert.equal(loan.totalCents, 4_968);
  assert.equal(loan.interestPaidTo, "2026-11-01");
});

test("interest runs per diem both ways, on calendar days, and a blank paid-to date leaves it out", () => {
  const base = { noteId: "n1", label: "A loan", priceCents: 5_000_000, tapeUpbCents: 5_000_000, closingUpbCents: 5_000_000, ratePercent: 7.3 };
  // 7.3% on $50,000 is exactly $10 a day.
  assert.equal(perDiemCents(5_000_000, 7.3), 1000);
  assert.equal(prorateLoan({ ...base, interestPaidTo: day("2026-11-05") }, day("2026-11-15")).interestCents, 10_000);
  // Interest the seller collected past closing goes back to the buyer.
  const collected = prorateLoan({ ...base, interestPaidTo: day("2026-11-20") }, day("2026-11-15"));
  assert.equal(collected.interestDays, -5);
  assert.equal(collected.interestCents, -5_000);
  assert.equal(prorateLoan({ ...base, interestPaidTo: null }, day("2026-11-15")).interestCents, 0);
  // Actual days: February 2028 has 29, and the rate still divides by 365.
  assert.equal(daysBetween(day("2028-02-01"), day("2028-03-01")), 29);
  assert.equal(prorateLoan({ ...base, interestPaidTo: day("2028-02-01") }, day("2028-03-01")).interestCents, 29_000);
  // A balance that rose moves the price up by the same ratio.
  assert.equal(prorateLoan({ ...base, closingUpbCents: 5_100_000, interestPaidTo: null }, day("2026-11-15")).principalCents, 100_000);
  assert.equal(prorationProblem({ cutoffDate: day("2026-11-15"), closingDate: day("2026-11-01"), loans: [{ label: "A loan", tapeUpbCents: 1, closingUpbCents: 1, interestPaidTo: null }] }), "The closing date can't be before the cut-off date.");
  assert.match(prorationProblem({ cutoffDate: day("2026-11-01"), closingDate: day("2026-11-15"), loans: [{ label: "A loan", tapeUpbCents: 100, closingUpbCents: 300, interestPaidTo: null }] }) ?? "", /more than twice/);
  assert.match(prorationProblem({ cutoffDate: day("2026-11-01"), closingDate: day("2026-11-15"), loans: [{ label: "A loan", tapeUpbCents: 100, closingUpbCents: 100, interestPaidTo: day("2024-01-01") }] }) ?? "", /more than a year/);
});

test("a pool is prorated loan by loan, on the buyer's loan prices when they stand and the UPB share when they don't", () => {
  const loans = [
    { id: "a", upbCents: 10_000_000 },
    { id: "b", upbCents: 5_000_000 },
  ];
  const byUpb = loanPriceShares({ priceCents: 12_000_000, loans });
  assert.equal(byUpb.basis, "upbShare");
  assert.deepEqual(byUpb.shares, { a: 8_000_000, b: 4_000_000 });
  const priced = loanPriceShares({ priceCents: 12_000_000, loans, loanPrices: { a: 90_000, b: 30_000 } });
  assert.equal(priced.basis, "loanPrice");
  assert.deepEqual(priced.shares, { a: 9_000_000, b: 3_000_000 });
  // Prices that no longer add up to the closing's price are set aside.
  assert.equal(loanPriceShares({ priceCents: 12_000_000, loans, loanPrices: { a: 90_000, b: 10_000 } }).basis, "upbShare");
  const pool = prorate({
    cutoffDate: day("2026-10-20"),
    closingDate: day("2026-11-11"),
    basis: byUpb.basis,
    loans: [
      { noteId: "a", label: "A", priceCents: byUpb.shares.a, tapeUpbCents: 10_000_000, closingUpbCents: 9_900_000, ratePercent: 6, interestPaidTo: day("2026-11-01") },
      { noteId: "b", label: "B", priceCents: byUpb.shares.b, tapeUpbCents: 5_000_000, closingUpbCents: 5_000_000, ratePercent: 8, interestPaidTo: day("2026-10-27") },
    ],
  });
  assert.deepEqual(pool.loans.map((loan) => [loan.principalCents, loan.interestCents]), [[-80_000, 16_274], [0, 16_438]]);
  assert.equal(pool.principalCents, -80_000);
  assert.equal(pool.interestCents, 32_712);
  assert.equal(pool.totalCents, -47_288);
  assert.equal(pool.cutoffDate, "2026-10-20");
});

test("the statements show the proration as its own lines, and the money gate and expected totals count it", async () => {
  const proration = prorate({
    cutoffDate: day("2026-11-01"),
    closingDate: day("2026-11-15"),
    basis: "upbShare",
    loans: [{ noteId: "n1", label: "1 Main", priceCents: 9_000_000, tapeUpbCents: 10_000_000, closingUpbCents: 9_980_000, ratePercent: 6, interestPaidTo: day("2026-11-01") }],
  });
  const closing = {
    id: "c1", salePrice: 90_000, buyerPremiumCents: 225_000, sellerCommissionCents: 270_000, buyerTotalCents: 9_225_000, netToSellerCents: 8_730_000,
    openedAt: day("2026-11-01"), closedAt: null, status: "OPEN",
    fundsReceivedCents: 9_225_000 as number | null, fundsReceivedAt: day("2026-11-14"), fundsReference: "FED1", proceedsSentCents: null, proceedsSentAt: null, proceedsReference: null,
    prorationCents: proration.totalCents, prorationDetail: proration,
  };
  const buyer = statementLines(closing, "buyer")[0].lines;
  const seller = statementLines(closing, "seller")[0].lines;
  for (const lines of [buyer, seller]) {
    assert.equal(lines.find((line) => line.label === "Proration, principal since cut-off")?.cents, -18_000);
    assert.equal(lines.find((line) => line.label === "Proration, interest to closing")?.cents, 22_968);
  }
  // The stored price and fees stand; the proration moves what the buyer wires and what the seller nets.
  assert.equal(buyer.find((line) => line.label === "Purchase price")?.cents, 9_000_000);
  assert.equal(buyer.find((line) => line.label === "Buyer premium")?.cents, 225_000);
  assert.equal(buyer.find((line) => line.label === "Due from buyer")?.cents, 9_229_968);
  assert.equal(seller.find((line) => line.label === "Net proceeds to seller")?.cents, 8_734_968);
  assert.match(buyer.find((line) => line.label === "Funds received")?.detail ?? "", /short \$49\.68/);
  assert.equal(balanceDueCents({ ...closing, depositReceivedCents: 900_000 }), 8_329_968);
  // Funds that match the price and premium alone are short by the proration.
  assert.equal(moneyGate("PAYMENT_RECEIVED", closing, []), "Buyer funds are short $49.68, counting the deposit.");
  assert.equal(moneyGate("PAYMENT_RECEIVED", { ...closing, fundsReceivedCents: 9_229_968 }, []), null);
  const delivered = [{ key: "COLLATERAL_TRANSFER", status: "COMPLETE" }, { key: "ASSIGNMENT", status: "COMPLETE" }];
  assert.match(proceedsGate(closing, [], delivered) ?? "", /short \$49\.68/);
  assert.equal(proceedsGate({ ...closing, fundsReceivedCents: 9_229_968 }, [], delivered), null);
  // One owed to the buyer comes off both.
  const down = { ...closing, prorationCents: -50_000, prorationDetail: null, fundsReceivedCents: 9_175_000 };
  assert.equal(moneyGate("PAYMENT_RECEIVED", down, []), null);
  assert.deepEqual(statementLines(down, "seller")[0].lines.find((line) => line.label === "Proration"), { label: "Proration", cents: -50_000, detail: "$500.00 owed to the buyer" });
  assert.deepEqual(economicsRows(closing, "seller").map((row) => [row.label, row.cents]), [["Sale price", 9_000_000], ["Seller commission", 270_000], ["Proration", 4_968], ["Net to seller", 8_734_968]]);
  assert.equal(economicsRows(closing, "buyer").find((row) => row.label === "Buyer all-in")?.cents, 9_229_968);
  // No proration, no lines: the statement reads as it always did.
  assert.ok(!statementLines({ ...closing, prorationCents: null, prorationDetail: null }, "buyer")[0].lines.some((line) => line.label.startsWith("Proration")));
  // The desk's copy with a deposit, the proration and kick-outs runs on to a second page rather than over the footer.
  const kickouts = Array.from({ length: 6 }, (_, index) => ({ loan: `${index} Main, Miami, FL`, priceCents: 100_000, depositCents: 0, reason: "Paid off", at: day("2026-11-10") }));
  const full = { ...closing, depositCents: 900_000, depositReceivedCents: 900_000, depositReceivedAt: day("2026-11-03"), depositReference: "DEP1", depositStatus: "HELD" };
  const pdf = await buildStatementPdf({ title: "Desk copy", parties: "Seller - Buyer", closing: full, sections: statementLines(full, "desk", 10_000, null, kickouts) });
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Payout accounts.

test("a payout account is refused with a bad routing number, and never takes a whole account number", async () => {
  assert.equal(abaValid("021000021"), true);
  assert.equal(abaValid("011000015"), true);
  assert.equal(abaValid("021000022"), false);
  assert.equal(abaValid("123456789"), false);
  assert.equal(abaValid("000000000"), false);
  assert.equal(abaValid("02100002"), false);
  const entry = { bankName: "First Test Bank", accountName: "Seller LLC", routingNumber: "021000021", accountLast4: "4321" };
  assert.equal(readPayoutEntry(entry).error, null);
  assert.match(readPayoutEntry({ ...entry, routingNumber: "021000022" }).error ?? "", /doesn't check out/);
  assert.match(readPayoutEntry({ ...entry, accountLast4: "123456789" }).error ?? "", /never stores the whole number/);
  const seller = await prisma.user.create({ data: { email: `e-finance-aba-${suffix}@example.test`, name: "ABA Seller", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  try {
    const refused = await addPayoutAccount(seller, { ...entry, routingNumber: "021000022" });
    assert.match(refused.error ?? "", /routing number/);
    assert.equal(await prisma.payoutAccount.count({ where: { userId: seller.id } }), 0);
    // A buyer has no proceeds to send anywhere.
    assert.match((await addPayoutAccount({ id: seller.id, role: "BUYER" }, entry)).error ?? "", /Only a seller/);
  } finally {
    await prisma.user.delete({ where: { id: seller.id } });
  }
});

test("a call-back is logged by one desk member who approves wires and verified by another, and a change starts over", async () => {
  const seller = await prisma.user.create({ data: { email: `e-finance-callback-${suffix}@example.test`, name: "Callback Seller", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const caller = desk("caller", "CLOSINGS");
  const checker = desk("checker", "COMPLIANCE");
  const sales = desk("sales", "SALES");
  const ids: string[] = [];
  try {
    const added = await addPayoutAccount(seller, { bankName: "First Test Bank", accountName: "Callback Seller", routingNumber: "021000021", accountLast4: "4321" });
    assert.equal(added.error, null);
    const account = added.account!;
    ids.push(account.id);
    assert.equal(account.status, "PENDING");
    const call = { accountId: account.id, phone: "(212) 555-0199", source: "BANK_PUBLISHED", note: "Spoke to the seller, who read back the routing number and last four.", independent: true };
    // Verifying waits for the call-back, and the sales side can't log one.
    assert.match((await decidePayoutAccount(checker, { accountId: account.id, decision: "VERIFIED" })).error ?? "", /Log the call-back first/);
    assert.equal((await logCallback(sales, call)).error, DESK_DENIED);
    assert.match((await logCallback(caller, { ...call, source: "" })).error ?? "", /where the desk found/);
    assert.match((await logCallback(caller, { ...call, independent: false })).error ?? "", /didn't come from the seller's request/);
    assert.equal((await logCallback(caller, call)).error, null);
    const logged = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert.equal(logged.callbackPhone, "2125550199");
    assert.equal(logged.callbackSource, "BANK_PUBLISHED");
    assert.equal(logged.callbackById, caller.id);
    // The member who called can't also verify.
    assert.match((await decidePayoutAccount(caller, { accountId: account.id, decision: "VERIFIED" })).error ?? "", /another desk member verifies/);
    assert.equal((await decidePayoutAccount(sales, { accountId: account.id, decision: "VERIFIED" })).error, DESK_DENIED);
    assert.equal((await proceedsAccount(seller.id, account.id)).error, "That payout account isn't verified yet. One desk member logs the call-back and another verifies it.");
    const verified = await decidePayoutAccount(checker, { accountId: account.id, decision: "VERIFIED" });
    assert.equal(verified.error, null);
    const after = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert.equal(after.status, "VERIFIED");
    assert.equal(after.verifiedById, checker.id);
    assert.equal((await proceedsAccount(seller.id, account.id)).error, null);
    // A change retires the old account at once; the new one needs its own call-back.
    const changed = await addPayoutAccount(seller, { bankName: "Second Test Bank", accountName: "Callback Seller", routingNumber: "011000015", accountLast4: "8765", replaces: account.id });
    assert.equal(changed.error, null);
    ids.push(changed.account!.id);
    assert.ok((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: account.id } })).retiredAt);
    assert.match((await proceedsAccount(seller.id, account.id)).error ?? "", /changed that payout account/);
    assert.match((await proceedsAccount(seller.id, changed.account!.id)).error ?? "", /isn't verified yet/);
    // Anyone who approves wires can reject, the caller included.
    assert.match((await decidePayoutAccount(caller, { accountId: changed.account!.id, decision: "REJECTED" })).error ?? "", /Say why/);
    assert.equal((await decidePayoutAccount(caller, { accountId: changed.account!.id, decision: "REJECTED", note: "Bank has no record" })).error, null);
    assert.equal((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: changed.account!.id } })).status, "REJECTED");
    assert.equal((await retirePayoutAccount(seller, changed.account!.id)).error, null);
    // Every change reached the seller as a security alert.
    const alerts = await prisma.notification.count({ where: { toEmail: seller.email } });
    assert.ok(alerts >= 4, `expected an alert per change, got ${alerts}`);
    const actions = (await prisma.auditEvent.findMany({ where: { entityId: { in: ids } }, orderBy: { createdAt: "asc" } })).map((event) => event.action);
    assert.deepEqual(actions, ["PAYOUT_ADDED", "PAYOUT_CALLBACK", "PAYOUT_VERIFIED", "PAYOUT_RETIRED", "PAYOUT_ADDED", "PAYOUT_REJECTED", "PAYOUT_RETIRED"]);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { toEmail: seller.email } });
    await prisma.user.delete({ where: { id: seller.id } });
  }
});

test("seller proceeds are refused without a verified payout account of the seller's", async () => {
  const account = { id: "p1", userId: "seller", status: "VERIFIED", retiredAt: null, bankName: "Bank", accountLast4: "1234" };
  assert.equal(payoutGate(account, "seller"), null);
  assert.match(payoutGate(null, "seller") ?? "", /Choose the seller's payout account/);
  assert.match(payoutGate({ ...account, userId: "someone-else" }, "seller") ?? "", /isn't the seller's/);
  assert.match(payoutGate({ ...account, status: "PENDING" }, "seller") ?? "", /isn't verified yet/);
  assert.match(payoutGate({ ...account, status: "REJECTED" }, "seller") ?? "", /rejected/);
  assert.match(payoutGate({ ...account, retiredAt: new Date() }, "seller") ?? "", /needs its own call-back/);
  const [seller, other] = await Promise.all([
    prisma.user.create({ data: { email: `e-finance-proceeds-${suffix}@example.test`, name: "Proceeds Seller", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } }),
    prisma.user.create({ data: { email: `e-finance-other-${suffix}@example.test`, name: "Other Seller", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } }),
  ]);
  try {
    const theirs = await prisma.payoutAccount.create({ data: { userId: other.id, bankName: "Other Bank", accountName: "Other", routingNumber: "021000021", accountLast4: "9999", status: "VERIFIED", verifiedAt: new Date() } });
    const mine = await prisma.payoutAccount.create({ data: { userId: seller.id, bankName: "Mine Bank", accountName: "Mine", routingNumber: "021000021", accountLast4: "1111" } });
    assert.match((await proceedsAccount(seller.id, "")).error ?? "", /Choose the seller's payout account/);
    assert.match((await proceedsAccount(seller.id, theirs.id)).error ?? "", /isn't the seller's/);
    assert.match((await proceedsAccount(seller.id, mine.id)).error ?? "", /isn't verified yet/);
    await prisma.payoutAccount.update({ where: { id: mine.id }, data: { status: "VERIFIED", verifiedAt: new Date() } });
    const ok = await proceedsAccount(seller.id, mine.id);
    assert.equal(ok.error, null);
    assert.equal(ok.account?.id, mine.id);
  } finally {
    await prisma.user.delete({ where: { id: seller.id } });
    await prisma.user.delete({ where: { id: other.id } });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Invoices.

test("invoice numbers never repeat, even with twenty issued at once", async () => {
  const series = testSeries("num");
  const now = day("2026-11-08");
  const numbers: string[] = [];
  try {
    const drawn = await Promise.all(Array.from({ length: 20 }, () => nextInvoiceNumber(series, now)));
    assert.equal(new Set(drawn).size, 20);
    assert.deepEqual([...drawn].sort(), Array.from({ length: 20 }, (_, index) => `${series.prefix}-2026-${String(index + 1).padStart(6, "0")}`));
    const issued = await Promise.all(
      Array.from({ length: 20 }, (_, index) => issueInvoice({ kind: "PREMIUM", closingId: null, userId: `e-finance-user-${suffix}`, amountCents: 100 + index, description: "Numbering test" }, { series, now })),
    );
    numbers.push(...issued.map((invoice) => invoice.number));
    assert.equal(new Set(numbers).size, 20);
    assert.ok(numbers.every((number) => !drawn.includes(number)));
    assert.equal(INVOICE_SERIES.prefix, "UPB");
  } finally {
    await prisma.invoice.deleteMany({ where: { number: { in: numbers } } });
    await prisma.counter.deleteMany({ where: { id: `${series.counter}:2026` } });
  }
});

test("a completed closing invoices each side once, and canceling a fee issues a credit note against it", async () => {
  const series = testSeries("deal");
  const owner = desk("owner", "OWNER");
  const closer = desk("closer", "CLOSINGS");
  const [seller, buyer] = await Promise.all([
    prisma.user.create({ data: { email: `e-finance-inv-seller-${suffix}@example.test`, name: "Invoice Seller", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } }),
    prisma.user.create({ data: { email: `e-finance-inv-buyer-${suffix}@example.test`, name: "Invoice Buyer", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } }),
  ]);
  const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SOLD", title: `e-finance invoices ${suffix}` } });
  const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 100000, message: "Invoice bid" } });
  const closing = await prisma.closing.create({
    data: { listingId: listing.id, inquiryId: inquiry.id, salePrice: 100000, buyerPremiumCents: 250_000, sellerCommissionCents: 300_000, buyerTotalCents: 10_250_000, netToSellerCents: 9_700_000, status: "OPEN" },
  });
  try {
    // Nothing is invoiced before the closing completes.
    assert.deepEqual(await issueClosingInvoices(closing.id, { series }), []);
    await prisma.closing.update({ where: { id: closing.id }, data: { status: "COMPLETE", closedAt: new Date() } });
    // Five issues at once still leave one invoice per side, for the cents the closing charged.
    await Promise.all(Array.from({ length: 5 }, () => issueClosingInvoices(closing.id, { series })));
    await issueClosingInvoices(closing.id, { series });
    const invoices = await prisma.invoice.findMany({ where: { closingId: closing.id }, orderBy: { kind: "asc" } });
    assert.deepEqual(invoices.map((invoice) => [invoice.kind, invoice.userId, invoice.amountCents]), [["COMMISSION", seller.id, 300_000], ["PREMIUM", buyer.id, 250_000]]);
    assert.equal(new Set(invoices.map((invoice) => invoice.number)).size, 2);
    assert.ok(invoices.every((invoice) => invoice.number.startsWith(`${series.prefix}-`)));
    const premium = invoices.find((invoice) => invoice.kind === "PREMIUM")!;
    const commission = invoices.find((invoice) => invoice.kind === "COMMISSION")!;
    assert.equal(premium.id, invoiceId(closing.id, "PREMIUM", buyer.id));
    // Fees are the admin's.
    assert.equal((await creditInvoice(closer, { invoiceId: premium.id, reason: "Premium waived for a desk error on the papers." }, { series })).error, DESK_DENIED);
    assert.match((await creditInvoice(owner, { invoiceId: premium.id, reason: "short" }, { series })).error ?? "", /Say why/);
    // A cancel credits the whole fee once, voids the invoice and takes the fee back off the ledger.
    const [first, second] = await Promise.all([
      creditInvoice(owner, { invoiceId: premium.id, reason: "Premium waived for a desk error on the papers." }, { series }),
      creditInvoice(owner, { invoiceId: premium.id, reason: "Premium waived for a desk error on the papers." }, { series }),
    ]);
    const credited = [first, second].filter((result) => result.error === null);
    assert.equal(credited.length, 1);
    const notes = await prisma.invoice.findMany({ where: { creditOfId: premium.id } });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, "CREDIT_NOTE");
    assert.equal(notes[0].amountCents, -250_000);
    assert.equal(notes[0].userId, buyer.id);
    assert.ok((await prisma.invoice.findUniqueOrThrow({ where: { id: premium.id } })).voidedAt);
    const reversal = await prisma.revenueEvent.findUnique({ where: { externalId: `credit:${notes[0].id}` } });
    assert.equal(reversal?.amountCents, -250_000);
    assert.equal(reversal?.type, "BUYER_PREMIUM");
    assert.match((await creditInvoice(owner, { invoiceId: premium.id, reason: "Premium waived for a desk error on the papers." }, { series })).error ?? "", /already canceled/);
    // A part refund leaves the rest of the fee standing; more than is left is refused.
    const part = await creditInvoice(owner, { invoiceId: commission.id, amountCents: 100_000, reason: "Commission reduced to match the signed letter." }, { series });
    assert.equal(part.error, null);
    assert.match((await creditInvoice(owner, { invoiceId: commission.id, amountCents: 250_000, reason: "Commission reduced to match the signed letter." }, { series })).error ?? "", /Only \$2,000\.00 is left/);
    const commissionCredits = await prisma.invoice.findMany({ where: { creditOfId: commission.id } });
    assert.equal(creditLeft(commission, commissionCredits), 200_000);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: commission.id } })).voidedAt, null);
    const all = await prisma.invoice.findMany({ where: { closingId: closing.id } });
    assert.equal(new Set(all.map((invoice) => invoice.number)).size, all.length);
    // Each party's PDF is theirs alone; the desk reads any.
    assert.equal(canReadInvoice({ id: buyer.id, role: "BUYER" }, premium), true);
    assert.equal(canReadInvoice({ id: seller.id, role: "INDIVIDUAL_SELLER" }, premium), false);
    assert.equal(canReadInvoice({ id: owner.id, role: "ADMIN" }, premium), true);
    const pdf = await buildInvoicePdf({ invoice: commission, party: seller, listingTitle: listing.title, creditOf: null, credits: commissionCredits });
    assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), "%PDF-");
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: closing.id, action: "CREDIT_NOTE" } }));
  } finally {
    await prisma.revenueEvent.deleteMany({ where: { listingId: listing.id } });
    await prisma.invoice.deleteMany({ where: { closingId: closing.id } });
    await prisma.auditEvent.deleteMany({ where: { entityId: closing.id } });
    await prisma.counter.deleteMany({ where: { id: `${series.counter}:2026` } });
    await prisma.notification.deleteMany({ where: { toEmail: { in: [seller.email, buyer.email] } } });
    await prisma.closing.delete({ where: { id: closing.id } });
    await prisma.user.delete({ where: { id: seller.id } });
    await prisma.user.delete({ where: { id: buyer.id } });
  }
});

test("when one side pays both fees, that side gets one invoice for both, the other none, and no invoice is for zero", async () => {
  assert.equal(invoiceDescription("PREMIUM", null, "Pool 7"), "Buyer premium on Pool 7, paid by the buyer");
  assert.equal(invoiceDescription("COMMISSION", "SPLIT", "Pool 7"), "Seller commission on Pool 7, paid by the seller");
  assert.equal(invoiceDescription("COMMISSION", "SELLER", "Pool 7"), "Buyer premium and seller commission on Pool 7, paid by the seller under this listing's terms");
  assert.equal(invoiceDescription("PREMIUM", "BUYER", "Pool 7"), "Buyer premium and seller commission on Pool 7, paid by the buyer under this listing's terms");
  const series = testSeries("payer");
  const [seller, buyer] = await Promise.all([
    prisma.user.create({ data: { email: `e-finance-payer-seller-${suffix}@example.test`, name: "Payer Seller", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } }),
    prisma.user.create({ data: { email: `e-finance-payer-buyer-${suffix}@example.test`, name: "Payer Buyer", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } }),
  ]);
  const listingIds: string[] = [];
  const closingIds: string[] = [];
  // A completed $100,000 sale at 2.50% and 3.00%, with the listing's payer moving both fees onto one side.
  const closeWith = async (payer: "SELLER" | "BUYER") => {
    const fees = chargeFees({ ...flatTerms(250, 300), payer }, 100000);
    const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "PENDING", feePayer: payer, title: `e-finance payer ${payer} ${suffix}` } });
    listingIds.push(listing.id);
    const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 100000, message: "Payer bid" } });
    const closing = await prisma.closing.create({
      data: { listingId: listing.id, inquiryId: inquiry.id, salePrice: 100000, buyerPremiumCents: fees.premiumCents, sellerCommissionCents: fees.commissionCents, buyerTotalCents: fees.buyerTotalCents, netToSellerCents: fees.netToSellerCents, status: "OPEN" },
    });
    closingIds.push(closing.id);
    return { closing, fees };
  };
  try {
    // SELLER: through finalizeClosing itself, the hook every completed sale runs.
    const bySeller = await closeWith("SELLER");
    assert.equal(bySeller.fees.premiumCents, 0);
    assert.equal(bySeller.fees.commissionCents, 550_000);
    assert.equal((await finalizeClosing(bySeller.closing.id))?.status, "COMPLETE");
    const sellerPays = await prisma.invoice.findMany({ where: { closingId: bySeller.closing.id } });
    assert.deepEqual(sellerPays.map((invoice) => [invoice.kind, invoice.userId, invoice.amountCents]), [["COMMISSION", seller.id, 550_000]]);
    assert.match(sellerPays[0].description, /^Buyer premium and seller commission on .*, paid by the seller under this listing's terms$/);
    // BUYER: the buyer's one invoice carries both fees, and the seller is billed nothing.
    const byBuyer = await closeWith("BUYER");
    assert.equal(byBuyer.fees.commissionCents, 0);
    await prisma.closing.update({ where: { id: byBuyer.closing.id }, data: { status: "COMPLETE", closedAt: new Date() } });
    await issueClosingInvoices(byBuyer.closing.id, { series });
    const buyerPays = await prisma.invoice.findMany({ where: { closingId: byBuyer.closing.id } });
    assert.deepEqual(buyerPays.map((invoice) => [invoice.kind, invoice.userId, invoice.amountCents]), [["PREMIUM", buyer.id, 550_000]]);
    assert.match(buyerPays[0].description, /paid by the buyer under this listing's terms$/);
    assert.ok(![...sellerPays, ...buyerPays].some((invoice) => invoice.amountCents === 0));
  } finally {
    await prisma.invoice.deleteMany({ where: { closingId: { in: closingIds } } });
    await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.buyerHolding.deleteMany({ where: { closingId: { in: closingIds } } });
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [...closingIds, ...listingIds] } } });
    await prisma.counter.deleteMany({ where: { id: `${series.counter}:2026` } });
    await prisma.notification.deleteMany({ where: { toEmail: { in: [seller.email, buyer.email] } } });
    await prisma.closing.deleteMany({ where: { id: { in: closingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.delete({ where: { id: seller.id } });
    await prisma.user.delete({ where: { id: buyer.id } });
  }
});

test("the desk sets the proration on an open closing, both sides hear it, and a group closing is refused", async () => {
  const closer = desk("prorate", "CLOSINGS");
  const sales = desk("prorate-sales", "SALES");
  const [seller, buyer] = await Promise.all([
    prisma.user.create({ data: { email: `e-finance-pro-seller-${suffix}@example.test`, name: "Proration Seller", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } }),
    prisma.user.create({ data: { email: `e-finance-pro-buyer-${suffix}@example.test`, name: "Proration Buyer", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } }),
  ]);
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "PENDING",
      title: `e-finance proration ${suffix}`,
      notes: { create: { streetAddress: "1 Proration", city: "Miami", state: "FL", propertyType: "SFR", estimatedValue: 200000, lienPosition: "FIRST", upb: 100000, interestRate: 6, monthlyPi: 700, paymentStatus: "PERFORMING", askingPrice: 90000 } },
    },
    include: { notes: true },
  });
  const note = listing.notes[0];
  const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 90000, message: "Proration bid" } });
  const closing = await prisma.closing.create({
    data: { listingId: listing.id, inquiryId: inquiry.id, salePrice: 90000, buyerPremiumCents: 225_000, sellerCommissionCents: 270_000, buyerTotalCents: 9_225_000, netToSellerCents: 8_730_000, status: "OPEN", openedAt: day("2026-11-01") },
  });
  const entry = { closingId: closing.id, cutoffDate: "2026-11-01", closingDate: "2026-11-15", loans: { [note.id]: { upb: "99,800", paidTo: "2026-11-01" } } };
  try {
    assert.equal((await saveProration(sales, entry)).error, DESK_DENIED);
    assert.match((await saveProration(closer, { ...entry, closingDate: "2026-10-01" })).error ?? "", /before the cut-off/);
    const saved = await saveProration(closer, entry);
    assert.equal(saved.error, null);
    const stored = await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } });
    assert.equal(stored.prorationCents, 4_968);
    assert.equal(stored.cutoffDate?.toISOString().slice(0, 10), "2026-11-01");
    // The price and fees are untouched.
    assert.equal(Number(stored.salePrice), 90000);
    assert.equal(stored.buyerTotalCents, 9_225_000);
    assert.equal(stored.netToSellerCents, 8_730_000);
    const detail = stored.prorationDetail as { loans: { noteId: string; principalCents: number; interestCents: number }[]; setById: string };
    assert.deepEqual(detail.loans.map((loan) => [loan.noteId, loan.principalCents, loan.interestCents]), [[note.id, -18_000, 22_968]]);
    assert.equal(detail.setById, closer.id);
    const told = await prisma.notification.findMany({ where: { toEmail: { in: [seller.email, buyer.email] } } });
    assert.ok(told.some((row) => row.toEmail === buyer.email && /\$92,299\.68 in all/.test(row.body)), "the buyer hears what they now wire");
    assert.ok(told.some((row) => row.toEmail === seller.email && /\$87,349\.68/.test(row.body)), "the seller hears their new net");
    const audits = (await prisma.auditEvent.findMany({ where: { entityId: closing.id } })).map((event) => event.action).sort();
    assert.deepEqual(audits, ["PRORATION_CUTOFF", "PRORATION_SET"]);
    assert.equal((await clearProration(closer, closing.id)).error, null);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).prorationCents, null);
    // A group's seats each agreed their own share, so the desk can't prorate it here.
    await prisma.closingFunder.create({ data: { closingId: closing.id, userId: buyer.id, percent: 100, amount: 90000, premiumCents: 225_000 } });
    assert.match((await saveProration(closer, entry)).error ?? "", /group closing/);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: closing.id } });
    await prisma.notification.deleteMany({ where: { toEmail: { in: [seller.email, buyer.email] } } });
    await prisma.closingFunder.deleteMany({ where: { closingId: closing.id } });
    await prisma.closing.delete({ where: { id: closing.id } });
    await prisma.user.delete({ where: { id: seller.id } });
    await prisma.user.delete({ where: { id: buyer.id } });
  }
});
