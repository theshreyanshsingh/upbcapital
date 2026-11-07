import assert from "node:assert/strict";
import test from "node:test";
import { deskWalled, hideCompetingBids } from "../lib/auction";
import { auditCsv, auditExport, auditFilterFrom, auditPage, auditQuery } from "../lib/audit-log";
import { bidSheetFor } from "../lib/bid-sheet";
import { openClosing } from "../lib/closing-service";
import { literal } from "../lib/db-filters";
import { DESK_ROLES, canOwnDeals, deskCan, deskPowers, deskRoleOf, deskWrites, type DeskCapability } from "../lib/desk-roles";
import { prisma } from "../lib/prisma";
import { saleFile, saleFileCsv, saleFilePdf } from "../lib/sale-file";
import { assignDealOwner, deskContact, deskRoleProblem, setDeskRole } from "../lib/staff";
import { decideWireChange, pendingWireChanges, proposeWireChange } from "../lib/wire-changes";

const DAY = 24 * 60 * 60 * 1000;
// Desk and buyer notices stay in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// The capability matrix, as pure rules.

const ALL: DeskCapability[] = ["sales", "sealedBids", "closings", "approveWires", "compliance", "deskBook", "admin", "content"];

test("each desk role covers its own work, an account with no role is an owner, and nobody else is desk staff", () => {
  const expected: Record<string, DeskCapability[]> = {
    OWNER: ALL,
    SALES: ["sales", "sealedBids", "content"],
    CLOSINGS: ["closings", "approveWires"],
    COMPLIANCE: ["compliance", "approveWires"],
    TRADER: ["deskBook"],
    ANALYST: [],
  };
  for (const role of DESK_ROLES) {
    const user = { role: "ADMIN", deskRole: role };
    for (const capability of ALL) assert.equal(deskCan(user, capability), expected[role].includes(capability), `${role} ${capability}`);
    assert.equal(deskWrites(user), role !== "ANALYST");
  }
  // Accounts from before roles keep every power.
  assert.equal(deskRoleOf({ role: "ADMIN" }), "OWNER");
  assert.equal(deskRoleOf({ role: "ADMIN", deskRole: null }), "OWNER");
  assert.equal(deskRoleOf({ role: "ADMIN", deskRole: "NONSENSE" }), "OWNER");
  assert.deepEqual(deskPowers({ role: "ADMIN" }), ALL);
  // A buyer or seller with a stray deskRole is still not desk staff.
  assert.equal(deskRoleOf({ role: "BUYER", deskRole: "OWNER" }), null);
  assert.equal(deskCan({ role: "BUYER", deskRole: "OWNER" }, "sales"), false);
  assert.equal(deskCan(null, "sales"), false);
  // The two separations the roles exist for.
  assert.ok(!DESK_ROLES.some((role) => deskCan({ role: "ADMIN", deskRole: role }, "sealedBids") && deskCan({ role: "ADMIN", deskRole: role }, "deskBook") && role !== "OWNER"));
  assert.equal(canOwnDeals({ role: "ADMIN", deskRole: "TRADER" }), false);
  assert.equal(canOwnDeals({ role: "ADMIN", deskRole: "CLOSINGS" }), true);
});

