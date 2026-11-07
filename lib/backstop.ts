import { audit } from "@/lib/audit";
import { CLOSING_STEPS, stepLabel } from "@/lib/closing";
import { effectiveTarget, targetDays } from "@/lib/closing-clock";
import { buyerSideEmails, cancelOpenClosing } from "@/lib/closing-service";
import { unset } from "@/lib/db-filters";
import { depositNoticeLine } from "@/lib/deposits";
import { notify, notifyDesk } from "@/lib/email";
import { onGroupDeclined } from "@/lib/group-events";
import { money, prettyDate } from "@/lib/format";
import { eachItem } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { faultLabel } from "@/lib/strikes";

// The stalled-deal backstop. An open closing past its target hears once at the target, and once more three days
// before the backstop. At the backstop, a deal with no money moved is canceled through the usual cancel path, so the
// note goes back on the book and nobody takes a strike. A deal with money in it is never canceled by a job: it goes
// to the desk once, to decide. Each notice is claimed on its own marker, so an overlapping run sends it once.

export const DEFAULT_STALL_DAYS = 15;
export const FINAL_NOTICE_DAYS = 3;
export const STALL_REASON = "Stalled past the backstop";

const DAY = 24 * 60 * 60 * 1000;

// Days past the target close before the backstop acts. Missing or out of range means the default.
export function stallDaysOf(setting: number | null | undefined) {
  return setting != null && setting >= 5 && setting <= 90 ? Math.round(setting) : DEFAULT_STALL_DAYS;
}

type StallClosing = {
  status: string;
  openedAt: Date;
  targetCloseAt: Date | null;
  stallWarnedAt: Date | null;
  stallFinalAt: Date | null;
  stallEscalatedAt: Date | null;
};

// When the backstop acts: the target plus the stall days, and never sooner than three days after the final notice,
// so a run that finds a deal late still gives the parties their warning.
export function backstopDates(closing: StallClosing, stallDays: number, closingDays: number) {
  const target = effectiveTarget(closing, closingDays);
  const deadline = new Date(target.getTime() + stallDays * DAY);
  const final = new Date(deadline.getTime() - FINAL_NOTICE_DAYS * DAY);
  const act = closing.stallFinalAt ? new Date(Math.max(deadline.getTime(), closing.stallFinalAt.getTime() + FINAL_NOTICE_DAYS * DAY)) : deadline;
  return { target, deadline, final, act };
}

// The one notice or action due on this run, in order: the warning, then the final notice, then the backstop.
export function backstopStage(closing: StallClosing, stallDays: number, closingDays: number, now = new Date()) {
  if (closing.status !== "OPEN") return null;
  const dates = backstopDates(closing, stallDays, closingDays);
  if (now.getTime() < dates.target.getTime()) return null;
  if (!closing.stallWarnedAt) return "warn" as const;
  if (!closing.stallFinalAt) return now.getTime() >= dates.final.getTime() ? ("final" as const) : null;
  if (now.getTime() < dates.act.getTime() || closing.stallEscalatedAt) return null;
  return "act" as const;
}

// Money has moved once the desk recorded a deposit, buyer funds, the seller's proceeds, or a group share funded.
export function moneyMoved(closing: { depositReceivedCents: number | null; fundsReceivedCents: number | null; proceedsSentCents: number | null }, funders: { status: string }[] = []) {
  return Boolean(closing.depositReceivedCents || closing.fundsReceivedCents || closing.proceedsSentCents || funders.some((funder) => funder.status === "FUNDED"));
}

