"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const SUBJECTS = new Set(["listing", "closing", "user"]);

function backTo(raw: string) {
  return raw.startsWith("/") && !raw.startsWith("//") ? raw.split("?")[0] : "/admin";
}

export async function addDeskNote(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const subjectType = String(formData.get("subjectType") || "");
  const subjectId = String(formData.get("subjectId") || "");
  const body = String(formData.get("body") || "").trim().slice(0, 2000);
  const back = backTo(String(formData.get("back") || ""));
  if (!SUBJECTS.has(subjectType) || !subjectId) redirect(`${back}?error=That note has nothing to attach to.`);
  if (body.length < 2) redirect(`${back}?error=${encodeURIComponent("Write the note first.")}`);
  await prisma.deskNote.create({ data: { subjectType, subjectId, authorId: user.id, body } });
  revalidatePath(back);
  redirect(`${back}?notice=desk_note`);
}

export async function removeDeskNote(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const noteId = String(formData.get("noteId") || "");
  const back = backTo(String(formData.get("back") || ""));
  const note = await prisma.deskNote.findUnique({ where: { id: noteId } });
  if (!note) redirect(back);
  if (note.authorId !== user.id) redirect(`${back}?error=${encodeURIComponent("Only the person who wrote a note removes it.")}`);
  await prisma.deskNote.delete({ where: { id: noteId } });
  revalidatePath(back);
  redirect(`${back}?notice=desk_note_removed`);
}