test("only an owner sets roles, and the last owner who can sign in can't be demoted", () => {
  const owner = { id: "o1", role: "ADMIN", deskRole: null };
  const other = { id: "o2", role: "ADMIN", deskRole: "OWNER" };
  const sales = { id: "s1", role: "ADMIN", deskRole: "SALES" };
  assert.match(deskRoleProblem({ actor: sales, target: owner, role: "ANALYST", owners: [owner, sales] }) ?? "", /doesn't cover this/);
  assert.match(deskRoleProblem({ actor: owner, target: owner, role: "SALES", owners: [owner, sales] }) ?? "", /at least one owner/);
  // A suspended second owner doesn't count, since nobody could use the account.
  assert.match(deskRoleProblem({ actor: owner, target: owner, role: "SALES", owners: [owner, { ...other, accountStatus: "SUSPENDED" }] }) ?? "", /at least one owner/);
  assert.equal(deskRoleProblem({ actor: owner, target: owner, role: "SALES", owners: [owner, other] }), null);
  assert.equal(deskRoleProblem({ actor: owner, target: owner, role: "OWNER", owners: [owner] }), null);
  assert.equal(deskRoleProblem({ actor: owner, target: sales, role: "TRADER", owners: [owner] }), null);
  assert.match(deskRoleProblem({ actor: owner, target: sales, role: "BOSS", owners: [owner] }) ?? "", /Choose a desk role/);
  assert.match(deskRoleProblem({ actor: owner, target: { id: "b", role: "BUYER" }, role: "SALES", owners: [owner] }) ?? "", /for desk accounts/);
});

test("the sealed wall: before the deadline only a role that reads sealed bids sees amounts, and the book's buyer stays out until the sale is decided", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const sealed = { bidMode: "SEALED", bidDeadline: new Date(now.getTime() + DAY), status: "APPROVED" };
  const final = { bidMode: "BEST_AND_FINAL", bidDeadline: new Date(now.getTime() + DAY), status: "APPROVED" };
  const past = { bidMode: "SEALED", bidDeadline: new Date(now.getTime() - DAY), status: "APPROVED" };
  const open = { bidMode: "NONE", bidDeadline: null, status: "APPROVED" };
  const as = (deskRole: string | null) => ({ role: "ADMIN", deskRole });
  for (const listing of [sealed, final]) {
    assert.equal(deskWalled(listing, as("TRADER"), now), true);
    assert.equal(deskWalled(listing, as("ANALYST"), now), true);
    assert.equal(deskWalled(listing, as("COMPLIANCE"), now), true);
    assert.equal(deskWalled(listing, as("SALES"), now), false);
    assert.equal(deskWalled(listing, as(null), now), false);
  }
  // After the deadline an analyst reads the round, but a trader who could still bid for the book does not.
  assert.equal(deskWalled(past, as("ANALYST"), now), false);
  assert.equal(deskWalled(past, as("TRADER"), now), true);
  assert.equal(deskWalled({ ...past, status: "SOLD" }, as("TRADER"), now), false);
  assert.equal(deskWalled(open, as("TRADER"), now), false);
  // Buyers and sellers keep the rules they had.
  assert.equal(deskWalled(sealed, { role: "BUYER" }, now), false);
  assert.equal(hideCompetingBids({ bidMode: "SEALED", deadline: sealed.bidDeadline, isDesk: deskCan(as("TRADER"), "sealedBids"), now }), true);
  assert.equal(hideCompetingBids({ bidMode: "SEALED", deadline: sealed.bidDeadline, isDesk: deskCan(as("SALES"), "sealedBids"), now }), false);
});

