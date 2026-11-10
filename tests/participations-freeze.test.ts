import assert from "node:assert/strict";
import test from "node:test";
import {
  ACKNOWLEDGE_FIRST,
  confirmNotices,
  deskEligibilityLog,
  deskMaryland,
  eligibilityFor,
  MARYLAND_BRIEF,
  marylandLoan,
} from "../lib/eligibility";
import { logSeatEligibility, seatEligibility } from "../lib/group-eligibility";
import { acknowledgeRoad } from "../lib/inquiry";
import {
  CAPITAL_PAUSED,
  capitalAllocationBlock,
  participationFaq,
  participationsOpen,
  TRANCHES_PAUSED,
  trancheBlock,
} from "../lib/participation";
import { prisma } from "../lib/prisma";

const DAY = 24 * 60 * 60 * 1000;
const OFF = {};
const ON = { UPB_PARTICIPATIONS: "1" };

test.after(async () => {
  await prisma.$disconnect();
});

// Runs with the flag as the server would read it, and puts it back after.
async function withFlag<T>(value: string | undefined, run: () => T | Promise<T>) {
  const before = process.env.UPB_PARTICIPATIONS;
  if (value === undefined) delete process.env.UPB_PARTICIPATIONS;
  else process.env.UPB_PARTICIPATIONS = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.UPB_PARTICIPATIONS;
    else process.env.UPB_PARTICIPATIONS = before;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The participations freeze, as pure rules.

test("a senior and junior group is refused while the freeze holds and allowed once it lifts; pro rata stays open", async () => {
  assert.equal(trancheBlock("SENIOR_JUNIOR", OFF), TRANCHES_PAUSED);
  assert.equal(trancheBlock("SENIOR_JUNIOR", { UPB_PARTICIPATIONS: "true" }), TRANCHES_PAUSED);
  assert.equal(trancheBlock("SENIOR_JUNIOR", ON), null);
  assert.equal(trancheBlock("PRO_RATA", OFF), null);
  assert.equal(trancheBlock(null, OFF), null);
  assert.match(TRANCHES_PAUSED, /counsel's review/);
  assert.match(TRANCHES_PAUSED, /can still drop out/);
  // The group actions read the flag from the server's environment.
  assert.equal(await withFlag(undefined, () => trancheBlock("SENIOR_JUNIOR")), TRANCHES_PAUSED);
  assert.equal(await withFlag("1", () => trancheBlock("SENIOR_JUNIOR")), null);
});

test("a new capital allocation is refused while the freeze holds", async () => {
  assert.equal(capitalAllocationBlock(OFF), CAPITAL_PAUSED);
  assert.equal(capitalAllocationBlock(ON), null);
  assert.match(CAPITAL_PAUSED, /waits on counsel's review/);
  assert.match(CAPITAL_PAUSED, /already made/);
  assert.equal(await withFlag(undefined, () => capitalAllocationBlock()), CAPITAL_PAUSED);
  assert.equal(await withFlag("1", () => capitalAllocationBlock()), null);
});

test("the FAQ says what the code does with the flag off and on", () => {
  const off = participationFaq(participationsOpen(OFF));
  // Off: no tranche can open, so "no waterfall" holds, and a partial relist is refused.
  assert.match(off.fund, /There is no waterfall and no investor portal/);
  assert.match(off.resale, /^Not yet\. Relisting a partial position/);
  assert.match(off.resale, /paused until counsel rules/);
  const on = participationFaq(participationsOpen(ON));
  // On: the senior slice and the desk's investor capital are both live, so the answer names them.
  assert.doesNotMatch(on.fund, /no waterfall/);
  assert.match(on.fund, /senior slice, paid first/);
  assert.match(on.fund, /capital from its own investors/);
  assert.match(on.fund, /no investor portal/);
  assert.match(on.resale, /^Yes\. A partial position, such as a group seat, can be relisted/);
});

test("the desk sees the Maryland prompt on a Maryland loan, and it is logged with the bid or the purchase", () => {
  assert.equal(marylandLoan({ state: " md " }), true);
  assert.equal(marylandLoan({ state: "VA" }), false);
  assert.equal(deskMaryland([{ state: "VA" }, { state: "MD" }]), true);
  assert.equal(deskMaryland([{ state: "VA" }]), false);
  assert.equal(deskEligibilityLog([{ state: "MD" }], "bid"), "Maryland prompt shown · desk bid");
  assert.equal(deskEligibilityLog([{ state: "MD" }], "purchase"), "Maryland prompt shown · desk purchase");
  assert.equal(deskEligibilityLog([{ state: "PA" }], "bid"), "");
  // The brief form is the one a buyer's bid confirmation carries.
  const md = { state: "MD", propertyType: "SFR", paymentStatus: "PERFORMING" };
  assert.deepEqual(confirmNotices(eligibilityFor([md], { entityType: "LLC" })), [MARYLAND_BRIEF]);
});

// ---------------------------------------------------------------------------------------------------------------
// The ROAD Act acknowledgement on a group seat, against the local test database.

// A pro buyer and a pool nothing seeded touches: a non-performing house in Pennsylvania and a performing loan in Maryland.
async function makeSeatDeal(homes: number) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const seller = await prisma.user.create({
    data: { email: `pf-seller-${tag}@example.org`, name: `seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  const buyer = await prisma.user.create({
    data: {
      email: `pf-buyer-${tag}@example.org`,
      name: `buyer ${tag}`,
      role: "BUYER",
      accountStatus: "APPROVED",
      passwordHash: "x",
      subscriptionTier: "PRO",
      subscriptionStatus: "ACTIVE",
    },
  });
  await prisma.buyerProfile.create({
    data: {
      userId: buyer.id,
      status: "APPROVED",
      entityType: "LLC",
      entityName: `Fund ${tag}`,
      homesControlled: homes,
      reoStrategy: "SELL",
      eligibilityAt: new Date(Date.now() - DAY),
    },
  });
  const loan = { city: "Testville", zip: "00000", occupancy: "VACANT", lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, askingPrice: 120000, estimatedValue: 260000 };
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: seller.id,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      title: `Seat screen ${tag}`,
      notes: {
        create: [
          { ...loan, streetAddress: "1 First St", state: "PA", propertyType: "SFR", paymentStatus: "NON_PERFORMING", monthsDelinquent: 9 },
          { ...loan, streetAddress: "2 Second St", state: "MD", propertyType: "SFR", paymentStatus: "PERFORMING", monthsDelinquent: 0 },
        ] as never,
      },
    },
    include: { notes: true },
  });
  return { tag, seller, buyer, listing };
}

async function cleanSeatDeal(deal: Awaited<ReturnType<typeof makeSeatDeal>>, groupId: string) {
  const userIds = [deal.seller.id, deal.buyer.id];
  await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: [deal.listing.id, groupId] } }] } });
  await prisma.listing.deleteMany({ where: { id: deal.listing.id } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test("a buyer with 350 or more homes takes no group seat until they acknowledge the notice, and the seat logs what they saw", async () => {
  const deal = await makeSeatDeal(400);
  const small = await makeSeatDeal(12);
  const groupId = `group-${deal.tag}`;
  try {
    const listingId = deal.listing.id;
    const refused = await seatEligibility(deal.buyer.id, listingId);
    assert.equal(refused.error, ACKNOWLEDGE_FIRST);
    assert.equal(refused.eligibility.acknowledge, true);
    // The Maryland loan in the pool shows its prompt on the seat too.
    assert.equal(refused.eligibility.maryland, true);

    // A buyer under the threshold sees the notice and is never asked.
    const under = await seatEligibility(small.buyer.id, small.listing.id);
    assert.equal(under.error, null);
    assert.equal(under.eligibility.road, true);
    assert.equal(under.eligibility.acknowledge, false);

    // A group on the performing Maryland loan alone has no ROAD notice to acknowledge.
    const maryland = deal.listing.notes.find((note) => note.state === "MD")!;
    const oneLoan = await seatEligibility(deal.buyer.id, listingId, maryland.id);
    assert.equal(oneLoan.error, null);
    assert.equal(oneLoan.eligibility.road, false);
    assert.equal(oneLoan.eligibility.maryland, true);

    // The acknowledgement the listing page takes is the one the seat reads.
    assert.equal((await acknowledgeRoad(deal.buyer, listingId)).error, null);
    const allowed = await seatEligibility(deal.buyer.id, listingId);
    assert.equal(allowed.error, null);
    assert.ok(allowed.acknowledgedAt);

    // A changed answer asks again.
    await prisma.buyerProfile.update({ where: { userId: deal.buyer.id }, data: { eligibilityAt: new Date(Date.now() + 1000) } });
    assert.equal((await seatEligibility(deal.buyer.id, listingId)).error, ACKNOWLEDGE_FIRST);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await acknowledgeRoad(deal.buyer, listingId)).error, null);
    const again = await seatEligibility(deal.buyer.id, listingId);
    assert.equal(again.error, null);

    await logSeatEligibility(deal.buyer.id, groupId, again);
    const log = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: "group", entityId: groupId, action: "ELIGIBILITY" } });
    assert.equal(log.actorId, deal.buyer.id);
    assert.match(log.detail, /ROAD notice shown · 400 homes stated · acknowledged .* · Maryland prompt shown/);
  } finally {
    await cleanSeatDeal(deal, groupId);
    await cleanSeatDeal(small, groupId);
  }
});
