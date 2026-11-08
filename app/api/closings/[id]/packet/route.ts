import { getApiUser } from "@/lib/auth";
import type { TemplateKey } from "@/lib/closing-docs";
import { closingPacket } from "@/lib/closing-packet";
import { ENOTE_NO_PAPER } from "@/lib/enotes";
import { sentCopy } from "@/lib/signatures";
import { isTemplateKey } from "@/lib/templates";

export const runtime = "nodejs";

// The form filled from the closing as it stands. With ?request=, the copy sent for signature instead, byte for byte,
// so a signer reads what every party signs. Sending for signature is lib/signatures.ts, from the closing page.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const params = new URL(request.url).searchParams;
  const requestId = params.get("request");
  if (requestId) {
    const copy = await sentCopy(id, requestId, user);
    if (!copy) return new Response("Not found.", { status: 404 });
    if (!copy.allowed) return new Response("Closed.", { status: 403 });
    return new Response(new Uint8Array(copy.pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${copy.kind.toLowerCase()}-for-signature.pdf"` },
    });
  }
  const kind = params.get("kind") || "PSA";
  if (!isTemplateKey(kind)) return new Response("Unknown form.", { status: 400 });
  const packet = await closingPacket(id, kind as TemplateKey, user);
  if (!packet) return new Response("Not found.", { status: 404 });
  // An eNote closing has no allonge or lost note affidavit to draw. lib/enotes.ts.
  if (!packet.allowed) return "eNote" in packet ? new Response(ENOTE_NO_PAPER, { status: 409 }) : new Response("Closed.", { status: 403 });
  const { pdf } = packet;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${kind.toLowerCase()}.pdf"`,
    },
  });
}
