import { deskWalled } from "@/lib/auction";
import { deskCan, type Staff } from "@/lib/desk-roles";
import { prettyDate } from "@/lib/format";
import { buyerPrice } from "@/lib/offers";
import { sendAudience } from "@/lib/outreach";
import { prisma } from "@/lib/prisma";

// The desk's pipeline for one sale: every prospective bidder, how far they have come, what they did and when, and the
// next step the desk takes with each. It is for the desk only. Sellers keep the counts they see on their own page
// (lib/activity.ts sellerReport), never a bidder's level, and nothing here is shown to a bidder.

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Engagement: what a bidder did on this listing, read from what UPB already logs.
//
// The rule, as a desk member would say it to a seller:
//   "Active means that in the last 7 days the bidder bid, asked a question, or opened a file in the data room, or
//   came back to the listing on 3 different days. Looking means they did something on the listing in the last 30
//   days: opened it, signed the NDA, saved it, or one of the active things more than a week ago. Quiet means nothing
//   in the last 30 days. It is what the bidder did, counted from our logs and shown with the facts behind it. It is
//   not a grade, and it doesn't predict whether they will bid."
//
// Recent activity counts more than old: a file opened yesterday makes a bidder active, the same file opened three
// weeks ago only looking, and two months ago it counts for nothing.

export const ACTIVE_DAYS = 7;
export const LOOKING_DAYS = 30;
// Visits on this many different days in ACTIVE_DAYS count as active on their own.
export const RETURN_DAYS = 3;

export const ENGAGEMENT_LEVELS = ["Active", "Looking", "Quiet"] as const;
export type EngagementLevel = (typeof ENGAGEMENT_LEVELS)[number];

// One bidder's events on one listing. A visit is an open of the listing, logged once an hour at most
// (lib/listing-intel.ts rememberView). A file is a download from the room (the DOCUMENT_DOWNLOAD audit event).
// Questions are the room's Q&A and info requests. Bids are every bid they placed, live or not.
export type BidderEvents = {
  ndaSignedAt: Date | null;
  visits: Date[];
  files: { name: string; at: Date }[];
  questions: Date[];
  savedAt: Date | null;
  bids: Date[];
};

export type Engagement = {
  level: EngagementLevel;
  // Why the level, in one line: "Opened a file on Nov 12, 2026".
  why: string;
  // The facts behind it, for the line beside the level.
  facts: string[];
  last: { what: string; at: Date } | null;
};

