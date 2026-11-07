import { canManageRoom, ndaOpensRoom } from "@/lib/acl";
import { draftInBackground } from "@/lib/ai-reading";
import { audit } from "@/lib/audit";
import { bidderAlias, realName } from "@/lib/bidder-alias";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { qaCutoffBlock } from "@/lib/sale-events";
import { notifyWatchers, watchLink } from "@/lib/watchers";

// Shared bidder Q&A. A buyer in the data room asks; the seller, the filing broker or the desk answers once for
// everyone. An answer goes to every bidder with room access and never says who asked. A declined question closes
// privately, with an optional note to the one who asked.

type Actor = { id: string; role: string; accountStatus: string; name: string; email: string; companyName?: string | null };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

export const QUESTION_MIN = 5;
export const QUESTION_MAX = 1000;
export const ANSWER_MAX = 4000;
export const NOTE_MAX = 600;
// The same pace as the app's other posts: enough to work a file, not enough to flood the seller.
const ASK_LIMIT = 10;
const ASK_WINDOW_MS = 60 * 60 * 1000;

function clean(text: unknown, max: number) {
  return String(text ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

// The page a seller or broker answers on.
export function ownerPath(listing: { id: string; sellerId: string; brokerId: string | null }, sellerRole: string) {
  if (listing.brokerId && listing.brokerId === listing.sellerId) return `/broker/deals/${listing.id}`;
  if (sellerRole === "BUYER") return `/buyer/resales/${listing.id}`;
  return `/seller/listings/${listing.id}`;
}

// Buyers whose NDA opens this listing's room: the ones a published answer goes to.
export async function roomBidders(listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { sellerId: true, brokerId: true } });
  if (!listing) return [];
  const ndas = await prisma.ndaAcknowledgment.findMany({
    where: { listingId },
    include: { user: { select: { id: true, email: true, role: true, accountStatus: true } } },
  });
  return ndas
    .filter((nda) => ndaOpensRoom(nda) && nda.user.role === "BUYER" && nda.user.accountStatus === "APPROVED")
    .filter((nda) => nda.userId !== listing.sellerId && nda.userId !== listing.brokerId)
    .map((nda) => nda.user);
}

export async function canAsk(user: { id: string; role: string; accountStatus: string }, listing: { id: string; status: string; sellerId: string; brokerId: string | null }) {
  if (user.role !== "BUYER" || user.accountStatus !== "APPROVED") return false;
  if (listing.status !== "APPROVED" || user.id === listing.sellerId || user.id === listing.brokerId) return false;
  const nda = await prisma.ndaAcknowledgment.findUnique({ where: { userId_listingId: { userId: user.id, listingId: listing.id } } });
  return ndaOpensRoom(nda);
}

