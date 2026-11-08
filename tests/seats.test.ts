import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import bcrypt from "bcryptjs";
import { actionGate } from "../lib/action-gates";
import { announcementRecipients } from "../lib/announcements";
import { audit } from "../lib/audit";
import { dispatchRecipients } from "../lib/dispatch";
import { placeInquiry } from "../lib/bid-form";
import { prisma } from "../lib/prisma";
import {
  acceptSeatInvite,
  approveSeatBid,
  billingBlock,
  declineSeatBid,
  expireSeatApprovals,
  inviteSeat,
  openSeatInvite,
  overSeatLimit,
  ownAccounts,
  personId,
  removeSeat,
  resendSeatInvite,
  resolveSessionUser,
  revokeSeatInvite,
  seatBylines,
  seatGate,
  seatLimitBlock,
  seatsUnderFirms,
  secondFactorSubject,
  teamOf,
  updateSeat,
  withdrawSeatBid,
  type ActingUser,
} from "../lib/seats";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

// A firm buyer with four seats, a seller, and a live sealed listing whose deadline is two days out. Every address
// and title is tagged, so other test files running against the same database never meet these rows.
async function makeFirm() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const email = (prefix: string) => `seats-${prefix}-${tag}@example.org`;
  const seller = await prisma.user.create({ data: { email: email("seller"), name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x", emailConfirmedAt: new Date() } });
  const firm = await prisma.user.create({
    data: {
      email: email("firm"),
      name: `Firm owner ${tag}`,
      companyName: `First Test Bank ${tag}`,
      role: "BUYER",
      accountStatus: "APPROVED",
      passwordHash: "x",
      subscriptionTier: "PRO",
      subscriptionStatus: "ACTIVE",
      bidCapLifted: true,
      emailConfirmedAt: new Date(),
    },
  });
  await prisma.buyerProfile.create({ data: { userId: firm.id, status: "APPROVED", entityName: `First Test Bank ${tag}` } });
  const seat = (prefix: string, seatRole: string, limit: number | null = null) =>
    prisma.user.create({
      data: {
        email: email(prefix),
        name: `${prefix} ${tag}`,
        role: "BUYER",
        accountStatus: "APPROVED",
        passwordHash: "x",
        principalId: firm.id,
        seatRole,
        seatBidLimitCents: limit,
        seatAddedById: firm.id,
        seatAddedAt: new Date(),
        emailConfirmedAt: new Date(),
      },
    });
  const trader = await seat("trader", "TRADE", 5_000_000);
  const approver = await seat("approver", "APPROVE");
  const viewer = await seat("viewer", "VIEW");
  const manager = await seat("manager", "MANAGE");
  const deadline = new Date(Date.now() + 2 * DAY);
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 30 * DAY),
      bidMode: "SEALED",
      bidDeadline: deadline,
      title: `Seat test note ${tag}`,
      notes: {
        create: [{
          streetAddress: "1 Seat St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 90000, estimatedValue: 150000,
        }] as never,
      },
    },
  });
  return { tag, seller, firm, trader, approver, viewer, manager, listing, deadline, users: [seller, firm, trader, approver, viewer, manager] };
}

type Firm = Awaited<ReturnType<typeof makeFirm>>;

async function acting(id: string) {
  const resolved = await resolveSessionUser(id);
  assert.ok(resolved, `expected ${id} to resolve`);
  return resolved.user;
}

function bidForm(firm: Firm, amount: number) {
  const form = new FormData();
  form.set("listingId", firm.listing.id);
  form.set("type", "OFFER");
  form.set("amount", String(amount));
  form.set("message", "Seat test bid.");
  form.set("$ACTION_ID_abc", "dropped");
  return form;
}

