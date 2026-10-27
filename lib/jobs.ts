import { retentionCutoff } from "@/lib/compliance";
import { digestBody, digestSince } from "@/lib/digest";
import { notify, notifyDesk } from "@/lib/email";
import { notifyClosedAuctions } from "@/lib/listing-intel";
import { prisma } from "@/lib/prisma";
import { bidNeedsReminder, taskNeedsReminder } from "@/lib/schedule";
import { purgeTapeDrafts } from "@/lib/tape-draft";

export async function runJobs(now = new Date()) {
  const [digests, tasks, bids, auctions, retention, drafts] = await Promise.all([
    sendDueDigests(now),
    remindTasks(now),
    remindBidDeadlines(now),
    notifyClosedAuctions().then(() => "closed auctions checked"),
    cleanRetention(now),
    purgeTapeDrafts(now),
  ]);
  const summary = `Digests ${digests}. Task reminders ${tasks}. Bid reminders ${bids}. ${auctions}. ${retention}. Abandoned tapes ${drafts}.`;
  await prisma.jobRun.create({ data: { finishedAt: new Date(), summary } });
  return { digests, tasks, bids, retention, summary };
}

export async function sendDueDigests(now = new Date()) {
  const users = await prisma.user.findMany({
    where: { role: "BUYER", accountStatus: "APPROVED", digest: { not: "OFF" } },
  });
  let sent = 0;
  for (const user of users) {
    const since = digestSince(user.digest, user.lastDigestAt, now);
    if (!since) continue;
    const matches = await prisma.listingMatch.findMany({
      where: { userId: user.id, createdAt: { gte: since }, listing: { status: "APPROVED" } },
      include: { listing: true },
      orderBy: { score: "desc" },
      take: 12,
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastDigestAt: now } });
    const body = digestBody(matches.map((match) => ({ title: match.listing.title, score: match.score })));
    if (!body) continue;
    await notify(user.email, "Buy box digest", body);
    sent += 1;
  }
  return sent;
}

async function remindTasks(now: Date) {
  const tasks = await prisma.lossTask.findMany({
    where: { doneAt: null },
    include: { case: { include: { holding: true } } },
  });
  let sent = 0;
  for (const task of tasks) {
    if (!taskNeedsReminder(task, now)) continue;
    await notifyDesk(
      `Task due · ${task.title}`,
      `${task.title} on ${task.case.holding.title} is due ${task.dueOn.toISOString().slice(0, 10)}.`,
    );
    await prisma.lossTask.update({ where: { id: task.id }, data: { remindedAt: now } });
    sent += 1;
  }
  return sent;
}

async function remindBidDeadlines(now: Date) {
  const listings = await prisma.listing.findMany({
    where: { bidMode: { not: "NONE" }, bidDeadline: { not: null }, bidReminderAt: null },
    include: { seller: true, inquiries: { where: { type: "OFFER" }, include: { buyer: true } } },
  });
  let sent = 0;
  for (const listing of listings) {
    if (!bidNeedsReminder(listing, now)) continue;
    const when = listing.bidDeadline?.toISOString().slice(0, 16) ?? "";
    const body = `Bids on ${listing.title} close at ${when} UTC.`;
    await notify(listing.seller.email, `Bid deadline · ${listing.title}`, body);
    await notifyDesk(`Bid deadline · ${listing.title}`, body);
    for (const inquiry of listing.inquiries) await notify(inquiry.buyer.email, `Bid deadline · ${listing.title}`, body);
    await prisma.listing.update({ where: { id: listing.id }, data: { bidReminderAt: now } });
    sent += 1;
  }
  return sent;
}

export async function cleanRetention(now = new Date()) {
  const settings = await prisma.platformSettings.findUnique({ where: { id: "default" } });
  const cutoff = retentionCutoff(settings?.retentionYears ?? 7, now);
  const [hits, notices] = await Promise.all([
    prisma.pageHit.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff }, readAt: { not: null } } }),
  ]);
  return `retention removed ${hits.count} visits and ${notices.count} read notices`;
}
