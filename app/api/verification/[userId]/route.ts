import { canReadProof } from "@/lib/acl";
import { getApiUser } from "@/lib/auth";
import { attachmentName } from "@/lib/uploads";
import { prisma } from "@/lib/prisma";
import { getBytes } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
  const { userId } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  if (!canReadProof(user, userId)) return new Response("Closed.", { status: 403 });
  const profile = await prisma.buyerProfile.findUnique({ where: { userId } });
  if (!profile?.proofKey) return new Response("Not found.", { status: 404 });
  try {
    const bytes = await getBytes(profile.proofKey);
    return new Response(bytes, {
      headers: {
        "Content-Type": profile.proofMime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${attachmentName(profile.proofName || "proof")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("File missing.", { status: 404 });
  }
}
