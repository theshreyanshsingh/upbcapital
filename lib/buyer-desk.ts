import { deskWalled } from "@/lib/auction";
import { bidCapFor } from "@/lib/bid-caps";
import { ownersByFile } from "@/lib/beneficial-owners";
import { buyerPrice } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { strikeLimitOf, strikesFor } from "@/lib/strikes";

// One buyer as the desk reads them, as DebtX's desk does: the file, every bid and how it ended, each closing,
// strikes, holdings and the log. Amounts on a sealed or best-and-final listing stay behind the desk's wall
// (lib/auction.ts deskWalled), the same wall the offer book and the bid sheet keep.

type Viewer = { role: string; deskRole?: string | null };
type WallListing = { bidMode: string; bidDeadline: Date | null; status?: string };
type Priced = { kind: string; amount: number | null; createdAt: Date; authorId: string };

export type RawBid = {
  id: string;
  buyerId: string;
  listingId: string;
  status: string;
  createdAt: Date;
  amount: number | null;
  buyNow?: boolean | null;
  messages: Priced[];
  listing: WallListing & { title: string };
  note?: { city: string; state: string } | null;
};

export type BidView = {
  id: string;
  listingId: string;
  listingTitle: string;
  loan: string;
  status: string;
  createdAt: Date;
  buyNow: boolean;
  // The price the buyer last named. Null when the wall hides it from this viewer, or there is none.
  amount: number | null;
  sealed: boolean;
};

// The bids as this viewer may read them. The amount is the buyer's own latest price, as the offer book ranks it.
export function bidViews(viewer: Viewer, bids: RawBid[], now = new Date()): BidView[] {
  return bids.map((bid) => {
    const sealed = deskWalled(bid.listing, viewer, now);
    const price = buyerPrice(bid.amount, bid.messages, bid.buyerId);
    return {
      id: bid.id,
      listingId: bid.listingId,
      listingTitle: bid.listing.title,
      loan: bid.note ? `Loan in ${bid.note.city}, ${bid.note.state}` : "Whole listing",
      status: bid.status,
      createdAt: bid.createdAt,
      buyNow: Boolean(bid.buyNow),
      amount: sealed ? null : price ?? null,
      sealed,
    };
  });
}

// A figure on a closing, or a line in the log, on a listing behind the wall. The figure shows once the wall lifts.
export function walledFigure<T>(viewer: Viewer, listing: WallListing, value: T, now = new Date()): T | null {
  return deskWalled(listing, viewer, now) ? null : value;
}

export const SEALED_DETAIL = "Detail sealed until the deadline.";

const DECIDED = ["ACCEPTED", "DECLINED", "EXPIRED"];

// Win rate over the bids decided either way, and close rate over the closings that finished. A bid still open, or
// one the buyer took back, counts toward neither.
export function buyerRates(bids: { status: string }[], closings: { status: string }[]) {
  const decided = bids.filter((bid) => DECIDED.includes(bid.status)).length;
  const won = bids.filter((bid) => bid.status === "ACCEPTED").length;
  const finished = closings.filter((closing) => closing.status === "COMPLETE" || closing.status === "CANCELED").length;
  const closed = closings.filter((closing) => closing.status === "COMPLETE").length;
  return {
    bids: bids.length,
    decided,
    won,
    winRate: decided ? won / decided : null,
    finished,
    closed,
    closeRate: finished ? closed / finished : null,
  };
}

