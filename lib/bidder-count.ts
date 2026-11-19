import { audit } from "@/lib/audit";
import { deadlinePassed } from "@/lib/auction";
import { launchPending } from "@/lib/launch-rules";
import { bidExpired } from "@/lib/offers";
import { prisma } from "@/lib/prisma";

// A live count of the other firms bidding on a listing, shown to its bidders when the seller chooses. Ten-X and similar
// venues show one: knowing others are in raises bids without saying what anyone bid. It is a count and nothing else. No
// amount, rank, time of the last bid or anything else that narrows a price goes with it, and UPB still sends no
// near-miss or outbid alert, since those would leak amounts. The seller's own counts stay on their page
// (lib/activity.ts).

// From five up the count reads "5 or more". A buyer who reloads the page sees every change in the count, and so learns
// when another firm bid or withdrew. Below five that is the price of the signal. Above it, an exact figure adds no
// urgency, only more of that timing, and a long-running sale would print a trail of it. One and two show exactly:
// a thin field is the fact the count exists to tell.
export const BIDDER_COUNT_CAP = 5;

export const BIDDER_COUNT_SWITCH = "Show buyers how many others are bidding (never amounts)";

export type BidderCount = { count: number; orMore: boolean; label: string };

type CountListing = { id: string; status: string; bidMode: string; bidDeadline: Date | null; showBidderCount?: boolean | null; launchAt?: Date | null };
type Viewer = { id: string; role: string; accountStatus: string };

// Whether the count shows at all: the seller opted in, the listing is live on the book, and its round hasn't closed.
// After a sealed or best-and-final deadline the desk awards, so the count stops there.
export function bidderCountShown(listing: CountListing, now = new Date()) {
  if (listing.showBidderCount !== true) return false;
  if (listing.status !== "APPROVED" || launchPending(listing, now)) return false;
  return !(listing.bidMode !== "NONE" && deadlinePassed(listing.bidDeadline, now));
}

export function bidderCountLabel(others: number): BidderCount {
  const orMore = others >= BIDDER_COUNT_CAP;
  const count = Math.max(0, Math.min(others, BIDDER_COUNT_CAP));
  if (count === 0) return { count, orMore, label: "No other bids yet" };
  if (orMore) return { count, orMore, label: `${BIDDER_COUNT_CAP} or more other bidders` };
  return { count, orMore, label: `${count} other bidder${count === 1 ? "" : "s"}` };
}

// How many bidders other than the viewer's firm hold a live bid: open or reviewed, not withdrawn and not past its
// good-until date. A firm counts once however many of its seats bid, a group once however many firms hold its seats,
// and the desk's own book once, like any other bidder. A firm that bids alone and in a group is two bids in the room,
// so it counts in both. Null once any bid is accepted, since awards have begun.
export async function otherBidders(listingId: string, viewerId: string, now = new Date()) {
  const [bids, deskBids] = await Promise.all([
    prisma.inquiry.findMany({
      where: { listingId, type: "OFFER", status: { in: ["OPEN", "REVIEWED", "ACCEPTED"] } },
      select: { id: true, buyerId: true, status: true, expiresAt: true },
    }),
    prisma.deskBid.findMany({ where: { listingId, status: { in: ["OPEN", "ACCEPTED"] } }, select: { status: true } }),
  ]);
  if (bids.some((bid) => bid.status === "ACCEPTED") || deskBids.some((bid) => bid.status === "ACCEPTED")) return null;
  const live = bids.filter((bid) => !bidExpired(bid.expiresAt, now));
  const groups = live.length
    ? await prisma.groupBuy.findMany({
        where: { inquiryId: { in: live.map((bid) => bid.id) } },
        select: { id: true, inquiryId: true, positions: { where: { status: { not: "DROPPED" } }, select: { userId: true } } },
      })
    : [];
  // A seat acts as its firm, so a bid normally carries the firm's id. A seat's own id still reads as the firm.
  const ids = [...new Set([viewerId, ...live.map((bid) => bid.buyerId), ...groups.flatMap((group) => group.positions.map((position) => position.userId))])];
  const accounts = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, principalId: true } });
  const principal = new Map(accounts.map((account) => [account.id, account.principalId]));
  const firmOf = (id: string) => principal.get(id) ?? id;
  const mine = firmOf(viewerId);
  const groupOf = new Map(groups.map((group) => [group.inquiryId, group]));
  const bidders = new Set<string>();
  for (const bid of live) {
    const group = groupOf.get(bid.id);
    if (!group) {
      if (firmOf(bid.buyerId) !== mine) bidders.add(`firm:${firmOf(bid.buyerId)}`);
      continue;
    }
    // A group the viewer holds a seat in, or leads, is their own bid.
    const theirs = firmOf(bid.buyerId) === mine || group.positions.some((position) => firmOf(position.userId) === mine);
    if (!theirs) bidders.add(`group:${group.id}`);
  }
  if (deskBids.length) bidders.add("desk");
  return bidders.size;
}

// What a signed-in approved buyer reads on the listing's bid rail and in the buyer API. Null when hidden: the seller
// hasn't opted in, the round is over, awards have begun, or the viewer isn't an approved buyer.
export async function bidderCountFor(listing: CountListing, viewer: Viewer, now = new Date()): Promise<BidderCount | null> {
  if (viewer.role !== "BUYER" || viewer.accountStatus !== "APPROVED") return null;
  if (!bidderCountShown(listing, now)) return null;
  const others = await otherBidders(listing.id, viewer.id, now);
  return others == null ? null : bidderCountLabel(others);
}

// ---------------------------------------------------------------------------------------------------------------
// The seller's switch, which the desk can set for them. Off unless chosen.

const OPEN_FOR_TERMS = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"];

// Why the switch can't change now, or null. It locks when the round's deadline passes, so what bidders were shown
// stays the record of the sale, and once the listing leaves the market.
export function bidderCountLock(listing: { status: string; bidMode: string; bidDeadline: Date | null }, now = new Date()) {
  if (!OPEN_FOR_TERMS.includes(listing.status)) return "This listing is off the market, so the bidder count can't change.";
  if (listing.bidMode !== "NONE" && deadlinePassed(listing.bidDeadline, now)) return "Bids closed at the deadline, so the bidder count is fixed for this sale.";
  return null;
}

export async function setBidderCount(input: { listingId: string; actor: { id: string; role: string }; on: boolean; now?: Date }) {
  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    select: { id: true, sellerId: true, status: true, bidMode: true, bidDeadline: true, showBidderCount: true },
  });
  const desk = input.actor.role === "ADMIN";
  if (!listing || (!desk && listing.sellerId !== input.actor.id)) return { error: "That listing isn't yours." } as const;
  const locked = bidderCountLock(listing, input.now);
  if (locked) return { error: locked } as const;
  if ((listing.showBidderCount === true) === input.on) return { error: null, on: input.on, unchanged: true } as const;
  await prisma.listing.update({ where: { id: listing.id }, data: { showBidderCount: input.on } });
  await audit(input.actor.id, "BIDDER_COUNT", "listing", listing.id, `${input.on ? "on" : "off"}${desk ? ", set by the desk" : ""}`);
  return { error: null, on: input.on, unchanged: false } as const;
}
