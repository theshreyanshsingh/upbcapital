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
