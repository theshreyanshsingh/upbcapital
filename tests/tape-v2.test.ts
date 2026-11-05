import assert from "node:assert/strict";
import test from "node:test";
import { duplicateKeys, duplicatesFor } from "../lib/duplicates";
import { prisma } from "../lib/prisma";
import { normalizeTapeRows } from "../lib/tape";
import { SAMPLE_TAPE_ROWS, TAPE_HEADERS, parsePayString, payStringWidth, restorePayString, suggestMapping } from "../lib/tape-fields";
import { monthsPastDue, reviewTape } from "../lib/tape-quality";
import { noteSchema, servicingDraft } from "../lib/validators";

const NOW = new Date("2026-11-05T12:00:00Z");

test("pay strings read from digits, C for current, separators and days late", () => {
  assert.equal(parsePayString("000011"), "000011");
  assert.equal(parsePayString("CCCC3"), "00003");
  assert.equal(parsePayString("cccc3"), "00003");
  assert.equal(parsePayString("0,0,1"), "001");
  assert.equal(parsePayString("0-0-1"), "001");
  assert.equal(parsePayString("0 30 60 90"), "0123");
  assert.equal(parsePayString("0, 30, 180+"), "016");
  assert.equal(parsePayString("000,011"), "000011");
  assert.equal(parsePayString("X00"), "X00");
  // Run together, "30" is two months, not thirty days.
  assert.equal(parsePayString("30"), "30");
  assert.equal(parsePayString("paid"), null);
  assert.equal(parsePayString(""), null);
  assert.equal(parsePayString("0".repeat(60))?.length, 48);
});

test("a pay string that lost its leading zeros in a spreadsheet gets them back", () => {
  const column = ["000000000000", "100000000000", "11", "", "abc"];
  assert.equal(payStringWidth(column), 12);
  assert.equal(restorePayString("11", 12), "000000000011");
  // Only an all-digit value is padded. "CC1" was typed, not rounded.
  assert.equal(restorePayString("CC1", 12), "001");
  assert.equal(restorePayString("11", 0), "11");
});

test("servicer tape headers map to the new fields without taking the old ones", () => {
  const headers = ["Loan #", "Servicer", "Pay History", "Next Due", "BK Chapter", "BK Filed Date", "FC Date", "Mod Date", "Modified", "Value", "Value Date", "Value Source", "Loan Purpose", "HOA Lien", "Taxes Delinquent", "Loss Mit"];
  const mapping = suggestMapping(headers);
  assert.equal(mapping.loanNumber, "Loan #");
  assert.equal(mapping.servicerName, "Servicer");
  assert.equal(mapping.payString, "Pay History");
  assert.equal(mapping.nextDueDate, "Next Due");
  assert.equal(mapping.bankruptcyChapter, "BK Chapter");
  assert.equal(mapping.bankruptcyFiledAt, "BK Filed Date");
  assert.equal(mapping.foreclosureFiledAt, "FC Date");
  assert.equal(mapping.modificationDate, "Mod Date");
  assert.equal(mapping.modified, "Modified");
  assert.equal(mapping.estimatedValue, "Value");
  assert.equal(mapping.valueAsOf, "Value Date");
  assert.equal(mapping.valueType, "Value Source");
  assert.equal(mapping.loanPurpose, "Loan Purpose");
  assert.equal(mapping.hoaLien, "HOA Lien");
  assert.equal(mapping.taxDelinquent, "Taxes Delinquent");
  assert.equal(mapping.lossMitigation, "Loss Mit");
  // The template's own headers map every field.
  const template = suggestMapping(TAPE_HEADERS);
  assert.equal(Object.keys(template).length, TAPE_HEADERS.length);
});

const base = { City: "Tampa", State: "FL", Type: "SFR", Lien: "First", Status: "Performing", UPB: "100000", Value: "150000", Rate: "6.5", Ask: "80000" };
const mapping = {
  city: "City",
  state: "State",
  propertyType: "Type",
  lienPosition: "Lien",
  paymentStatus: "Status",
  upb: "UPB",
  estimatedValue: "Value",
  interestRate: "Rate",
  askingPrice: "Ask",
  monthsDelinquent: "Months",
  ...suggestMapping(["Loan #", "Servicer", "Pay History", "Next Due", "BK Chapter", "BK Filed Date", "FC Date", "Mod Date", "Modified", "Value Date", "Value Source", "Loan Purpose", "HOA Lien", "Taxes Delinquent"]),
} as const;