async function cleanFirm(firm: Firm) {
  const extra = await prisma.user.findMany({ where: { OR: [{ principalId: firm.firm.id }, { email: { contains: firm.tag } }] }, select: { id: true, email: true } });
  const userIds = [...new Set([...firm.users.map((row) => row.id), ...extra.map((row) => row.id)])];
  const emails = [...new Set([...firm.users.map((row) => row.email), ...extra.map((row) => row.email)])];
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: firm.listing.id }, select: { id: true } })).map((row) => row.id);
  const approvalIds = (await prisma.seatApproval.findMany({ where: { principalId: firm.firm.id }, select: { id: true } })).map((row) => row.id);
  const inviteIds = (await prisma.seatInvite.findMany({ where: { principalId: firm.firm.id }, select: { id: true } })).map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: [firm.listing.id, ...inquiryIds, ...approvalIds, ...inviteIds, ...userIds] } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: firm.listing.id }, { inquiryId: { in: inquiryIds } }] } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: firm.listing.id } });
  await prisma.seatApproval.deleteMany({ where: { principalId: firm.firm.id } });
  await prisma.seatInvite.deleteMany({ where: { principalId: firm.firm.id } });
  await prisma.note.deleteMany({ where: { listingId: firm.listing.id } });
  await prisma.listing.deleteMany({ where: { id: firm.listing.id } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: emails } }, { subject: { contains: firm.tag } }] } });
  await prisma.serverSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const fakeUser = (actor?: { seatRole: string; bidLimitCents?: number | null }) =>
  ({
    id: "firm",
    role: "BUYER",
    email: "firm@example.org",
    emailConfirmedAt: new Date(),
    ...(actor ? { actor: { id: "seat", name: "Dana", email: "dana@example.org", seatRole: actor.seatRole, bidLimitCents: actor.bidLimitCents ?? null } } : {}),
  }) as unknown as ActingUser;

