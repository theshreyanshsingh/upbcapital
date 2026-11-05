import { canReadDocument, isPrivateDocument, loanFileAccess } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { dealAccess } from "@/lib/data-room";
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
  const deal = owner || admin ? { whole: false, loans: new Set<string>() } : await dealAccess(document.listingId, user.id);
  // A loan's own file follows that loan: sold out of a pool, it closes to everyone but its buyer.
  const note = document.noteId
    ? await prisma.note.findUnique({ where: { id: document.noteId }, select: { id: true, listingId: true, tradeStatus: true } })
    : null;
  const allowed = canReadDocument({
    owner,
    admin,
    ownNda: Boolean(ownNda),
    privateFile: isPrivateDocument(document, document.listing),
    proBuyer: user.role === "BUYER" && user.accountStatus === "APPROVED" && isPro(user),
    signedNda: Boolean(nda),
    listingStatus: document.listing.status,
    closingParty: deal.whole || deal.loans.size > 0,
    loan: document.noteId
      ? loanFileAccess({ note, listingId: document.listingId, listingStatus: document.listing.status, signedNda: Boolean(nda), wholeParty: deal.whole, loanIds: deal.loans })
      : null,
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
