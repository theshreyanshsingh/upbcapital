import { getApiUser } from "@/lib/auth";
import { cashCsv, loadCashNeeds } from "@/lib/cash-needs";

export const runtime = "nodejs";

// The buyer's own owed rows from /buyer/cash, every page of them. A firm's seat gets its firm's, as signed in.
export async function GET() {
  const user = await getApiUser();
  if (!user || user.role !== "BUYER") return new Response("Buyers only.", { status: 403 });
  const cash = await loadCashNeeds(user.id);
  return new Response(cashCsv(cash.items), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="upb-cash-needs-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