test("seatGate: view is refused everything, trade can't award or sign, approve and manage and the owner pass", async () => {
  const actions = ["bid", "list", "award", "sign", "message"] as const;
  for (const action of actions) {
    assert.equal(await seatGate(fakeUser(), action), null, `owner ${action}`);
    assert.match((await seatGate(fakeUser({ seatRole: "VIEW" }), action)) ?? "", /view only/, `view ${action}`);
    assert.equal(await seatGate(fakeUser({ seatRole: "APPROVE" }), action), null, `approve ${action}`);
    assert.equal(await seatGate(fakeUser({ seatRole: "MANAGE" }), action), null, `manage ${action}`);
    // A role this code doesn't know can only look.
    assert.match((await seatGate(fakeUser({ seatRole: "ADMIN" }), action)) ?? "", /view only/);
  }
  for (const action of ["bid", "list", "message"] as const) assert.equal(await seatGate(fakeUser({ seatRole: "TRADE" }), action), null);
  assert.match((await seatGate(fakeUser({ seatRole: "TRADE" }), "award")) ?? "", /can't accept awards\. An approving or managing seat, or the account owner, can\./);
  assert.match((await seatGate(fakeUser({ seatRole: "TRADE" }), "sign")) ?? "", /can't sign\. An approving or managing seat/);
  assert.match((await seatGate(fakeUser({ seatRole: "VIEW" }), "bid")) ?? "", /A trading, approving or managing seat, or the account owner, can do this\./);
  // The chain in lib/action-gates.ts carries the seat's refusal.
  assert.match((await actionGate(fakeUser({ seatRole: "VIEW" }), "message")) ?? "", /view only/);

  // The limit binds a trading seat only, above the figure in cents.
  const trader = fakeUser({ seatRole: "TRADE", bidLimitCents: 5_000_000 });
  assert.equal(overSeatLimit(trader, 50000), false);
  assert.equal(overSeatLimit(trader, 50000.01), true);
  assert.equal(overSeatLimit(fakeUser({ seatRole: "TRADE" }), 9e9), false);
  assert.equal(overSeatLimit(fakeUser({ seatRole: "APPROVE", bidLimitCents: 100 }), 9e9), false);
  assert.equal(overSeatLimit(fakeUser(), 9e9), false);
  assert.match(seatLimitBlock(trader, 60000) ?? "", /above your bid limit of \$50,000/);
  assert.equal(personId(trader), "seat");
  assert.equal(personId(fakeUser()), "firm");

  // Membership and billing are the owner's or a managing seat's.
  assert.equal(billingBlock(fakeUser()), null);
  assert.equal(billingBlock(fakeUser({ seatRole: "MANAGE" })), null);
  for (const seatRole of ["VIEW", "TRADE", "APPROVE"]) assert.match(billingBlock(fakeUser({ seatRole })) ?? "", /Only a managing seat or the account owner/);
});

test("the desk's account list puts each firm's seats under it and counts only accounts of their own", () => {
  const rows = [
    { id: "a", principalId: null },
    { id: "s1", principalId: "b" },
    { id: "b", principalId: null },
    { id: "s2", principalId: "a" },
    { id: "s3", principalId: "gone" },
    { id: "s4", principalId: "b" },
    // A removed seat keeps its row but isn't an account of its own.
    { id: "r1", principalId: null, seatAddedAt: new Date() },
  ];
  const listed = seatsUnderFirms(rows);
  assert.deepEqual(listed.rows.map((row) => row.id), ["a", "s2", "b", "s1", "s4", "s3", "r1"]);
  assert.equal(listed.accounts, 2);
});

test("seats get no announcement or dispatch of their own, since they read the firm's", async () => {
  const firm = await makeFirm();
  try {
    await prisma.user.updateMany({ where: { id: { in: [firm.firm.id, firm.trader.id] } }, data: { announcements: true, marketDispatch: true, notifyEmail: true } });
    const members = await announcementRecipients({ emails: [firm.firm.email, firm.trader.email] });
    assert.deepEqual(members.map((row) => row.email), [firm.firm.email]);
    const dispatch = await dispatchRecipients([firm.firm.id, firm.trader.id]);
    assert.deepEqual(dispatch.map((row) => row.id), [firm.firm.id]);
    // Counts of accounts leave out current seats and removed ones.
    await removeSeat(await acting(firm.firm.id), firm.viewer.id);
    const counted = await prisma.user.findMany({ where: { email: { contains: firm.tag }, ...ownAccounts() }, select: { id: true } });
    assert.deepEqual(counted.map((row) => row.id).sort(), [firm.seller.id, firm.firm.id].sort());
  } finally {
    await cleanFirm(firm);
  }
});

test("a session resolves to the firm with the seat as actor, and a locked firm or removed seat is out", async () => {
  const firm = await makeFirm();
  try {
    // An account of its own acts as itself.
    const own = await resolveSessionUser(firm.firm.id);
    assert.equal(own?.user.id, firm.firm.id);
    assert.equal(own?.user.actor, undefined);
    assert.equal(own?.person.id, firm.firm.id);

    // A seat acts as the firm, and the person is the seat.
    await prisma.user.update({ where: { id: firm.trader.id }, data: { totpEnabled: true } });
    const seat = await resolveSessionUser(firm.trader.id);
    assert.equal(seat?.user.id, firm.firm.id);
    assert.equal(seat?.user.companyName, firm.firm.companyName);
    assert.deepEqual(seat?.user.actor, { id: firm.trader.id, name: firm.trader.name, email: firm.trader.email, seatRole: "TRADE", bidLimitCents: 5_000_000 });
    assert.equal(seat?.person.id, firm.trader.id);
    // The second factor asked of a seat is its own, on the firm's standing.
    assert.deepEqual(secondFactorSubject(seat!), { role: "BUYER", email: firm.trader.email, totpEnabled: true, accountStatus: "APPROVED" });
    assert.equal(personId(seat!.user), firm.trader.id);

    // The firm locked or deleted takes its seats out with it, and back when it is reinstated.
    await prisma.user.update({ where: { id: firm.firm.id }, data: { accountStatus: "SUSPENDED" } });
    assert.equal(await resolveSessionUser(firm.trader.id), null);
    await prisma.user.update({ where: { id: firm.firm.id }, data: { accountStatus: "APPROVED", deletedAt: new Date() } });
    assert.equal(await resolveSessionUser(firm.trader.id), null);
    await prisma.user.update({ where: { id: firm.firm.id }, data: { deletedAt: null } });
    assert.equal((await resolveSessionUser(firm.trader.id))?.user.id, firm.firm.id);

    // A seat whose role doesn't match its firm, a seat of a seat, and a desk seat are all refused.
    await prisma.user.update({ where: { id: firm.viewer.id }, data: { role: "INSTITUTIONAL_SELLER" } });
    assert.equal(await resolveSessionUser(firm.viewer.id), null);
    const nested = await prisma.user.create({ data: { email: `seats-nested-${firm.tag}@example.org`, name: "Nested", role: "BUYER", accountStatus: "APPROVED", passwordHash: "x", principalId: firm.trader.id, seatRole: "MANAGE", seatAddedAt: new Date() } });
    assert.equal(await resolveSessionUser(nested.id), null);

    // Removing a seat ends its sessions, clears principalId, and it can't act even if its lock were lifted.
    await prisma.serverSession.create({ data: { id: crypto.randomUUID(), userId: firm.trader.id, expiresAt: new Date(Date.now() + DAY) } });
    const manager = await acting(firm.manager.id);
    assert.match((await removeSeat(manager, firm.manager.id)).error ?? "", /your own seat/);
    assert.match((await removeSeat(await acting(firm.approver.id), firm.trader.id)).error ?? "", /Only a managing seat/);
    assert.equal((await removeSeat(manager, firm.trader.id)).error, null);
    const removed = await prisma.user.findUniqueOrThrow({ where: { id: firm.trader.id } });
    assert.equal(removed.principalId, null);
    assert.equal(removed.accountStatus, "SUSPENDED");
    assert.equal(await prisma.serverSession.count({ where: { userId: firm.trader.id } }), 0);
    assert.equal(await resolveSessionUser(firm.trader.id), null);
    await prisma.user.update({ where: { id: firm.trader.id }, data: { accountStatus: "APPROVED" } });
    assert.equal(await resolveSessionUser(firm.trader.id), null);
    assert.match((await removeSeat(manager, firm.trader.id)).error ?? "", /isn't on this account/);
    // The audit log names the seat that did it, with the firm as the actor.
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "SEAT_REMOVED", entityId: firm.trader.id } });
    assert.equal(event.actorId, firm.firm.id);
    assert.equal(event.seatId, firm.manager.id);
  } finally {
    await cleanFirm(firm);
  }
});

