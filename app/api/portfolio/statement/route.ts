import { getApiUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import { buildYearStatementPdf, ESTIMATED, loadStatementHoldings, statementCsv, taxYearStatement } from "@/lib/portfolio-tax";

export const runtime = "nodejs";

// ?year=2025&format=pdf|csv gives that tax year's statement. With no year it is the whole receipt ledger, as before.
export async function GET(request: Request) {
  const user = await getApiUser();
  if (!user || user.role !== "BUYER") return new Response("Buyers only.", { status: 403 });
  const url = new URL(request.url);
  const rawYear = url.searchParams.get("year");
  const holdings = await loadStatementHoldings(user.id);
  if (rawYear) {
    const year = Number(rawYear);
    const current = new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 1990 || year > current) return new Response("Choose a tax year up to this one.", { status: 400 });
    const statement = taxYearStatement(holdings, year);
    if (url.searchParams.get("format") === "csv") {
      return new Response(statementCsv(statement), {
        headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="upb-statement-${year}.csv"`, "Cache-Control": "private, no-store" },
      });
    }
    const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { entityName: true } });
    const holder = [profile?.entityName || user.companyName || user.name, user.email].filter(Boolean).join("  -  ");
    const pdf = await buildYearStatementPdf(statement, holder);
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="upb-statement-${year}.pdf"`, "Cache-Control": "private, no-store" },
    });
  }
  const rows = holdings.flatMap((holding) => {
    const received = holding.receipts.reduce((sum, receipt) => sum + receipt.amount, 0);
    const base = {
      title: holding.title,
      status: holding.status,
      cost: holding.costBasis,
      upb: holding.upb,
      underwrittenYield: holding.underwrittenYield ?? "",
      acquired: holding.acquiredAt.toISOString().slice(0, 10),
      received,
    };
    const none = { paidOn: "", amount: null as number | null, memo: "", principal: null as number | null, interest: null as number | null, fees: null as number | null, escrow: null as number | null, split: "" };
    if (!holding.receipts.length) return [{ ...base, ...none }];
    return holding.receipts.map((receipt) => ({
      ...base,
      paidOn: receipt.paidOn.toISOString().slice(0, 10),
      amount: receipt.amount as number | null,
      memo: receipt.memo ?? "",
      principal: receipt.split?.principal ?? null,
      interest: receipt.split?.interest ?? null,
      fees: receipt.split?.fees ?? null,
      escrow: receipt.split?.escrow ?? null,
      split: receipt.split ? (receipt.estimated ? ESTIMATED : "As logged") : "Not split",
    }));
  });
  const csv = toCsv(rows.length ? rows : [{ title: "", status: "", cost: "", upb: "", underwrittenYield: "", acquired: "", received: "", paidOn: "", amount: "", memo: "", principal: "", interest: "", fees: "", escrow: "", split: "" }]);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": "attachment; filename=\"portfolio.csv\"",
    },
  });
}
