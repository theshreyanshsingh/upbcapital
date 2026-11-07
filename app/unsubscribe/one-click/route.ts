import { NextResponse } from "next/server";
import { applyUnsubscribe, readUnsubscribeToken } from "@/lib/unsubscribe";

export const runtime = "nodejs";

// RFC 8058 one-click: the mail client POSTs here from its own unsubscribe button, with no cookies and no page. The
// signed token is the permission. The answer is plain, never a redirect, as the RFC asks.
export async function POST(request: Request) {
  const found = readUnsubscribeToken(new URL(request.url).searchParams.get("token"));
  if (!found) return NextResponse.json({ error: "This unsubscribe link isn't valid." }, { status: 400 });
  await applyUnsubscribe(found);
  return NextResponse.json({ ok: true });
}

// Opened in a browser, the link shows the confirmation page instead, so a scanner that follows links turns nothing off.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = new URL("/unsubscribe", url);
  const token = url.searchParams.get("token");
  if (token) page.searchParams.set("token", token);
  return NextResponse.redirect(page, 303);
}
