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

// What a sending job did: how many went out, and how many items failed, with the first reason.
export type Tally = { sent: number; failed: number; error: string };

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
}

// One bad item is logged and counted, and the job goes on to the next. A claimed item that then fails waits for its
// next turn rather than risk a second send.
export async function eachItem<T>(job: string, items: T[], name: (item: T) => string, send: (item: T) => Promise<boolean>): Promise<Tally> {
  const tally: Tally = { sent: 0, failed: 0, error: "" };
  for (const item of items) {
    try {
      if (await send(item)) tally.sent += 1;
    } catch (error) {
      tally.failed += 1;
      tally.error ||= `${name(item)}: ${errorText(error)}`;
      console.error(`[upb-jobs] ${job} failed for ${name(item)}:`, errorText(error));
    }
  }
  return tally;
}

// A marker still at the value this run read. Each item is claimed with it before anything is sent, so an overlapping
// run (a second cron delivery, or the desk's digest button) finds the item taken and sends nothing.
function still<K extends string>(field: K, seen: Date | null) {
  return seen ? ({ [field]: seen } as Record<K, Date>) : unset(field);
}

type JobResult = { job: string; ok: boolean; line: string };

function describe(job: string, outcome: PromiseSettledResult<Tally | string>): JobResult {
  if (outcome.status === "rejected") return { job, ok: false, line: `${job} failed: ${errorText(outcome.reason)}.` };
  const value = outcome.value;
  if (typeof value === "string") return { job, ok: true, line: `${value.charAt(0).toUpperCase()}${value.slice(1)}.` };
  const ok = value.failed === 0;
  return { job, ok, line: `${job} ${value.sent}${ok ? "" : `, ${value.failed} failed (${value.error})`}.` };
}

export type Job = [name: string, run: () => Promise<Tally | string>];

export async function runJobs(now = new Date()) {
  return runJobList([
    ["Digests", () => sendDueDigests(now)],
    ["Task reminders", () => remindTasks(now)],
    ["Bid reminders", () => remindBidDeadlines(now)],
    ["Bid expiry", () => expireBids(now)],
    ["Closing reminders", () => remindClosingSteps(now)],
    ["Sale notice reminders", () => remindSaleNotices(now)],
    ["Closed auctions", () => notifyClosedAuctions().then(() => "closed auctions checked")],
    ["Retention", () => cleanRetention(now)],
    ["Abandoned tapes", () => purgeTapeDrafts(now).then((count) => `abandoned tapes ${count}`)],
  ]);
}

// Each job settles on its own, so one failure neither stops the others nor loses the run record.
export async function runJobList(jobs: Job[]) {
  const startedAt = new Date();
  const settled = await Promise.allSettled(jobs.map(([, run]) => Promise.resolve().then(run)));
  const results = settled.map((outcome, index) => describe(jobs[index][0], outcome));
  const failed = results.filter((result) => !result.ok).map((result) => result.job);
  const summary = results.map((result) => result.line).join(" ");
  try {
    await prisma.jobRun.create({ data: { startedAt, finishedAt: new Date(), summary } });
  } catch (error) {
    console.error("[upb-jobs] the run record was not saved:", errorText(error), summary);
  }
  return { startedAt, summary, failed, results };
}

export async function sendDueDigests(now = new Date()) {
  const users = await prisma.user.findMany({
    where: { role: "BUYER", accountStatus: "APPROVED", digest: { not: "OFF" } },
    select: { id: true, email: true, digest: true, lastDigestAt: true },
  });
  return eachItem("digest", users, (user) => `user ${user.id}`, (user) => sendDigest(user, now));
}

export async function sendDigest(user: { id: string; email: string; digest: string; lastDigestAt: Date | null }, now = new Date()) {
  const since = digestSince(user.digest, user.lastDigestAt, now);
  if (!since) return false;
  const claim = await prisma.user.updateMany({ where: { id: user.id, ...still("lastDigestAt", user.lastDigestAt) }, data: { lastDigestAt: now } });
  if (claim.count !== 1) return false;
  // Up to this run's start; anything newer opens the next window.
  const matches = await prisma.listingMatch.findMany({
    where: { userId: user.id, createdAt: { gte: since, lt: now }, listing: { status: "APPROVED" } },
    include: { listing: true },
    orderBy: { score: "desc" },
    take: 12,
  });
  const body = digestBody(matches.map((match) => ({ title: match.listing.title, score: match.score })));
  if (!body) return false;
  await notify(user.email, "Buy box digest", body);
  return true;
}

async function remindTasks(now: Date) {
  const tasks = await prisma.lossTask.findMany({
    where: unset("doneAt"),
    include: { case: { include: { holding: true } } },
  });
  return eachItem("task reminder", tasks, (task) => `task ${task.id}`, async (task) => {
    if (!taskNeedsReminder(task, now)) return false;
    const claim = await prisma.lossTask.updateMany({
      where: { id: task.id, AND: [still("remindedAt", task.remindedAt), unset("doneAt")] },
      data: { remindedAt: now },
    });
    if (claim.count !== 1) return false;
    await notifyDesk(
      `Task due · ${task.title}`,
      `${task.title} on ${task.case.holding.title} is due ${task.dueOn.toISOString().slice(0, 10)}.`,
    );
    return true;
  });
}

