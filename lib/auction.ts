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
