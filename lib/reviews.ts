import { createHmac, timingSafeEqual } from "node:crypto";
import { audit } from "@/lib/audit";
import { appOrigin } from "@/lib/billing";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import { eachItem, type Tally } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";

// Reviews of a trade, asked only after it really closed. Once a closing is complete and its post-closing file is
// complete too (lib/trailing-docs.ts), the buyer and the seller are each asked once for a few lines in their own
// words. Text only, with no stars and no rating, since UPB shows factual records and never scores. A review is kept
// as a testimonial tied to its closing, unpublished. The desk publishes or declines it on the journal page and never
// edits it, and a declined review stays on file. Published, it names the side and the month the trade closed, never
// the person. Nothing is offered for one.

const DAY = 24 * 60 * 60 * 1000;
export const REVIEW_MIN = 20;
export const REVIEW_MAX = 600;
// How long the link in the request works.
export const REVIEW_LINK_DAYS = 60;
// Closings whose file completed within this many days are asked. Older ones never are, so the first run after this
// ships writes to no one about a trade from long ago.
export const REVIEW_WINDOW_DAYS = 30;

export const REVIEW_SIDES = ["BUYER", "SELLER"] as const;
export type ReviewSide = (typeof REVIEW_SIDES)[number];

// What the request and the form both say. Counsel: confirm this, the public note below and the request email meet
// the FTC's Endorsement Guides (16 CFR Part 255) and its rule on consumer reviews and testimonials (16 CFR Part 465),
// including the desk choosing which reviews to show.
export const REVIEW_TERMS =
  "The desk may publish your review on UPB with your role and the month the trade closed, never your name. Nothing is offered for a review, and you don't have to write one.";

// The line beside published reviews on the public pages.
export const REVIEWS_NOTE =
  "Reviews marked “closed on UPB” are written by the buyer or the seller of a completed closing. The desk chooses which to show and never edits them, and none was paid for.";

// ---------------------------------------------------------------------------------------------------------------
// The link

const ID = /^[\w-]{1,64}$/;

function secret() {
  return process.env.AUTH_SECRET || "";
}

function sign(payload: string, key: string) {
  return createHmac("sha256", key).update(`upb-review:${payload}`).digest("base64url");
}

// Names one closing, one side and the account asked, and the day it was issued. Null without a secret.
export function reviewToken(input: { closingId: string; side: ReviewSide; userId: string }, now = new Date()) {
  const key = secret();
  if (!key || !ID.test(input.closingId) || !ID.test(input.userId)) return null;
  const payload = `${input.closingId}.${input.side}.${input.userId}.${Math.floor(now.getTime() / DAY)}`;
  return `${payload}.${sign(payload, key)}`;
}

export type ReviewRef = { closingId: string; side: ReviewSide; userId: string; expired: boolean };

export function readReviewToken(token: string | null | undefined, now = new Date()): ReviewRef | null {
  const key = secret();
  const parts = (token ?? "").trim().split(".");
  if (!key || parts.length !== 5) return null;
  const [closingId, side, userId, issued, given] = parts;
  if (!ID.test(closingId) || !ID.test(userId) || !/^\d{1,7}$/.test(issued) || !(REVIEW_SIDES as readonly string[]).includes(side)) return null;
  const expected = Buffer.from(sign(`${closingId}.${side}.${userId}.${issued}`, key));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const expired = Math.floor(now.getTime() / DAY) - Number(issued) > REVIEW_LINK_DAYS;
  return { closingId, side: side as ReviewSide, userId, expired };
}

