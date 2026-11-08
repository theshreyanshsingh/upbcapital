"use server";

import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { requireUser } from "@/lib/auth";
import { deskWrites } from "@/lib/staff";
import { prisma } from "@/lib/prisma";
import { notifyThread, threadWall } from "@/lib/threads";
import { putBytes } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";
import crypto from "crypto";

async function canPost(userId: string, role: string, threadId: string, deskRole?: string | null) {
  // A read-only desk account reads every thread and posts in none, and no desk role posts in a thread behind its wall.
  if (role === "ADMIN") {
    if (!deskWrites({ role, deskRole })) return false;
    const thread = await prisma.deskThread.findUnique({ where: { id: threadId }, select: { id: true, inquiryId: true } });
    return thread ? !(await threadWall({ role, deskRole }, thread)) : false;
  }
  const seat = await prisma.threadMember.findUnique({ where: { threadId_userId: { threadId, userId } } });
  return Boolean(seat);
}

export async function postThread(formData: FormData) {
  const user = await requireUser();
  const threadId = String(formData.get("threadId") || "");
  const body = String(formData.get("body") || "").trim();
  if (!(await canPost(user.id, user.role, threadId, user.deskRole))) redirect("/inbox?error=That thread is closed to this account.");
  // A post speaks for the account, so a firm's seat needs a role that writes (lib/seats.ts).
  const gated = await actionGate(user, "message");
  if (gated) redirect(`/inbox/${threadId}?error=${encodeURIComponent(gated)}`);
  const file = formData.get("file");
  const hasFile = file instanceof File && file.size > 0;
  if (body.length < 1 && !hasFile) redirect(`/inbox/${threadId}?error=Write a note or attach a file.`);
  if (body.length > 4000) redirect(`/inbox/${threadId}?error=Keep the note under 4,000 characters.`);
  let stored: { name: string; key: string; mime: string; size: number } | null = null;
  if (hasFile && file instanceof File) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const problem = uploadProblem(file.name, bytes.length, bytes);
    if (problem) redirect(`/inbox/${threadId}?error=${encodeURIComponent(problem)}`);
    const key = `threads/${threadId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60)}`;
    await putBytes(key, bytes, file.type || "application/octet-stream");
    stored = { name: file.name, key, mime: file.type || "application/octet-stream", size: bytes.length };
  }
  await prisma.threadPost.create({
    data: {
      threadId,
      authorId: user.id,
      body: body || "Attachment.",
      files: stored ? { create: { originalName: stored.name, storageKey: stored.key, mime: stored.mime, size: stored.size } } : undefined,
    },
  });
  await prisma.threadMember.upsert({
    where: { threadId_userId: { threadId, userId: user.id } },
    create: { threadId, userId: user.id, lastReadAt: new Date() },
    update: { lastReadAt: new Date() },
  });
  await prisma.deskThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
  await notifyThread(threadId, user.id, body || "A file was added.");
  redirect(`/inbox/${threadId}?notice=message`);
}
