import { getApiUser } from "@/lib/auth";
import { searchCommands } from "@/lib/command-search";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The palette searches as you type, after a short pause, so a minute allows plenty of searches but not a scrape.
const LIMIT = 90;
const WINDOW_MS = 60 * 1000;

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

// POST, so a search term (a desk user may type a borrower's name) stays out of URLs and access logs. JSON only,
// which a cross-site form can't send without a preflight.
export async function POST(request: Request) {
  const user = await getApiUser();
  if (!user) return reply({ error: "Sign in required." }, 401);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply({ error: "Send the search as JSON." }, 415);
  if (Number(request.headers.get("content-length") ?? 0) > 2048) return reply({ error: "That search is too long." }, 413);
  if (!(await consumeRateLimit(`command:${user.id}`, LIMIT, WINDOW_MS))) return reply({ error: "That is a lot of searches in a minute. Try again shortly." }, 429);
  let q = "";
  try {
    const body = (await request.json()) as { q?: unknown };
    q = typeof body?.q === "string" ? body.q.slice(0, 200) : "";
  } catch {
    return reply({ error: "Send the search as JSON." }, 400);
  }
  try {
    return reply({ items: await searchCommands(user, q) });
  } catch (error) {
    console.error("[upb-command] search failed:", error instanceof Error ? error.message : "unknown error");
    return reply({ error: "Search is unavailable. Pages and actions still work." }, 500);
  }
}
