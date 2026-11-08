import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { closingPacket } from "../lib/closing-packet";
import { diligenceChecklist } from "../lib/diligence-checklist";
import { ENOTE_LINE, ENOTE_NO_PAPER, eNoteSummary, isENote, isMersOrgId, isPaperForm, paperLoans, parseMersOrgId, transferNeeds, transfereeNote, transfereeOf } from "../lib/enotes";
import { collateralLines, completeness, displayValue, fieldSpec, standardChecklist, tapeValue } from "../lib/loan-file";
import { mismoFor, mismoLoan, TAPE_STANDARD, WITHHELD_UNTIL_OPEN } from "../lib/mismo";
import { prisma } from "../lib/prisma";
import { sendForSignatures } from "../lib/signatures";
import { normalizeTapeRows, readServicing } from "../lib/tape";
import { suggestMapping, termsExportColumns } from "../lib/tape-fields";

// The closing papers stay on local disk and signing stays in the app, whatever the local .env carries.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

test("a MERS Org ID is 7 digits, and the buyer's answer reads back off the item", () => {
  assert.equal(parseMersOrgId("1000123"), "1000123");
  assert.equal(parseMersOrgId(" 100-0123 "), "1000123");
  assert.equal(parseMersOrgId("100 0123"), "1000123");
  assert.equal(parseMersOrgId("123456"), null);
  assert.equal(parseMersOrgId("12345678"), null);
  assert.equal(parseMersOrgId("10001A3"), null);
  assert.equal(parseMersOrgId(""), null);
  assert.equal(parseMersOrgId(null), null);
  assert.equal(isMersOrgId("1000123"), true);
  assert.equal(isMersOrgId("100012300000123456"), false);
  assert.equal(transfereeOf(transfereeNote("1000789")), "1000789");
  assert.equal(transfereeOf("Something else"), null);
  assert.match(transferNeeds("ENOTE_CONTROL", "Equity Trust"), /yours, or your custodian's \(Equity Trust\)/);
  assert.match(transferNeeds("ENOTE_LOCATION", null), /eVault that will hold the eNote/);
  assert.equal(isENote({ eNote: true }), true);
  assert.equal(isENote({ eNote: false }), false);
  assert.equal(isENote({}), false);
  assert.equal(isENote(null), false);
});

test("the tape reads the eNote flag, the eRegistry Org IDs and the eVault, and leaves off what it can't read", () => {
  // "eNote" alone still means the eNote ID; the flag answers to its own headers.
  const mapping = suggestMapping(["City", "State", "Type", "Lien", "Status", "UPB", "Value", "Rate", "Ask", "eNote", "Is eNote", "eRegistry Controller", "eRegistry Location", "eVault Provider"]);
  assert.equal(mapping.eNoteId, "eNote");
  assert.equal(mapping.eNote, "Is eNote");
  assert.equal(mapping.eRegistryController, "eRegistry Controller");
  assert.equal(mapping.eRegistryLocation, "eRegistry Location");
  assert.equal(mapping.eVaultProvider, "eVault Provider");
  const core = { city: "City", state: "State", propertyType: "Type", lienPosition: "Lien", paymentStatus: "Status", upb: "UPB", estimatedValue: "Value", interestRate: "Rate", askingPrice: "Ask" } as const;
  const base = { City: "Tampa", State: "FL", Type: "SFR", Lien: "First", Status: "Performing", UPB: "100000", Value: "150000", Rate: "6.5", Ask: "80000" };
  const full = { ...core, eNote: "Is eNote", eRegistryController: "eRegistry Controller", eRegistryLocation: "eRegistry Location", eVaultProvider: "eVault Provider" } as const;
  const { loans, errors } = normalizeTapeRows({
    rows: [
      { ...base, "Is eNote": "Yes", "eRegistry Controller": "100-0123", "eRegistry Location": "1000456", "eVault Provider": "Sample eVault" },
      // A bad Org ID is left off; the flag left blank is answered by the Org ID that was read.
      { ...base, "Is eNote": "", "eRegistry Controller": "12345", "eRegistry Location": "1000456" },
      { ...base, "Is eNote": "maybe" },
      { ...base, "Is eNote": "No" },
    ],
    mapping: full,
    priceMode: "COLUMN",
  });
  assert.deepEqual(errors, []);
  const [first, second, third, fourth] = loans;
  assert.equal(first.eNote, true);
  assert.equal(first.eRegistryController, "1000123");
  assert.equal(first.eRegistryLocation, "1000456");
  assert.equal(first.eVaultProvider, "Sample eVault");
  assert.equal(second.eRegistryController, undefined);
  assert.equal(second.eRegistryLocation, "1000456");
  assert.equal(second.eNote, true);
  assert.equal(third.eNote, undefined);
  assert.equal(fourth.eNote, false);
  const notes = readServicing({ ...base, "Is eNote": "maybe", "eRegistry Controller": "12345" }, full).notes;
  assert.ok(notes.some((note) => note.field === "eNote" && /yes or no/.test(note.message)));
  assert.ok(notes.some((note) => note.field === "eRegistryController" && /7-digit MERS Org ID/.test(note.message)));
  // The standard lists them, as UPB extensions, and an Org ID names a holder, not the borrower.
  for (const key of ["eNote", "eRegistryController", "eRegistryLocation", "eVaultProvider"] as const) {
    assert.ok(TAPE_STANDARD.some((field) => field.key === key), key);
    assert.equal(mismoFor(key)?.match, "extension");
    assert.equal(WITHHELD_UNTIL_OPEN.has(key), false);
  }
});

test("the tape export carries the eNote fields, and an import of it reads them back", () => {
  const stored = { eNote: true, eRegistryController: "1000123", eRegistryLocation: "1000456", eVaultProvider: "Sample eVault", eNoteId: "EN-778-1" };
  // Org IDs name a MERS member, not the borrower, so a closed loan still exports them; the eNote ID waits for the street.
  const closed = termsExportColumns(stored, false);
  assert.equal(closed.isENote, "yes");
  assert.equal(closed.eRegistryController, "1000123");
  assert.equal(closed.eRegistryLocation, "1000456");
  assert.equal(closed.eVaultProvider, "Sample eVault");
  assert.equal(closed.eNoteId, "");
  assert.equal(termsExportColumns({ eNote: false }, true).isENote, "no");
  assert.equal(termsExportColumns({}, true).isENote, "");
  // The export's own headers map back to the same fields.
  const open = termsExportColumns(stored, true);
  const row = Object.fromEntries(Object.entries({ City: "Tampa", State: "FL", Type: "SFR", Lien: "First", Status: "Performing", UPB: "100000", Value: "150000", Rate: "6.5", Ask: "80000", ...open }).map(([key, value]) => [key, String(value)]));
  const mapping = suggestMapping(Object.keys(row));
  assert.equal(mapping.eNote, "isENote");
  assert.equal(mapping.eNoteId, "eNoteId");
  const { loans, errors } = normalizeTapeRows({ rows: [row], mapping: { ...mapping, city: "City", state: "State", propertyType: "Type", lienPosition: "Lien", paymentStatus: "Status", upb: "UPB", estimatedValue: "Value", interestRate: "Rate", askingPrice: "Ask" }, priceMode: "COLUMN" });
  assert.deepEqual(errors, []);
  assert.equal(loans[0].eNote, true);
  assert.equal(loans[0].eRegistryController, "1000123");
  assert.equal(loans[0].eRegistryLocation, "1000456");
  assert.equal(loans[0].eVaultProvider, "Sample eVault");
  assert.equal(loans[0].eNoteId, "EN-778-1");
  // The MISMO export reads the standard's field list, so the four travel there too, under UPB extensions.
  const mismo = mismoLoan({ city: "Tampa", ...stored }, false);
  assert.equal(mismo["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/ENoteIndicator"], true);
  assert.equal(mismo["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/ERegistryControllerOrganizationIdentifier"], "1000123");
  assert.equal(mismo["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/ERegistryLocationOrganizationIdentifier"], "1000456");
  assert.equal(mismo["DEAL/LOANS/LOAN/EXTENSION/OTHER/UPB_TAPE/EVaultProviderName"], "Sample eVault");
  assert.ok(!Object.values(mismo).includes("EN-778-1"));
});

test("an eNote's file doesn't ask for the paper original or an allonge, and the loan file says it's on the eRegistry", () => {
  const paper = standardChecklist("FIRST");
  const electronic = standardChecklist("FIRST", { eNote: true });
  const line = (lines: typeof paper, kind: string) => lines.find((row) => row.kind === kind)!;
  assert.equal(line(paper, "ORIGINAL_NOTE").required, true);
  assert.equal(line(paper, "ALLONGE").required, true);
  assert.equal(line(electronic, "ORIGINAL_NOTE").required, false);
  assert.match(line(electronic, "ORIGINAL_NOTE").reason ?? "", /eVault's confirmation/);
  assert.equal(line(electronic, "ALLONGE").required, false);
  assert.match(line(electronic, "ALLONGE").reason ?? "", /no allonge/);
  // Everything else stands as it does for paper.
  assert.deepEqual(
    electronic.filter((row) => row.kind !== "ORIGINAL_NOTE" && row.kind !== "ALLONGE").map((row) => [row.kind, row.required]),
    paper.filter((row) => row.kind !== "ORIGINAL_NOTE" && row.kind !== "ALLONGE").map((row) => [row.kind, row.required]),
  );
  assert.equal(collateralLines("FIRST", [], { eNote: true }).find((row) => row.kind === "ALLONGE")?.required, false);
  // An untouched file asks for two fewer lines.
  const before = completeness({ lienPosition: "FIRST" }, [], []).collateral.required;
  assert.equal(completeness({ lienPosition: "FIRST", eNote: true } as { lienPosition: string }, [], []).collateral.required, before - 2);

  const spec = fieldSpec("eNote")!;
  assert.equal(spec.label, ENOTE_LINE);
  assert.equal(spec.source, "eVault confirmation");
  assert.equal(displayValue(spec, tapeValue({ eNote: true }, "eNote")), "Yes");
  assert.equal(tapeValue({}, "eNote"), null);
  assert.equal(fieldSpec("eRegistryController")?.identity, undefined);

  assert.equal(eNoteSummary([{ eNote: false }]), null);
  assert.equal(eNoteSummary([{ eNote: true }])?.title, "eNote on the MERS eRegistry");
  assert.equal(eNoteSummary([{ eNote: true }, { eNote: true }])?.title, "Every loan is an eNote on the MERS eRegistry");
  assert.equal(eNoteSummary([{ eNote: true }, {}, {}])?.title, "1 of 3 loans are eNotes on the MERS eRegistry");
  assert.deepEqual(paperLoans("ALLONGE", [{ id: "a" }, { id: "b", eNote: true }]), [{ id: "a" }]);
  assert.equal(paperLoans("PSA", [{ id: "a" }, { id: "b", eNote: true }]).length, 2);
  assert.equal(isPaperForm("LOST_NOTE_AFFIDAVIT"), true);
  assert.equal(isPaperForm("ASSIGNMENT"), false);

  // The pool room's diligence set asks no endorsement chain of an eNote.
  const notes = [
    { id: "p", city: "Tampa", state: "FL", lienPosition: "FIRST", paymentStatus: "NON_PERFORMING" },
    { id: "e", city: "Tampa", state: "FL", lienPosition: "FIRST", paymentStatus: "NON_PERFORMING", eNote: true },
  ];
  const endorsements = diligenceChecklist({ kind: "POOL", notes, collateral: [], documents: [], release: false }).lines.find((row) => row.key === "ENDORSEMENTS")!;
  assert.equal(endorsements.required, 1);
  assert.deepEqual(endorsements.missing.map((gap) => gap.noteId), ["p"]);
});

const loan = (street: string, extra: Record<string, unknown> = {}) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 120000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 100000, estimatedValue: 180000, borrowerName: "Pat Borrower", ...extra,
});

