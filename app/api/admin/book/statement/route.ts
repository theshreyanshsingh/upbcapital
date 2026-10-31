import { getApiUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const user = await getApiUser();
  if (!user || user.role !== "ADMIN") return new Response("The desk only.", { status: 403 });
  const holdings = await prisma.deskHolding.findMany({ include: { payments: true }, orderBy: { acquiredAt: "desc" } });
  const rows = holdings.map((holding) => {
    const received = holding.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    return {
      title: holding.title,
      status: holding.status,
      cost: Number(holding.costBasis),
      upb: Number(holding.upb),
      acquired: holding.acquiredAt.toISOString().slice(0, 10),
      received,
      roi: Number(holding.costBasis) > 0 ? ((received - Number(holding.costBasis)) / Number(holding.costBasis)) * 100 : "",
    };
  });
  return new Response(toCsv(rows.length ? rows : [{ title: "", status: "", cost: "", upb: "", acquired: "", received: "", roi: "" }]), {
    headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=\"desk-book.csv\"" },
  });
}
