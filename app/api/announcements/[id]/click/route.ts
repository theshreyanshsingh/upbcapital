import { NextResponse } from "next/server";
import { recordEmailEvent, trackTarget } from "@/lib/announcements";
import { appOrigin } from "@/lib/billing";

export const runtime = "nodejs";

// A link in an announcement. It goes only to this site's own index, listing or events page, built on the app's own
// origin, so it can never send a reader to another site. A target off the list lands on the index and records
// nothing. A signed token records the click, once per reader.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const origin = appOrigin().replace(/\/+$/, "");
  const target = trackTarget(url.searchParams.get("to"));
  if (!target) return NextResponse.redirect(`${origin}/open`, 302);
  await recordEmailEvent({ announcementId: id, token: url.searchParams.get("t"), kind: "CLICK", target }).catch(() => false);
  return NextResponse.redirect(`${origin}${target}`, 302);
}
