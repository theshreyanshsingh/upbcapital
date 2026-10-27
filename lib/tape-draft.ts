import { prisma } from "@/lib/prisma";

export const TAPE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export function tapeDraftCutoff(now = new Date()) {
  return new Date(now.getTime() - TAPE_DRAFT_TTL_MS);
}

export function tapeDraftFresh(createdAt: Date, now = new Date()) {
  return createdAt.getTime() > tapeDraftCutoff(now).getTime();
}

export async function saveTapeDraft(input: { token: string; userId: string; filename: string; bytes: Buffer }) {
  await prisma.tapeDraft.create({
    data: { token: input.token, userId: input.userId, filename: input.filename, bytes: input.bytes },
  });
}

export async function readTapeDraft(userId: string, token: string) {
  const draft = await prisma.tapeDraft.findUnique({ where: { token } });
  if (!draft || draft.userId !== userId) return null;
  if (!tapeDraftFresh(draft.createdAt)) {
    await prisma.tapeDraft.delete({ where: { token } }).catch(() => undefined);
    return null;
  }
  return { filename: draft.filename, bytes: Buffer.from(draft.bytes) };
}

export async function deleteTapeDraft(token: string) {
  await prisma.tapeDraft.delete({ where: { token } }).catch(() => undefined);
}

export async function purgeTapeDrafts(now = new Date()) {
  const removed = await prisma.tapeDraft.deleteMany({ where: { createdAt: { lt: tapeDraftCutoff(now) } } });
  return removed.count;
}
