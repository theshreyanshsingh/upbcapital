import Link from "next/link";
import { clearPriceTarget, setPriceTarget } from "@/actions/price-target";
import { SubmitButton } from "@/components/submit-button";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { dollars, targetState } from "@/lib/target-alerts";

// A buyer's price alert on a live listing (lib/target-alerts.ts): where their target stands, and the form to set or
// clear it. The ask is a Pro figure, so a free buyer reads one line about Pro instead. Pass the page's own `pro`.
export async function PriceTarget({ listingId, viewer, pro }: { listingId: string; viewer: { id: string; watchAlerts?: boolean | null }; pro: boolean }) {
  if (!pro) {
    return (
      <p id="price-alert" className="mt-4 scroll-mt-6 text-sm text-muted-foreground">
        Price alerts, a notice when the ask reaches a figure you set, come with Pro. <Link href="/buyer/subscription" className="text-link">See Pro</Link>
      </p>
    );
  }
  const saved = await prisma.favorite.findUnique({
    where: { userId_listingId: { userId: viewer.id, listingId } },
    select: { targetAsk: true, targetSetAt: true, targetHitAt: true },
  });
  const state = saved ? targetState(saved) : null;
  const hidden = <input type="hidden" name="listingId" value={listingId} />;
  return (
    <section id="price-alert" aria-labelledby="price-alert-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
      <h2 id="price-alert-heading" className="eyebrow">Price alert</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground tabular-nums">
        {state ?? `Hear once when the ask reaches a figure you set.${saved ? "" : " Setting one saves the listing."}`}
        {saved?.targetHitAt ? " Set a new target for another alert." : ""}
      </p>
      {viewer.watchAlerts === false && (
        <p className="mt-2 text-sm text-muted-foreground">
          Notices about listings you saved are off, so an alert won&apos;t reach you. <Link href="/account/notifications" className="text-link">Turn them on</Link>
        </p>
      )}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <form action={setPriceTarget} className="flex min-w-0 flex-col gap-3 sm:flex-1 sm:flex-row sm:items-end">
          {hidden}
          <label className="block min-w-0 sm:flex-1">
            <span className="text-[13px] text-muted-foreground">Alert me at or under</span>
            <input name="target" inputMode="decimal" required autoComplete="off" className="desk-input mt-2" aria-describedby="price-alert-hint" />
          </label>
          <SubmitButton className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Setting…">Set</SubmitButton>
        </form>
        {saved?.targetAsk != null && (
          <form action={clearPriceTarget}>
            {hidden}
            <SubmitButton variant="outline" className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Clearing…">Clear</SubmitButton>
          </form>
        )}
      </div>
      <p id="price-alert-hint" className="mt-2 text-xs text-muted-foreground">In dollars, under today&apos;s ask. A new target replaces the old one.</p>
    </section>
  );
}

// A saved listing's price alert on the favorites page, with a link to the form on the listing. A listing that is no
// longer live keeps its line but takes no new target.
export function SavedTarget({ listingId, live, target }: { listingId: string; live: boolean; target: { targetAsk: number | null; targetSetAt: Date | null; targetHitAt: Date | null } }) {
  if (target.targetAsk == null && !live) return null;
  const line = target.targetAsk == null
    ? "No price alert."
    : `Price alert at or under ${dollars(target.targetAsk)} · ${target.targetHitAt ? `hit on ${prettyDate(target.targetHitAt)}` : `waiting, set ${prettyDate(target.targetSetAt)}`}`;
  return (
    <p className="flex flex-wrap items-center gap-x-3 px-5 pb-3 text-sm text-muted-foreground tabular-nums">
      <span className="min-w-0">{line}</span>
      {live && (
        <Link href={`/marketplace/${listingId}#price-alert`} className="inline-flex min-h-10 items-center font-medium text-link">
          {target.targetAsk == null ? "Set one" : "Change it"}
        </Link>
      )}
    </p>
  );
}
