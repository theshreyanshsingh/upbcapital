import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { GET as getListing } from "../app/api/v1/listings/[id]/route";
import { GET as getListings } from "../app/api/v1/listings/route";
import { BUYER_SCOPES, hashKey, mintKey } from "../lib/api-keys";
import { prisma } from "../lib/prisma";
import { resolveSessionUser } from "../lib/seats";
import {
  BROKER_CLIENT,
  COMPANY_TYPE_VALUES,
  DESK_SELLER,
  deskSellerLine,
  heldForClient,
  isCompanyType,
  maySeeSellerName,
  namedToEveryBuyer,
  sellerLabel,
  sellerName,
  sellerNameSight,
  sellerNamingLine,
  sellerShown,
  sellerShownTo,
  sellerTypeLabel,
  setCompanyType,
  setSellerNamed,
} from "../lib/seller-anonymity";

const HOUR = 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], listings: [] as string[], tokens: [] as string[] };
const FIRM = `Coastal Members Credit Union ${tag}`;
const CLIENT = `Helen Marsh ${tag}`;

type Role = "BUYER" | "INSTITUTIONAL_SELLER" | "INDIVIDUAL_SELLER" | "BROKER" | "ADMIN";

async function person(who: string, role: Role, data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `anon-${who}-${tag}@example.org`,
      name: `Anon ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...data,
    },
  });
  made.users.push(user.id);
  return user;
}

async function listing(sellerId: string, data: Partial<Prisma.ListingUncheckedCreateInput> = {}) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 2 * HOUR),
      standingBidsNotifiedAt: new Date(),
      title: `Anon listing ${tag}`,
      summary: "A test listing.",
      notes: {
        create: [{
          streetAddress: `1 Quiet Way ${tag}`, city: "Quietville", state: "XQ", zip: "99877", propertyType: "SFR", occupancy: "VACANT",
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

async function key(userId: string) {
  const minted = mintKey();
  await prisma.apiKey.create({ data: { userId, name: `Key ${tag}`, prefix: minted.prefix, hash: minted.hash, scopes: BUYER_SCOPES.join(",") } });
  made.tokens.push(minted.token);
  return minted.token;
}

function call(handler: (request: Request, context: never) => Promise<Response>, path: string, token: string, params?: Record<string, string>) {
  const request = new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
  return handler(request, (params ? { params: Promise.resolve(params) } : undefined) as never);
}

const seller = (role: string, companyType: string | null = null, names: { name?: string; companyName?: string } = {}) => ({
  role,
  companyType,
  name: names.name ?? "Pat Seller",
  companyName: names.companyName ?? "",
});

test.after(async () => {
  const ids = made.listings;
  const closings = await prisma.closing.findMany({ where: { listingId: { in: ids } }, select: { id: true } });
  await prisma.closingFunder.deleteMany({ where: { closingId: { in: closings.map((row) => row.id) } } });
  await prisma.closing.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: made.users } } });
  if (made.tokens.length) await prisma.rateWindow.deleteMany({ where: { OR: made.tokens.map((token) => ({ key: { startsWith: `api:${hashKey(token).slice(0, 32)}` } })) } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...made.users] } }, { actorId: { in: made.users } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ subject: { contains: tag } }, { body: { contains: tag } }] } });
  await prisma.user.deleteMany({ where: { principalId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
});

// ---------------------------------------------------------------------------------------------------------------
// Labels

test("each company type reads as its label, and a seller with none as an institution or a private note holder", () => {
  const expected: Record<string, string> = {
    BANK: "Bank",
    CREDIT_UNION: "Credit union",
    FUND: "Fund",
    SERVICER: "Servicer",
    LENDER: "Private lender",
    OTHER: "Institution",
  };
  assert.deepEqual([...COMPANY_TYPE_VALUES].sort(), Object.keys(expected).sort());
  for (const [type, label] of Object.entries(expected)) {
    assert.equal(sellerTypeLabel({ role: "INSTITUTIONAL_SELLER", companyType: type }), label, type);
    assert.ok(isCompanyType(type));
  }
  assert.equal(sellerTypeLabel({ role: "INSTITUTIONAL_SELLER", companyType: null }), "Institution");
  assert.equal(sellerTypeLabel({ role: "INDIVIDUAL_SELLER", companyType: null }), "Private note holder");
  assert.equal(sellerTypeLabel({ role: "INDIVIDUAL_SELLER", companyType: "LENDER" }), "Private lender");
  // A buyer reselling a holding, with no type, holds the note privately.
  assert.equal(sellerTypeLabel({ role: "BUYER" }), "Private note holder");
  assert.equal(sellerTypeLabel({ role: "ADMIN" }), DESK_SELLER);
  assert.equal(sellerTypeLabel({ role: "INSTITUTIONAL_SELLER", companyType: "NOT_A_TYPE" }), "Institution");
  assert.ok(!isCompanyType("NOT_A_TYPE"));
});

test("a desk-filed tape reads as its seller's type, and a broker's listing as the broker's client", () => {
  const deskFiled = { sellerId: "s1", brokerId: null, clientSellerName: "", seller: seller("INSTITUTIONAL_SELLER", "CREDIT_UNION", { companyName: FIRM }) };
  assert.equal(sellerLabel(deskFiled), "Credit union");
  assert.equal(sellerName(deskFiled), FIRM);
  const brokered = { sellerId: "b1", brokerId: "b1", clientSellerName: CLIENT, seller: seller("BROKER", null, { companyName: "Marsh Notes Brokerage" }) };
  assert.ok(heldForClient(brokered));
  assert.equal(sellerLabel(brokered), BROKER_CLIENT);
  // Once the room opens, the name is the note holder the broker filed for.
  assert.equal(sellerName(brokered), CLIENT);
  // The desk's own paper says it is the desk's.
  const desk = { sellerId: "d1", seller: seller("ADMIN", null, { name: "Jordan at the desk" }) };
  assert.equal(sellerShown(desk, false), DESK_SELLER);
  assert.equal(sellerShown(desk, true), DESK_SELLER);
});

// ---------------------------------------------------------------------------------------------------------------
// The predicate

test("only the room, a closing, the seller's own side, the desk or the seller's choice names the seller", () => {
  const plain = { sellerId: "seller", brokerId: null, sellerNamed: null };
  const buyer = { id: "buyer", role: "BUYER" };
  assert.equal(maySeeSellerName(buyer, plain), false, "an unadmitted buyer");
  assert.equal(maySeeSellerName(buyer, plain, { nda: { accessStatus: "PENDING" } }), false, "an NDA waiting on the seller");
  assert.equal(maySeeSellerName(buyer, plain, { nda: { accessStatus: "DECLINED" } }), false, "a declined NDA");
  assert.equal(maySeeSellerName(buyer, plain, { nda: { accessStatus: null } }), true, "an NDA on a room that opens on the signature");
  assert.equal(maySeeSellerName(buyer, plain, { nda: { accessStatus: "APPROVED" } }), true, "an NDA the seller approved");
  assert.equal(maySeeSellerName(buyer, plain, { closingParty: true }), true, "a party to a closing");
  assert.equal(maySeeSellerName({ id: "seller", role: "INSTITUTIONAL_SELLER" }, plain), true, "the seller");
  assert.equal(maySeeSellerName({ id: "someone", role: "ADMIN" }, plain), true, "the desk");
  assert.equal(maySeeSellerName({ id: "broker", role: "BROKER" }, { ...plain, brokerId: "broker" }), true, "the broker on the listing");
  assert.equal(maySeeSellerName({ id: "other-seller", role: "INDIVIDUAL_SELLER" }, plain), false, "another seller");
  assert.equal(maySeeSellerName(buyer, { ...plain, sellerNamed: true }), true, "the seller chose to be named");
  assert.equal(maySeeSellerName(buyer, { ...plain, sellerNamed: false }), false);
  // The public pages name no seller either way.
  assert.equal(maySeeSellerName(null, { ...plain, sellerNamed: true }), false);
  // A broker's client is never named to every buyer, whatever the listing holds.
  const brokered = { sellerId: "broker", brokerId: "broker", clientSellerName: CLIENT, sellerNamed: true };
  assert.equal(namedToEveryBuyer(brokered), false);
  assert.equal(maySeeSellerName(buyer, brokered), false);
  assert.equal(maySeeSellerName(buyer, brokered, { nda: { accessStatus: "APPROVED" } }), true);
});

test("the NDA, the seller's approval, a closing and a firm's seat decide it against the database", async () => {
  const firm = await person("firm", "INSTITUTIONAL_SELLER", { companyName: FIRM, companyType: "CREDIT_UNION" });
  const sellerSeat = await person("firm-seat", "INSTITUTIONAL_SELLER", { principalId: firm.id, seatRole: "VIEW", seatAddedAt: new Date() });
  const outsider = await person("outsider", "BUYER");
  const waiting = await person("waiting", "BUYER");
  const admitted = await person("admitted", "BUYER");
  const winner = await person("winner", "BUYER");
  const funder = await person("funder", "BUYER");
  const buyerSeat = await person("admitted-seat", "BUYER", { principalId: admitted.id, seatRole: "VIEW", seatAddedAt: new Date() });
  const row = await listing(firm.id, { roomApproval: true });
  await prisma.ndaAcknowledgment.create({ data: { userId: waiting.id, listingId: row.id, accessStatus: "PENDING" } });
  await prisma.ndaAcknowledgment.create({ data: { userId: admitted.id, listingId: row.id, accessStatus: "APPROVED" } });
  const bid = await prisma.inquiry.create({ data: { listingId: row.id, buyerId: winner.id, type: "OFFER", amount: 90000, status: "ACCEPTED" } });
  const closing = await prisma.closing.create({
    data: { listingId: row.id, inquiryId: bid.id, status: "OPEN", salePrice: 90000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 9000000, netToSellerCents: 9000000 },
  });
  await prisma.closingFunder.create({ data: { closingId: closing.id, userId: funder.id, amount: 45000, premiumCents: 0, percent: 50 } });
  const full = { ...row, seller: firm };

  const sight = async (viewer: { id: string; role: string }) => (await sellerNameSight(viewer, [row])).get(row.id);
  assert.equal(await sight(outsider), false);
  assert.equal(await sight(waiting), false);
  assert.equal(await sight(admitted), true);
  assert.equal(await sight(winner), true);
  assert.equal(await sight(funder), true);
  assert.equal(await sight(firm), true);
  assert.equal(await sellerShownTo(outsider, full), "Credit union");
  assert.equal(await sellerShownTo(admitted, full), FIRM);

  // A seat signs in as its firm, so it sees what the firm sees: the seller's own seat, and a buyer firm's seat.
  const asSellerSeat = await resolveSessionUser(sellerSeat.id);
  const asBuyerSeat = await resolveSessionUser(buyerSeat.id);
  assert.ok(asSellerSeat && asBuyerSeat);
  assert.equal(await sellerShownTo(asSellerSeat.user, full), FIRM);
  assert.equal(await sellerShownTo(asBuyerSeat.user, full), FIRM);

  // The seller's choice names it to every approved buyer.
  await prisma.listing.update({ where: { id: row.id }, data: { sellerNamed: true } });
  assert.equal(await sellerShownTo(outsider, { ...full, sellerNamed: true }), FIRM);
});

// ---------------------------------------------------------------------------------------------------------------
// The buyer API

test("the API's listing payload gives an unadmitted buyer the label, and the name once the room opens", async () => {
  const firm = await person("api-firm", "INSTITUTIONAL_SELLER", { companyName: FIRM, companyType: "CREDIT_UNION", name: `Dana Officer ${tag}` });
  const buyer = await person("api-buyer", "BUYER");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED" } });
  const token = await key(buyer.id);
  const row = await listing(firm.id, { title: `Anon api ${tag}` });

  const before = await call(getListing, `/api/v1/listings/${row.id}`, token, { id: row.id });
  assert.equal(before.status, 200);
  const text = await before.text();
  const body = JSON.parse(text) as { seller: string };
  assert.equal(body.seller, "Credit union");
  assert.ok(!text.includes(FIRM) && !text.includes(`Dana Officer ${tag}`), "the seller's name leaked");

  // The list carries the same label, read for each row.
  let cursor: string | null = null;
  let found: { id: string; seller: string } | undefined;
  for (let page = 0; page < 50 && !found; page += 1) {
    const response = await call(getListings, `/api/v1/listings?limit=100${cursor ? `&cursor=${cursor}` : ""}`, token);
    const list = (await response.json()) as { listings: { id: string; seller: string }[]; nextCursor: string | null };
    found = list.listings.find((item) => item.id === row.id);
    cursor = list.nextCursor;
    if (!cursor) break;
  }
  assert.equal(found?.seller, "Credit union");

  await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId: row.id } });
  const after = (await (await call(getListing, `/api/v1/listings/${row.id}`, token, { id: row.id })).json()) as { seller: string };
  assert.equal(after.seller, FIRM);
});

test("a broker's client never shows to a buyer outside the room, even with the naming switch on", async () => {
  const broker = await person("broker", "BROKER", { companyName: `Marsh Notes Brokerage ${tag}` });
  const buyer = await person("broker-buyer", "BUYER");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED" } });
  const token = await key(buyer.id);
  const row = await listing(broker.id, { brokerId: broker.id, brokerRole: "SELLER_BROKER", clientSellerName: CLIENT, clientRelationship: "Family friend", title: `Anon brokered ${tag}` });

  // The broker can't switch it on, and a row that says so anyway still hides the client.
  const refused = await setSellerNamed({ listingId: row.id, actorId: broker.id, on: true });
  assert.match(refused.error ?? "", /broker's client stays unnamed/);
  await prisma.listing.update({ where: { id: row.id }, data: { sellerNamed: true } });

  const response = await call(getListing, `/api/v1/listings/${row.id}`, token, { id: row.id });
  const text = await response.text();
  assert.equal((JSON.parse(text) as { seller: string }).seller, BROKER_CLIENT);
  assert.ok(!text.includes(CLIENT), "the note holder's name leaked");
  const full = { ...row, sellerNamed: true, seller: broker };
  assert.equal(await sellerShownTo(buyer, full), BROKER_CLIENT);
  assert.ok(!sellerNamingLine(full).includes(CLIENT));
  assert.ok(deskSellerLine(full).includes(CLIENT), "the desk sees who it is");

  // In the room, the papers name the holder, and so does the page.
  await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId: row.id } });
  assert.equal(await sellerShownTo(buyer, full), CLIENT);
});

// ---------------------------------------------------------------------------------------------------------------
// The seller's choices

test("the seller of record switches the name on and off, while the listing is filed or live", async () => {
  const owner = await person("owner", "INDIVIDUAL_SELLER");
  const stranger = await person("stranger", "INDIVIDUAL_SELLER");
  const row = await listing(owner.id);
  assert.match((await setSellerNamed({ listingId: row.id, actorId: stranger.id, on: true })).error ?? "", /isn't yours/);
  const on = await setSellerNamed({ listingId: row.id, actorId: owner.id, on: true });
  assert.equal(on.error, null);
  assert.equal(on.unchanged, false);
  assert.equal((await prisma.listing.findUnique({ where: { id: row.id } }))?.sellerNamed, true);
  assert.equal((await setSellerNamed({ listingId: row.id, actorId: owner.id, on: true })).unchanged, true);
  assert.equal(await prisma.auditEvent.count({ where: { entityId: row.id, action: "SELLER_NAMED" } }), 1);
  const full = { ...row, sellerNamed: true, seller: owner };
  assert.match(sellerNamingLine(full), /Every approved buyer sees your name/);
  assert.match(deskSellerLine(full), /chose to be named/);
  await setSellerNamed({ listingId: row.id, actorId: owner.id, on: false });
  const off = { ...row, sellerNamed: false, seller: owner };
  assert.match(sellerNamingLine(off), /^Buyers see you as Private note holder until the data room opens to them/);
  assert.match(deskSellerLine(off), /^Buyers see the seller as Private note holder until the data room opens to them, then Anon owner/);
  await prisma.listing.update({ where: { id: row.id }, data: { status: "SOLD" } });
  assert.match((await setSellerNamed({ listingId: row.id, actorId: owner.id, on: true })).error ?? "", /closed/);
});

test("a seller sets the company type buyers read, and a buyer has none to set", async () => {
  const individual = await person("type-individual", "INDIVIDUAL_SELLER");
  const institution = await person("type-institution", "INSTITUTIONAL_SELLER", { companyName: FIRM, companyType: "BANK" });
  const buyer = await person("type-buyer", "BUYER");
  assert.match((await setCompanyType(buyer, "BANK")).error ?? "", /Only a seller account/);
  assert.match((await setCompanyType(institution, "THRIFT")).error ?? "", /Choose a type/);
  const lender = await setCompanyType(individual, "LENDER");
  assert.equal(lender.error, null);
  assert.equal(lender.label, "Private lender");
  assert.equal((await prisma.user.findUnique({ where: { id: individual.id } }))?.companyType, "LENDER");
  const cleared = await setCompanyType({ ...individual, companyType: "LENDER" }, "");
  assert.equal(cleared.label, "Private note holder");
  assert.equal((await prisma.user.findUnique({ where: { id: individual.id } }))?.companyType, null);
  const union = await setCompanyType(institution, "CREDIT_UNION");
  assert.equal(union.label, "Credit union");
  assert.equal((await setCompanyType({ ...institution, companyType: "CREDIT_UNION" }, "CREDIT_UNION")).unchanged, true);
});
