import { FUNNEL_STAGES, STAGE_LABELS, listingHealth, type FunnelStage, type HealthStep, type Similar, type StepTarget } from "@/lib/listing-health";
import { prisma } from "@/lib/prisma";
import { deskContact } from "@/lib/staff";

// Listing health on the seller's, broker's and buyer-seller's own listing pages (lib/listing-health.ts): what buyers
// did with a live listing, against similar listings, and the next steps from fixed rules. It loads what it shows, so
// a page needs one line for it. On a phone the funnel is a stacked list; from md up it is a table.

type From = "seller" | "broker" | "resale";
type Link = { href: string; label: string };

const fmt = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

// Where each step is acted on. Sections on the page come first; anything the page can't do goes to the desk.
function linkFor(
  target: StepTarget,
  ctx: { from: From; desk: boolean; owner: boolean; pool: boolean; listingId: string; mail: Link | null },
): Link | null {
  const deskPage = { href: `/admin/listings/${ctx.listingId}`, label: "Open the desk's listing page" };
  const away = ctx.desk ? deskPage : ctx.mail;
  switch (target) {
    case "availability":
      return { href: "#availability", label: "Confirm availability" };
    case "diligence":
      if (ctx.from === "seller") return { href: "#diligence", label: "See the diligence set" };
      return ctx.desk ? { href: `/admin/listings/${ctx.listingId}#diligence`, label: "See the diligence set" } : ctx.mail;
    case "files":
      // A pool takes new files on its owner's page. A single note's files go through the desk.
      if (ctx.pool && ctx.owner && ctx.from !== "resale") return { href: "#room-files", label: "Add files" };
      return away;
    case "photos":
      return ctx.from === "resale" ? away : { href: "#photos", label: "Add photos" };
    case "price":
      if (ctx.pool && ctx.from === "seller") return { href: "#bulk-price", label: "Go to bulk price" };
      return away;
    case "audience":
      return { href: "#audience", label: "Change the audience" };
    case "limits":
      return { href: "#bidder-limits", label: "See who may bid" };
    case "announce":
      return ctx.desk ? { href: "/admin/announcements", label: "Write an announcement" } : ctx.mail;
    case "bidderCount":
      return { href: "#bidder-count", label: "Go to the bidder count" };
  }
}

function Median({ similar, stage }: { similar: Similar | null; stage: FunnelStage }) {
  return similar ? <>{fmt(similar.median[stage])}</> : <span aria-label="No comparison">—</span>;
}

export async function ListingHealthPanel({ listingId, viewer, from }: { listingId: string; viewer: { id: string; role: string }; from: From }) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, title: true, kind: true, status: true, sellerId: true, brokerId: true, deskOwnerId: true } });
  if (!listing || listing.status !== "APPROVED") return null;
  const desk = viewer.role === "ADMIN";
  const owner = listing.sellerId === viewer.id || (Boolean(listing.brokerId) && listing.brokerId === viewer.id);
  if (!desk && !owner) return null;
  const [health, contact] = await Promise.all([
    // A section that can't load leaves the rest of the page standing.
    listingHealth([listing.id], new Date(), { desk }).then((map) => map.get(listing.id) ?? null).catch(() => null),
    desk ? Promise.resolve(null) : deskContact(listing.deskOwnerId),
  ]);
  if (!health) return null;
  const deskEmail = contact?.email ?? process.env.DESK_EMAIL?.trim() ?? "";
  const mail = deskEmail ? { href: `mailto:${deskEmail}?subject=${encodeURIComponent(listing.title)}`, label: contact ? `Write ${contact.name}` : "Write the desk" } : null;
  const ctx = { from, desk, owner, pool: listing.kind === "POOL", listingId: listing.id, mail };
  const { funnel, similar } = health;
  const compare = similar
    ? `Similar is the median of ${similar.count} other sellers' listings like this one (${health.profile.label.toLowerCase()}), each over its first ${similar.days} day${similar.days === 1 ? "" : "s"} live, from the last 180 days. No listing is shown on its own.`
    : "Not enough similar listings to compare.";

  return (
    <section id="listing-health" aria-labelledby="listing-health-heading" className="mt-6 scroll-mt-6 rounded-xl border border-border p-4 sm:p-5">
      <h2 id="listing-health-heading" className="eyebrow">Listing health</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Live {health.daysLive} day{health.daysLive === 1 ? "" : "s"}. What buyers did with it, counted from UPB&apos;s logs. Opens by you and by the desk are left out.
      </p>

      {/* Phones: one row per stage. */}
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border md:hidden">
        {FUNNEL_STAGES.map((stage) => (
          <li key={stage} className="flex items-baseline justify-between gap-3 px-3 py-2.5">
            <span className="min-w-0 text-sm text-foreground">{STAGE_LABELS[stage]}</span>
            <span className="shrink-0 text-right text-sm tabular-nums">
              <span className="font-medium text-foreground">{funnel[stage].total}</span>
              <span className="block text-xs text-muted-foreground">
                {funnel[stage].week} this week{similar ? ` · similar ${fmt(similar.median[stage])}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {/* From md up: the same figures as a table. */}
      <table className="mt-4 hidden w-full text-sm md:table">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border text-left">
            <th scope="col" className="py-2 pr-3 font-normal">Stage</th>
            <th scope="col" className="px-3 py-2 text-right font-normal">All</th>
            <th scope="col" className="px-3 py-2 text-right font-normal">Last 7 days</th>
            <th scope="col" className="py-2 pl-3 text-right font-normal">Similar, median</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {FUNNEL_STAGES.map((stage) => (
            <tr key={stage}>
              <th scope="row" className="py-2 pr-3 text-left font-normal text-foreground">{STAGE_LABELS[stage]}</th>
              <td className="px-3 py-2 text-right font-medium tabular-nums text-foreground">{funnel[stage].total}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{funnel[stage].week}</td>
              <td className="py-2 pl-3 text-right tabular-nums text-muted-foreground"><Median similar={similar} stage={stage} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{compare}</p>

      <h3 className="mt-5 text-[13px] font-semibold text-foreground">Next steps</h3>
      {health.steps.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing to suggest right now.</p>
      ) : (
        <ol className="mt-2 space-y-3">
          {health.steps.map((step: HealthStep, index) => {
            const link = linkFor(step.target, ctx);
            return (
              <li key={`${step.key}-${index}`} className="rounded-lg border border-border p-3">
                <p className="text-sm break-words text-foreground">{step.fact}</p>
                <p className="mt-1 text-sm break-words text-foreground">{step.suggestion}</p>
                <p className="mt-1 text-xs break-words text-muted-foreground">{step.reason}</p>
                {link && (
                  <a href={link.href} className="mt-1 inline-flex min-h-10 items-center text-[13px] font-medium text-link">
                    {link.label}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Facts from UPB&apos;s own records and fixed rules. Not a grade, a forecast or advice, and the price is always yours to set.
      </p>
    </section>
  );
}
