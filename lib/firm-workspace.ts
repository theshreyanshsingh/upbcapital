import type { FirmTask } from "@prisma/client";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { DILIGENCE_ITEMS, loadDiligence } from "@/lib/diligence-checklist";
import { notify } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { canSee, listingAccess, listingSight } from "@/lib/private-listings";
import { consumeRateLimit } from "@/lib/rate-limit";
import { personId, seatGate, seatRoleOf, type ActingUser } from "@/lib/seats";

// A buyer firm's own workspace on a listing: notes and diligence tasks that everyone on the firm's account shares.
// The firm is the principal account its seats act for (lib/seats.ts), so the owner and each seat read the same rows,
// and a buyer with no seats is a firm of one. Every row carries the firm, and every read and write here keys on the
// firm the session resolves to (the acting user's id), never on an id a form sends.
//
// Private to the firm. The seller, the broker, other buyers and the desk never read it: a desk, seller or broker
// account has no workspace, no desk page or export queries these rows, and no note or task's words go to the audit
// log or a notice subject, both of which the desk's pages show.

export const NOTE_MAX = 2000;
export const TASK_TITLE_MAX = 200;
const DAY = 24 * 60 * 60 * 1000;
const STANDARD_RUN = "FIRM_STANDARD_TASKS";

export type Workspace = { firmId: string; personId: string; canWrite: boolean; canManage: boolean };

// The workspace a session works in, or null. A seat's row passed in without its firm resolved gets none, so it can
// never stand as a firm of its own.
export function workspaceOf(user: ActingUser | null | undefined): Workspace | null {
  if (!user || user.role !== "BUYER" || user.accountStatus !== "APPROVED" || user.principalId) return null;
  const role = seatRoleOf(user);
  // The owner reads as a managing seat. A view-only seat, or one with a role this code doesn't know, only reads.
  return { firmId: user.id, personId: personId(user), canWrite: role === "TRADE" || role === "APPROVE" || role === "MANAGE", canManage: role === "MANAGE" };
}

const NO_WORKSPACE = "Firm notes and tasks are for buyers' firms.";
const LISTING_GONE = "That listing isn't open to your firm.";
const NOTE_GONE = "That note isn't in your firm's workspace.";
const TASK_GONE = "That task isn't in your firm's workspace.";

// The workspace, for someone who may write in it: the owner, or a trading, approving or managing seat.
async function writer(user: ActingUser) {
  const workspace = workspaceOf(user);
  if (!workspace) return { error: NO_WORKSPACE } as const;
  const gated = await seatGate(user, "message");
  if (gated || !workspace.canWrite) return { error: gated ?? "Your seat is view only. A trading, approving or managing seat, or the account owner, can do this." } as const;
  return { error: null, workspace } as const;
}

// A listing the firm can see, by the same rule as the listing page. Notes on anything else are refused.
async function openListing(user: ActingUser, listingId: string) {
  if (!listingId) return null;
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, title: true, sellerId: true, brokerId: true, visibility: true, status: true, stalePausedAt: true } });
  if (!listing || !(await listingSight(user, listing)).visible) return null;
  return listing;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

// ---------------------------------------------------------------------------------------------------------------
// Reading the form

function readBody(raw: string) {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (!body) return { error: "Write the note first." } as const;
  if (body.length > NOTE_MAX) return { error: `Keep a note to ${NOTE_MAX.toLocaleString("en-US")} characters.` } as const;
  return { error: null, body } as const;
}

function readTitle(raw: string) {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length < 2) return { error: "Name the task." } as const;
  if (title.length > TASK_TITLE_MAX) return { error: `Keep a task to ${TASK_TITLE_MAX} characters.` } as const;
  return { error: null, title } as const;
}

// A due date from a date field, held as that day at midnight UTC, the way the desk's dates read. Blank is none.
export function readDueDate(raw: string): { error: string } | { error: null; dueAt: Date | null } {
  const text = raw.trim();
  if (!text) return { error: null, dueAt: null };
  const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : null;
  if (!dueAt || Number.isNaN(dueAt.getTime()) || dueAt.toISOString().slice(0, 10) !== text) return { error: "Enter the due date as a date, or leave it blank." };
  return { error: null, dueAt };
}

