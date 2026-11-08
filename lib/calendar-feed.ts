import { createHash, randomBytes } from "node:crypto";
import { accountLocked } from "@/lib/access";
import { audit } from "@/lib/audit";
import { awaitingSeller, sellerPage } from "@/lib/awards";
import { prisma } from "@/lib/prisma";
import { canSee, listingAccess } from "@/lib/private-listings";
import { resolveSessionUser } from "@/lib/seats";
import { milestones, when } from "@/lib/sale-events";
import { kindLabel, LIVE_STATUSES, readSigners } from "@/lib/signatures";

// A private calendar feed: one secret link per account that Google, Apple or Outlook subscribes to, carrying the
// dates the account has to act by. Bid deadlines on listings it saved, bid on or sells; the dates of sale events
// those listings are in; the dates of its open closings and the papers it has to sign; and the answers a seller owes
// the desk. Titles and dates only: no amount, no other bidder, no borrower. Only the hash of the link is kept.

const DAY = 24 * 60 * 60 * 1000;
// Calendars keep their own history, so the feed carries a month back and everything ahead.
const PAST_DAYS = 30;
const MAX_EVENTS = 500;

// ---------------------------------------------------------------------------------------------------------------
// The iCalendar text, shared with the sale event file in lib/process-letter.ts.

// TEXT values escape backslash, semicolon, comma and newlines (RFC 5545 3.3.11). Other control characters aren't
// allowed in a value at all, so they go.
export function icsText(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, "");
}

