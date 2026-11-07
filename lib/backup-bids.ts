import { audit } from "@/lib/audit";
import { askSeller, askedPriceStands, awaitingSeller, awardOffer, checkAward, roundFeedback } from "@/lib/awards";
import { stallDaysOf } from "@/lib/backstop";
import { effectiveTarget, targetDays } from "@/lib/closing-clock";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { money, prettyDate } from "@/lib/format";
import { eachItem } from "@/lib/jobs";
import { bidExpired, buyerPrice, type OfferMoney } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

// Backup bidders. Once a bid wins an award other than a buy-it-now sale, the next two best live bids on the same
// loans are asked whether they'll stand behind it until ten days past the backstop. A bid that agrees
// stays live, good until then, instead of closing with the other losing bids, and if the winner's closing fails the
// desk awards it through the usual award path, every check included. A bid that declines, or doesn't answer within
// three days, closes as a losing bid would have. Backups end when the winner's sale closes or their date passes.

export const BACKUP_COUNT = 2;
export const ANSWER_DAYS = 3;
// Days a backup outlives the backstop, so a deal the backstop cancels still has backups for the desk to award.
export const BACKUP_GRACE_DAYS = 10;

const LIVE = ["OPEN", "REVIEWED"] as const;
const DAY = 24 * 60 * 60 * 1000;

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || "";

type Candidate = {
  id: string;
  type: string;
  status: string;
  noteId: string | null;
  buyerId: string;
  amount: number | null;
  expiresAt: Date | null;
  createdAt: Date;
  messages: OfferMoney[];
};

// The same scope as the winner: the same listing, and the same loan for a one-loan bid. Highest price first, the
// earlier bid on a tie. Group bids are the seats' money and close as before, and the winner's own other bids don't
// stand behind it.
export function pickBackups(winner: { id: string; buyerId: string; noteId: string | null }, bids: Candidate[], now = new Date(), groupBidIds: ReadonlySet<string> = new Set()) {
  return bids
    .filter((bid) => bid.id !== winner.id && bid.type === "OFFER" && (LIVE as readonly string[]).includes(bid.status) && (bid.noteId ?? null) === (winner.noteId ?? null))
    .filter((bid) => bid.buyerId !== winner.buyerId && !groupBidIds.has(bid.id) && !bidExpired(bid.expiresAt, now))
    .map((bid) => ({ bid, price: buyerPrice(bid.amount, bid.messages, bid.buyerId) ?? 0 }))
    .filter((row) => row.price > 0)
    .sort((a, b) => b.price - a.price || a.bid.createdAt.getTime() - b.bid.createdAt.getTime())
    .slice(0, BACKUP_COUNT);
}

function scopeWhere(listingId: string, noteId: string | null) {
  return { listingId, type: "OFFER" as const, ...(noteId ? { noteId } : unset("noteId")) };
}

const withMoney = { messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } } as const;

function priced(bid: { amount: number | null; buyerId: string; messages: OfferMoney[] }) {
  return buyerPrice(bid.amount, bid.messages, bid.buyerId) ?? 0;
}

// The open closing on these loans, if any: the winner a backup stands behind.
async function scopeClosing(listingId: string, noteId: string | null) {
  const open = await prisma.closing.findMany({ where: { listingId, status: "OPEN" }, orderBy: { openedAt: "desc" } });
  return open.find((closing) => (noteId ? closing.noteId === noteId : !closing.noteId && !closing.noteIds.length)) ?? null;
}

// How long a backup stands: the winner's target close plus the backstop's days, plus a grace past the backstop.
export async function backupUntilFor(closing: { openedAt: Date; targetCloseAt: Date | null }) {
  const settings = await getSettings();
  const target = effectiveTarget(closing, targetDays(settings.closingTargetDays));
  return new Date(target.getTime() + (stallDaysOf(settings.stallDays) + BACKUP_GRACE_DAYS) * DAY);
}

// The listing has gone to another buyer and is shut, so a bidder whose bid just closed is asked to destroy the room's
// files as their NDA requires, as losing bidders are by the job (lib/destruction.ts).
async function requestDestruction(listingId: string, userId: string, now: Date) {
  const { destructionRequestsDue, sendDestructionRequest } = await import("@/lib/destruction");
  const due = (await destructionRequestsDue(new Date(0), { listingIds: [listingId] })).filter((nda) => nda.userId === userId);
  for (const nda of due) await sendDestructionRequest(nda, now);
}

