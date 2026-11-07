import { audit } from "@/lib/audit";
import { auditExport, auditFilterFrom, auditQuery } from "@/lib/audit-log";
import { getApiUser } from "@/lib/auth";
import { DESK_DENIED, deskCan } from "@/lib/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The audit log as a CSV, with the same filter as the page. Exporting it is itself a logged event.
export async function GET(request: Request) {
  const user = await getApiUser();
  if (!user || user.role !== "ADMIN") return new Response("The desk only.", { status: 403 });
  if (!deskCan(user, "compliance")) return new Response(DESK_DENIED, { status: 403 });
  const filter = auditFilterFrom(new URL(request.url).searchParams);
  const csv = await auditExport(filter);
  await audit(user.id, "AUDIT_EXPORT", "audit", "log", auditQuery(filter) || "No filter");
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