export function icsTime(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Lines over 75 octets fold onto a continuation line that starts with a space, as RFC 5545 asks.
export function fold(line: string) {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (octets + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

export type IcsEvent = { uid: string; start: Date; summary: string; description: string; url?: string; canceled?: boolean };

// A whole calendar. Each entry is half an hour from its deadline, so it shows as a block rather than a pin.
export function icsCalendar(input: { name: string; events: IcsEvent[]; now?: Date }) {
  const stamp = icsTime(input.now ?? new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UPB Capital//Deadlines//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(input.name)}`,
    // How often a subscribed calendar should look again. Clients treat it as a hint.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const event of input.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(event.start)}`,
      `DTEND:${icsTime(new Date(event.start.getTime() + 30 * 60 * 1000))}`,
      `SUMMARY:${icsText(event.summary)}`,
      `DESCRIPTION:${icsText(event.description)}`,
      ...(event.url ? [`URL:${event.url}`] : []),
      ...(event.canceled ? ["STATUS:CANCELLED"] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// The link. Making a new one replaces the hash, so the old link stops working at once.

export function calendarTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function calendarFeedUrl(token: string, appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  return `${appUrl.replace(/\/$/, "")}/api/calendar/${token}.ics`;
}

export async function issueCalendarFeed(userId: string) {
  const token = randomBytes(32).toString("hex");
  const before = await prisma.user.findUnique({ where: { id: userId }, select: { calendarTokenHash: true } });
  await prisma.user.update({ where: { id: userId }, data: { calendarTokenHash: calendarTokenHash(token) } });
  await audit(userId, before?.calendarTokenHash ? "CALENDAR_FEED_ROTATED" : "CALENDAR_FEED_ON", "user", userId);
  return token;
}

export async function endCalendarFeed(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { calendarTokenHash: null } });
  await audit(userId, "CALENDAR_FEED_OFF", "user", userId);
}

// The account a link reads for, or null. A link belongs to the person who made it, and a firm's seat reads its
// firm's dates, as it does signed in; a seat removed since, or a locked account, reads nothing. Calendar apps may add
// ".ics", so it is allowed on the end.
export async function userForCalendarToken(raw: string) {
  const token = raw.replace(/\.ics$/i, "");
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const person = await prisma.user.findUnique({ where: { calendarTokenHash: calendarTokenHash(token) }, select: { id: true, accountStatus: true, deletedAt: true } });
  if (!person || accountLocked(person.accountStatus) || person.deletedAt) return null;
  return (await resolveSessionUser(person.id))?.user ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// What goes in one account's feed.

type FeedUser = { id: string; role: string; email: string };
type FeedListing = { id: string; title: string; status: string; sellerId: string; brokerId: string | null; visibility: string | null; bidDeadline: Date | null; saleEventId: string | null };

const LISTING_FIELDS = { id: true, title: true, status: true, sellerId: true, brokerId: true, visibility: true, bidDeadline: true, saleEventId: true } as const;
const LIVE_BIDS = ["OPEN", "REVIEWED"] as const;
const ON_BOOK = ["APPROVED", "PENDING"];

export async function feedEvents(user: FeedUser, options: { now?: Date; appUrl?: string } = {}): Promise<IcsEvent[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - PAST_DAYS * DAY);
  const base = (options.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const link = (path: string) => (base ? `${base}${path}` : undefined);
  const told = (text: string, path: string) => (base ? `${text} ${base}${path}` : text);
  const events: IcsEvent[] = [];

  const [access, saved, bids, own] = await Promise.all([
    listingAccess(user),
    prisma.favorite.findMany({ where: { userId: user.id }, select: { listingId: true } }),
    prisma.inquiry.findMany({ where: { buyerId: user.id, type: "OFFER", status: { in: [...LIVE_BIDS] } }, select: { listingId: true } }),
    prisma.listing.findMany({ where: { OR: [{ sellerId: user.id }, { brokerId: user.id }] }, select: LISTING_FIELDS }),
  ]);
  const ownIds = new Set(own.map((listing) => listing.id));
  const followIds = [...new Set([...saved, ...bids].map((row) => row.listingId))].filter((id) => !ownIds.has(id));
  // A listing that went private since it was saved drops out for anyone not invited (lib/private-listings.ts).
  const followed = (followIds.length ? await prisma.listing.findMany({ where: { id: { in: followIds } }, select: LISTING_FIELDS }) : []).filter((listing) => canSee(access, listing));

  const ownPage = (listing: FeedListing) => (listing.brokerId === user.id && listing.sellerId !== user.id ? `/broker/deals/${listing.id}` : sellerPage(listing, user.role));
  const deadline = (listing: FeedListing, path: string) => {
    if (listing.status !== "APPROVED" || !listing.bidDeadline || listing.bidDeadline < since) return;
    events.push({
      uid: `listing-${listing.id}-bids@upbcapital`,
      start: listing.bidDeadline,
      summary: `Bids due: ${listing.title}`,
      description: told(`Bids on ${listing.title} close ${when(listing.bidDeadline)}.`, path),
      url: link(path),
    });
  };
  for (const listing of followed) deadline(listing, `/marketplace/${listing.id}`);
  for (const listing of own) deadline(listing, ownPage(listing));

  // Sale events the account takes part in through a listing it sells, saved or bid on. The same UIDs as the event's
  // own calendar file, so a calendar that has both shows each date once.
  // Only listings still on the book: a withdrawn or sold one no longer ties the account to its event.
  const eventIds = [...new Set([...own, ...followed].filter((listing) => ON_BOOK.includes(listing.status)).map((listing) => listing.saleEventId).filter((id): id is string => Boolean(id)))];
  const saleEvents = eventIds.length ? await prisma.saleEvent.findMany({ where: { id: { in: eventIds } } }) : [];
  for (const event of saleEvents) {
    for (const milestone of milestones(event)) {
      if (milestone.at < since) continue;
      events.push({
        uid: `${event.id}-${milestone.key}@upbcapital`,
        start: milestone.at,
        summary: `${milestone.label}: ${event.name}`,
        description: told(`${milestone.label} in the UPB Capital sale event ${event.name}, at ${when(milestone.at)}.`, `/events#${event.id}`),
        url: link(`/events#${event.id}`),
        canceled: event.status === "CANCELED",
      });
    }
  }

  // Open closings the account is a party to: as the winning buyer, a group buyer or the seller.
  const won = await prisma.inquiry.findMany({ where: { buyerId: user.id, status: "ACCEPTED" }, select: { id: true } });
  const closings = await prisma.closing.findMany({
    where: {
      status: "OPEN",
      OR: [{ listing: { sellerId: user.id } }, { funders: { some: { userId: user.id } } }, ...(won.length ? [{ inquiryId: { in: won.map((row) => row.id) } }] : [])],
    },
    select: {
      id: true,
      targetCloseAt: true,
      depositDueAt: true,
      depositReceivedAt: true,
      diligenceEndsAt: true,
      listing: { select: { title: true } },
      signatures: { where: { status: { in: LIVE_STATUSES }, dueAt: { not: null } }, select: { id: true, kind: true, dueAt: true, signers: true } },
    },
  });
  for (const closing of closings) {
    const title = closing.listing.title;
    const path = `/closings/${closing.id}`;
    const add = (key: string, at: Date | null, label: string, text: string) => {
      if (!at || at < since) return;
      events.push({ uid: `closing-${closing.id}-${key}@upbcapital`, start: at, summary: `${label}: ${title}`, description: told(`${text} ${when(at)}.`, path), url: link(path) });
    };
    add("target", closing.targetCloseAt, "Target close", `The closing of ${title} aims to finish by`);
    if (!closing.depositReceivedAt) add("deposit", closing.depositDueAt, "Deposit due", `The buyer's deposit on ${title} is due by`);
    add("diligence", closing.diligenceEndsAt, "Diligence ends", `The buyer's diligence window on ${title} ends`);
    for (const request of closing.signatures) {
      // Only papers this account still has to sign.
      const mine = readSigners(request.signers).some((signer) => (signer.userId ? signer.userId === user.id : signer.email.toLowerCase() === user.email.toLowerCase()) && !signer.signedAt && !signer.declinedAt);
      if (!mine || !request.dueAt || request.dueAt < since) continue;
      const form = kindLabel(request.kind);
      events.push({
        uid: `signature-${request.id}@upbcapital`,
        start: request.dueAt,
        summary: `Sign the ${form.toLowerCase()}: ${title}`,
        description: told(`The ${form.toLowerCase()} for ${title} needs your signature by ${when(request.dueAt)}.`, path),
        url: link(path),
      });
    }
  }

  // The desk's asks a seller owes an answer on. The bid itself, its amount and its bidder stay off the calendar.
  const asks = await prisma.inquiry.findMany({
    where: { type: "OFFER", status: { in: [...LIVE_BIDS] }, sellerRespondBy: { gte: since }, listing: { sellerId: user.id } },
    select: { id: true, sellerAskedAt: true, sellerAnsweredAt: true, sellerRespondBy: true, listing: { select: { id: true, title: true, sellerId: true, brokerId: true } } },
  });
  for (const ask of asks) {
    if (!ask.sellerRespondBy || !awaitingSeller(ask)) continue;
    const path = sellerPage(ask.listing, user.role);
    events.push({
      uid: `inquiry-${ask.id}-answer@upbcapital`,
      start: ask.sellerRespondBy,
      summary: `Answer the desk on a bid: ${ask.listing.title}`,
      description: told(`The desk asked you to approve, decline or counter a bid on ${ask.listing.title}. Please answer by ${when(ask.sellerRespondBy)}.`, path),
      url: link(path),
    });
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, MAX_EVENTS);
}

export async function calendarFeed(user: FeedUser, options: { now?: Date; appUrl?: string } = {}) {
  return icsCalendar({ name: "UPB Capital deadlines", events: await feedEvents(user, options), now: options.now });
}