async function closedNotice(bid: { id: string; listingId: string; buyerId: string }, sellerId: string, reason: string, now: Date) {
  const { emitWebhook } = await import("@/lib/webhooks");
  await emitWebhook(sellerId, "offer.declined", { inquiryId: bid.id, listingId: bid.listingId, reason });
  await requestDestruction(bid.listingId, bid.buyerId, now);
}

// Called by the award, before the losing bids close. Returns the bids to keep live: those asked now, and any already
// asked or standing as backup on these loans.
export async function askBackups(
  winner: { id: string; listingId: string; noteId: string | null; buyerId: string; price: number; buyNow?: boolean; title: string; closingId: string },
  now = new Date(),
) {
  // A buy-it-now sale is the first confirmation at a price the seller fixed in advance, with no round to stand behind,
  // so every other bid closes as before.
  if (winner.buyNow) return [];
  try {
    const [bids, listing, closing] = await Promise.all([
      prisma.inquiry.findMany({ where: { ...scopeWhere(winner.listingId, winner.noteId), status: { in: [...LIVE] }, id: { not: winner.id } }, include: { buyer: { select: { email: true } }, ...withMoney } }),
      prisma.listing.findUnique({ where: { id: winner.listingId }, select: { reservePrice: true } }),
      prisma.closing.findUnique({ where: { id: winner.closingId }, select: { openedAt: true, targetCloseAt: true } }),
    ]);
    if (!bids.length || !closing) return [];
    const groups = new Set((await prisma.groupBuy.findMany({ where: { inquiryId: { in: bids.map((bid) => bid.id) } }, select: { inquiryId: true } })).map((group) => group.inquiryId ?? ""));
    const picked = pickBackups(winner, bids, now, groups);
    const until = await backupUntilFor(closing);
    const answerBy = new Date(now.getTime() + ANSWER_DAYS * DAY);
    // The round as each losing bidder hears it (lib/awards.ts declineLosingBids), so a backup gets the same feedback.
    const round = winner.price > 0 ? { winnerPrice: winner.price, reserve: listing?.reservePrice, bids: [{ id: winner.id, price: winner.price }, ...bids.map((bid) => ({ id: bid.id, price: priced(bid) }))] } : null;
    const kept: string[] = [];
    for (const { bid, price } of picked) {
      const row = bids.find((item) => item.id === bid.id)!;
      // Already asked, or already standing behind an earlier winner: it stays as it is.
      if (row.backupAskedAt) {
        kept.push(row.id);
        continue;
      }
      const claimed = await prisma.inquiry.updateMany({ where: { id: row.id, status: { in: [...LIVE] }, ...unset("backupAskedAt") }, data: { backupAskedAt: now } });
      if (claimed.count !== 1) continue;
      kept.push(row.id);
      const feedback = round ? roundFeedback(round, row.id) : null;
      await notify(
        row.buyer.email,
        `Stand as backup? · ${winner.title}`,
        `Another bid was accepted.${feedback ? ` ${feedback}` : ""} The desk asks whether your bid of ${money(price)} will stand as backup until ${prettyDate(until)}. If the winning closing doesn't complete, the desk can award your bid without a new round. If you agree, your bid stays good until then. Answer on your inquiries page by ${prettyDate(answerBy)}, or the bid closes: ${appUrl()}/buyer/offers#backup`,
      );
      await audit(null, "BACKUP_ASKED", "inquiry", row.id, `${winner.title} · ${money(price)} · until ${prettyDate(until)}`);
    }
    return kept;
  } catch (error) {
    // The award stands either way. A failure here leaves every losing bid to close as before.
    console.error("[upb-backups] asking for backups failed:", error instanceof Error ? error.message : error);
    return [];
  }
}

