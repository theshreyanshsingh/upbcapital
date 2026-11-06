import { canReadClosingFile } from "@/lib/acl";
import { getApiUser } from "@/lib/auth";
import { loadDealTimeline, ownerWord, timelineStamp } from "@/lib/closing-service";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import { statementSide } from "@/lib/settlement";

export const runtime = "nodejs";

// The deal timeline as a CSV, for the parties. Each side gets the lines its closing page shows it.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const closing = await prisma.closing.findUnique({ where: { id }, select: { id: true, inquiryId: true, listing: { select: { sellerId: true } }, funders: { select: { userId: true } } } });
  if (!closing) return new Response("Not found.", { status: 404 });
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : null;
  const parties = { role: user.role, userId: user.id, sellerId: closing.listing.sellerId, buyerId: inquiry?.buyerId ?? null, funderIds: closing.funders.map((funder) => funder.userId) };
  const side = statementSide(parties);
  if (!canReadClosingFile(parties) || side === "observer") return new Response("Closed.", { status: 403 });
  const timeline = await loadDealTimeline(closing.id, side);
  if (!timeline) return new Response("Not found.", { status: 404 });
  const rows = [
    ...timeline.entries.map((entry) => ({
      When: entry.at.toISOString(),
      "When (UTC)": timelineStamp(entry.at),
      Event: entry.title,
      Detail: entry.detail,
      Owner: ownerWord(entry.owner),
      By: entry.who,
    })),
    ...timeline.upcoming.map((step) => ({
      When: step.due ? step.due.toISOString() : "",
      "When (UTC)": step.due ? `Due ${timelineStamp(step.due)}` : "",
      Event: `${step.next ? "Next: " : "Open: "}${step.label}`,
      Detail: step.late ? "Late" : "",
      Owner: ownerWord(step.owner),
      By: "",
    })),
  ];
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="closing-${closing.id}-log.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