function movedWords(closing: { depositReceivedCents: number | null; fundsReceivedCents: number | null; proceedsSentCents: number | null }, funders: { status: string }[]) {
  const parts = [
    closing.depositReceivedCents ? "the buyer's deposit" : "",
    closing.fundsReceivedCents ? "buyer funds" : "",
    closing.proceedsSentCents ? "the seller's proceeds" : "",
    funders.some((funder) => funder.status === "FUNDED") ? "group shares" : "",
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
}

async function loadOpen(options: { closingIds?: string[] }) {
  return prisma.closing.findMany({
    where: { status: "OPEN", ...(options.closingIds ? { id: { in: options.closingIds } } : {}) },
    include: { listing: { include: { seller: { select: { email: true } } } }, steps: { select: { key: true, status: true } }, funders: { select: { status: true } } },
  });
}

type OpenClosing = Awaited<ReturnType<typeof loadOpen>>[number];

// One pass over the open closings. `closingIds` narrows a run, so a test touches only its own.
export async function runBackstop(now = new Date(), options: { closingIds?: string[] } = {}) {
  const settings = await getSettings();
  const stallDays = stallDaysOf(settings.stallDays);
  const closingDays = targetDays(settings.closingTargetDays);
  const closings = await loadOpen(options);
  return eachItem("backstop", closings, (closing) => `closing ${closing.id}`, (closing) => backstopOne(closing, stallDays, closingDays, now));
}

async function backstopOne(closing: OpenClosing, stallDays: number, closingDays: number, now: Date) {
  const stage = backstopStage(closing, stallDays, closingDays, now);
  if (!stage) return false;
  const dates = backstopDates(closing, stallDays, closingDays);
  const title = closing.listing.title;
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closing.id}`;
  const moved = moneyMoved(closing, closing.funders);
  // The open steps in checklist order. Closing the file is the deal itself, so it isn't listed.
  const open = CLOSING_STEPS.filter((step) => step.key !== "CLOSED" && closing.steps.some((row) => row.key === step.key && row.status !== "COMPLETE")).map((step) => stepLabel(step.key));
  const todo = open.length ? ` Still to do: ${open.join(", ").toLowerCase()}.` : "";
  const then = moved ? "the desk decides what happens to it" : "it is canceled and the note goes back on the book";
  if (stage === "warn") {
    const claim = await prisma.closing.updateMany({ where: { id: closing.id, status: "OPEN", ...unset("stallWarnedAt") }, data: { stallWarnedAt: now } });
    if (claim.count !== 1) return false;
    const body = `${title} was due to close ${prettyDate(dates.target)} and is still open.${todo} If it isn't closed by ${prettyDate(dates.deadline)}, ${then}. The checklist: ${link}`;
    await tellParties(closing, `Past the target close · ${title}`, body);
    await audit(null, "STALL_WARNED", "closing", closing.id, `Past the target of ${prettyDate(dates.target)}. Backstop ${prettyDate(dates.deadline)}.`);
    return true;
  }
  if (stage === "final") {
    const claim = await prisma.closing.updateMany({ where: { id: closing.id, status: "OPEN", ...unset("stallFinalAt") }, data: { stallFinalAt: now } });
    if (claim.count !== 1) return false;
    const by = new Date(Math.max(dates.deadline.getTime(), now.getTime() + FINAL_NOTICE_DAYS * DAY));
    const body = `Final notice. ${title} was due to close ${prettyDate(dates.target)}.${todo} If it isn't closed by ${prettyDate(by)}, ${then}. The checklist: ${link}`;
    await tellParties(closing, `Final notice · ${title}`, body);
    await notifyDesk(`Backstop on ${prettyDate(by)} · ${title}`, `${body}${moved ? "" : " No money has moved on it."}`, { capability: "closings" });
    await audit(null, "STALL_FINAL", "closing", closing.id, `Backstop ${prettyDate(by)}${moved ? ", money has moved" : ", no money moved"}.`);
    return true;
  }
  if (moved) {
    const claim = await prisma.closing.updateMany({ where: { id: closing.id, status: "OPEN", ...unset("stallEscalatedAt") }, data: { stallEscalatedAt: now } });
    if (claim.count !== 1) return false;
    await notifyDesk(
      `Stalled closing · ${title}`,
      `${title} is past its backstop, ${stallDays} days after the target close of ${prettyDate(dates.target)}. Money is on record: ${movedWords(closing, closing.funders)}. The backstop doesn't cancel a deal with money in it, so the desk decides: close it, move the target, or cancel it and return the money. ${link}`,
      { capability: "closings" },
    );
    await audit(null, "STALL_ESCALATED", "closing", closing.id, `Past the backstop with ${movedWords(closing, closing.funders)} on record.`);
    return true;
  }
  return cancelStalled(closing, stallDays, link);
}

// The cancel the desk's form makes (actions/closing.ts cancelClosing), with the same notices, made by the job: no
// one's fault, so no strike. The cancel path itself hands the loans back, reopens the listing and tells the desk
// about any backup bids.
async function cancelStalled(closing: OpenClosing, stallDays: number, link: string) {
  const canceled = await cancelOpenClosing(closing.id, STALL_REASON, { fault: "NEITHER", actorId: null });
  if (!canceled) return false;
  const title = closing.listing.title;
  await audit(null, "CLOSING_CANCELED", "closing", closing.id, `${faultLabel("NEITHER")}. ${STALL_REASON}.`);
  const message = `This closing ran ${stallDays} days past its target close with no money moved, so it was canceled. The note goes back on the book. Nobody is at fault, and no strike is recorded.`;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { id: true } }) : null;
  if (inquiry) {
    await onGroupDeclined(inquiry.id, message);
    const { emitWebhook } = await import("@/lib/webhooks");
    await emitWebhook(closing.listing.sellerId, "offer.declined", { inquiryId: inquiry.id, listingId: closing.listingId, reason: "stalled" });
  }
  const ended = await prisma.closing.findUnique({ where: { id: closing.id } });
  for (const email of await buyerSideEmails(closing.id)) await notify(email, `Closing canceled · ${title}`, `${message}${ended ? depositNoticeLine(ended) : ""}`);
  await notify(closing.listing.seller.email, `Closing canceled · ${title}`, message);
  // Backups outlive the backstop (lib/backup-bids.ts), so the desk can award one from the canceled closing's page.
  const { backupsFor } = await import("@/lib/backup-bids");
  const { standing } = await backupsFor(closing);
  const backups = standing.length
    ? ` Backup bids live: ${standing.map((bid) => `${bid.buyer} at ${money(bid.price)}, standing until ${prettyDate(bid.until)}`).join("; ")}. Award one from the closing page.`
    : " No backup bids are live.";
  await notifyDesk(`Closing canceled by the backstop · ${title}`, `${message}${backups} ${link}`, { capability: "closings" });
  return true;
}

// The buyer side and the seller. On a desk purchase the desk is the buyer, so it hears instead.
async function tellParties(closing: OpenClosing, subject: string, body: string) {
  for (const email of new Set([...(await buyerSideEmails(closing.id)), closing.listing.seller.email])) await notify(email, subject, body);
  if (closing.deskBidId) await notifyDesk(subject, body, { capability: "closings" });
}