test("a trading seat's bid above its limit waits; approving places it with every check, declining doesn't", async () => {
  const firm = await makeFirm();
  try {
    const trader = await acting(firm.trader.id);
    const approver = await acting(firm.approver.id);
    const viewer = await acting(firm.viewer.id);
    const count = () => prisma.inquiry.count({ where: { listingId: firm.listing.id } });

    // A view seat can't bid at all.
    const refused = await placeInquiry(viewer, bidForm(firm, 1000));
    assert.match(refused.error ?? "", /view only/);
    assert.equal(await count(), 0);

    // Inside the limit the bid goes straight in, and the firm's offer book says who placed it.
    const placed = await placeInquiry(trader, bidForm(firm, 40000));
    assert.equal(placed.error, null);
    assert.ok(placed.inquiryId);
    const direct = await prisma.inquiry.findUniqueOrThrow({ where: { id: placed.inquiryId! } });
    assert.equal(direct.buyerId, firm.firm.id);
    assert.equal(Number(direct.amount), 40000);
    const tagged = await prisma.auditEvent.findFirstOrThrow({ where: { action: "SEAT_BID", entityId: direct.id } });
    assert.equal(tagged.actorId, firm.firm.id);
    assert.equal(tagged.seatId, firm.trader.id);

    // Above it, nothing is placed. The form waits, closing at the deadline, and the approvers hear.
    const held = await placeInquiry(trader, bidForm(firm, 60000));
    assert.equal(held.error, null);
    assert.ok(held.heldId);
    assert.equal(await count(), 1);
    const row = await prisma.seatApproval.findUniqueOrThrow({ where: { id: held.heldId! } });
    assert.equal(row.status, "PENDING");
    assert.equal(row.requestedById, firm.trader.id);
    assert.equal(row.amountCents, 6_000_000);
    assert.equal(row.expiresAt?.getTime(), firm.deadline.getTime());
    assert.equal((row.payload as Record<string, string>).amount, "60000");
    assert.equal((row.payload as Record<string, string>).$ACTION_ID_abc, undefined);
    assert.equal(await prisma.notification.count({ where: { toEmail: { in: [firm.firm.email, firm.approver.email, firm.manager.email] }, subject: { contains: firm.tag } } }), 3);
    assert.equal(await prisma.notification.count({ where: { toEmail: { in: [firm.viewer.email, firm.trader.email] }, subject: { contains: "waiting for approval" } } }), 0);
    // One held bid per seat and listing.
    assert.match((await placeInquiry(trader, bidForm(firm, 61000))).error ?? "", /already waiting/);

    // Nobody decides their own bid, and a view or trading seat decides none.
    assert.match((await approveSeatBid(trader, row.id)).error ?? "", /approving or managing seat/);
    await prisma.user.update({ where: { id: firm.trader.id }, data: { seatRole: "APPROVE" } });
    assert.match((await approveSeatBid(await acting(firm.trader.id), row.id)).error ?? "", /your own bid/);
    await prisma.user.update({ where: { id: firm.trader.id }, data: { seatRole: "TRADE" } });
    assert.match((await approveSeatBid(viewer, row.id)).error ?? "", /approving or managing seat/);

    // Every bid check runs again when it is approved: a buyer file no longer approved stops it, and it waits again.
    await prisma.buyerProfile.update({ where: { userId: firm.firm.id }, data: { status: "SUBMITTED" } });
    assert.match((await approveSeatBid(approver, row.id)).error ?? "", /buyer file/);
    assert.equal((await prisma.seatApproval.findUniqueOrThrow({ where: { id: row.id } })).status, "PENDING");
    assert.equal(await count(), 1);
    await prisma.buyerProfile.update({ where: { userId: firm.firm.id }, data: { status: "APPROVED" } });

    // Approved, the bid is placed for the firm through the same path, and only once.
    const approved = await approveSeatBid(approver, row.id);
    assert.equal(approved.error, null);
    assert.equal(await count(), 2);
    const after = await prisma.seatApproval.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after.status, "APPROVED");
    assert.equal(after.decidedById, firm.approver.id);
    assert.ok(after.inquiryId);
    const bid = await prisma.inquiry.findUniqueOrThrow({ where: { id: after.inquiryId! } });
    assert.equal(bid.buyerId, firm.firm.id);
    assert.equal(Number(bid.amount), 60000);
    assert.match((await approveSeatBid(approver, row.id)).error ?? "", /already decided/);
    assert.equal(await count(), 2);
    const lines = await seatBylines(firm.firm.id, [direct.id, bid.id]);
    assert.equal(lines.get(direct.id), `by ${firm.trader.name}`);
    assert.equal(lines.get(bid.id), `by ${firm.trader.name}, approved by ${firm.approver.name}`);

    // Declined, nothing is placed, and the seat has the reason.
    const second = await placeInquiry(trader, bidForm(firm, 70000));
    assert.ok(second.heldId);
    assert.match((await declineSeatBid(approver, second.heldId!, "no")).error ?? "", /Say why/);
    assert.match((await declineSeatBid(trader, second.heldId!, "Too rich for us")).error ?? "", /approving or managing seat/);
    assert.equal((await declineSeatBid(await acting(firm.firm.id), second.heldId!, "Too rich for us")).error, null);
    const declined = await prisma.seatApproval.findUniqueOrThrow({ where: { id: second.heldId! } });
    assert.equal(declined.status, "DECLINED");
    assert.equal(declined.reason, "Too rich for us");
    assert.equal(declined.decidedById, firm.firm.id);
    assert.equal(await count(), 2);
    assert.match((await approveSeatBid(approver, second.heldId!)).error ?? "", /already decided/);
    assert.equal(await prisma.notification.count({ where: { toEmail: firm.trader.email, subject: { contains: "Bid declined" } } }), 1);

    // The seat that asked can withdraw, and no one else can.
    const third = await placeInquiry(trader, bidForm(firm, 65000));
    assert.ok(third.heldId);
    assert.match((await withdrawSeatBid(approver, third.heldId!)).error ?? "", /isn't yours/);
    assert.equal((await withdrawSeatBid(trader, third.heldId!)).error, null);
    assert.equal((await prisma.seatApproval.findUniqueOrThrow({ where: { id: third.heldId! } })).status, "WITHDRAWN");
    assert.match((await approveSeatBid(approver, third.heldId!)).error ?? "", /already decided/);
    assert.equal(await count(), 2);

    // A changed limit applies on the seat's next request.
    assert.equal((await updateSeat({ account: await acting(firm.manager.id), seatId: firm.trader.id, seatRole: "TRADE", bidLimit: "$100,000" })).error, null);
    assert.equal((await acting(firm.trader.id)).actor?.bidLimitCents, 10_000_000);
    assert.match((await updateSeat({ account: approver, seatId: firm.trader.id, seatRole: "MANAGE" })).error ?? "", /Only a managing seat/);
  } finally {
    await cleanFirm(firm);
  }
});

