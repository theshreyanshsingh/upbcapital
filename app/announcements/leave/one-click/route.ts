import { NextResponse } from "next/server";
import { leaveList } from "@/lib/announcements";
import { consumeRateLimit } from "@/lib/rate-limit";
import { clientAddress } from "@/lib/request-meta";

export const runtime = "nodejs";

// RFC 8058 one-click for a subscriber without an account: the mail client POSTs here from its own button. The
// subscriber's token is the permission. The answer is plain, never a redirect, as the RFC asks.
export async function POST(request: Request) {
  const ip = clientAddress(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip"));
  if (!(await consumeRateLimit(`deal-list-token:${ip}`, 30, 60 * 60 * 1000))) return NextResponse.json({ error: "Too many tries." }, { status: 429 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!(await leaveList(token))) return NextResponse.json({ error: "This unsubscribe link isn't valid." }, { status: 400 });
  return NextResponse.json({ ok: true });
}

// Opened in a browser, the link shows the leave page, so a scanner that follows links removes no one.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = new URL("/announcements/leave", url);
  const token = url.searchParams.get("token");
  if (token) page.searchParams.set("token", token);
  return NextResponse.redirect(page, 303);
}
