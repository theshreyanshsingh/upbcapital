import { prisma } from "@/lib/prisma";

// The name each buyer takes title in: the investing entity on their buyer file, which the desk vetted, or their
// company or account name when they have no file.
export async function vestingNames(userIds: string[]) {
  if (!userIds.length) return new Map<string, string>();
  const [profiles, users] = await Promise.all([
    prisma.buyerProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true, entityName: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, companyName: true } }),
  ]);
  const entities = new Map(profiles.map((profile) => [profile.userId, profile.entityName.trim()]));
  return new Map(users.map((user) => [user.id, entities.get(user.id) || user.companyName.trim() || user.name]));
}

type VestingEntity = { name: string; entityType: string; iraAccountTitle?: string | null };

// An IRA takes title in its account title, which names the custodian for the buyer's benefit. Any other entity
// takes title in its own name.
export function entityVestingName(entity: VestingEntity) {
  const title = entity.entityType === "IRA" ? entity.iraAccountTitle?.trim() : "";
  return title || entity.name.trim();
}

// The name a won bid takes title in, fixed at award: the buying entity the buyer chose on the bid, or the main file
// when they chose none. An entity that isn't the buyer's own falls back to the main file, so a bad id can't name a
// stranger on the papers.
export async function bidVesting(bid: { buyerId: string; buyerEntityId?: string | null }) {
  if (bid.buyerEntityId) {
    const entity = await prisma.buyerEntity.findUnique({ where: { id: bid.buyerEntityId } });
    if (entity && entity.userId === bid.buyerId) return { name: entityVestingName(entity), entityId: entity.id };
  }
  return { name: (await vestingNames([bid.buyerId])).get(bid.buyerId) ?? null, entityId: null };
}

// Who the closing papers name. The names fixed at award win; a closing opened before they were kept reads the
// buyer files as they stand now.
export async function namesOnTitle(
  closing: { buyerEntity?: string | null },
  buyerId: string | null,
  funders: { userId: string; entityName?: string | null }[],
) {
  const unfixed = [...(buyerId && !closing.buyerEntity ? [buyerId] : []), ...funders.filter((funder) => !funder.entityName).map((funder) => funder.userId)];
  const now = await vestingNames(unfixed);
  return {
    buyer: closing.buyerEntity || (buyerId ? (now.get(buyerId) ?? null) : null),
    funder: (funder: { userId: string; entityName?: string | null }) => funder.entityName || now.get(funder.userId) || null,
  };
}

// For a closing bought through a self-directed IRA: the custodian, who signs for the account and sends the deposit
// and balance wires, and the account title the papers name. Null for any other buyer.
export async function fundingParty(closing: { buyerEntityId?: string | null }) {
  if (!closing.buyerEntityId) return null;
  const entity = await prisma.buyerEntity.findUnique({ where: { id: closing.buyerEntityId }, select: { entityType: true, iraCustodian: true, iraAccountTitle: true } });
  if (!entity || entity.entityType !== "IRA" || !entity.iraCustodian?.trim()) return null;
  return { custodian: entity.iraCustodian.trim(), accountTitle: entity.iraAccountTitle?.trim() || "" };
}

export const CUSTODIAN_FUNDS = "The custodian signs for the account and sends the deposit and balance wires.";
