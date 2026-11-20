"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser, requireRole } from "@/lib/auth";
import { addWatchedNote, deleteWatchedNote, editWatchedNote, setWatchAlerts, WATCH_FIELDS, watchFromValuation } from "@/lib/note-watch";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function fields(formData: FormData) {
  return Object.fromEntries(WATCH_FIELDS.map((key) => [key, text(formData, key)]));
}

function back(kind: "notice" | "error", message: string, anchor = ""): never {
  revalidatePath("/seller/watch");
  redirect(`/seller/watch?${kind}=${encodeURIComponent(message)}${anchor}`);
}

const seller = () => requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);

export async function addNoteToWatch(formData: FormData) {
  const user = await seller();
  const result = await addWatchedNote(user, fields(formData));
  if (result.error !== null) back("error", result.error, "#add");
  back("notice", "The note is on watch. Its first reading is below, and the next comes by email in about a month.", `#note-${result.id}`);
}

export async function editNoteOnWatch(formData: FormData) {
  const user = await seller();
  const id = text(formData, "noteId");
  const result = await editWatchedNote(user, id, fields(formData));
  if (result.error !== null) {
    revalidatePath(`/seller/watch/${id}`);
    redirect(`/seller/watch/${encodeURIComponent(id)}?error=${encodeURIComponent(result.error)}`);
  }
  back("notice", "Saved. The reading below is from the figures as they are now.", `#note-${result.id}`);
}

export async function setNoteWatchAlerts(formData: FormData) {
  const user = await seller();
  const on = text(formData, "alerts") === "on";
  const result = await setWatchAlerts(user, text(formData, "noteId"), on);
  if (result.error !== null) back("error", result.error);
  back("notice", on ? "The monthly email covers this note again." : "No more monthly email for this note. It stays on your watch.", `#note-${result.id}`);
}

export async function deleteNoteFromWatch(formData: FormData) {
  const user = await seller();
  const result = await deleteWatchedNote(user, text(formData, "noteId"));
  if (result.error !== null) back("error", result.error);
  back("notice", "The note is off your watch.");
}

// "Keep watching this note" on a Value my loans result. Signed out, the visitor goes to signup with the valuation, and
// comes back here to finish.
export async function keepWatchingValuation(formData: FormData) {
  const id = text(formData, "valuationId");
  const page = `/sell/value/${encodeURIComponent(id)}`;
  const user = await getCurrentUser().catch(() => null);
  if (!user) redirect(`/signup?valuation=${encodeURIComponent(id)}&next=${encodeURIComponent(`${page}#watch`)}`);
  const result = await watchFromValuation(user, { valuationId: id, label: text(formData, "label") });
  if (result.error !== null) redirect(`${page}?error=${encodeURIComponent(result.error)}#watch`);
  back("notice", result.already ? "This note is already on your watch." : "The note is on watch. Its first reading is below, and the next comes by email in about a month.", `#note-${result.id}`);
}