// The buyer agrees or declines from their inquiries page.
export async function answerBackup(input: { inquiryId: string; buyerId: string; answer: string }, now = new Date()) {
  const bid = await prisma.inquiry.findUnique({ where: { id: input.inquiryId }, include: { listing: { select: { title: true, sellerId: true } }, buyer: { select: { name: true } }, ...withMoney } });
  if (!bid || bid.buyerId !== input.buyerId) return { error: "That bid isn't yours." } as const;
  if (input.answer !== "ACCEPT" && input.answer !== "DECLINE") return { error: "Choose to stand as backup or not." } as const;
  if (!bid.backupAskedAt || !(LIVE as readonly string[]).includes(bid.status)) return { error: "Nothing on this bid is waiting for your answer." } as const;
  if (bid.backupAt || bid.backupDeclinedAt) return { error: "You already answered." } as const;
  const asked = { id: bid.id, status: { in: [...LIVE] }, backupAskedAt: bid.backupAskedAt, AND: [unset("backupAt"), unset("backupDeclinedAt")] };
  const title = bid.listing.title;
  const price = priced(bid);
  if (input.answer === "DECLINE") {
    const closed = await prisma.inquiry.updateMany({ where: asked, data: { status: "DECLINED", backupDeclinedAt: now } });
    if (closed.count !== 1) return { error: "This bid changed a moment ago. Reload the page." } as const;
    await audit(input.buyerId, "BACKUP_DECLINED", "inquiry", bid.id, `${title} · ${money(price)}`);
    await closedNotice(bid, bid.listing.sellerId, "backup_declined", now);
    return { error: null, accepted: false } as const;
  }
  if (bidExpired(bid.expiresAt, now)) return { error: "Your bid passed its good-until date, so it can't stand as backup." } as const;
  const winner = await scopeClosing(bid.listingId, bid.noteId);
  if (!winner) return { error: "The winning closing has ended, so there is nothing to stand behind. Your bid is as it was." } as const;
  const until = await backupUntilFor(winner);
  // The bid stays good until the backup ends, which the buyer has just agreed to.
  const agreed = await prisma.inquiry.updateMany({ where: asked, data: { backupAt: now, backupUntil: until, expiresAt: until } });
  if (agreed.count !== 1) return { error: "This bid changed a moment ago. Reload the page." } as const;
  await audit(input.buyerId, "BACKUP_ACCEPTED", "inquiry", bid.id, `${title} · ${money(price)} · until ${prettyDate(until)}`);
  await notifyDesk(
    `Backup bid · ${title}`,
    `${bid.buyer.name} agreed to stand as backup at ${money(price)} until ${prettyDate(until)}. If the winning closing fails, award it from that closing's page.`,
    { capability: "sales" },
  );
  return { error: null, accepted: true, until } as const;
}

type ScopeRow = Awaited<ReturnType<typeof scopeBids>>[number];

function scopeBids(listingId: string, noteId: string | null) {
  return prisma.inquiry.findMany({
    where: { ...scopeWhere(listingId, noteId), status: { in: [...LIVE] }, backupAskedAt: { not: null } },
    include: { buyer: { select: { name: true, email: true } }, listing: { select: { title: true, sellerId: true } }, ...withMoney },
    orderBy: { createdAt: "asc" },
  });
}

const standing = (row: { backupAt: Date | null; backupUntil: Date | null }, now: Date) => Boolean(row.backupAt && row.backupUntil && row.backupUntil.getTime() > now.getTime());
const waiting = (row: { backupAt: Date | null; backupDeclinedAt: Date | null }) => !row.backupAt && !row.backupDeclinedAt;

// The backups and open questions behind one closing, for its page. A part-pool closing has none.
export async function backupsFor(closing: { id: string; listingId: string; noteId: string | null; noteIds: string[] }, now = new Date()) {
  if (closing.noteIds.length) return { standing: [], waiting: [], awardedTo: null };
  const rows = await scopeBids(closing.listingId, closing.noteId);
  const open = await scopeClosing(closing.listingId, closing.noteId);
  const view = (row: ScopeRow) => ({ id: row.id, buyer: row.buyer.name, price: priced(row), until: row.backupUntil, askedAt: row.backupAskedAt });
  return {
    standing: rows.filter((row) => standing(row, now)).sort((a, b) => priced(b) - priced(a)).map(view),
    waiting: rows.filter(waiting).map(view),
    // Another closing open on these loans, such as an awarded backup's.
    awardedTo: open && open.id !== closing.id ? open.id : null,
  };
}

// The close or cancel that calls these has already landed, so a failure is logged and the deal stands.
async function guarded(what: string, run: () => Promise<number>) {
  try {
    return await run();
  } catch (error) {
    console.error(`[upb-backups] ${what} failed:`, error instanceof Error ? error.message : error);
    return 0;
  }
}

// The winner's closing was canceled. The desk hears which backups it can award. A question still waiting has nothing
// to stand behind, so it is withdrawn, and the bid is a live bid on the listing again.
export async function announceBackups(closingId: string, now = new Date()) {
  return guarded(`announcing the backups for closing ${closingId}`, () => announce(closingId, now));
}

