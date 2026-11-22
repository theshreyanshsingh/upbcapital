import { Circle, CircleCheck } from "lucide-react";
import {
  addFirmNoteAction,
  addFirmTaskAction,
  addStandardTasksAction,
  deleteFirmNoteAction,
  deleteFirmTaskAction,
  editFirmNoteAction,
  saveFirmTaskAction,
  toggleFirmTaskAction,
} from "@/actions/firm-workspace";
import { SubmitButton } from "@/components/submit-button";
import { firmWorkspace, NOTE_MAX, openTasksText, TASK_TITLE_MAX, type FirmPerson, type WorkspaceTask } from "@/lib/firm-workspace";
import { isoDate, prettyDate } from "@/lib/format";
import { when } from "@/lib/sale-events";
import type { ActingUser } from "@/lib/seats";
import { cn } from "@/lib/utils";

// What the panel and the tasks page say about privacy. The desk's pages never read these rows (lib/firm-workspace.ts).
export const PRIVATE_LINE = "Private to your firm; the seller and the desk can't see this.";

// The firm's notes and diligence tasks on one listing, for the Firm notes tab. Everyone on the firm's account reads
// it; a view-only seat reads without the forms. Anyone else, the desk included, gets nothing.
export async function FirmWorkspacePanel({ user, listingId }: { user: ActingUser; listingId: string }) {
  const view = await firmWorkspace(user, listingId);
  if (!view) return null;
  const { workspace, people, notes, tasks } = view;
  const open = tasks.filter((task) => !task.doneAt).length;
  return (
    <section id="firm" aria-labelledby="firm-heading" className="mt-8 min-w-0 scroll-mt-28 lg:scroll-mt-6">
      <h2 id="firm-heading" className="eyebrow">Firm notes</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {PRIVATE_LINE} Everyone on your firm&apos;s account reads it.
        {workspace.canWrite ? "" : " Your seat is view only, so you read without writing."}
      </p>

      <div id="firm-tasks" className="mt-6 scroll-mt-28 lg:scroll-mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-[13px] font-semibold text-foreground">Diligence tasks</h3>
          {tasks.length > 0 && <p className="text-[13px] text-muted-foreground tabular-nums">{openTasksText(open)}</p>}
        </div>
        <ul className="mt-3 divide-y divide-border border border-border rounded-xl">
          {tasks.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">No tasks yet.</li>}
          {tasks.map((task) => (
            <li key={task.id} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <TaskToggle task={task} canWrite={workspace.canWrite} listingId={listingId} />
                <div className="min-w-0 flex-1 pt-0.5">
                  <p className={cn("break-words text-sm", task.doneAt ? "text-muted-foreground line-through" : "text-foreground")}>{task.title}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[13px] text-muted-foreground">
                    <span className="break-words">{task.assignee ?? "Not assigned"}</span>
                    <DueLine task={task} />
                    {task.doneAt && <span>Done {prettyDate(task.doneAt)}{task.doneBy ? ` by ${task.doneBy}` : ""}</span>}
                  </p>
                  {workspace.canWrite && (
                    <details className="mt-1">
                      <summary className="inline-flex min-h-10 cursor-pointer items-center text-[13px] font-medium text-link">Change or delete</summary>
                      <form action={saveFirmTaskAction} className="mt-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
                        <input type="hidden" name="taskId" value={task.id} />
                        <input type="hidden" name="listingId" value={listingId} />
                        <AssigneeField people={people} me={workspace.personId} defaultValue={task.assigneeId ?? ""} />
                        <label className="block">
                          <span className="text-[13px] text-muted-foreground">Due</span>
                          <input type="date" name="due" defaultValue={isoDate(task.dueAt) ?? ""} className="desk-input mt-2" />
                        </label>
                        <div className="sm:col-span-2">
                          <SubmitButton variant="outline" className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Saving…">Save the task</SubmitButton>
                        </div>
                      </form>
                      <form action={deleteFirmTaskAction} className="mt-2">
                        <input type="hidden" name="taskId" value={task.id} />
                        <input type="hidden" name="listingId" value={listingId} />
                        <SubmitButton variant="ghost" className="h-10 px-0 text-[13px] font-medium text-bad" pendingLabel="Deleting…">Delete the task</SubmitButton>
                      </form>
                    </details>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {workspace.canWrite && (
          <>
            {view.standardOffered && (
              <form action={addStandardTasksAction} className="mt-3">
                <input type="hidden" name="listingId" value={listingId} />
                <SubmitButton variant="outline" className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Adding…">Add the standard diligence tasks</SubmitButton>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  One task for each loan document in this listing&apos;s diligence set, from the note to the assignment chain. Tasks your firm already has are skipped, and it runs once.
                </p>
              </form>
            )}
            <form action={addFirmTaskAction} className="mt-4 grid gap-3 border border-border p-4 rounded-xl sm:grid-cols-[minmax(0,1fr)_11rem]">
              <input type="hidden" name="listingId" value={listingId} />
              <label className="block sm:col-span-2">
                <span className="text-[13px] text-muted-foreground">New task</span>
                <input name="title" required minLength={2} maxLength={TASK_TITLE_MAX} className="desk-input mt-2" placeholder="Order the title search" />
              </label>
              <AssigneeField people={people} me={workspace.personId} defaultValue="" />
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Due, optional</span>
                <input type="date" name="due" className="desk-input mt-2" />
              </label>
              <div className="sm:col-span-2">
                <SubmitButton className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Adding…">Add the task</SubmitButton>
                <p className="mt-1.5 text-xs text-muted-foreground">Whoever you assign it to hears by email and in the app.</p>
              </div>
            </form>
          </>
        )}
      </div>

      <div id="firm-notes" className="mt-8 scroll-mt-28 lg:scroll-mt-6">
        <h3 className="text-[13px] font-semibold text-foreground">Notes</h3>
        {workspace.canWrite && (
          <form action={addFirmNoteAction} className="mt-3 space-y-2">
            <input type="hidden" name="listingId" value={listingId} />
            <label className="block">
              <span className="sr-only">New note</span>
              <textarea name="body" required maxLength={NOTE_MAX} className="desk-input min-h-24 py-2" placeholder="What the pay history shows, what to ask the seller, what's left to check" />
            </label>
            <SubmitButton className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Saving…">Add the note</SubmitButton>
          </form>
        )}
        <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
          {notes.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">No notes yet.</li>}
          {notes.map((note) => (
            <li key={note.id} className="min-w-0 px-4 py-3">
              <p className="break-words text-[13px] text-muted-foreground tabular-nums">
                {note.author} · {when(note.createdAt)}{note.edited ? " · edited" : ""}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{note.body}</p>
              {(note.canEdit || note.canDelete) && (
                <div className="mt-1 flex flex-wrap items-center gap-x-5">
                  {note.canEdit && (
                    <details className="open:basis-full">
                      <summary className="inline-flex min-h-10 cursor-pointer items-center text-[13px] font-medium text-link">Edit</summary>
                      <form action={editFirmNoteAction} className="mb-2 space-y-2">
                        <input type="hidden" name="noteId" value={note.id} />
                        <input type="hidden" name="listingId" value={listingId} />
                        <label className="block">
                          <span className="sr-only">Edit the note</span>
                          <textarea name="body" required maxLength={NOTE_MAX} defaultValue={note.body} className="desk-input min-h-24 py-2" />
                        </label>
                        <SubmitButton variant="outline" className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Saving…">Save the note</SubmitButton>
                      </form>
                    </details>
                  )}
                  {note.canDelete && (
                    <form action={deleteFirmNoteAction}>
                      <input type="hidden" name="noteId" value={note.id} />
                      <input type="hidden" name="listingId" value={listingId} />
                      <SubmitButton variant="ghost" className="h-10 px-0 text-[13px] font-medium text-bad" pendingLabel="Deleting…">Delete</SubmitButton>
                    </form>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// Anyone on the firm can take a task: the owner or a seat.
function AssigneeField({ people, me, defaultValue }: { people: FirmPerson[]; me: string; defaultValue: string }) {
  return (
    <label className="block min-w-0">
      <span className="text-[13px] text-muted-foreground">Assigned to</span>
      <select name="assigneeId" defaultValue={defaultValue} className="desk-input mt-2 min-w-0">
        <option value="">No one yet</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}{person.id === me ? " (you)" : person.owner ? " (account owner)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

// The check that marks a task done or open again, 40px square for a thumb. A view-only seat sees the state only.
export function TaskToggle({ task, canWrite, listingId, from }: { task: Pick<WorkspaceTask, "id" | "title" | "doneAt">; canWrite: boolean; listingId: string; from?: "tasks" }) {
  const icon = task.doneAt ? <CircleCheck className="size-5 text-good" aria-hidden /> : <Circle className="size-5 text-muted-foreground" aria-hidden />;
  if (!canWrite) {
    return (
      <span className="flex size-10 shrink-0 items-center justify-center -my-2 -ml-2" role="img" aria-label={task.doneAt ? "Done" : "Open"}>
        {icon}
      </span>
    );
  }
  return (
    <form action={toggleFirmTaskAction} className="-my-2 -ml-2 shrink-0">
      <input type="hidden" name="taskId" value={task.id} />
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="done" value={task.doneAt ? "no" : "yes"} />
      {from && <input type="hidden" name="from" value={from} />}
      <button
        type="submit"
        aria-label={task.doneAt ? `Open again: ${task.title}` : `Mark done: ${task.title}`}
        className="flex size-10 items-center justify-center rounded-lg transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        {icon}
      </button>
    </form>
  );
}

// "Due Dec 3, 2026", and marked once the day has passed with the task still open.
export function DueLine({ task }: { task: Pick<WorkspaceTask, "dueAt" | "overdue"> }) {
  if (!task.dueAt) return null;
  if (!task.overdue) return <span className="tabular-nums">Due {prettyDate(task.dueAt)}</span>;
  return (
    <span className="font-medium text-bad tabular-nums">
      Overdue · due {prettyDate(task.dueAt)}
    </span>
  );
}

// "3 open tasks" beside a listing on favorites and inquiries. Nothing when there are none.
export function OpenTasksCount({ count, className }: { count: number | undefined; className?: string }) {
  if (!count) return null;
  return <span className={cn("text-[13px] font-medium text-link tabular-nums", className)}>{openTasksText(count)}</span>;
}
