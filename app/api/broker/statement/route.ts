import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/auth";
import { brokerRoleLabel } from "@/lib/broker-fees";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const user = await getApiUser();
  if (!user || user.role !== "BROKER") return new NextResponse("Sign in as a broker.", { status: 401 });
  const fees = await prisma.brokerFee.findMany({
    where: { brokerId: user.id },
    include: { closing: { include: { listing: true } } },
    orderBy: { createdAt: "asc" },
  });
  const lines = [
    ["Date", "Listing", "Role", "Amount", "Status", "Paid"],
    ...fees.map((fee) => [
      fee.createdAt.toISOString().slice(0, 10),
      fee.closing.listing.title,
      brokerRoleLabel(fee.role),
      (fee.amountCents / 100).toFixed(2),
      fee.status,
      fee.paidAt ? fee.paidAt.toISOString().slice(0, 10) : "",
    ]),
  ];
  const csv = lines.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=upb-broker-statement.csv",
    },
  });
}
