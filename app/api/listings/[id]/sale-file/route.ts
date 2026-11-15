import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { saleFile, saleFileCsv, saleFilePdf, sellerSaleFile, type SaleFile } from "@/lib/sale-file";
import { DESK_DENIED, deskCan } from "@/lib/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The sale's record for a bank seller's board or exam file: the CSV by default, or ?format=pdf for the summary page.
// The desk's sales and compliance staff get the desk's file. Once the listing has an award, its seller (a firm's seats
// act as the firm) and the broker of record get the seller's copy, which holds only what the seller already sees.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const { id } = await context.params;
  const pdf = new URL(request.url).searchParams.get("format") === "pdf";
  if (user.role !== "ADMIN") {
    const result = await sellerSaleFile(id, user);
    if (result.status === 404) return new Response("Not found.", { status: 404 });
    if (result.status === 403) return new Response(result.error, { status: 403 });
    // Logged against the listing, as the bid summary is, so the desk can show who took it and when.
    await audit(user.id, "SALE_FILE", "listing", id, `Seller copy, ${pdf ? "PDF summary" : "CSV"}${result.file.walled ? ", sealed amounts withheld" : ""}`);
    return send(result.file, id, pdf);
  }
  if (!deskCan(user, "sales") && !deskCan(user, "compliance")) return new Response(DESK_DENIED, { status: 403 });
  const file = await saleFile(id, user);
  if (!file) return new Response("Not found.", { status: 404 });
  await audit(user.id, "SALE_FILE", "listing", id, `${pdf ? "PDF summary" : "CSV"}${file.walled ? ", sealed amounts withheld" : ""}`);
  return send(file, id, pdf);
}

async function send(file: SaleFile, id: string, pdf: boolean) {
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
