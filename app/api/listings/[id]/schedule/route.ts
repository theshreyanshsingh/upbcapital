import { canOpenListing } from "@/lib/access";
import { scheduleDownload } from "@/lib/amortization";
import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listingSight } from "@/lib/private-listings";
import { getSettings, isPro } from "@/lib/settings";

export const runtime = "nodejs";

// One loan's full monthly schedule as a CSV, for the viewers the listing page shows its figures to: the desk and Pro
// buyers who may open the listing. The checks are the page's own; the file never carries the borrower or the street.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const listing = await prisma.listing.findUnique({ where: { id }, include: { notes: true } });
  if (!listing) return new Response("Not found.", { status: 404 });
  const [sight, settings] = await Promise.all([listingSight(user, listing), getSettings()]);
  // The free slice is never in play: a viewer without Pro is refused before it would matter.
  const opens = canOpenListing({
    invited: sight.invited,
    viewer: user,
    status: listing.status,
    approvedAt: listing.approvedAt,
    earlyAccessHours: settings.earlyAccessHours,
    openableIds: new Set<string>(),
    listingId: listing.id,
    sellerId: listing.sellerId,
    brokerId: listing.brokerId,
    launchAt: listing.launchAt,
  }).ok;
  const answer = scheduleDownload({
    visible: sight.visible,
    opens,
    figures: user.role === "ADMIN" || isPro(user),
    listing,
    noteId: new URL(request.url).searchParams.get("loan"),
  });
  if (answer.status !== 200) return new Response(answer.body, { status: answer.status });
  await audit(user.id, "SCHEDULE_EXPORT", "listing", listing.id, `Payment schedule (${answer.filename})`);
  return new Response(answer.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${answer.filename}"`,
    },
  });
}
