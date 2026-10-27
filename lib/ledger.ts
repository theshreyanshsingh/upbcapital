import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Ledger rows are keyed by externalId, so posting the same event twice leaves one row.
export async function postRevenueOnce(events: Prisma.RevenueEventCreateInput[]) {
  for (const event of events) {
    if (!event.externalId) {
      await prisma.revenueEvent.create({ data: event });
      continue;
    }
    try {
      await prisma.revenueEvent.upsert({ where: { externalId: event.externalId }, create: event, update: {} });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }
}
