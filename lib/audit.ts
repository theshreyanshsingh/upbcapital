import { prisma } from "@/lib/prisma";

export async function audit(actorId: string | null, action: string, entityType: string, entityId: string, detail = "") {
  await prisma.auditEvent.create({ data: { actorId, action, entityType, entityId, detail: detail.slice(0, 500) } });
}
