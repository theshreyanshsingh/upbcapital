import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { buyerSideEmails } from "@/lib/closing-service";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache } from "@/lib/settings";

// Four eyes on wire instructions. Changed wire details are the classic closing fraud, so a change to a closing's
// instructions or to the desk default waits as a proposal until a second desk member approves it. Until then the
// instructions on file stay as they are.

type Actor = Staff & { id: string; name?: string };

const excerpt = (text: string) => (text.trim() ? text.trim().slice(0, 200) : "none");

export const WIRES_CHANGED_WARNING = "The desk changed the wire instructions on this closing. Before sending money, confirm them by phone on a number you already trust.";

export async function proposeWireChange(actor: Actor, input: { closingId: string | null; instructions: string; reason?: string }) {
  const instructions = input.instructions.trim().slice(0, 4000);
  const reason = (input.reason ?? "").trim().slice(0, 300);
  const closingId = input.closingId || null;
  if (!deskCan(actor, closingId ? "closings" : "admin")) return { error: DESK_DENIED } as const;
  let current: string;
  let title = "the desk default";
  if (closingId) {
    const closing = await prisma.closing.findUnique({ where: { id: closingId }, select: { status: true, wireInstructions: true, listing: { select: { title: true } } } });
    if (!closing) return { error: "Closing not found." } as const;
    if (closing.status !== "OPEN") return { error: "This closing is already finished." } as const;
    current = closing.wireInstructions;
    title = closing.listing.title;
  } else {
    current = (await prisma.platformSettings.findUnique({ where: { id: "default" }, select: { wireInstructions: true } }))?.wireInstructions ?? "";
  }
  if (instructions === current.trim()) return { error: null, change: null } as const;
  const waiting = await prisma.wireChange.findFirst({ where: { status: "PENDING", ...(closingId ? { closingId } : unset("closingId")) } });
  if (waiting) return { error: "A wire change is already waiting for approval. Approve or reject it first." } as const;
  const change = await prisma.wireChange.create({ data: { closingId, proposedById: actor.id, instructions, reason } });
  await audit(actor.id, "WIRE_PROPOSED", closingId ? "closing" : "settings", closingId ?? "default", `Change ${change.id}. Before: ${excerpt(current)}. Proposed: ${excerpt(instructions)}.${reason ? ` Reason: ${reason}` : ""}`);
  await notifyDesk(
    `Wire change to approve · ${title}`,
    `${actor.name ?? "A desk member"} proposed new wire instructions for ${title}. They take effect only when another desk member who approves wires approves them${closingId ? ` on the closing page` : " on the fee schedule page"}.`,
  );
  return { error: null, change } as const;
}

export async function decideWireChange(actor: Actor, input: { changeId: string; decision: string; note?: string }) {
  if (!deskCan(actor, "approveWires")) return { error: DESK_DENIED } as const;
  if (input.decision !== "APPROVED" && input.decision !== "REJECTED") return { error: "Choose approve or reject." } as const;
  const change = await prisma.wireChange.findUnique({ where: { id: input.changeId } });
  if (!change || change.status !== "PENDING") return { error: "That wire change is already decided." } as const;
  // Rejecting your own proposal is withdrawing it. Approving it would be one pair of eyes.
  if (input.decision === "APPROVED" && change.proposedById === actor.id) {
    return { error: "You proposed this change, so another desk member approves it." } as const;
  }
  const closing = change.closingId
    ? await prisma.closing.findUnique({ where: { id: change.closingId }, select: { id: true, status: true, wireInstructions: true, listing: { select: { title: true, seller: { select: { email: true } } } } } })
    : null;
  if (input.decision === "APPROVED" && change.closingId && closing?.status !== "OPEN") return { error: "This closing is already finished." } as const;
  const note = (input.note ?? "").trim().slice(0, 300);
  const decided = await prisma.wireChange.updateMany({
    where: { id: change.id, status: "PENDING" },
    data: { status: input.decision, decidedById: actor.id, decidedAt: new Date() },
  });
  if (decided.count !== 1) return { error: "That wire change is already decided." } as const;
  const entityType = change.closingId ? "closing" : "settings";
  const entityId = change.closingId ?? "default";
  if (input.decision === "REJECTED") {
    await audit(actor.id, "WIRE_REJECTED", entityType, entityId, `Change ${change.id}${note ? `. ${note}` : ""}`);
    const proposer = await prisma.user.findUnique({ where: { id: change.proposedById }, select: { email: true } });
    if (proposer && change.proposedById !== actor.id) {
      await notify(proposer.email, `Wire change rejected · ${closing?.listing.title ?? "the desk default"}`, `${actor.name ?? "A desk member"} rejected the wire instructions you proposed. The instructions on file are unchanged.${note ? ` ${note}` : ""}`);
    }
    return { error: null, applied: false, withdrawn: change.proposedById === actor.id } as const;
  }
  await audit(actor.id, "WIRE_APPROVED", entityType, entityId, `Change ${change.id}, proposed by ${change.proposedById}${note ? `. ${note}` : ""}`);
  if (closing) {
    await prisma.closing.update({ where: { id: closing.id }, data: { wireInstructions: change.instructions } });
    // WIRE_EDIT is the entry the deal timeline shows the parties.
    await audit(actor.id, "WIRE_EDIT", "closing", closing.id, `Before: ${excerpt(closing.wireInstructions)}. After: ${excerpt(change.instructions)}. Approved change ${change.id}.`);
    // Each side hears about it from the desk, as they did before changes needed a second pair of eyes.
    for (const email of [...(await buyerSideEmails(closing.id)), closing.listing.seller.email]) {
      await notify(email, `Wires changed · ${closing.listing.title}`, WIRES_CHANGED_WARNING);
    }
  } else {
    const before = (await prisma.platformSettings.findUnique({ where: { id: "default" }, select: { wireInstructions: true } }))?.wireInstructions ?? "";
    await prisma.platformSettings.upsert({ where: { id: "default" }, update: { wireInstructions: change.instructions }, create: { id: "default", wireInstructions: change.instructions } });
    clearSettingsCache();
    await audit(actor.id, "WIRE_EDIT", "settings", "default", `Before: ${excerpt(before)}. After: ${excerpt(change.instructions)}. Approved change ${change.id}.`);
  }
  return { error: null, applied: true } as const;
}

// The proposals waiting on a closing, or on the desk default when closingId is null, with who proposed each.
export async function pendingWireChanges(closingId: string | null) {
  const rows = await prisma.wireChange.findMany({
    where: { status: "PENDING", ...(closingId ? { closingId } : unset("closingId")) },
    orderBy: { createdAt: "asc" },
  });
  const people = rows.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.proposedById))] } }, select: { id: true, name: true } })).map((person) => [person.id, person.name]))
    : new Map<string, string>();
  return rows.map((row) => ({ ...row, proposedBy: people.get(row.proposedById) ?? "A desk member" }));
}
