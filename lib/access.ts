import type { ListingStatus, Role, SubscriptionStatus, SubscriptionTier } from "@prisma/client";
import { demoSeat } from "@/lib/deploy";
import { launchPending } from "@/lib/launch-rules";
import { isEarlyAccess, isPro } from "@/lib/settings";

export type Viewer = {
  id: string;
  role: Role;
  accountStatus: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";
  subscriptionTier: SubscriptionTier;
  subscriptionStatus: SubscriptionStatus;
  subscriptionCurrentPeriodEnd?: Date | null;
};

// A declined or suspended account has no session at all, so every signed-in path stops at once.
export function accountLocked(status: string) {
  return status === "REJECTED" || status === "SUSPENDED";
}

// Real admins must have an authenticator. Only the demo desk's seeded seats are exempt, because one visitor enrolling
// would lock out the rest. An undeliverable address alone earns nothing, and a release build has no seats.
export function adminNeedsSecondFactor(user: { role: string; email: string; totpEnabled: boolean }) {
  return user.role === "ADMIN" && !user.totpEnabled && !demoSeat(user.email);
}

// When the desk requires it, every approved account that can see borrower data enrolls an authenticator too.
// Pending accounts can't see that data yet, and the same demo exemption applies.
export function needsSecondFactor(user: { role: string; email: string; totpEnabled: boolean; accountStatus?: string }, requireAll: boolean) {
  if (adminNeedsSecondFactor(user)) return true;
  return requireAll && user.role !== "ADMIN" && user.accountStatus === "APPROVED" && !user.totpEnabled && !demoSeat(user.email);
}

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
  // A coming-soon listing opens to its own side and the desk only. Buyers see its teaser on the book.
  launchAt?: Date | null;
  // A private listing the caller confirmed this buyer was invited to (lib/private-listings.ts). The seller asked
  // them in by name, so the early-access and free-slice holds don't apply.
  invited?: boolean;
  now?: Date;
}) {
  if (input.viewer.role === "ADMIN") return { ok: true as const };
  if (input.viewer.id === input.sellerId || (input.brokerId && input.viewer.id === input.brokerId)) return { ok: true as const };
  if (input.viewer.role === "BROKER") return { ok: false as const, reason: "account" as const };
  if (input.viewer.role !== "BUYER" || input.viewer.accountStatus !== "APPROVED") {
    return { ok: false as const, reason: "account" as const };
  }
  if (!listingIsPublic(input.status)) return { ok: false as const, reason: "unpublished" as const };
  if (input.status === "APPROVED" && launchPending({ launchAt: input.launchAt }, input.now)) return { ok: false as const, reason: "coming" as const };
  if (input.status === "SOLD" || input.invited) return { ok: true as const };
  if (isEarlyAccess(input.approvedAt, input.earlyAccessHours) && !isPro(input.viewer)) {
    return { ok: false as const, reason: "early" as const };
  }
  if (!isPro(input.viewer) && !input.openableIds.has(input.listingId)) {
    return { ok: false as const, reason: "limit" as const };
  }
  return { ok: true as const };
}

// A private listing takes no place in the free slice: it opens to its invitees only, through canOpenListing's
// invited flag. Callers select visibility so the slice is the same on every page.
export function openableListingIds(
  listings: { id: string; status: ListingStatus; approvedAt: Date | null; visibility?: string | null }[],
  earlyAccessHours: number,
  limit: number,
) {
  const ranked = listings
    .filter((listing) => (listing.status === "APPROVED" || listing.status === "PENDING") && listing.visibility !== "PRIVATE")
    .filter((listing) => !isEarlyAccess(listing.approvedAt, earlyAccessHours))
    .sort((a, b) => (b.approvedAt?.getTime() ?? 0) - (a.approvedAt?.getTime() ?? 0));
  return new Set(ranked.slice(0, Math.max(limit, 0)).map((listing) => listing.id));
}