async function announce(closingId: string, now: Date) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, include: { listing: { select: { title: true } } } });
  if (!closing || closing.noteIds.length) return 0;
  const rows = await scopeBids(closing.listingId, closing.noteId);
  const title = closing.listing.title;
  for (const row of rows.filter(waiting)) {
    const cleared = await prisma.inquiry.updateMany({ where: { id: row.id, backupAskedAt: row.backupAskedAt, ...unset("backupAt") }, data: { backupAskedAt: null } });
    if (cleared.count === 1) {
      await notify(row.buyer.email, `Backup question withdrawn · ${title}`, `The winning closing on ${title} was canceled, so the desk's question about standing as backup no longer applies. Your bid of ${money(priced(row))} is live on the listing as it was.`);
    }
  }
  const live = rows.filter((row) => standing(row, now)).sort((a, b) => priced(b) - priced(a));
  if (!live.length) return 0;
  const lines = live.map((row) => `${row.buyer.name} at ${money(priced(row))}, standing until ${prettyDate(row.backupUntil)}`).join("\n");
  await notifyDesk(
    `Backup bids live · ${title}`,
    `The closing on ${title} was canceled. ${live.length === 1 ? "One backup bid is" : `${live.length} backup bids are`} live:\n${lines}\n\nAward the backup from the canceled closing's page. The award runs every usual check, and asks the seller first if their approval doesn't cover the price: ${appUrl()}/closings/${closingId}`,
    { capability: "sales" },
  );
  return live.length;
}

// The winner's sale closed, so the backups behind it, and any question still waiting, are released.
export async function releaseBackups(closingId: string, now = new Date()) {
  return guarded(`releasing the backups for closing ${closingId}`, () => release(closingId, now));
}

async function release(closingId: string, now: Date) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, select: { listingId: true, noteId: true, noteIds: true } });
  if (!closing || closing.noteIds.length) return 0;
  let released = 0;
  for (const row of await scopeBids(closing.listingId, closing.noteId)) {
    const closed = await prisma.inquiry.updateMany({ where: { id: row.id, status: { in: [...LIVE] } }, data: { status: "DECLINED" } });
    if (closed.count !== 1) continue;
    released += 1;
    const title = row.listing.title;
    await notify(
      row.buyer.email,
      `Bid not selected · ${title}`,
      row.backupAt ? "The winning sale closed, so your backup bid is released and closed. Thank you for standing by." : "The winning sale closed, so the desk's question about standing as backup no longer applies and your bid is closed. Thank you for bidding.",
    );
    await audit(null, "BACKUP_RELEASED", "inquiry", row.id, `${title} · the winning sale closed`);
    await closedNotice(row, row.listing.sellerId, "another_bid_accepted", now);
  }
  return released;
}

// The desk awards a backup once the winner's closing has failed, through the award a desk member makes from the offer
// book: every check, and the seller asked first when their approval or reserve doesn't cover the price.
export async function awardBackup(actor: Staff & { id: string }, inquiryId: string, now = new Date()) {
  if (!deskCan(actor, "sales")) return { error: DESK_DENIED } as const;
  const bid = await prisma.inquiry.findUnique({ where: { id: inquiryId }, select: { id: true, status: true, backupAt: true, backupUntil: true } });
  if (!bid || !(LIVE as readonly string[]).includes(bid.status) || !standing(bid, now)) return { error: "That backup bid is no longer live." } as const;
  const check = await checkAward(inquiryId);
  if (check.error !== null) return { error: check.error } as const;
  if (!check.agreed) {
    const asked = awaitingSeller(check.offer) && askedPriceStands(check.offer.sellerAskedAmount, check.price);
    if (!asked) {
      await askSeller(check.offer, check.price);
      await audit(actor.id, "SELLER_ASKED", "inquiry", inquiryId, `${check.offer.listing.title} · ${money(check.price)} · backup bid`);
    }
    return { error: null, asked: true, closingId: null } as const;
  }
  // A second backup still standing stays live behind the new winner.
  const result = await awardOffer(inquiryId, actor.id, { backups: true });
  if (result.error !== null) return { error: result.error } as const;
  await audit(actor.id, "BACKUP_AWARDED", "inquiry", inquiryId, `${check.offer.listing.title} · ${money(result.price)}`);
  return { error: null, asked: false, closingId: result.closingId } as const;
}

