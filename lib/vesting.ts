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
