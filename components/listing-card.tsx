import Link from "next/link";
import { Heart } from "lucide-react";
import { toggleFavorite } from "@/actions/buyer";
import { CompareToggle } from "@/components/compare-picker";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { BID_MODES } from "@/lib/filters";
import { money, pct, prettyDate } from "@/lib/format";
import type { RateStamp } from "@/lib/indicative";

export function ListingCard({
  href,
  title,
  city,
  state,
  kind,
  paymentLabel,
  lienLabel,
  propertyLabel,
  status,
  loanCount,
  locked,
  lockReason,
  metrics,
  favorited,
  canFavorite,
  listingId,
  bidMode = "NONE",
  deadline = null,
  comparable = false,
  indicative = null,
}: {
  href: string;
  title: string;
  city: string;
  state: string;
  kind: string;
  paymentLabel: string;
  lienLabel: string;
  propertyLabel: string;
  status: string;
  loanCount: number;
  locked: boolean;
  lockReason: "early" | "limit" | null;
  metrics: { upb: number; asking: number; priceToUpb: number | null; yield: number | null } | null;
  favorited: boolean;
  canFavorite: boolean;
  listingId: string;
  bidMode?: string;
  // ISO time the bids close, when the listing has a dated deadline.
  deadline?: string | null;
  comparable?: boolean;
  // The desk's indicative range in whole percent of UPB, from loadIndicatives(). Shown with the figures, so only on
  // Pro. rate is set when a spread-priced standing bid is part of it.
  indicative?: { low: number; high: number; rate?: RateStamp | null } | null;
}) {
  const style = BID_MODES.find((mode) => mode.value === bidMode)?.label ?? "Open offers";
  return (
    <article className="glass relative flex h-full flex-col justify-between p-5 transition duration-500 hover:border-foreground/20 sm:min-h-64 sm:p-6">
      <div>
        <div className="flex items-start justify-between gap-3">
          <p className="eyebrow">{state} · {lienLabel}</p>
          <StatusPill status={status} />
        </div>
        {/* The title's link covers the card, so the whole card opens it while the controls stay their own. */}
        <h2 className="mt-3 pr-10 font-semibold tracking-tight text-lg text-foreground sm:mt-4">
          <Link href={locked ? `/buyer/subscription?reason=${lockReason ?? "access"}` : href} className="after:absolute after:inset-0 after:rounded-[16px] after:content-['']">
            {title}
          </Link>
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          {city}, {state} · {propertyLabel}
          {kind === "POOL" ? ` · ${loanCount} loans` : ""} · {paymentLabel}
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground tabular-nums">
          {deadline ? `${style} · closes ${prettyDate(deadline)}` : style}
        </p>
      </div>
      <div className="mt-5 border-t border-border pt-4 sm:mt-8">
        {lockReason === "early" && (
          <p className="text-[13px] font-medium text-link">Early access · Pro</p>
        )}
        {lockReason === "limit" && (
          <p className="text-[13px] font-medium text-link">Beyond the free book</p>
        )}
        {metrics ? (
          <div className="flex items-end justify-between tabular-nums">
            <div>
              <p className="font-semibold tracking-tight text-3xl text-foreground">{pct(metrics.priceToUpb, 0)}</p>
              <p className="text-[13px] font-medium text-muted-foreground">of UPB</p>
            </div>
            <div className="text-right text-sm text-muted-foreground">
              <p>{money(metrics.asking)} ask</p>
              <p>{metrics.yield == null ? "No current yield" : `${pct(metrics.yield)} current yield`}</p>
            </div>
          </div>
        ) : (
          !lockReason && <p className="text-[13px] font-medium text-muted-foreground">Economics reserved for Pro</p>
        )}
        {metrics && indicative && (
          <p className="mt-2 text-[13px] text-muted-foreground tabular-nums">
            Indicative {indicative.low === indicative.high ? `${indicative.low}%` : `${indicative.low}–${indicative.high}%`} of UPB, an estimate as of today
            {indicative.rate?.stale && <span className="block text-xs text-warn">10-year {indicative.rate.text}</span>}
          </p>
        )}
        {comparable && (
          <div className="relative z-10 mt-4">
            <CompareToggle listingId={listingId} title={title} />
          </div>
        )}
      </div>
      {canFavorite && (
        <form action={toggleFavorite} className="absolute top-12 right-3 z-10 sm:top-14 sm:right-4">
          <input type="hidden" name="listingId" value={listingId} />
          <Button type="submit" variant="ghost" size="icon" aria-label={favorited ? "Remove favorite" : "Save favorite"} className="bg-card">
            <Heart className={favorited ? "fill-link text-link" : "text-foreground"} />
          </Button>
        </form>
      )}
    </article>
  );
}
