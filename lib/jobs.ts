import { borrowerNotices, loansInScope, saleNoticeNeedsReminder } from "@/lib/borrower-notices";
import { closingLoans, stepLabel } from "@/lib/closing";
import { STEP_OWNER, effectiveDue, stepClock, stepNeedsReminder, targetDays } from "@/lib/closing-clock";
import { retentionCutoff } from "@/lib/compliance";
import { destructionRemindersDue, destructionRequestsDue, destructionWindowStart, sendDestructionReminder, sendDestructionRequest } from "@/lib/destruction";
import { digestBody, digestSince } from "@/lib/digest";
import { launchPending } from "@/lib/launch-rules";
import { sendMarketDispatch } from "@/lib/dispatch";
import { advanceSaleEvents } from "@/lib/sale-events";
import { notify, notifyDesk } from "@/lib/email";
import { notifyClosedAuctions } from "@/lib/listing-intel";
import { prisma } from "@/lib/prisma";
import { listingScope } from "@/lib/private-listings";
import { bidNeedsReminder, taskNeedsReminder } from "@/lib/schedule";
import { roundupSearches, sendSearchRoundup } from "@/lib/search-alerts";
import { reportOwners, sendSellerReport } from "@/lib/seller-report";
import { purgeTapeDrafts } from "@/lib/tape-draft";
import { unset } from "@/lib/db-filters";
import { notifyWatchers } from "@/lib/watchers";
import { dueDeliveries, retryDelivery, type WebhookSender } from "@/lib/webhooks";

const DAY = 24 * 60 * 60 * 1000;

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

// One job's part of a run: whether it finished clean, its line in the summary, and how long it took.
export type JobResult = { job: string; ok: boolean; line: string; ms?: number };

function describe(job: string, outcome: PromiseSettledResult<Tally | string>, ms?: number): JobResult {
  if (outcome.status === "rejected") return { job, ok: false, line: `${job} failed: ${errorText(outcome.reason)}.`, ms };
  const value = outcome.value;
  if (typeof value === "string") return { job, ok: true, line: `${value.charAt(0).toUpperCase()}${value.slice(1)}.`, ms };
  const ok = value.failed === 0;
  return { job, ok, line: `${job} ${value.sent}${ok ? "" : `, ${value.failed} failed (${value.error})`}.`, ms };
}

// The run record keeps its one summary field, written as JSON: the summary sentence as before, and each job's
// result, so the desk's job history can mark failures without reading the sentence.
const SUMMARY_VERSION = 1;

export function jobSummary(results: JobResult[]) {
  return JSON.stringify({ v: SUMMARY_VERSION, text: results.map((result) => result.line).join(" "), jobs: results });
}

export type JobSummary = { text: string; jobs: JobResult[]; failed: string[] };

