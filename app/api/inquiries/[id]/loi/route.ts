import { getApiUser } from "@/lib/auth";
import { buildLoiPdf, openLoi } from "@/lib/loi";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 30;
const WINDOW_MS = 10 * 60 * 1000;

// A bid's letter of intent and term sheet, as a PDF: for the bid's buyer and the firm's seats, and for the seller and
// the desk once the bid's amount is no longer sealed from them. Anyone else gets a 404. Each download is audited in
// openLoi (lib/loi.ts).
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  if (!(await consumeRateLimit(`loi:${user.id}`, LIMIT, WINDOW_MS))) return new Response("That is a lot of downloads in a few minutes. Try again shortly.", { status: 429 });
  const opened = await openLoi(id, user);
  if (!opened.ok) return new Response(opened.error, { status: opened.status });
  const pdf = await buildLoiPdf(opened.content);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="letter-of-intent-${id.slice(-8)}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
