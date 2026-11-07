import { deskCan } from "@/lib/desk-roles";

export function deadlinePassed(deadline: Date | null, now = new Date()) {
  return Boolean(deadline && deadline.getTime() <= now.getTime());
}

export function canSubmitBid(input: { bidMode: string; deadline: Date | null; alreadyBid: boolean; now?: Date }) {
  if (input.bidMode !== "NONE" && deadlinePassed(input.deadline, input.now)) {
    return { ok: false as const, reason: "deadline" as const };
  }
  if (input.bidMode === "BEST_AND_FINAL" && input.alreadyBid) {
    return { ok: false as const, reason: "final" as const };
  }
  return { ok: true as const };
}

export function hideCompetingBids(input: { bidMode: string; deadline: Date | null; isDesk: boolean; now?: Date }) {
  return input.bidMode === "SEALED" && !input.isDesk && !deadlinePassed(input.deadline, input.now);
}

// What the seller may learn about a bid on this listing right now: the bidder, not the amount or the note.
export function sealedFromSeller(listing: { bidMode: string; bidDeadline: Date | null }, now = new Date()) {
  return hideCompetingBids({ bidMode: listing.bidMode, deadline: listing.bidDeadline, isDesk: false, now });
}

// Listing statuses the desk book can still bid on, so a trader stays behind the wall through them.
const BOOK_CAN_BID = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"];

// The desk's wall. On a sealed or best-and-final listing, a bid's amount before the deadline is only for staff
// whose role reads sealed bids. Staff who buy for UPB's own book stay behind it after the deadline too, until the
// listing leaves the market, so the book never bids knowing what the seller's own bidders offered.
export function deskWalled(
  listing: { bidMode: string; bidDeadline: Date | null; status?: string },
  viewer: { role: string; deskRole?: string | null },
  now = new Date(),
) {
  if (viewer.role !== "ADMIN" || deskCan(viewer, "sealedBids")) return false;
  if (listing.bidMode !== "SEALED" && listing.bidMode !== "BEST_AND_FINAL") return false;
  if (!deadlinePassed(listing.bidDeadline, now)) return true;
  return deskCan(viewer, "deskBook") && BOOK_CAN_BID.includes(listing.status ?? "APPROVED");
}

// A dated sale event runs a listing's rounds from the event's two dates: sealed indications, then one best-and-final
// bid each. While the event is open its terms stand in for the listing's own, so nobody sets them by hand.
export const EVENT_OPEN = ["PLANNED", "INDICATIONS", "BEST_AND_FINAL"] as const;

export function eventSetsTerms(eventStatus: string | null | undefined) {
  return Boolean(eventStatus && (EVENT_OPEN as readonly string[]).includes(eventStatus));
}

// The terms a listing carries in each round. Both rounds share the best-and-final date as the deadline, so every
// check that waits for a deadline (awards, desk bids, marking sold, the closed-bids notice) waits for the second round.
export function eventTerms(round: "INDICATIONS" | "BEST_AND_FINAL", bestFinalAt: Date) {
  return { bidMode: round === "INDICATIONS" ? ("SEALED" as const) : ("BEST_AND_FINAL" as const), bidDeadline: bestFinalAt };
}