test("a held bid expires at the listing's deadline, by the job or when someone tries to approve it late", async () => {
  const firm = await makeFirm();
  try {
    const trader = await acting(firm.trader.id);
    const approver = await acting(firm.approver.id);
    const first = await placeInquiry(trader, bidForm(firm, 60000));
    assert.ok(first.heldId);
    // Before the deadline the job leaves it.
    await expireSeatApprovals(new Date(firm.deadline.getTime() - 60 * 1000));
    assert.equal((await prisma.seatApproval.findUniqueOrThrow({ where: { id: first.heldId! } })).status, "PENDING");
    await expireSeatApprovals(new Date(firm.deadline.getTime() + 60 * 1000));
    assert.equal((await prisma.seatApproval.findUniqueOrThrow({ where: { id: first.heldId! } })).status, "EXPIRED");
    assert.equal(await prisma.notification.count({ where: { toEmail: firm.trader.email, subject: { contains: "Bid not placed" } } }), 1);
    assert.match((await approveSeatBid(approver, first.heldId!)).error ?? "", /already decided/);

    // Approved after the deadline, it expires on the spot and nothing is placed.
    const second = await placeInquiry(trader, bidForm(firm, 62000));
    assert.ok(second.heldId);
    assert.match((await approveSeatBid(approver, second.heldId!, new Date(firm.deadline.getTime() + 1000))).error ?? "", /deadline passed/);
    assert.equal((await prisma.seatApproval.findUniqueOrThrow({ where: { id: second.heldId! } })).status, "EXPIRED");
    assert.equal(await prisma.inquiry.count({ where: { listingId: firm.listing.id } }), 0);
  } finally {
    await cleanFirm(firm);
  }
});

