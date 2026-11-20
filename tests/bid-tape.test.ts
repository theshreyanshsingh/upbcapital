import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  BID_TAPE_COLUMNS,
  bidTapeCsv,
  bidTapeMatrix,
  bidTapeNote,
  bidTapeTemplate,
  bidTapeView,
  bidTapeXlsx,
  partPoolRefusal,
  placeBidTape,
  pricesFromPreview,
  readBidTape,
  readUploadedTape,
  submittedBidTape,
  tapeDownloads,
  tapePreview,
  type BidTapeLoan,
} from "../lib/bid-tape";
import { ACK_MISSING, covenantView } from "../lib/covenants";
import { readLoanPrices } from "../lib/loan-prices";
import { prisma } from "../lib/prisma";
import { PAUSED_BIDS } from "../lib/provenance";
import { bidSummary } from "../lib/seller-decisions";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
// A state nothing seeded uses, so no buy box or standing bid reaches these listings.
const STATE = "QT";
const FHFA = "Serviced to FHFA requirements. The buyer selects the servicer and offers a loss mitigation waterfall before any foreclosure referral.";
const made = { users: [] as { id: string; email: string }[], listings: [] as string[] };

type Role = "BUYER" | "INDIVIDUAL_SELLER";

async function person(who: string, role: Role) {
  const user = await prisma.user.create({
    data: {
      email: `tape-${who}-${tag}@example.org`,
      name: `Tape ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      emailConfirmedAt: new Date(),
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
    } as never,
  });
  made.users.push(user);
  return user;
}

async function buyer(who: string) {
  const user = await person(who, "BUYER");
  await prisma.buyerProfile.create({
    data: { userId: user.id, status: "APPROVED", entityType: "LLC", entityName: `${who} Notes LLC ${tag}`, jurisdiction: "Delaware", homesControlled: 0, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY) },
  });
  return user;
}

const loan = (street: string, extra: Partial<Prisma.NoteCreateWithoutListingInput> = {}) => ({
  streetAddress: `${street} ${tag}`,
  city: "Tapeville",
  state: STATE,
  zip: "99782",
  propertyType: "SFR" as const,
  occupancy: "OWNER_OCCUPIED" as const,
  lienPosition: "FIRST" as const,
  upb: 150000,
  interestRate: 6.5,
  monthlyPi: 1000,
  paymentStatus: "PERFORMING" as const,
  monthsDelinquent: 0,
  askingPrice: 15000,
  estimatedValue: 220000,
  borrowerName: "Quincy Marlowe",
  ...extra,
});

async function listing(sellerId: string, notes: ReturnType<typeof loan>[]) {
  const row = await prisma.listing.create({
    data: {
      kind: notes.length > 1 ? "POOL" : "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      standingBidsNotifiedAt: new Date(),
      title: `Bid tape pool ${tag} ${made.listings.length + 1}`,
      summary: "A test listing.",
      notes: { create: notes as never },
    },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
  made.listings.push(row.id);
  return row;
}

// The confirm step's form, as the bid tape component posts it.
function confirmForm(listingId: string, prices: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("listingId", listingId);
  form.set("tapePrices", prices);
  form.set("tapeName", "my model.csv");
  for (const [name, value] of Object.entries(extra)) form.set(name, value);
  return form;
}

test.after(async () => {
  const userIds = made.users.map((user) => user.id);
  const ids = made.listings;
  const inquiries = (await prisma.inquiry.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((row) => row.id);
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiries } } });
  await prisma.deskThread.deleteMany({ where: { inquiryId: { in: inquiries } } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiries } } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...inquiries, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.users.map((user) => user.email) } }, { subject: { contains: tag } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Reading a tape, on plain figures

const LOANS: BidTapeLoan[] = [
  { ref: "ref-a", label: "Loan 1 · Akron, OH", loanNumber: "", city: "Akron", state: "OH", lien: "First", status: "Performing", upb: 100000, rate: 6, ask: 80000 },
  { ref: "ref-b", label: "Loan 2 · Dayton, OH", loanNumber: "", city: "Dayton", state: "OH", lien: "First", status: "Performing", upb: 50000, rate: 7, ask: 40000 },
  { ref: "ref-c", label: "Loan 3 · Toledo, OH", loanNumber: "", city: "Toledo", state: "OH", lien: "Second", status: "Performing", upb: 20000, rate: 9, ask: 15000 },
];

const csv = (text: string) => bidTapeMatrix(Buffer.from(text), "tape.csv");

test("a tape is matched by loan ref, reads $ and commas, and ignores the buyer's own columns, notes and totals", () => {
  const tape = [
    "My pricing run,,,",
    "",
    "Model yield,Loan ref,City,Bid price",
    `9.1%,ref-b,Dayton,"$45,000.50"`,
    `8.2%,ref-a,Akron," 81,250 "`,
    "7%,ref-c,Toledo,$22000",
    `,,Total,"$148,250.50"`,
  ].join("\n");
  assert.deepEqual(readBidTape(csv(tape), LOANS), { error: null, prices: { "ref-b": 45000.5, "ref-a": 81250, "ref-c": 22000 } });
  // The header is found wherever it sits, under any spelling that reads as the same words.
  assert.deepEqual(readBidTape(csv("loan_ref,BID PRICE\nref-a,1\nref-b,2\nref-c,3.456"), LOANS), { error: null, prices: { "ref-a": 1, "ref-b": 2, "ref-c": 3.46 } });
  // Without the two columns there is nothing to match.
  assert.match(readBidTape(csv("Loan,Bid price\nref-a,1"), LOANS).error ?? "", /no Loan ref column/);
  assert.match(readBidTape(csv("Loan ref,Price\nref-a,1"), LOANS).error ?? "", /no Bid price column/);
  assert.match(readBidTape(csv("Loan ref,Bid price\nref-a,\nref-b,\nref-c,"), LOANS).error ?? "", /no bid prices/);
});

test("unknown and duplicate refs, unreadable, negative, zero and oversized prices are refused by row", () => {
  const read = readBidTape(csv(["Loan ref,Bid price", "ref-a,100", "ref-a,200", "ref-z,300", "ref-b,-5", "ref-c,abc"].join("\n")), LOANS);
  assert.equal(read.error, "The tape has 4 problems. Fix them and upload the tape again.");
  assert.deepEqual(read.error !== null ? read.problems : [], [
    "Row 3: loan ref ref-a is also on row 2. Each loan goes on one row.",
    "Row 4: ref-z isn't a loan ref in this pool.",
    "Row 5: the bid price must be more than zero.",
    'Row 6: the bid price "abc" doesn\'t read as dollars.',
  ]);
  const zero = readBidTape(csv("Loan ref,Bid price\nref-a,0\nref-b,0.50\nref-c,\"$2,000,000,000\""), LOANS);
  assert.deepEqual(zero.error !== null ? zero.problems : [], [
    "Row 2: the bid price must be more than zero.",
    "Row 3: the bid price must be at least $1.",
    "Row 4: the bid price is over $1,000,000,000. Check the figure.",
  ]);
  // Accounting brackets are a negative, not a price.
  const bracketed = readBidTape(csv("Loan ref,Bid price\nref-a,(500)\nref-b,1\nref-c,1"), LOANS);
  assert.deepEqual(bracketed.error !== null ? bracketed.problems : [], ["Row 2: the bid price must be more than zero."]);
});

test("a tape with a blank leaves loans out, which this listing doesn't take, so it is refused with the reason", () => {
  const read = readBidTape(csv("Loan ref,Bid price\nref-a,100\nref-b,\nref-c,300"), LOANS);
  assert.equal(read.error, partPoolRefusal(1, 3));
  assert.match(read.error ?? "", /^1 of 3 loans has no bid price\. Part-pool bids aren't taken on this listing, so price every loan\./);
  assert.match(read.error ?? "", /take part of the pool at your prices/);
  // A loan left off the tape altogether is a blank too.
  assert.equal(readBidTape(csv("Loan ref,Bid price\nref-a,100"), LOANS).error, partPoolRefusal(2, 3));
  // The template says so before the buyer fills it in.
  assert.ok(bidTapeNote({ title: "Pool", pro: true, withheld: false }).some((line) => /part-pool bids aren't taken on this listing/.test(line)));
  // The confirm step's prices are held to the same rules, so an edited page can't place part of the pool.
  assert.equal(pricesFromPreview(JSON.stringify({ "ref-a": 100, "ref-c": 300 }), LOANS).error, partPoolRefusal(1, 3));
  assert.match(pricesFromPreview(JSON.stringify({ "ref-a": 100, "ref-b": 1, "ref-z": 1 }), LOANS).error ?? "", /Read the tape again/);
  assert.match(pricesFromPreview(JSON.stringify({ "ref-a": -1, "ref-b": 1, "ref-c": 1 }), LOANS).error ?? "", /more than zero/);
  assert.match(pricesFromPreview("not json", LOANS).error ?? "", /Read the tape again/);
  assert.deepEqual(pricesFromPreview(JSON.stringify({ "ref-a": 100, "ref-b": 200, "ref-c": 300 }), LOANS), { error: null, prices: { "ref-a": 100, "ref-b": 200, "ref-c": 300 } });
});

test("the preview totals the bid and its share of UPB, and flags loans priced above UPB without refusing them", () => {
  const preview = tapePreview({ "ref-a": 120000, "ref-b": 40000, "ref-c": 20000.5 }, LOANS, "tape.csv");
  assert.equal(preview.count, 3);
  assert.equal(preview.total, 180000.5);
  assert.equal(preview.upb, 170000);
  assert.equal(preview.pctOfUpb, 105.88);
  assert.equal(preview.over, 2);
  assert.deepEqual(preview.rows.map((row) => [row.label, row.over]), [["Loan 1 · Akron, OH", true], ["Loan 2 · Dayton, OH", false], ["Loan 3 · Toledo, OH", true]]);
  assert.deepEqual(JSON.parse(preview.prices), { "ref-a": 120000, "ref-b": 40000, "ref-c": 20000.5 });
  // Off Pro the balances are veiled, so the preview names no share of UPB and flags nothing against it.
  const veiled = tapePreview({ "ref-a": 120000, "ref-b": 40000, "ref-c": 20000.5 }, LOANS.map((row) => ({ ...row, upb: null, rate: null, ask: null })), "tape.csv");
  assert.deepEqual([veiled.upb, veiled.pctOfUpb, veiled.over, veiled.total], [null, null, 0, 180000.5]);
  assert.ok(bidTapeNote({ title: "Pool", pro: false, withheld: false }).some((line) => /show on Pro/.test(line)));
});

// ---------------------------------------------------------------------------------------------------------------
// The template, the bid and the copy, against the database

test("the template has a row per loan with the columns, the loan number only where the loan opens, and stable refs", async () => {
  const seller = await person("seller-t", "INDIVIDUAL_SELLER");
  const inRoom = await buyer("in-room");
  const outside = await buyer("outside");
  const pool = await listing(seller.id, [loan("1 Ledger Lane", { loanNumber: `LN-1-${tag}` }), loan("2 Ledger Lane", { loanNumber: `LN-2-${tag}`, upb: 90000 }), loan("3 Ledger Lane", { loanNumber: `LN-3-${tag}` })]);
  await prisma.ndaAcknowledgment.create({ data: { userId: inRoom.id, listingId: pool.id } });

  const opened = await bidTapeTemplate(inRoom, pool.id);
  const closed = await bidTapeTemplate(outside, pool.id);
  assert.equal(opened.error, null);
  assert.equal(closed.error, null);
  if (opened.error !== null || closed.error !== null) return;
  assert.deepEqual(Object.keys(opened.rows[0]), [...BID_TAPE_COLUMNS]);
  assert.deepEqual(opened.rows.map((row) => row["Loan ref"]), pool.notes.map((note) => note.id));
  assert.deepEqual(opened.rows.map((row) => row["Loan number"]), [`LN-1-${tag}`, `LN-2-${tag}`, `LN-3-${tag}`]);
  assert.deepEqual(opened.rows[1], { "Loan ref": pool.notes[1].id, "Loan number": `LN-2-${tag}`, City: "Tapeville", State: STATE, Lien: "First", "Payment status": "Performing", UPB: 90000, "Rate %": 6.5, Ask: 15000, "Bid price": null });
  // Outside the room the loan number is withheld, the note says why, and the refs are the same rows.
  assert.deepEqual(closed.rows.map((row) => row["Loan number"]), ["", "", ""]);
  assert.deepEqual(closed.rows.map((row) => row["Loan ref"]), opened.rows.map((row) => row["Loan ref"]));
  assert.ok(closed.lines.includes("Loan numbers show once the data room opens to you."));
  assert.ok(!opened.lines.includes("Loan numbers show once the data room opens to you."));
  // The same refs on the next download.
  const again = await bidTapeTemplate(outside, pool.id);
  assert.deepEqual(again.error === null ? again.rows.map((row) => row["Loan ref"]) : [], closed.rows.map((row) => row["Loan ref"]));

  // The CSV opens with the note, then the table, and reads back to the same rows. So does the workbook.
  const text = bidTapeCsv(closed);
  assert.ok(text.startsWith("UPB Capital bid tape\n"));
  assert.ok(text.includes(`\n${BID_TAPE_COLUMNS.join(",")}\n`));
  const fromCsv = csv(text);
  const fromXlsx = bidTapeMatrix(bidTapeXlsx(closed), "tape.xlsx");
  assert.deepEqual(fromXlsx[0], [...BID_TAPE_COLUMNS]);
  for (const matrix of [fromCsv, fromXlsx]) {
    const header = matrix.findIndex((row) => row[0] === "Loan ref");
    assert.deepEqual(matrix.slice(header + 1, header + 4).map((row) => row[0]), pool.notes.map((note) => note.id));
  }

  // Only a pool that can be bid whole has a template.
  const single = await listing(seller.id, [loan("9 Lone Road")]);
  assert.match((await bidTapeTemplate(inRoom, single.id)).error ?? "", /Bid tapes are for pools/);
  await prisma.note.update({ where: { id: pool.notes[2].id }, data: { tradeStatus: "IN_CONTRACT" } });
  assert.match((await bidTapeTemplate(inRoom, pool.id)).error ?? "", /can't be bid whole/);
  await prisma.note.update({ where: { id: pool.notes[2].id }, data: { tradeStatus: "AVAILABLE" } });
  assert.match((await bidTapeTemplate(seller, pool.id)).error ?? "", /approved buyers/);
});

test("a confirmed tape is placed through checkOffer: a paused listing and a missing covenants tick refuse it, and the seller's summary says it came by tape", async () => {
  const seller = await person("seller-b", "INDIVIDUAL_SELLER");
  const bidder = await buyer("bidder");
  const pool = await listing(seller.id, [loan("1 Covenant Court", { inheritedCovenants: FHFA }), loan("2 Covenant Court"), loan("3 Covenant Court")]);
  const hash = covenantView(pool, () => false).forBid(null)?.hash;
  assert.ok(hash);

  // The buyer fills the template in their own model and uploads it.
  const template = await bidTapeTemplate(bidder, pool.id);
  assert.equal(template.error, null);
  if (template.error !== null) return;
  const priced = [12000, 15500.5, 9000];
  const filled = template.rows.map((row, index) => ({ ...row, "Bid price": `$${priced[index].toLocaleString("en-US")}` as never }));
  const read = await readUploadedTape(bidder, pool.id, { bytes: Buffer.from(bidTapeCsv({ lines: template.lines, rows: filled })), filename: "my model.csv" });
  assert.equal(read.error, null);
  if (read.error !== null) return;
  assert.equal(read.preview.count, 3);
  assert.equal(read.preview.total, 36500.5);
  assert.equal(read.preview.fileName, "my_model.csv");

  // No tick on the covenants: refused by the bid's own check, and nothing is written.
  const unticked = await placeBidTape(bidder, confirmForm(pool.id, read.preview.prices));
  assert.equal(unticked.error, ACK_MISSING);
  // A paused listing takes no new bid, tape or not.
  await prisma.listing.update({ where: { id: pool.id }, data: { stalePausedAt: new Date() } });
  assert.equal((await placeBidTape(bidder, confirmForm(pool.id, read.preview.prices, { covenantsAck: hash! }))).error, PAUSED_BIDS);
  assert.equal((await readUploadedTape(bidder, pool.id, { bytes: Buffer.from("Loan ref,Bid price"), filename: "t.csv" })).error, PAUSED_BIDS);
  await prisma.listing.update({ where: { id: pool.id }, data: { stalePausedAt: null } });
  // Prices edited on the page after the preview are held to the tape's rules again.
  const edited = JSON.stringify({ [pool.notes[0].id]: 12000, [pool.notes[1].id]: 15500.5 });
  assert.equal((await placeBidTape(bidder, confirmForm(pool.id, edited, { covenantsAck: hash! }))).error, partPoolRefusal(1, 3));
  assert.equal(await prisma.inquiry.count({ where: { listingId: pool.id } }), 0);

  // With the tick it is a whole-pool bid with the tape's loan prices, at their total.
  const placed = await placeBidTape(bidder, confirmForm(pool.id, read.preview.prices, { covenantsAck: hash!, allowPartial: "yes", message: "Priced in our model." }));
  assert.equal(placed.error, null);
  assert.ok(placed.inquiryId);
  const row = await prisma.inquiry.findUniqueOrThrow({ where: { id: placed.inquiryId! } });
  assert.equal(row.type, "OFFER");
  assert.equal(row.noteId, null);
  assert.equal(row.amount, 36500.5);
  assert.equal(row.allowPartial, true);
  assert.equal(row.message, "Priced in our model.");
  assert.ok(row.covenantsAcknowledgedAt);
  assert.deepEqual(readLoanPrices(row.loanPrices), Object.fromEntries(pool.notes.map((note, index) => [note.id, priced[index]])));
  const logged = await prisma.auditEvent.findFirst({ where: { entityId: row.id, action: "BID_TAPE" } });
  assert.equal(logged?.detail, "Bid by tape, 3 loans · my_model.csv");

  // The seller's bid summary notes the tape and the loan count, beside the loan prices it already shows.
  const summary = await bidSummary(pool.id, { id: seller.id, role: seller.role });
  assert.equal(summary.status, 200);
  if (summary.status !== 200) return;
  assert.equal(summary.rows[0].scope, "Whole listing · Bid by tape, 3 loans");
  assert.match(summary.rows[0].loan_prices, /^Loan 1 12000\.00; Loan 2 15500\.50; Loan 3 9000\.00$/);
});

test("a placed bid downloads back as a filled tape that reads to the same prices, for its buyer only", async () => {
  const seller = await person("seller-r", "INDIVIDUAL_SELLER");
  const bidder = await buyer("round-trip");
  const other = await buyer("other");
  const pool = await listing(seller.id, [loan("1 Return Row", { loanNumber: `RT-1-${tag}` }), loan("2 Return Row", { loanNumber: `RT-2-${tag}` })]);
  await prisma.ndaAcknowledgment.create({ data: { userId: bidder.id, listingId: pool.id } });
  const prices = { [pool.notes[0].id]: 20000.25, [pool.notes[1].id]: 18000 };
  const placed = await placeBidTape(bidder, confirmForm(pool.id, JSON.stringify(prices)));
  assert.equal(placed.error, null);
  const inquiryId = placed.inquiryId!;

  const copy = await submittedBidTape(bidder, pool.id, inquiryId);
  assert.equal(copy.error, null);
  if (copy.error !== null) return;
  assert.match(copy.lines[0], /^Your bid on .* as placed .*: 2 loans, \$38,000\.25 in all\. This copy isn't a bid\./);
  assert.deepEqual(copy.rows.map((row) => [row["Loan number"], row["Bid price"]]), [[`RT-1-${tag}`, 20000.25], [`RT-2-${tag}`, 18000]]);

  // Uploaded again, the copy reads to the prices the bid carries, from the CSV and from the workbook alike.
  const view = await bidTapeView(bidder, pool.id);
  assert.equal(view.error, null);
  if (view.error !== null) return;
  assert.deepEqual(readBidTape(csv(bidTapeCsv(copy)), view.loans), { error: null, prices });
  assert.deepEqual(readBidTape(bidTapeMatrix(bidTapeXlsx(copy), "copy.xlsx"), view.loans), { error: null, prices });

  // The listing page and the offers page link it; nobody else gets it.
  const mine = await prisma.inquiry.findMany({ where: { listingId: pool.id, buyerId: bidder.id } });
  assert.deepEqual(tapeDownloads(mine), [{ id: inquiryId, label: "Your $38,000 bid as a tape" }]);
  assert.deepEqual(await submittedBidTape(other, pool.id, inquiryId), { error: "Not found.", status: 404 });
  assert.deepEqual(await submittedBidTape(bidder, made.listings[0], inquiryId), { error: "Not found.", status: 404 });
});