// A run record as the job history shows it. Records from before the JSON were the sentence alone; each job's line
// there starts with a capital after the last one's full stop, and a failure says "failed".
export function readJobSummary(summary: string): JobSummary {
  try {
    const parsed = JSON.parse(summary) as { v?: number; text?: unknown; jobs?: unknown };
    if (parsed && parsed.v === SUMMARY_VERSION && Array.isArray(parsed.jobs)) {
      const jobs = parsed.jobs
        .filter((row): row is JobResult => Boolean(row) && typeof row.job === "string" && typeof row.line === "string" && typeof row.ok === "boolean")
        .map((row) => ({ job: row.job, ok: row.ok, line: row.line, ...(typeof row.ms === "number" ? { ms: row.ms } : {}) }));
      return { text: typeof parsed.text === "string" ? parsed.text : jobs.map((row) => row.line).join(" "), jobs, failed: jobs.filter((row) => !row.ok).map((row) => row.job) };
    }
  } catch {
    // The sentence from before the JSON.
  }
  const text = summary.trim();
  const jobs = text
    ? text.split(/(?<=\.)\s+(?=[A-Z])/).map((line) => {
        const failedJob = /^(.+?) failed: /.exec(line)?.[1] ?? null;
        const partial = /^(.+?) \d+, \d+ failed \(/.exec(line)?.[1] ?? null;
        const job = failedJob ?? partial ?? (/^(.+?) \d+\.$/.exec(line)?.[1] ?? line.replace(/\.$/, ""));
        return { job, ok: !failedJob && !partial, line };
      })
    : [];
  return { text, jobs, failed: jobs.filter((row) => !row.ok).map((row) => row.job) };
}

export type Job = [name: string, run: () => Promise<Tally | string>];

export async function runJobs(now = new Date()) {
  return runJobList([
    ["Digests", () => sendDueDigests(now)],
    ["Task reminders", () => remindTasks(now)],
    ["Bid reminders", () => remindBidDeadlines(now)],
    ["Bid expiry", () => expireBids(now)],
    // A seller asked to approve a bid hears once at half their window, and the desk hears once it closes.
    ["Seller answers", () => import("@/lib/seller-decisions").then((decisions) => decisions.remindSellerAnswers(now))],
    ["Closing reminders", () => remindClosingSteps(now)],
    ["Signature clock", () => import("@/lib/signatures").then((signatures) => signatures.signatureClock(now))],
    // Open closings past their target hear twice, then fail or go to the desk. Backup bids past their date close.
    ["Stalled closings", () => import("@/lib/backstop").then((backstop) => backstop.runBackstop(now))],
    ["Backup bids", () => import("@/lib/backup-bids").then((backups) => backups.lapseBackups(now))],
    // A seat's bid held for approval closes at the listing's deadline, and the seat that asked hears.
    ["Seat approvals", () => import("@/lib/seats").then((seats) => seats.expireSeatApprovals(now))],
    ["Sale notice reminders", () => remindSaleNotices(now)],
    // Trailing documents after a close: three days out, on the day, weekly while late, and the desk at 14 days.
    ["Trailing documents", () => import("@/lib/trailing-docs").then((docs) => docs.runTrailingDocs(now))],
    ["Closed auctions", () => notifyClosedAuctions().then(() => "closed auctions checked")],
    ["Retention", () => cleanRetention(now)],
    ["Abandoned tapes", () => purgeTapeDrafts(now).then((count) => `abandoned tapes ${count}`)],
    // The first run of each month sends the market dispatch; later runs find the month claimed.
    ["Market dispatch", () => sendMarketDispatch(now)],
    // Rounds change on their dates. The event pages also advance an event when they load, between runs.
    ["Sale events", () => advanceSaleEvents(now)],
    // Daily and weekly saved searches send one roundup each when their period is up.
    ["Launches", () => import("@/lib/launch").then((launch) => launch.runLaunches(now))],
    // Forward-flow tranches whose first look has ended open to the market, with the alerts approval held back.
    ["Flow releases", () => import("@/lib/flow-programs").then((flow) => flow.runFlowReleases(now))],
    ["Search roundups", () => sendSearchRoundups(now)],
    // Each seller or broker with a live listing hears how it did, once a week.
    ["Seller reports", () => sendSellerReports(now)],
    // Failed webhook deliveries whose next try is due.
    ["Webhook retries", () => retryWebhooks(now)],
    // Losing bidders are asked once to certify they destroyed the room's files, and reminded once a week later.
    ["Destruction requests", () => sendDestructionRequests(now)],
    ["Destruction reminders", () => remindDestruction(now)],
    ["Treasury 10-year", () => import("@/lib/treasury").then((treasury) => treasury.treasuryJob(now))],
    // Each approved buyer hears once, 30 days before their file is due for its yearly re-certification.
    ["Re-certification reminders", () => import("@/lib/buyer-file").then((file) => file.remindRecertifications(now))],
    // Each Pro trial hears three days before its end and once when it ends.
    ["Trial reminders", () => import("@/lib/trial").then((trial) => trial.remindTrials(now))],
    // A seller hears once two days before a repurchase claim's answer is due; with no answer, the claim goes to the desk.
    ["Repurchase claims", () => import("@/lib/claims").then((claims) => claims.claimClock(now))],
  ]);
}

// Each job settles on its own, so one failure neither stops the others nor loses the run record.
export async function runJobList(jobs: Job[]) {
  const startedAt = new Date();
  const took: number[] = [];
  const settled = await Promise.allSettled(
    jobs.map(([, run], index) => {
      const start = Date.now();
      return Promise.resolve().then(run).finally(() => {
        took[index] = Date.now() - start;
      });
    }),
  );
  const results = settled.map((outcome, index) => describe(jobs[index][0], outcome, took[index]));
  const failed = results.filter((result) => !result.ok).map((result) => result.job);
  const summary = results.map((result) => result.line).join(" ");
  try {
    await prisma.jobRun.create({ data: { startedAt, finishedAt: new Date(), summary: jobSummary(results) } });
  } catch (error) {
    console.error("[upb-jobs] the run record was not saved:", errorText(error), summary);
  }
  return { startedAt, summary, failed, results };
}

// How long a run or a job took, as the job history prints it. A run with no finish time never wrote one.
export function durationText(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "Didn't finish";
  if (ms < 1000) return "Under a second";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} min${rest ? ` ${rest} s` : ""}`;
}

export type JobRunRow = { id: string; startedAt: Date; finishedAt: Date | null; durationMs: number | null; summary: JobSummary; failed: boolean };

// The desk's job history, newest first. A run counts as failed when a job in it failed or it never finished.
export async function jobHistory(take = 50): Promise<JobRunRow[]> {
  const runs = await prisma.jobRun.findMany({ orderBy: { startedAt: "desc" }, take });
  return runs.map((run) => {
    const summary = readJobSummary(run.summary);
    const durationMs = run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null;
    return { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs, summary, failed: !run.finishedAt || summary.failed.length > 0 };
  });
}

export async function sendDueDigests(now = new Date()) {
  const users = await prisma.user.findMany({
    // The firm gets the digest. Its seats read it there, so none gets its own (lib/seats.ts).
    where: { role: "BUYER", accountStatus: "APPROVED", digest: { not: "OFF" }, ...unset("principalId") },
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
    // A match on a listing since made private, or from a seller who excludes this buyer, stays out of the digest.
    where: { userId: user.id, createdAt: { gte: since, lt: now }, listing: { status: "APPROVED", AND: [await listingScope({ id: user.id, role: "BUYER" })] } },
    include: { listing: true },
    orderBy: { score: "desc" },
    take: 12,
  });
  // A coming-soon listing waits for its launch, which sends its own alerts.
  const live = matches.filter((match) => !launchPending(match.listing, now));
  const body = digestBody(live.map((match) => ({ title: match.listing.title, score: match.score })));
  if (!body) return false;
  await notify(user.email, "Buy box digest", body, { category: "digest", userId: user.id });
  return true;
}

// Daily and weekly saved searches. Each sends one roundup per period, claimed on its lastAlertAt. `userIds` narrows
// a run, so a test sends only its own.
export async function sendSearchRoundups(now = new Date(), options: { userIds?: string[] } = {}) {
  const searches = await roundupSearches(options.userIds);
  return eachItem("search roundup", searches, (search) => `search ${search.id}`, (search) => sendSearchRoundup(search, now));
}

// The weekly report to each seller or broker with a live listing, claimed on lastSellerReportAt.
export async function sendSellerReports(now = new Date(), options: { userIds?: string[] } = {}) {
  const owners = await reportOwners(options.userIds);
  return eachItem("seller report", owners, (user) => `user ${user.id}`, (user) => sendSellerReport(user, now));
}

// Each due delivery is claimed on its try count, so an overlapping run sends it once. `endpointIds` narrows a run and
// `send` stands in for the network, both for tests.
export async function retryWebhooks(now = new Date(), options: { endpointIds?: string[]; send?: WebhookSender } = {}) {
  const due = await dueDeliveries(now, options);
  return eachItem("webhook retry", due, (delivery) => `delivery ${delivery.id}`, (delivery) => retryDelivery(delivery, now, options.send));
}

// Closings opened or closed since the last run say which listings went to a buyer. Rather than hook the award
// itself, the job polls, so an award from any path is covered. `since` and `listingIds` narrow a run for tests.
export async function sendDestructionRequests(now = new Date(), options: { since?: Date; listingIds?: string[] } = {}) {
  const since = options.since ?? (await destructionWindowStart(now));
  const due = await destructionRequestsDue(since, options);
  return eachItem("destruction request", due, (nda) => `nda ${nda.id}`, (nda) => sendDestructionRequest(nda, now));
}

export async function remindDestruction(now = new Date(), options: { listingIds?: string[] } = {}) {
  const due = await destructionRemindersDue(now, options);
  return eachItem("destruction reminder", due, (nda) => `nda ${nda.id}`, (nda) => sendDestructionReminder(nda, now));
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

// A day before bids close, the seller, the desk and every bidder hear once, claimed on bidReminderAt. Buyers who saved
// a live listing hear once too, claimed on watchReminderAt, except those who bid and already got the bidder notice.
// The two claims stand apart, so a run that sent one finishes the other on its next pass. `listingIds` narrows a run,
// so a test reminds its own listings and nobody else's.
export async function remindBidDeadlines(now = new Date(), options: { listingIds?: string[] } = {}) {
  const listings = await prisma.listing.findMany({
    where: {
      bidMode: { not: "NONE" },
      bidDeadline: { gt: now, lte: new Date(now.getTime() + DAY) },
      OR: [unset("bidReminderAt"), unset("watchReminderAt")],
      ...(options.listingIds ? { id: { in: options.listingIds } } : {}),
    },
    include: { seller: true, inquiries: { where: { type: "OFFER" }, include: { buyer: true } } },
  });
  return eachItem("bid reminder", listings, (listing) => `listing ${listing.id}`, async (listing) => {
    const when = listing.bidDeadline?.toISOString().slice(0, 16) ?? "";
    const subject = `Bid deadline · ${listing.title}`;
    let sent = false;
    if (bidNeedsReminder(listing, now)) {
      const claim = await prisma.listing.updateMany({ where: { id: listing.id, ...unset("bidReminderAt") }, data: { bidReminderAt: now } });
      if (claim.count === 1) {
        const body = `Bids on ${listing.title} close at ${when} UTC.`;
        await notify(listing.seller.email, subject, body);
        await notifyDesk(subject, body);
        // A buyer with several offers on the listing hears once.
        for (const email of new Set(listing.inquiries.map((inquiry) => inquiry.buyer.email))) await notify(email, subject, body);
        sent = true;
      }
    }
    if (listing.status === "APPROVED" && bidNeedsReminder({ ...listing, bidReminderAt: listing.watchReminderAt }, now)) {
      const claim = await prisma.listing.updateMany({ where: { id: listing.id, ...unset("watchReminderAt") }, data: { watchReminderAt: now } });
      if (claim.count === 1) {
        await notifyWatchers({
          listingId: listing.id,
          event: "DEADLINE",
          subject,
          body: `Bids on ${listing.title}, a listing you saved, close at ${when} UTC.`,
          except: listing.inquiries.map((inquiry) => inquiry.buyerId),
        });
        sent = true;
      }
    }
    return sent;
  });
}

// A bid past its good-until date closes. Each is claimed with a conditional write, so an award or a withdrawal that
// lands first wins, and an overlapping run tells nobody twice. The buyer hears, and so does a seller who was asked
// to approve it, so they don't answer a bid that is gone. `inquiryIds` narrows the run, so a test expires only its
// own bids.
export async function expireBids(now = new Date(), options: { inquiryIds?: string[] } = {}) {
  const bids = await prisma.inquiry.findMany({
    // A backup bid is good until its backup ends, and lib/backup-bids.ts lapseBackups closes it with its own notice.
    where: { type: "OFFER", status: { in: ["OPEN", "REVIEWED"] }, expiresAt: { lte: now }, ...unset("backupAt"), ...(options.inquiryIds ? { id: { in: options.inquiryIds } } : {}) },
    include: { buyer: true, listing: { include: { seller: true } } },
  });
  return eachItem("bid expiry", bids, (bid) => `inquiry ${bid.id}`, async (bid) => {
    const claim = await prisma.inquiry.updateMany({
      where: { id: bid.id, status: { in: ["OPEN", "REVIEWED"] }, expiresAt: { lte: now } },
      data: { status: "EXPIRED" },
    });
    if (claim.count !== 1) return false;
    // The buyer's own endpoints hear it as offer.status. Sellers have no webhook event for an expiry.
    await (await import("@/lib/webhooks")).emitOfferStatus(bid.id, "expired");
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

// One message per closing and party, listing every step that is late or due within two days. `closingIds` narrows
// the run, so a test reminds its own closings and never reads one whose listing another test is deleting.
export async function remindClosingSteps(now = new Date(), options: { closingIds?: string[] } = {}) {
  const settings = await prisma.platformSettings.findUnique({ where: { id: "default" } });
  const days = targetDays(settings?.closingTargetDays);
  const closings = await prisma.closing.findMany({
    where: { status: "OPEN", ...(options.closingIds ? { id: { in: options.closingIds } } : {}) },
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
    const notes = closingLoans(closing, closing.listing.notes);
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
