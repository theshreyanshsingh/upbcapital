import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { bidTapeCsv, bidTapeTemplate, bidTapeXlsx, submittedBidTape } from "@/lib/bid-tape";

export const runtime = "nodejs";

// A pool's bid template for a buyer who may bid it, or with ?bid= the buyer's own placed bid as a filled tape. CSV by
// default, Excel with ?format=xlsx. Each download is logged.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const bid = url.searchParams.get("bid");
  const tape = bid ? await submittedBidTape(user, id, bid) : await bidTapeTemplate(user, id);
  if (tape.error !== null) return new Response(tape.error, { status: tape.status });
  await audit(user.id, bid ? "BID_TAPE_COPY" : "BID_TAPE_TEMPLATE", bid ? "inquiry" : "listing", bid ?? id, `Bid tape ${bid ? "copy" : "template"} (${format}) · ${tape.rows.length} loans`);
  const filename = `bid-tape-${id.slice(-6)}${bid ? `-bid-${bid.slice(-6)}` : ""}.${format}`;
  if (format === "csv") {
    return new Response(bidTapeCsv(tape), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" },
    });
  }
  return new Response(new Uint8Array(bidTapeXlsx(tape)), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
