import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { RevenueBars } from "@/components/charts";
import { FinanceExports } from "@/components/finance-panels";
import { requireRole } from "@/lib/auth";
import { targetDays } from "@/lib/closing-clock";
import { deskToday } from "@/lib/desk-today";
import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Revenue" };

export default async function AdminHome() {
  const viewer = await requireRole(["ADMIN"]);
  const settings = await getSettings();
  const [today, events, subscribers, notices] = await Promise.all([
    deskToday(settings.closingTargetDays),
    prisma.revenueEvent.findMany({ orderBy: { occurredAt: "desc" } }),
    prisma.user.findMany({ where: { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" } }),
    prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
  ]);
  const sum = (type: "BUYER_PREMIUM" | "SELLER_COMMISSION" | "SUBSCRIPTION") =>
    events.filter((event) => event.type === type).reduce((total, event) => total + event.amountCents, 0);
  const paid = subscribers.filter((user) => !user.subscriptionComped);
  const mrr = paid.length * settings.proMonthlyPriceCents;
  const months = lastMonths(6).map((month) => {
    const inMonth = events.filter((event) => event.occurredAt.getUTCFullYear() === month.year && event.occurredAt.getUTCMonth() === month.month);
    const take = (type: string) => inMonth.filter((event) => event.type === type).reduce((total, event) => total + event.amountCents, 0) / 100;
    return { label: month.label, premium: take("BUYER_PREMIUM"), commission: take("SELLER_COMMISSION"), subscription: take("SUBSCRIPTION") };
  });

  return (
    <div>
      <PageIntro eyebrow="Desk ledger" title="What the desk has earned." lede="Premiums and commissions post when a listing is marked sold. Membership cash posts from Stripe, or from the simulated checkout." />
      <section className="mb-10 glass p-5 sm:p-6" aria-labelledby="today-heading">
        <p id="today-heading" className="eyebrow">Desk today</p>
        <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:gap-y-3 lg:grid-cols-4">
          <Waiting href="/admin/queue" k="Listings to review" v={today.review} hint={today.oldestReviewDays != null ? `oldest ${today.oldestReviewDays} day${today.oldestReviewDays === 1 ? "" : "s"}` : undefined} urgent={(today.oldestReviewDays ?? 0) >= 5} />
          <Waiting href="/admin/offers" k="Open bids" v={today.offers} hint={today.toAward ? `${today.toAward} listing${today.toAward === 1 ? "" : "s"} ready to award` : undefined} urgent={today.toAward > 0} />
          <Waiting href="/closings" k="Open closings" v={today.openClosings} hint={today.lateClosings ? `${today.lateClosings} running late` : undefined} urgent={today.lateClosings > 0} />
          <Waiting href="/admin/compliance" k="OFAC reviews" v={today.ofac} urgent={today.ofac > 0} />
          <Waiting href="/admin/verification" k="Buyer files waiting" v={today.files} />
          <Waiting href="/admin/users" k="Accounts waiting" v={today.accounts} />
        </ul>
        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-3">
          <Kpi k="Close rate, 180 days" v={today.stats.closeRate == null ? "—" : `${Math.round(today.stats.closeRate * 100)}%`} hint={`${today.stats.complete} closed · ${today.stats.canceled} canceled`} />
          <Kpi k="Average days to close" v={today.stats.averageDays == null ? "—" : today.stats.averageDays.toFixed(0)} hint={`Target ${targetDays(settings.closingTargetDays)} days`} />
          <Kpi k="Bids per live listing" v={today.bidsPerListing == null ? "—" : today.bidsPerListing.toFixed(1)} hint={`${today.liveListings} live`} />
        </dl>
      </section>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Figure k="Buyer premiums" v={money(sum("BUYER_PREMIUM") / 100)} />
        <Figure k="Seller commissions" v={money(sum("SELLER_COMMISSION") / 100)} />
        <Figure k="Subscription MRR" v={money(mrr / 100)} hint={`${paid.length} paid · ${subscribers.length - paid.length} comped`} />
        <Figure k="Broker fees posted" v={money(events.filter((event) => event.type === "BROKER_FEE").reduce((total, event) => total + event.amountCents, 0) / 100)} hint="Payable to brokers. Not desk income." />
      </div>
      <p className="mt-4 text-[13px] font-medium"><Link href="/admin/payouts" className="text-link">Payout queue</Link></p>
      {/* The finance pack's exports, for the desk book and the admin. lib/finance-export.ts. */}
      <FinanceExports viewer={viewer} />
      <section className="mt-10 glass p-5 sm:p-6">
        <p className="eyebrow">Six months</p>
        <div className="mt-6">
          <RevenueBars months={months} />
        </div>
      </section>
      <section className="mt-10">
        <div className="flex items-end justify-between">
          <p className="eyebrow">Ledger</p>
          <Link href="/admin/settings" className="text-[13px] font-medium text-link">Fee schedule</Link>
        </div>
        <div className="mt-4 relative overflow-x-auto border border-border rounded-xl">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs font-medium text-muted-foreground">
              <tr>
                {["When", "Type", "Amount", "Note"].map((heading) => <th key={heading} className="px-4 py-3 font-normal">{heading}</th>)}
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="border-t border-border">
                  <td className="px-4 py-3 text-muted-foreground">{event.occurredAt.toISOString().slice(0, 10)}</td>
                  <td className="px-4 py-3">{event.type.replaceAll("_", " ").toLowerCase()}{event.mock ? " · mock" : ""}</td>
                  <td className="px-4 py-3 font-semibold tracking-tight text-xl text-foreground">{money(event.amountCents / 100)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{event.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="mt-10">
        <p className="eyebrow">Desk notices</p>
        <ul className="mt-4 space-y-3">
          {notices.map((notice) => (
            <li key={notice.id} className="border border-border px-4 py-3 rounded-xl">
              <p className="text-[13px] font-medium text-link">{notice.toEmail}</p>
              <p className="mt-1 text-sm text-foreground">{notice.subject}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Waiting({ href, k, v, hint, urgent }: { href: string; k: string; v: number; hint?: string; urgent?: boolean }) {
  return (
    <li>
      <Link href={href} className="group block">
        <span className="text-[13px] text-muted-foreground group-hover:text-foreground">{k}</span>
        <span className={`block text-2xl font-semibold tracking-tight ${v > 0 && urgent ? "text-bad" : "text-foreground"}`}>{v}</span>
        {hint && <span className={`block text-xs ${urgent ? "text-bad" : "text-muted-foreground"}`}>{hint}</span>}
      </Link>
    </li>
  );
}

function Kpi({ k, v, hint }: { k: string; v: string; hint: string }) {
  return (
    <div>
      <dt className="text-[13px] text-muted-foreground">{k}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{v}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}

function Figure({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="glass @container p-4 sm:p-6">
      <p className="eyebrow">{k}</p>
      {/* Sized to the card, so a long figure shrinks to fit rather than overflowing or breaking mid-number. */}
      <p className="figure mt-2 text-[clamp(1.125rem,13cqi,1.75rem)] leading-tight font-semibold tracking-tight whitespace-nowrap text-foreground sm:mt-3">{v}</p>
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function lastMonths(count: number) {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - index), 1));
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      label: date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
    };
  });
}
