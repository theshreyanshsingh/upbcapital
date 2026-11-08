import { appOrigin } from "@/lib/billing";
import { notify } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { audienceOf } from "@/lib/private-listings";

const DAY = 24 * 60 * 60 * 1000;
export const MAX_RECIPIENTS = 200;
// A buyer gets the same listing again only after this long, and a deadline notice once a day at most.
export const RESEND_AFTER: Record<SendKind, number> = { LISTING: 7 * DAY, DEADLINE: DAY };

export type SendKind = "LISTING" | "DEADLINE";

export function recentlySent(sends: { userId: string; kind: string; createdAt: Date }[], userId: string, kind: SendKind, now = new Date()) {
  return sends.some((send) => send.userId === userId && send.kind === kind && now.getTime() - send.createdAt.getTime() < RESEND_AFTER[kind]);
}

// The email carries what the book already shows an approved buyer, and never an address or a borrower name.
export function sendBody(input: {
  kind: SendKind;
  title: string;
  loans: number;
  states: string[];
  bidMode: string;
  deadline: Date | null;
  note: string;
  link: string;
}) {
  const where = input.states.length ? ` in ${input.states.slice(0, 6).join(", ")}${input.states.length > 6 ? " and more" : ""}` : "";
  const lines = [
    input.kind === "DEADLINE" && input.deadline
      ? `Bids on ${input.title} close ${input.deadline.toISOString().slice(0, 16).replace("T", " ")} UTC${input.bidMode === "BEST_AND_FINAL" ? ", one best-and-final bid each" : input.bidMode === "SEALED" ? ", sealed" : ""}.`
      : `The desk picked ${input.title} for your buy box.`,
    `${input.loans} loan${input.loans === 1 ? "" : "s"}${where}.`,
    input.note ? `From the desk: ${input.note}` : "",
    `Open it on the book: ${input.link}`,
    "You get these because a buy box of yours matches. Turn off desk picks under Notice settings.",
  ];
  return lines.filter(Boolean).join("\n\n");
}

// Approved buyers whose buy box matches, best score first, with when the desk last sent them this listing.
export async function sendAudience(listingId: string) {
  const [matchRows, sends, views, offers] = await Promise.all([
    prisma.listingMatch.findMany({ where: { listingId }, orderBy: { score: "desc" } }),
    prisma.listingSend.findMany({ where: { listingId }, orderBy: { createdAt: "desc" } }),
    prisma.listingView.findMany({ where: { listingId, userId: { not: null } }, select: { userId: true } }),
    prisma.inquiry.findMany({ where: { listingId }, select: { buyerId: true, type: true } }),
  ]);
  // Boxes are read apart from their matches: deleting a box removes its matches a moment later on MongoDB, and a
  // required include on a match whose box is gone fails the whole read.
  const boxes = matchRows.length
    ? await prisma.buyBox.findMany({
        where: { id: { in: [...new Set(matchRows.map((row) => row.buyBoxId))] } },
        select: { id: true, name: true, user: { select: { id: true, name: true, companyName: true, email: true, role: true, accountStatus: true, dealAlerts: true } } },
      })
    : [];
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const fitting = matchRows.flatMap((row) => {
    const buyBox = boxById.get(row.buyBoxId);
    return buyBox ? [{ ...row, buyBox }] : [];
  });
  // A private listing goes to its invitees only, and never to a buyer its seller excludes (lib/private-listings.ts).
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, brokerId: true, visibility: true } });
  const shown = listing ? new Set((await audienceOf(listing, fitting.map((match) => match.buyBox.user))).map((user) => user.id)) : new Set<string>();
  const matches = fitting.filter((match) => shown.has(match.buyBox.user.id));
  const seen = new Set<string>();
  const viewed = new Set(views.map((view) => view.userId));
  const offered = new Set(offers.filter((inquiry) => inquiry.type === "OFFER").map((inquiry) => inquiry.buyerId));
  const rows = [];
  for (const match of matches) {
    const user = match.buyBox.user;
    if (seen.has(user.id) || user.role !== "BUYER") continue;
    seen.add(user.id);
    const lastSent = sends.find((send) => send.userId === user.id && send.kind === "LISTING")?.createdAt ?? null;
    rows.push({
      userId: user.id,
      name: user.companyName || user.name,
      box: match.buyBox.name,
      score: match.score,
      eligible: user.accountStatus === "APPROVED" && user.dealAlerts !== false,
      optedOut: user.dealAlerts === false,
      approved: user.accountStatus === "APPROVED",
      lastSent,
      viewed: viewed.has(user.id),
      offered: offered.has(user.id),
    });
  }
  return rows;
}

export async function sendListing(input: { listingId: string; userIds: string[]; kind: SendKind; note: string; actorId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, include: { notes: { select: { state: true } } } });
  if (!listing) return { sent: 0, skipped: 0, problem: "That listing is not on file." };
  if (listing.status !== "APPROVED") return { sent: 0, skipped: 0, problem: "Only a live listing can go to buyers." };
  if (input.kind === "DEADLINE" && (listing.bidMode === "NONE" || !listing.bidDeadline || listing.bidDeadline.getTime() <= now.getTime())) {
    return { sent: 0, skipped: 0, problem: "Set a future bid deadline before announcing it." };
  }
  const audience = await sendAudience(listing.id);
  const allowed = new Map(audience.filter((row) => row.eligible).map((row) => [row.userId, row]));
  const wanted = [...new Set(input.userIds)].filter((id) => allowed.has(id)).slice(0, MAX_RECIPIENTS);
  const sends = await prisma.listingSend.findMany({ where: { listingId: listing.id, userId: { in: wanted } } });
  const fresh = wanted.filter((id) => !recentlySent(sends, id, input.kind, now));
  const users = await prisma.user.findMany({ where: { id: { in: fresh } }, select: { id: true, email: true } });
  const body = sendBody({
    kind: input.kind,
    title: listing.title,
    loans: listing.notes.length,
    states: [...new Set(listing.notes.map((note) => note.state))].sort(),
    bidMode: listing.bidMode,
    deadline: listing.bidDeadline,
    note: input.note.trim().slice(0, 400),
    link: `${appOrigin()}/marketplace/${listing.id}`,
  });
  const subject = input.kind === "DEADLINE" ? `Bid deadline · ${listing.title}` : `Desk pick · ${listing.title}`;
  for (const user of users) {
    await notify(user.email, subject, body, { category: "deals", userId: user.id });
    await prisma.listingSend.create({ data: { listingId: listing.id, userId: user.id, sentById: input.actorId, kind: input.kind, createdAt: now } });
  }
  return { sent: users.length, skipped: input.userIds.length - users.length, problem: "" };
}

// What buyers did after the desk first sent them this listing.
export function sendFunnel(
  sends: { userId: string; createdAt: Date }[],
  views: { userId: string | null; createdAt: Date }[],
  offers: { buyerId: string; createdAt: Date }[],
) {
  const first = new Map<string, Date>();
  for (const send of sends) {
    const prior = first.get(send.userId);
    if (!prior || send.createdAt < prior) first.set(send.userId, send.createdAt);
  }
  const after = (userId: string | null, at: Date) => {
    const sentAt = userId ? first.get(userId) : undefined;
    return Boolean(sentAt && at >= sentAt);
  };
  return {
    reached: first.size,
    viewed: new Set(views.filter((view) => after(view.userId, view.createdAt)).map((view) => view.userId)).size,
    offered: new Set(offers.filter((offer) => after(offer.buyerId, offer.createdAt)).map((offer) => offer.buyerId)).size,
  };
}