async function remindBidDeadlines(now: Date) {
  const listings = await prisma.listing.findMany({
    where: { bidMode: { not: "NONE" }, bidDeadline: { not: null }, ...unset("bidReminderAt") },
    include: { seller: true, inquiries: { where: { type: "OFFER" }, include: { buyer: true } } },
  });
  return eachItem("bid reminder", listings, (listing) => `listing ${listing.id}`, async (listing) => {
    if (!bidNeedsReminder(listing, now)) return false;
    const claim = await prisma.listing.updateMany({ where: { id: listing.id, ...unset("bidReminderAt") }, data: { bidReminderAt: now } });
    if (claim.count !== 1) return false;
    const when = listing.bidDeadline?.toISOString().slice(0, 16) ?? "";
    const subject = `Bid deadline · ${listing.title}`;
    const body = `Bids on ${listing.title} close at ${when} UTC.`;
    await notify(listing.seller.email, subject, body);
    await notifyDesk(subject, body);
    // A buyer with several offers on the listing hears once.
    for (const email of new Set(listing.inquiries.map((inquiry) => inquiry.buyer.email))) await notify(email, subject, body);
    return true;
  });
}

// A bid past its good-until date closes. Each is claimed with a conditional write, so an award or a withdrawal that
// lands first wins, and an overlapping run tells nobody twice. The buyer hears, and so does a seller who was asked
// to approve it, so they don't answer a bid that is gone.
export async function expireBids(now = new Date()) {
  const bids = await prisma.inquiry.findMany({
    where: { type: "OFFER", status: { in: ["OPEN", "REVIEWED"] }, expiresAt: { lte: now } },
    include: { buyer: true, listing: { include: { seller: true } } },
  });
  return eachItem("bid expiry", bids, (bid) => `inquiry ${bid.id}`, async (bid) => {
    const claim = await prisma.inquiry.updateMany({
      where: { id: bid.id, status: { in: ["OPEN", "REVIEWED"] }, expiresAt: { lte: now } },
      data: { status: "EXPIRED" },
    });
    if (claim.count !== 1) return false;
    const day = bid.expiresAt?.toISOString().slice(0, 10) ?? "";
    const title = bid.listing.title;
    await notify(bid.buyer.email, `Bid expired · ${title}`, `Your bid on ${title} reached its good-until date of ${day}, so it is closed. You can send a new one while the listing is live.`);
    if (bid.sellerAskedAt) {
      await notify(bid.listing.seller.email, `Bid expired · ${title}`, `The bid the desk asked you to approve reached the buyer's good-until date, so it is closed. Nothing is waiting for your answer on it.`);
    }
    await notifyDesk(`Bid expired · ${title}`, `${bid.buyer.name}'s bid reached its good-until date of ${day} and is closed.`);
    return true;
  });
}

// One message per closing and party, listing every step that is late or due within two days.
export async function remindClosingSteps(now = new Date()) {
  const settings = await prisma.platformSettings.findUnique({ where: { id: "default" } });
  const days = targetDays(settings?.closingTargetDays);
  const closings = await prisma.closing.findMany({
    where: { status: "OPEN" },
    include: { steps: true, listing: { include: { seller: true } }, funders: { include: { user: true } } },
  });
  return eachItem("closing reminder", closings, (closing) => `closing ${closing.id}`, async (closing) => {
    const ready = closing.steps
      .map((step) => ({ step, at: effectiveDue(step, closing, days) }))
      .filter(({ step, at }) => stepNeedsReminder(step, at, now));
    // Each step is claimed on its own; the message covers only the steps this run took.
    const due: typeof ready = [];
    for (const item of ready) {
      const claim = await prisma.closingStep.updateMany({
        where: { id: item.step.id, status: { not: "COMPLETE" }, ...still("remindedAt", item.step.remindedAt) },
        data: { remindedAt: now },
      });
      if (claim.count === 1) due.push(item);
    }
    if (!due.length) return false;
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
    if (buyerSteps.length) for (const email of new Set(buyers)) await notify(email, subject, `${buyerSteps.map(line).join("\n")}\n\nThe checklist: ${link}`);
    await notifyDesk(subject, `${due.map(line).join("\n")}\n\n${link}`);
    return true;
  });
}

// The new owner's sale notice to the borrower, due 30 days after transfer. One reminder five days out and one
// once it's late, to the buyer side, or to the desk when the desk bought it. UPB never writes to the borrower.
export async function remindSaleNotices(now = new Date()) {
  const closings = await prisma.closing.findMany({
    where: { status: "COMPLETE", ...unset("ownerNoticeSentAt"), closedAt: { gte: new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000) } },
    include: { listing: { include: { notes: true } }, boarding: true, funders: { include: { user: true } } },
  });
  return eachItem("sale notice reminder", closings, (closing) => `closing ${closing.id}`, async (closing) => {
    const notes = closing.noteId ? closing.listing.notes.filter((note) => note.id === closing.noteId) : closing.listing.notes;
    const plan = borrowerNotices(closing, closing.boarding, loansInScope(notes, closing.loanPurpose).length, now);
    if (plan.sale.state === "not_needed" || !saleNoticeNeedsReminder(plan.sale.due, closing.ownerNoticeSentAt, closing.ownerNoticeRemindedAt, now)) return false;
    const claim = await prisma.closing.updateMany({
      where: { id: closing.id, AND: [still("ownerNoticeRemindedAt", closing.ownerNoticeRemindedAt), unset("ownerNoticeSentAt")] },
      data: { ownerNoticeRemindedAt: now },
    });
    if (claim.count !== 1) return false;
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
      for (const email of new Set(buyers)) await notify(email, subject, body);
    }
    return true;
  });
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
