import { NextResponse } from "next/server";
import { applyVendorEvent, docuSignEvent, dropboxPayload, dropboxSignEvent, verifyDocuSign, verifyDropboxSign } from "@/lib/signatures";

export const runtime = "nodejs";

// Signature events from Dropbox Sign and DocuSign Connect. Each is verified before anything is read from it, and an
// unverified one gets a 401. A verified event for an envelope that isn't one of ours, such as an NDA, is acknowledged
// so the vendor doesn't keep retrying it.
export async function POST(request: Request) {
  const raw = Buffer.from(await request.arrayBuffer());
  const docusign = [...request.headers.entries()].filter(([name]) => /^x-docusign-signature-\d+$/i.test(name)).map(([, value]) => value);
  if (docusign.length) {
    if (!verifyDocuSign(raw, docusign, process.env.DOCUSIGN_CONNECT_SECRET)) return new Response("Unverified.", { status: 401 });
    let payload: unknown = null;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      // Connect can be set to XML. Only JSON is read, and anything else is acknowledged and dropped.
    }
    const event = payload && typeof payload === "object" ? docuSignEvent(payload as Record<string, unknown>) : null;
    const outcome = event ? await applyVendorEvent(event) : { matched: false, status: null };
    return NextResponse.json({ ok: true, matched: outcome.matched });
  }
  const payload = await dropboxPayload(raw, request.headers.get("content-type"));
  if (!payload || !verifyDropboxSign(payload.event, process.env.DROPBOX_SIGN_API_KEY)) return new Response("Unverified.", { status: 401 });
  const event = dropboxSignEvent(payload);
  if (event) await applyVendorEvent(event);
  // Dropbox Sign counts a delivery as received only on this exact body.
  return new Response("Hello API Event Received", { status: 200, headers: { "Content-Type": "text/plain" } });
}