test("the audit filter reads its parameters safely and round-trips them", () => {
  const filter = auditFilterFrom({ actor: " Jane ", action: "wire_edit; drop", entityType: "closing$", entityId: "abc{}123", from: "2026-11-01", to: "not a date" });
  assert.deepEqual(filter, { actor: "Jane", action: "WIRE_EDITDROP", entityType: "closing", entityId: "abc123", from: "2026-11-01", to: "" });
  assert.equal(auditQuery(filter, 3), "actor=Jane&action=WIRE_EDITDROP&entityType=closing&entityId=abc123&from=2026-11-01&page=3");
  assert.equal(auditQuery(auditFilterFrom(new URLSearchParams("")), 1), "");
  const csv = auditCsv([{ id: "e1", createdAt: new Date("2026-11-07T10:00:00Z"), actorId: null, actor: null, action: "AWARD", entityType: "inquiry", entityId: "i1", detail: "=SUM(A1)" }]);
  const [header, line] = csv.split("\n");
  assert.equal(header, "time_utc,actor,actor_email,actor_id,action,entity_type,entity_id,detail,event_id");
  // A detail that would run as a formula is defused.
  assert.equal(line, "2026-11-07T10:00:00.000Z,System,,,AWARD,inquiry,i1,'=SUM(A1),e1");
  assert.match(auditCsv([]), /^time_utc,actor/);
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged desk staff, seller, buyers and listings nothing seeded touches.

async function makeDesk() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN", deskRole?: string) =>
    prisma.user.create({
      data: {
        email: `gov-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(deskRole ? { deskRole } : {}),
      },
    });
  const owner = await person("owner", "ADMIN");
  const owner2 = await person("owner2", "ADMIN", "OWNER");
  const sales = await person("sales", "ADMIN", "SALES");
  const closer = await person("closer", "ADMIN", "CLOSINGS");
  const compliance = await person("compliance", "ADMIN", "COMPLIANCE");
  const trader = await person("trader", "ADMIN", "TRADER");
  const analyst = await person("analyst", "ADMIN", "ANALYST");
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const buyer = await person("buyer", "BUYER");
  const rival = await person("rival", "BUYER");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED", entityType: "LLC", entityName: `Fund ${tag}`, homesControlled: 4, reoStrategy: "SELL" } });
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 7 * DAY),
      title: `Governance ${tag}`,
      bidMode: "SEALED",
      bidDeadline: new Date(Date.now() + 2 * DAY),
      reservePrice: 100000,
      deskOwnerId: sales.id,
      notes: {
        create: [{
          streetAddress: "1 First St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000,
        }] as never,
      },
    },
    include: { notes: true },
  });
  const users = [owner, owner2, sales, closer, compliance, trader, analyst, seller, buyer, rival];
  return { tag, owner, owner2, sales, closer, compliance, trader, analyst, seller, buyer, rival, listing, users, startedAt: new Date(Date.now() - 1000) };
}

type Desk = Awaited<ReturnType<typeof makeDesk>>;

async function cleanDesk(fixture: Desk) {
  const userIds = fixture.users.map((user) => user.id);
  const listingIds = [fixture.listing.id];
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.wireChange.deleteMany({ where: { proposedById: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...inquiryIds, ...closingIds, ...userIds, `gov-${fixture.tag}`] } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { inquiryId: { in: inquiryIds } }, { closingId: { in: closingIds } }] } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({
    where: {
      OR: [
        { toEmail: { in: fixture.users.map((user) => user.email) } },
        { subject: { contains: literal(fixture.tag) } },
        { subject: "Wire change to approve · the desk default", createdAt: { gte: fixture.startedAt } },
      ],
    },
  });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function bid(fixture: Desk, buyerId: string, amount: number, extra: Record<string, unknown> = {}) {
  const inquiry = await prisma.inquiry.create({
    data: { listingId: fixture.listing.id, buyerId, type: "OFFER", noteId: fixture.listing.notes[0].id, amount, status: "OPEN", expiresAt: new Date(Date.now() + 10 * DAY), ...extra },
  });
  await prisma.offerMessage.create({ data: { inquiryId: inquiry.id, authorId: buyerId, kind: "OFFER", amount, body: "Opening bid." } });
  return inquiry;
}

test("a role change is audited, and an owner may step down while another owner remains", async () => {
  const fixture = await makeDesk();
  try {
    const refused = await setDeskRole(fixture.sales, fixture.analyst.id, "SALES");
    assert.match(refused.error ?? "", /doesn't cover this/);
    const changed = await setDeskRole(fixture.owner, fixture.analyst.id, "COMPLIANCE");
    assert.deepEqual(changed, { error: null, changed: true });
    assert.equal((await prisma.user.findUnique({ where: { id: fixture.analyst.id } }))?.deskRole, "COMPLIANCE");
    const event = await prisma.auditEvent.findFirst({ where: { action: "DESK_ROLE", entityId: fixture.analyst.id } });
    assert.match(event?.detail ?? "", /Read only to Compliance/);
    assert.equal(event?.actorId, fixture.owner.id);
    assert.deepEqual(await setDeskRole(fixture.owner, fixture.analyst.id, "COMPLIANCE"), { error: null, changed: false });
    assert.match((await setDeskRole(fixture.owner, fixture.seller.id, "SALES")).error ?? "", /for desk accounts/);
    // With a second owner on file, an owner may step down; the database check runs the same rule as above.
    assert.deepEqual(await setDeskRole(fixture.owner, fixture.owner.id, "ANALYST"), { error: null, changed: true });
    // Stepped down, they no longer set roles. Actions read the actor fresh from the database, as here.
    const demoted = await prisma.user.findUniqueOrThrow({ where: { id: fixture.owner.id } });
    assert.match((await setDeskRole(demoted, fixture.owner2.id, "SALES")).error ?? "", /doesn't cover this/);
  } finally {
    await cleanDesk(fixture);
  }
});

test("a trader sees no sealed amounts or bid sheet before the deadline, sales does, and the sale file keeps the wall", async () => {
  const fixture = await makeDesk();
  try {
    await bid(fixture, fixture.buyer.id, 110017);
    await bid(fixture, fixture.rival.id, 90000);
    const premium = 300;
    assert.equal(await bidSheetFor(fixture.trader, fixture.listing.id, premium), null);
    assert.equal(await bidSheetFor(fixture.analyst, fixture.listing.id, premium), null);
    const sheet = await bidSheetFor(fixture.sales, fixture.listing.id, premium);
    assert.deepEqual(sheet?.map((row) => row.amount), [110017, 90000]);
    // An account from before roles reads it too.
    assert.equal((await bidSheetFor(fixture.owner, fixture.listing.id, premium))?.length, 2);

    const walled = await saleFile(fixture.listing.id, fixture.trader);
    assert.ok(walled);
    assert.equal(walled.walled, true);
    assert.ok(walled.rows.filter((row) => row.section === "Bid").every((row) => row.amount === null && row.reserveMet === ""));
    assert.equal(walled.rows.find((row) => row.section === "Reserve")?.amount, null);
    const csv = saleFileCsv(walled);
    assert.ok(!csv.includes("110017"));
    assert.match(csv, /Sealed until the deadline/);
    const open = await saleFile(fixture.listing.id, fixture.sales);
    assert.deepEqual(open?.rows.filter((row) => row.section === "Bid").map((row) => row.amount), [110017, 90000]);
  } finally {
    await cleanDesk(fixture);
  }
});

test("a wire change waits for a second desk member, the proposer can't approve it, and it applies only on approval", async () => {
  const fixture = await makeDesk();
  try {
    const inquiry = await bid(fixture, fixture.buyer.id, 110000, { status: "ACCEPTED" });
    const closing = await openClosing({ listingId: fixture.listing.id, inquiryId: inquiry.id, noteId: fixture.listing.notes[0].id, salePrice: 110000, title: fixture.listing.title });
    const before = (await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).wireInstructions;

    // A trader or an analyst doesn't propose closing wires.
    assert.match((await proposeWireChange(fixture.trader, { closingId: closing.id, instructions: "Bank X" })).error ?? "", /doesn't cover this/);
    const proposed = await proposeWireChange(fixture.closer, { closingId: closing.id, instructions: `Bank of Test ${fixture.tag}\nABA 000000000`, reason: "New escrow agent" });
    assert.equal(proposed.error, null);
    assert.ok(proposed.change);
    // Nothing changes until approval, and nobody outside the desk is told yet.
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).wireInstructions, before);
    assert.equal(await prisma.notification.count({ where: { toEmail: { in: [fixture.buyer.email, fixture.seller.email] }, subject: { startsWith: "Wires changed" } } }), 0);
    assert.equal((await pendingWireChanges(closing.id)).length, 1);
    assert.equal((await pendingWireChanges(closing.id))[0].proposedBy, fixture.closer.name);
    // One change at a time.
    assert.match((await proposeWireChange(fixture.owner, { closingId: closing.id, instructions: "Another bank" })).error ?? "", /already waiting/);
    // The same text again is no change at all.
    assert.deepEqual(await proposeWireChange(fixture.closer, { closingId: closing.id, instructions: `  ${before}  ` }), { error: null, change: null });

    const changeId = proposed.change!.id;
    assert.match((await decideWireChange(fixture.closer, { changeId, decision: "APPROVED" })).error ?? "", /another desk member approves/);
    assert.match((await decideWireChange(fixture.analyst, { changeId, decision: "APPROVED" })).error ?? "", /doesn't cover this/);
    assert.match((await decideWireChange(fixture.sales, { changeId, decision: "APPROVED" })).error ?? "", /doesn't cover this/);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).wireInstructions, before);

    const approved = await decideWireChange(fixture.compliance, { changeId, decision: "APPROVED" });
    assert.deepEqual(approved, { error: null, applied: true });
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).wireInstructions, `Bank of Test ${fixture.tag}\nABA 000000000`);
    const row = await prisma.wireChange.findUniqueOrThrow({ where: { id: changeId } });
    assert.equal(row.status, "APPROVED");
    assert.equal(row.decidedById, fixture.compliance.id);
    // Both sides are told, as before the change needed a second pair of eyes.
    for (const email of [fixture.buyer.email, fixture.seller.email]) {
      assert.equal(await prisma.notification.count({ where: { toEmail: email, subject: `Wires changed · ${fixture.listing.title}` } }), 1);
    }
    const actions = (await prisma.auditEvent.findMany({ where: { entityId: closing.id, action: { startsWith: "WIRE_" } } })).map((event) => event.action).sort();
    assert.deepEqual(actions, ["WIRE_APPROVED", "WIRE_EDIT", "WIRE_PROPOSED"]);
    assert.match((await decideWireChange(fixture.owner, { changeId, decision: "APPROVED" })).error ?? "", /already decided/);

    // A rejected change leaves the instructions alone, and the proposer can withdraw their own.
    const second = await proposeWireChange(fixture.owner, { closingId: closing.id, instructions: "Somewhere else" });
    assert.ok(second.change);
    assert.deepEqual(await decideWireChange(fixture.closer, { changeId: second.change!.id, decision: "REJECTED", note: "Not verified by phone" }), { error: null, applied: false, withdrawn: false });
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).wireInstructions, `Bank of Test ${fixture.tag}\nABA 000000000`);
    const third = await proposeWireChange(fixture.closer, { closingId: closing.id, instructions: "Third bank" });
    assert.deepEqual(await decideWireChange(fixture.closer, { changeId: third.change!.id, decision: "REJECTED" }), { error: null, applied: false, withdrawn: true });
    assert.equal((await pendingWireChanges(closing.id)).length, 0);

    // The desk default takes the same path. This test rejects it, so the shared settings never change.
    const fallback = await proposeWireChange(fixture.owner, { closingId: null, instructions: `Default ${fixture.tag}` });
    if (fallback.error === null && fallback.change) {
      assert.match((await decideWireChange(fixture.owner, { changeId: fallback.change.id, decision: "APPROVED" })).error ?? "", /another desk member approves/);
      assert.ok((await pendingWireChanges(null)).some((change) => change.id === fallback.change!.id));
      assert.match((await proposeWireChange(fixture.closer, { closingId: null, instructions: "x" })).error ?? "", /doesn't cover this/);
      assert.deepEqual(await decideWireChange(fixture.owner, { changeId: fallback.change.id, decision: "REJECTED" }), { error: null, applied: false, withdrawn: true });
      assert.notEqual((await prisma.platformSettings.findUnique({ where: { id: "default" } }))?.wireInstructions, `Default ${fixture.tag}`);
    } else {
      // Another run left a default change waiting; it is not this test's to decide.
      assert.match(fallback.error ?? "", /already waiting/);
    }
  } finally {
    await cleanDesk(fixture);
  }
});

test("the deal owner carries to the closing, and only a desk member who runs sales or closings can own a deal", async () => {
  const fixture = await makeDesk();
  try {
    const inquiry = await bid(fixture, fixture.buyer.id, 110000, { status: "ACCEPTED" });
    const closing = await openClosing({ listingId: fixture.listing.id, inquiryId: inquiry.id, noteId: fixture.listing.notes[0].id, salePrice: 110000, title: fixture.listing.title });
    assert.equal(closing.deskOwnerId, fixture.sales.id);
    assert.deepEqual(await deskContact(closing.deskOwnerId), { name: fixture.sales.name, email: fixture.sales.email });

    assert.match((await assignDealOwner(fixture.trader, { kind: "listing", id: fixture.listing.id, ownerId: fixture.sales.id })).error ?? "", /doesn't cover this/);
    assert.match((await assignDealOwner(fixture.sales, { kind: "listing", id: fixture.listing.id, ownerId: fixture.trader.id })).error ?? "", /runs sales or closings/);
    assert.match((await assignDealOwner(fixture.sales, { kind: "closing", id: closing.id, ownerId: fixture.closer.id })).error ?? "", /doesn't cover this/);
    const moved = await assignDealOwner(fixture.closer, { kind: "closing", id: closing.id, ownerId: fixture.closer.id });
    assert.equal(moved.error, null);
    assert.equal((await prisma.closing.findUniqueOrThrow({ where: { id: closing.id } })).deskOwnerId, fixture.closer.id);
    const cleared = await assignDealOwner(fixture.sales, { kind: "listing", id: fixture.listing.id, ownerId: "" });
    assert.equal(cleared.error, null);
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listing.id } })).deskOwnerId, null);
    assert.deepEqual(
      (await prisma.auditEvent.findMany({ where: { action: "DEAL_OWNER", entityId: { in: [fixture.listing.id, closing.id] } }, orderBy: { createdAt: "asc" } })).map((event) => event.detail),
      [`Owner ${fixture.closer.name}`, "Owner cleared"],
    );
    // A suspended desk account names no one to the seller.
    await prisma.user.update({ where: { id: fixture.closer.id }, data: { accountStatus: "SUSPENDED" } });
    assert.equal(await deskContact(fixture.closer.id), null);
  } finally {
    await cleanDesk(fixture);
  }
});

test("the audit log filters by who, what, which record and when, pages past the first hundred, and exports the same filter", async () => {
  const fixture = await makeDesk();
  try {
    const entityId = `gov-${fixture.tag}`;
    const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
    await prisma.auditEvent.createMany({
      data: [
        { actorId: fixture.closer.id, action: "WIRE_PROPOSED", entityType: "closing", entityId, detail: "one", createdAt: at("2026-10-01") },
        { actorId: fixture.compliance.id, action: "WIRE_APPROVED", entityType: "closing", entityId, detail: "two", createdAt: at("2026-10-02") },
        { actorId: fixture.closer.id, action: "CLOSING", entityType: "closing", entityId, detail: "three", createdAt: at("2026-10-05") },
      ],
    });
    const base = { actor: "", action: "", entityType: "", entityId, from: "", to: "" };
    assert.equal((await auditPage(base)).total, 3);
    const byActor = await auditPage({ ...base, actor: fixture.closer.email });
    assert.deepEqual(byActor.events.map((event) => event.detail), ["three", "one"]);
    assert.equal((await auditPage({ ...base, actor: fixture.closer.id })).total, 2);
    assert.deepEqual((await auditPage({ ...base, action: "WIRE_APPROVED" })).events.map((event) => event.actor?.name), [fixture.compliance.name]);
    assert.equal((await auditPage({ ...base, entityType: "listing" })).total, 0);
    assert.deepEqual((await auditPage({ ...base, from: "2026-10-02", to: "2026-10-02" })).events.map((event) => event.detail), ["two"]);
    assert.equal((await auditPage({ ...base, actor: `nobody-${fixture.tag}` })).total, 0);
    // Pages, newest first, with a page past the end landing on the last one.
    const first = await auditPage(base, 1, 2);
    assert.deepEqual([first.pages, first.events.length], [2, 2]);
    const last = await auditPage(base, 9, 2);
    assert.deepEqual([last.page, last.events.map((event) => event.detail)], [2, ["one"]]);
    const csv = (await auditExport({ ...base, actor: fixture.closer.email })).split("\n");
    assert.equal(csv.length, 3);
    assert.match(csv[1], new RegExp(`^2026-10-05T12:00:00.000Z,closer ${fixture.tag},${fixture.closer.email},${fixture.closer.id},CLOSING,closing,${entityId},three,`));
  } finally {
    await cleanDesk(fixture);
  }
});

test("the sale file carries every bid with its round and reserve check, the seller's answers, the award, the declines and the closing", async () => {
  const fixture = await makeDesk();
  try {
    const winner = await bid(fixture, fixture.buyer.id, 110000, { sellerAskedAt: new Date(), sellerAskedAmount: 110000 });
    const loser = await bid(fixture, fixture.rival.id, 90000);
    await prisma.offerMessage.create({ data: { inquiryId: loser.id, authorId: fixture.sales.id, kind: "COUNTER", amount: 95000, body: "Desk counter." } });
    await prisma.deskBid.create({ data: { listingId: fixture.listing.id, amount: 80000, status: "DECLINED" } });
    // The round closed, the seller agreed, the desk awarded and declined the other bid.
    await prisma.listing.update({ where: { id: fixture.listing.id }, data: { bidDeadline: new Date(Date.now() - 1000) } });
    await prisma.auditEvent.create({ data: { actorId: fixture.seller.id, action: "SELLER_APPROVED", entityType: "inquiry", entityId: winner.id, detail: `${fixture.listing.title} · $110,000` } });
    await prisma.inquiry.update({ where: { id: winner.id }, data: { status: "ACCEPTED", sellerApprovedAmount: 110000, sellerAnsweredAt: new Date() } });
    await prisma.inquiry.update({ where: { id: loser.id }, data: { status: "DECLINED" } });
    await prisma.auditEvent.create({ data: { actorId: fixture.sales.id, action: "AWARD", entityType: "inquiry", entityId: winner.id, detail: `${fixture.listing.title} · within the seller's reserve · 1 other bid declined` } });
    await prisma.notification.create({ data: { toEmail: fixture.rival.email, subject: `Bid not selected · ${fixture.listing.title}`, body: "Thank you for bidding." } });
    await prisma.notification.create({ data: { toEmail: fixture.rival.email, subject: `Bid not selected · Some other listing ${fixture.tag}`, body: "Not this one." } });
    const closing = await openClosing({ listingId: fixture.listing.id, inquiryId: winner.id, noteId: fixture.listing.notes[0].id, salePrice: 110000, title: fixture.listing.title });
    await prisma.closing.update({ where: { id: closing.id }, data: { status: "COMPLETE", closedAt: new Date() } });

    const file = await saleFile(fixture.listing.id, fixture.compliance);
    assert.ok(file);
    assert.equal(file.walled, false);
    const section = (name: string) => file.rows.filter((row) => row.section === name);
    assert.equal(section("Reserve")[0].amount, 100000);
    const bids = section("Bid");
    assert.deepEqual(bids.map((row) => [row.party, row.amount, row.round, row.status, row.reserveMet]), [
      [`Fund ${fixture.tag}`, 110000, "Sealed", "Accepted", "Yes"],
      [`rival ${fixture.tag}`, 90000, "Sealed", "Declined", "No"],
    ]);
    assert.ok(bids.every((row) => row.goodUntil instanceof Date && row.at instanceof Date));
    assert.deepEqual(section("Counter").map((row) => [row.amount, row.by]), [[95000, "Desk"]]);
    assert.deepEqual(section("Desk bid").map((row) => [row.amount, row.status, row.reserveMet]), [[80000, "Declined", "No"]]);
    assert.deepEqual(section("Seller approval").map((row) => [row.status, row.by, row.party]), [["Approved", fixture.seller.name, `Fund ${fixture.tag}`]]);
    assert.deepEqual(section("Award").map((row) => [row.status, row.by]), [["Award", fixture.sales.name]]);
    // Only this listing's decline counts.
    assert.deepEqual(section("Decline sent").map((row) => [row.party, row.detail]), [[`rival ${fixture.tag}`, `Bid not selected · ${fixture.listing.title}`]]);
    assert.deepEqual(section("Closing opened").map((row) => [row.party, row.amount]), [[`Fund ${fixture.tag}`, 110000]]);
    assert.deepEqual(section("Closing outcome").map((row) => row.status), ["Closed"]);

    const csv = saleFileCsv(file).split("\n");
    assert.equal(csv[0], "section,time_utc,party,amount,round,good_until_utc,status,met_reserve,by,detail");
    assert.ok(csv.some((line) => line.startsWith("Bid,") && line.includes(",110000.00,Sealed,") && line.includes(",Accepted,Yes,")));
    const pdf = await saleFilePdf(file);
    assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-");
    // Past the deadline a trader still stands behind the wall while the book could bid, and not once it is in contract.
    assert.equal((await saleFile(fixture.listing.id, fixture.trader))?.walled, true);
    assert.equal((await saleFile(fixture.listing.id, fixture.analyst))?.walled, false);
    await prisma.listing.update({ where: { id: fixture.listing.id }, data: { status: "PENDING" } });
    assert.equal((await saleFile(fixture.listing.id, fixture.trader))?.walled, false);
  } finally {
    await cleanDesk(fixture);
  }
});

test("the sale file scopes a part-pool closing to its loans and carries the pool plan, the part award and each kick-out", async () => {
  const fixture = await makeDesk();
  const loan = (index: number) => ({
    streetAddress: `${index} Pool St`, city: `Pooltown${index}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
    lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: 60000, estimatedValue: 130000,
  });
  const pool = await prisma.listing.create({
    data: { kind: "POOL", sellerId: fixture.seller.id, status: "PENDING", approvedAt: new Date(Date.now() - 7 * DAY), title: `Pool ${fixture.tag}`, notes: { create: [loan(1), loan(2), loan(3)] as never } },
    include: { notes: true },
  });
  try {
    const [first, second, third] = pool.notes;
    const inquiry = await prisma.inquiry.create({ data: { listingId: pool.id, buyerId: fixture.buyer.id, type: "OFFER", amount: 150000, status: "ACCEPTED" } });
    await prisma.auditEvent.createMany({
      data: [
        { actorId: fixture.sales.id, action: "SELLER_ASKED_PART", entityType: "inquiry", entityId: inquiry.id, detail: "Two loans" },
        { actorId: fixture.sales.id, action: "POOL_PLAN", entityType: "listing", entityId: pool.id, detail: "Plan across 1 bid" },
        { actorId: fixture.sales.id, action: "AWARD_PARTIAL", entityType: "inquiry", entityId: inquiry.id, detail: "Two of three loans" },
      ],
    });
    const closing = await openClosing({ listingId: pool.id, inquiryId: inquiry.id, noteId: null, noteIds: [first.id, second.id], salePrice: 100000, title: pool.title });
    await prisma.closingKickout.create({ data: { closingId: closing.id, noteId: second.id, priceCents: 4000000, depositCents: 400000, reason: "Title defect", actorId: fixture.closer.id } });
    await prisma.auditEvent.create({ data: { actorId: fixture.closer.id, action: "CLOSING_KICKOUT", entityType: "closing", entityId: closing.id, detail: "Pooltown2 · Title defect" } });
    await prisma.closing.update({ where: { id: closing.id }, data: { noteIds: [first.id] } });

    const file = await saleFile(pool.id, fixture.compliance);
    assert.ok(file);
    const section = (name: string) => file.rows.filter((row) => row.section === name);
    // After the kick-out the closing covers one loan, not the whole pool.
    assert.match(section("Closing opened")[0].detail, /^Loan in Pooltown1, ZZ · closing /);
    assert.ok(!section("Closing opened")[0].detail.includes(third.city));
    assert.deepEqual(section("Seller approval").map((row) => row.status), ["Asked part"]);
    assert.deepEqual(section("Award").map((row) => row.status), ["Pool plan", "Award partial"]);
    // One row per kick-out, from the kept record, not a second one from its audit entry.
    const kicks = section("Closing outcome").filter((row) => row.status === "Kicked out");
    assert.equal(kicks.length, 1);
    assert.deepEqual([kicks[0].amount, kicks[0].by], [40000, fixture.closer.name]);
    assert.equal(kicks[0].detail, "Loan in Pooltown2, ZZ · price down $40,000.00 · deposit down $4,000.00 · Title defect");
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityId: { in: [pool.id, ...(await prisma.inquiry.findMany({ where: { listingId: pool.id }, select: { id: true } })).map((row) => row.id), ...(await prisma.closing.findMany({ where: { listingId: pool.id }, select: { id: true } })).map((row) => row.id)] } } });
    await prisma.listing.deleteMany({ where: { id: pool.id } });
    await cleanDesk(fixture);
  }
});
