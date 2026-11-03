import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { borrowerNotices, loanScope, loansInScope, looksLikeCompany, saleNoticeNeedsReminder, transferDate } from "../lib/borrower-notices";
import { buildSaleNoticePdf, wrap } from "../lib/sale-notice";
import { closingLoans } from "../lib/closing";
import { buildClosingPdf } from "../lib/closing-docs";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const day = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;

test("the sale notice is due 30 calendar days after transfer, as in the CFPB's own example", () => {
  const plan = borrowerNotices({ status: "COMPLETE", closedAt: at("2026-03-15") }, null, 1, at("2026-03-20"));
  assert.equal(day(plan.transfer), "2026-03-15");
  assert.equal(day(plan.sale.due), "2026-04-14");
  assert.equal(plan.sale.state, "upcoming");
  // A recorded transfer date wins over the close, and an open file has no clock yet.
  assert.equal(day(transferDate({ status: "COMPLETE", closedAt: at("2026-03-15"), transferAt: at("2026-03-10") })), "2026-03-10");
  assert.equal(borrowerNotices({ status: "OPEN", closedAt: null }, null, 1, at("2026-03-20")).sale.state, "waiting");
  assert.equal(borrowerNotices({ status: "COMPLETE", closedAt: at("2026-03-15") }, null, 0).sale.state, "not_needed");
  assert.equal(borrowerNotices({ status: "COMPLETE", closedAt: at("2026-03-15"), ownerNoticeSentAt: at("2026-04-01") }, null, 1).sale.state, "sent");
});

test("servicer letters fall 15 days either side of the transfer, and payments are protected for 60 days", () => {
  const plan = borrowerNotices({ status: "COMPLETE", closedAt: at("2026-11-02") }, { boardedAt: at("2026-12-01") }, 1, at("2026-11-10"));
  assert.equal(day(plan.goodbye.due), "2026-11-16");
  assert.equal(day(plan.hello.due), "2026-12-16");
  // Day 1 is the effective date, so the 60th day is 29 January.
  assert.equal(day(plan.graceThrough), "2027-01-29");
  assert.equal(plan.goodbye.state, "upcoming");
  assert.equal(borrowerNotices({ status: "COMPLETE", closedAt: null }, { boardedAt: at("2026-12-01") }, 1, at("2026-11-13")).goodbye.state, "due_soon");
  assert.equal(borrowerNotices({ status: "COMPLETE", closedAt: null }, null, 1).goodbye.state, "waiting");
});

test("rentals and company borrowers fall outside Reg Z; owner-occupied and estate-planning trusts don't", () => {
  assert.equal(loanScope({ occupancy: "OWNER_OCCUPIED", borrowerName: "Dana Ruiz" }).inScope, true);
  assert.equal(loanScope({ occupancy: "TENANT", borrowerName: "Dana Ruiz" }).inScope, false);
  assert.equal(loanScope({ occupancy: "OWNER_OCCUPIED", borrowerName: "Coastal Rentals LLC" }).inScope, false);
  assert.equal(loanScope({ occupancy: "UNKNOWN", borrowerName: "Ruiz Family Trust" }).inScope, true);
  for (const name of ["Acme Co.", "Bay Holdings, Inc.", "Gulf Corporation", "Keys L.L.C."]) assert.equal(looksLikeCompany(name), true, name);
  for (const name of ["Marco Diaz", "Ruiz Family Trust", "Inca Lopez", ""]) assert.equal(looksLikeCompany(name), false, name);
  const notes = [{ occupancy: "OWNER_OCCUPIED", borrowerName: "A" }, { occupancy: "TENANT", borrowerName: "B" }];
  assert.equal(loansInScope(notes, null).length, 1);
  assert.equal(loansInScope(notes, "CONSUMER").length, 2);
  assert.equal(loansInScope(notes, "BUSINESS").length, 0);
});

test("the sale notice reminder goes five days out and once more when late", () => {
  const due = at("2026-04-14");
  assert.equal(saleNoticeNeedsReminder(due, null, null, at("2026-04-01")), false);
  assert.equal(saleNoticeNeedsReminder(due, null, null, at("2026-04-10")), true);
  assert.equal(saleNoticeNeedsReminder(due, null, at("2026-04-10"), at("2026-04-12")), false);
  assert.equal(saleNoticeNeedsReminder(due, null, at("2026-04-10"), at("2026-04-16")), true);
  assert.equal(saleNoticeNeedsReminder(due, null, at("2026-04-16"), at("2026-04-20")), false);
  assert.equal(saleNoticeNeedsReminder(due, at("2026-04-12"), null, at("2026-04-16")), false);
});

test("the draft notice has a page per loan and leaves blanks for what the owner must supply", async () => {
  const bytes = await buildSaleNoticePdf({
    owner: "Fund One LLC",
    ownerContact: "",
    transfer: at("2026-03-15"),
    agent: "",
    recording: "The transfer of ownership has not yet been recorded in the public records.",
    policy: "HOLD",
    loans: [
      { streetAddress: "9 Hidden Ln", city: "Tampa", state: "FL", zip: "33601", borrowerName: "Dana Ruiz", loanNumber: "" },
      { streetAddress: "1 Bay Rd", city: "Miami", state: "FL", zip: "33101", borrowerName: "Lee Wong", loanNumber: "778" },
    ],
  });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), "%PDF-");
});

test("typed line breaks stay line breaks in the notice, and long lines wrap", async () => {
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  assert.deepEqual(wrap("Fund One LLC\r\n200 Bay St\n(904) 555-0100", font, 10, 500), ["Fund One LLC", "200 Bay St", "(904) 555-0100"]);
  assert.ok(wrap("word ".repeat(80), font, 10, 200).length > 5);
});

test("a closing covers its one loan, or every loan for a whole-listing sale", () => {
  const notes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(closingLoans({ noteId: "b" }, notes), [{ id: "b" }]);
  assert.equal(closingLoans({ noteId: null }, notes).length, 3);
});

test("closing paper gives each loan its own page and carries long text onto more pages", async () => {
  const fields = [{ name: "buyer", value: "Fund" }, { name: "price", value: "$1" }];
  const perLoan = await PDFDocument.load(await buildClosingPdf({ title: "Allonge", pages: ["Loan one", "Loan two", "Loan three"], fields }));
  assert.equal(perLoan.getPageCount(), 3);
  assert.deepEqual(perLoan.getForm().getFields().map((field) => field.getName()).sort(), ["buyer", "buyer_2", "buyer_3", "price", "price_2", "price_3"]);
  const schedule = Array.from({ length: 60 }, (_, index) => `${index + 1}. 9 Hidden Ln, Tampa, FL. Unpaid principal $100,000.`).join("\n");
  const long = await PDFDocument.load(await buildClosingPdf({ title: "Purchase and sale agreement", body: `Terms.\n\nLoan schedule\n${schedule}`, fields }));
  assert.ok(long.getPageCount() >= 2);
  assert.equal(long.getForm().getFields().length, 2);
});
