import { getApiUser } from "@/lib/auth";
import { buildCalendar, eventPapers } from "@/lib/process-letter";

export const runtime = "nodejs";

// Every date of the event as a calendar file, for the same readers as the process letter.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const papers = await eventPapers(id, user);
  if (papers.status === 404) return new Response("Not found.", { status: 404 });
  if (papers.status === 403) return new Response("Closed.", { status: 403 });
  return new Response(buildCalendar(papers.event), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="sale-event-${papers.event.id}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
