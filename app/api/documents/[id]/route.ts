import { canReadDocument, isPrivateDocument } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { isClosingParty } from "@/lib/data-room";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";
import { getBytes } from "@/lib/storage";
import { attachmentName } from "@/lib/uploads";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
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
    listingStatus: document.listing.status,
    closingParty: owner || admin ? false : await isClosingParty(document.listingId, user.id),
  });
  if (!allowed) return new Response("The data room is closed.", { status: 403 });

  try {
    const bytes = await getBytes(document.storedName);
    // Every download is logged against the listing, so the desk can show who took which file and when.
    await audit(user.id, "DOCUMENT_DOWNLOAD", "listing", document.listingId, document.originalName);
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
