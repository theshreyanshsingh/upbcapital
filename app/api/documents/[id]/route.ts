import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { documentGate, stampName } from "@/lib/room-access";
import { getBytes } from "@/lib/storage";
import { attachmentName } from "@/lib/uploads";
import { bidderCopy } from "@/lib/watermark";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const { document, allowed, buyerCopy } = await documentGate(user, id);
  if (!document) return new Response("Not found.", { status: 404 });
  if (!allowed) return new Response("The data room is closed.", { status: 403 });

  let bytes: Awaited<ReturnType<typeof getBytes>>;
  try {
    bytes = await getBytes(document.storedName);
  } catch {
    return new Response("File missing.", { status: 404 });
  }
  // A bidder's copy of a PDF carries their name on every page. Photos have their own route and stay as taken.
  const copy = buyerCopy ? await bidderCopy(document, bytes, await stampName(user)) : null;
  if (copy?.failed) console.warn(`[upb-documents] ${document.id} did not parse as a PDF, so it went out without a watermark.`);
  // Every download is logged against the listing, so the desk can show who took which file and when.
  await audit(user.id, "DOCUMENT_DOWNLOAD", "listing", document.listingId, document.originalName);
  const headers = {
    "Content-Type": document.mime,
    "Content-Disposition": `attachment; filename="${attachmentName(document.originalName)}"`,
    "Cache-Control": "private, no-store",
  };
  return copy?.stamped ? new Response(new Uint8Array(copy.bytes), { headers }) : new Response(bytes, { headers });
}
