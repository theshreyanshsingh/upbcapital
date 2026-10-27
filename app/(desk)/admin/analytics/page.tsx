import { sendMatchDigests } from "@/actions/prefs";
import { HorizontalBars } from "@/components/charts";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { average, daysBetween, funnelSteps } from "@/lib/analytics";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const [visits, signups, verified, offers, closings, closed, sold, buyers, listings] = await Promise.all([
    prisma.pageHit.count(),
    prisma.user.count(),
    prisma.buyerProfile.count({ where: { status: "APPROVED" } }),
    prisma.inquiry.count({ where: { type: "OFFER" } }),
    prisma.closing.count(),
    prisma.closing.count({ where: { status: "COMPLETE" } }),
    prisma.listing.findMany({ where: { status: "SOLD", soldAt: { not: null } }, select: { submittedAt: true, soldAt: true, title: true } }),
    prisma.inquiry.findMany({
      where: { type: "OFFER" },
      include: { buyer: true },
    }),
    prisma.listing.findMany({
      where: { status: { in: ["APPROVED", "PENDING", "SOLD"] } },
      include: { _count: { select: { inquiries: true, views: true } } },
      orderBy: { viewCount: "desc" },
      take: 8,
    }),
  ]);
  const steps = funnelSteps({ visits, signups, verified, offers, closings, closed });
  const closeDays = sold.flatMap((listing) => (listing.soldAt ? [daysBetween(listing.submittedAt, listing.soldAt)] : []));
  const meanClose = average(closeDays);
  const byBuyer = new Map<string, { name: string; offers: number; volume: number }>();
  for (const offer of buyers) {
    const row = byBuyer.get(offer.buyerId) ?? { name: offer.buyer.name, offers: 0, volume: 0 };
    row.offers += 1;
    row.volume += Number(offer.amount || 0);
    byBuyer.set(offer.buyerId, row);
  }
  const top = [...byBuyer.values()].sort((a, b) => b.volume - a.volume).slice(0, 5);
  return (
    <div>
      <PageIntro eyebrow="Analytics" title="How the desk is moving." lede="Visits are pages opened since this counter started. Time to close uses sold listings, from the day they were filed to the day they were marked sold." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <form action={sendMatchDigests} className="mt-4">
        <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Send match digest</SubmitButton>
      </form>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <Stat label="Mean days to sell" value={meanClose == null ? "—" : meanClose.toFixed(0)} />
        <Stat label="Offers" value={String(offers)} />
        <Stat label="Closings still open" value={String(closings - closed)} />
      </div>
      <section className="glass mt-8 p-6">
        <p className="eyebrow">Funnel</p>
        <div className="mt-6">
          <HorizontalBars rows={steps.map((step) => ({ label: step.label.split(" ")[0], value: step.value }))} />
        </div>
        <ul className="mt-6 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
          {steps.slice(1).map((step) => (
            <li key={step.key}>{step.label}: {step.rate == null ? "no prior step" : `${step.rate.toFixed(0)}% of the prior step`}</li>
          ))}
        </ul>
      </section>
      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Top buyers by offer volume</p>
          <ul className="mt-4 space-y-3">
            {top.length === 0 && <li className="text-sm text-muted-foreground">No offers yet.</li>}
            {top.map((buyer) => (
              <li key={buyer.name} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-foreground">{buyer.name}</span>
                <span className="text-muted-foreground">{buyer.offers} offers · ${Math.round(buyer.volume).toLocaleString("en-US")}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Listing performance</p>
          <ul className="mt-4 space-y-3">
            {listings.map((listing) => (
              <li key={listing.id} className="text-sm">
                <p className="text-foreground">{listing.title}</p>
                <p className="text-muted-foreground">{listing.viewCount} views · {listing._count.inquiries} inquiries · {listing.status.toLowerCase()}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{value}</p>
    </div>
  );
}
