import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { saleFile, saleFileCsv, saleFilePdf } from "@/lib/sale-file";
import { DESK_DENIED, deskCan } from "@/lib/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The sale's record for a bank seller's exam file: the CSV by default, or ?format=pdf for the summary page.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user || user.role !== "ADMIN") return new Response("The desk only.", { status: 403 });
  if (!deskCan(user, "sales") && !deskCan(user, "compliance")) return new Response(DESK_DENIED, { status: 403 });
  const { id } = await context.params;
  const file = await saleFile(id, user);
  if (!file) return new Response("Not found.", { status: 404 });
  const pdf = new URL(request.url).searchParams.get("format") === "pdf";
  await audit(user.id, "SALE_FILE", "listing", id, `${pdf ? "PDF summary" : "CSV"}${file.walled ? ", sealed amounts withheld" : ""}`);
  const name = `sale-file-${id.slice(-8)}`;
  if (pdf) {
    return new Response(Buffer.from(await saleFilePdf(file)), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"`, "Cache-Control": "private, no-store" },
    });
  }
  return new Response(saleFileCsv(file), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"`, "Cache-Control": "private, no-store" },
  });
}
