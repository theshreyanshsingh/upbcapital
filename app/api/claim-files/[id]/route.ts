import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { canReadClaimFile } from "@/lib/claims";
import { prisma } from "@/lib/prisma";
import { getBytes } from "@/lib/storage";
import { attachmentName } from "@/lib/uploads";

export const runtime = "nodejs";

// A repurchase claim's evidence opens for the buyer who filed it, the seller and the desk. lib/claims.ts.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const file = await prisma.claimFile.findUnique({ where: { id }, include: { claim: { select: { id: true, filedById: true, sellerId: true } } } });
  if (!file) return new Response("Not found.", { status: 404 });
  if (!canReadClaimFile({ role: user.role, userId: user.id, filedById: file.claim.filedById, sellerId: file.claim.sellerId })) return new Response("Closed.", { status: 403 });
  try {
    const bytes = await getBytes(file.storageKey);
    await audit(user.id, "CLAIM_FILE_DOWNLOAD", "claimFile", file.id, file.originalName);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": file.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${attachmentName(file.originalName)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("File missing.", { status: 404 });
  }
}
