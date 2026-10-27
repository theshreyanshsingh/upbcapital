import Link from "next/link";
import { Heart } from "lucide-react";
import { toggleFavorite } from "@/actions/buyer";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { money, pct } from "@/lib/format";

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
}) {
  return (
    <div className="relative">
      <Link href={locked ? `/buyer/subscription?reason=${lockReason ?? "access"}` : href} className="group block h-full">
        <article className="glass flex h-full min-h-64 flex-col justify-between p-6 transition duration-500 group-hover:border-foreground/20">
          <div>
            <div className="flex items-start justify-between gap-3">
              <p className="eyebrow">{state} · {lienLabel}</p>
              <StatusPill status={status} />
            </div>
            <h2 className="mt-4 font-semibold tracking-tight text-lg text-foreground">{title}</h2>
            <p className="mt-3 text-sm text-muted-foreground">
              {city}, {state} · {propertyLabel}
              {kind === "POOL" ? ` · ${loanCount} loans` : ""} · {paymentLabel}
            </p>
          </div>
          <div className="mt-8 border-t border-border pt-4">
            {lockReason === "early" && (
              <p className="text-[13px] font-medium text-link">Early access · Pro</p>
            )}
            {lockReason === "limit" && (
              <p className="text-[13px] font-medium text-link">Beyond the free book</p>
            )}
            {metrics ? (
              <div className="flex items-end justify-between">
                <div>
                  <p className="font-semibold tracking-tight text-3xl text-foreground">{pct(metrics.priceToUpb, 0)}</p>
                  <p className="text-[13px] font-medium text-muted-foreground">of UPB</p>
                </div>
                <div className="text-right text-sm text-muted-foreground">
                  <p>{money(metrics.asking)}</p>
                  <p>{metrics.yield == null ? "Yield n/a" : `${pct(metrics.yield)} yield`}</p>
                </div>
              </div>
            ) : (
              !lockReason && <p className="text-[13px] font-medium text-muted-foreground">Economics reserved for Pro</p>
            )}
          </div>
        </article>
      </Link>
      {canFavorite && (
        <form action={toggleFavorite} className="absolute right-4 top-14">
          <input type="hidden" name="listingId" value={listingId} />
          <Button type="submit" variant="ghost" size="icon" aria-label={favorited ? "Remove favorite" : "Save favorite"} className="bg-card">
            <Heart className={favorited ? "fill-link text-link" : "text-foreground"} />
          </Button>
        </form>
      )}
    </div>
  );
}
