import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { deskCan } from "@/lib/desk-roles";
import { prisma } from "@/lib/prisma";
import { getBytes, mimeFor, extensionOf } from "@/lib/storage";
import { attachmentName } from "@/lib/uploads";

export const runtime = "nodejs";

// The tape a seller sent with a valuation request, for the desk members who work the queue.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user || user.role !== "ADMIN" || !deskCan(user, "sales")) return new Response("Desk access only.", { status: 403 });
  const request = await prisma.valuationRequest.findUnique({ where: { id }, select: { id: true, tapeKey: true, tapeName: true } });
  if (!request?.tapeKey) return new Response("Not found.", { status: 404 });
  let bytes: Awaited<ReturnType<typeof getBytes>>;
  try {
    bytes = await getBytes(request.tapeKey);
  } catch {
    return new Response("File missing.", { status: 404 });
  }
  await audit(user.id, "VALUATION_TAPE", "valuation", request.id, request.tapeName);
  return new Response(bytes, {
    headers: {
      "Content-Type": mimeFor(extensionOf(request.tapeName) ?? "", "application/octet-stream"),
      "Content-Disposition": `attachment; filename="${attachmentName(request.tapeName || "tape.csv")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
