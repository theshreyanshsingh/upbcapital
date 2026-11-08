import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import type { Tally } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { getSettings, isPro } from "@/lib/settings";

// A Pro trial, once per account, when the desk sets PlatformSettings.proTrialDays. Without a Stripe secret it is a
// no-card trial: Pro until trialEndsAt, then the account is simply free again and nothing is charged. With a Stripe
// secret, checkout carries trial_period_days, Stripe takes the card up front and bills at the end, and the webhook
// marks the trial used. isPro (lib/settings.ts) counts any trial until its end.

const DAY = 24 * 60 * 60 * 1000;
export const TRIAL_REMINDER_DAYS = 3;
export const MAX_TRIAL_DAYS = 60;

export function trialDaysOf(setting: number | null | undefined) {
  return typeof setting === "number" && Number.isInteger(setting) && setting > 0 ? Math.min(setting, MAX_TRIAL_DAYS) : 0;
}

// "card" runs through Stripe checkout; "free" asks for nothing.
export function trialMode(env: Record<string, string | undefined> = process.env) {
  return env.STRIPE_SECRET_KEY ? ("card" as const) : ("free" as const);
}

type TrialUser = {
  role: string;
  accountStatus: string;
  subscriptionTier: string;
  subscriptionStatus: string;
  subscriptionCurrentPeriodEnd?: Date | null;
  subscriptionComped?: boolean | null;
  stripeSubscriptionId?: string | null;
  trialStartedAt?: Date | null;
  trialEndsAt?: Date | null;
};

// Pro the buyer pays for or the desk comped, leaving any trial out.
export function paidPro(user: TrialUser, now = new Date()) {
  return isPro({ ...user, trialEndsAt: null }, now);
}

export function trialActive(user: Pick<TrialUser, "trialEndsAt">, now = new Date()) {
  return Boolean(user.trialEndsAt && user.trialEndsAt.getTime() > now.getTime());
}

// A trial running now that is the account's only Pro: the no-card kind, or a card trial Stripe already ended.
export function onFreeTrial(user: TrialUser, now = new Date()) {
  return trialActive(user, now) && !paidPro(user, now);
}

const NEVER_PRO = "Trials are for accounts that have never had Pro.";

// Why this account can't start a trial, or null. A FREE buyer who never had Pro, a subscription, a desk comp or a
// trial. The revenue ledger is checked by trialOffer.
export function trialProblem(user: TrialUser, days: number) {
  if (days <= 0) return "The desk isn't offering a trial.";
  if (user.role !== "BUYER" || user.accountStatus !== "APPROVED") return "Trials are for approved buyer accounts.";
  if (user.trialStartedAt) return "This account has had its trial.";
  if (user.subscriptionTier !== "FREE" || user.subscriptionStatus !== "INCOMPLETE" || user.stripeSubscriptionId || user.subscriptionComped) return NEVER_PRO;
  return null;
}

// given stands in for the desk's setting, so a test never changes the shared settings row.
export async function trialOffer(user: TrialUser & { id: string }, given = -1) {
  const days = trialDaysOf(given >= 0 ? given : (await getSettings()).proTrialDays);
  let problem = trialProblem(user, days);
  // A past simulated or Stripe charge is a past subscription, whatever the account row says now.
  if (!problem && (await prisma.revenueEvent.count({ where: { userId: user.id, type: "SUBSCRIPTION" } }))) problem = NEVER_PRO;
  return { days, problem, mode: trialMode() };
}

// Starts a no-card trial. The write repeats the checks, so two presses, or a trial and a checkout at once, start one.
export async function startFreeTrial(userId: string, now = new Date(), given = -1) {
  if (trialMode() !== "free") return { error: "Start the trial from Stripe checkout." } as const;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { error: "Account not found." } as const;
  const offer = await trialOffer(user, given);
  if (offer.problem) return { error: offer.problem } as const;
  const endsAt = new Date(now.getTime() + offer.days * DAY);
  const { count } = await prisma.user.updateMany({
    where: {
      id: user.id,
      role: "BUYER",
      accountStatus: "APPROVED",
      subscriptionTier: "FREE",
      subscriptionStatus: "INCOMPLETE",
      AND: [unset("trialStartedAt"), unset("stripeSubscriptionId")],
    },
    data: { trialStartedAt: now, trialEndsAt: endsAt },
  });
  if (count !== 1) return { error: "This account has had its trial." } as const;
  await audit(user.id, "PRO_TRIAL", "user", user.id, `${offer.days}-day Pro trial with no card, until ${prettyDate(endsAt)}.`);
  return { error: null, endsAt, days: offer.days } as const;
}

