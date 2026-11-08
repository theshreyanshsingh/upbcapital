import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { bidSummary, bidSummaryCsv, bidSummaryPdf } from "@/lib/seller-decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The seller's bid summary: the CSV by default, or ?format=pdf. For the listing's seller, a broker of record and the
// desk's sales staff, with the sealed amounts left out while the round runs, as on the seller's page.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const { id } = await context.params;
  const summary = await bidSummary(id, user);
  if (summary.status === 404) return new Response("Not found.", { status: 404 });
  if (summary.status === 403) return new Response("The bid summary is for the seller, the broker and the desk.", { status: 403 });
  const pdf = new URL(request.url).searchParams.get("format") === "pdf";
  // Logged against the listing, as a room download is, so the desk can show who took it and when.
  await audit(user.id, "BID_SUMMARY_DOWNLOAD", "listing", id, `${pdf ? "PDF" : "CSV"} · ${summary.rows.length} bids${summary.sealed ? " · sealed amounts withheld" : ""}`);
  const name = `bid-summary-${id.slice(-8)}`;
  if (pdf) {
    return new Response(Buffer.from(await bidSummaryPdf(summary)), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"`, "Cache-Control": "private, no-store" },
    });
  }
  return new Response(bidSummaryCsv(summary), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"`, "Cache-Control": "private, no-store" },
  });
}
