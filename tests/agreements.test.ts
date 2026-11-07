import assert from "node:assert/strict";
import test from "node:test";
import {
  MASTER_KINDS,
  MASTER_VERSIONS,
  acceptMaster,
  acceptanceHistory,
  agreementBack,
  currentAcceptance,
  currentVersion,
  masterKindsFor,
  masterLines,
  masterPrefill,
  masterTermsText,
  masterText,
  type MasterParty,
} from "../lib/agreements";
import { pdfText } from "../lib/ai-reading";
import { DEFAULT_TEMPLATES, PER_LOAN_TEMPLATES, TEMPLATE_KEYS, fillTemplate, formBody, templateTokens, winAnsi } from "../lib/closing-docs";
import { closingPacket } from "../lib/closing-packet";
import { legalBlocks } from "../lib/legal";
import { prisma } from "../lib/prisma";
import { isTemplateKey } from "../lib/templates";

test.after(async () => {
  await prisma.$disconnect();
});

const tag = () => `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const meta = { ip: "203.0.113.7", userAgent: "agreements-test" };

// Every row these tests make hangs off these accounts, so removing them removes the rest.
async function cleanPeople(ids: string[]) {
  await prisma.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.agreementAcceptance.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

// ---------------------------------------------------------------------------------------------------------------
// The texts, as pure rules.

test("each master opens with the desk-draft note and covers the articles counsel will finish", () => {
  for (const kind of MASTER_KINDS) {
    const text = masterText(kind);
    assert.ok(text, kind);
    assert.equal(text.version, currentVersion(kind));
    const [first] = legalBlocks(text.body);
    assert.equal(first.kind, "note");
    assert.match(first.kind === "note" ? first.text : "", /^Desk draft pending counsel review\./);
    const body = text.body;
    assert.match(body, /as is, where is, and with all faults/);
    assert.match(body, /chain of title/);
    assert.match(body, /## Your representations/);
    assert.match(body, /within \[180\] days after the closing date/);
    assert.match(body, /\[30\] days to cure/);
    assert.match(body, /the price paid for that loan;\n- plus the buyer's documented, reasonable costs/);
    assert.match(body, /the price moves in the same proportion/);
    assert.match(body, /refunded in full when/);
    assert.match(body, /inside the diligence window/);
    assert.match(body, /forfeited to (the seller when you fail|you when the buyer fails) to close after the diligence window ends/);
    assert.match(body, /within \[12\] months of the introduction, you owe UPB the fees it would have charged on the desk/);
    assert.match(body, /## Confidentiality/);
    assert.match(body, /E-SIGN Act/);
    assert.match(body, /laws of \[State\], set by counsel/);
    // A draft never claims a lawyer has read it.
    assert.doesNotMatch(body, /reviewed by (an )?(attorney|counsel|lawyer)|attorney-reviewed|approved by counsel|fictional/i);
    // The texts print on the standard PDF fonts.
    assert.equal(winAnsi(body), body);
  }
  assert.match(masterText("MASTER_SALE")!.body, /## Your warranty on title and collateral/);
  assert.match(masterText("MASTER_PURCHASE")!.body, /## What the seller warrants/);
});

test("the closing forms are desk drafts with articles, and the new forms fill from their tokens", () => {
  assert.deepEqual([...TEMPLATE_KEYS], ["PSA", "ASSIGNMENT", "ALLONGE", "LOST_NOTE_AFFIDAVIT", "DEPOSIT_AGREEMENT"]);
  for (const key of TEMPLATE_KEYS) {
    const form = DEFAULT_TEMPLATES[key];
    assert.equal(isTemplateKey(key), true);
    assert.match(form.body, /Desk draft pending counsel review\./, key);
    assert.doesNotMatch(form.body, /fictional|for this demo|Desk form only/i, key);
    // The forms page refuses a body over 8,000 characters, so the built-in one must fit.
    assert.ok(form.body.length < 8000, key);
    assert.equal(winAnsi(form.body), form.body, key);
  }
  const psa = DEFAULT_TEMPLATES.PSA.body;
  for (const article of ["1. As-is sale.", "2. Seller's warranty.", "3. Representations.", "4. Repurchase.", "5. Proration.", "6. Deposit.", "11. Master agreements. {{masterTerms}}"]) {
    assert.ok(psa.includes(article), article);
  }
  assert.deepEqual([...PER_LOAN_TEMPLATES], ["ASSIGNMENT", "ALLONGE", "LOST_NOTE_AFFIDAVIT"]);
  // A purchase agreement the desk saved before the token existed still gets the paragraph. Other forms don't.
  assert.equal(formBody("PSA", psa), psa);
  assert.equal(formBody("PSA", "Old desk text."), "Old desk text.\n\nMaster agreements. {{masterTerms}}");
  assert.equal(formBody("ALLONGE", "Old desk text."), "Old desk text.");

  const vars: Record<string, string> = {
    seller: "Seller Notes LLC",
    buyer: "Roe Capital LLC",
    title: "First lien in Tampa",
    price: "$90,000",
    allIn: "$92,250",
    street: "12 Bay St",
    city: "Tampa",
    state: "FL",
    borrower: "Pat Borrower",
    upb: "$120,000",
    loanNumber: "LN-7731",
    noteDate: "2019-04-01",
    signer: "Dana Seller",
    signerTitle: "Managing member",
    date: "2026-11-08",
    depositTerms: "The buyer pays a deposit of $4,500.00 by 2026-11-12.",
    diligenceWindow: "inside its diligence window, which ends on 2026-11-20",
    closingRef: "cls_123",
    buyerMaster: "Master purchase agreement version 1, accepted 2026-11-03",
    sellerMaster: "Master sale agreement version 1, not accepted",
  };
  for (const key of ["LOST_NOTE_AFFIDAVIT", "DEPOSIT_AGREEMENT"] as const) {
    const body = DEFAULT_TEMPLATES[key].body;
    for (const token of templateTokens(body)) assert.ok(token in vars, `${key} uses {{${token}}}`);
    assert.doesNotMatch(fillTemplate(body, vars), /\{\{/);
  }
  const affidavit = fillTemplate(DEFAULT_TEMPLATES.LOST_NOTE_AFFIDAVIT.body, vars);
  assert.match(affidavit, /Dana Seller, Managing member of Seller Notes LLC \(the seller\), states under penalty of perjury/);
  assert.match(affidavit, /Borrower: Pat Borrower\. Collateral: 12 Bay St, Tampa, FL\. Loan number: LN-7731\. Note date: 2019-04-01/);
  assert.match(affidavit, /sells the note and the mortgage to Roe Capital LLC/);
  const deposit = fillTemplate(DEFAULT_TEMPLATES.DEPOSIT_AGREEMENT.body, vars);
  assert.match(deposit, /1\. Amount\. The buyer pays a deposit of \$4,500\.00 by 2026-11-12\. The buyer wires it .* reference cls_123/);
  assert.match(deposit, /- the buyer walks away inside its diligence window, which ends on 2026-11-20\./);
  assert.match(deposit, /Buyer: Master purchase agreement version 1, accepted 2026-11-03\. Seller: Master sale agreement version 1, not accepted\./);
});

test("the purchase agreement's master paragraph names each acceptance, or says the articles govern", () => {
  const at = new Date("2026-11-04T15:00:00.000Z");
  const party = (side: MasterParty["side"], label: string, accepted: boolean): MasterParty => ({
    side,
    userId: label,
    name: label,
    label,
    kind: side === "SELLER" ? "MASTER_SALE" : "MASTER_PURCHASE",
    version: "1",
    acceptance: accepted ? { version: "1", signerName: `${label} signer`, signerTitle: "", entityName: `${label} entity`, acceptedAt: at } : null,
  });
  const desk = masterTermsText({ deskPurchase: true, complete: true, parties: [party("SELLER", "the seller", true)] });
  assert.match(desk, /incorporated into this agreement by reference: the seller's master sale agreement, version 1, accepted on 2026-11-04 by the seller signer, for the seller entity\./);
  assert.match(desk, /UPB Capital buys for its own book/);
  const group = { deskPurchase: false, complete: false, parties: [party("SELLER", "the seller", true), party("BUYER", "Alpha Holdings", true), party("BUYER", "Beta Trust", false)] };
  const open = masterTermsText(group);
  assert.match(open, /^No master agreement is incorporated/);
  assert.match(open, /Beta Trust has not accepted version 1 of the master purchase agreement\. The articles above govern this sale on their own\./);
  assert.doesNotMatch(open, /Alpha Holdings has not/);
  assert.deepEqual(masterLines(group), {
    sellerMaster: `Master sale agreement version ${currentVersion("MASTER_SALE")}, accepted 2026-11-04`,
    buyerMaster: `Master purchase agreement version ${currentVersion("MASTER_PURCHASE")}, not accepted by every seat`,
  });
  // A closing with no buyer named is never complete.
  assert.match(masterTermsText({ deskPurchase: false, complete: false, parties: [party("SELLER", "the seller", true)] }), /no buyer is named/);
});

test("the accept page sends people back only to their own desk pages", () => {
  assert.equal(agreementBack("/closings/cmabc123xyz"), "/closings/cmabc123xyz");
  assert.equal(agreementBack("/buyer/offers"), "/buyer/offers");
  assert.equal(agreementBack("/seller"), "/seller");
  for (const bad of ["//evil.example", "https://evil.example", "/closings/../admin", "/admin/settings", "", null, 7]) assert.equal(agreementBack(bad), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Accepting, and a new version.

test("a member accepts the master once, and a new version asks again and keeps the old acceptance", async () => {
  const id = tag();
  const buyer = await prisma.user.create({
    data: { email: `d-master-buyer-${id}@example.test`, name: "Jo Roe", companyName: "Roe Capital LLC", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  try {
    assert.deepEqual(await masterKindsFor(buyer), ["MASTER_PURCHASE"]);
    assert.deepEqual(await masterKindsFor({ id: buyer.id, role: "INDIVIDUAL_SELLER" }), ["MASTER_SALE"]);
    assert.deepEqual(await masterKindsFor({ id: buyer.id, role: "ADMIN" }), []);
    assert.deepEqual(await masterKindsFor({ id: buyer.id, role: "BROKER" }), []);
    assert.equal(await currentAcceptance(buyer.id, "MASTER_PURCHASE"), null);
    assert.deepEqual(await masterPrefill(buyer, "MASTER_PURCHASE"), { signerName: "Jo Roe", signerTitle: "", entityName: "Roe Capital LLC" });

    const base = { kind: "MASTER_PURCHASE", signerName: "  Jo   Roe ", signerTitle: "Manager", entityName: "", agreed: "yes", ...meta };
    assert.equal((await acceptMaster(buyer, { ...base, kind: "TERMS" })).error, "Choose an agreement to sign.");
    assert.match((await acceptMaster(buyer, { ...base, kind: "MASTER_SALE" })).error ?? "", /doesn't sign the master sale agreement/);
    assert.equal((await acceptMaster(buyer, { ...base, agreed: "on" })).error, "Tick the box to sign.");
    assert.equal((await acceptMaster(buyer, { ...base, signerName: " J " })).error, "Type the name you are signing with.");
    assert.equal((await acceptMaster({ id: buyer.id, role: "ADMIN" }, base)).error, "Your account doesn't sign the master purchase agreement.");
    assert.equal(await prisma.agreementAcceptance.count({ where: { userId: buyer.id } }), 0);

    const first = await acceptMaster(buyer, base, new Date("2026-11-01T12:00:00.000Z"));
    if (first.error !== null) throw new Error(first.error);
    assert.equal(first.already, false);
    assert.equal(first.acceptance.version, currentVersion("MASTER_PURCHASE"));
    assert.equal(first.acceptance.signerName, "Jo Roe");
    assert.equal(first.acceptance.signerTitle, "Manager");
    // An individual's entity is their own name.
    assert.equal(first.acceptance.entityName, "Jo Roe");
    assert.equal(first.acceptance.ip, meta.ip);
    assert.equal(first.acceptance.userAgent, meta.userAgent);
    assert.equal((await currentAcceptance(buyer.id, "MASTER_PURCHASE"))?.id, first.acceptance.id);
    const logged = await prisma.auditEvent.findFirst({ where: { actorId: buyer.id, action: "MASTER_ACCEPTED", entityId: first.acceptance.id } });
    assert.match(logged?.detail ?? "", /master purchase agreement, version 1, as Jo Roe, Manager, for Jo Roe/);

    // Signing the same version again records nothing new.
    const again = await acceptMaster(buyer, base);
    assert.equal(again.error, null);
    assert.equal(again.error === null && again.already, true);
    assert.equal(await prisma.agreementAcceptance.count({ where: { userId: buyer.id } }), 1);

    // A new version is a new entry at the end of the list. Nobody has accepted it yet.
    const previous = currentVersion("MASTER_PURCHASE");
    MASTER_VERSIONS.MASTER_PURCHASE.push({ ...masterText("MASTER_PURCHASE")!, version: `${previous}-test`, effective: "2026-12-01" });
    try {
      assert.equal(currentVersion("MASTER_PURCHASE"), `${previous}-test`);
      assert.equal(await currentAcceptance(buyer.id, "MASTER_PURCHASE"), null);
      const history = await acceptanceHistory(buyer.id, "MASTER_PURCHASE");
      assert.deepEqual(history.map((row) => row.version), [previous]);
      // The earlier text stays readable, and the form starts from the last signature.
      assert.ok(masterText("MASTER_PURCHASE", previous));
      assert.deepEqual(await masterPrefill(buyer, "MASTER_PURCHASE"), { signerName: "Jo Roe", signerTitle: "Manager", entityName: "Jo Roe" });
      const second = await acceptMaster(buyer, { ...base, entityName: "Roe Capital LLC" }, new Date("2026-12-02T12:00:00.000Z"));
      if (second.error !== null) throw new Error(second.error);
      assert.equal(second.already, false);
      assert.equal(second.acceptance.version, `${previous}-test`);
      assert.equal((await currentAcceptance(buyer.id, "MASTER_PURCHASE"))?.id, second.acceptance.id);
      assert.deepEqual((await acceptanceHistory(buyer.id, "MASTER_PURCHASE")).map((row) => row.version), [`${previous}-test`, previous]);
    } finally {
      MASTER_VERSIONS.MASTER_PURCHASE.pop();
    }
    assert.equal((await currentAcceptance(buyer.id, "MASTER_PURCHASE"))?.id, first.acceptance.id);

    // A buyer who relists a holding sells too, so signs both.
    const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: buyer.id, status: "SUBMITTED", title: `d-master resale ${id}` } });
    try {
      assert.deepEqual(await masterKindsFor(buyer), ["MASTER_PURCHASE", "MASTER_SALE"]);
    } finally {
      await prisma.listing.delete({ where: { id: listing.id } });
    }
  } finally {
    await cleanPeople([buyer.id]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The packet.

test("the purchase agreement incorporates the masters only once both sides accept, and the new forms fill", async () => {
  const id = tag();
  const seller = await prisma.user.create({
    data: { email: `d-master-seller-${id}@example.test`, name: "Dana Seller", companyName: "Seller Notes LLC", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  const buyer = await prisma.user.create({
    data: { email: `d-master-pbuyer-${id}@example.test`, name: "Jo Roe", companyName: "Roe Capital LLC", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  const stranger = await prisma.user.create({
    data: { email: `d-master-other-${id}@example.test`, name: "Other Buyer", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  try {
    const listing = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId: seller.id,
        status: "APPROVED",
        title: `d-master ${id}`,
        notes: {
          create: {
            streetAddress: "12 Bay St",
            city: "Tampa",
            state: "FL",
            propertyType: "SFR",
            estimatedValue: 200000,
            lienPosition: "FIRST",
            upb: 120000,
            interestRate: 6,
            monthlyPi: 900,
            paymentStatus: "PERFORMING",
            askingPrice: 95000,
            borrowerName: "Pat Borrower",
            loanNumber: "LN-7731",
            originationDate: new Date("2019-04-01T00:00:00.000Z"),
          },
        },
      },
    });
    const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", amount: 90000, message: "d-master bid" } });
    const closing = await prisma.closing.create({
      data: {
        listingId: listing.id,
        inquiryId: inquiry.id,
        salePrice: 90000,
        buyerPremiumCents: 225000,
        sellerCommissionCents: 270000,
        buyerTotalCents: 9225000,
        netToSellerCents: 8730000,
        depositCents: 450000,
        depositDueAt: new Date("2026-11-12T00:00:00.000Z"),
        diligenceEndsAt: new Date("2026-11-20T00:00:00.000Z"),
      },
    });
    const read = async (kind: (typeof TEMPLATE_KEYS)[number]) => {
      const packet = await closingPacket(closing.id, kind, { id: seller.id, role: seller.role });
      if (!packet || !packet.allowed) throw new Error(`${kind} packet refused`);
      return { packet, text: pdfText(packet.pdf).replace(/\s+/g, " ") };
    };
    const purchase = currentVersion("MASTER_PURCHASE");
    const sale = currentVersion("MASTER_SALE");

    assert.equal((await closingPacket(closing.id, "PSA", { id: stranger.id, role: "BUYER" }))?.allowed, false);

    // Nobody has signed: the articles govern.
    const none = await read("PSA");
    assert.equal(none.packet.masters.complete, false);
    assert.match(none.text, /No master agreement is incorporated/);
    assert.match(none.text, new RegExp(`the seller has not accepted version ${sale} of the master sale agreement; the buyer has not accepted version ${purchase} of the master purchase agreement\\. The articles above govern this sale on their own\\.`));
    assert.doesNotMatch(none.text, /incorporated into this agreement by reference/);

    // The seller alone is not enough.
    const sellerSigned = await acceptMaster(seller, { kind: "MASTER_SALE", signerName: "Dana Seller", signerTitle: "Managing member", entityName: "Seller Notes LLC", agreed: "yes", ...meta }, new Date("2026-11-02T12:00:00.000Z"));
    assert.equal(sellerSigned.error, null);
    const half = await read("PSA");
    assert.match(half.text, /No master agreement is incorporated/);
    assert.match(half.text, /the buyer has not accepted version/);
    assert.doesNotMatch(half.text, /the seller has not accepted/);

    // Both sides at the current versions: the masters are incorporated, with versions and dates.
    const buyerSigned = await acceptMaster(buyer, { kind: "MASTER_PURCHASE", signerName: "Jo Roe", signerTitle: "Manager", entityName: "Roe Capital LLC", agreed: "yes", ...meta }, new Date("2026-11-03T12:00:00.000Z"));
    assert.equal(buyerSigned.error, null);
    const both = await read("PSA");
    assert.equal(both.packet.masters.complete, true);
    assert.match(both.text, /incorporated into this agreement by reference/);
    assert.match(both.text, new RegExp(`the seller's master sale agreement, version ${sale}, accepted on 2026-11-02 by Dana Seller, Managing member, for Seller Notes LLC`));
    assert.match(both.text, new RegExp(`the buyer's master purchase agreement, version ${purchase}, accepted on 2026-11-03 by Jo Roe, Manager, for Roe Capital LLC`));
    assert.match(both.text, /the master agreements govern, except for the price, the loans, the deposit and the dates/);
    assert.doesNotMatch(both.text, /No master agreement is incorporated/);

    // A new version nobody has accepted takes the incorporation away again.
    MASTER_VERSIONS.MASTER_SALE.push({ ...masterText("MASTER_SALE")!, version: `${sale}-test`, effective: "2026-12-01" });
    try {
      const stale = await read("PSA");
      assert.match(stale.text, new RegExp(`the seller has not accepted version ${sale}-test of the master sale agreement`));
    } finally {
      MASTER_VERSIONS.MASTER_SALE.pop();
    }

    // The new forms fill from the closing and its loan.
    const affidavit = await read("LOST_NOTE_AFFIDAVIT");
    assert.match(affidavit.text, /Dana Seller, authorised signer of Seller Notes LLC \(the seller\)/);
    assert.match(affidavit.text, /Borrower: Pat Borrower\. Collateral: 12 Bay St, Tampa, FL\. Loan number: LN-7731\. Note date: 2019-04-01\./);
    const deposit = await read("DEPOSIT_AGREEMENT");
    assert.match(deposit.text, /The buyer pays a deposit of \$4,500\.00 by 2026-11-12\./);
    assert.match(deposit.text, new RegExp(`reference ${closing.id}`));
    assert.match(deposit.text, /the buyer walks away inside its diligence window, which ends on 2026-11-20\./);
    assert.match(deposit.text, new RegExp(`Buyer: Master purchase agreement version ${purchase}, accepted 2026-11-03\\. Seller: Master sale agreement version ${sale}, accepted 2026-11-02\\.`));
  } finally {
    await prisma.closing.deleteMany({ where: { listing: { sellerId: seller.id } } });
    await prisma.inquiry.deleteMany({ where: { buyerId: buyer.id } });
    await prisma.listing.deleteMany({ where: { sellerId: seller.id } });
    await cleanPeople([seller.id, buyer.id, stranger.id]);
  }
});
