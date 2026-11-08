import { getApiUser } from "@/lib/auth";
import { boardCsv, boardPdf, exportPack, monthStart, parseMonth } from "@/lib/board-pack";
import { DESK_DENIED, deskCan } from "@/lib/staff";

export const runtime = "nodejs";

// The month's board pack as a PDF or a CSV, for owners. A locked month exports its locked figures.
export async function GET(request: Request, context: { params: Promise<{ month: string }> }) {
  const user = await getApiUser();
  if (!user || user.role !== "ADMIN") return new Response("The desk only.", { status: 403 });
  if (!deskCan(user, "admin")) return new Response(DESK_DENIED, { status: 403 });
  const month = parseMonth((await context.params).month);
  if (!month || monthStart(month).getTime() > Date.now()) return new Response("Choose a month that has started, as YYYY-MM.", { status: 400 });
  const format = new URL(request.url).searchParams.get("format") || "pdf";
  if (format !== "pdf" && format !== "csv") return new Response("Ask for format=pdf or format=csv.", { status: 400 });
  const { pack, basis } = await exportPack(month);
  const name = `upb-board-pack-${month}`;
  if (format === "csv") {
    return new Response(boardCsv(pack, basis), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"`, "Cache-Control": "private, no-store" },
    });
  }
  return new Response(new Uint8Array(await boardPdf(pack, basis)), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
