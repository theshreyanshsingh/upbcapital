import { money, pct } from "@/lib/format";

// On a phone, or a screen too short for the offer panel to stay in view, a slim bar keeps the ask and the way
// to bid one tap away. It hides where the panel itself sits in view beside the page.
export function BidBar({
  asking,
  priceToUpb,
  canOffer,
  verified,
  buyNow = null,
  acknowledgeFirst = false,
}: {
  asking: number | null;
  priceToUpb: number | null;
  canOffer: boolean;
  verified: boolean;
  // The seller's buy-it-now price, passed only when this buyer can take it now.
  buyNow?: number | null;
  // The buyer acknowledges the ROAD Act notice on the page before any bid.
  acknowledgeFirst?: boolean;
}) {
  const ready = canOffer && verified && !acknowledgeFirst;
  const action = !canOffer
    ? "Bid options"
    : !verified
      ? "Verify to bid"
      : acknowledgeFirst
        ? "Read the notice to bid"
        : buyNow != null
          ? `Buy it now at ${money(buyNow)}`
          : "Make a bid";
  const href = canOffer && verified && acknowledgeFirst ? "#eligibility" : ready && buyNow != null ? "#buy-now" : "#offer";
  return (
    <>
      {/* Focused fields scroll clear of the bar (and the phone's tab bar under it), so it never hides where the keyboard is. */}
      <style>{"@media (max-width: 63.99rem), (max-height: 49.99rem) { html { scroll-padding-bottom: calc(var(--dock, 0px) + 5rem); } }"}</style>
      {/* On a phone it rides just above the tab bar; elsewhere it sits on the bottom edge, clear of the home indicator. */}
      <div
        data-slot="bid-bar"
        className="fixed inset-x-0 bottom-[var(--dock,0px)] z-20 flex items-center justify-between gap-3 border-t border-border bg-card/95 px-4 pt-2.5 pb-[calc(0.625rem+max(0px,env(safe-area-inset-bottom)-var(--dock,0px)))] backdrop-blur-xl md:left-72 [@media(min-width:64rem)_and_(min-height:50rem)]:hidden"
      >
        <p className="min-w-0 truncate text-sm text-foreground tabular-nums">
          {asking == null ? (
            <span className="text-muted-foreground">Ask and yield on Pro</span>
          ) : (
            <>
              <span className="font-semibold">{money(asking)}</span>
              <span className="text-muted-foreground"> ask · {pct(priceToUpb, 0)} of UPB</span>
            </>
          )}
        </p>
        <a href={href} className="inline-flex h-11 shrink-0 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground tabular-nums transition-[scale] duration-(--dur-1) active:scale-[0.97] md:h-10 md:rounded-lg md:text-[13px] md:font-medium">
          {action}
        </a>
      </div>
    </>
  );
}
