import type { ListingStatus, Role, SubscriptionStatus, SubscriptionTier } from "@prisma/client";
import { isEarlyAccess, isPro } from "@/lib/settings";

export type Viewer = {
  id: string;
  role: Role;
  accountStatus: "PENDING" | "APPROVED" | "REJECTED";
  subscriptionTier: SubscriptionTier;
  subscriptionStatus: SubscriptionStatus;
};

export function canSeeMetrics(viewer: Viewer | null) {
  if (!viewer) return false;
  if (viewer.role === "ADMIN") return true;
  if (viewer.role === "BUYER") return isPro(viewer);
  return false;
}

export function buyerApproved(viewer: Viewer) {
  return viewer.role === "ADMIN" || (viewer.role === "BUYER" && viewer.accountStatus === "APPROVED");
}

export function listingIsPublic(status: ListingStatus) {
  return status === "APPROVED" || status === "PENDING" || status === "SOLD";
}

export function canOpenListing(input: {
  viewer: Viewer;
  status: ListingStatus;
  approvedAt: Date | null;
  earlyAccessHours: number;
  openableIds: Set<string>;
  listingId: string;
  sellerId: string;
  brokerId?: string | null;
}) {
  if (input.viewer.role === "ADMIN") return { ok: true as const };
  if (input.viewer.id === input.sellerId || (input.brokerId && input.viewer.id === input.brokerId)) return { ok: true as const };
  if (input.viewer.role === "BROKER") return { ok: false as const, reason: "account" as const };
  if (input.viewer.role !== "BUYER" || input.viewer.accountStatus !== "APPROVED") {
    return { ok: false as const, reason: "account" as const };
  }
  if (!listingIsPublic(input.status)) return { ok: false as const, reason: "unpublished" as const };
  if (input.status === "SOLD") return { ok: true as const };
  if (isEarlyAccess(input.approvedAt, input.earlyAccessHours) && !isPro(input.viewer)) {
    return { ok: false as const, reason: "early" as const };
  }
  if (!isPro(input.viewer) && !input.openableIds.has(input.listingId)) {
    return { ok: false as const, reason: "limit" as const };
  }
  return { ok: true as const };
}

export function openableListingIds(
  listings: { id: string; status: ListingStatus; approvedAt: Date | null }[],
  earlyAccessHours: number,
  limit: number,
) {
  const ranked = listings
    .filter((listing) => listing.status === "APPROVED" || listing.status === "PENDING")
    .filter((listing) => !isEarlyAccess(listing.approvedAt, earlyAccessHours))
    .sort((a, b) => (b.approvedAt?.getTime() ?? 0) - (a.approvedAt?.getTime() ?? 0));
  return new Set(ranked.slice(0, Math.max(limit, 0)).map((listing) => listing.id));
}