const latest = (dates: Date[]) => dates.reduce<Date | null>((last, at) => (!last || at > last ? at : last), null);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// Every event, newest first, with the words for it. Strong events are the ones that count as active on their own.
function timeline(events: BidderEvents) {
  return [
    ...events.bids.map((at) => ({ at, what: "Bid", strong: true })),
    ...events.questions.map((at) => ({ at, what: "Asked a question", strong: true })),
    ...events.files.map((file) => ({ at: file.at, what: "Opened a file", strong: true })),
    ...(events.ndaSignedAt ? [{ at: events.ndaSignedAt, what: "Signed the NDA", strong: false }] : []),
    ...(events.savedAt ? [{ at: events.savedAt, what: "Saved it", strong: false }] : []),
    ...events.visits.map((at) => ({ at, what: "Opened the listing", strong: false })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
}

export function engagementOf(events: BidderEvents, now = new Date()): Engagement {
  const at = now.getTime();
  const within = (date: Date, days: number) => at - date.getTime() <= days * DAY && date.getTime() <= at;
  const all = timeline(events).filter((event) => event.at.getTime() <= at);
  const last = all[0] ? { what: all[0].what, at: all[0].at } : null;
  const strong = all.find((event) => event.strong && within(event.at, ACTIVE_DAYS));
  const returnDays = new Set(events.visits.filter((date) => within(date, ACTIVE_DAYS)).map((date) => date.toISOString().slice(0, 10))).size;
  const recent = all.find((event) => within(event.at, LOOKING_DAYS));
  let level: EngagementLevel = "Quiet";
  let why = last ? `Nothing in the last ${LOOKING_DAYS} days; last ${last.what.toLowerCase()} on ${prettyDate(last.at)}` : "Nothing on this listing yet";
  if (strong) {
    level = "Active";
    why = `${strong.what} on ${prettyDate(strong.at)}`;
  } else if (returnDays >= RETURN_DAYS) {
    level = "Active";
    why = `Opened the listing on ${returnDays} days in the last ${ACTIVE_DAYS}`;
  } else if (recent) {
    level = "Looking";
    why = `${recent.what} on ${prettyDate(recent.at)}`;
  }
  const files = new Set(events.files.map((file) => file.name)).size;
  const facts = [
    events.ndaSignedAt ? `NDA signed ${prettyDate(events.ndaSignedAt)}` : "No NDA",
    events.visits.length ? `${plural(events.visits.length, "visit")}, the last ${prettyDate(latest(events.visits))}` : "",
    files ? `${plural(files, "file")} opened, the last ${prettyDate(latest(events.files.map((file) => file.at)))}` : "",
    events.questions.length ? plural(events.questions.length, "question") : "",
    events.savedAt ? `Watching since ${prettyDate(events.savedAt)}` : "",
    events.bids.length ? `${plural(events.bids.length, "bid")}, the last ${prettyDate(latest(events.bids))}` : "",
  ].filter(Boolean);
  return { level, why, facts, last };
}

// ---------------------------------------------------------------------------------------------------------------
// Stages and next steps

export const STAGES = ["MATCHED", "SENT", "VIEWED", "NDA", "ROOM", "QUESTIONS", "BID", "AWARDED"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  MATCHED: "Matched",
  SENT: "Invited or sent",
  VIEWED: "Viewed",
  NDA: "NDA signed",
  ROOM: "In the room",
  QUESTIONS: "Asking",
  BID: "Bid",
  AWARDED: "Awarded",
};

export type PipelineFacts = {
  events: BidderEvents;
  // A buy box of theirs fits the listing, and the seller doesn't hide it from them (lib/outreach.ts sendAudience).
  matched: boolean;
  // Whether the desk may send them the listing: approved, with desk picks on.
  sendable: boolean;
  optedOut: boolean;
  sentAt: Date | null;
  invitedAt: Date | null;
  inviteOpenedAt: Date | null;
  // Their NDA's room decision: OPEN (the NDA opens the room, or the seller approved them), PENDING or DECLINED.
  room: "OPEN" | "PENDING" | "DECLINED" | null;
  openQuestions: number;
  liveBid: { inquiryId: string } | null;
  awarded: { inquiryId: string; closingId: string | null } | null;
};

// The furthest stage the facts show. Saving a listing or opening an invitation counts as having viewed it.
export function stageOf(facts: PipelineFacts): Stage {
  const { events } = facts;
  if (facts.awarded) return "AWARDED";
  if (events.bids.length) return "BID";
  if (events.questions.length) return "QUESTIONS";
  if (facts.room === "OPEN" || events.files.length) return "ROOM";
  if (events.ndaSignedAt) return "NDA";
  if (events.visits.length || events.savedAt || facts.inviteOpenedAt) return "VIEWED";
  if (facts.sentAt || facts.invitedAt) return "SENT";
  return "MATCHED";
}

export type PipelineListing = {
  id: string;
  status: string;
  bidMode: string;
  bidDeadline: Date | null;
  // An open sale event the listing trades in, whose process letter goes to bidders.
  eventId: string | null;
  // Another bidder's bid was awarded, so this one's round is over.
  awardedElsewhere: boolean;
};

export type NextStep = { key: string; text: string; href: string | null };

const step = (key: string, text: string, href: string | null = null): NextStep => ({ key, text, href });

// The desk's next step with a bidder, from rules, first match wins. Each step names something the desk can do now on
// the listing page, the offer book or the closing; "None" says why there is nothing to do.
export function nextStep(facts: PipelineFacts, listing: PipelineListing, now = new Date()): NextStep {
  const page = `/admin/listings/${listing.id}`;
  const deadline = listing.bidMode !== "NONE" ? listing.bidDeadline : null;
  const beforeDeadline = Boolean(deadline && deadline.getTime() > now.getTime());
  const roundClosed = Boolean(deadline && deadline.getTime() <= now.getTime());
  if (facts.awarded) {
    return facts.awarded.closingId ? step("CLOSING", "Run the closing", `/closings/${facts.awarded.closingId}`) : step("AWARD", "Check the award on the offer book", `/admin/offers#offer-${facts.awarded.inquiryId}`);
  }
  if (listing.status !== "APPROVED") {
    if (listing.awardedElsewhere) return step("NONE", "None: the sale went to another bidder");
    if (listing.status === "PENDING" || listing.status === "SOLD") return step("NONE", "None: the listing is off the book");
    return step("NONE", "None until the listing is live");
  }
  if (facts.openQuestions > 0) return step("ANSWER", facts.openQuestions === 1 ? "Answer their question" : `Answer their ${facts.openQuestions} questions`, `${page}#questions`);
  if (facts.room === "PENDING") return step("ROOM", "Decide their room access", `${page}#room-access`);
  if (facts.liveBid) {
    if (beforeDeadline) return step("WAIT", `None until the deadline on ${prettyDate(deadline)}`);
    return step("DECIDE", "Decide on their bid", `/admin/offers#offer-${facts.liveBid.inquiryId}`);
  }
  if (facts.room === "DECLINED") return step("NONE", "None: their room access was declined");
  if (roundClosed) return step("NONE", "None: bidding has closed");
  const stage = stageOf(facts);
  if (stage === "ROOM" || stage === "QUESTIONS" || stage === "BID") {
    return beforeDeadline ? step("REMIND", "Remind before the deadline", `${page}#send-heading`) : step("ASK_BID", "Ask whether they will bid");
  }
  if (stage === "NDA") return step("NONE", "None: their NDA is on file");
  if (stage === "VIEWED") return step("NDA", "Point them to the NDA");
  if (stage === "SENT") return step("FOLLOW_UP", "Follow up: they haven't opened it");
  if (facts.optedOut) return step("NONE", "None: they turned off desk picks");
  if (!facts.sendable) return step("NONE", "None: their account isn't approved");
  if (listing.eventId) return step("LETTER", "Send the process letter", `/admin/events/${listing.eventId}`);
  return step("SEND", "Send the listing", `${page}#send-heading`);
}

export type PipelineRow = {
  key: string;
  userId: string | null;
  name: string;
  email: string;
  stage: Stage;
  engagement: Engagement;
  // The last thing that happened with this bidder, theirs or the desk's, for the activity column.
  last: { what: string; at: Date } | null;
  next: NextStep;
  // The bidder's current price on their latest bid. Null when there is none, or when the viewer's role is behind
  // the sealed-bid wall (lib/auction.ts deskWalled), which is then sealed: true.
  bid: { amount: number | null; sealed: boolean } | null;
};

// Furthest stage first, then the most recent activity.
export function sortPipeline<T extends Pick<PipelineRow, "stage" | "last" | "name">>(rows: T[]): T[] {
  const rank = (stage: Stage) => STAGES.indexOf(stage);
  return [...rows].sort((a, b) => rank(b.stage) - rank(a.stage) || (b.last?.at.getTime() ?? 0) - (a.last?.at.getTime() ?? 0) || a.name.localeCompare(b.name));
}

// The desk's last touch, when the bidder has done nothing yet.
function deskTouch(facts: PipelineFacts) {
  const touches = [
    facts.sentAt ? { what: "Sent the listing", at: facts.sentAt } : null,
    facts.invitedAt ? { what: "Invited", at: facts.invitedAt } : null,
  ].filter((touch): touch is { what: string; at: Date } => touch != null);
  return touches.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Loading

const emptyEvents = (): BidderEvents => ({ ndaSignedAt: null, visits: [], files: [], questions: [], savedAt: null, bids: [] });

// The pipeline for a listing, for a desk member whose role runs sales. Null when the listing isn't there or the role
// doesn't cover it. Amounts follow the sealed-bid wall exactly as the bid pages do.
export async function bidderPipeline(listingId: string, viewer: Staff, now = new Date()) {
  if (!deskCan(viewer, "sales")) return null;
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, title: true, status: true, sellerId: true, brokerId: true, bidMode: true, bidDeadline: true, saleEventId: true, acceptedInquiryId: true },
  });
  if (!listing) return null;
  const [audience, sends, invites, views, ndas, favorites, questions, inquiries, downloads, event] = await Promise.all([
    sendAudience(listing.id),
    prisma.listingSend.findMany({ where: { listingId: listing.id }, select: { userId: true, createdAt: true } }),
    prisma.listingInvite.findMany({ where: { listingId: listing.id }, select: { email: true, userId: true, createdAt: true, openedAt: true, revokedAt: true } }),
    prisma.listingView.findMany({ where: { listingId: listing.id, userId: { not: null } }, select: { userId: true, createdAt: true } }),
    prisma.ndaAcknowledgment.findMany({ where: { listingId: listing.id }, select: { userId: true, acknowledgedAt: true, accessStatus: true } }),
    prisma.favorite.findMany({ where: { listingId: listing.id }, select: { userId: true, createdAt: true } }),
    prisma.listingQuestion.findMany({ where: { listingId: listing.id }, select: { askerId: true, status: true, createdAt: true } }),
    prisma.inquiry.findMany({
      where: { listingId: listing.id, type: { in: ["OFFER", "INFO_REQUEST"] } },
      select: { id: true, buyerId: true, type: true, status: true, amount: true, createdAt: true, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.auditEvent.findMany({ where: { entityType: "listing", entityId: listing.id, action: "DOCUMENT_DOWNLOAD" }, select: { actorId: true, detail: true, createdAt: true } }),
    listing.saleEventId ? prisma.saleEvent.findUnique({ where: { id: listing.saleEventId }, select: { id: true, status: true } }) : Promise.resolve(null),
  ]);
  const accepted = inquiries.filter((row) => row.type === "OFFER" && row.status === "ACCEPTED");
  const closings = accepted.length ? await prisma.closing.findMany({ where: { inquiryId: { in: accepted.map((row) => row.id) } }, select: { id: true, inquiryId: true, status: true } }) : [];
  const liveInvites = invites.filter((invite) => !invite.revokedAt);
  // An invitation to an address with no account yet is matched to one by email once it exists.
  const loose = liveInvites.filter((invite) => !invite.userId).map((invite) => invite.email.trim().toLowerCase());
  const byEmail = loose.length ? await prisma.user.findMany({ where: { email: { in: loose } }, select: { id: true, email: true } }) : [];
  const inviteUser = (invite: { email: string; userId: string | null }) => invite.userId ?? byEmail.find((user) => user.email.toLowerCase() === invite.email.trim().toLowerCase())?.id ?? null;

  const ids = new Set<string>([
    ...audience.map((row) => row.userId),
    ...sends.map((row) => row.userId),
    ...liveInvites.map(inviteUser).filter((id): id is string => Boolean(id)),
    ...views.map((row) => row.userId).filter((id): id is string => Boolean(id)),
    ...ndas.map((row) => row.userId),
    ...favorites.map((row) => row.userId),
    ...questions.map((row) => row.askerId),
    ...inquiries.map((row) => row.buyerId),
    ...downloads.map((row) => row.actorId).filter((id): id is string => Boolean(id)),
  ]);
  // The seller, the broker and the desk aren't bidders.
  ids.delete(listing.sellerId);
  if (listing.brokerId) ids.delete(listing.brokerId);
  const users = ids.size
    ? await prisma.user.findMany({
        where: { id: { in: [...ids] }, role: "BUYER" },
        select: { id: true, name: true, companyName: true, email: true, accountStatus: true, dealAlerts: true, buyerProfile: { select: { entityName: true } } },
      })
    : [];
  const walled = deskWalled(listing, viewer, now);
  const pipelineListing: PipelineListing = {
    id: listing.id,
    status: listing.status,
    bidMode: listing.bidMode,
    bidDeadline: listing.bidDeadline,
    eventId: event && ["PLANNED", "INDICATIONS", "BEST_AND_FINAL"].includes(event.status) ? event.id : null,
    awardedElsewhere: accepted.length > 0,
  };
  const rows: PipelineRow[] = users.map((user) => {
    const match = audience.find((row) => row.userId === user.id);
    const own = <T extends { createdAt: Date }>(list: T[], pick: (row: T) => string | null) => list.filter((row) => pick(row) === user.id);
    const nda = ndas.find((row) => row.userId === user.id);
    const theirInvites = liveInvites.filter((invite) => inviteUser(invite) === user.id);
    const offers = inquiries.filter((row) => row.buyerId === user.id && row.type === "OFFER");
    const asked = [...own(questions, (row) => row.askerId), ...inquiries.filter((row) => row.buyerId === user.id && row.type === "INFO_REQUEST")];
    const won = offers.find((row) => row.status === "ACCEPTED");
    const live = [...offers].reverse().find((row) => row.status === "OPEN" || row.status === "REVIEWED");
    const events: BidderEvents = {
      ndaSignedAt: nda?.acknowledgedAt ?? null,
      visits: own(views, (row) => row.userId).map((row) => row.createdAt),
      files: downloads.filter((row) => row.actorId === user.id).map((row) => ({ name: row.detail, at: row.createdAt })),
      questions: asked.map((row) => row.createdAt),
      savedAt: favorites.find((row) => row.userId === user.id)?.createdAt ?? null,
      bids: offers.map((row) => row.createdAt),
    };
    const sentAt = latest(own(sends, (row) => row.userId).map((row) => row.createdAt));
    const facts: PipelineFacts = {
      events,
      matched: Boolean(match),
      sendable: match ? match.eligible : user.accountStatus === "APPROVED" && user.dealAlerts !== false,
      optedOut: user.dealAlerts === false,
      sentAt,
      invitedAt: latest(theirInvites.map((invite) => invite.createdAt)),
      inviteOpenedAt: latest(theirInvites.map((invite) => invite.openedAt).filter((at): at is Date => Boolean(at))),
      room: nda ? (nda.accessStatus === "PENDING" ? "PENDING" : nda.accessStatus === "DECLINED" ? "DECLINED" : "OPEN") : null,
      openQuestions: asked.filter((row) => row.status === "OPEN").length,
      liveBid: live ? { inquiryId: live.id } : null,
      awarded: won ? { inquiryId: won.id, closingId: closings.find((closing) => closing.inquiryId === won.id)?.id ?? null } : null,
    };
    const engagement = engagementOf(events, now);
    const shown = won ?? live ?? offers[offers.length - 1];
    const price = shown
      ? buyerPrice(
          shown.amount != null ? Number(shown.amount) : null,
          shown.messages.map((message) => ({ kind: message.kind, amount: message.amount != null ? Number(message.amount) : null, createdAt: message.createdAt, authorId: message.authorId })),
          shown.buyerId,
        )
      : null;
    return {
      key: user.id,
      userId: user.id,
      name: user.buyerProfile?.entityName || user.companyName || user.name,
      email: user.email,
      stage: stageOf(facts),
      engagement,
      last: engagement.last ?? deskTouch(facts),
      next: nextStep(facts, pipelineListing, now),
      bid: shown ? (walled ? { amount: null, sealed: true } : { amount: price ?? null, sealed: false }) : null,
    };
  });
  // Invitations to addresses with no account yet: the desk can see who hasn't signed up.
  const known = new Set(users.map((user) => user.email.toLowerCase()));
  for (const invite of liveInvites) {
    const email = invite.email.trim().toLowerCase();
    if (inviteUser(invite) || known.has(email)) continue;
    known.add(email);
    const facts: PipelineFacts = { events: emptyEvents(), matched: false, sendable: false, optedOut: false, sentAt: null, invitedAt: invite.createdAt, inviteOpenedAt: invite.openedAt, room: null, openQuestions: 0, liveBid: null, awarded: null };
    rows.push({
      key: `invite:${email}`,
      userId: null,
      name: email,
      email,
      stage: stageOf(facts),
      engagement: { ...engagementOf(facts.events, now), why: "No account yet", facts: ["Invited, no account yet"] },
      last: deskTouch(facts),
      next: listing.status === "APPROVED" ? step("FOLLOW_UP", "Follow up: no account yet") : step("NONE", "None until the listing is live"),
      bid: null,
    });
  }
  return { listing, walled, rows: sortPipeline(rows) };
}

export type Pipeline = NonNullable<Awaited<ReturnType<typeof bidderPipeline>>>;
