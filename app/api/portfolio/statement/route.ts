import { getApiUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const user = await getApiUser();
  if (!user || user.role !== "BUYER") return new Response("Buyers only.", { status: 403 });
  const holdings = await prisma.buyerHolding.findMany({
    where: { userId: user.id },
    include: { payments: { orderBy: { paidOn: "asc" } } },
    orderBy: { acquiredAt: "desc" },
  });
  const rows = holdings.flatMap((holding) => {
    const received = holding.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    const base = {
      title: holding.title,
      status: holding.status,
      cost: Number(holding.costBasis),
      upb: Number(holding.upb),
      underwrittenYield: holding.underwrittenYield == null ? "" : Number(holding.underwrittenYield),
      acquired: holding.acquiredAt.toISOString().slice(0, 10),
      received,
    };
    if (!holding.payments.length) return [{ ...base, paidOn: "", amount: null as number | null, memo: "" }];
    return holding.payments.map((payment) => ({
      ...base,
      paidOn: payment.paidOn.toISOString().slice(0, 10),
      amount: Number(payment.amount) as number | null,
      memo: payment.memo,
    }));
  });
  const csv = toCsv(rows.length ? rows : [{ title: "", status: "", cost: "", upb: "", underwrittenYield: "", acquired: "", received: "", paidOn: "", amount: "", memo: "" }]);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": "attachment; filename=\"portfolio.csv\"",
    },
  });
}
