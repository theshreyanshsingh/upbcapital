import { audit } from "@/lib/audit";
import { ACKNOWLEDGE_FIRST, acknowledgementMissing, eligibilityFor, eligibilityLog, type Eligibility } from "@/lib/eligibility";
import { roadAcknowledgedAt } from "@/lib/inquiry";
import { prisma } from "@/lib/prisma";

// A group seat is a pledge toward one bid, so it meets the eligibility screen checkOffer runs before a buyer's own
// bid (lib/inquiry.ts). A buyer who says they control 350 or more homes acknowledges the ROAD Act notice on the
// listing, after their latest answers, before opening a group or taking a seat in one. The acknowledgement is the
// one the listing page takes, so a buyer gives it once per listing for both. A group on one loan screens that
// loan; otherwise the group buys the whole listing and every loan on it counts.
export async function seatEligibility(userId: string, listingId: string, noteId: string | null = null) {
  const [profile, loans] = await Promise.all([
    prisma.buyerProfile.findUnique({ where: { userId }, select: { entityType: true, homesControlled: true, reoStrategy: true, eligibilityAt: true } }),
    prisma.note.findMany({ where: { listingId, ...(noteId ? { id: noteId } : {}) }, select: { state: true, propertyType: true, paymentStatus: true } }),
  ]);
  const eligibility = eligibilityFor(loans, profile);
  const acknowledgedAt = eligibility.acknowledge ? await roadAcknowledgedAt(userId, listingId) : null;
  const error = acknowledgementMissing(eligibility, acknowledgedAt, profile?.eligibilityAt) ? ACKNOWLEDGE_FIRST : null;
  return { error, eligibility, acknowledgedAt };
}

// What the seat holder was shown goes into the log against the group, as a bid's does against the bid. Nothing is
// written when no notice applied.
export async function logSeatEligibility(userId: string, groupId: string, check: { eligibility: Eligibility; acknowledgedAt: Date | null }) {
  const line = eligibilityLog(check.eligibility, check.acknowledgedAt);
  if (line) await audit(userId, "ELIGIBILITY", "group", groupId, line);
}