test("the import stores the servicing columns, reads yes and no, and leaves out what it can't read", () => {
  const { loans, errors } = normalizeTapeRows({
    rows: [
      {
        ...base,
        "Loan #": "00012-345",
        Servicer: "Shellpoint Mortgage Servicing",
        "Pay History": "CCCC3",
        "Next Due": "2026-07-01",
        "BK Chapter": "Ch 13",
        "BK Filed Date": "2026-02-10",
        "FC Date": "N/A",
        "Mod Date": "2021-05-01",
        "Value Date": "2026-08-15",
        "Value Source": "Exterior BPO",
        "Loan Purpose": "Cash-out refi",
        "HOA Lien": "Y",
        "Taxes Delinquent": "No",
        Status: "Sub-performing",
      },
      { ...base, "Pay History": "abc", "Value Source": "Zillow guess", "BK Chapter": "None", "Next Due": "soon", "HOA Lien": "None" },
    ],
    mapping,
    priceMode: "COLUMN",
  });
  assert.deepEqual(errors, []);
  const [first, second] = loans;
  assert.equal(first.loanNumber, "00012-345");
  assert.equal(first.servicerName, "Shellpoint Mortgage Servicing");
  assert.equal(first.payString, "00003");
  assert.equal(first.nextDueDate?.toISOString().slice(0, 10), "2026-07-01");
  assert.equal(first.bankruptcyChapter, "13");
  assert.equal(first.bankruptcyFiledAt?.toISOString().slice(0, 10), "2026-02-10");
  assert.equal(first.foreclosureFiledAt, undefined);
  // A modification date answers a blank modified column.
  assert.equal(first.modified, true);
  assert.equal(first.valueType, "BPO");
  assert.equal(first.valueAsOf?.toISOString().slice(0, 10), "2026-08-15");
  assert.equal(first.loanPurpose, "CASH_OUT");
  assert.equal(first.hoaLien, true);
  assert.equal(first.taxDelinquent, false);
  // Blank months delinquent reads the pay string's newest month.
  assert.equal(first.monthsDelinquent, 0);
  assert.equal(second.payString, undefined);
  assert.equal(second.valueType, undefined);
  assert.equal(second.bankruptcyChapter, undefined);
  assert.equal(second.nextDueDate, undefined);
  assert.equal(second.hoaLien, false);
  // An older tape without the columns imports as it did.
  const old = normalizeTapeRows({ rows: [base], mapping: { ...mapping, payString: undefined }, priceMode: "COLUMN" });
  assert.equal(old.loans[0].monthsDelinquent, 0);
  assert.equal(old.loans[0].payString, undefined);
});

test("a blank months delinquent is taken from the pay string", () => {
  const { loans } = normalizeTapeRows({ rows: [{ ...base, Status: "Non-performing", "Pay History": "321000" }], mapping, priceMode: "COLUMN" });
  assert.equal(loans[0].monthsDelinquent, 3);
});

test("the preview flags a pay string, next due date or filing date that doesn't fit", () => {
  const rows = [
    // 1: performing, but the pay string says three months behind.
    { ...base, "Pay History": "321000" },
    // 2: non-performing, but the newest month was paid.
    { ...base, Status: "Non-performing", Months: "0", "Pay History": "000000" },
    // 3: months delinquent disagrees with the pay string.
    { ...base, Status: "Sub-performing", Months: "0", "Pay History": "210000" },
    // 4: next due eight months ago on a loan called current.
    { ...base, Months: "0", "Next Due": "2026-03-01" },
    // 5: filing dates ahead of today, and a value over a year old.
    { ...base, "BK Chapter": "7", "BK Filed Date": "2027-01-10", "FC Date": "2027-02-01", "Value Date": "2025-06-01" },
    // 6: a clean record raises nothing.
    { ...base, Months: "1", "Pay History": "100000000000", "Next Due": "2026-10-01", "Value Date": "2026-06-01", "FC Date": "2026-04-01", Status: "Sub-performing" },
    // 7: an unreadable pay string and one that is tidied.
    { ...base, "Pay History": "late" },
    { ...base, "Pay History": "CCCC" },
  ];
  const flags = reviewTape(rows, mapping, NOW);
  const at = (row: number) => flags.filter((flag) => flag.row === row);
  assert.ok(at(2).some((flag) => flag.field === "payString" && /status is performing/.test(flag.message)));
  assert.ok(at(3).some((flag) => flag.field === "payString" && /non-performing/.test(flag.message)));
  assert.ok(at(4).some((flag) => flag.field === "payString" && /months delinquent says 0/.test(flag.message)));
  assert.ok(at(5).some((flag) => flag.field === "nextDueDate" && /about 8 months behind/.test(flag.message)));
  assert.ok(at(6).some((flag) => flag.field === "bankruptcyFiledAt" && flag.level === "warn"));
  assert.ok(at(6).some((flag) => flag.field === "foreclosureFiledAt" && flag.level === "warn"));
  assert.ok(at(6).some((flag) => flag.field === "valueAsOf" && /more than 12 months/.test(flag.message)));
  assert.deepEqual(at(7), []);
  assert.ok(at(8).some((flag) => flag.field === "payString" && flag.level === "warn"));
  assert.ok(at(9).some((flag) => flag.field === "payString" && flag.level === "fix"));
});

