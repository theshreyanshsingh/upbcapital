import { getApiUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const user = await getApiUser();
  if (!user || user.role !== "ADMIN") return new Response("The desk only.", { status: 403 });
  const investors = await prisma.investor.findMany({
    include: { commitments: true, allocations: { include: { holding: { include: { payments: true } } } } },
    orderBy: { name: "asc" },
  });
  const rows = investors.flatMap((investor) => {
    const committed = investor.commitments.reduce((sum, row) => sum + Number(row.amount), 0);
    if (!investor.allocations.length) {
      return [{ investor: investor.name, email: investor.email, note: "", allocated: 0, receipts: 0, committed, cashReturn: "" }];
    }
    return investor.allocations.map((row) => {
      const cost = Number(row.holding.costBasis);
      const cash = row.holding.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
      const receipts = cost > 0 ? cash * (Number(row.amount) / cost) : 0;
      const allocated = Number(row.amount);
      return {
        investor: investor.name,
        email: investor.email,
        note: row.holding.title,
        allocated,
        receipts: Math.round(receipts * 100) / 100,
        committed,
        cashReturn: allocated > 0 ? ((receipts / allocated) * 100).toFixed(1) : "",
      };
    });
  });
  const empty = { investor: "", email: "", note: "", allocated: "", receipts: "", committed: "", cashReturn: "" };
  return new Response(toCsv(rows.length ? rows : [empty]), {
    headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=\"investor-statements.csv\"" },
  });
}
