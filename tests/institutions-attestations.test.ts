import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  ATTESTATION_KINDS,
  attestationGaps,
  bidderLimitBlock,
  deskBookBlock,
  endings,
  giveAttestation,
  readReference,
  requiredKinds,
  revokeAttestation,
  setBidderLimits,
  withdrawAttestation,
} from "../lib/attestations";
import { addBeneficialOwner } from "../lib/beneficial-owners";
import { addBuyerEntity, readEntity, reviewBuyerEntity, submitBuyerEntity } from "../lib/buyer-entities";
import { literal } from "../lib/db-filters";
import { checkOffer } from "../lib/inquiry";
import {
  REGULATED,
  charterLookup,
  isRegulatedBuyer,
  keepRegulated,
  listingsForBuyer,
  readCharter,
  regulatedLineFor,
  regulatedUserIds,
} from "../lib/institutions";
import { entityLabel } from "../lib/labels";
import { rescoreBox, rescoreListing } from "../lib/matching";
import { prisma } from "../lib/prisma";
import { ENTITY_LABELS } from "../lib/room-access";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
// A state nothing seeded uses, so only this file's boxes are scored against its listings.
const STATE = "QZ";
const made = { users: [] as { id: string; email: string }[], listings: [] as string[] };

type Role = "BUYER" | "ADMIN" | "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER";

