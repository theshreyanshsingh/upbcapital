import { accessLog, accessLogCsv } from "@/lib/access-log";
import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";

export const runtime = "nodejs";

// The room's access log as a spreadsheet, for the seller, the filing broker and the desk.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const log = await accessLog(id, user);
  if (log.status === 404) return new Response("Not found.", { status: 404 });
  if (log.status === 403) return new Response("The access log is for the seller, the broker and the desk.", { status: 403 });
  await audit(user.id, "ACCESS_LOG_EXPORT", "listing", log.listing.id, `${log.rows.length} rows`);
  return new Response(accessLogCsv(log.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="access-log-${log.listing.id.slice(-6)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