// What the buyer's inquiries page shows: questions waiting for their answer, and bids standing as backup.
export async function backupAsksFor(buyerId: string, now = new Date()) {
  const rows = await prisma.inquiry.findMany({
    where: { buyerId, type: "OFFER", status: { in: [...LIVE] }, backupAskedAt: { not: null } },
    include: { listing: { select: { title: true } }, ...withMoney },
    orderBy: { backupAskedAt: "desc" },
  });
  const out: { id: string; title: string; listingId: string; price: number; state: "asked" | "standing"; until: Date; answerBy: Date | null }[] = [];
  for (const row of rows) {
    if (row.backupDeclinedAt) continue;
    if (row.backupAt && row.backupUntil) {
      if (row.backupUntil.getTime() > now.getTime()) out.push({ id: row.id, title: row.listing.title, listingId: row.listingId, price: priced(row), state: "standing", until: row.backupUntil, answerBy: null });
      continue;
    }
    const winner = await scopeClosing(row.listingId, row.noteId);
    if (!winner || !row.backupAskedAt) continue;
    out.push({ id: row.id, title: row.listing.title, listingId: row.listingId, price: priced(row), state: "asked", until: await backupUntilFor(winner), answerBy: new Date(row.backupAskedAt.getTime() + ANSWER_DAYS * DAY) });
  }
  return out;
}

// Backups past their date close and the bidder hears. A question left unanswered for three days closes the bid as a
// losing bid. `inquiryIds` narrows a run, so a test lapses only its own bids.
export async function lapseBackups(now = new Date(), options: { inquiryIds?: string[] } = {}) {
  const cutoff = new Date(now.getTime() - ANSWER_DAYS * DAY);
  const rows = await prisma.inquiry.findMany({
    where: {
      type: "OFFER",
      status: { in: [...LIVE] },
      OR: [{ backupUntil: { lte: now } }, { backupAskedAt: { lte: cutoff } }],
      ...(options.inquiryIds ? { id: { in: options.inquiryIds } } : {}),
    },
    include: { buyer: { select: { email: true } }, listing: { select: { title: true, sellerId: true, seller: { select: { email: true } } } } },
  });
  const due = rows.filter((row) => (row.backupAt ? Boolean(row.backupUntil && row.backupUntil <= now) : !row.backupDeclinedAt && Boolean(row.backupAskedAt && row.backupAskedAt <= cutoff)));
  return eachItem("backup lapse", due, (row) => `inquiry ${row.id}`, async (row) => {
    const title = row.listing.title;
    if (row.backupAt) {
      const claim = await prisma.inquiry.updateMany({ where: { id: row.id, status: { in: [...LIVE] }, backupUntil: { lte: now } }, data: { status: "EXPIRED" } });
      if (claim.count !== 1) return false;
      await notify(row.buyer.email, `Backup bid ended · ${title}`, `Your backup bid on ${title} ran to ${prettyDate(row.backupUntil)}, the date you agreed to stand behind the winning bid, so it is closed. Thank you for standing by.`);
      // A seller asked to approve the backup's price doesn't answer a bid that is gone (as in lib/jobs.ts expireBids).
      if (row.sellerAskedAt) {
        await notify(row.listing.seller.email, `Bid expired · ${title}`, `The bid the desk asked you to approve reached the end of its backup, so it is closed. Nothing is waiting for your answer on it.`);
      }
      await audit(null, "BACKUP_LAPSED", "inquiry", row.id, `${title} · until ${prettyDate(row.backupUntil)}`);
      await closedNotice(row, row.listing.sellerId, "backup_lapsed", now);
      return true;
    }
    const claim = await prisma.inquiry.updateMany({
      where: { id: row.id, status: { in: [...LIVE] }, backupAskedAt: row.backupAskedAt, AND: [unset("backupAt"), unset("backupDeclinedAt")] },
      data: { status: "DECLINED" },
    });
    if (claim.count !== 1) return false;
    await notify(row.buyer.email, `Bid not selected · ${title}`, `No answer came on standing as backup for ${title}, so your bid is closed. Thank you for bidding.`);
    await audit(null, "BACKUP_UNANSWERED", "inquiry", row.id, title);
    await closedNotice(row, row.listing.sellerId, "another_bid_accepted", now);
    return true;
  });
}
