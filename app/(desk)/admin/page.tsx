import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { RevenueBars } from "@/components/charts";
import { requireRole } from "@/lib/auth";
import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Revenue" };

export default async function AdminHome() {
  await requireRole(["ADMIN"]);
  const [settings, events, subscribers, notices] = await Promise.all([
    getSettings(),
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure k="Buyer premiums" v={money(sum("BUYER_PREMIUM") / 100)} />
        <Figure k="Seller commissions" v={money(sum("SELLER_COMMISSION") / 100)} />
        <Figure k="Subscription MRR" v={money(mrr / 100)} hint={`${paid.length} paid · ${subscribers.length - paid.length} comped`} />
        <Figure k="Broker fees posted" v={money(events.filter((event) => event.type === "BROKER_FEE").reduce((total, event) => total + event.amountCents, 0) / 100)} hint="Payable to brokers. Not desk income." />
      </div>
      <p className="mt-4 text-[13px] font-medium"><Link href="/admin/payouts" className="text-link">Payout queue</Link></p>
      <section className="mt-10 glass p-6">
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
        <div className="mt-4 overflow-x-auto border border-border rounded-xl">
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

function Figure({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="glass p-6">
      <p className="eyebrow">{k}</p>
      <p className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{v}</p>
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