test("months past due counts whole months since the next due date", () => {
  assert.equal(monthsPastDue(new Date("2026-10-01T00:00:00Z"), NOW), 1);
  assert.equal(monthsPastDue(new Date("2026-11-01T00:00:00Z"), NOW), 0);
  assert.equal(monthsPastDue(new Date("2026-10-15T00:00:00Z"), NOW), 0);
  assert.equal(monthsPastDue(new Date("2027-01-01T00:00:00Z"), NOW), 0);
  assert.equal(monthsPastDue(new Date("2025-12-01T00:00:00Z"), NOW), 11);
});

test("the template's sample loans import with their servicing record and no warnings", () => {
  const rows = SAMPLE_TAPE_ROWS.map((row) => Object.fromEntries(TAPE_HEADERS.map((header, index) => [header, row[index] ?? ""])));
  const tapeMapping = suggestMapping(TAPE_HEADERS);
  const { loans, errors } = normalizeTapeRows({ rows, mapping: tapeMapping, priceMode: "COLUMN" });
  assert.deepEqual(errors, []);
  assert.equal(loans.length, 3);
  assert.equal(loans[1].payString, "999876543210");
  assert.equal(loans[1].loanPurpose, "CASH_OUT");
  assert.equal(loans[2].bankruptcyChapter, "13");
  const flags = reviewTape(rows, tapeMapping, NOW);
  assert.deepEqual(flags.filter((flag) => flag.level !== "fix"), []);
});

