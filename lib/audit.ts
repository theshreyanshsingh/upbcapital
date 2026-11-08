import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

// When a firm's seat is signed in and acts for the account, the event names the seat too, so the log says which
// person did it (lib/seats.ts). Outside a request, as in a job or a test, there is no session and no seat.
async function sessionSeat(accountId: string) {
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const session = token ? await verifySession(token) : null;
    if (!session || session.sub === accountId) return null;
    const person = await prisma.user.findUnique({ where: { id: session.sub }, select: { principalId: true } });
    return person?.principalId === accountId ? session.sub : null;
  } catch {
    return null;
  }
}

// seatId names the seat when the caller knows it. Otherwise the session says.
export async function audit(actorId: string | null, action: string, entityType: string, entityId: string, detail = "", seatId?: string | null) {
  const seat = seatId ?? (actorId ? await sessionSeat(actorId) : null);
  await prisma.auditEvent.create({ data: { actorId, ...(seat ? { seatId: seat } : {}), action, entityType, entityId, detail: detail.slice(0, 500) } });
}
