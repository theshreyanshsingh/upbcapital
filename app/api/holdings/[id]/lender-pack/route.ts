import { getApiUser } from "@/lib/auth";
import { buildLenderPackPdf, openLenderPack } from "@/lib/lender-pack";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const LIMIT = 30;
const WINDOW_MS = 10 * 60 * 1000;

// The lender-ready file for one holding: its holder's, or the desk's for any holding. Anyone else gets a 404, so a
// holding's existence isn't confirmed. Each download is audited in openLenderPack.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  if (!(await consumeRateLimit(`lender-pack:${user.id}`, LIMIT, WINDOW_MS))) return new Response("That is a lot of downloads in a few minutes. Try again shortly.", { status: 429 });
  const opened = await openLenderPack(id, user);
  if (!opened.ok) return new Response("Not found.", { status: 404 });
  const pdf = await buildLenderPackPdf(opened.pack);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="lender-pack.pdf"',
      "Cache-Control": "private, no-store",
    },
  });
}
