import { sendFunnel } from "@/lib/outreach";
import { prisma } from "@/lib/prisma";

const DAY = 24 * 60 * 60 * 1000;

type Viewer = { id: string; name: string; companyName: string; role: string };

// Buyer interest in one listing. Views from the seller and the desk are left out, because neither is a bidder.
export async function listingActivity(listingId: string, sellerId: string, now = new Date()) {
  const [views, ndas, favorites, inquiries, sends, matches, downloads] = await Promise.all([
    prisma.listingView.findMany({ where: { listingId }, include: { user: { select: { id: true, name: true, companyName: true, role: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.ndaAcknowledgment.findMany({ where: { listingId }, include: { user: { select: { id: true, name: true, companyName: true, role: true } } }, orderBy: { acknowledgedAt: "desc" } }),
    prisma.favorite.findMany({ where: { listingId }, include: { user: { select: { id: true, name: true, companyName: true, role: true } } } }),
    prisma.inquiry.findMany({ where: { listingId }, select: { buyerId: true, type: true, createdAt: true } }),
    prisma.listingSend.findMany({ where: { listingId }, select: { userId: true, createdAt: true, kind: true } }),
    prisma.listingMatch.findMany({ where: { listingId }, select: { userId: true } }),
    prisma.auditEvent.findMany({ where: { entityId: listingId, action: "DOCUMENT_DOWNLOAD" }, include: { actor: { select: { id: true, name: true, companyName: true, role: true } } }, orderBy: { createdAt: "desc" } }),
  ]);
  const buyer = (user: Viewer | null): user is Viewer => Boolean(user && user.id !== sellerId && user.role !== "ADMIN");
  const buyerViews = views.filter((view) => buyer(view.user));
  const byViewer = new Map<string, { user: Viewer; count: number; last: Date }>();
  for (const view of buyerViews) {
    const user = view.user!;
    const row = byViewer.get(user.id);
    if (row) row.count += 1;
    else byViewer.set(user.id, { user, count: 1, last: view.createdAt });
  }
  const offers = inquiries.filter((inquiry) => inquiry.type === "OFFER");
  return {
    views: buyerViews.length,
    viewsThisWeek: buyerViews.filter((view) => now.getTime() - view.createdAt.getTime() < 7 * DAY).length,
    viewers: [...byViewer.values()],
    ndas: ndas.filter((nda) => buyer(nda.user)),
    favorites: favorites.filter((favorite) => buyer(favorite.user)),
    downloads: downloads.filter((row) => buyer(row.actor)),
    offers: offers.length,
    bidders: new Set(offers.map((offer) => offer.buyerId)).size,
    questions: inquiries.length - offers.length,
    matchedBuyers: new Set(matches.map((match) => match.userId)).size,
    sends: sendFunnel(
      sends.filter((send) => send.kind === "LISTING"),
      buyerViews.map((view) => ({ userId: view.userId, createdAt: view.createdAt })),
      offers.map((offer) => ({ buyerId: offer.buyerId, createdAt: offer.createdAt })),
    ),
  };
}

export type ListingActivity = Awaited<ReturnType<typeof listingActivity>>;

// What the seller sees: counts only. Who viewed or signed stays with the desk.
export function sellerReport(activity: ListingActivity) {
  return [
    { label: "Buyers who opened it", value: activity.viewers.length },
    { label: "Opens in the last 7 days", value: activity.viewsThisWeek },
    { label: "Signed the NDA", value: activity.ndas.length },
    { label: "Buyers who took a file", value: new Set(activity.downloads.map((row) => row.actorId)).size },
    { label: "Saved it", value: activity.favorites.length },
    { label: "Buy boxes it fits", value: activity.matchedBuyers },
    { label: "Sent to by the desk", value: activity.sends.reached },
    { label: "Bidders", value: activity.bidders },
  ];
}