export function reviewLink(input: { closingId: string; side: ReviewSide; userId: string }, now = new Date(), origin = appOrigin()) {
  const token = reviewToken(input, now);
  return token ? `${origin}/review?token=${encodeURIComponent(token)}` : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Who is asked

type ClosingParties = { inquiryId: string | null; deskBidId: string | null; listing: { sellerId: string } };

// The seller of record, and the buyer whose bid won. A desk purchase has no outside buyer to ask.
async function partiesOf(closing: ClosingParties) {
  const inquiry = closing.inquiryId && !closing.deskBidId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : null;
  const ids = { SELLER: closing.listing.sellerId, BUYER: inquiry?.buyerId ?? null };
  const users = await prisma.user.findMany({ where: { id: { in: [ids.SELLER, ids.BUYER].filter((id): id is string => Boolean(id)) } }, select: { id: true, email: true, deletedAt: true } });
  return REVIEW_SIDES.flatMap((side) => {
    const user = users.find((row) => row.id === ids[side]);
    return user && !user.deletedAt ? [{ side, userId: user.id, email: user.email }] : [];
  });
}

// The daily job: each closing complete, with its post-closing file complete in the window, is claimed once on
// reviewRequestedAt and both sides hear once. `closingIds` narrows a run for tests.
export async function requestReviews(now = new Date(), options: { closingIds?: string[] } = {}): Promise<Tally> {
  // Without a secret there is no link to send, so nothing is claimed and the next run asks.
  if (!secret()) return { sent: 0, failed: 0, error: "" };
  const closings = await prisma.closing.findMany({
    where: {
      status: "COMPLETE",
      postCloseCompleteAt: { gte: new Date(now.getTime() - REVIEW_WINDOW_DAYS * DAY), lte: now },
      ...unset("reviewRequestedAt"),
      ...(options.closingIds ? { id: { in: options.closingIds } } : {}),
    },
    select: { id: true, closedAt: true, inquiryId: true, deskBidId: true, listing: { select: { title: true, sellerId: true } } },
  });
  return eachItem("review request", closings, (closing) => `closing ${closing.id}`, async (closing) => {
    const claim = await prisma.closing.updateMany({ where: { id: closing.id, status: "COMPLETE", ...unset("reviewRequestedAt") }, data: { reviewRequestedAt: now } });
    if (claim.count !== 1) return false;
    const parties = await partiesOf(closing);
    for (const party of parties) {
      const link = reviewLink({ closingId: closing.id, side: party.side, userId: party.userId }, now);
      if (!link) continue;
      await notify(
        party.email,
        `How did the trade go? · ${closing.listing.title}`,
        `${closing.listing.title} closed on ${prettyDate(closing.closedAt)} and its post-closing file is complete. If you have a minute, the desk would like a few lines in your own words on how the trade went on UPB.\n\nWrite it here: ${link}\n\nThere are no stars and no ratings, only what you write, up to ${REVIEW_MAX} characters. ${REVIEW_TERMS} The link works for ${REVIEW_LINK_DAYS} days, and this is the only time the desk asks about this trade.`,
      );
    }
    await audit(null, "REVIEW_REQUESTED", "closing", closing.id, parties.length ? parties.map((party) => party.side.toLowerCase()).join(" and ") : "No party to ask");
    return parties.length > 0;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The form

export type ReviewForm = { state: "ok"; side: ReviewSide; closedAt: Date | null } | { state: "invalid" | "expired" | "done" };

// What the form page shows for a link. A link stops taking a review once that side has written one.
export async function reviewForm(token: string | null | undefined, now = new Date()): Promise<ReviewForm> {
  const ref = readReviewToken(token, now);
  if (!ref) return { state: "invalid" };
  const party = await checkParty(ref);
  if (!party) return { state: "invalid" };
  if (await prisma.testimonial.findFirst({ where: { closingId: ref.closingId, side: ref.side }, select: { id: true } })) return { state: "done" };
  if (ref.expired) return { state: "expired" };
  return { state: "ok", side: ref.side, closedAt: party.closedAt };
}

// The link's account must still be that side of a completed closing.
async function checkParty(ref: ReviewRef) {
  const closing = await prisma.closing.findUnique({ where: { id: ref.closingId }, select: { status: true, closedAt: true, inquiryId: true, deskBidId: true, listing: { select: { sellerId: true } } } });
  if (!closing || closing.status !== "COMPLETE") return null;
  const parties = await partiesOf(closing);
  return parties.some((party) => party.side === ref.side && party.userId === ref.userId) ? closing : null;
}

export function readReviewText(raw: string) {
  return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export async function submitReview(input: { token: string; text: string }, now = new Date()): Promise<{ error: string; id?: undefined } | { error: null; id: string }> {
  const ref = readReviewToken(input.token, now);
  const party = ref ? await checkParty(ref) : null;
  if (!ref || !party) return { error: "This link doesn't work. Use the link in the email again." };
  if (await prisma.testimonial.findFirst({ where: { closingId: ref.closingId, side: ref.side }, select: { id: true } })) return { error: "The desk already has your review of this trade. Thank you." };
  if (ref.expired) return { error: "This link has expired." };
  const quote = readReviewText(input.text);
  if (quote.length < REVIEW_MIN) return { error: `Write at least ${REVIEW_MIN} characters.` };
  if (quote.length > REVIEW_MAX) return { error: `Keep it to ${REVIEW_MAX} characters.` };
  const row = await prisma.testimonial.create({
    data: { quote, role: ref.side === "BUYER" ? "Buyer" : "Seller", place: "", published: false, closingId: ref.closingId, authorId: ref.userId, side: ref.side },
  });
  await audit(ref.userId, "REVIEW_RECEIVED", "testimonial", row.id, `${ref.side.toLowerCase()} · closing ${ref.closingId}`);
  await notifyDesk("Review received", `The ${ref.side.toLowerCase()} of a completed closing wrote a review. Publish or decline it under Journal, testimonials: /admin/blog`, { capability: "content" });
  return { error: null, id: row.id };
}

// ---------------------------------------------------------------------------------------------------------------
// The desk's decision

export type ReviewState = "WAITING" | "PUBLISHED" | "DECLINED";
const DECISIONS = ["REVIEW_PUBLISHED", "REVIEW_DECLINED"];

// Where each closing review stands, from its flag and the desk's latest decision on it.
export async function reviewStates(ids: string[]) {
  const events = ids.length
    ? await prisma.auditEvent.findMany({ where: { entityType: "testimonial", entityId: { in: ids }, action: { in: DECISIONS } }, orderBy: { createdAt: "desc" }, select: { entityId: true, action: true, actorId: true, createdAt: true } })
    : [];
  const rows = ids.length ? await prisma.testimonial.findMany({ where: { id: { in: ids } }, select: { id: true, published: true } }) : [];
  return new Map(
    rows.map((row) => {
      const last = events.find((event) => event.entityId === row.id);
      const state: ReviewState = row.published ? "PUBLISHED" : last?.action === "REVIEW_DECLINED" ? "DECLINED" : "WAITING";
      return [row.id, { state, at: last?.createdAt ?? null, by: last?.actorId ?? null }];
    }),
  );
}

// Publishing or declining changes the flag only. The words stay as written, and a declined review stays on file.
export async function decideReview(actor: Staff & { id: string }, input: { id: string; publish: boolean }): Promise<{ error: string } | { error: null }> {
  if (actor.role !== "ADMIN" || !deskCan(actor, "content")) return { error: DESK_DENIED };
  const row = ID.test(input.id) ? await prisma.testimonial.findUnique({ where: { id: input.id }, select: { id: true, closingId: true, side: true } }) : null;
  if (!row?.closingId) return { error: "That review no longer exists." };
  await prisma.testimonial.update({ where: { id: row.id }, data: { published: input.publish } });
  await audit(actor.id, input.publish ? "REVIEW_PUBLISHED" : "REVIEW_DECLINED", "testimonial", row.id, `${(row.side ?? "").toLowerCase()} · closing ${row.closingId}`);
  return { error: null };
}

// ---------------------------------------------------------------------------------------------------------------
// The public display

export function monthYear(date: Date) {
  return date.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// A closing review names its side and the month the trade closed. A typed testimonial keeps its role and place.
export function testimonialByline(row: { role: string; place: string; closingId?: string | null; side?: string | null }, closedAt?: Date | null) {
  if (row.closingId && (row.side === "BUYER" || row.side === "SELLER")) {
    return `${row.side === "BUYER" ? "Buyer" : "Seller"} · closed on UPB${closedAt ? `, ${monthYear(closedAt)}` : ""}`;
  }
  return `${row.role}${row.place ? ` · ${row.place}` : ""}`;
}

// The newest published testimonials, each with its byline. Rows labeled Placeholder came from an earlier seed and
// never show.
export async function publicTestimonials(take = 2) {
  const rows = await prisma.testimonial.findMany({ where: { published: true, NOT: { role: { startsWith: "Placeholder" } } }, orderBy: { createdAt: "desc" }, take });
  const closingIds = rows.flatMap((row) => (row.closingId ? [row.closingId] : []));
  const closings = closingIds.length ? await prisma.closing.findMany({ where: { id: { in: closingIds } }, select: { id: true, closedAt: true } }) : [];
  const closedAt = new Map(closings.map((closing) => [closing.id, closing.closedAt]));
  return rows.map((row) => ({ id: row.id, quote: row.quote, review: Boolean(row.closingId), byline: testimonialByline(row, row.closingId ? closedAt.get(row.closingId) : null) }));
}
