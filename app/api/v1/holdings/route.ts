import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { badRequest, paginate, readPage } from "@/lib/buyer-api";
import { ensureBuyerHolding } from "@/lib/portfolio";
import { prisma } from "@/lib/prisma";

// The paper this account holds, as its portfolio page lists it. A holding has no edit time, so updated_since reads
// when it was acquired.
export async function GET(request: Request) {
  const caller = await apiCaller(request, "holdings:read");
  if (caller.response) return caller.response;
  const page = readPage(new URL(request.url));
  if ("error" in page) return badRequest(page.error);
  const userId = caller.user.id;
  // A completed closing becomes a holding when the portfolio first reads it, so the API reads it the same way.
  const [mine, seats] = await Promise.all([
    prisma.inquiry.findMany({ where: { buyerId: userId }, select: { id: true } }),
    prisma.closingFunder.findMany({ where: { userId }, select: { closingId: true } }),
  ]);
  const closings = await prisma.closing.findMany({
    where: { status: "COMPLETE", OR: [{ inquiryId: { in: mine.map((row) => row.id) } }, { id: { in: seats.map((row) => row.closingId) } }] },
    select: { id: true },
  });
  for (const closing of closings) await ensureBuyerHolding(closing.id);
  const holdings = await prisma.buyerHolding.findMany({ where: { userId } });
  const shown = paginate(holdings, (holding) => holding.acquiredAt, page);
  return NextResponse.json({
    holdings: shown.rows.map((holding) => ({
      id: holding.id,
      title: holding.title,
      listingId: holding.listingId ?? null,
      closingId: holding.closingId ?? null,
      status: holding.status,
      costBasis: holding.costBasis,
      upb: holding.upb,
      sharePercent: holding.sharePercent ?? null,
      underwrittenYield: holding.underwrittenYield ?? null,
      acquiredAt: holding.acquiredAt.toISOString(),
    })),
    nextCursor: shown.nextCursor,
  });
}
