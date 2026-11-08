import { calendarFeed, userForCalendarToken } from "@/lib/calendar-feed";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;

function slowDown() {
  return new Response("Too many requests. Try again later.", { status: 429, headers: { "Retry-After": "600" } });
}

// An account's private calendar feed. The link is the credential, so an unknown or replaced one is simply not found.
// Calendar apps poll on their own schedule, and Google's fetchers share addresses across many people, so the limit
// per address is loose and the limit per link is the one that bites.
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const meta = await requestMeta();
  if (!(await consumeRateLimit(`calendar-ip:${meta.ipAddress}`, 600, HOUR))) return slowDown();
  const user = await userForCalendarToken(token);
  if (!user) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!(await consumeRateLimit(`calendar:${user.actor?.id ?? user.id}`, 60, HOUR))) return slowDown();
  return new Response(await calendarFeed(user), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="upb-capital.ics"',
      // A few minutes in the subscriber's own cache, never in a shared one.
      "Cache-Control": "private, max-age=300",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}