async function person(who: string, role: Role) {
  const user = await prisma.user.create({
    data: {
      email: `inst-${who}-${tag}@example.org`,
      name: `Inst ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
    },
  });
  made.users.push(user);
  return user;
}

async function buyer(who: string, file: Partial<Prisma.BuyerProfileUncheckedCreateInput> = {}) {
  const user = await person(who, "BUYER");
  await prisma.buyerProfile.create({
    data: { userId: user.id, status: "APPROVED", entityType: "LLC", entityName: `${who} Notes LLC ${tag}`, jurisdiction: "Delaware", homesControlled: 0, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY), ...file },
  });
  return user;
}

async function listing(sellerId: string, data: Partial<Prisma.ListingUncheckedCreateInput> = {}) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      standingBidsNotifiedAt: new Date(),
      title: `Institutional note ${tag}`,
      summary: "A test listing.",
      notes: {
        create: [{
          streetAddress: `1 Charter Way ${tag}`, city: "Charterville", state: STATE, zip: "99871", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000, borrowerName: `Borrower ${tag}`,
        }] as never,
      },
      ...data,
    },
  });
  made.listings.push(row.id);
  return row;
}

const readListing = (id: string) => prisma.listing.findUniqueOrThrow({ where: { id }, include: { seller: true } });
const bid = async (user: Awaited<ReturnType<typeof person>>, listingId: string, buyerEntityId = "", now = new Date()) =>
  checkOffer({ user, listing: await readListing(listingId), noteId: "", amount: 100000, goodUntil: "", buyerEntityId, now });

// An approved bank or credit union entity on a buyer's file, as the desk leaves it once the charter is checked.
async function approvedInstitution(userId: string, data: Partial<Prisma.BuyerEntityUncheckedCreateInput> = {}) {
  return prisma.buyerEntity.create({
    data: { userId, name: `First Charter Bank ${tag}`, entityType: "BANK", jurisdiction: "Ohio", charterNumber: "3510", regulator: "OCC", taxIdLast4: "4321", status: "APPROVED", ...data },
  });
}

test.after(async () => {
  const userIds = made.users.map((user) => user.id);
  const ids = made.listings;
  await prisma.listingMatch.deleteMany({ where: { OR: [{ listingId: { in: ids } }, { userId: { in: userIds } }] } });
  await prisma.buyBox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.groupBuy.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.bidderAttestation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.beneficialOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerEntity.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.ofacCheck.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { name: { contains: literal(tag) } }] } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.users.map((user) => user.email) } }, { subject: { contains: literal(tag) } }, { body: { contains: literal(tag) } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The charter.

test("a bank gives an FDIC certificate and a credit union an NCUA charter, in digits, with a regulator of its kind", () => {
  assert.deepEqual(readCharter("BANK", { charterNumber: " 3 510 ", regulator: "occ" }), { error: null, data: { charterNumber: "3510", regulator: "OCC" } });
  assert.deepEqual(readCharter("CREDIT_UNION", { charterNumber: "#24212", regulator: "NCUA" }), { error: null, data: { charterNumber: "24212", regulator: "NCUA" } });
  assert.equal(readCharter("CREDIT_UNION", { charterNumber: "60123", regulator: "STATE" }).error, null);
  // Leading zeros are dropped so the lookup reads the regulator's number.
  assert.deepEqual(readCharter("BANK", { charterNumber: "007", regulator: "FDIC" }), { error: null, data: { charterNumber: "7", regulator: "FDIC" } });
  for (const charterNumber of ["", "ABC12", "12-34-56-78", "1234567", "0"]) {
    assert.match(readCharter("BANK", { charterNumber, regulator: "OCC" }).error ?? "", /FDIC certificate number, in digits/, charterNumber);
  }
  assert.match(readCharter("CREDIT_UNION", { charterNumber: "CU-9", regulator: "NCUA" }).error ?? "", /NCUA charter number, in digits/);
  // The regulator has to fit the kind.
  assert.match(readCharter("BANK", { charterNumber: "3510", regulator: "NCUA" }).error ?? "", /bank's regulator/);
  assert.match(readCharter("CREDIT_UNION", { charterNumber: "24212", regulator: "OCC" }).error ?? "", /credit union's regulator/);
  assert.match(readCharter("BANK", { charterNumber: "3510", regulator: "" }).error ?? "", /bank's regulator/);
  // Any other entity keeps neither.
  assert.deepEqual(readCharter("LLC", { charterNumber: "3510", regulator: "OCC" }), { error: null, data: { charterNumber: null, regulator: null } });

  // The buying-entity form asks for them, and labels the kinds everywhere entities are listed.
  assert.match(readEntity({ name: `Credit Union ${tag}`, entityType: "CREDIT_UNION", jurisdiction: "Iowa", taxIdLast4: "1111" }).error ?? "", /NCUA charter number/);
  const read = readEntity({ name: `Credit Union ${tag}`, entityType: "CREDIT_UNION", jurisdiction: "Iowa", taxIdLast4: "1111", charterNumber: "24212", regulator: "NCUA" });
  assert.equal(read.error === null && read.data.charterNumber, "24212");
  assert.equal(entityLabel("BANK"), "Bank");
  assert.equal(entityLabel("CREDIT_UNION"), "Credit union");
  assert.equal(ENTITY_LABELS.BANK, "Bank");
  assert.equal(ENTITY_LABELS.CREDIT_UNION, "Credit union");

  // The lookup links are built from the number alone.
  assert.deepEqual(charterLookup({ entityType: "BANK", charterNumber: "3510", regulator: "OCC" }), { label: "FDIC BankFind", href: "https://banks.data.fdic.gov/bankfind-suite/bankfind/details/3510" });
  assert.deepEqual(charterLookup({ entityType: "CREDIT_UNION", charterNumber: "24212", regulator: "NCUA" }), { label: "NCUA credit union locator", href: "https://mapping.ncua.gov/SingleResult.aspx?ID=24212" });
  assert.equal(charterLookup({ entityType: "BANK", charterNumber: "<script>", regulator: "OCC" }), null);
  assert.equal(charterLookup({ entityType: "LLC" }), null);
});

test("a regulated buyer is a bank or credit union the desk approved with its charter checked, and never an LLC", async () => {
  const desk = await person("desk-a", "ADMIN");
  const holder = await buyer("holder");
  // The bank entity waits on the buyer for its control person, then on the desk.
  const added = await addBuyerEntity(holder, { name: `Lakeside Bank ${tag}`, entityType: "BANK", jurisdiction: "Ohio", taxIdLast4: "2468", charterNumber: "3510", regulator: "OCC" });
  if (added.error !== null) assert.fail(added.error);
  const bank = added.entity;
  assert.equal(bank.status, "NOT_STARTED");
  assert.equal(await isRegulatedBuyer(holder, bank.id), false);
  assert.equal((await addBeneficialOwner(holder, { buyerEntityId: bank.id, name: `Pat Officer ${tag}`, title: "Chief financial officer", controlPerson: "yes" })).error, null);
  assert.equal((await submitBuyerEntity(holder, bank.id)).error, null);
  // Submitted is not approved.
  assert.equal(await isRegulatedBuyer(holder, bank.id), false);
  // The desk can't approve a bank without saying it checked the charter.
  assert.match((await reviewBuyerEntity(desk, { entityId: bank.id, decision: "APPROVED", note: "" })).error ?? "", /Check the charter number/);
  assert.equal((await reviewBuyerEntity(desk, { entityId: bank.id, decision: "APPROVED", note: "", charterChecked: true })).error, null);
  assert.equal(await isRegulatedBuyer(holder, bank.id), true);
  const log = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: holder.id, action: "BUYER_ENTITY_REVIEW" }, orderBy: { createdAt: "desc" } });
  assert.match(log.detail, /FDIC certificate number 3510 · OCC checked/);
  // The main file is an LLC, so it isn't one, and someone else's entity never counts.
  assert.equal(await isRegulatedBuyer(holder), false);
  const other = await buyer("other");
  assert.equal(await isRegulatedBuyer(other, bank.id), false);
  assert.equal(await isRegulatedBuyer(other), false);
  // A bank with no charter in the right shape doesn't count even when approved.
  const unchecked = await prisma.buyerEntity.create({ data: { userId: other.id, name: `Unchecked Bank ${tag}`, entityType: "BANK", jurisdiction: "Ohio", status: "APPROVED" } });
  assert.equal(await isRegulatedBuyer(other, unchecked.id), false);
  assert.deepEqual([...(await regulatedUserIds([holder.id, other.id]))], [holder.id]);
});

// ---------------------------------------------------------------------------------------------------------------
// Regulated-only listings.

test("a sale open to banks and credit unions only refuses an LLC's bid and seat, and takes a bank's", async () => {
  const seller = await person("cu-seller", "INSTITUTIONAL_SELLER");
  const sale = await listing(seller.id, { buyerLimit: REGULATED });
  const llc = await buyer("llc");
  const withBank = await buyer("with-bank");
  const bank = await approvedInstitution(withBank.id);
  const bankFile = await buyer("bank-file", { entityType: "CREDIT_UNION", entityName: `Members Credit Union ${tag}`, charterNumber: "24212", regulator: "NCUA" });

  const refused = await bid(llc, sale.id);
  assert.equal(refused.error, "This sale is open to banks and credit unions only.");
  assert.equal(refused.error !== null && refused.verification, false);
  // A buyer with a bank on file is told to bid through it.
  assert.match((await bid(withBank, sale.id)).error ?? "", /only\. Choose your bank or credit union/);
  assert.equal((await bid(withBank, sale.id, bank.id)).error, null);
  // A main file that is a credit union bids as itself.
  assert.equal((await bid(bankFile, sale.id)).error, null);

  // A group seat is for the main file, which is how actions/group.ts asks.
  const seat = (user: { id: string }) => bidderLimitBlock({ user, listingId: sale.id, buyerEntityId: null, seat: true });
  assert.match((await seat(llc))?.error ?? "", /^This sale is open to banks and credit unions only\. A group seat is for your main buyer file/);
  assert.match((await seat(withBank))?.error ?? "", /group seat is for your main buyer file/);
  assert.equal(await seat(bankFile), null);

  // The listing page shows the line in place of the bid form, and still shows the listing.
  assert.equal(await regulatedLineFor(sale, llc), "This sale is open to banks and credit unions only.");
  assert.equal(await regulatedLineFor(sale, withBank), null);
  assert.equal(await regulatedLineFor(sale, { id: seller.id, role: "INSTITUTIONAL_SELLER" }), null);
  // Any other listing is open to all, as every listing was before the limit.
  const open = await listing(seller.id);
  assert.equal((await bid(llc, open.id)).error, null);
  assert.equal(await bidderLimitBlock({ user: llc, listingId: open.id, buyerEntityId: null, seat: true }), null);
  // The desk book has no charter to bid with.
  assert.match(deskBookBlock(sale) ?? "", /banks and credit unions only\. The desk book doesn't bid/);
  assert.equal(deskBookBlock(open), null);
});

test("only an institutional seller or the desk limits a sale, and bids in lock it against tightening", async () => {
  const desk = await person("desk-b", "ADMIN");
  const institution = await person("inst-seller", "INSTITUTIONAL_SELLER");
  const individual = await person("ind-seller", "INDIVIDUAL_SELLER");
  const theirs = await listing(individual.id);
  assert.match((await setBidderLimits(individual, { listingId: theirs.id, regulated: true, kinds: [] })).error ?? "", /institutional seller or the desk/);
  // The individual seller may still ask for statements, and the desk may limit their sale.
  assert.equal((await setBidderLimits(individual, { listingId: theirs.id, regulated: false, kinds: ["QUALIFIED_PURCHASER"] })).error, null);
  assert.equal((await setBidderLimits(desk, { listingId: theirs.id, regulated: true, kinds: ["QUALIFIED_PURCHASER"] })).error, null);
  // Nobody else's.
  assert.match((await setBidderLimits(institution, { listingId: theirs.id, regulated: false, kinds: [] })).error ?? "", /isn't yours/);

  const ours = await listing(institution.id);
  assert.match((await setBidderLimits(institution, { listingId: ours.id, regulated: false, kinds: ["NOT_A_KIND"] })).error ?? "", /from the list/);
  const set = await setBidderLimits(institution, { listingId: ours.id, regulated: true, kinds: ["HUD_EO_14376"] });
  assert.equal(set.error === null && set.unchanged, false);
  let row = await prisma.listing.findUniqueOrThrow({ where: { id: ours.id } });
  assert.equal(row.buyerLimit, REGULATED);
  assert.deepEqual(row.requiredAttestations, ["HUD_EO_14376"]);
  assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: ours.id, action: "BIDDER_LIMITS" } }));
  const same = await setBidderLimits(institution, { listingId: ours.id, regulated: true, kinds: ["HUD_EO_14376"] });
  assert.equal(same.error === null && same.unchanged, true);

  // A bid in locks tightening. Loosening stays open.
  const bidder = await buyer("locker");
  await prisma.inquiry.create({ data: { listingId: ours.id, buyerId: bidder.id, type: "OFFER", amount: 100000, message: "Bid", status: "OPEN" } });
  assert.match((await setBidderLimits(institution, { listingId: ours.id, regulated: true, kinds: ["HUD_EO_14376", "QUALIFIED_PURCHASER"] })).error ?? "", /only be loosened/);
  assert.equal((await setBidderLimits(institution, { listingId: ours.id, regulated: false, kinds: [] })).error, null);
  row = await prisma.listing.findUniqueOrThrow({ where: { id: ours.id } });
  assert.equal(row.buyerLimit, null);
  assert.deepEqual(row.requiredAttestations, []);
  assert.match((await setBidderLimits(desk, { listingId: ours.id, regulated: true, kinds: [] })).error ?? "", /only be loosened/);
});

// ---------------------------------------------------------------------------------------------------------------
// Attestations.

test("a required statement is missing, then given, then expired, then asked again after a version bump", async () => {
  const seller = await person("hud-seller", "INSTITUTIONAL_SELLER");
  const sale = await listing(seller.id, { requiredAttestations: ["HUD_EO_14376"] });
  const fund = await buyer("fund");
  const bank = await approvedInstitution(fund.id);

  const missing = await bid(fund, sale.id);
  assert.match(missing.error ?? "", /asks each bidder for a current HUD bidder certification \(Executive Order 14376\), and your main buyer file has none/);
  assert.match(missing.error ?? "", /\/buyer\/verification#attestations/);
  // It sends the buyer to their file, where they give it.
  assert.equal(missing.error !== null && missing.verification, true);

  assert.match((await giveAttestation(fund, { kind: "HUD_EO_14376", agreed: false })).error ?? "", /Tick the box/);
  assert.match((await giveAttestation(fund, { kind: "SOMETHING", agreed: true })).error ?? "", /Choose a statement/);
  const given = await giveAttestation(fund, { kind: "HUD_EO_14376", agreed: true });
  if (given.error !== null) assert.fail(given.error);
  assert.equal(given.attestation.text, ATTESTATION_KINDS.HUD_EO_14376.text);
  assert.equal(given.attestation.version, ATTESTATION_KINDS.HUD_EO_14376.version);
  assert.equal(given.attestation.expiresAt, null);
  assert.equal(given.attestation.buyerEntityId ?? null, null);
  assert.match(given.attestation.text, /UPB's draft.*agency's own bidder form control/);
  assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: fund.id, action: "BIDDER_ATTESTATION", detail: { contains: given.attestation.id } } }));
  assert.equal((await bid(fund, sale.id)).error, null);
  // It is per buying entity: the bank has none yet.
  assert.match((await bid(fund, sale.id, bank.id)).error ?? "", /the buying entity you chose has none/);
  assert.equal((await giveAttestation(fund, { kind: "HUD_EO_14376", buyerEntityId: bank.id, agreed: true })).error, null);
  assert.equal((await bid(fund, sale.id, bank.id)).error, null);
  // Another buyer's entity can't be attested for.
  const stranger = await buyer("stranger");
  assert.match((await giveAttestation(stranger, { kind: "HUD_EO_14376", buyerEntityId: bank.id, agreed: true })).error ?? "", /your own buying entities/);

  // A licence statement lasts a year and names the licence.
  const licensed = await listing(seller.id, { requiredAttestations: ["DEBT_BUYER_LICENSE"] });
  const now = new Date();
  assert.match((await giveAttestation(fund, { kind: "DEBT_BUYER_LICENSE", agreed: true })).error ?? "", /two-letter code and the licence number/);
  assert.match(readReference("ZZ 12345").error ?? "", /two-letter code/);
  assert.match(readReference("PA licence").error ?? "", /two-letter code/);
  const licence = await giveAttestation(fund, { kind: "DEBT_BUYER_LICENSE", reference: " pa  db-012345 ", agreed: true }, now);
  if (licence.error !== null) assert.fail(licence.error);
  assert.equal(licence.attestation.reference, "PA DB-012345");
  assert.equal(licence.attestation.expiresAt?.getUTCFullYear(), now.getUTCFullYear() + 1);
  assert.equal(await bidderLimitBlock({ user: fund, listingId: licensed.id, buyerEntityId: null, now }), null);
  const later = new Date(now.getTime() + 400 * DAY);
  assert.deepEqual(await attestationGaps({ userId: fund.id, buyerEntityId: null, kinds: ["DEBT_BUYER_LICENSE"], now: later }), ["DEBT_BUYER_LICENSE"]);
  assert.match((await bidderLimitBlock({ user: fund, listingId: licensed.id, buyerEntityId: null, now: later }))?.error ?? "", /current debt-buyer licence statement/);
  // Renewing is giving it again; the newest one decides.
  assert.equal((await giveAttestation(fund, { kind: "DEBT_BUYER_LICENSE", reference: "PA DB-012345", agreed: true }, later)).error, null);
  assert.equal(await bidderLimitBlock({ user: fund, listingId: licensed.id, buyerEntityId: null, now: new Date(later.getTime() + DAY) }), null);

  // New wording asks again, for every entity, until each gives it in the new version.
  const kind = ATTESTATION_KINDS.HUD_EO_14376;
  const version = kind.version;
  try {
    kind.version = `${version}-bumped-${tag}`;
    assert.match((await bid(fund, sale.id)).error ?? "", /HUD bidder certification/);
    assert.match((await bid(fund, sale.id, bank.id)).error ?? "", /HUD bidder certification/);
    const again = await giveAttestation(fund, { kind: "HUD_EO_14376", agreed: true });
    assert.equal(again.error === null && again.attestation.version, kind.version);
    assert.equal((await bid(fund, sale.id)).error, null);
  } finally {
    kind.version = version;
  }
  // A listing asking two kinds names both that are missing.
  const both = await listing(seller.id, { requiredAttestations: ["QUALIFIED_PURCHASER", "HUD_EO_14376", "RETIRED_KIND"] });
  assert.deepEqual(requiredKinds(both.requiredAttestations), ["HUD_EO_14376", "QUALIFIED_PURCHASER"]);
  assert.match((await bid(stranger, both.id)).error ?? "", /HUD bidder certification \(Executive Order 14376\) and qualified purchaser statement, and your main buyer file has none\. Give them/);
});

test("the buyer withdraws a statement and the desk revokes one with a reason the buyer reads", async () => {
  const desk = await person("desk-c", "ADMIN");
  const seller = await person("qp-seller", "INDIVIDUAL_SELLER");
  const sale = await listing(seller.id, { requiredAttestations: ["QUALIFIED_PURCHASER"] });
  const holder = await buyer("qp");
  const first = await giveAttestation(holder, { kind: "QUALIFIED_PURCHASER", agreed: true });
  if (first.error !== null) assert.fail(first.error);
  assert.equal((await bid(holder, sale.id)).error, null);
  const other = await buyer("qp-other");
  assert.match((await withdrawAttestation(other, first.attestation.id)).error ?? "", /isn't on your file/);
  assert.equal((await withdrawAttestation(holder, first.attestation.id)).error, null);
  assert.match((await withdrawAttestation(holder, first.attestation.id)).error ?? "", /already withdrawn/);
  assert.match((await bid(holder, sale.id)).error ?? "", /qualified purchaser statement/);

  const second = await giveAttestation(holder, { kind: "QUALIFIED_PURCHASER", agreed: true });
  if (second.error !== null) assert.fail(second.error);
  assert.equal((await bid(holder, sale.id)).error, null);
  assert.match((await revokeAttestation(desk, { attestationId: second.attestation.id, reason: " " })).error ?? "", /Say why/);
  const reason = `The fund's assets fell below the threshold ${tag}`;
  assert.equal((await revokeAttestation(desk, { attestationId: second.attestation.id, reason })).error, null);
  assert.match((await revokeAttestation(desk, { attestationId: second.attestation.id, reason })).error ?? "", /already withdrawn or revoked/);
  assert.match((await bid(holder, sale.id)).error ?? "", /qualified purchaser statement/);
  const stored = await prisma.bidderAttestation.findUniqueOrThrow({ where: { id: second.attestation.id } });
  assert.ok(stored.revokedAt);
  const log = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: holder.id, action: "BIDDER_ATTESTATION_REVOKED" } });
  assert.equal(log.actorId, desk.id);
  assert.match(log.detail, new RegExp(`${second.attestation.id} · Qualified purchaser statement · ${reason}`));
  const mail = await prisma.notification.findFirstOrThrow({ where: { toEmail: holder.email, subject: { contains: "Statement revoked" } } });
  assert.match(mail.body, new RegExp(reason));
  const ended = await endings(holder.id);
  assert.deepEqual(ended.get(second.attestation.id), { by: "desk", reason });
  assert.deepEqual(ended.get(first.attestation.id), { by: "buyer", reason: "" });
});

