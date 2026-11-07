"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decideRoomAccess, setRoomApproval } from "@/lib/room-access";
import { deskDenied } from "@/lib/staff";

const PAGES: Record<string, (id: string) => string> = {
  seller: (id) => `/seller/listings/${id}`,
  broker: (id) => `/broker/deals/${id}`,
  admin: (id) => `/admin/listings/${id}`,
  resale: (id) => `/buyer/resales/${id}`,
};

function back(formData: FormData, listingId: string, outcome: { ok: true } | { ok: false; error: string }, notice: string): never {
  for (const page of [...Object.values(PAGES), (id: string) => `/marketplace/${id}`]) revalidatePath(page(listingId));
  const page = (PAGES[String(formData.get("from") || "")] ?? PAGES.seller)(listingId);
  const message = outcome.ok ? `notice=${encodeURIComponent(notice)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`${page}?${message}#room-access`);
}

export async function saveRoomApproval(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const on = String(formData.get("roomApproval") || "") === "on";
  const outcome = deskDenied(user, "sales") ?? (await setRoomApproval(user, { listingId, on }));
  const released = outcome.ok ? outcome.value.released : 0;
  back(
    formData,
    listingId,
    outcome,
    on
      ? "You approve each bidder now. A new NDA waits for your answer before the room opens."
      : `The room opens on the NDA alone again.${released ? ` ${released} waiting bidder${released === 1 ? " was" : "s were"} let in.` : ""}`,
  );
}

export async function answerRoomRequest(formData: FormData) {
  const user = await requireUser();
  const ndaId = String(formData.get("ndaId") || "");
  const nda = await prisma.ndaAcknowledgment.findUnique({ where: { id: ndaId }, select: { listingId: true } });
  if (!nda) redirect("/");
  const decision = String(formData.get("decision") || "");
  const outcome = deskDenied(user, "sales") ?? (await decideRoomAccess(user, { ndaId, decision }));
  back(formData, nda.listingId, outcome, decision === "APPROVED" ? "Approved. The bidder's room is open, and they were told." : "Declined. The bidder was told, and the room stays shut to them.");
}
