import { recordEmailEvent } from "@/lib/announcements";

export const runtime = "nodejs";

// A transparent 1x1 GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

// The open pixel in an announcement. It always answers with the image, so a bad or repeated token shows nothing
// different; only a signed token records an open, once per reader.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await recordEmailEvent({ announcementId: id, token: new URL(request.url).searchParams.get("t"), kind: "OPEN" }).catch(() => false);
  return new Response(new Uint8Array(PIXEL), {
    headers: { "Content-Type": "image/gif", "Content-Length": String(PIXEL.length), "Cache-Control": "no-store, max-age=0" },
  });
}