test("the closing packet draws no allonge or lost note affidavit for an eNote, and none goes out for signature", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const email = (who: string) => `e-enotes-${tag}-${who}@example.org`;
  const seller = await prisma.user.create({ data: { email: email("seller"), name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const buyer = await prisma.user.create({ data: { email: email("buyer"), name: `Buyer ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  const closer = await prisma.user.create({ data: { email: email("closer"), name: `Closer ${tag}`, role: "ADMIN", deskRole: "CLOSINGS", accountStatus: "APPROVED", passwordHash: "x" } });
  const users = [seller, buyer, closer];
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: "PENDING",
      approvedAt: new Date(),
      reservePrice: 1000,
      title: `E enotes ${tag}`,
      notes: { create: [loan("1 Paper Row"), loan("2 Vault Lane", { eNote: true, eRegistryController: "1000123" })] as never },
    },
    include: { notes: { orderBy: { streetAddress: "asc" } } },
  });
  const [paper, enote] = listing.notes;
  try {
    const inquiry = await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 90000 } });
    const closing = (noteIds: string[]) =>
      prisma.closing.create({
        data: { listingId: listing.id, inquiryId: noteIds.length === 2 ? inquiry.id : null, noteIds, salePrice: 90000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 9000000, netToSellerCents: 9000000 },
      });
    const pages = async (closingId: string, kind: "ALLONGE" | "LOST_NOTE_AFFIDAVIT" | "ASSIGNMENT" | "PSA") => {
      const packet = await closingPacket(closingId, kind, { id: seller.id, role: seller.role });
      if (!packet?.allowed) return packet && "eNote" in packet ? "eNote" : "refused";
      return (await PDFDocument.load(packet.pdf)).getPageCount();
    };
    // A pool of one paper loan and one eNote: the allonge and the affidavit cover the paper loan alone.
    const mixed = await closing([paper.id, enote.id]);
    assert.equal(await pages(mixed.id, "ALLONGE"), 1);
    assert.equal(await pages(mixed.id, "LOST_NOTE_AFFIDAVIT"), 1);
    assert.equal(await pages(mixed.id, "ASSIGNMENT"), 2);
    // The eNote alone: no allonge and no affidavit, while the purchase agreement and the assignment still draw.
    const electronic = await closing([enote.id]);
    assert.equal(await pages(electronic.id, "ALLONGE"), "eNote");
    assert.equal(await pages(electronic.id, "LOST_NOTE_AFFIDAVIT"), "eNote");
    assert.equal(typeof (await pages(electronic.id, "ASSIGNMENT")), "number");
    assert.equal(typeof (await pages(electronic.id, "PSA")), "number");
    // A stranger is still refused as before, not told about the eNote.
    assert.equal(await closingPacket(electronic.id, "ALLONGE", { id: buyer.id, role: "BUYER" }).then((packet) => packet?.allowed), false);
    assert.equal(await closingPacket(electronic.id, "ALLONGE", { id: buyer.id, role: "BUYER" }).then((packet) => packet && "eNote" in packet), false);
    // The desk can't send one for signature either.
    assert.deepEqual(await sendForSignatures(electronic.id, "ALLONGE", closer), { error: ENOTE_NO_PAPER });
    assert.equal(await prisma.signatureRequest.count({ where: { closingId: electronic.id } }), 0);
  } finally {
    const closings = await prisma.closing.findMany({ where: { listingId: listing.id }, select: { id: true } });
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [listing.id, ...closings.map((row) => row.id)] } } });
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: users.map((row) => row.email) } }, { subject: { contains: listing.title } }] } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((row) => row.id) } } });
  }
});
