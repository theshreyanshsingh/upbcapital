import type { SaleEvent } from "@prisma/client";
import { EVENT_OPEN, eventSetsTerms, eventTerms } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notify, notifyDesk } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import { launchBlock } from "@/lib/launch-rules";
import { notifyIfAuctionClosed } from "@/lib/listing-intel";
import { prisma } from "@/lib/prisma";
import { notifyWatchers } from "@/lib/watchers";

// A dated sale event, on an advisor's cadence: sealed indications by one date, then one best-and-final bid each by
// a second date 7 to 30 days later. Listings from several sellers trade on the same two dates, so thin demand
// gathers where buyers can plan for it. The rounds run on the listing's own bid terms (lib/auction.ts), never beside them.

const DAY = 24 * 60 * 60 * 1000;
export const FINAL_MIN_DAYS = 7;
export const FINAL_MAX_DAYS = 30;
export const FINAL_USUAL_DAYS = [16, 21] as const;
// A blank best-and-final date takes the short end of the usual gap, since rates can move a bid inside a long round.
export const FINAL_DEFAULT_DAYS = 16;

const LIVE_BIDS = ["OPEN", "REVIEWED", "ACCEPTED"] as const;

export type EventStatus = "PLANNED" | "INDICATIONS" | "BEST_AND_FINAL" | "CLOSED" | "CANCELED";
type Dated = { status: string; indicationsAt: Date; bestFinalAt: Date };

// A date and time as the desk prints every deadline: in UTC, with the time.
export function when(date: Date) {
  return `${prettyDate(date)}, ${date.toISOString().slice(11, 16)} UTC`;
}

export const EVENT_STATUS_LABEL: Record<string, string> = {
  PLANNED: "Planned",
  INDICATIONS: "Indications open",
  BEST_AND_FINAL: "Best and final open",
  CLOSED: "Closed",
  CANCELED: "Canceled",
};

// A date as a datetime-local field shows it, in UTC.
export function inputValue(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 16) : "";
}

