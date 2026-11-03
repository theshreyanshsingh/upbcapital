import { borrowerNotices, loansInScope, saleNoticeNeedsReminder } from "@/lib/borrower-notices";
import { stepLabel } from "@/lib/closing";
import { STEP_OWNER, effectiveDue, stepClock, stepNeedsReminder, targetDays } from "@/lib/closing-clock";
import { retentionCutoff } from "@/lib/compliance";
import { digestBody, digestSince } from "@/lib/digest";
import { notify, notifyDesk } from "@/lib/email";
import { notifyClosedAuctions } from "@/lib/listing-intel";
import { prisma } from "@/lib/prisma";
import { bidNeedsReminder, taskNeedsReminder } from "@/lib/schedule";
import { purgeTapeDrafts } from "@/lib/tape-draft";
import { unset } from "@/lib/db-filters";

export async function runJobs(now = new Date()) {
  const [digests, tasks, bids, steps, notices, auctions, retention, drafts] = await Promise.all([
    sendDueDigests(now),
    remindTasks(now),
    remindBidDeadlines(now),
    remindClosingSteps(now),
    remindSaleNotices(now),
    notifyClosedAuctions().then(() => "closed auctions checked"),
    cleanRetention(now),
    purgeTapeDrafts(now),
  ]);
  const summary = `Digests ${digests}. Task reminders ${tasks}. Bid reminders ${bids}. Closing reminders ${steps}. Sale notice reminders ${notices}. ${auctions}. ${retention}. Abandoned tapes ${drafts}.`;
  await prisma.jobRun.create({ data: { finishedAt: new Date(), summary } });
  return { digests, tasks, bids, steps, notices, retention, summary };
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
    where: unset("doneAt"),
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
    where: { bidMode: { not: "NONE" }, bidDeadline: { not: null }, ...unset("bidReminderAt") },
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

// One message per closing and party, listing every step that is late or due within two days.
export async function remindClosingSteps(now = new Date()) {
  const settings = await prisma.platformSettings.findUnique({ where: { id: "default" } });
  const days = targetDays(settings?.closingTargetDays);
  const closings = await prisma.closing.findMany({
    where: { status: "OPEN" },
    include: { steps: true, listing: { include: { seller: true } }, funders: { include: { user: true } } },
  });
  let sent = 0;
  for (const closing of closings) {
    const due = closing.steps
      .map((step) => ({ step, at: effectiveDue(step, closing, days) }))
      .filter(({ step, at }) => stepNeedsReminder(step, at, now));
    if (!due.length) continue;
    const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true } }) : null;
    const buyers = closing.funders.length ? closing.funders.map((funder) => funder.user.email) : inquiry ? [inquiry.buyer.email] : [];
    const line = ({ step, at }: (typeof due)[number]) =>
      `${stepLabel(step.key)}: ${stepClock(step.status, at, now) === "overdue" ? "late, was due" : "due"} ${at?.toISOString().slice(0, 10) ?? ""}`;
    const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closing.id}`;
    const subject = `Closing dates · ${closing.listing.title}`;
    const forParty = (party: "buyer" | "seller") => due.filter(({ step }) => STEP_OWNER[step.key] === party || STEP_OWNER[step.key] === "both");
    const sellerSteps = forParty("seller");
    if (sellerSteps.length) await notify(closing.listing.seller.email, subject, `${sellerSteps.map(line).join("\n")}\n\nThe checklist: ${link}`);
    const buyerSteps = forParty("buyer");
    if (buyerSteps.length) for (const email of buyers) await notify(email, subject, `${buyerSteps.map(line).join("\n")}\n\nThe checklist: ${link}`);
    await notifyDesk(subject, `${due.map(line).join("\n")}\n\n${link}`);
    await prisma.closingStep.updateMany({ where: { id: { in: due.map(({ step }) => step.id) } }, data: { remindedAt: now } });
    sent += 1;
  }
  return sent;
}

// The new owner's sale notice to the borrower, due 30 days after transfer. One reminder five days out and one
// once it's late, to the buyer side, or to the desk when the desk bought it. UPB never writes to the borrower.
export async function remindSaleNotices(now = new Date()) {
  const closings = await prisma.closing.findMany({
    where: { status: "COMPLETE", ...unset("ownerNoticeSentAt"), closedAt: { gte: new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000) } },
    include: { listing: { include: { notes: true } }, boarding: true, funders: { include: { user: true } } },
  });
  let sent = 0;
  for (const closing of closings) {
    const notes = closing.noteId ? closing.listing.notes.filter((note) => note.id === closing.noteId) : closing.listing.notes;
    const plan = borrowerNotices(closing, closing.boarding, loansInScope(notes, closing.loanPurpose).length, now);
    if (plan.sale.state === "not_needed" || !saleNoticeNeedsReminder(plan.sale.due, closing.ownerNoticeSentAt, closing.ownerNoticeRemindedAt, now)) continue;
    const due = plan.sale.due!.toISOString().slice(0, 10);
    const late = plan.sale.state === "late";
    const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closing.id}`;
    const subject = `Sale notice ${late ? "late" : "due"} · ${closing.listing.title}`;
    const body = `The new owner's notice of sale to the borrower ${late ? "was due" : "is due"} ${due}, 30 days after the transfer (12 CFR 1026.39). Send it, then record the date in the closing room. A draft is there too: ${link}

UPB doesn't send borrower notices. This is a reminder, not legal advice.`;
    if (closing.deskBidId) await notifyDesk(subject, body);
    else {
      const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true } }) : null;
      const buyers = closing.funders.length ? closing.funders.map((funder) => funder.user.email) : inquiry ? [inquiry.buyer.email] : [];
      for (const email of buyers) await notify(email, subject, body);
    }
    await prisma.closing.update({ where: { id: closing.id }, data: { ownerNoticeRemindedAt: now } });
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
