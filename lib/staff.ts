import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { canOwnDeals, deskCan, deskRoleOf, deskWrites, DESK_DENIED, DESK_ROLE_LABELS, isDeskRole, type DeskCapability, type Staff } from "@/lib/desk-roles";
import { prisma } from "@/lib/prisma";

// Desk staff are ADMIN accounts with a role that says what each may do. One person shouldn't both read sealed bids
// and buy for UPB's own book, or change wire instructions and approve the change. An account with no role is an
// OWNER, so the desk as it was keeps working. The rules themselves are in lib/desk-roles.ts, which has no server
// imports; this module adds the checks that need a session or the database.
export * from "@/lib/desk-roles";

function deniedAt(back: string) {
  return `${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(DESK_DENIED)}`;
}

// For server actions: a signed-in desk member whose role covers the capability, or a redirect with the reason.
// The auth module is loaded on call, so tests can read the rules here without a request.
export async function requireDesk(capability: DeskCapability, back = "/admin") {
  const { requireRole } = await import("@/lib/auth");
  const user = await requireRole(["ADMIN"]);
  if (!deskCan(user, capability)) redirect(deniedAt(back));
  return user;
}

// For desk notes and thread posts: any desk role that writes something.
export async function requireDeskWriter(back = "/admin") {
  const { requireRole } = await import("@/lib/auth");
  const user = await requireRole(["ADMIN"]);
  if (!deskWrites(user)) redirect(deniedAt(back));
  return user;
}

// For forms a seller, buyer or the desk can submit. A desk member still needs the capability; anyone else passes
// through to the action's own checks.
export function guardDesk(user: Staff, capability: DeskCapability, back: string) {
  if (user.role === "ADMIN" && !deskCan(user, capability)) redirect(deniedAt(back));
}

// The same check for actions that answer with an outcome rather than a redirect.
export function deskDenied(user: Staff, capability: DeskCapability) {
  return user.role === "ADMIN" && !deskCan(user, capability) ? ({ ok: false, error: DESK_DENIED } as const) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Setting a desk role. Only an owner does it, and the desk always keeps one owner who can still sign in.

type StaffRow = Staff & { id: string; accountStatus?: string | null; deletedAt?: Date | null };

function activeOwner(user: StaffRow) {
  return deskRoleOf(user) === "OWNER" && user.accountStatus !== "SUSPENDED" && user.accountStatus !== "REJECTED" && !user.deletedAt;
}

export function deskRoleProblem(input: { actor: Staff; target: StaffRow | null; role: unknown; owners: StaffRow[] }) {
  if (!deskCan(input.actor, "admin")) return DESK_DENIED;
  if (!input.target || input.target.role !== "ADMIN") return "Desk roles are for desk accounts.";
  if (!isDeskRole(input.role)) return "Choose a desk role.";
  const others = input.owners.filter((owner) => owner.id !== input.target!.id && activeOwner(owner));
  if (input.role !== "OWNER" && deskRoleOf(input.target) === "OWNER" && others.length === 0) {
    return "The desk needs at least one owner. Make someone else an owner first.";
  }
  return null;
}

export async function setDeskRole(actor: StaffRow, targetId: string, role: unknown) {
  const [target, admins] = await Promise.all([
    prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, deskRole: true, accountStatus: true, deletedAt: true, name: true } }),
    prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true, role: true, deskRole: true, accountStatus: true, deletedAt: true } }),
  ]);
  const problem = deskRoleProblem({ actor, target, role, owners: admins });
  if (problem || !target || !isDeskRole(role)) return { error: problem ?? "Choose a desk role." } as const;
  const before = deskRoleOf(target) ?? "OWNER";
  if (before === role) return { error: null, changed: false } as const;
  await prisma.user.update({ where: { id: target.id }, data: { deskRole: role } });
  await audit(actor.id, "DESK_ROLE", "user", target.id, `${target.name}: ${DESK_ROLE_LABELS[before]} to ${DESK_ROLE_LABELS[role]}`);
  return { error: null, changed: true } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// The named deal owner, named to the seller, the broker and the buyer in closing as their contact.

export async function dealOwners() {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", accountStatus: { notIn: ["SUSPENDED", "REJECTED"] } },
    select: { id: true, name: true, email: true, role: true, deskRole: true, deletedAt: true },
    orderBy: { name: "asc" },
  });
  return admins.filter((admin) => !admin.deletedAt && canOwnDeals(admin));
}

// The owner as the seller, broker or buyer sees them. A removed or suspended desk account names no one.
export async function deskContact(ownerId: string | null | undefined) {
  if (!ownerId) return null;
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true, email: true, role: true, accountStatus: true, deletedAt: true } });
  if (!owner || owner.role !== "ADMIN" || owner.deletedAt || owner.accountStatus === "SUSPENDED" || owner.accountStatus === "REJECTED") return null;
  return { name: owner.name, email: owner.email };
}

export async function assignDealOwner(actor: StaffRow, input: { kind: "listing" | "closing"; id: string; ownerId: string }) {
  if (!deskCan(actor, input.kind === "listing" ? "sales" : "closings")) return { error: DESK_DENIED } as const;
  const owner = input.ownerId
    ? await prisma.user.findUnique({ where: { id: input.ownerId }, select: { id: true, name: true, role: true, deskRole: true, accountStatus: true, deletedAt: true } })
    : null;
  if (input.ownerId && (!owner || owner.role !== "ADMIN" || owner.deletedAt || owner.accountStatus === "SUSPENDED" || owner.accountStatus === "REJECTED" || !canOwnDeals(owner))) {
    return { error: "Choose a desk member who runs sales or closings." } as const;
  }
  const deskOwnerId = owner?.id ?? null;
  const moved = input.kind === "listing"
    ? await prisma.listing.updateMany({ where: { id: input.id }, data: { deskOwnerId } })
    : await prisma.closing.updateMany({ where: { id: input.id }, data: { deskOwnerId } });
  if (moved.count !== 1) return { error: input.kind === "listing" ? "Listing not found." : "Closing not found." } as const;
  await audit(actor.id, "DEAL_OWNER", input.kind, input.id, owner ? `Owner ${owner.name}` : "Owner cleared");
  return { error: null, owner } as const;
}
