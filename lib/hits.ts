import { prisma } from "@/lib/prisma";

export async function recordHit(path: string) {
  await prisma.pageHit.create({ data: { path } }).catch(() => null);
}