export async function askQuestion(actor: Actor, input: { listingId: string; question: unknown; noteId?: string | null }): Promise<Outcome<{ id: string }>> {
  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    include: { seller: { select: { email: true, role: true } }, broker: { select: { email: true } } },
  });
  if (!listing) return fail("That listing isn't on the book.");
  if (listing.status !== "APPROVED") return fail("This listing isn't live, so it isn't taking questions.");
  // A sale event's Q&A cutoff closes questions on its listings, so the seller can answer before bids are due.
  const cutoff = await qaCutoffBlock(listing);
  if (cutoff) return fail(cutoff);
  if (!(await canAsk(actor, listing))) return fail("Questions open to bidders in the data room. Sign the NDA first.");
  const question = clean(input.question, QUESTION_MAX);
  if (question.length < QUESTION_MIN) return fail("Write the question in a sentence or two.");
  const noteId = input.noteId ? String(input.noteId) : null;
  if (noteId && !(await prisma.note.findFirst({ where: { id: noteId, listingId: listing.id }, select: { id: true } }))) {
    return fail("That loan isn't on this listing.");
  }
  if (!(await consumeRateLimit(`question:${actor.id}`, ASK_LIMIT, ASK_WINDOW_MS))) return fail("That is a lot of questions in an hour. Try again shortly.");
  const row = await prisma.listingQuestion.create({ data: { listingId: listing.id, askerId: actor.id, noteId, question } });
  await audit(actor.id, "QUESTION_ASK", "listing", listing.id, row.id);
  // The desk's reader drafts an answer from the room's files for the seller to check. Bidders never see a draft.
  draftInBackground(row.id);
  // The seller and broker see the bidder's letter, the desk sees who it is.
  const alias = await bidderAlias(listing.id, actor.id);
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}${ownerPath(listing, listing.seller.role)}`;
  const quoted = question.length > 300 ? `${question.slice(0, 300)}…` : question;
  const owners = new Set([listing.seller.email, ...(listing.broker?.email ? [listing.broker.email] : [])]);
  for (const email of owners) {
    await notify(email, `Bidder question · ${listing.title}`, `${alias} asked: "${quoted}" Answer it once for every bidder in the data room, or decline it. ${link}`);
  }
  await notifyDesk(`Bidder question · ${listing.title}`, `${realName(actor)} (${actor.email}) asked: "${quoted}"`);
  return { ok: true, value: { id: row.id } };
}

async function openQuestion(actor: { id: string; role: string }, questionId: string) {
  const question = await prisma.listingQuestion.findUnique({
    where: { id: questionId },
    include: { listing: { select: { id: true, title: true, sellerId: true, brokerId: true, status: true } }, asker: { select: { id: true, email: true } } },
  });
  if (!question || !canManageRoom(actor, question.listing)) return null;
  return question;
}

export async function answerQuestion(actor: { id: string; role: string }, input: { questionId: string; answer: unknown }): Promise<Outcome<{ told: number }>> {
  const question = await openQuestion(actor, input.questionId);
  if (!question) return fail("That question isn't on your listing.");
  if (question.status !== "OPEN") return fail("That question is already closed.");
  if (question.listing.status !== "APPROVED") return fail("This listing isn't live, so an answer has no bidders to go to. Decline it instead.");
  const answer = clean(input.answer, ANSWER_MAX);
  if (answer.length < 2) return fail("Write the answer.");
  // Claimed while still open, so two people answering at once publish once.
  const claimed = await prisma.listingQuestion.updateMany({
    where: { id: question.id, status: "OPEN" },
    data: { status: "ANSWERED", answer, answeredById: actor.id, answeredAt: new Date() },
  });
  if (claimed.count !== 1) return fail("That question is already closed.");
  await audit(actor.id, "QUESTION_ANSWER", "listing", question.listingId, question.id);
  const told = await publishAnswer({ listingId: question.listingId, title: question.listing.title, askerId: question.askerId, askerEmail: question.asker.email });
  return { ok: true, value: { told } };
}

// Every bidder in the room hears once. Watchers hear through their saved-listing notices, other NDA signers directly,
// and the one who asked gets their own line. Nobody outside the room is told, even if they saved the listing.
export async function publishAnswer(input: { listingId: string; title: string; askerId: string; askerEmail: string }) {
  const [bidders, watchers] = await Promise.all([
    roomBidders(input.listingId),
    prisma.favorite.findMany({ where: { listingId: input.listingId }, select: { userId: true } }),
  ]);
  const inRoom = new Set(bidders.map((bidder) => bidder.id));
  const watching = new Set(watchers.map((row) => row.userId));
  const subject = `Question answered · ${input.title}`;
  const body = `A bidder's question on ${input.title} has a published answer. Every bidder in the data room can read it on the listing.`;
  const link = watchLink(input.listingId);
  let told = 0;
  if (inRoom.has(input.askerId)) {
    await notify(input.askerEmail, subject, `Your question on ${input.title} is answered. The answer is published to every bidder in the data room, without your name. ${link}`);
    told += 1;
  }
  told += await notifyWatchers({
    listingId: input.listingId,
    event: "ANSWER",
    subject,
    body,
    except: [input.askerId, ...[...watching].filter((userId) => !inRoom.has(userId))],
  });
  for (const bidder of bidders) {
    if (bidder.id === input.askerId || watching.has(bidder.id)) continue;
    await notify(bidder.email, subject, `${body} ${link}`);
    told += 1;
  }
  return told;
}

export async function declineQuestion(actor: { id: string; role: string }, input: { questionId: string; note?: unknown }): Promise<Outcome<null>> {
  const question = await openQuestion(actor, input.questionId);
  if (!question) return fail("That question isn't on your listing.");
  if (question.status !== "OPEN") return fail("That question is already closed.");
  const note = clean(input.note, NOTE_MAX);
  const claimed = await prisma.listingQuestion.updateMany({
    where: { id: question.id, status: "OPEN" },
    data: { status: "DECLINED", answer: note, answeredById: actor.id, answeredAt: new Date() },
  });
  if (claimed.count !== 1) return fail("That question is already closed.");
  await audit(actor.id, "QUESTION_DECLINE", "listing", question.listingId, question.id);
  await notify(
    question.asker.email,
    `Your question · ${question.listing.title}`,
    `Your question on ${question.listing.title} was closed without a published answer.${note ? ` The note: ${note}` : ""} ${watchLink(question.listingId)}`,
  );
  return { ok: true, value: null };
}

// What a bidder in the room reads: the question and its answer, nothing about who asked.
export async function publishedQuestions(listingId: string) {
  return prisma.listingQuestion.findMany({
    where: { listingId, status: "ANSWERED" },
    orderBy: { answeredAt: "desc" },
    select: { id: true, noteId: true, question: true, answer: true, answeredAt: true, createdAt: true },
  });
}

export async function questionsAskedBy(listingId: string, userId: string) {
  return prisma.listingQuestion.findMany({
    where: { listingId, askerId: userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, noteId: true, question: true, answer: true, status: true, answeredAt: true, createdAt: true },
  });
}

// The seller's, broker's and desk's queue: open questions first, then what was answered or declined.
export async function questionQueue(listingId: string) {
  const rows = await prisma.listingQuestion.findMany({
    where: { listingId },
    orderBy: { createdAt: "desc" },
    include: { asker: { select: { id: true, name: true, companyName: true } } },
  });
  return [...rows.filter((row) => row.status === "OPEN"), ...rows.filter((row) => row.status !== "OPEN")];
}
