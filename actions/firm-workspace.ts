"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  addFirmNote,
  addFirmTask,
  addStandardTasks,
  deleteFirmNote,
  deleteFirmTask,
  editFirmNote,
  saveFirmTask,
  setFirmTaskDone,
} from "@/lib/firm-workspace";

const TASKS = "/buyer/tasks";

type Outcome = { error: string; listingId?: string } | { error: null; listingId: string };

// Back to the listing's Firm notes tab, or to the tasks page when the form came from there. The lib reads the firm
// from the session and checks every id against it; the form's listing id only picks the page to return to.
function back(formData: FormData, outcome: Outcome, notice: string, hash = "#firm"): never {
  const asked = String(formData.get("listingId") || "");
  const listingId = outcome.listingId ?? (/^[A-Za-z0-9_-]{1,64}$/.test(asked) ? asked : "");
  const message = outcome.error !== null ? `error=${encodeURIComponent(outcome.error)}` : `notice=${encodeURIComponent(notice)}`;
  revalidatePath(TASKS);
  if (listingId) revalidatePath(`/marketplace/${listingId}`);
  if (formData.get("from") === "tasks" || !listingId) redirect(`${TASKS}?${message}`);
  redirect(`/marketplace/${listingId}?tab=firm&${message}${hash}`);
}

export async function addFirmNoteAction(formData: FormData) {
  const user = await requireUser();
  back(formData, await addFirmNote(user, formData), "Note added. Only your firm reads it.", "#firm-notes");
}

export async function editFirmNoteAction(formData: FormData) {
  const user = await requireUser();
  back(formData, await editFirmNote(user, formData), "Note saved.", "#firm-notes");
}

export async function deleteFirmNoteAction(formData: FormData) {
  const user = await requireUser();
  back(formData, await deleteFirmNote(user, formData), "Note deleted.", "#firm-notes");
}

export async function addFirmTaskAction(formData: FormData) {
  const user = await requireUser();
  const outcome = await addFirmTask(user, formData);
  back(formData, outcome, outcome.error === null && outcome.told ? "Task added. The person it's assigned to was told." : "Task added.", "#firm-tasks");
}

export async function saveFirmTaskAction(formData: FormData) {
  const user = await requireUser();
  const outcome = await saveFirmTask(user, formData);
  back(formData, outcome, outcome.error === null && outcome.told ? "Task saved. The person it's assigned to was told." : "Task saved.", "#firm-tasks");
}

export async function toggleFirmTaskAction(formData: FormData) {
  const user = await requireUser();
  const outcome = await setFirmTaskDone(user, formData);
  back(formData, outcome, outcome.error === null && !outcome.done ? "Task opened again." : "Task done.", "#firm-tasks");
}

export async function deleteFirmTaskAction(formData: FormData) {
  const user = await requireUser();
  back(formData, await deleteFirmTask(user, formData), "Task deleted.", "#firm-tasks");
}

export async function addStandardTasksAction(formData: FormData) {
  const user = await requireUser();
  const outcome = await addStandardTasks(user, formData);
  const added = outcome.error === null ? outcome.added : 0;
  const skipped = outcome.error === null ? outcome.skipped : 0;
  const text = added
    ? `Added ${added} standard diligence task${added === 1 ? "" : "s"}${skipped ? `, and skipped ${skipped} your firm already had` : ""}.`
    : "Your firm already had every standard diligence task here, so nothing was added.";
  back(formData, outcome, text, "#firm-tasks");
}
