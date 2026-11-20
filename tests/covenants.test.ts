import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { pdfText } from "../lib/ai-reading";
import { closingPacket } from "../lib/closing-packet";
import {
  ACK_CHANGED,
  ACK_MISSING,
  ACK_WITHHELD,
  SEAT_ACK_STALE,
  acknowledgeAgain,
  bidCovenantStanding,
  closingCovenants,
  covenantAwardBlock,
  covenantCheck,
  covenantsOwed,
  covenantView,
  listingCovenants,
  namesBorrower,
  recordCovenantAck,
  seatCovenantCheck,
  summarizeCovenant,
  syncGroupCovenants,
} from "../lib/covenants";
import { checkOffer, writeInquiry } from "../lib/inquiry";
import { prisma } from "../lib/prisma";
import { saleFile, sellerSaleFile } from "../lib/sale-file";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
// A state nothing seeded uses, so no buy box or standing bid reaches these listings.
const STATE = "QK";
const FHFA = "Serviced to FHFA requirements. The buyer selects the servicer and offers a loss mitigation waterfall before any foreclosure referral.";
const made = { users: [] as { id: string; email: string }[], listings: [] as string[] };

type Role = "BUYER" | "ADMIN" | "INDIVIDUAL_SELLER";

async function person(who: string, role: Role, data: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `cov-${who}-${tag}@example.org`,
      name: `Cov ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...data,
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
  city: "Covenant City",
  state: STATE,
  zip: "99781",
  propertyType: "SFR" as const,
  occupancy: "OWNER_OCCUPIED" as const,
  lienPosition: "FIRST" as const,
  upb: 150000,
  interestRate: 6.5,
  monthlyPi: 1000,
  paymentStatus: "PERFORMING" as const,
  monthsDelinquent: 0,
  askingPrice: 50000,
  estimatedValue: 220000,
  borrowerName: `Quincy Marlowe`,
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
      title: `Covenant tape ${tag} ${made.listings.length + 1}`,
      summary: "A test listing.",
      notes: { create: notes as never },
    },
    include: { notes: { orderBy: { createdAt: "asc" } } },
  });
  made.listings.push(row.id);
  return row;
}

const readListing = (id: string) => prisma.listing.findUniqueOrThrow({ where: { id }, include: { seller: true } });

// A bid through the checks the bid form runs, written as the form writes it.
async function bid(user: Awaited<ReturnType<typeof buyer>>, listingId: string, covenantsAck: string | null, noteId = "", now = new Date()) {
  const row = await readListing(listingId);
  const check = await checkOffer({ user, listing: row, noteId, amount: 45000, goodUntil: "", covenantsAck, now });
  if (check.error !== null) return { error: check.error, inquiry: null };
  const inquiry = await writeInquiry({ user, listing: row, type: "OFFER", noteId, amount: 45000, message: "", expiresAt: check.expiresAt, covenants: check.covenants });
  return { error: null, inquiry, check };
}

async function closingOn(listingId: string, inquiryId: string | null, extra: Partial<Prisma.ClosingUncheckedCreateInput> = {}) {
  return prisma.closing.create({
    data: { listingId, inquiryId, salePrice: 45000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 4500000, netToSellerCents: 4500000, ...extra },
  });
}

test.after(async () => {
  const userIds = made.users.map((user) => user.id);
  const ids = made.listings;
  const inquiries = (await prisma.inquiry.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((row) => row.id);
  const groups = (await prisma.groupBuy.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((row) => row.id);
  const closings = (await prisma.closing.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((row) => row.id);
  await prisma.closing.deleteMany({ where: { id: { in: closings } } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiries } } });
  await prisma.groupPosition.deleteMany({ where: { groupId: { in: groups } } });
  await prisma.groupBuy.deleteMany({ where: { id: { in: groups } } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiries } } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...inquiries, ...groups, ...closings, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { toEmail: { in: made.users.map((user) => user.email) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------

test("listingCovenants trims each loan's covenants, drops empty ones and sums them up", () => {
  const verified = { inheritedCovenants: { at: "2026-11-02T12:00:00.000Z", by: "desk", source: "Other", value: "Occupancy covenant: rent only to owner-occupants for three years." } };
  const notes = [
    { id: "a", inheritedCovenants: `  ${FHFA}\n` },
    { id: "b", inheritedCovenants: "" },
    { id: "c", inheritedCovenants: null },
    { id: "d", inheritedCovenants: "N/A" },
    { id: "e", inheritedCovenants: "Occupancy covenant: rent only to owner-occupants for three years.", verifiedFields: verified },
  ];
  const all = listingCovenants({ notes });
  assert.deepEqual(all.loans.map((row) => [row.noteId, row.position, row.verified]), [["a", 1, false], ["e", 5, true]]);
  assert.equal(all.loans[0].text, FHFA);
  assert.equal(all.total, 5);
  assert.equal(all.summary, "2 of 5 loans carry covenants that pass to the buyer.");
  assert.equal(listingCovenants({ notes }, ["e", "b"]).summary, "1 of 2 loans carries covenants that pass to the buyer.");
  assert.equal(listingCovenants({ notes: [notes[0]] }).summary, "This loan carries covenants that pass to the buyer.");
  assert.equal(listingCovenants({ notes: [notes[1], notes[2]] }).summary, null);
  assert.equal(listingCovenants({ notes: [notes[1]] }).hash, null);

  // The version changes with the text, not with whitespace around it.
  assert.equal(listingCovenants({ notes: [{ id: "a", inheritedCovenants: FHFA }] }).hash, listingCovenants({ notes: [notes[0]] }).hash);
  assert.notEqual(listingCovenants({ notes: [{ id: "a", inheritedCovenants: `${FHFA} Amended.` }] }).hash, listingCovenants({ notes: [notes[0]] }).hash);

  // Long text shows as a summary away from the bid form.
  const short = summarizeCovenant(FHFA, 60);
  assert.ok(short.length <= 61 && short.endsWith("…"));
  assert.equal(summarizeCovenant("Serviced to FHFA requirements."), "Serviced to FHFA requirements.");

  // A text carrying the borrower's name, the street or the loan number follows the street's rule.
  const note = { borrowerName: "Quincy Marlowe", streetAddress: "12 Bay St", loanNumber: "LN-77310" };
  assert.equal(namesBorrower(FHFA, note), false);
  assert.equal(namesBorrower("Marlowe loan: modification agreed in 2024.", note), true);
  assert.equal(namesBorrower("The house at 12 Bay Street stays owner-occupied.", note), true);
  assert.equal(namesBorrower("Loan LN 77310 carries a partial claim.", note), true);
  assert.equal(namesBorrower("Bay windows are not covered.", note), false);
});

test("a bid on loans with covenants needs the tick, on the text shown, and records it", async () => {
  const seller = await person("seller-a", "INDIVIDUAL_SELLER");
  const buyerA = await buyer("buyer-a");
  const pool = await listing(seller.id, [loan("1 Waterfall Way", { inheritedCovenants: FHFA }), loan("2 Waterfall Way"), loan("3 Waterfall Way")]);
  const [withCovenants, plain] = pool.notes;
  const view = covenantView(pool, () => false);
  const whole = view.forBid(null);
  assert.ok(whole?.hash);
  assert.equal(whole.summary, "1 of 3 loans carries covenants that pass to the buyer.");
  assert.deepEqual(whole.loans.map((row) => [row.label, row.text]), [[`Loan 1 · Covenant City, ${STATE}`, FHFA]]);

  // No tick, or a tick on an older text, is refused with the reason.
  assert.equal((await bid(buyerA, pool.id, null)).error, ACK_MISSING);
  assert.equal((await bid(buyerA, pool.id, "0123456789abcdef")).error, ACK_CHANGED);

  // The tick on the text shown places the bid and dates the acknowledgement on it.
  const now = new Date();
  const placed = await bid(buyerA, pool.id, whole.hash, "", now);
  assert.equal(placed.error, null);
  const row = await prisma.inquiry.findUniqueOrThrow({ where: { id: placed.inquiry!.id } });
  assert.equal(row.covenantsAcknowledgedAt?.toISOString(), now.toISOString());
  const logged = await prisma.auditEvent.findFirst({ where: { entityId: row.id, action: "COVENANTS_ACK" } });
  assert.equal(logged?.detail, `${whole.hash} · 1 loan with covenants`);
  assert.deepEqual(await bidCovenantStanding(row), { acknowledgedAt: now, current: true });
  assert.equal(await covenantAwardBlock(row.id), null);

  // A bid on a loan that carries none needs no tick, and its form shows none.
  assert.equal(view.forBid(plain.id), null);
  const loanBid = await bid(buyerA, pool.id, null, plain.id);
  assert.equal(loanBid.error, null);
  assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: loanBid.inquiry!.id } })).covenantsAcknowledgedAt, null);
  assert.equal(await bidCovenantStanding(loanBid.inquiry!), null);
  // A bid on the loan that carries them needs it.
  assert.equal((await bid(buyerA, pool.id, "", withCovenants.id)).error, ACK_MISSING);
});

test("a listing with no covenants asks for no tick", async () => {
  const seller = await person("seller-b", "INDIVIDUAL_SELLER");
  const buyerB = await buyer("buyer-b");
  const single = await listing(seller.id, [loan("9 Plain Road", { inheritedCovenants: "  " })]);
  assert.equal(covenantView(single, () => true).forBid(null), null);
  assert.equal(covenantView(single, () => true).summary, null);
  const placed = await bid(buyerB, single.id, null);
  assert.equal(placed.error, null);
  assert.equal(placed.check?.covenants, null);
  assert.deepEqual(await covenantCheck({ userId: buyerB.id, listingId: single.id, ack: "" }), { error: null, ack: null });
});

test("a change to the covenants after the acknowledgement asks again; a counter doesn't", async () => {
  const seller = await person("seller-c", "INDIVIDUAL_SELLER");
  const buyerC = await buyer("buyer-c");
  const single = await listing(seller.id, [loan("4 Timeline Court", { inheritedCovenants: FHFA })]);
  const first = covenantView(single, () => false).forBid(null)!;
  const placed = await bid(buyerC, single.id, first.hash);
  assert.equal(placed.error, null);
  const inquiry = placed.inquiry!;

  // A seller's counter moves the price, not the covenants.
  await prisma.offerMessage.create({ data: { inquiryId: inquiry.id, authorId: seller.id, kind: "COUNTER", amount: 48000, body: "Counter at $48,000." } });
  assert.equal((await bidCovenantStanding(await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } })))?.current, true);
  assert.deepEqual(await covenantsOwed(buyerC.id, single.id), { bids: [], groups: [] });

  // The desk fixes the text to a document on the live listing.
  await prisma.note.update({ where: { id: single.notes[0].id }, data: { inheritedCovenants: `${FHFA} Foreclosure may not be referred before 120 days delinquent.` } });
  const stale = await bidCovenantStanding(await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } }));
  assert.equal(stale?.current, false);
  assert.ok(stale?.acknowledgedAt);
  assert.match((await covenantAwardBlock(inquiry.id)) ?? "", /changed after the buyer acknowledged them/);
  const owed = await covenantsOwed(buyerC.id, single.id);
  assert.deepEqual(owed.bids.map((row) => row.id), [inquiry.id]);

  // A new bid on the old text is refused, and so is acknowledging the old text again.
  assert.equal((await bid(buyerC, single.id, first.hash)).error, ACK_CHANGED);
  assert.deepEqual(await acknowledgeAgain(buyerC, single.id, first.hash), { error: ACK_CHANGED });
  const second = covenantView(await prisma.listing.findUniqueOrThrow({ where: { id: single.id }, include: { notes: true } }), () => false).forBid(null)!;
  assert.notEqual(second.hash, first.hash);
  const later = new Date(Date.now() + 1000);
  assert.deepEqual(await acknowledgeAgain(buyerC, single.id, second.hash, later), { error: null, count: 1 });
  const renewed = await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
  assert.equal(renewed.covenantsAcknowledgedAt?.toISOString(), later.toISOString());
  assert.equal((await bidCovenantStanding(renewed))?.current, true);
  assert.equal(await covenantAwardBlock(inquiry.id), null);
  assert.deepEqual(await covenantsOwed(buyerC.id, single.id), { bids: [], groups: [] });
});

test("a text that names the borrower waits for the room, and a bid waits with it", async () => {
  const seller = await person("seller-d", "INDIVIDUAL_SELLER");
  const buyerD = await buyer("buyer-d");
  const single = await listing(seller.id, [loan("6 Private Lane", { inheritedCovenants: "Marlowe loan: the 2024 modification terms bind any later holder." })]);
  const outside = covenantView(single, () => false);
  assert.deepEqual([...outside.withheld], [single.notes[0].id]);
  assert.equal(outside.rows[0].text, null);
  // Nobody acknowledges what they can't read, so the form carries no version to tick.
  assert.equal(outside.forBid(null)?.hash, null);
  const inside = covenantView(single, () => true);
  assert.equal(inside.withheld.size, 0);
  assert.match(inside.rows[0].label, /6 Private Lane/);
  const hash = inside.forBid(null)!.hash!;

  assert.equal((await bid(buyerD, single.id, hash)).error, ACK_WITHHELD);
  await prisma.ndaAcknowledgment.create({ data: { userId: buyerD.id, listingId: single.id, signerName: "Cov Buyer D" } });
  assert.equal((await bid(buyerD, single.id, hash)).error, null);
});

test("a group seat is refused without the tick, and the group's offer carries it once every seat gave it", async () => {
  const seller = await person("seller-e", "INDIVIDUAL_SELLER");
  const lead = await buyer("lead-e");
  const second = await buyer("second-e");
  const single = await listing(seller.id, [loan("8 Group Street", { inheritedCovenants: FHFA })]);
  const hash = covenantView(single, () => false).forBid(null)!.hash!;

  // Opening or joining without the tick, or on an older text, is refused with the reason.
  assert.deepEqual(await seatCovenantCheck({ userId: lead.id, listingId: single.id, noteId: null, ack: "" }), { error: ACK_MISSING });
  assert.deepEqual(await seatCovenantCheck({ userId: lead.id, listingId: single.id, noteId: null, ack: "ffffffffffffffff" }), { error: ACK_CHANGED });
  const leadAck = await seatCovenantCheck({ userId: lead.id, listingId: single.id, noteId: null, ack: hash });
  assert.equal(leadAck.error, null);

  const group = await prisma.groupBuy.create({ data: { listingId: single.id, openedById: lead.id, minPosition: 10000, deadline: new Date(Date.now() + 7 * DAY), targetAmount: 45000 } });
  await prisma.groupPosition.create({ data: { groupId: group.id, userId: lead.id, seat: 1, amount: 25000, percent: 55.56 } });
  await prisma.groupPosition.create({ data: { groupId: group.id, userId: second.id, seat: 2, amount: 20000, percent: 44.44 } });
  await recordCovenantAck(lead.id, "group", group.id, leadAck.ack!);
  const offer = await prisma.inquiry.create({ data: { listingId: single.id, buyerId: lead.id, type: "OFFER", amount: 45000, message: "Group offer." } });
  await prisma.groupBuy.update({ where: { id: group.id }, data: { inquiryId: offer.id } });

  // One seat hasn't ticked, so the offer carries no acknowledgement and can't be awarded on it.
  assert.equal(await syncGroupCovenants(group.id), false);
  assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: offer.id } })).covenantsAcknowledgedAt, null);
  assert.match((await covenantAwardBlock(offer.id)) ?? "", /hasn't acknowledged/);

  const secondAck = await seatCovenantCheck({ userId: second.id, listingId: single.id, noteId: null, groupId: group.id, ack: hash });
  assert.equal(secondAck.error, null);
  await recordCovenantAck(second.id, "group", group.id, secondAck.ack!);
  assert.equal(await syncGroupCovenants(group.id), true);
  assert.ok((await prisma.inquiry.findUniqueOrThrow({ where: { id: offer.id } })).covenantsAcknowledgedAt);
  assert.equal(await covenantAwardBlock(offer.id), null);

  // Reconfirming a counter asks nothing while the text stands, and asks again once it changed.
  assert.deepEqual(await seatCovenantCheck({ userId: second.id, listingId: single.id, noteId: null, groupId: group.id, reconfirm: true }), { error: null, ack: null });
  await prisma.note.update({ where: { id: single.notes[0].id }, data: { inheritedCovenants: `${FHFA} Amended.` } });
  assert.deepEqual(await seatCovenantCheck({ userId: second.id, listingId: single.id, noteId: null, groupId: group.id, reconfirm: true }), { error: SEAT_ACK_STALE });
  assert.deepEqual((await covenantsOwed(second.id, single.id)).groups.map((row) => row.id), [group.id]);
});

test("the purchase agreement carries the covenant schedule with the loans and the date, and the sale files say so", async () => {
  const seller = await person("seller-f", "INDIVIDUAL_SELLER", { companyName: `Seller Bank ${tag}` });
  const buyerF = await buyer("buyer-f");
  const desk = await person("desk-f", "ADMIN", { deskRole: "CLOSINGS" });
  const pool = await listing(seller.id, [loan("10 Schedule Row", { inheritedCovenants: FHFA }), loan("11 Schedule Row"), loan("12 Schedule Row", { inheritedCovenants: "Occupancy: market any REO to owner-occupants first." })]);
  const hash = covenantView(pool, () => false).forBid(null)!.hash!;
  const now = new Date();
  const placed = await bid(buyerF, pool.id, hash, "", now);
  assert.equal(placed.error, null);
  await prisma.inquiry.update({ where: { id: placed.inquiry!.id }, data: { status: "ACCEPTED" } });
  await prisma.listing.update({ where: { id: pool.id }, data: { status: "PENDING" } });
  const closing = await closingOn(pool.id, placed.inquiry!.id);
  const day = now.toISOString().slice(0, 10);

  const read = async (closingId: string) => {
    const packet = await closingPacket(closingId, "PSA", { id: seller.id, role: seller.role });
    if (!packet || !packet.allowed) throw new Error("PSA refused");
    return pdfText(packet.pdf).replace(/\s+/g, " ");
  };
  const text = await read(closing.id);
  assert.match(text, /Schedule: Covenants that pass to the buyer/);
  assert.match(text, /Desk draft pending counsel review\. Each loan below carries servicing covenants/);
  assert.match(text, new RegExp(`1\\. Loan 1 on the loan schedule, 10 Schedule Row ${tag}, Covenant City, ${STATE} 99781\\. Seller-stated: Serviced to FHFA requirements`));
  assert.match(text, new RegExp(`2\\. Loan 3 on the loan schedule, 12 Schedule Row ${tag}`));
  assert.doesNotMatch(text, new RegExp(`Loan 2 on the loan schedule`));
  assert.match(text, new RegExp(`The buyer acknowledged these covenants on ${day}, before bidding`));
  // Only the purchase agreement carries it.
  const assignment = await closingPacket(closing.id, "ASSIGNMENT", { id: seller.id, role: seller.role });
  assert.ok(assignment?.allowed);
  if (assignment?.allowed) assert.doesNotMatch(pdfText(assignment.pdf), /Covenants that pass/);

  // The closing page's line reads the same standing.
  const found = await closingCovenants(closing);
  assert.equal(found?.covenants.summary, "2 of 3 loans carry covenants that pass to the buyer.");
  assert.equal(found?.standing?.current, true);

  // The desk's sale file and the seller's copy both say the covenants were acknowledged, and when.
  const deskFile = await saleFile(pool.id, desk);
  const deskRow = deskFile?.rows.find((row) => row.section === "Covenants");
  assert.equal(deskRow?.status, "Acknowledged");
  assert.equal(deskRow?.at?.toISOString(), now.toISOString());
  assert.match(deskRow?.detail ?? "", /2 of 3 loans carry covenants that pass to the buyer\. The buyer acknowledged these covenants on/);
  const sellerFile = await sellerSaleFile(pool.id, seller);
  assert.equal(sellerFile.status, 200);
  if (sellerFile.status === 200) {
    const sellerRow = sellerFile.file.rows.find((row) => row.section === "Covenants");
    assert.equal(sellerRow?.status, "Acknowledged");
    assert.equal(sellerRow?.at?.toISOString(), now.toISOString());
  }

  // A sale with no covenants has no schedule and no line.
  const plain = await listing(seller.id, [loan("13 Plain Row")]);
  const plainBid = await prisma.inquiry.create({ data: { listingId: plain.id, buyerId: buyerF.id, type: "OFFER", status: "ACCEPTED", amount: 45000 } });
  const plainClosing = await closingOn(plain.id, plainBid.id);
  assert.doesNotMatch(await read(plainClosing.id), /Covenants that pass to the buyer/);
  assert.equal(await closingCovenants(plainClosing), null);
  assert.equal((await saleFile(plain.id, desk))?.rows.some((row) => row.section === "Covenants"), false);
});

test("the exports hold back a covenant that names the borrower until the loan opens, by the listing page's rule", async () => {
  const { COVENANT_IDENTITY_FIELDS, closedCovenant } = await import("../lib/covenant-text");
  const { loanFileIdentityFields } = await import("../lib/covenants");
  const { termsExportColumns } = await import("../lib/tape-fields");
  const { mismoLoan } = await import("../lib/mismo");
  // The shared list is the loan file's identity fields, less the descriptive ones.
  assert.deepEqual([...COVENANT_IDENTITY_FIELDS].sort(), [...loanFileIdentityFields()].sort());
  const naming = { borrowerName: "Ana Whitcombe", streetAddress: "12 Bay St", loanNumber: "LN-55821", inheritedCovenants: "Whitcombe loan: modification agreed in 2024." };
  const plain = { ...naming, inheritedCovenants: "Serviced to FHFA requirements; the buyer picks the servicer." };
  assert.equal(closedCovenant(naming.inheritedCovenants, naming), "");
  assert.equal(closedCovenant(plain.inheritedCovenants, plain), plain.inheritedCovenants);
  assert.equal(termsExportColumns(naming, false).inheritedCovenants, "");
  assert.equal(termsExportColumns(naming, true).inheritedCovenants, naming.inheritedCovenants);
  assert.equal(termsExportColumns(plain, false).inheritedCovenants, plain.inheritedCovenants);
  const key = Object.keys(mismoLoan(plain, false)).find((path) => path.endsWith("InheritedSaleCovenantsText"));
  assert.ok(key);
  assert.equal(mismoLoan(naming, false)[key], undefined);
  assert.equal(mismoLoan(naming, true)[key], naming.inheritedCovenants);
});
