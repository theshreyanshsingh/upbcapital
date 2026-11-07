import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadSellerFile } from "@/lib/seller-identity";
import { getBytes } from "@/lib/storage";
import { attachmentName } from "@/lib/uploads";

export const runtime = "nodejs";

// A seller file's identity or authority document, for the seller and for compliance. Each desk read is logged.
export async function GET(_request: Request, context: { params: Promise<{ userId: string; doc: string }> }) {
  const { userId, doc } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  if (!canReadSellerFile(user, userId)) return new Response("Closed.", { status: 403 });
  if (doc !== "id" && doc !== "authority") return new Response("Not found.", { status: 404 });
  const profile = await prisma.sellerProfile.findUnique({ where: { userId } });
  const file = profile && (doc === "id"
    ? { key: profile.idDocKey, name: profile.idDocName, mime: profile.idDocMime }
    : { key: profile.authorityDocKey, name: profile.authorityDocName, mime: profile.authorityDocMime });
  if (!file?.key) return new Response("Not found.", { status: 404 });
  try {
    const bytes = await getBytes(file.key);
    if (user.id !== userId) await audit(user.id, "SELLER_FILE_READ", "user", userId, doc === "id" ? "Identity document" : "Authority document");
    return new Response(bytes, {
      headers: {
        "Content-Type": file.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${attachmentName(file.name || `${doc}-document`)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("File missing.", { status: 404 });
  }
}