export function rateText(rate: number | null) {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

const WALL = { bidMode: true, bidDeadline: true, status: true } as const;

export async function buyerDeskProfile(viewer: Viewer, userId: string, now = new Date()) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      companyName: true,
      role: true,
      accountStatus: true,
      subscriptionTier: true,
      createdAt: true,
      deletedAt: true,
      bidCapCents: true,
      bidCapLifted: true,
      buyerProfile: true,
    },
  });
  if (!user || user.role !== "BUYER") return null;
  const [rawBids, funderRows, entities, owners, strikeRows, holdings, settings, cap] = await Promise.all([
    prisma.inquiry.findMany({
      where: { buyerId: userId, type: "OFFER" },
      select: {
        id: true,
        buyerId: true,
        listingId: true,
        status: true,
        createdAt: true,
        amount: true,
        buyNow: true,
        messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } },
        listing: { select: { title: true, ...WALL } },
        note: { select: { city: true, state: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.closingFunder.findMany({ where: { userId }, select: { closingId: true, amount: true, premiumCents: true, status: true } }),
    prisma.buyerEntity.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    ownersByFile([userId]),
    strikesFor([userId]),
    prisma.buyerHolding.findMany({ where: { userId }, orderBy: { acquiredAt: "desc" } }),
    getSettings(),
    bidCapFor(userId, { now }),
  ]);
  const bidIds = rawBids.map((bid) => bid.id);
  const closingRows = await prisma.closing.findMany({
    where: { OR: [...(bidIds.length ? [{ inquiryId: { in: bidIds } }] : []), { id: { in: funderRows.map((row) => row.closingId) } }] },
    select: {
      id: true,
      inquiryId: true,
      status: true,
      salePrice: true,
      buyerTotalCents: true,
      openedAt: true,
      closedAt: true,
      canceledAt: true,
      cancelReason: true,
      listing: { select: { id: true, title: true, ...WALL } },
    },
    orderBy: { openedAt: "desc" },
  });
  const share = new Map(funderRows.map((row) => [row.closingId, row]));
  const won = new Set(bidIds);
  const closings = closingRows.map((closing) => {
    const seat = share.get(closing.id);
    // A group's lead holds the bid and a seat; the seat is what they fund.
    const part = seat ? Number(seat.amount) + seat.premiumCents / 100 : closing.buyerTotalCents / 100;
    return {
      id: closing.id,
      listingId: closing.listing.id,
      listingTitle: closing.listing.title,
      status: closing.status,
      as: seat && !(closing.inquiryId && won.has(closing.inquiryId)) ? ("funder" as const) : seat ? ("lead" as const) : ("buyer" as const),
      price: walledFigure(viewer, closing.listing, closing.salePrice, now),
      theirShare: walledFigure(viewer, closing.listing, part, now),
      openedAt: closing.openedAt,
      endedAt: closing.closedAt ?? closing.canceledAt ?? null,
      cancelReason: closing.cancelReason ?? null,
    };
  });
  // The log: what the buyer did, what was done to their account, and what happened on their bids.
  const events = await prisma.auditEvent.findMany({
    where: { OR: [{ actorId: userId }, { entityId: userId }, ...(bidIds.length ? [{ entityId: { in: bidIds } }] : [])] },
    include: { actor: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  const listingOfBid = new Map(rawBids.map((bid) => [bid.id, bid.listing]));
  const audit = events.map((event) => {
    const listing = event.entityType === "inquiry" ? listingOfBid.get(event.entityId) : undefined;
    return {
      id: event.id,
      createdAt: event.createdAt,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      actor: event.actor?.name ?? (event.actorId ? "Removed account" : "System"),
      detail: listing ? (walledFigure(viewer, listing, event.detail, now) ?? SEALED_DETAIL) : event.detail,
    };
  });
  const bids = bidViews(viewer, rawBids.map((bid) => ({ ...bid, messages: bid.messages.map((message) => ({ ...message, amount: message.amount ?? null })) })), now);
  const strikes = strikeRows.get(userId) ?? [];
  return {
    user,
    file: user.buyerProfile,
    entities,
    owners,
    bids,
    closings,
    rates: buyerRates(bids, closings),
    strikes,
    activeStrikes: strikes.filter((strike) => !strike.clearedAt).length,
    strikeLimit: strikeLimitOf(settings.strikeLimit),
    holdings,
    cap,
    audit,
  };
}
