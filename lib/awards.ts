import { onGroupDeclined } from "@/actions/group";
import { notify } from "@/lib/email";
import { prisma } from "@/lib/prisma";

// Once a bid wins, the others on the same loans can't, so they close now: an award, a desk purchase, or a
// manual sale. Each bidder hears it without the price or the winner. A one-loan sale also ends offers on the
// whole listing, which can no longer trade whole. Pass a null winner id when the winning bid isn't an offer.
export async function declineLosingBids(winner: { id: string | null; listingId: string; noteId: string | null }, title: string) {
  const open = await prisma.inquiry.findMany({
    where: { listingId: winner.listingId, ...(winner.id ? { id: { not: winner.id } } : {}), type: "OFFER", status: { in: ["OPEN", "REVIEWED"] } },
    include: { buyer: { select: { email: true } } },
  });
  const losers = winner.noteId ? open.filter((offer) => !offer.noteId || offer.noteId === winner.noteId) : open;
  const { emitWebhook } = await import("@/lib/webhooks");
  const sellerId = (await prisma.listing.findUnique({ where: { id: winner.listingId }, select: { sellerId: true } }))?.sellerId;
  for (const loser of losers) {
    await prisma.inquiry.update({ where: { id: loser.id }, data: { status: "DECLINED" } });
    await onGroupDeclined(loser.id, "Another bid was accepted, so the group offer closed.");
    if (sellerId) await emitWebhook(sellerId, "offer.declined", { inquiryId: loser.id, listingId: winner.listingId, reason: "another_bid_accepted" });
    await notify(
      loser.buyer.email,
      `Bid not selected · ${title}`,
      winner.noteId && !loser.noteId
        ? "A loan in this pool was sold on its own, so the pool can no longer trade whole. Thank you for bidding."
        : "Another bid was accepted. Thank you for bidding.",
    );
  }
  return losers.length;
}

// Takes one loan into contract only if it is still free, in a single write, so two awards at the same moment
// can't both get it. Returns false when someone else got there first.
export async function claimLoan(noteId: string) {
  const claimed = await prisma.note.updateMany({ where: { id: noteId, tradeStatus: "AVAILABLE" }, data: { tradeStatus: "IN_CONTRACT" } });
  return claimed.count === 1;
}