test("an invitation stores only its hash, lasts seven days, refuses taken addresses, and opens a seat", async () => {
  const firm = await makeFirm();
  try {
    const owner = await acting(firm.firm.id);
    const address = `seats-new-${firm.tag}@example.org`;
    // Only the owner or a managing seat invites, and an address with its own account can't take a seat.
    assert.match((await inviteSeat({ account: await acting(firm.approver.id), email: address, seatRole: "TRADE" })).error ?? "", /Only a managing seat/);
    assert.match((await inviteSeat({ account: owner, email: firm.seller.email, seatRole: "VIEW" })).error ?? "", /already has an account/);
    assert.match((await inviteSeat({ account: owner, email: address, seatRole: "OWNER" })).error ?? "", /Choose view, trade/);
    assert.match((await inviteSeat({ account: owner, email: address, seatRole: "TRADE", bidLimit: "-5" })).error ?? "", /bid limit/);
    // An account the desk hasn't approved invites nobody, and a personal seller has no seats at all.
    assert.match((await inviteSeat({ account: { ...owner, accountStatus: "PENDING" }, email: address, seatRole: "VIEW" })).error ?? "", /desk approves/);
    assert.match((await inviteSeat({ account: await acting(firm.seller.id), email: address, seatRole: "VIEW" })).error ?? "", /Seats are for firms/);

    const sent = await inviteSeat({ account: await acting(firm.manager.id), email: address.toUpperCase(), name: "New Analyst", seatRole: "TRADE", bidLimit: "25000" });
    assert.equal(sent.error, null);
    const { token, inviteId } = sent as { token: string; inviteId: string };
    const stored = await prisma.seatInvite.findUniqueOrThrow({ where: { id: inviteId } });
    assert.equal(stored.email, address);
    assert.equal(stored.tokenHash, createHash("sha256").update(token).digest("hex"));
    assert.notEqual(stored.tokenHash, token);
    assert.equal(stored.bidLimitCents, 2_500_000);
    assert.equal(stored.invitedById, firm.manager.id);
    assert.ok(Math.abs(stored.expiresAt.getTime() - (Date.now() + 7 * DAY)) < 60 * 1000);
    assert.match((await inviteSeat({ account: owner, email: address, seatRole: "VIEW" })).error ?? "", /open invitation/);
    assert.deepEqual(await openSeatInvite(token), { state: "open", email: address, name: "New Analyst", seatRole: "TRADE", firm: firm.firm.companyName });

    // A resend replaces the link.
    const again = await resendSeatInvite(owner, inviteId);
    assert.equal(again.error, null);
    const fresh = (again as { token: string }).token;
    assert.equal((await openSeatInvite(token)).state, "closed");
    assert.equal((await openSeatInvite(fresh)).state, "open");

    // The form's own checks, then the seat opens with the address proved and the firm's role.
    const accept = (over: Partial<{ token: string; name: string; password: string; confirm: string; terms: string | null }> = {}) =>
      acceptSeatInvite({ token: fresh, name: "Nia Analyst", password: "a-long-password", confirm: "a-long-password", terms: "yes", ...over });
    assert.match((await accept({ password: "short", confirm: "short" })).error ?? "", /8 characters/);
    assert.match((await accept({ confirm: "different-password" })).error ?? "", /do not match/);
    assert.match((await accept({ terms: null })).error ?? "", /./);
    assert.match((await accept({ token })).error ?? "", /expired/);
    const opened = await accept();
    assert.equal(opened.error, null);
    const seatId = (opened as { user: { id: string } }).user.id;
    const seat = await prisma.user.findUniqueOrThrow({ where: { id: seatId } });
    assert.equal(seat.email, address);
    assert.equal(seat.name, "Nia Analyst");
    assert.equal(seat.role, "BUYER");
    assert.equal(seat.principalId, firm.firm.id);
    assert.equal(seat.seatRole, "TRADE");
    assert.equal(seat.seatBidLimitCents, 2_500_000);
    assert.ok(seat.emailConfirmedAt);
    assert.ok(seat.termsVersion);
    assert.ok(await bcrypt.compare("a-long-password", seat.passwordHash));
    assert.equal((await resolveSessionUser(seatId))?.user.id, firm.firm.id);
    const used = await prisma.seatInvite.findUniqueOrThrow({ where: { id: inviteId } });
    assert.ok(used.acceptedAt);
    assert.equal(used.acceptedById, seatId);
    assert.ok((await accept()).error?.includes("expired"));
    assert.equal((await openSeatInvite(fresh)).state, "closed");

    // A link past its seven days, or withdrawn, opens nothing.
    const old = await inviteSeat({ account: owner, email: `seats-old-${firm.tag}@example.org`, seatRole: "VIEW", now: new Date(Date.now() - 8 * DAY) });
    assert.equal(old.error, null);
    assert.equal((await openSeatInvite((old as { token: string }).token)).state, "closed");
    assert.ok((await acceptSeatInvite({ token: (old as { token: string }).token, name: "Late Larry", password: "a-long-password", confirm: "a-long-password", terms: "yes" })).error?.includes("expired"));
    const pulled = await inviteSeat({ account: owner, email: `seats-pulled-${firm.tag}@example.org`, seatRole: "VIEW" });
    assert.equal((await revokeSeatInvite(owner, (pulled as { inviteId: string }).inviteId)).error, null);
    assert.equal((await openSeatInvite((pulled as { token: string }).token)).state, "closed");
    // The team page lists invitations still out, lapsed ones marked, and the seat that joined.
    const team = await teamOf(firm.firm.id);
    assert.deepEqual(team.invites.map((invite) => [invite.id, invite.lapsed]), [[(old as { inviteId: string }).inviteId, true]]);
    assert.ok(team.seats.some((row) => row.id === seatId));

    // A removed seat's address can be invited back, and accepting reattaches the same row.
    assert.equal((await removeSeat(owner, seatId)).error, null);
    const back = await inviteSeat({ account: owner, email: address, seatRole: "VIEW" });
    assert.equal(back.error, null);
    const rejoined = await acceptSeatInvite({ token: (back as { token: string }).token, name: "Nia Analyst", password: "another-password", confirm: "another-password", terms: "yes" });
    assert.equal(rejoined.error, null);
    assert.equal((rejoined as { user: { id: string } }).user.id, seatId);
    const resolved = await resolveSessionUser(seatId);
    assert.equal(resolved?.user.actor?.seatRole, "VIEW");
    assert.equal(resolved?.user.actor?.bidLimitCents, null);
  } finally {
    await cleanFirm(firm);
  }
});

test("an audit event outside a request names no seat unless the caller does", async () => {
  const firm = await makeFirm();
  try {
    await audit(firm.firm.id, "SEAT_TEST", "user", firm.firm.id, firm.tag);
    await audit(firm.firm.id, "SEAT_TEST", "user", firm.firm.id, firm.tag, firm.trader.id);
    const events = await prisma.auditEvent.findMany({ where: { action: "SEAT_TEST", entityId: firm.firm.id } });
    assert.equal(events.length, 2);
    assert.equal(events.filter((event) => event.seatId === firm.trader.id).length, 1);
    assert.equal(events.filter((event) => !event.seatId).length, 1);
  } finally {
    await cleanFirm(firm);
  }
});