const utcDay = (date: Date) => Math.floor(date.getTime() / DAY);

// Open, with its due day already behind it. A task due today isn't overdue until tomorrow.
export function isOverdue(task: { dueAt: Date | null; doneAt: Date | null }, now = new Date()) {
  return Boolean(task.dueAt && !task.doneAt && utcDay(task.dueAt) < utcDay(now));
}

export function openTasksText(count: number) {
  return `${count} open task${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The firm's people

export type FirmPerson = { id: string; name: string; email: string; owner: boolean };

// Everyone who works in the firm's workspace and can take a task: the owner, then its seats in the order they joined.
export async function firmPeople(firmId: string): Promise<FirmPerson[]> {
  const [owner, seats] = await Promise.all([
    prisma.user.findUnique({ where: { id: firmId }, select: { id: true, name: true, email: true } }),
    prisma.user.findMany({ where: { principalId: firmId, accountStatus: "APPROVED", ...unset("deletedAt") }, select: { id: true, name: true, email: true }, orderBy: { seatAddedAt: "asc" } }),
  ]);
  return [...(owner ? [{ ...owner, owner: true }] : []), ...seats.map((seat) => ({ ...seat, owner: false }))];
}

async function readAssignee(workspace: Workspace, raw: string): Promise<{ error: string } | { error: null; person: FirmPerson | null }> {
  const id = raw.trim();
  if (!id) return { error: null, person: null };
  const person = (await firmPeople(workspace.firmId)).find((row) => row.id === id);
  return person ? { error: null, person } : { error: "Assign the task to someone on your firm's account." };
}

// Names for authors and assignees. A seat that was removed keeps its row, so its name still shows.
async function namesOf(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, string>();
  return new Map((await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]));
}

// The assignee hears once, by email and in the app. Someone who takes a task themselves needs no notice. The subject
// names no listing or task, since the desk's pages list notice subjects.
async function tellAssignee(user: ActingUser, workspace: Workspace, task: { title: string; dueAt: Date | null }, person: FirmPerson, listingTitle: string) {
  if (person.id === workspace.personId) return false;
  const by = user.actor?.name ?? user.name;
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/buyer/tasks`;
  await notify(
    person.email,
    "A diligence task for you",
    `${by} assigned you a task on ${listingTitle}: ${task.title}.${task.dueAt ? ` It is due ${prettyDate(task.dueAt)}.` : ""}\n\nIt is on your tasks page, and in your firm's notes on the listing: ${link}`,
  );
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The panel on the listing

export type WorkspaceNote = { id: string; body: string; author: string; createdAt: Date; edited: boolean; canEdit: boolean; canDelete: boolean };
export type WorkspaceTask = {
  id: string;
  title: string;
  assigneeId: string | null;
  assignee: string | null;
  dueAt: Date | null;
  doneAt: Date | null;
  doneBy: string | null;
  overdue: boolean;
};

// Open tasks first, the soonest due at the top and those with no date after; then the done ones, latest first.
function taskOrder(a: FirmTask, b: FirmTask) {
  if (Boolean(a.doneAt) !== Boolean(b.doneAt)) return a.doneAt ? 1 : -1;
  if (a.doneAt && b.doneAt) return b.doneAt.getTime() - a.doneAt.getTime();
  const due = (task: FirmTask) => task.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return due(a) - due(b) || a.createdAt.getTime() - b.createdAt.getTime();
}

async function standardRun(firmId: string, listingId: string) {
  return Boolean(await prisma.auditEvent.findFirst({ where: { actorId: firmId, action: STANDARD_RUN, entityId: listingId }, select: { id: true } }));
}

// Everything the firm keeps on one listing, for someone on the firm. Null for anyone else, the desk included.
export async function firmWorkspace(user: ActingUser, listingId: string, now = new Date()) {
  const workspace = workspaceOf(user);
  if (!workspace) return null;
  const { firmId } = workspace;
  const [notes, tasks, people, ran] = await Promise.all([
    prisma.firmNote.findMany({ where: { firmId, listingId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 }),
    prisma.firmTask.findMany({ where: { firmId, listingId } }),
    firmPeople(firmId),
    standardRun(firmId, listingId),
  ]);
  const names = await namesOf([...notes.map((note) => note.authorId), ...tasks.flatMap((task) => [task.assigneeId, task.doneById])]);
  const name = (id: string | null) => (id ? (names.get(id) ?? "A former seat") : null);
  return {
    workspace,
    people,
    standardOffered: workspace.canWrite && !ran,
    notes: notes.map((note): WorkspaceNote => {
      const mine = note.authorId === workspace.personId;
      return {
        id: note.id,
        body: note.body,
        author: name(note.authorId) ?? "A former seat",
        createdAt: note.createdAt,
        edited: note.updatedAt.getTime() - note.createdAt.getTime() > 1000,
        canEdit: workspace.canWrite && mine,
        canDelete: workspace.canWrite && (mine || workspace.canManage),
      };
    }),
    tasks: [...tasks].sort(taskOrder).map((task): WorkspaceTask => ({
      id: task.id,
      title: task.title,
      assigneeId: task.assigneeId,
      assignee: name(task.assigneeId),
      dueAt: task.dueAt,
      doneAt: task.doneAt,
      doneBy: name(task.doneById),
      overdue: isOverdue(task, now),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Notes

export async function addFirmNote(user: ActingUser, form: FormData) {
  const access = await writer(user);
  if (access.error !== null) return access;
  const listing = await openListing(user, field(form, "listingId"));
  if (!listing) return { error: LISTING_GONE } as const;
  const read = readBody(field(form, "body"));
  if (read.error !== null) return read;
  const note = await prisma.firmNote.create({ data: { firmId: access.workspace.firmId, listingId: listing.id, authorId: access.workspace.personId, body: read.body } });
  return { error: null, id: note.id, listingId: listing.id } as const;
}

// The person who wrote a note edits it. Nobody else does, a managing seat included.
export async function editFirmNote(user: ActingUser, form: FormData) {
  const access = await writer(user);
  if (access.error !== null) return access;
  const { firmId, personId: author } = access.workspace;
  const note = await prisma.firmNote.findFirst({ where: { id: field(form, "noteId"), firmId } });
  if (!note) return { error: NOTE_GONE } as const;
  if (note.authorId !== author) return { error: "Only the person who wrote a note edits it.", listingId: note.listingId } as const;
  const read = readBody(field(form, "body"));
  if (read.error !== null) return { ...read, listingId: note.listingId };
  const saved = await prisma.firmNote.updateMany({ where: { id: note.id, firmId, authorId: author }, data: { body: read.body } });
  if (saved.count !== 1) return { error: "That note was deleted a moment ago.", listingId: note.listingId } as const;
  return { error: null, listingId: note.listingId } as const;
}

// The person who wrote a note deletes it, and so do a managing seat and the account owner.
export async function deleteFirmNote(user: ActingUser, form: FormData) {
  const access = await writer(user);
  if (access.error !== null) return access;
  const { firmId } = access.workspace;
  const note = await prisma.firmNote.findFirst({ where: { id: field(form, "noteId"), firmId } });
  if (!note) return { error: NOTE_GONE } as const;
  if (note.authorId !== access.workspace.personId && !access.workspace.canManage) {
    return { error: "Only the person who wrote a note deletes it, or a managing seat or the account owner.", listingId: note.listingId } as const;
  }
  await prisma.firmNote.deleteMany({ where: { id: note.id, firmId } });
  return { error: null, listingId: note.listingId } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks

export async function addFirmTask(user: ActingUser, form: FormData) {
  const access = await writer(user);
  if (access.error !== null) return access;
  const { workspace } = access;
  const listing = await openListing(user, field(form, "listingId"));
  if (!listing) return { error: LISTING_GONE } as const;
  const title = readTitle(field(form, "title"));
  if (title.error !== null) return { ...title, listingId: listing.id };
  const due = readDueDate(field(form, "due"));
  if (due.error !== null) return { ...due, listingId: listing.id };
  const assignee = await readAssignee(workspace, field(form, "assigneeId"));
  if (assignee.error !== null) return { ...assignee, listingId: listing.id };
  const task = await prisma.firmTask.create({
    data: { firmId: workspace.firmId, listingId: listing.id, title: title.title, assigneeId: assignee.person?.id ?? null, dueAt: due.dueAt, createdById: workspace.personId },
  });
  const told = assignee.person ? await tellAssignee(user, workspace, task, assignee.person, listing.title) : false;
  return { error: null, id: task.id, listingId: listing.id, told } as const;
}

// Who has the task and by when. The assignee hears only when the task moves to them, so saving a new date, a double
// submit or two people saving at once never sends the notice twice.
export async function saveFirmTask(user: ActingUser, form: FormData) {
  const access = await writer(user);
  if (access.error !== null) return access;
  const { workspace } = access;
  const task = await prisma.firmTask.findFirst({ where: { id: field(form, "taskId"), firmId: workspace.firmId } });
  if (!task) return { error: TASK_GONE } as const;
  const due = readDueDate(field(form, "due"));
  if (due.error !== null) return { ...due, listingId: task.listingId };
  const assignee = await readAssignee(workspace, field(form, "assigneeId"));
  if (assignee.error !== null) return { ...assignee, listingId: task.listingId };
  const next = assignee.person?.id ?? null;
  // Claimed against the assignee read above, so only one save moves the task to someone new.
  const saved = await prisma.firmTask.updateMany({
    where: { id: task.id, firmId: workspace.firmId, ...(task.assigneeId ? { assigneeId: task.assigneeId } : unset("assigneeId")) },
    data: { assigneeId: next, dueAt: due.dueAt },
  });
  if (saved.count !== 1) return { error: "Someone changed that task a moment ago. Look again and save.", listingId: task.listingId } as const;
  let told = false;
  if (assignee.person && next !== task.assigneeId) {
    const listing = await prisma.listing.findUnique({ where: { id: task.listingId }, select: { title: true } });
    told = await tellAssignee(user, workspace, { title: task.title, dueAt: due.dueAt }, assignee.person, listing?.title ?? "a listing");
  }
  return { error: null, listingId: task.listingId, told } as const;
}

// Done, or open again. Marking a done task done keeps who did it first.
export async function setFirmTaskDone(user: ActingUser, form: FormData, now = new Date()) {
  const access = await writer(user);
  if (access.error !== null) return access;
  const { workspace } = access;
  const task = await prisma.firmTask.findFirst({ where: { id: field(form, "taskId"), firmId: workspace.firmId }, select: { id: true, listingId: true } });
  if (!task) return { error: TASK_GONE } as const;
  const done = field(form, "done") !== "no";
  if (done) await prisma.firmTask.updateMany({ where: { id: task.id, firmId: workspace.firmId, ...unset("doneAt") }, data: { doneAt: now, doneById: workspace.personId } });
  else await prisma.firmTask.updateMany({ where: { id: task.id, firmId: workspace.firmId }, data: { doneAt: null, doneById: null } });
  return { error: null, listingId: task.listingId, done } as const;
}

export async function deleteFirmTask(user: ActingUser, form: FormData) {
  const access = await writer(user);
  if (access.error !== null) return access;
  const { firmId } = access.workspace;
  const task = await prisma.firmTask.findFirst({ where: { id: field(form, "taskId"), firmId }, select: { id: true, listingId: true } });
  if (!task) return { error: TASK_GONE } as const;
  await prisma.firmTask.deleteMany({ where: { id: task.id, firmId } });
  return { error: null, listingId: task.listingId } as const;
}

// "Review the pay history", from the checklist's own label, so the tasks keep up with lib/diligence-checklist.ts.
export function standardTaskTitle(label: string) {
  return `Review the ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

// The loan-level items of the listing's diligence set, as task titles. An item no loan here needs, such as the pay
// history on a loan that isn't paying or the endorsements on an eNote, is left out. If the set can't be read, every
// loan-level item is offered.
export async function standardTaskTitles(listingId: string) {
  const loaded = await loadDiligence(listingId).catch(() => null);
  const needed = loaded ? new Set(loaded.diligence.lines.filter((line) => line.state !== "not_required").map((line) => line.key)) : null;
  return DILIGENCE_ITEMS.filter((item) => item.scope === "loan" && (!needed || needed.has(item.key))).map((item) => standardTaskTitle(item.label));
}

const titleKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();

// The standard diligence tasks, once per listing per firm. A title the firm already has is skipped. The run is kept
// in the audit log with a count and no titles, which is what keeps it to once.
export async function addStandardTasks(user: ActingUser, form: FormData, now = new Date()) {
  const access = await writer(user);
  if (access.error !== null) return access;
  const { workspace } = access;
  const listing = await openListing(user, field(form, "listingId"));
  if (!listing) return { error: LISTING_GONE } as const;
  const done = { error: "The standard diligence tasks were already added to this listing.", listingId: listing.id } as const;
  if (await standardRun(workspace.firmId, listing.id)) return done;
  // A double submit lands in the same minute and adds nothing.
  if (!(await consumeRateLimit(`firm-standard:${workspace.firmId}:${listing.id}`, 1, 60 * 1000, now.getTime()))) return done;
  const [titles, existing] = await Promise.all([
    standardTaskTitles(listing.id),
    prisma.firmTask.findMany({ where: { firmId: workspace.firmId, listingId: listing.id }, select: { title: true } }),
  ]);
  const have = new Set(existing.map((task) => titleKey(task.title)));
  const fresh = titles.filter((title) => !have.has(titleKey(title)));
  if (fresh.length) {
    await prisma.firmTask.createMany({
      // A millisecond apart, so they list in the checklist's order.
      data: fresh.map((title, index) => ({ firmId: workspace.firmId, listingId: listing.id, title, createdById: workspace.personId, createdAt: new Date(now.getTime() + index) })),
    });
  }
  await audit(workspace.firmId, STANDARD_RUN, "listing", listing.id, `${fresh.length} task${fresh.length === 1 ? "" : "s"}`, user.actor?.id ?? null);
  return { error: null, listingId: listing.id, added: fresh.length, skipped: titles.length - fresh.length } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Across listings

export type TaskGroup = { listing: { id: string; title: string; status: string }; tasks: WorkspaceTask[] };

// The person's own open tasks, by listing, the listing with the soonest due date first. A listing since closed to the
// firm, such as one made private or from a seller who now excludes it, drops off, as on favorites. One paused for a
// stale confirmation stays, since its link still opens.
export async function myTasks(user: ActingUser, now = new Date()): Promise<TaskGroup[]> {
  const workspace = workspaceOf(user);
  if (!workspace) return [];
  const tasks = await prisma.firmTask.findMany({ where: { firmId: workspace.firmId, assigneeId: workspace.personId, ...unset("doneAt") }, take: 500 });
  if (!tasks.length) return [];
  const [listings, access] = await Promise.all([
    prisma.listing.findMany({ where: { id: { in: [...new Set(tasks.map((task) => task.listingId))] } }, select: { id: true, title: true, status: true, sellerId: true, brokerId: true, visibility: true } }),
    listingAccess(user),
  ]);
  const shown = new Map(listings.filter((listing) => canSee(access, listing)).map((listing) => [listing.id, listing]));
  const groups = new Map<string, FirmTask[]>();
  for (const task of [...tasks].sort(taskOrder)) {
    if (!shown.has(task.listingId)) continue;
    groups.set(task.listingId, [...(groups.get(task.listingId) ?? []), task]);
  }
  const soonest = (rows: FirmTask[]) => rows[0]?.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...groups.entries()]
    .sort(([, a], [, b]) => soonest(a) - soonest(b))
    .map(([listingId, rows]) => {
      const listing = shown.get(listingId)!;
      return {
        listing: { id: listing.id, title: listing.title, status: listing.status },
        tasks: rows.map((task) => ({ id: task.id, title: task.title, assigneeId: task.assigneeId, assignee: null, dueAt: task.dueAt, doneAt: null, doneBy: null, overdue: isOverdue(task, now) })),
      };
    });
}

// The firm's open tasks on each listing, for the "3 open tasks" line on favorites and inquiries.
export async function openTaskCounts(user: ActingUser, listingIds: string[]) {
  const counts = new Map<string, number>();
  const workspace = workspaceOf(user);
  if (!workspace || !listingIds.length) return counts;
  const rows = await prisma.firmTask.findMany({ where: { firmId: workspace.firmId, listingId: { in: [...new Set(listingIds)] }, ...unset("doneAt") }, select: { listingId: true } });
  for (const row of rows) counts.set(row.listingId, (counts.get(row.listingId) ?? 0) + 1);
  return counts;
}
