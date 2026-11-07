import { getApiUser } from "@/lib/auth";
import { buildLetterPdf, eventPapers, loadLetter } from "@/lib/process-letter";

export const runtime = "nodejs";

// The event's process letter, for signed-in buyers, the sellers of its listings and the desk.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const papers = await eventPapers(id, user);
  if (papers.status === 404) return new Response("Not found.", { status: 404 });
  if (papers.status === 403) return new Response("Closed.", { status: 403 });
  const pdf = await buildLetterPdf(await loadLetter(papers));
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="process-letter-${papers.event.id}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