test("the note wizard's servicing record is optional and checked", () => {
  const note = { streetAddress: "1 Main St", city: "Tampa", state: "FL", zip: "33602", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", estimatedValue: "150000", lienPosition: "FIRST", upb: "100000", interestRate: "6", monthlyPi: "0", paymentStatus: "PERFORMING", monthsDelinquent: "0", askingPrice: "80000", foreclosureStatus: "NONE" };
  const bare = noteSchema.parse(note);
  assert.equal(bare.payString, null);
  assert.equal(bare.modified, null);
  assert.equal(bare.valueType, null);
  const blanks = noteSchema.parse({ ...note, payString: "", modified: "", valueType: "", bankruptcyFiledAt: "" });
  assert.equal(blanks.payString, null);
  assert.equal(blanks.bankruptcyFiledAt, null);
  const full = noteSchema.parse({ ...note, loanNumber: " 12345 ", payString: "CCCC3", modified: "true", hoaLien: "false", bankruptcyChapter: "13", valueType: "BPO", loanPurpose: "SELLER_FINANCED", valueAsOf: "2026-08-01" });
  assert.equal(full.loanNumber, "12345");
  assert.equal(full.payString, "00003");
  assert.equal(full.modified, true);
  assert.equal(full.hoaLien, false);
  assert.equal(full.loanPurpose, "SELLER_FINANCED");
  assert.match(noteSchema.safeParse({ ...note, payString: "late twice" }).error?.issues[0].message ?? "", /0 to 9 or X/);
  assert.match(noteSchema.safeParse({ ...note, bankruptcyFiledAt: "2099-01-01" }).error?.issues[0].message ?? "", /can't be in the future/);
  assert.equal(noteSchema.safeParse({ ...note, valueType: "ZILLOW" }).success, false);
  const draft = servicingDraft({ ...full, nextDueDate: null, modificationDate: null, lossMitigation: null, servicerName: null, bankruptcyFiledAt: null, foreclosureFiledAt: null, taxDelinquent: null });
  assert.equal(draft.payString, "00003");
  assert.equal(draft.modified, "true");
  assert.equal(draft.hoaLien, "false");
  assert.equal(draft.taxDelinquent, "");
  assert.equal(draft.valueAsOf, "2026-08-01");
});

test("duplicate keys survive formatting differences and ignore placeholders", () => {
  const a = duplicateKeys({ streetAddress: "123 Main Street, Apt #4", city: "Saint Petersburg", state: "fl", zip: "33701", upb: 100000, loanNumber: "00012-345", servicerName: "Shellpoint Mortgage Servicing LLC" });
  const b = duplicateKeys({ streetAddress: "123 MAIN ST UNIT 4", city: "St. Petersburg", state: "FL", zip: "33701-1234", upb: 100500, loanNumber: "12345", servicerName: "Shellpoint" });
  assert.equal(a.loan, b.loan);
  assert.equal(a.streetZip, b.streetZip);
  assert.equal(a.streetCity, b.streetCity);
  assert.notEqual(a.loan, null);
  // A loan number alone, without a servicer, can collide across servicers.
  assert.equal(duplicateKeys({ streetAddress: "1 A St", city: "Tampa", state: "FL", upb: 1, loanNumber: "12345" }).loan, null);
  const placeholder = duplicateKeys({ streetAddress: "Not provided on tape", city: "Tampa", state: "FL", zip: "33602", upb: 1 });
  assert.equal(placeholder.streetZip, null);
  assert.equal(placeholder.streetCity, null);
  assert.notEqual(
    duplicateKeys({ streetAddress: "10 Oak Ave", city: "Springfield", state: "IL", upb: 1 }).streetCity,
    duplicateKeys({ streetAddress: "10 Oak Ave", city: "Springfield", state: "MO", upb: 1 }).streetCity,
  );
});

test("duplicatesFor finds the same loan on other live listings and skips sold and withdrawn ones", async () => {
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const zip = String(10000 + (Number(tag.slice(-6)) % 89999));
  const seller = await prisma.user.create({
    data: { email: `tape-v2-${tag}@example.com`, name: `Tape v2 ${tag}`, role: "INSTITUTIONAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  const loan = (street: string, extra: Record<string, unknown> = {}) => ({
    streetAddress: street,
    city: `Dupeville ${tag}`,
    state: "FL",
    zip,
    propertyType: "SFR" as const,
    lienPosition: "FIRST" as const,
    upb: 100000,
    interestRate: 6,
    monthlyPi: 600,
    paymentStatus: "PERFORMING" as const,
    estimatedValue: 150000,
    askingPrice: 80000,
    ...extra,
  });
  const ids: string[] = [];
  try {
    const live = await prisma.listing.create({
      data: {
        kind: "POOL",
        sellerId: seller.id,
        status: "APPROVED",
        title: `Live ${tag}`,
        notes: {
          create: [
            loan(`1 ${tag} Loan Rd`, { city: `Elsewhere ${tag}`, zip: "00001", loanNumber: `LN-${tag}`, servicerName: "Acme Servicing LLC" }),
            loan(`2 ${tag} Zip Street`, { city: `Other name ${tag}` }),
            loan(`3 ${tag} City Avenue`, { zip: "00002", upb: 50000 }),
            loan(`4 ${tag} Sold Lane`, { tradeStatus: "SOLD" }),
            loan(`5 ${tag} Far Court`, { city: `Far ${tag}`, upb: 200000 }),
          ],
        },
      },
    });
    ids.push(live.id);
    const withdrawn = await prisma.listing.create({
      data: { kind: "SINGLE", sellerId: seller.id, status: "WITHDRAWN", title: `Withdrawn ${tag}`, notes: { create: [loan(`6 ${tag} Gone Way`)] } },
    });
    ids.push(withdrawn.id);
    const fresh = await prisma.listing.create({
      data: {
        kind: "POOL",
        sellerId: seller.id,
        status: "SUBMITTED",
        title: `Fresh ${tag}`,
        notes: {
          create: [
            loan(`9 ${tag} Other Rd`, { loanNumber: `ln-${tag}`, servicerName: "ACME SERVICING" }),
            loan(`2 ${tag} Zip St.`, { upb: 100900 }),
            loan(`3 ${tag} City Ave`, { zip: "00003", upb: 90000 }),
            loan(`4 ${tag} Sold Ln`),
            // Same street and ZIP but the balance is 10% off, in a different city: not the same loan.
            loan(`5 ${tag} Far Ct`, { city: `Near ${tag}`, upb: 180000 }),
            loan(`6 ${tag} Gone Way`, { city: `Gone ${tag}`, zip: "00004" }),
          ],
        },
      },
      include: { notes: true },
    });
    ids.push(fresh.id);
    const byStreet = new Map(fresh.notes.map((note) => [note.id, note.streetAddress]));
    const matches = (await duplicatesFor(fresh.id)).filter((match) => ids.includes(match.listing.id));
    const found = matches.map((match) => `${byStreet.get(match.noteId)?.split(" ")[0]}:${match.reason}`).sort();
    assert.deepEqual(found, ["2:STREET_ZIP_UPB", "3:STREET_CITY", "9:LOAN_NUMBER"]);
    for (const match of matches) {
      assert.equal(match.listing.id, live.id);
      assert.equal(match.listing.status, "APPROVED");
      assert.equal(match.seller.id, seller.id);
    }
    // The live listing sees the fresh one in turn, since a submitted listing counts too.
    const reverse = (await duplicatesFor(live.id)).filter((match) => ids.includes(match.listing.id));
    assert.equal(reverse.length, 3);
    assert.ok(reverse.every((match) => match.listing.id === fresh.id));
  } finally {
    await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
    await prisma.listing.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.delete({ where: { id: seller.id } }).catch(() => undefined);
  }
});
