import { prisma } from "@/lib/prisma";
import { SOUTH_FLORIDA_COSTS } from "@/lib/rehab";

// Seeds the rehab unit-cost table the first time a desk page needs it. It lives here, not in a server action file,
// because every export of a "use server" file is a public endpoint.
export async function ensureUnitCosts() {
  const count = await prisma.unitCost.count();
  if (count > 0) return;
  await prisma.unitCost.createMany({
    data: SOUTH_FLORIDA_COSTS.map((row) => ({ ...row, region: "South Florida" })),
  });
}