// The trial_period_days for this buyer's Stripe checkout, or 0.
export async function checkoutTrialDays(user: TrialUser & { id: string }) {
  if (trialMode() !== "card") return 0;
  const offer = await trialOffer(user);
  return offer.problem ? 0 : offer.days;
}

// The webhook, once Stripe checkout completes with a trial: the trial is used, and its end is on the account for
// the reminders. Only the first one counts.
export async function markCardTrial(userId: string, days: number, now = new Date()) {
  const length = trialDaysOf(days);
  if (!length) return false;
  const { count } = await prisma.user.updateMany({
    where: { id: userId, ...unset("trialStartedAt") },
    data: { trialStartedAt: now, trialEndsAt: new Date(now.getTime() + length * DAY) },
  });
  return count === 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Reminders

type Reminded = TrialUser & { id: string; email: string };

export function trialNotice(user: Reminded, ended: boolean, now = new Date()) {
  const card = Boolean(user.stripeSubscriptionId);
  const on = prettyDate(user.trialEndsAt);
  if (!ended) {
    return {
      subject: `Your Pro trial ends ${on}`,
      body: card
        ? `Your Pro trial ends on ${on}. Stripe then bills the card on file for Pro each month. To stop that, cancel in the customer portal from Membership before the trial ends.`
        : `Your Pro trial ends on ${on}. Nothing is charged: the account goes back to the free desk then. To keep Pro, subscribe from Membership.`,
    };
  }
  return {
    subject: "Your Pro trial has ended",
    body: card && paidPro(user, now)
      ? "Your Pro trial has ended. Pro carries on, billed to the card on file. Manage it from Membership."
      : "Your Pro trial has ended, and nothing was charged. The account is on the free desk. To keep Pro, subscribe from Membership.",
  };
}

// A notice goes once: the first run to write its key sends it. Counter keys are unique, so an overlapping run finds
// the key taken.
async function claimOnce(key: string) {
  if (await prisma.counter.findUnique({ where: { id: key }, select: { id: true } })) return false;
  try {
    await prisma.counter.create({ data: { id: key, value: 1 } });
    return true;
  } catch (error) {
    if (await prisma.counter.findUnique({ where: { id: key }, select: { id: true } })) return false;
    throw error;
  }
}

export function trialNoticeKey(userId: string, endsAt: Date, ended: boolean) {
  return `trial-notice:${ended ? "end" : "soon"}:${userId}:${endsAt.getTime()}`;
}

// Each trial hears TRIAL_REMINDER_DAYS before its end and once when it ends. A trial that short skips the first. A
// buyer who started paying for Pro during a no-card trial hears nothing at the end. scope.userIds limits a test run.
export async function remindTrials(now = new Date(), scope: { userIds?: string[] } = {}): Promise<Tally> {
  const users = await prisma.user.findMany({
    where: {
      trialEndsAt: { gt: new Date(now.getTime() - 7 * DAY), lte: new Date(now.getTime() + TRIAL_REMINDER_DAYS * DAY) },
      ...unset("deletedAt"),
      ...(scope.userIds ? { id: { in: scope.userIds } } : {}),
    },
  });
  // Loaded on call: lib/jobs loads this module the same way.
  const { eachItem } = await import("@/lib/jobs");
  return eachItem("Trial reminders", users, (user) => user.id, async (user) => {
    const ends = user.trialEndsAt!;
    const ended = ends.getTime() <= now.getTime();
    if (!ended && user.trialStartedAt && ends.getTime() - user.trialStartedAt.getTime() <= TRIAL_REMINDER_DAYS * DAY) return false;
    if (!(await claimOnce(trialNoticeKey(user.id, ends, ended)))) return false;
    if (ended && !user.stripeSubscriptionId && paidPro(user, now)) return false;
    const notice = trialNotice(user, ended, now);
    await notify(user.email, notice.subject, notice.body);
    return true;
  });
}
