import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { CLOSING_STEPS } from "@/lib/closing";
import { money, prettyDate, q } from "@/lib/format";
import { filterRisk, isRiskKind, ownerLabel, RISK_KIND_ORDER, RISK_KINDS, riskAge, riskCounts, riskQueue, type RiskItem, type RiskKind } from "@/lib/risk-queue";
import { formatService, SERVICE_METRICS, SERVICE_MIN_EVENTS, SERVICE_WINDOW_DAYS, STEP_DEFINITION, serviceMetrics } from "@/lib/service-metrics";
import { deskCan } from "@/lib/staff";
import { cn } from "@/lib/utils";

export const metadata = { title: "Risk queue" };

const DAY = 24 * 60 * 60 * 1000;

// Every desk role reads the queue. Each item is resolved on the page it links to, under that page's own role checks.
export default async function RiskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["ADMIN"]);
  const params = await searchParams;
  const asked = q(params, "kind");
  const kind = isRiskKind(asked) ? asked : null;
  const mine = q(params, "mine") === "1";
  const now = new Date();
  const [all, service] = await Promise.all([riskQueue(user, { now }), serviceMetrics(now)]);
  const scoped = filterRisk(all, user, { mine });
  const counts = riskCounts(scoped);
  const items = filterRisk(scoped, user, { kind });
  const link = (next: { kind?: RiskKind | null; mine?: boolean }) => {
    const query = new URLSearchParams();
    if (next.kind) query.set("kind", next.kind);
    if (next.mine) query.set("mine", "1");
    const text = query.toString();
    return `/admin/risk${text ? `?${text}` : ""}`;
  };
  const shown = RISK_KIND_ORDER.filter((each) => counts[each] > 0 || each === kind);
  return (
    <div>
      <PageIntro
        eyebrow="Risk queue"
        title="What is stuck, and for how long."
        lede="Every open hold and red flag across the desk on one list: sanctions and money first, then the oldest. Each item links to the page that resolves it."
      />
      {!deskCan(user, "sealedBids") && (
        <p className="text-sm text-muted-foreground">Your desk role doesn&apos;t read sealed bids, so a figure on a listing behind the wall stays hidden here too.</p>
      )}

      <nav aria-label="Kinds" className="mt-6 flex flex-wrap gap-2">
        <Link href={link({ mine })} aria-current={!kind ? "page" : undefined} className={pill(!kind)}>
          All <span className="figure tabular-nums">{scoped.length}</span>
        </Link>
        {shown.map((each) => (
          <Link key={each} href={link({ kind: each, mine })} aria-current={each === kind ? "page" : undefined} className={pill(each === kind)}>
            {RISK_KINDS[each].label} <span className="figure tabular-nums">{counts[each]}</span>
          </Link>
        ))}
      </nav>
      <nav aria-label="Whose items" className="mt-3 flex flex-wrap gap-2">
        <Link href={link({ kind })} aria-current={!mine ? "page" : undefined} className={pill(!mine)}>All owners</Link>
        <Link href={link({ kind, mine: true })} aria-current={mine ? "page" : undefined} className={pill(mine)}>Mine</Link>
      </nav>
      {mine && <p className="mt-2 text-[13px] text-muted-foreground">Yours: deals you own by name, and unowned items your desk role resolves.</p>}

      <ul className="mt-6 space-y-3">
        {items.length === 0 && (
          <li className="rounded-xl border border-dashed border-border px-5 py-8 text-sm text-muted-foreground">
            {kind ? `No ${RISK_KINDS[kind].label.toLowerCase()} items are open${mine ? " for you" : ""}.` : mine ? "Nothing of yours is open." : "Nothing is open."}
          </li>
        )}
        {items.map((item) => (
          <li key={item.id}>
            <RiskCard item={item} now={now} />
          </li>
        ))}
      </ul>

      <section className="mt-12" aria-labelledby="service-heading">
        <h2 id="service-heading" className="eyebrow">How fast the desk works</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The last {SERVICE_WINDOW_DAYS} days, {prettyDate(service.range.start)} to {prettyDate(service.range.end)}, from the timestamps and audit log on file. Each event counts when it ended, and a figure needs at least {SERVICE_MIN_EVENTS} of them. The board pack carries the same figures each month.
        </p>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {SERVICE_METRICS.map((metric) => {
            const figure = service.figures[metric.key];
            const steps = metric.key === "closing" ? CLOSING_STEPS.filter((step) => service.figures.closingSteps[step.key]?.count) : [];
            return (
              <li key={metric.key} className="glass min-w-0 p-4">
                <h3 className="text-[13px] font-medium text-muted-foreground">{metric.label}</h3>
                <p className={cn("mt-1 font-semibold tabular-nums", figure.median == null ? "text-sm text-muted-foreground" : "text-xl text-foreground")}>
                  {figure.median == null ? formatService(null, metric.unit) : `${formatService(figure.median, metric.unit)} median`}
                </p>
                {metric.p90 && figure.p90 != null && <p className="text-sm tabular-nums text-foreground">{formatService(figure.p90, metric.unit)} at the 90th percentile</p>}
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">n = {figure.count}</p>
                <p className="mt-2 text-xs text-pretty text-muted-foreground">{metric.definition}</p>
                {steps.length > 0 && (
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="text-xs text-muted-foreground">By step. {STEP_DEFINITION}</p>
                    <dl className="mt-2 space-y-1.5 text-xs">
                      {steps.map((step) => {
                        const each = service.figures.closingSteps[step.key];
                        return (
                          <div key={step.key} className="flex flex-wrap items-baseline justify-between gap-x-3">
                            <dt className="text-foreground">{step.label}</dt>
                            <dd className="tabular-nums text-muted-foreground">{formatService(each.median, "days")} · n = {each.count}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function pill(active: boolean) {
  return cn(
    "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium",
    active ? "border-link/50 bg-link/10 text-link" : "border-border bg-card text-muted-foreground hover:text-foreground",
  );
}

const TIER_TONE = ["bg-bad/12 text-bad", "bg-warn/12 text-warn", "bg-muted text-muted-foreground", "bg-muted text-muted-foreground"];

// The whole card is the link, so on a phone it is one full-width target.
function RiskCard({ item, now }: { item: RiskItem; now: Date }) {
  const meta = RISK_KINDS[item.kind];
  const waited = item.openedAt ? (now.getTime() - item.openedAt.getTime()) / DAY : 0;
  const ageTone = waited >= 5 ? "text-bad" : waited >= 2 ? "text-foreground" : "text-muted-foreground";
  return (
    <Link href={item.href} className="glass block p-4 transition-colors hover:bg-hover sm:p-5 md:grid md:grid-cols-[minmax(0,1fr)_12rem] md:gap-6">
      <div className="min-w-0">
        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", TIER_TONE[meta.tier])}>{meta.label}</span>
        <p className="mt-2 font-semibold break-words text-foreground">{item.title}</p>
        <p className="mt-1 text-sm break-words text-muted-foreground">{item.detail}</p>
        {item.sealed ? (
          <p className="mt-1 text-[13px] text-muted-foreground">{item.amountLabel ?? "Amount"} sealed: your desk role is behind the bid wall on this listing.</p>
        ) : item.amountCents != null ? (
          <p className="mt-1 text-[13px] tabular-nums text-muted-foreground">{item.amountLabel ?? "Amount"} {money(item.amountCents / 100)}</p>
        ) : null}
        <p className="mt-2 text-sm text-pretty text-foreground">
          <span className="font-medium">Next:</span> {item.next}
        </p>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs md:mt-0 md:grid-cols-1 md:content-start md:border-t-0 md:pt-0">
        <div className="min-w-0">
          <dt className="text-muted-foreground">Waiting</dt>
          <dd className={cn("mt-0.5 font-medium tabular-nums", ageTone)}>{riskAge(item.openedAt, now)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Owner</dt>
          <dd className="mt-0.5 font-medium break-words text-foreground">{ownerLabel(item)}</dd>
        </div>
      </dl>
    </Link>
  );
}