// ---------------------------------------------------------------------------------------------------------------
// Matches and alerts.

test("buy-box matches and alerts skip a sale open to banks and credit unions only for an LLC buyer", async () => {
  const seller = await person("match-seller", "INSTITUTIONAL_SELLER");
  const llc = await buyer("match-llc");
  const cu = await buyer("match-cu", { entityType: "CREDIT_UNION", entityName: `Valley Credit Union ${tag}`, charterNumber: "61234", regulator: "STATE" });
  const llcBox = await prisma.buyBox.create({ data: { userId: llc.id, name: `LLC box ${tag}`, states: STATE } });
  const cuBox = await prisma.buyBox.create({ data: { userId: cu.id, name: `CU box ${tag}`, states: STATE } });
  const sale = await listing(seller.id, { buyerLimit: REGULATED });
  await rescoreListing(sale.id, false);
  const matched = async () => (await prisma.listingMatch.findMany({ where: { listingId: sale.id, buyBoxId: { in: [llcBox.id, cuBox.id] } } })).map((row) => row.buyBoxId).sort();
  assert.deepEqual(await matched(), [cuBox.id]);
  // Rescoring the LLC's box leaves it out too.
  await rescoreBox(llcBox.id, { quiet: true });
  assert.deepEqual(await matched(), [cuBox.id]);
  // Alerts read the same rule.
  assert.deepEqual((await keepRegulated(sale, [llc, cu])).map((user) => user.id), [cu.id]);
  assert.deepEqual((await listingsForBuyer(llc.id, [sale])).length, 0);
  assert.deepEqual((await listingsForBuyer(cu.id, [sale])).length, 1);
  // Loosening the limit brings the LLC's match back.
  assert.equal((await setBidderLimits(seller, { listingId: sale.id, regulated: false, kinds: [] })).error, null);
  assert.deepEqual(await matched(), [llcBox.id, cuBox.id].sort());
  // And setting it again takes it away at once.
  assert.equal((await setBidderLimits(seller, { listingId: sale.id, regulated: true, kinds: [] })).error, null);
  assert.deepEqual(await matched(), [cuBox.id]);
});