// The form's datetime-local value, read as UTC like the bid deadline field.
export function readUtc(raw: string) {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function gapDays(indicationsAt: Date, bestFinalAt: Date) {
  return (bestFinalAt.getTime() - indicationsAt.getTime()) / DAY;
}

export function usualGap(indicationsAt: Date, bestFinalAt: Date) {
  const gap = gapDays(indicationsAt, bestFinalAt);
  return gap >= FINAL_USUAL_DAYS[0] && gap <= FINAL_USUAL_DAYS[1];
}

export function datesProblem(dates: { indicationsAt: Date; bestFinalAt: Date }, now = new Date()) {
  if (dates.indicationsAt.getTime() <= now.getTime()) return "The indications date has to be in the future.";
  const gap = gapDays(dates.indicationsAt, dates.bestFinalAt);
  if (!(gap >= FINAL_MIN_DAYS && gap <= FINAL_MAX_DAYS)) {
    return `Best and final has to fall ${FINAL_MIN_DAYS} to ${FINAL_MAX_DAYS} days after indications. ${FINAL_USUAL_DAYS[0]} to ${FINAL_USUAL_DAYS[1]} days is usual.`;
  }
  return null;
}

export function readEventDates(rawIndications: string, rawBestFinal: string, now = new Date()) {
  const indicationsAt = readUtc(rawIndications);
  if (!indicationsAt) return { error: "Enter the indications date and time." } as const;
  const bestFinalAt = rawBestFinal.trim() ? readUtc(rawBestFinal) : new Date(indicationsAt.getTime() + FINAL_DEFAULT_DAYS * DAY);
  if (!bestFinalAt) return { error: "Enter the best-and-final date and time, or leave it blank." } as const;
  const problem = datesProblem({ indicationsAt, bestFinalAt }, now);
  if (problem) return { error: problem } as const;
  return { error: null, indicationsAt, bestFinalAt, usual: usualGap(indicationsAt, bestFinalAt) } as const;
}

// The one move an event's dates call for now, or null. Indications open as soon as a listing joins, since its
// terms are live from then. A best-and-final round whose dates both passed before it opened is skipped, not opened late.
export function nextStatus(event: Dated, listings: number, now = new Date()): EventStatus | null {
  const at = now.getTime();
  if (event.status === "PLANNED") {
    if (listings > 0) return "INDICATIONS";
    return at >= event.indicationsAt.getTime() ? "CANCELED" : null;
  }
  if (event.status === "INDICATIONS") {
    if (at >= event.bestFinalAt.getTime()) return "CLOSED";
    return at >= event.indicationsAt.getTime() ? "BEST_AND_FINAL" : null;
  }
  if (event.status === "BEST_AND_FINAL") return at >= event.bestFinalAt.getTime() ? "CLOSED" : null;
  return null;
}

// Which round a buyer can act in, in words, for the listing page, the book and the events page.
export function roundText(event: Dated) {
  if (event.status === "PLANNED") return "Upcoming. Listings join before indications are due.";
  if (event.status === "INDICATIONS") return `Indications are open: sealed bids until ${when(event.indicationsAt)}.`;
  if (event.status === "BEST_AND_FINAL") return `Best and final is open: one bid each until ${when(event.bestFinalAt)}.`;
  if (event.status === "CLOSED") return "Closed. The desk awards from the bids in.";
  return "Canceled.";
}

// The date that matters next, for ordering events.
export function nextDate(event: Dated) {
  return event.status === "BEST_AND_FINAL" || event.status === "CLOSED" ? event.bestFinalAt : event.indicationsAt;
}

type HeldBid = { id: string; buyerId: string; status: string; createdAt: Date; group: boolean };

// At the round change, an indication placed before the indications date is released, so its buyer can place one
// best-and-final bid. One they withdrew during the event is released too, since best and final counts a withdrawn bid
// as the one bid. A bid placed after the date, before the round switched, already is a best-and-final bid and stays.
// A group's bid stays as its bid, since releasing it would undo every seat.
export function splitIndications(bids: HeldBid[], window: { since: Date; indicationsAt: Date }) {
  const release: HeldBid[] = [];
  const keep: HeldBid[] = [];
  const cut = window.indicationsAt.getTime();
  for (const bid of bids) {
    const live = bid.status === "OPEN" || bid.status === "REVIEWED";
    const placed = bid.createdAt.getTime();
    if (bid.group) {
      if (live) keep.push(bid);
    } else if (live && placed < cut) {
      release.push(bid);
    } else if (bid.status === "WITHDRAWN" && placed < cut && placed >= window.since.getTime()) {
      release.push(bid);
    } else if (live) {
      keep.push(bid);
    }
  }
  return { release, keep };
}

// Why this listing can't join this event, or null when it can. Bids placed under the listing's own terms run to
// their end first, as a running round's rules hold in setAuction. Terms with no bids are simply replaced.
export function joinBlock(input: {
  event: { id: string; status: string; indicationsAt: Date };
  listing: { status: string; saleEventId?: string | null; launchAt?: Date | null };
  currentEventStatus: string | null;
  liveBids: number;
  consent: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (input.event.status !== "PLANNED" && input.event.status !== "INDICATIONS") return "This event is no longer taking listings.";
  if (input.event.indicationsAt.getTime() <= now.getTime()) return "Indications are already due, so a listing can't join now.";
  if (input.listing.status !== "APPROVED") return "Only a live listing can join a sale event.";
  const coming = launchBlock(input.listing, "event", now);
  if (coming) return coming;
  if (input.listing.saleEventId && eventSetsTerms(input.currentEventStatus)) {
    return input.listing.saleEventId === input.event.id ? "This listing is already in this event." : "This listing is already in another open event.";
  }
  if (input.liveBids > 0) return "Bids are in under this listing's own terms. They run to their end first, so it can't join.";
  if (input.consent.trim().length < 3) return "Record how the seller agreed, such as the email and its date.";
  return null;
}

// Why the desk can't take this listing out of its event, or null when it can.
export function leaveBlock(input: { eventStatus: string; liveBids: number }) {
  if (!eventSetsTerms(input.eventStatus)) return "This event is over, so its listings stay on its record.";
  if (input.liveBids > 0) return "Bids are in, so this listing stays in the event until it closes.";
  return null;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function liveBidCount(listingIds: string[]) {
  return listingIds.length ? prisma.inquiry.count({ where: { listingId: { in: listingIds }, type: "OFFER", status: { in: [...LIVE_BIDS] } } }) : Promise.resolve(0);
}

// Back to open offers, out of the event. Only a listing still in this event moves.
async function releaseListing(listingId: string, eventId: string) {
  const done = await prisma.listing.updateMany({
    where: { id: listingId, saleEventId: eventId },
    data: { saleEventId: null, bidMode: "NONE", bidDeadline: null, auctionNotifiedAt: null, bidReminderAt: null, watchReminderAt: null },
  });
  return done.count === 1;
}

export async function createEvent(input: { name: string; summary: string; indicationsAt: string; bestFinalAt: string; actorId: string; now?: Date }) {
  const name = input.name.trim().slice(0, 120);
  if (name.length < 3) return { error: "Name the event." } as const;
  const dates = readEventDates(input.indicationsAt, input.bestFinalAt, input.now);
  if (dates.error !== null) return { error: dates.error } as const;
  const event = await prisma.saleEvent.create({
    data: { name, summary: input.summary.trim().slice(0, 1000), indicationsAt: dates.indicationsAt, bestFinalAt: dates.bestFinalAt, createdById: input.actorId },
  });
  await audit(input.actorId, "SALE_EVENT_CREATED", "saleEvent", event.id, `${name} · indications ${when(dates.indicationsAt)} · best and final ${when(dates.bestFinalAt)}`);
  return { error: null, event, usual: dates.usual } as const;
}

// The name and summary change until the event is over. The dates change only before any bid is in, and the
// listings' deadlines move with them.
export async function editEvent(input: { eventId: string; name: string; summary: string; indicationsAt: string; bestFinalAt: string; actorId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const event = await prisma.saleEvent.findUnique({ where: { id: input.eventId } });
  if (!event) return { error: "That event no longer exists." } as const;
  if (!eventSetsTerms(event.status)) return { error: "This event is over, so it can't change." } as const;
  const name = input.name.trim().slice(0, 120);
  if (name.length < 3) return { error: "Name the event." } as const;
  const summary = input.summary.trim().slice(0, 1000);
  const typedIndications = readUtc(input.indicationsAt);
  const typedFinal = readUtc(input.bestFinalAt);
  const same = typedIndications?.getTime() === event.indicationsAt.getTime() && typedFinal?.getTime() === event.bestFinalAt.getTime();
  if (!same) {
    if (event.status === "BEST_AND_FINAL") return { error: "Best and final is open, so the dates stay as printed." } as const;
    const dates = readEventDates(input.indicationsAt, input.bestFinalAt, now);
    if (dates.error !== null) return { error: dates.error } as const;
    const listings = await prisma.listing.findMany({ where: { saleEventId: event.id }, select: { id: true, title: true, seller: { select: { email: true } } } });
    if ((await liveBidCount(listings.map((listing) => listing.id))) > 0) return { error: "Bids are in, so the dates stay as printed." } as const;
    const claimed = await prisma.saleEvent.updateMany({
      where: { id: event.id, status: event.status, indicationsAt: event.indicationsAt, bestFinalAt: event.bestFinalAt },
      data: { name, summary, indicationsAt: dates.indicationsAt, bestFinalAt: dates.bestFinalAt },
    });
    if (claimed.count !== 1) return { error: "The event changed a moment ago. Check it and try again." } as const;
    await prisma.listing.updateMany({
      where: { saleEventId: event.id, bidMode: "SEALED", bidDeadline: event.bestFinalAt },
      data: { bidDeadline: dates.bestFinalAt, bidReminderAt: null, watchReminderAt: null, auctionNotifiedAt: null },
    });
    await audit(input.actorId, "SALE_EVENT_DATES", "saleEvent", event.id, `Indications ${when(dates.indicationsAt)} · best and final ${when(dates.bestFinalAt)}`);
    for (const listing of listings) {
      await notify(
        listing.seller.email,
        `Sale event dates moved · ${listing.title}`,
        `${name} has new dates. Indications are due ${when(dates.indicationsAt)}. Best and final is due ${when(dates.bestFinalAt)}.`,
      );
      await notifyWatchers({
        listingId: listing.id,
        event: "SALE_EVENT",
        subject: `New sale dates · ${listing.title}`,
        body: `${listing.title}, a listing you saved, has new dates in the sale event ${name}. Sealed indications are due ${when(dates.indicationsAt)}. Best and final, one bid each, is due ${when(dates.bestFinalAt)}.`,
        except: [input.actorId],
      });
    }
    return { error: null, moved: true } as const;
  }
  await prisma.saleEvent.update({ where: { id: event.id }, data: { name, summary } });
  return { error: null, moved: false } as const;
}

// The desk enters a seller's live listing, on the seller's agreement, which the desk records as it does for a desk
// purchase. The listing's bid terms become the event's: sealed indications now, best and final at the round change.
export async function enterEvent(input: { eventId: string; listingId: string; consent: string; actorId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const [event, listing] = await Promise.all([
    prisma.saleEvent.findUnique({ where: { id: input.eventId } }),
    prisma.listing.findUnique({ where: { id: input.listingId }, include: { seller: { select: { email: true } } } }),
  ]);
  if (!event) return { error: "That event no longer exists." } as const;
  if (!listing) return { error: "That listing no longer exists." } as const;
  const current = !listing.saleEventId ? null : listing.saleEventId === event.id ? event : await prisma.saleEvent.findUnique({ where: { id: listing.saleEventId } });
  const consent = input.consent.trim().slice(0, 300);
  const block = joinBlock({ event, listing, currentEventStatus: current?.status ?? null, liveBids: await liveBidCount([listing.id]), consent, now });
  if (block) return { error: block } as const;
  // Claimed on the terms just read, so a seller saving their own terms at the same moment wins or loses cleanly.
  const claimed = await prisma.listing.updateMany({
    where: {
      id: listing.id,
      status: "APPROVED",
      bidMode: listing.bidMode,
      AND: [
        listing.saleEventId ? { saleEventId: listing.saleEventId } : unset("saleEventId"),
        listing.bidDeadline ? { bidDeadline: listing.bidDeadline } : unset("bidDeadline"),
      ],
    },
    data: { saleEventId: event.id, ...eventTerms("INDICATIONS", event.bestFinalAt), auctionNotifiedAt: null, bidReminderAt: null, watchReminderAt: null },
  });
  if (claimed.count !== 1) return { error: "The listing changed a moment ago. Check it and try again." } as const;
  await prisma.saleEvent.updateMany({ where: { id: event.id, status: "PLANNED" }, data: { status: "INDICATIONS" } });
  // A cancel that landed in the same instant would leave the listing on a dead event's terms, so it comes back out.
  const fresh = await prisma.saleEvent.findUnique({ where: { id: event.id }, select: { status: true } });
  if (!fresh || !eventSetsTerms(fresh.status)) {
    await releaseListing(listing.id, event.id);
    return { error: "This event closed a moment ago." } as const;
  }
  await audit(input.actorId, "SALE_EVENT_JOIN", "listing", listing.id, `${event.id} · ${event.name} · Seller agreement: ${consent}`);
  const paused = listing.buyNowPrice != null ? " Your buy-it-now price is paused while the event runs." : "";
  await notify(
    listing.seller.email,
    `Sale event · ${listing.title}`,
    `The desk entered ${listing.title} in ${event.name}, on your agreement (${consent}). Sealed indications are due ${when(event.indicationsAt)}. Best and final, one bid per buyer, is due ${when(event.bestFinalAt)}. Awards wait for that date, and your approval works as usual.${paused} If you did not agree, write the desk now.`,
  );
  // Buyers who saved it hear the event's two dates, since its bid terms are now the event's.
  await notifyWatchers({
    listingId: listing.id,
    event: "SALE_EVENT",
    subject: `In a sale event · ${listing.title}`,
    body: `${listing.title}, a listing you saved, is in the sale event ${event.name}. Sealed indications are due ${when(event.indicationsAt)}. Best and final, one bid each, is due ${when(event.bestFinalAt)}. Awards wait for that date.`,
    except: [input.actorId],
  });
  return { error: null } as const;
}

export async function leaveEvent(input: { eventId: string; listingId: string; actorId: string }) {
  const [event, listing] = await Promise.all([
    prisma.saleEvent.findUnique({ where: { id: input.eventId } }),
    prisma.listing.findUnique({ where: { id: input.listingId }, include: { seller: { select: { email: true } } } }),
  ]);
  if (!event || !listing || listing.saleEventId !== event.id) return { error: "That listing isn't in this event." } as const;
  const block = leaveBlock({ eventStatus: event.status, liveBids: await liveBidCount([listing.id]) });
  if (block) return { error: block } as const;
  if (!(await releaseListing(listing.id, event.id))) return { error: "The listing changed a moment ago. Check it and try again." } as const;
  await audit(input.actorId, "SALE_EVENT_LEAVE", "listing", listing.id, `${event.id} · ${event.name}`);
  await notify(listing.seller.email, `Out of the sale event · ${listing.title}`, `The desk took ${listing.title} out of ${event.name}. It is back on open offers, and its bid terms can be set again.`);
  return { error: null } as const;
}

// An event with bids in runs to its dates, as any round does. One without is called off and its listings go back.
export async function cancelEvent(input: { eventId: string; actorId: string }) {
  const event = await prisma.saleEvent.findUnique({ where: { id: input.eventId } });
  if (!event) return { error: "That event no longer exists." } as const;
  if (!eventSetsTerms(event.status)) return { error: "This event is already over." } as const;
  const listings = await prisma.listing.findMany({ where: { saleEventId: event.id }, include: { seller: { select: { email: true } } } });
  const bids = await liveBidCount(listings.map((listing) => listing.id));
  if (bids > 0) return { error: `${plural(bids, "bid")} ${bids === 1 ? "is" : "are"} in, so the event runs to its dates. Take out the listings without bids instead.` } as const;
  const claimed = await prisma.saleEvent.updateMany({ where: { id: event.id, status: event.status }, data: { status: "CANCELED" } });
  if (claimed.count !== 1) return { error: "The event changed a moment ago. Check it and try again." } as const;
  for (const listing of listings) {
    if (!(await releaseListing(listing.id, event.id))) continue;
    await notify(listing.seller.email, `Sale event canceled · ${listing.title}`, `${event.name} is canceled. ${listing.title} is back on open offers.`);
  }
  await audit(input.actorId, "SALE_EVENT_CANCELED", "saleEvent", event.id, `${event.name} · ${plural(listings.length, "listing")} released`);
  return { error: null } as const;
}

type Outcome = { moves: number; failed: number; error: string };

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
}

// Indications on one listing whose round just switched: released, kept, and everyone told.
async function settleIndications(listing: { id: string; title: string; seller: { email: string } }, event: SaleEvent) {
  const bids = await prisma.inquiry.findMany({
    where: { listingId: listing.id, type: "OFFER", status: { in: ["OPEN", "REVIEWED", "WITHDRAWN"] } },
    include: { buyer: { select: { email: true } } },
  });
  const grouped = new Set((await prisma.groupBuy.findMany({ where: { inquiryId: { in: bids.map((bid) => bid.id) } }, select: { inquiryId: true } })).map((group) => group.inquiryId));
  const byId = new Map(bids.map((bid) => [bid.id, bid]));
  const split = splitIndications(
    bids.map((bid) => ({ id: bid.id, buyerId: bid.buyerId, status: bid.status, createdAt: bid.createdAt, group: grouped.has(bid.id) })),
    { since: event.createdAt, indicationsAt: event.indicationsAt },
  );
  const released: typeof bids = [];
  for (const item of split.release) {
    const bid = byId.get(item.id)!;
    // Declined is the one closed status best and final doesn't count as a buyer's bid.
    const done = await prisma.inquiry.updateMany({ where: { id: bid.id, status: bid.status }, data: { status: "DECLINED" } });
    if (done.count !== 1) continue;
    released.push(bid);
    if (bid.status !== "WITHDRAWN" && event.createdById) {
      await prisma.offerMessage.create({
        data: { inquiryId: bid.id, authorId: event.createdById, kind: "NOTE", body: `Indications closed ${when(event.indicationsAt)}. This indication is released and is not a bid. Place one best-and-final bid by ${when(event.bestFinalAt)} to stay in.` },
      });
    }
  }
  const indications = released.filter((bid) => bid.status !== "WITHDRAWN");
  const keptEmails = new Set(split.keep.map((item) => byId.get(item.id)!.buyer.email));
  for (const email of keptEmails) {
    await notify(email, `Best and final open · ${listing.title}`, `Your bid on ${listing.title} stands as your one best-and-final bid. Bids close ${when(event.bestFinalAt)}, and the desk awards after that.`);
  }
  for (const email of new Set(indications.map((bid) => bid.buyer.email))) {
    if (keptEmails.has(email)) continue;
    await notify(
      email,
      `Best and final open · ${listing.title}`,
      `Indications on ${listing.title} closed ${when(event.indicationsAt)}. Your indication is released, so it is not a bid. Place one best-and-final bid by ${when(event.bestFinalAt)} to stay in. The desk awards after that date.`,
    );
  }
  const buyers = new Set(indications.map((bid) => bid.buyerId)).size;
  const came = indications.length ? `${plural(indications.length, "indication")} came in on ${listing.title} from ${plural(buyers, "buyer")}.` : `No indications came in on ${listing.title}.`;
  await notify(
    listing.seller.email,
    `Indications closed · ${listing.title}`,
    `${came} Best and final, one bid per buyer, is open until ${when(event.bestFinalAt)}. Awards wait for that date, and your approval works as usual.`,
  );
  await audit(null, "SALE_EVENT_FINAL", "listing", listing.id, `${event.id} · ${released.length} released · ${split.keep.length} kept`);
  return { indications: indications.length, kept: split.keep.length };
}

// Every listing still on indication terms moves to best and final. Each is claimed on those terms, so a second run,
// or a repair pass after a crash, switches and tells nobody twice.
async function openFinalRound(event: SaleEvent) {
  const terms = { saleEventId: event.id, status: "APPROVED" as const, bidMode: "SEALED" as const, bidDeadline: event.bestFinalAt };
  const listings = await prisma.listing.findMany({ where: terms, select: { id: true, title: true, seller: { select: { email: true } } } });
  const totals = { listings: 0, indications: 0, kept: 0, failed: 0, error: "" };
  for (const listing of listings) {
    try {
      const claimed = await prisma.listing.updateMany({ where: { id: listing.id, ...terms }, data: eventTerms("BEST_AND_FINAL", event.bestFinalAt) });
      if (claimed.count !== 1) continue;
      totals.listings += 1;
      const settled = await settleIndications(listing, event);
      totals.indications += settled.indications;
      totals.kept += settled.kept;
    } catch (error) {
      totals.failed += 1;
      totals.error ||= `listing ${listing.id}: ${errorText(error)}`;
      console.error(`[upb-events] round change failed for listing ${listing.id}:`, errorText(error));
    }
  }
  return totals;
}

async function announceMove(event: SaleEvent, from: string): Promise<Pick<Outcome, "failed" | "error">> {
  await audit(null, "SALE_EVENT_ROUND", "saleEvent", event.id, `${from} to ${event.status}`);
  if (event.status === "CANCELED") {
    await notifyDesk(`Sale event canceled · ${event.name}`, `No listings joined ${event.name} by its indications date of ${when(event.indicationsAt)}, so it is canceled.`);
  }
  if (event.status === "BEST_AND_FINAL") {
    const round = await openFinalRound(event);
    await notifyDesk(
      `Best and final open · ${event.name}`,
      `Indications closed on ${event.name}. ${plural(round.indications, "indication")} across ${plural(round.listings, "listing")} ${round.indications === 1 ? "was" : "were"} released, so each buyer can bid best and final. ${plural(round.kept, "later bid")} already ${round.kept === 1 ? "counts" : "count"} as best and final. The round is open until ${when(event.bestFinalAt)}.`,
    );
    return { failed: round.failed, error: round.error };
  }
  if (event.status === "CLOSED") {
    const listings = await prisma.listing.findMany({ where: { saleEventId: event.id }, select: { id: true } });
    // The per-listing closed-bids notice is claimed on the listing, so the daily job's pass sends nothing twice.
    for (const listing of listings) await notifyIfAuctionClosed(listing.id);
    const bids = await liveBidCount(listings.map((listing) => listing.id));
    await notifyDesk(
      `Sale event closed · ${event.name}`,
      from === "INDICATIONS"
        ? `${event.name} passed its best-and-final date before the round changed, so the sealed bids stand as the bids. ${plural(bids, "live bid")} across ${plural(listings.length, "listing")}. Award from the offer book.`
        : `${event.name} closed with ${plural(bids, "live bid")} across ${plural(listings.length, "listing")}. Award from the offer book.`,
    );
  }
  return { failed: 0, error: "" };
}

// Moves one event as far as its dates allow. Each move is claimed on the status it read, so overlapping runs (the
// daily job and a page view) make each move once, and the run that made it sends its notices.
export async function advanceSaleEvent(event: SaleEvent, now = new Date()): Promise<Outcome> {
  let current = event;
  const outcome: Outcome = { moves: 0, failed: 0, error: "" };
  for (let step = 0; step < 4; step += 1) {
    const listings = current.status === "PLANNED" ? await prisma.listing.count({ where: { saleEventId: current.id } }) : 0;
    const next = nextStatus(current, listings, now);
    if (!next) break;
    const claimed = await prisma.saleEvent.updateMany({ where: { id: current.id, status: current.status as EventStatus }, data: { status: next } });
    if (claimed.count !== 1) return outcome;
    const from = current.status;
    current = { ...current, status: next };
    outcome.moves += 1;
    const notices = await announceMove(current, from);
    outcome.failed += notices.failed;
    outcome.error ||= notices.error;
  }
  // A run that claimed the round change and then stopped leaves listings on indication terms. This finishes them.
  if (outcome.moves === 0 && current.status === "BEST_AND_FINAL") {
    const repair = await openFinalRound(current);
    outcome.failed += repair.failed;
    outcome.error ||= repair.error;
  }
  return outcome;
}

// For the daily job: every open event moves PLANNED → INDICATIONS → BEST_AND_FINAL → CLOSED on its dates. Running it
// again changes nothing. `sent` counts the moves made, in the jobs runner's tally shape. `eventIds` narrows the run,
// so a test can move its own events on a simulated clock and nobody else's.
export async function advanceSaleEvents(now = new Date(), options: { eventIds?: string[] } = {}) {
  const events = await prisma.saleEvent.findMany({ where: { status: { in: [...EVENT_OPEN] }, ...(options.eventIds ? { id: { in: options.eventIds } } : {}) } });
  const tally = { sent: 0, failed: 0, error: "" };
  for (const event of events) {
    try {
      const outcome = await advanceSaleEvent(event, now);
      tally.sent += outcome.moves;
      tally.failed += outcome.failed;
      tally.error ||= outcome.error;
    } catch (error) {
      tally.failed += 1;
      tally.error ||= `event ${event.id}: ${errorText(error)}`;
      console.error(`[upb-events] advance failed for event ${event.id}:`, errorText(error));
    }
  }
  return tally;
}

// A page about to show an event moves it first when a date has passed, so the round it prints is the round the
// listing's terms are in. Returns the event as it now stands, and whether it moved.
export async function currentSaleEvent(eventId: string, now = new Date()) {
  const event = await prisma.saleEvent.findUnique({ where: { id: eventId } });
  if (!event || !eventSetsTerms(event.status)) return { event, moved: false };
  const listings = event.status === "PLANNED" ? await prisma.listing.count({ where: { saleEventId: event.id } }) : 0;
  if (!nextStatus(event, listings, now)) return { event, moved: false };
  const outcome = await advanceSaleEvent(event, now);
  return { event: await prisma.saleEvent.findUnique({ where: { id: eventId } }), moved: outcome.moves > 0 };
}

// What the book and the events page say about open events: the next one first.
export async function openEvents() {
  const events = await prisma.saleEvent.findMany({ where: { status: { in: [...EVENT_OPEN] } } });
  return events.sort((a, b) => nextDate(a).getTime() - nextDate(b).getTime());
}
