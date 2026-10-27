import { canReadDocument, isPrivateDocument } from "@/lib/acl";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";
import { getBytes } from "@/lib/storage";
import { attachmentName } from "@/lib/uploads";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const document = await prisma.document.findUnique({ where: { id }, include: { listing: true } });
  if (!document) return new Response("Not found.", { status: 404 });

  const owner = document.listing.sellerId === user.id;
  const admin = user.role === "ADMIN";
  const ownNda = await prisma.ndaAcknowledgment.findFirst({ where: { userId: user.id, documentId: document.id } });
  const nda = await prisma.ndaAcknowledgment.findUnique({
    where: { userId_listingId: { userId: user.id, listingId: document.listingId } },
  });
  const allowed = canReadDocument({
    owner,
    admin,
    ownNda: Boolean(ownNda),
    privateFile: isPrivateDocument(document, document.listing),
    proBuyer: user.role === "BUYER" && user.accountStatus === "APPROVED" && isPro(user),
    signedNda: Boolean(nda),
    listingVisible: ["APPROVED", "PENDING", "SOLD"].includes(document.listing.status),
  });
  if (!allowed) return new Response("The data room is closed.", { status: 403 });

  try {
    const bytes = await getBytes(document.storedName);
    return new Response(bytes, {
      headers: {
        "Content-Type": document.mime,
        "Content-Disposition": `attachment; filename="${attachmentName(document.originalName)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("File missing.", { status: 404 });
  }
}
