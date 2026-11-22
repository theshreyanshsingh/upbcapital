import assert from "node:assert/strict";
import test from "node:test";
import {
  addFirmNote,
  addFirmTask,
  addStandardTasks,
  deleteFirmNote,
  deleteFirmTask,
  editFirmNote,
  firmWorkspace,
  isOverdue,
  myTasks,
  NOTE_MAX,
  openTaskCounts,
  readDueDate,
  saveFirmTask,
  setFirmTaskDone,
  standardTaskTitle,
  standardTaskTitles,
  workspaceOf,
} from "../lib/firm-workspace";
import { DILIGENCE_ITEMS } from "../lib/diligence-checklist";
import { prisma } from "../lib/prisma";
import { resolveSessionUser, type ActingUser } from "../lib/seats";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

// Two buyer firms, a buyer with no seats, a seller, a broker and a desk account, and two live listings: a performing
// note and a non-performing one. Every address and title is tagged, so other test files on the same database never
// meet these rows.
async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const email = (prefix: string) => `firmws-${prefix}-${tag}@example.org`;
  const account = (prefix: string, role: "BUYER" | "ADMIN" | "BROKER" | "INDIVIDUAL_SELLER", extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email: email(prefix), name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", emailConfirmedAt: new Date(), ...extra } });
  const seller = await account("seller", "INDIVIDUAL_SELLER");
  const broker = await account("broker", "BROKER");
  const desk = await account("desk", "ADMIN");
  const firm = await account("firm", "BUYER", { companyName: `Workspace Bank ${tag}` });
  const other = await account("other", "BUYER", { companyName: `Other Fund ${tag}` });
  const solo = await account("solo", "BUYER");
  const seat = (prefix: string, seatRole: string, principalId = firm.id) =>
    account(prefix, "BUYER", { principalId, seatRole, seatAddedById: principalId, seatAddedAt: new Date() });
  const trader = await seat("trader", "TRADE");
  const approver = await seat("approver", "APPROVE");
  const viewer = await seat("viewer", "VIEW");
  const manager = await seat("manager", "MANAGE");
  const otherSeat = await seat("otherseat", "MANAGE", other.id);
  const loan = (paymentStatus: string) => ({
    streetAddress: "1 Firm St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
    lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus, monthsDelinquent: paymentStatus === "PERFORMING" ? 0 : 8,
    askingPrice: 90000, estimatedValue: 150000,
  });
  const listing = (title: string, paymentStatus: string) =>
    prisma.listing.create({
      data: {
        kind: "SINGLE", sellerId: seller.id, status: "APPROVED", approvedAt: new Date(Date.now() - 30 * DAY), bidMode: "NONE",
        title: `${title} ${tag}`, notes: { create: [loan(paymentStatus)] as never },
      },
    });
  const performing = await listing("Workspace performing note", "PERFORMING");
  const npl = await listing("Workspace NPL", "NON_PERFORMING");
  const users = [seller, broker, desk, firm, other, solo, trader, approver, viewer, manager, otherSeat];
  return { tag, seller, broker, desk, firm, other, solo, trader, approver, viewer, manager, otherSeat, performing, npl, users };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const ids = world.users.map((row) => row.id);
  const listingIds = [world.performing.id, world.npl.id];
  await prisma.firmNote.deleteMany({ where: { OR: [{ firmId: { in: ids } }, { listingId: { in: listingIds } }] } });
  await prisma.firmTask.deleteMany({ where: { OR: [{ firmId: { in: ids } }, { listingId: { in: listingIds } }] } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: [...listingIds, ...ids] } }] } });
  await prisma.rateWindow.deleteMany({ where: { OR: ids.map((id) => ({ key: { startsWith: `firm-standard:${id}:` } })) } });
  await prisma.notification.deleteMany({ where: { toEmail: { in: world.users.map((row) => row.email) } } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function acting(id: string): Promise<ActingUser> {
  const resolved = await resolveSessionUser(id);
  assert.ok(resolved, `expected ${id} to resolve`);
  return resolved.user;
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const assignedNotices = (address: string) => prisma.notification.findMany({ where: { toEmail: address, subject: "A diligence task for you" }, select: { subject: true, body: true } });

test("a seat and its principal share one firm's notes and tasks", async () => {
  const world = await makeWorld();
  try {
    const [owner, trader] = await Promise.all([acting(world.firm.id), acting(world.trader.id)]);
    assert.equal(workspaceOf(trader)?.firmId, world.firm.id, "a seat works in its firm's workspace");
    assert.equal(workspaceOf(trader)?.personId, world.trader.id);
    assert.equal(workspaceOf(owner)?.personId, world.firm.id);
    // A seat's own row, unresolved, is never a firm of its own.
    assert.equal(workspaceOf(world.trader as ActingUser), null);

    const note = await addFirmNote(trader, form({ listingId: world.performing.id, body: "Pay history looks clean through March." }));
    assert.equal(note.error, null);
    const task = await addFirmTask(owner, form({ listingId: world.performing.id, title: "Order the title search", assigneeId: world.trader.id, due: "2026-12-01" }));
    assert.equal(task.error, null);

    const seen = await firmWorkspace(owner, world.performing.id);
    assert.ok(seen);
    assert.deepEqual(seen.notes.map((row) => [row.body, row.author]), [["Pay history looks clean through March.", world.trader.name]]);
    const theirs = await firmWorkspace(trader, world.performing.id);
    assert.ok(theirs);
    assert.deepEqual(theirs.tasks.map((row) => [row.title, row.assignee]), [["Order the title search", world.trader.name]]);
    assert.equal(theirs.tasks[0].dueAt?.toISOString(), "2026-12-01T00:00:00.000Z");
    // Everyone on the account can take a task: the owner and each current seat, not another firm's.
    const people = theirs.people.map((person) => person.id);
    assert.deepEqual(new Set(people), new Set([world.firm.id, world.trader.id, world.approver.id, world.viewer.id, world.manager.id]));
    assert.equal(theirs.people[0].owner, true);

    // The seat marks it done and the owner reads who did.
    assert.equal((await setFirmTaskDone(trader, form({ taskId: (task as { id: string }).id, done: "yes" }))).error, null);
    const after = await firmWorkspace(owner, world.performing.id);
    assert.equal(after?.tasks[0].doneBy, world.trader.name);
    assert.equal((await setFirmTaskDone(owner, form({ taskId: (task as { id: string }).id, done: "no" }))).error, null);
    assert.equal((await firmWorkspace(owner, world.performing.id))?.tasks[0].doneAt, null);

    // A buyer with no seats gets the workspace too, as a firm of one.
    const solo = await acting(world.solo.id);
    assert.equal(workspaceOf(solo)?.canWrite, true);
    assert.equal((await addFirmNote(solo, form({ listingId: world.performing.id, body: "Solo note." }))).error, null);
    assert.deepEqual((await firmWorkspace(solo, world.performing.id))?.notes.map((row) => row.body), ["Solo note."]);
    assert.ok(!(await firmWorkspace(owner, world.performing.id))?.notes.some((row) => row.body === "Solo note."));
  } finally {
    await cleanWorld(world);
  }
});

test("another firm can neither read nor write a firm's workspace, a forged firm id included", async () => {
  const world = await makeWorld();
  try {
    const [owner, other, otherSeat] = await Promise.all([acting(world.firm.id), acting(world.other.id), acting(world.otherSeat.id)]);
    const note = await addFirmNote(owner, form({ listingId: world.performing.id, body: "Our ceiling is 82 cents." }));
    const task = await addFirmTask(owner, form({ listingId: world.performing.id, title: "Call the servicer" }));
    assert.equal(note.error, null);
    assert.equal(task.error, null);
    const noteId = (note as { id: string }).id;
    const taskId = (task as { id: string }).id;

    for (const outsider of [other, otherSeat]) {
      const view = await firmWorkspace(outsider, world.performing.id);
      assert.ok(view);
      assert.deepEqual(view.notes, [], "another firm reads none of the notes");
      assert.deepEqual(view.tasks, [], "or the tasks");
      assert.equal((await openTaskCounts(outsider, [world.performing.id])).size, 0);
      assert.deepEqual(await myTasks(outsider), []);
      // Every write names the row by id, and the firm comes from the session: each is refused.
      const forged = { firmId: world.firm.id };
      assert.match((await editFirmNote(outsider, form({ ...forged, noteId, body: "Changed by another firm." }))).error ?? "", /isn't in your firm's workspace/);
      assert.match((await deleteFirmNote(outsider, form({ ...forged, noteId }))).error ?? "", /isn't in your firm's workspace/);
      assert.match((await setFirmTaskDone(outsider, form({ ...forged, taskId, done: "yes" }))).error ?? "", /isn't in your firm's workspace/);
      assert.match((await saveFirmTask(outsider, form({ ...forged, taskId, assigneeId: world.other.id }))).error ?? "", /isn't in your firm's workspace/);
      assert.match((await deleteFirmTask(outsider, form({ ...forged, taskId }))).error ?? "", /isn't in your firm's workspace/);
    }
    // A firm id typed into the form is ignored: the note lands in the writer's own firm.
    const planted = await addFirmNote(other, form({ listingId: world.performing.id, firmId: world.firm.id, body: "Planted note." }));
    assert.equal(planted.error, null);
    const row = await prisma.firmNote.findUnique({ where: { id: (planted as { id: string }).id } });
    assert.equal(row?.firmId, world.other.id);
    // Nor can another firm hand a task to the firm's people.
    assert.match((await addFirmTask(other, form({ listingId: world.performing.id, firmId: world.firm.id, title: "Hand off", assigneeId: world.trader.id }))).error ?? "", /someone on your firm's account/);

    const mine = await firmWorkspace(owner, world.performing.id);
    assert.deepEqual(mine?.notes.map((item) => item.body), ["Our ceiling is 82 cents."]);
    assert.equal(mine?.tasks[0].doneAt, null);
    assert.equal(mine?.tasks[0].assigneeId, null);
    assert.equal(await prisma.firmNote.count({ where: { id: noteId } }), 1);
    assert.equal(await prisma.firmTask.count({ where: { id: taskId } }), 1);
  } finally {
    await cleanWorld(world);
  }
});

test("a view-only seat reads the workspace and is refused every write", async () => {
  const world = await makeWorld();
  try {
    const [owner, viewer] = await Promise.all([acting(world.firm.id), acting(world.viewer.id)]);
    const note = await addFirmNote(owner, form({ listingId: world.performing.id, body: "Read me." }));
    const task = await addFirmTask(owner, form({ listingId: world.performing.id, title: "Check the dated value" }));
    const view = await firmWorkspace(viewer, world.performing.id);
    assert.equal(view?.workspace.canWrite, false);
    assert.equal(view?.standardOffered, false);
    assert.deepEqual(view?.notes.map((row) => [row.body, row.canEdit, row.canDelete]), [["Read me.", false, false]]);
    assert.equal(view?.tasks.length, 1);
    const refusals = [
      await addFirmNote(viewer, form({ listingId: world.performing.id, body: "Viewer note." })),
      await addFirmTask(viewer, form({ listingId: world.performing.id, title: "Viewer task" })),
      await addStandardTasks(viewer, form({ listingId: world.performing.id })),
      await deleteFirmNote(viewer, form({ noteId: (note as { id: string }).id })),
      await setFirmTaskDone(viewer, form({ taskId: (task as { id: string }).id, done: "yes" })),
      await saveFirmTask(viewer, form({ taskId: (task as { id: string }).id, assigneeId: world.viewer.id })),
      await deleteFirmTask(viewer, form({ taskId: (task as { id: string }).id })),
    ];
    for (const outcome of refusals) assert.match(outcome.error ?? "", /view only/);
    assert.equal(await prisma.firmNote.count({ where: { firmId: world.firm.id } }), 1);
    assert.equal(await prisma.firmTask.count({ where: { firmId: world.firm.id } }), 1);
  } finally {
    await cleanWorld(world);
  }
});

test("the desk, the seller and the broker can't read a firm's workspace", async () => {
  const world = await makeWorld();
  try {
    const owner = await acting(world.firm.id);
    await addFirmNote(owner, form({ listingId: world.performing.id, body: "Not for the desk." }));
    await addFirmTask(owner, form({ listingId: world.performing.id, title: "Review the mortgage", assigneeId: world.trader.id }));
    for (const id of [world.desk.id, world.seller.id, world.broker.id]) {
      const outsider = await acting(id);
      assert.equal(workspaceOf(outsider), null);
      assert.equal(await firmWorkspace(outsider, world.performing.id), null);
      assert.deepEqual(await myTasks(outsider), []);
      assert.equal((await openTaskCounts(outsider, [world.performing.id])).size, 0);
      assert.match((await addFirmNote(outsider, form({ listingId: world.performing.id, firmId: world.firm.id, body: "Desk note." }))).error ?? "", /for buyers' firms/);
    }
    // The notice the desk's pages can list names neither the task nor the listing.
    const [notice] = await assignedNotices(world.trader.email);
    assert.ok(notice);
    assert.ok(!notice.subject.includes("Review the mortgage") && !notice.subject.includes(world.performing.title));
    // The audit log is the desk's, so no note or task text goes there.
    const logged = await prisma.auditEvent.findMany({ where: { actorId: world.firm.id } });
    assert.ok(!logged.some((event) => event.detail.includes("Not for the desk") || event.detail.includes("Review the mortgage")));
  } finally {
    await cleanWorld(world);
  }
});

test("an author edits their own note, and the author or a managing seat deletes it", async () => {
  const world = await makeWorld();
  try {
    const [owner, trader, approver, manager] = await Promise.all([acting(world.firm.id), acting(world.trader.id), acting(world.approver.id), acting(world.manager.id)]);
    const add = async (user: ActingUser, body: string) => (await addFirmNote(user, form({ listingId: world.performing.id, body }))) as { error: null; id: string };
    const first = await add(trader, "First reading.");
    assert.equal(first.error, null);

    // The author edits; nobody else does, a managing seat and the owner included.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await editFirmNote(trader, form({ noteId: first.id, body: "Second reading." }))).error, null);
    for (const someone of [approver, manager, owner]) {
      assert.match((await editFirmNote(someone, form({ noteId: first.id, body: "Overwritten." }))).error ?? "", /Only the person who wrote a note edits it/);
    }
    const view = await firmWorkspace(owner, world.performing.id);
    assert.equal(view?.notes[0].body, "Second reading.");
    assert.equal(view?.notes[0].edited, true);
    assert.deepEqual([view?.notes[0].canEdit, view?.notes[0].canDelete], [false, true], "the owner deletes but doesn't edit another's note");
    const traderView = await firmWorkspace(trader, world.performing.id);
    assert.deepEqual([traderView?.notes[0].canEdit, traderView?.notes[0].canDelete], [true, true]);
    const approverView = await firmWorkspace(approver, world.performing.id);
    assert.deepEqual([approverView?.notes[0].canEdit, approverView?.notes[0].canDelete], [false, false]);

    // Plain text up to 2,000 characters; blank and longer are refused.
    assert.match((await editFirmNote(trader, form({ noteId: first.id, body: "   " }))).error ?? "", /Write the note first/);
    assert.match((await addFirmNote(trader, form({ listingId: world.performing.id, body: "x".repeat(NOTE_MAX + 1) }))).error ?? "", /2,000 characters/);
    assert.equal((await addFirmNote(trader, form({ listingId: world.performing.id, body: "y".repeat(NOTE_MAX) }))).error, null);

    // A trading or approving seat deletes only its own. A managing seat and the owner delete any.
    assert.match((await deleteFirmNote(approver, form({ noteId: first.id }))).error ?? "", /Only the person who wrote a note deletes it/);
    assert.equal((await deleteFirmNote(manager, form({ noteId: first.id }))).error, null);
    const second = await add(approver, "Approver's note.");
    assert.equal((await deleteFirmNote(owner, form({ noteId: second.id }))).error, null);
    const third = await add(trader, "Trader's own.");
    assert.equal((await deleteFirmNote(trader, form({ noteId: third.id }))).error, null);
    assert.deepEqual((await firmWorkspace(owner, world.performing.id))?.notes.map((row) => row.body.length), [NOTE_MAX]);

    // Newest first.
    await add(trader, "Older.");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await add(trader, "Newer.");
    assert.deepEqual((await firmWorkspace(owner, world.performing.id))?.notes.slice(0, 2).map((row) => row.body), ["Newer.", "Older."]);
  } finally {
    await cleanWorld(world);
  }
});

test("the standard diligence tasks come from the listing's diligence set, once, skipping titles the firm has", async () => {
  const world = await makeWorld();
  try {
    const [owner, trader] = await Promise.all([acting(world.firm.id), acting(world.trader.id)]);
    const loanItems = DILIGENCE_ITEMS.filter((item) => item.scope === "loan");
    const titles = await standardTaskTitles(world.performing.id);
    assert.deepEqual(titles, loanItems.map((item) => standardTaskTitle(item.label)));
    assert.ok(titles.includes("Review the pay history") && titles.includes("Review the assignment chain") && titles.includes("Review the note or lost-note affidavit"));
    // A loan that isn't paying has no pay history to review.
    assert.ok(!(await standardTaskTitles(world.npl.id)).includes("Review the pay history"));

    await addFirmTask(owner, form({ listingId: world.performing.id, title: "review the  PAY history" }));
    assert.equal((await firmWorkspace(trader, world.performing.id))?.standardOffered, true);
    const run = await addStandardTasks(trader, form({ listingId: world.performing.id }));
    assert.equal(run.error, null);
    assert.deepEqual([(run as { added: number }).added, (run as { skipped: number }).skipped], [titles.length - 1, 1]);
    const count = () => prisma.firmTask.count({ where: { firmId: world.firm.id, listingId: world.performing.id } });
    assert.equal(await count(), titles.length);

    // Once per listing per firm, even after a task is deleted.
    const view = await firmWorkspace(owner, world.performing.id);
    assert.equal(view?.standardOffered, false);
    await deleteFirmTask(owner, form({ taskId: view!.tasks.find((task) => task.title === "Review the title policy or O&E report")!.id }));
    assert.match((await addStandardTasks(owner, form({ listingId: world.performing.id }))).error ?? "", /already added/);
    assert.equal(await count(), titles.length - 1);

    // Another listing, and another firm, start fresh.
    assert.equal((await addStandardTasks(owner, form({ listingId: world.npl.id }))).error, null);
    const other = await acting(world.other.id);
    const theirs = await addStandardTasks(other, form({ listingId: world.performing.id }));
    assert.equal((theirs as { added: number }).added, titles.length);
    assert.equal(await count(), titles.length - 1);
  } finally {
    await cleanWorld(world);
  }
});

test("assigning a task tells the assignee once, by email and in the app", async () => {
  const world = await makeWorld();
  try {
    const [owner, trader] = await Promise.all([acting(world.firm.id), acting(world.trader.id)]);
    const added = await addFirmTask(owner, form({ listingId: world.performing.id, title: "Order the O&E report", assigneeId: world.trader.id, due: "2026-12-04" }));
    assert.equal(added.error, null);
    assert.equal((added as { told: boolean }).told, true);
    const taskId = (added as { id: string }).id;
    let notices = await assignedNotices(world.trader.email);
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /Order the O&E report/);
    assert.match(notices[0].body, new RegExp(world.performing.title));
    assert.match(notices[0].body, /Dec 4, 2026/);

    // A new date, the same save twice, or a stale save after someone else moved it: still one notice.
    assert.equal((await saveFirmTask(owner, form({ taskId, assigneeId: world.trader.id, due: "2026-12-09" }))).error, null);
    assert.equal((await saveFirmTask(owner, form({ taskId, assigneeId: world.trader.id, due: "2026-12-09" }))).error, null);
    notices = await assignedNotices(world.trader.email);
    assert.equal(notices.length, 1);

    // Moving it to someone else tells them, once.
    const moved = await saveFirmTask(trader, form({ taskId, assigneeId: world.approver.id, due: "2026-12-09" }));
    assert.equal((moved as { told: boolean }).told, true);
    await saveFirmTask(trader, form({ taskId, assigneeId: world.approver.id, due: "" }));
    assert.equal((await assignedNotices(world.approver.email)).length, 1);
    assert.equal((await assignedNotices(world.trader.email)).length, 1);

    // Taking a task yourself sends nothing, and neither does a task with no one on it.
    const own = await addFirmTask(trader, form({ listingId: world.performing.id, title: "My own task", assigneeId: world.trader.id }));
    assert.equal((own as { told: boolean }).told, false);
    await addFirmTask(owner, form({ listingId: world.performing.id, title: "Nobody's yet" }));
    assert.equal((await assignedNotices(world.trader.email)).length, 1);
    // A bad date or a stranger is refused before anything is saved.
    assert.match((await addFirmTask(owner, form({ listingId: world.performing.id, title: "Bad date", due: "2026-02-30" }))).error ?? "", /due date/);
    assert.match((await saveFirmTask(owner, form({ taskId, assigneeId: world.otherSeat.id }))).error ?? "", /someone on your firm's account/);
  } finally {
    await cleanWorld(world);
  }
});

test("my tasks lists the person's open tasks by listing, with due dates and overdue marked", async () => {
  const world = await makeWorld();
  try {
    const [owner, trader] = await Promise.all([acting(world.firm.id), acting(world.trader.id)]);
    const now = new Date("2026-11-22T15:00:00.000Z");
    const task = async (listingId: string, title: string, assigneeId: string, due = "") =>
      (await addFirmTask(owner, form({ listingId, title, assigneeId, due }))) as { error: null; id: string };
    await task(world.performing.id, "Due later", world.trader.id, "2026-12-15");
    await task(world.performing.id, "Overdue one", world.trader.id, "2026-11-20");
    await task(world.performing.id, "Someone else's", world.approver.id, "2026-11-01");
    const finished = await task(world.performing.id, "Already done", world.trader.id, "2026-11-01");
    await setFirmTaskDone(trader, form({ taskId: finished.id, done: "yes" }));
    await task(world.npl.id, "Due today", world.trader.id, "2026-11-22");
    await task(world.npl.id, "No date", world.trader.id);

    const groups = await myTasks(trader, now);
    assert.deepEqual(
      groups.map((group) => [group.listing.title, group.tasks.map((row) => [row.title, row.overdue])]),
      [
        [world.performing.title, [["Overdue one", true], ["Due later", false]]],
        [world.npl.title, [["Due today", false], ["No date", false]]],
      ],
    );
    assert.equal(groups[0].tasks[0].dueAt?.toISOString(), "2026-11-20T00:00:00.000Z");
    // The owner has none of their own. Another firm has none.
    assert.deepEqual(await myTasks(owner, now), []);
    assert.deepEqual(await myTasks(await acting(world.other.id), now), []);

    // The count on favorites and inquiries is the firm's open tasks, anyone's.
    const counts = await openTaskCounts(trader, [world.performing.id, world.npl.id]);
    assert.deepEqual([counts.get(world.performing.id), counts.get(world.npl.id)], [3, 2]);
    assert.deepEqual([...(await openTaskCounts(owner, [world.performing.id]))], [[world.performing.id, 3]]);
  } finally {
    await cleanWorld(world);
  }
});

test("due dates read as a day, and a task is overdue the day after it falls due", () => {
  assert.deepEqual(readDueDate(""), { error: null, dueAt: null });
  assert.equal((readDueDate("2026-12-01") as { dueAt: Date }).dueAt.toISOString(), "2026-12-01T00:00:00.000Z");
  for (const bad of ["12/01/2026", "2026-13-01", "2026-02-29", "soon"]) assert.ok(readDueDate(bad).error, bad);
  const due = new Date("2026-11-22T00:00:00.000Z");
  assert.equal(isOverdue({ dueAt: due, doneAt: null }, new Date("2026-11-22T23:59:00.000Z")), false);
  assert.equal(isOverdue({ dueAt: due, doneAt: null }, new Date("2026-11-23T00:01:00.000Z")), true);
  assert.equal(isOverdue({ dueAt: due, doneAt: new Date() }, new Date("2026-12-23T00:00:00.000Z")), false);
  assert.equal(isOverdue({ dueAt: null, doneAt: null }), false);
});
